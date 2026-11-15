//! Manifest-driven one-click installers. Every text and command lives in the
//! starter package's install section; the application core only knows that a
//! starter with an install section offers a button — never the wording.
use crate::{
    composer_installer::{self, Codes, Installed, Progress, Snapshot},
    error::CommandError,
    paths::{external_path, hidden_command, is_valid_module_name, resolve_installation},
    project_starters::{self, Document, InstallConfig},
    project_workspace::{base, child, parse},
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::ipc::Channel;

pub(crate) const CODES: Codes = Codes {
    install: "err.installFailed",
    timeout: "err.installTimeout",
    environment: "err.installEnvironment",
    conflict: "err.installConflict",
    not_prepared: "err.installNotPrepared",
    recovery: "err.installRecovery",
};

pub(crate) fn state(dir: &Path, id: &str) -> Option<String> {
    crate::project_starter_locale::state(dir, id)
}

fn error(code: &str) -> CommandError {
    CommandError::new(code)
}

fn install_of(doc: &Document) -> Result<&InstallConfig, CommandError> {
    doc.manifest.install.as_ref().ok_or_else(|| error("err.installNotPrepared"))
}

// A preparation may only contain the configuration, the starter directories, the
// starter readme, the placeholder page and the keep-files declared by the manifest.
fn prepared(
    root: &Path,
    domain: &str,
    base_dir: &str,
    doc: &Document,
) -> Result<(PathBuf, String, Snapshot), CommandError> {
    let install = install_of(doc)?;
    let dir = base(root, domain, base_dir)?;
    if state(&dir, &doc.manifest.id).as_deref() != Some("pending") {
        return Err(error("err.installNotPrepared"));
    }
    let files = composer_installer::snapshot(&dir)?;
    let mut allowed: Vec<String> = doc.manifest.directories.clone();
    allowed.push(".osp".into());
    if let Some(readme) = doc.manifest.readme_path.as_deref().filter(|path| !path.contains('/')) {
        allowed.push(readme.into());
    }
    // Root-level keep-files (a .gitignore, for example) are part of the scaffold.
    for kept in &install.keep {
        if !kept.contains('/') {
            allowed.push(kept.into());
        }
    }
    if fs::read_dir(&dir)?.any(|entry| {
        entry
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                !allowed.iter().any(|item| item == &name)
            })
            .unwrap_or(true)
    }) || files
        .keys()
        .filter(|path| path.starts_with("public") && path.as_os_str() != "public")
        .any(|path| {
            path != Path::new("public/index.php") && !install.keep.iter().any(|kept| Path::new(kept) == path)
        })
    {
        return Err(error("err.installConflict"));
    }
    let placeholder = files
        .get(Path::new("public/index.php"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.installConflict"))?;
    if !crate::project_starter_locale::matches_placeholder(&dir, &doc.manifest.id, placeholder) {
        return Err(error("err.installConflict"));
    }
    let ini = files
        .get(Path::new(".osp/project.ini"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.installNotPrepared"))?;
    let ini = std::str::from_utf8(ini).map_err(|_| error("err.installNotPrepared"))?;
    let sections = parse(ini)?;
    let values = sections.get(domain).ok_or_else(|| error("err.installNotPrepared"))?;
    if sections.values().any(|values| {
        values.get("project_root").is_none_or(|root| root != "{base_dir}")
            || values.get("web_root").is_none_or(|root| root.replace('/', "\\") != r"{base_dir}\public")
    }) {
        return Err(error("err.installDirectories"));
    }
    let php = values.get("php_engine").cloned().unwrap_or_default();
    if !php.starts_with("PHP-") || !is_valid_module_name(&php) {
        return Err(error("err.installEnvironment"));
    }
    Ok((dir, php, files))
}

// The composer payload must contain the files and package name the manifest declares.
fn payload(stage: &Path, doc: &Document) -> Result<PathBuf, CommandError> {
    let install = install_of(doc)?;
    let application = child(stage, "application")?;
    crate::update_files::safe_tree(&application)?;
    for path in &install.payload.files {
        let mut current = application.clone();
        for part in path.split('/') {
            current = child(&current, part)?;
        }
        // The missing path is reported so a layout change in the upstream package
        // can be diagnosed without the (already deleted) staging directory.
        if !current.is_file() {
            return Err(error("err.installPayloadFile").with("path", path.clone()));
        }
    }
    // The package name identifies a downloaded archive. A composer create-project
    // installs exactly the requested package, and upstream projects are free to
    // publish a different name inside composer.json, so checking it there would
    // reject complete applications.
    if let (Some(name), Some(_)) = (&install.payload.composer_name, &install.archive) {
        let json: serde_json::Value = serde_json::from_slice(&fs::read(application.join("composer.json"))?)
            .map_err(|_| error("err.installPayloadFile").with("path", "composer.json"))?;
        if json["name"] != *name {
            return Err(error("err.installPayloadName")
                .with("name", name.clone())
                .with("actual", json["name"].as_str().unwrap_or_default()));
        }
    }
    if child(&application, ".osp")?.exists() {
        return Err(error("err.installPayload"));
    }
    Ok(application)
}

// Returns None when the template references a value that is not available
// (for example a database placeholder without a configured database), so the
// env key is skipped instead of being written with a literal placeholder.
// Renders a configuration template: escaped database values plus raw hex salts.
fn render_config(
    template: &str,
    escaped: &[(&'static str, String)],
    randoms: &[(String, String)],
) -> Result<String, CommandError> {
    let mut text = template.to_string();
    for (key, value) in escaped {
        text = text.replace(&format!("{{{key}}}"), value);
    }
    for (name, value) in randoms {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    Ok(text)
}

// Detects an unsubstituted "{name}" placeholder without touching PHP braces.
fn has_unresolved_placeholder(text: &str) -> bool {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'{' {
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if end > start + 1 && end < bytes.len() && bytes[end] == b'}' {
            return true;
        }
    }
    false
}

fn expand(template: &str, values: &[(&'static str, String)]) -> Option<String> {
    let mut result = template.to_string();
    for (key, value) in values {
        result = result.replace(&format!("{{{key}}}"), value);
    }
    (!result.contains('{') || values.iter().any(|(key, value)| {
        !value.is_empty() && template.contains(&format!("{{{key}}}"))
    }))
    .then_some(result)
}

// Percent-encoding for values embedded in a connection URL.
fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// SQLite connection values for a file at <project>/<dir>/<name>.
fn sqlite_values(project: &Path, dir: &str, name: &str) -> Vec<(&'static str, String)> {
    let path = external_path(&project.join(dir).join(name)).to_string_lossy().replace('\\', "/");
    vec![("sqliteFile", path.clone()), ("dbUrl", format!("sqlite:///{path}"))]
}

// Engine-appropriate connection values. The SQLite file is created inside the
// staging application; `project` is the location the published .env refers to.
fn connection_values(
    connection: &crate::project_database::Connection,
    application: &Path,
    project: &Path,
    install: &InstallConfig,
) -> Result<Vec<(&'static str, String)>, CommandError> {
    let db = &connection.db;
    let mut values = vec![
        ("dbHost", connection.host.clone()),
        ("dbPort", connection.port.to_string()),
        ("dbName", db.name.clone()),
        ("dbUsername", db.username.clone()),
        ("dbPassword", db.password.clone()),
        (
            "dbConnection",
            if db.engine.starts_with("PostgreSQL-") { "pgsql".into() } else { "mysql".into() },
        ),
    ];
    if db.engine == "sqlite" {
        let dir = install.sqlite_dir.as_deref().unwrap_or("var");
        let name = format!("{}.sqlite", db.name);
        let dir = child(&child(application, dir)?, &name)?;
        fs::OpenOptions::new().write(true).create_new(true).open(&dir)?;
        values.extend(sqlite_values(project, install.sqlite_dir.as_deref().unwrap_or("var"), &name));
    } else if db.engine.starts_with("PostgreSQL-") {
        values.push((
            "dbUrl",
            format!(
                "postgresql://{}:{}@{}:{}/{}",
                url_encode(&db.username),
                url_encode(&db.password),
                connection.host,
                connection.port,
                url_encode(&db.name)
            ),
        ));
    } else {
        values.push((
            "dbUrl",
            format!(
                "mysql://{}:{}@{}:{}/{}",
                url_encode(&db.username),
                url_encode(&db.password),
                connection.host,
                connection.port,
                url_encode(&db.name)
            ),
        ));
    }
    Ok(values)
}

fn chain_dir(base: &Path, relative: &str) -> Result<PathBuf, CommandError> {
    let mut current = base.to_path_buf();
    // Empty segments arise from an empty relative path or double slashes;
    // child(parent, "") would validate parent against itself and fail.
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        current = child(&current, part)?;
    }
    Ok(current)
}

// Applies the manifest environment maps to the application .env file, keeps the
// manifest-declared scaffold files and runs the console steps.
fn setup(
    root: &Path,
    project: &Path,
    domain: &str,
    application: &Path,
    php: &str,
    doc: &Document,
    channel: &Channel<Progress>,
) -> Result<(), CommandError> {
    setup_with_console(root, project, domain, application, doc, channel, |steps| {
        let module = child(&child(root, "modules")?, php)?;
        let executable = child(&module, "php.exe")?;
        let ini = child(&module, "php.ini")?;
        for args in steps {
            let mut command = hidden_command(external_path(&executable));
            command
                .current_dir(external_path(application))
                .arg("-c")
                .arg(external_path(&ini))
                .args(args)
                .env("PHPRC", external_path(&ini));
            composer_installer::run(&CODES, &mut command, channel)?;
        }
        Ok(())
    })
}

fn setup_with_console(
    root: &Path,
    project: &Path,
    domain: &str,
    application: &Path,
    doc: &Document,
    channel: &Channel<Progress>,
    mut run_console: impl FnMut(&[Vec<String>]) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let install = install_of(doc)?;
    composer_installer::progress(channel, "database", String::new());
    let stage = application.parent().ok_or_else(|| error("err.installPayload"))?;
    let osp = child(project, ".osp")?;
    let metadata = child(&osp, "database.json").is_ok_and(|path| path.exists());
    let mut connection = crate::project_database::provision(root, project, stage)?;
    // A scaffold without database metadata may fall back to a default SQLite file.
    if connection.is_none() && !metadata && install.sqlite_fallback {
        connection = Some(crate::project_database::Connection {
            db: serde_json::from_str(r#"{"engine":"sqlite","name":"database"}"#)
                .map_err(|_| error("err.installFailed"))?,
            host: String::new(),
            port: 0,
        });
    }
    let mut values: Vec<(&'static str, String)> =
        vec![("url", composer_installer::application_url(&CODES, root, project, domain)?)];
    if let Some(connection) = &connection {
        values.extend(connection_values(connection, application, project, install)?);
    }
    let source = install.env_source.as_deref().unwrap_or(".env");
    let source_path = child(application, source).map_err(|_| error("err.installPayload"))?;
    // Keep an existing environment file (for example .env.example renamed by the
    // starter), but do not create an empty .env for starters with no env config.
    let had_env_source = fs::read_to_string(&source_path).is_ok();
    let mut env = if had_env_source {
        fs::read_to_string(&source_path).unwrap_or_default()
    } else {
        String::new()
    };
    let apply = |env: &mut String, map: &BTreeMap<String, String>, values: &[(&'static str, String)]| {
        for (key, template) in map {
            if let Some(value) = expand(template, values) {
                *env = crate::project_database::env_set(env, key, &value);
            }
        }
    };
    apply(&mut env, &install.env, &values);
    if let Some(connection) = &connection {
        if connection.db.engine == "sqlite" {
            apply(&mut env, &install.env_sqlite, &values);
        } else {
            apply(&mut env, &install.env_server, &values);
        }
    }
    // Console commands execute before publication, so SQLite must point to the
    // existing staged file, not the still-unpublished project database.
    let mut console_env = env.clone();
    if let Some(connection) = &connection {
        if connection.db.engine == "sqlite" {
            let mut staged_values = values.clone();
            for (key, value) in sqlite_values(
                application,
                install.sqlite_dir.as_deref().unwrap_or("var"),
                &format!("{}.sqlite", connection.db.name),
            ) {
                if let Some((_, current)) = staged_values.iter_mut().find(|(name, _)| *name == key) {
                    *current = value;
                }
            }
            apply(&mut console_env, &install.env, &staged_values);
            apply(&mut console_env, &install.env_sqlite, &staged_values);
        }
    }
    // Write .env only when the starter actually configures environment variables
    // or an environment file already existed; otherwise no .env is created.
    let write_env = had_env_source || !console_env.trim().is_empty();
    if write_env {
        fs::write(child(application, ".env")?, &console_env)?;
    }
    // Configuration files render from package templates with PHP-escaped values;
    // the randomHex placeholders are pure hex and stay raw. Written only when a
    // database is configured (credentials must not point to a placeholder server).
    if !install.config_files.is_empty() {
        composer_installer::progress(channel, "configuring", String::new());
        if let Some(connection) = &connection {
            let host_port = if connection.host.contains(':') {
                format!("[{}]:{}", connection.host, connection.port)
            } else {
                format!("{}:{}", connection.host, connection.port)
            };
            let escaped: Vec<(&'static str, String)> = values
                .iter()
                .map(|(key, value)| (*key, crate::project_database::php_string(value)))
                .chain([
                    ("dbHostPort", crate::project_database::php_string(&host_port)),
                ])
                .collect();
            let randoms: Vec<(String, String)> = install
                .random_hex
                .iter()
                .map(|(name, bytes)| Ok((name.clone(), hex(&random_bytes(*bytes)?))))
                .collect::<Result<_, CommandError>>()?;
            for file in &install.config_files {
                let template = doc.assets.get(&file.template).ok_or_else(|| error("err.installPayload"))?;
                let text = render_config(template, &escaped, &randoms)?;
                // A leftover "{name}" pattern means the template references a
                // value the engine does not provide; PHP code braces survive
                // because only alphanumeric placeholder bodies are scanned.
                if has_unresolved_placeholder(&text) {
                    return Err(error("err.installPayload"));
                }
                let mut target = application.to_path_buf();
                for part in file.to.split('/') {
                    target = match child(&target, part) {
                        Ok(path) => path,
                        Err(_) => {
                            fs::create_dir(&target)?;
                            child(&target, part)?
                        }
                    };
                }
                let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
                output.write_all(text.as_bytes())?;
                output.sync_all()?;
            }
        }
    }
    if !install.console.is_empty() {
        composer_installer::progress(channel, "configuring", String::new());
        run_console(&install.console)?;
    }
    if connection.is_some() {
        run_console(&install.console_with_db)?;
    }
    // Preserve changes made by console commands (for example Laravel's APP_KEY),
    // replacing only manifest-managed values that contained staged SQLite paths.
    if write_env {
        if let Some(connection) = &connection {
            if connection.db.engine == "sqlite" {
                let mut published_env = fs::read_to_string(child(application, ".env")?)?;
                apply(&mut published_env, &install.env, &values);
                apply(&mut published_env, &install.env_sqlite, &values);
                fs::write(child(application, ".env")?, published_env)?;
            }
        }
    }
    // Keep-files carry scaffold routing and similar assets into the application.
    for relative in &install.keep {
        let Ok(content) = fs::read(chain_dir(project, relative)?) else { continue };
        let mut target = application.to_path_buf();
        for part in relative.split('/') {
            target = match child(&target, part) {
                Ok(path) => path,
                Err(_) => {
                    fs::create_dir(&target)?;
                    child(&target, part)?
                }
            };
        }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
        file.write_all(&content)?;
    }
    Ok(())
}

// The composer runner declared by the manifest: create-project, then the extra runs.
fn run_composer(
    root: &Path,
    php: &str,
    stage: &Path,
    doc: &Document,
    channel: &Channel<Progress>,
) -> Result<(), CommandError> {
    let install = install_of(doc)?;
    composer_installer::progress(channel, "installing", String::new());
    let mut command = composer_installer::composer_command(
        &CODES,
        root,
        php,
        stage,
        &install.create_project,
        install.scripts,
    )
    .map_err(|e| error("err.installEnvironment").with("detail", e.code))?;
    composer_installer::run(&CODES, &mut command, channel)?;
    let application = child(stage, "application")?;
    for args in &install.then {
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut require = composer_installer::composer_require(&CODES, root, php, &application, &borrowed)
            .map_err(|e| error("err.installEnvironment").with("detail", e.code))?;
        composer_installer::run(&CODES, &mut require, channel)?;
    }
    Ok(())
}

// --- The archive engine: download, verify, extract and move ---

// Pre-scan: every entry must live inside the declared directory and the
// uncompressed size stays within the manifest cap.
fn validate_zip(archive: &Path, from_dir: &str, max_bytes: u64) -> Result<(), CommandError> {
    let mut zip =
        zip::ZipArchive::new(fs::File::open(archive)?).map_err(|_| error("err.installArchive"))?;
    let mut total = 0u64;
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|_| error("err.installArchive"))?;
        // An empty from_dir means the archive's files live at its root (no
        // wrapper directory, for example a nightly build package).
        if !from_dir.is_empty() && !entry.name().starts_with(&format!("{from_dir}/")) {
            return Err(error("err.installArchive"));
        }
        total = total.checked_add(entry.size()).ok_or_else(|| error("err.installArchive"))?;
        if total > max_bytes {
            return Err(error("err.installArchive"));
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_bytes(count: u32) -> Result<Vec<u8>, CommandError> {
    let mut bytes = vec![0; count as usize];
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
        BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
            .ok()
            .map_err(|_| error("err.installFailed"))?;
    }
    #[cfg(not(windows))]
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn network(e: impl std::fmt::Debug) -> CommandError {
    let _ = e;
    error("err.installDownload")
}

// HTTPS-only downloads with a bounded redirect chain: the URLs come from a
// local starter manifest, so the trust anchor is the manifest author.
fn https_client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| error("err.installDownload"))
}

fn fetch_small(client: &reqwest::blocking::Client, url: &str, max: u64) -> Result<Vec<u8>, CommandError> {
    let response = client.get(url).send().and_then(|r| r.error_for_status()).map_err(network)?;
    let mut result = Vec::new();
    response.take(max + 1).read_to_end(&mut result).map_err(network)?;
    if result.len() as u64 > max {
        return Err(error("err.installDownload"));
    }
    Ok(result)
}

// Walks a JSON catalog by a declared key path ("offers" -> [0] -> "current").
fn version_path(json: &serde_json::Value, path: &[String]) -> Result<String, CommandError> {
    let mut node = json;
    for key in path {
        node = match key.parse::<usize>() {
            Ok(index) => node.get(index),
            Err(_) => node.get(key),
        }
        .ok_or_else(|| error("err.installDownload"))?;
    }
    let version = node.as_str().ok_or_else(|| error("err.installDownload"))?;
    if version.len() > 24
        || !(2..=3).contains(&version.split('.').count())
        || version.split('.').any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(error("err.installDownload"));
    }
    Ok(version.to_owned())
}

fn digest_hex(path: &Path, algorithm: &str) -> Result<String, CommandError> {
    let bytes = fs::read(path)?;
    match algorithm {
        // 40-hex checksums ride on the platform SHA-1; 64-hex on the SHA-2 crate.
        "sha1" => {
            #[cfg(windows)]
            {
                use windows::Win32::Security::Cryptography::{BCRYPT_SHA1_ALG_HANDLE, BCryptHash};
                let mut digest = [0; 20];
                unsafe {
                    BCryptHash(BCRYPT_SHA1_ALG_HANDLE, None, &bytes, &mut digest)
                        .ok()
                        .map_err(|_| error("err.installChecksum"))?;
                }
                Ok(hex(&digest))
            }
            #[cfg(not(windows))]
            {
                let _ = bytes;
                Err(error("err.installChecksum"))
            }
        }
        _ => {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            Ok(hex(&hasher.finalize()))
        }
    }
}

// The archive runner: resolve the version, download with progress, verify the
// checksum, extract and move the declared directory into the application.
fn run_archive(
    stage: &Path,
    doc: &Document,
    channel: &Channel<Progress>,
) -> Result<(), CommandError> {
    let install = install_of(doc)?;
    let archive = install.archive.as_ref().ok_or_else(|| error("err.installNotPrepared"))?;
    composer_installer::progress(channel, "downloading", String::new());
    let client = https_client()?;
    let mut url = archive.url.clone();
    let mut checksum_url = archive.checksum_url.clone();
    if let Some(release) = &archive.release {
        let catalog = fetch_small(&client, &release.url, 1_048_576)?;
        let json: serde_json::Value =
            serde_json::from_slice(&catalog).map_err(|_| error("err.installDownload"))?;
        let version = version_path(&json, &release.path)?;
        url = url.replace("{version}", &version);
        checksum_url = checksum_url.map(|u| u.replace("{version}", &version));
    }
    let expected = match &checksum_url {
        Some(url) => {
            let raw = String::from_utf8(fetch_small(&client, url, 512)?).map_err(network)?;
            let raw = raw.trim();
            let algorithm = match raw.len() {
                40 => "sha1",
                64 => "sha256",
                _ => return Err(error("err.installChecksum")),
            };
            if !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(error("err.installChecksum"));
            }
            Some((raw.to_ascii_lowercase(), algorithm.to_string()))
        }
        None => None,
    };
    let mut response = client.get(&url).send().and_then(|r| r.error_for_status()).map_err(network)?;
    if response.content_length().is_some_and(|n| n > archive.max_archive_bytes) {
        return Err(error("err.installArchive"));
    }
    let archive_path = child(stage, "package-archive")?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&archive_path)?;
    let mut downloaded = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let count = response.read(&mut buffer).map_err(network)?;
        if count == 0 {
            break;
        }
        downloaded += count as u64;
        if downloaded > archive.max_archive_bytes {
            return Err(error("err.installArchive"));
        }
        file.write_all(&buffer[..count])?;
        let _ = channel.send(Progress {
            phase: "downloading",
            output: String::new(),
            downloaded: Some(downloaded),
            total: response.content_length(),
        });
    }
    file.sync_all()?;
    drop(file);
    if let Some((expected, algorithm)) = &expected {
        if !digest_hex(&archive_path, algorithm)?.eq_ignore_ascii_case(expected) {
            return Err(error("err.installChecksum"));
        }
    }
    composer_installer::progress(channel, "extracting", String::new());
    let unpacked = child(stage, "unpacked")?;
    validate_zip(&archive_path, &archive.extract.from_dir, archive.max_archive_bytes.saturating_mul(3))?;
    crate::update_files::extract(&archive_path, &unpacked).map_err(|_| error("err.installArchive"))?;
    let source = chain_dir(&unpacked, &archive.extract.from_dir)?;
    for path in &archive.extract.required_files {
        if !chain_dir(&source, path)?.is_file() {
            return Err(error("err.installArchive"));
        }
    }
    if child(&source, ".osp")?.exists() {
        return Err(error("err.installArchive"));
    }
    let application = composer_installer::ensure_dir(stage, "application")?;
    let parts: Vec<&str> = archive.extract.to.split('/').collect();
    let mut target = application.clone();
    for part in &parts[..parts.len() - 1] {
        target = composer_installer::ensure_dir(&target, part)?;
    }
    let destination = child(&target, parts[parts.len() - 1])?;
    fs::rename(&source, &destination)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_project_starter(
    starter_id: String,
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<Installed, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
        let doc = project_starters::load(&starter_id)?;
        install_of(&doc)?;
        composer_installer::progress(&on_progress, "preparing", String::new());
        composer_installer::install_application(
            &doc.manifest.id,
            &CODES,
            &root,
            &domain,
            &base_dir,
            |root, domain, base_dir| prepared(root, domain, base_dir, &doc),
            |stage| payload(stage, &doc),
            |stage, php| {
                if doc.manifest.install.as_ref().is_some_and(|install| install.archive.is_some()) {
                    run_archive(stage, &doc, &on_progress)
                } else {
                    run_composer(&root, php, stage, &doc, &on_progress)
                }
            },
            || composer_installer::progress(&on_progress, "publishing", String::new()),
            |application, php, dir| setup(&root, &dir, &domain, application, php, &doc, &on_progress),
        )
    })
    .await
    .map_err(|_| error("err.installFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_starters::Manifest;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
        project: PathBuf,
    }
    impl Fixture {
        // A real scaffold of the given starter inside a throwaway installation.
        fn new(id: &str, language: &str) -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-{id}-test-{}-{nonce}", std::process::id()));
            fs::create_dir_all(root.join("home")).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let template = crate::project_templates::template(id).unwrap();
            let files = template.files("site.test", "Nginx", "PHP-8.3", "", 3000, 9123, language).unwrap();
            let project = template.create(&root.join("home"), "site.test", &files).unwrap();
            Self { root, project }
        }
        fn install(
            &self,
            doc: &Document,
            runner: impl FnOnce(&Path, &str) -> Result<(), CommandError>,
        ) -> Result<Installed, CommandError> {
            composer_installer::install_application(
                &doc.manifest.id,
                &CODES,
                &self.root,
                "site.test",
                self.project.to_str().unwrap(),
                |root, domain, base_dir| prepared(root, domain, base_dir, doc),
                |stage| payload(stage, doc),
                runner,
                || {},
                |_, _, _| Ok(()),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn laravel_document() -> Document {
        crate::project_starters::load("laravel").unwrap()
    }

    // A synthetic composer result matching the Laravel manifest payload.
    fn laravel_application(stage: &Path, php: &str) -> Result<(), CommandError> {
        assert_eq!(php, "PHP-8.3");
        for directory in ["application/public", "application/vendor", "application/app/Http", "application/database"] {
            fs::create_dir_all(stage.join(directory))?;
        }
        for path in ["artisan", ".env.example", "vendor/autoload.php", "app/Http/Controller.php", "README.md"] {
            fs::write(stage.join("application").join(path), "synthetic application")?;
        }
        fs::write(stage.join("application/public/index.php"), "<?php // installed application")?;
        fs::write(stage.join("application/composer.json"), r#"{"name":"laravel/laravel"}"#)?;
        Ok(())
    }

    #[test]
    fn successful_install_keeps_configuration_and_exact_original_backup() {
        let f = Fixture::new("laravel", "en");
        let doc = laravel_document();
        let before = composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
        let result = f.install(&doc, laravel_application).unwrap();
        assert!(f.project.join("app/Http/Controller.php").is_file());
        assert!(!f.project.join("app/app").exists());
        assert_eq!(fs::read_to_string(f.project.join("README.md")).unwrap(), "synthetic application");
        assert_eq!(state(&f.project, "laravel").as_deref(), Some("installed"));
        assert_eq!(composer_installer::snapshot(&fs::canonicalize(&result.backup_path).unwrap()).unwrap(), before);
        assert!(f.install(&doc, laravel_application).is_err());
        assert_eq!(fs::read_dir(f.root.join("temp")).unwrap().count(), 0);
    }

    #[test]
    fn composer_package_name_is_verified_only_for_archive_payloads() {
        let f = Fixture::new("laravel", "en");
        let mut doc = laravel_document();
        doc.manifest.install.as_mut().unwrap().payload.composer_name = Some("laravel/framework".into());
        // The synthetic application declares laravel/laravel; a create-project run
        // already installs the requested package, so the rename must not fail it.
        f.install(&doc, laravel_application).unwrap();
        assert!(f.project.join("artisan").is_file());
    }

    #[test]
    fn failed_composer_or_incomplete_payload_leaves_original_files() {
        let doc = laravel_document();
        for incomplete in [false, true] {
            let f = Fixture::new("laravel", "en");
            let before = composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
            let error = f
                .install(&doc, |stage, _| {
                    fs::create_dir(stage.join("application"))?;
                    fs::write(stage.join("application/partial.txt"), "partial")?;
                    if incomplete { Ok(()) } else { Err(error("err.installFailed")) }
                })
                .unwrap_err();
            assert_eq!(error.code, if incomplete { "err.installPayloadFile" } else { "err.installFailed" });
            if incomplete {
                // The first payload file of the Laravel manifest is the missing one.
                assert_eq!(error.params.get("path").map(String::as_str), Some("artisan"));
            }
            assert_eq!(composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap(), before);
            assert_eq!(state(&f.project, "laravel").as_deref(), Some("pending"));
            assert!(!f.root.join("backups").exists());
        }
    }

    #[test]
    fn extra_files_and_edited_placeholder_prevent_installation_before_the_runner() {
        let doc = laravel_document();
        for path in ["public/keep.txt", "public/index.php", "composer.json", "var/cache"] {
            let f = Fixture::new("laravel", "en");
            fs::create_dir_all(f.project.join(path).parent().unwrap()).unwrap();
            fs::write(f.project.join(path), "user content").unwrap();
            let before = composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
            let error = f.install(&doc, |_, _| panic!("must not start Composer")).unwrap_err();
            assert_eq!(error.code, "err.installConflict");
            assert_eq!(composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap(), before);
            assert!(!f.root.join("temp").exists());
        }
    }

    #[test]
    fn setup_applies_env_maps_sqlite_file_and_keep_files() {
        let f = Fixture::new("symfony", "en");
        let doc = crate::project_starters::load("symfony").unwrap();
        let app = f.root.join("staged-application");
        for directory in ["public", "var"] {
            fs::create_dir_all(app.join(directory)).unwrap();
        }
        fs::write(app.join(".env"), "# comment\n").unwrap();
        fs::write(f.project.join(".osp/database.json"), r#"{"engine":"sqlite","name":"site_db"}"#).unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        setup(&f.root, &f.project, "site.test", &app, "PHP-8.3", &doc, &channel).unwrap();
        let env = fs::read_to_string(app.join(".env")).unwrap();
        assert!(env.contains("DATABASE_URL=\"sqlite:///"));
        assert!(env.contains("/var/site_db.sqlite\""));
        assert!(app.join("var/site_db.sqlite").is_file());
        // The keep-file of the scaffold is carried into the staged application.
        assert_eq!(
            fs::read_to_string(app.join("public/.htaccess")).unwrap(),
            fs::read_to_string(f.project.join("public/.htaccess")).unwrap()
        );
    }

    #[test]
    fn sqlite_console_setup_uses_existing_staged_database_and_publishes_final_paths() {
        for (id, metadata) in [("laravel", true), ("laravel", false), ("symfony", true)] {
            let f = Fixture::new(id, "en");
            let doc = crate::project_starters::load(id).unwrap();
            let install = install_of(&doc).unwrap();
            let sqlite_dir = install.sqlite_dir.as_deref().unwrap_or("var");
            let name = if metadata { "site_db.sqlite" } else { "database.sqlite" };
            if metadata {
                fs::write(f.project.join(".osp/database.json"), r#"{"engine":"sqlite","name":"site_db"}"#).unwrap();
            }
            let mut console_calls = 0;
            composer_installer::install_application(
                id,
                &CODES,
                &f.root,
                "site.test",
                f.project.to_str().unwrap(),
                |root, domain, base_dir| prepared(root, domain, base_dir, &doc),
                |stage| payload(stage, &doc),
                |stage, _| {
                    let app = stage.join("application");
                    for relative in &install.payload.files {
                        let path = app.join(relative);
                        fs::create_dir_all(path.parent().unwrap())?;
                        fs::write(path, "synthetic application")?;
                    }
                    fs::create_dir_all(app.join(sqlite_dir))?;
                    fs::write(app.join(install.env_source.as_deref().unwrap_or(".env")), "APP_ENV=dev\n")?;
                    fs::write(app.join("composer.json"), serde_json::json!({
                        "name": install.payload.composer_name
                    }).to_string())?;
                    Ok(())
                },
                || {},
                |app, _, project| {
                    let channel = Channel::<Progress>::new(|_| Ok(()));
                    setup_with_console(&f.root, project, "site.test", app, &doc, &channel, |_| {
                        console_calls += 1;
                        let env = fs::read_to_string(app.join(".env"))?;
                        let staged_values = sqlite_values(app, sqlite_dir, name);
                        let staged_path = &staged_values[0].1;
                        let expected = if id == "laravel" {
                            format!("DB_DATABASE=\"{staged_path}\"")
                        } else {
                            format!("DATABASE_URL=\"sqlite:///{staged_path}\"")
                        };
                        assert!(env.contains(&expected));
                        assert!(Path::new(staged_path).is_file());
                        assert!(!project.join(sqlite_dir).join(name).exists());
                        // Simulate migrations and key generation without requiring PHP.
                        fs::write(app.join(sqlite_dir).join(name), "synthetic migration result")?;
                        fs::write(app.join(".env"), format!("{env}\nAPP_KEY=synthetic-key\n"))?;
                        Ok(())
                    })
                },
            ).unwrap();
            assert!(console_calls > 0);
            let env = fs::read_to_string(f.project.join(".env")).unwrap();
            let final_values = sqlite_values(&f.project, sqlite_dir, name);
            assert!(env.contains(&final_values[0].1));
            assert!(!env.contains("osp-control-"));
            assert!(env.contains("APP_KEY=synthetic-key"));
            assert_eq!(fs::read_to_string(f.project.join(sqlite_dir).join(name)).unwrap(), "synthetic migration result");
            assert_eq!(state(&f.project, id).as_deref(), Some("installed"));
        }
    }

    #[test]
    fn setup_without_database_leaves_env_untouched_but_keeps_files() {
        let f = Fixture::new("symfony", "en");
        let doc = crate::project_starters::load("symfony").unwrap();
        let app = f.root.join("staged-application");
        fs::create_dir_all(app.join("public")).unwrap();
        fs::write(app.join(".env"), "APP_ENV=dev\n").unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        setup(&f.root, &f.project, "site.test", &app, "PHP-8.3", &doc, &channel).unwrap();
        let env = fs::read_to_string(app.join(".env")).unwrap();
        assert!(env.contains("APP_ENV=dev"));
        assert!(!env.contains("DATABASE_URL"));
        assert!(app.join("public/.htaccess").is_file());
    }

    #[test]
    fn laravel_env_maps_are_resolved_for_sqlite_and_server_connections() {
        // The SQLite branch of the env maps with no console steps: a synthetic
        // document keeps the unit test free of a real PHP module.
        let f = Fixture::new("symfony", "en");
        let mut manifest: Manifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "envtest", "name": "Env", "httpPreference": "any",
            "php": true, "node": false, "installer": null, "readmePath": null,
            "database": {"enabled": true, "engines": ["sqlite"], "defaultEngine": "sqlite"},
            "projectRoot": "{base_dir}", "webRoot": "{base_dir}\\public",
            "settings": {}, "directories": [],
            "install": {
                "title": "Install", "button": "Install", "createProject": "vendor/pkg",
                "payload": {"composerName": "vendor/pkg", "files": ["public/index.php"]},
                "envSource": ".env.example",
                "env": {"APP_URL": "{url}"},
                "envSqlite": {"DB_CONNECTION": "sqlite", "DB_DATABASE": "{sqliteFile}"},
                "envServer": {"DB_HOST": "{dbHost}"},
                "sqliteDir": "database", "sqliteFallback": true
            }
        }))
        .unwrap();
        manifest.id = "envtest".into();
        let assets =
            BTreeMap::from([("files/public/index.php".to_string(), "<?php echo 1;".to_string())]);
        let doc = Document { manifest, assets, revision: None, builtin: false };
        project_starters::validate(&doc).unwrap();
        let app = f.root.join("staged-application");
        fs::create_dir_all(app.join("database")).unwrap();
        fs::write(app.join(".env.example"), "APP_NAME=Test\n").unwrap();
        fs::write(f.project.join(".osp/database.json"), br#"{"engine":"sqlite","name":"app_db"}"#).unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        setup(&f.root, &f.project, "site.test", &app, "PHP-8.3", &doc, &channel).unwrap();
        let env = fs::read_to_string(app.join(".env")).unwrap();
        assert!(env.contains("APP_URL="));
        assert!(env.contains("DB_CONNECTION=\"sqlite\""));
        assert!(env.contains("DB_DATABASE="));
        assert!(app.join("database/app_db.sqlite").is_file());
    }

    #[test]
    fn connection_values_escape_credentials_and_point_to_the_provisioned_server() {
        let f = Fixture::new("symfony", "en");
        let install = crate::project_starters::load("symfony").unwrap().manifest.install.unwrap();
        let connection = |engine: &str| crate::project_database::Connection {
            db: serde_json::from_str(&format!(
                r#"{{"engine":"{engine}","name":"app db","username":"us er","password":"p@ss:word"}}"#
            ))
            .unwrap(),
            host: "127.0.0.1".into(),
            port: 3307,
        };
        let find_url = |values: Vec<(&'static str, String)>| {
            values.into_iter().find(|(key, _)| *key == "dbUrl").unwrap().1
        };
        let url = find_url(connection_values(&connection("MySQL-8.4"), &f.project, &f.project, &install).unwrap());
        assert_eq!(url, "mysql://us%20er:p%40ss%3Aword@127.0.0.1:3307/app%20db");
        let url = find_url(connection_values(&connection("PostgreSQL-17"), &f.project, &f.project, &install).unwrap());
        assert_eq!(url, "postgresql://us%20er:p%40ss%3Aword@127.0.0.1:3307/app%20db");
        let sqlite = crate::project_database::Connection {
            db: serde_json::from_str(r#"{"engine":"sqlite","name":"app_db"}"#).unwrap(),
            host: String::new(),
            port: 0,
        };
        let url = find_url(connection_values(&sqlite, &f.project, &f.project, &install).unwrap());
        assert!(url.starts_with("sqlite:///") && url.ends_with("/var/app_db.sqlite"));
        assert!(f.project.join("var/app_db.sqlite").is_file());
    }

    #[test]
    fn wordpress_publication_preserves_configuration_rules_and_original_backup() {
        let f = Fixture::new("wordpress", "en");
        let doc = crate::project_starters::load("wordpress").unwrap();
        fs::write(f.project.join(".osp/menu.ini"), "custom menu").unwrap();
        let before = composer_installer::snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
        let result = f
            .install(&doc, |stage, _| {
                let app = composer_installer::ensure_dir(stage, "application")?;
                let public = composer_installer::ensure_dir(&app, "public")?;
                fs::write(public.join("index.php"), "wordpress")?;
                fs::write(public.join("readme.html"), "upstream documentation")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(fs::read_to_string(f.project.join(".osp/menu.ini")).unwrap(), "custom menu");
        assert_eq!(fs::read_to_string(f.project.join("public/readme.html")).unwrap(), "upstream documentation");
        assert_eq!(state(&f.project, "wordpress").as_deref(), Some("installed"));
        assert_eq!(
            composer_installer::snapshot(&fs::canonicalize(&result.backup_path).unwrap()).unwrap(),
            before
        );
        assert!(f.install(&doc, |_, _| panic!("must not start twice")).is_err());
    }

    #[test]
    fn archive_zip_must_live_inside_the_declared_directory_and_size_cap() {
        let root = std::env::temp_dir().join(format!("osp-zip-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let make = |names: &[&str]| {
            let path = root.join(format!("a-{}.zip", names.len()));
            let file = fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            for name in names {
                zip.start_file(name.to_string(), zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut zip, b"payload bytes").unwrap();
            }
            zip.finish().unwrap();
            path
        };
        let ok = make(&["wordpress/index.php", "wordpress/wp-includes/version.php"]);
        assert!(validate_zip(&ok, "wordpress", 1_000_000).is_ok());
        // An archive whose files sit at its root (no wrapper directory) is valid.
        let root_level = make(&["index.php", "install.php"]);
        assert!(validate_zip(&root_level, "", 1_000_000).is_ok());
        let outside = make(&["wordpress/index.php", "other/index.php"]);
        assert_eq!(validate_zip(&outside, "wordpress", 1_000_000).unwrap_err().code, "err.installArchive");
        let oversized = make(&["wordpress/big.bin"]);
        assert_eq!(
            validate_zip(&oversized, "wordpress", 4).unwrap_err().code,
            "err.installArchive"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_templates_escape_values_and_substitute_random_salts() {
        let template = "define('DB_NAME', {dbName});\ndefine('AUTH_KEY', '{authKey}');\n";
        let escaped = vec![("dbName", crate::project_database::php_string("it's'))))"))];
        let randoms = vec![("authKey".to_string(), "a".repeat(64))];
        let text = render_config(template, &escaped, &randoms).unwrap();
        assert!(
            text.contains(r"define('DB_NAME', 'it\'s\'))))');"),
            "{text}"
        );
        assert!(text.contains(&format!("define('AUTH_KEY', '{}');", "a".repeat(64))));
    }

    #[test]
    fn unresolved_placeholders_are_detected_without_touching_php_braces() {
        assert!(has_unresolved_placeholder("define('X', {missing});"));
        assert!(!has_unresolved_placeholder("if (!defined('ABSPATH')) { define('ABSPATH', __DIR__); }"));
        assert!(!has_unresolved_placeholder("{$var} is not a placeholder body without braces"));
        assert!(has_unresolved_placeholder("{a_b123}"));
    }

    #[test]
    fn smf_nightly_archive_installs_after_root_level_extraction() {
        // Network is disabled in unit tests; feed the real nightly archive from disk.
        let Some(zip_env) = std::env::var_os("OSP_CONTROL_SMF_NIGHTLY_ZIP") else {
            eprintln!("skipped: OSP_CONTROL_SMF_NIGHTLY_ZIP not set");
            return;
        };
        let zip_path = PathBuf::from(zip_env);
        assert!(zip_path.is_file(), "nightly zip missing: {zip_path:?}");
        let root = std::env::temp_dir().join(format!(
            "osp-smf-root-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let stage = root.join("stage");
        fs::create_dir_all(&stage).unwrap();
        let archive_path = child(&stage, "package-archive").unwrap();
        fs::copy(&zip_path, &archive_path).unwrap();
        validate_zip(&archive_path, "", 52_428_800).unwrap();
        let unpacked = child(&stage, "unpacked").unwrap();
        crate::update_files::extract(&archive_path, &unpacked).unwrap();
        for required in ["index.php", "install.php", "Settings.php", "SSI.php"] {
            assert!(child(&unpacked, required).unwrap().is_file(), "missing required file {required}");
        }
        let application = composer_installer::ensure_dir(&stage, "application").unwrap();
        let dest = child(&application, "public").unwrap();
        fs::rename(&unpacked, &dest).unwrap();
        // This is exactly what payload() runs on the staged application tree.
        crate::update_files::safe_tree(&application).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn smf_nightly_archive_production_path_with_real_setup() {
        let Some(zip_env) = std::env::var_os("OSP_CONTROL_SMF_NIGHTLY_ZIP") else {
            eprintln!("skipped: OSP_CONTROL_SMF_NIGHTLY_ZIP not set");
            return;
        };
        let zip_path = PathBuf::from(zip_env);
        let f = Fixture::new("smf", "en");
        let doc = crate::project_starters::load("smf").unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        composer_installer::install_application(
            &doc.manifest.id,
            &CODES,
            &f.root,
            "site.test",
            f.project.to_str().unwrap(),
            |root, domain, base_dir| prepared(root, domain, base_dir, &doc),
            |stage| payload(stage, &doc),
            |stage, _| {
                let archive_path = child(stage, "package-archive")?;
                fs::copy(&zip_path, &archive_path)?;
                validate_zip(&archive_path, "", 52_428_800)?;
                let unpacked = child(stage, "unpacked")?;
                crate::update_files::extract(&archive_path, &unpacked)?;
                let application = composer_installer::ensure_dir(stage, "application")?;
                fs::rename(&unpacked, child(&application, "public")?)?;
                Ok(())
            },
            || {},
            |application, php, dir| setup(&f.root, dir, "site.test", application, php, &doc, &channel),
        )
        .unwrap_or_else(|e| panic!("production install failed: {e:?}"));
        assert_eq!(state(&f.project, "smf").as_deref(), Some("installed"));
        assert!(f.project.join("public/Settings.php").is_file());
        // SMF configures no environment variables, so no .env must be created.
        assert!(!f.project.join(".env").exists());
    }

    #[test]
    #[ignore]
    fn smf_nightly_live_full_install_matches_production() {
        // Runs the real run_archive with an actual HTTP download (network), so the
        // exact production code path is exercised end to end.
        if std::env::var_os("OSP_CONTROL_SMF_LIVE").is_none() {
            eprintln!("skipped: OSP_CONTROL_SMF_LIVE not set");
            return;
        }
        let f = Fixture::new("smf", "en");
        let doc = crate::project_starters::load("smf").unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        composer_installer::install_application(
            &doc.manifest.id,
            &CODES,
            &f.root,
            "site.test",
            f.project.to_str().unwrap(),
            |root, domain, base_dir| prepared(root, domain, base_dir, &doc),
            |stage| payload(stage, &doc),
            |stage, php| run_archive(stage, &doc, &channel),
            || {},
            |application, php, dir| setup(&f.root, dir, "site.test", application, php, &doc, &channel),
        )
        .unwrap_or_else(|e| panic!("live SMF install failed: {e:?}"));
        assert_eq!(state(&f.project, "smf").as_deref(), Some("installed"));
        assert!(f.project.join("public/Settings.php").is_file());
    }

    #[test]
    fn chain_dir_with_an_empty_relative_path_returns_the_base() {
        let root = std::env::temp_dir().join(format!(
            "osp-chain-dir-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        assert_eq!(chain_dir(&root, "").unwrap(), root);
        assert_eq!(chain_dir(&root, "a/b").unwrap(), root.join("a").join("b"));
        assert_eq!(chain_dir(&root, "a//b").unwrap(), root.join("a").join("b"));
        fs::remove_dir_all(&root).unwrap();
    }
}
