//! Explicit Laravel installation in isolation, followed by a checked project replacement.
use crate::{
    error::{CommandError, spawn_failed},
    paths::{external_path, hidden_command, is_valid_module_name, resolve_installation},
    project_workspace::{base, child, parse},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

pub(crate) type Snapshot = BTreeMap<PathBuf, Option<Vec<u8>>>;

pub(crate) fn state(dir: &Path) -> Option<String> {
    crate::project_starter_locale::state(dir, "laravel")
}

fn error(code: &str) -> CommandError {
    CommandError::new(code)
}
pub(crate) fn ensure_dir(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = child(parent, name)?;
    if !path.exists() {
        fs::create_dir(&path)?;
    }
    let path = child(parent, name)?;
    if !path.is_dir() {
        return Err(error("err.accessDenied"));
    }
    Ok(path)
}
pub(crate) fn snapshot(dir: &Path) -> Result<Snapshot, CommandError> {
    fn walk(
        root: &Path,
        dir: &Path,
        result: &mut Snapshot,
        remaining: &mut u64,
        depth: usize,
    ) -> Result<(), CommandError> {
        if depth > 32 || result.len() > 4096 {
            return Err(error("err.laravelConflict"));
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = child(dir, &entry.file_name().to_string_lossy())?;
            if !path.starts_with(root) {
                return Err(error("err.accessDenied"));
            }
            let relative = path.strip_prefix(root).map_err(|_| error("err.accessDenied"))?.to_path_buf();
            if path.is_dir() {
                result.insert(relative, None);
                walk(root, &path, result, remaining, depth + 1)?;
            } else if path.is_file() {
                let mut bytes = Vec::new();
                fs::File::open(&path)?.take(*remaining + 1).read_to_end(&mut bytes)?;
                if bytes.len() as u64 > *remaining {
                    return Err(error("err.laravelConflict"));
                }
                *remaining -= bytes.len() as u64;
                result.insert(relative, Some(bytes));
            } else {
                return Err(error("err.accessDenied"));
            }
        }
        Ok(())
    }
    let mut result = Snapshot::new();
    walk(dir, dir, &mut result, &mut (64 * 1024 * 1024), 0)?;
    Ok(result)
}
fn prepared(root: &Path, domain: &str, base_dir: &str) -> Result<(PathBuf, String, Snapshot), CommandError> {
    let dir = base(root, domain, base_dir)?;
    if state(&dir).as_deref() != Some("pending") {
        return Err(error("err.laravelNotPrepared"));
    }
    let files = snapshot(&dir)?;
    // A preparation contains only configuration and our known public placeholder.
    if fs::read_dir(&dir)?.any(|entry| {
        entry
            .map(|entry| ![".osp", "public"].contains(&entry.file_name().to_string_lossy().as_ref()))
            .unwrap_or(true)
    }) || files
        .keys()
        .filter(|path| path.starts_with("public") && path.as_os_str() != "public")
        .any(|path| path != Path::new("public/index.php"))
    {
        return Err(error("err.laravelConflict"));
    }
    let placeholder = files
        .get(Path::new("public/index.php"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.laravelConflict"))?;
    if !crate::project_starter_locale::matches_placeholder(&dir, "laravel", placeholder) {
        return Err(error("err.laravelConflict"));
    }
    let ini = files
        .get(Path::new(".osp/project.ini"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.laravelNotPrepared"))?;
    let ini = std::str::from_utf8(ini).map_err(|_| error("err.laravelNotPrepared"))?;
    let sections = parse(ini)?;
    let values = sections.get(domain).ok_or_else(|| error("err.laravelNotPrepared"))?;
    if sections.values().any(|values| {
        values.get("project_root").is_none_or(|root| root != "{base_dir}")
            || values.get("web_root").is_none_or(|root| root.replace('/', "\\") != r"{base_dir}\public")
    }) {
        return Err(error("err.laravelDirectories"));
    }
    let php = values.get("php_engine").cloned().unwrap_or_default();
    if !php.starts_with("PHP-") || !is_valid_module_name(&php) {
        return Err(error("err.laravelEnvironment"));
    }
    Ok((dir, php, files))
}
fn composer_command(root: &Path, php: &str, stage: &Path) -> Result<Command, CommandError> {
    let module = child(&child(root, "modules")?, php)?;
    let executable = child(&module, "php.exe")?;
    let ini = child(&module, "php.ini")?;
    let config = child(&child(&child(root, "config")?, php)?, "module.ini")?;
    let config = parse(&fs::read_to_string(config)?)?;
    let profile =
        config.get("main").and_then(|values| values.get("profile")).map(String::as_str).unwrap_or("default");
    if !is_valid_module_name(profile) {
        return Err(error("err.laravelEnvironment"));
    }
    let data = child(&child(root, "data")?, php)?;
    let composer_home = child(&child(&data, profile)?, "composer")?;
    let composer = child(&composer_home, "composer.phar")?;
    if !executable.is_file() || !ini.is_file() || !composer.is_file() {
        return Err(error("err.laravelEnvironment"));
    }
    let mut paths = vec![
        external_path(&module),
        external_path(&child(root, "bin")?),
        external_path(&composer_home.join("vendor/bin")),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    let mut command = hidden_command(external_path(&executable));
    command
        .current_dir(external_path(stage))
        .args(["-d", "output_buffering=0", "-c"])
        .arg(external_path(&ini))
        .arg(external_path(&composer))
        .args([
            "create-project",
            "laravel/laravel",
            "application",
            "--prefer-dist",
            "--no-interaction",
            "--no-progress",
            "--remove-vcs",
            "--no-scripts",
        ])
        .env("PHPRC", external_path(&module))
        .env("COMPOSER_HOME", external_path(&composer_home))
        .env("COMPOSER_NO_INTERACTION", "1")
        .env("COMPOSER_PROCESS_TIMEOUT", "600")
        .env("PATH", std::env::join_paths(paths).map_err(|_| error("err.laravelEnvironment"))?);
    for key in ["COMPOSER", "COMPOSER_VENDOR_DIR", "COMPOSER_BIN_DIR", "COMPOSER_ROOT_VERSION"] {
        command.env_remove(key);
    }
    let ssl = child(&child(root, "data")?, "ssl")?;
    let ca = child(&ssl, "cacert.pem")?;
    if ca.is_file() {
        command.env("COMPOSER_CAFILE", external_path(&ca)).env("CURL_CA_BUNDLE", external_path(&ca));
    }
    Ok(command)
}
#[derive(Clone, Serialize)]
pub(crate) struct Progress {
    pub(crate) phase: &'static str,
    pub(crate) output: String,
    pub(crate) downloaded: Option<u64>,
    pub(crate) total: Option<u64>,
}
pub(crate) fn progress(channel: &Channel<Progress>, phase: &'static str, output: String) {
    let _ = channel.send(Progress { phase, output, downloaded: None, total: None });
}
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    if let Some(windows) = std::env::var_os("SystemRoot") {
        let _ = hidden_command(PathBuf::from(windows).join("System32/taskkill.exe"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn run(command: &mut Command, channel: &Channel<Progress>) -> Result<(), CommandError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_failed)?;
    fn pump(mut stream: impl Read, channel: Channel<Progress>) -> Vec<u8> {
        let mut tail = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..count]);
            if tail.len() > 12000 {
                tail.drain(..tail.len() - 12000);
            }
            progress(&channel, "installing", String::from_utf8_lossy(&buffer[..count]).into_owned());
        }
        tail
    }
    let stdout = child.stdout.take().ok_or_else(|| error("err.laravelInstall"))?;
    let stderr = child.stderr.take().ok_or_else(|| error("err.laravelInstall"))?;
    let out_channel = channel.clone();
    let err_channel = channel.clone();
    let stdout = std::thread::spawn(move || pump(stdout, out_channel));
    let stderr = std::thread::spawn(move || pump(stderr, err_channel));
    let deadline = Instant::now() + Duration::from_secs(900);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => {
                kill_tree(&mut child);
                break Err(error.into());
            }
            _ if Instant::now() >= deadline => {
                kill_tree(&mut child);
                break Err(error("err.laravelTimeout"));
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let _ = stdout.join();
    let details = stderr.join().unwrap_or_default();
    if !result?.success() {
        return Err(error("err.laravelInstall").with(
            "detail",
            String::from_utf8_lossy(&details)
                .chars()
                .rev()
                .take(2000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>(),
        ));
    }
    Ok(())
}
fn payload(stage: &Path) -> Result<PathBuf, CommandError> {
    let application = child(stage, "application")?;
    crate::update_files::safe_tree(&application)?;
    for path in ["artisan", "composer.json", "public/index.php", "vendor/autoload.php"] {
        let mut current = application.clone();
        for part in path.split('/') {
            current = child(&current, part)?;
        }
        if !current.is_file() {
            return Err(error("err.laravelPayload"));
        }
    }
    let json: serde_json::Value = serde_json::from_slice(&fs::read(application.join("composer.json"))?)
        .map_err(|_| error("err.laravelPayload"))?;
    if json["name"] != "laravel/laravel" || child(&application, ".osp")?.exists() {
        return Err(error("err.laravelPayload"));
    }
    Ok(application)
}
fn bootstrap(
    root: &Path,
    project: &Path,
    domain: &str,
    application: &Path,
    php: &str,
    channel: &Channel<Progress>,
) -> Result<(), CommandError> {
    let ini = child(&child(&child(root, "modules")?, php)?, "php.ini")?;
    bootstrap_with_ini(root, project, domain, application, php, &ini, channel)
}

fn application_url(root: &Path, project: &Path, domain: &str) -> Result<String, CommandError> {
    use crate::panel_api::{dat_field, dat_string_value, parse_osp_json};
    let domain = crate::paths::normalize_project_domain(domain)?;
    let sections = parse(&fs::read_to_string(child(&child(project, ".osp")?, "project.ini")?)?)?;
    let values = sections.get(&domain).ok_or_else(|| error("err.laravelNotPrepared"))?;
    let system = child(root, "system")?;
    let global = fs::read_to_string(child(&system, "program.dat")?).ok().and_then(|s| parse_osp_json(&s));
    let defaults = global.as_ref().and_then(|json| dat_field(json, "projects"));
    let setting = |key: &str, fallback: &str| {
        values
            .get(key)
            .filter(|v| !v.is_empty() && v.as_str() != "auto")
            .cloned()
            .or_else(|| {
                defaults
                    .and_then(|node| dat_field(node, key))
                    .map(dat_string_value)
                    .filter(|v| !v.is_empty() && v != "auto")
            })
            .unwrap_or_else(|| fallback.into())
    };
    let tls = setting("tls_enabled", "on") != "off";
    let scheme = if tls { "https" } else { "http" };
    let default_port = if tls { "443" } else { "80" };
    let port = setting(if tls { "https_port" } else { "http_port" }, default_port);
    let number: u16 =
        port.parse().ok().filter(|p| *p > 0).ok_or_else(|| error("err.projectWorkspaceInvalid"))?;
    let suffix = if port == default_port { String::new() } else { format!(":{number}") };
    Ok(format!("{scheme}://{domain}{suffix}"))
}

fn bootstrap_with_ini(
    root: &Path,
    project: &Path,
    domain: &str,
    application: &Path,
    php: &str,
    ini: &Path,
    channel: &Channel<Progress>,
) -> Result<(), CommandError> {
    use crate::project_database::{laravel_env, provision};
    let url = application_url(root, project, domain)?;
    progress(channel, "database", String::new());
    let stage = application.parent().ok_or_else(|| error("err.laravelPayload"))?;
    let connection = provision(root, project, stage, false)?;
    let env_example = child(application, ".env.example")?;
    let mut env = fs::read_to_string(env_example)?;
    env = crate::project_database::env_set(&env, "APP_URL", &url);
    let sqlite = connection.as_ref().filter(|c| c.db.engine == "sqlite");
    let sqlite_name =
        sqlite.map(|c| format!("{}.sqlite", c.db.name)).unwrap_or_else(|| "database.sqlite".into());
    let database = child(application, "database")?;
    let sqlite_path = child(&database, &sqlite_name)?;
    // Older preparations without database metadata retain Laravel's SQLite default.
    let metadata = child(&child(project, ".osp")?, "database.json")?.exists();
    let migrate = connection.is_some() || !metadata;
    if sqlite.is_some() || !metadata {
        fs::OpenOptions::new().write(true).create_new(true).open(&sqlite_path)?;
        env = crate::project_database::env_set(&env, "DB_CONNECTION", "sqlite");
        env = crate::project_database::env_set(
            &env,
            "DB_DATABASE",
            &external_path(&sqlite_path).to_string_lossy().replace('\\', "/"),
        );
    }
    env = laravel_env(
        &env,
        connection.as_ref(),
        &external_path(&sqlite_path).to_string_lossy().replace('\\', "/"),
    );
    let env_path = child(application, ".env")?;
    fs::write(&env_path, &env)?;
    progress(channel, "configuring", String::new());
    let module = child(&child(root, "modules")?, php)?;
    let executable = child(&module, "php.exe")?;
    for args in [
        vec!["package:discover", "--ansi"],
        vec!["key:generate", "--force", "--no-interaction"],
        if migrate { vec!["migrate", "--force", "--no-interaction"] } else { vec![] },
    ] {
        if args.is_empty() {
            continue;
        }
        let mut command = hidden_command(external_path(&executable));
        command
            .current_dir(external_path(application))
            .arg("-c")
            .arg(external_path(ini))
            .arg("artisan")
            .args(args)
            .env("PHPRC", external_path(ini));
        run(&mut command, channel)?;
    }
    if sqlite.is_some() || !metadata {
        let final_path =
            external_path(&project.join("database").join(sqlite_name)).to_string_lossy().replace('\\', "/");
        let env =
            crate::project_database::env_set(&fs::read_to_string(&env_path)?, "DB_DATABASE", &final_path);
        fs::write(env_path, env)?;
    }
    Ok(())
}
pub(crate) fn copy_configuration(
    files: &Snapshot,
    application: &Path,
    kind: &str,
) -> Result<(), CommandError> {
    for (path, content) in files.iter().filter(|(path, _)| path.starts_with(".osp")) {
        let parent = path.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new(""));
        let mut dir = application.to_path_buf();
        for part in parent.components() {
            dir = ensure_dir(&dir, part.as_os_str().to_str().ok_or_else(|| error("err.accessDenied"))?)?;
        }
        let target = child(
            &dir,
            path.file_name().and_then(|name| name.to_str()).ok_or_else(|| error("err.accessDenied"))?,
        )?;
        if let Some(content) = content {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
            file.write_all(content)?;
        } else {
            ensure_dir(&dir, path.file_name().unwrap().to_str().unwrap())?;
        }
    }
    let marker_path = PathBuf::from(format!(".osp/{kind}.json"));
    let bytes = files
        .get(&marker_path)
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.projectTemplateInvalid"))?;
    fs::write(application.join(marker_path), crate::project_starter_locale::installed_marker(bytes)?)?;
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Installed {
    pub(crate) backup_path: String,
}
pub(crate) fn publish_project(
    dir: &Path,
    application: &Path,
    backup: &Path,
    stage: &Path,
    mut move_dir: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), CommandError> {
    move_dir(dir, backup)?;
    if let Err(publish_error) = move_dir(application, dir) {
        if move_dir(backup, dir).is_err() {
            return Err(error("err.laravelRecovery")
                .with("path", external_path(backup).to_string_lossy())
                .with("staging", external_path(stage).to_string_lossy()));
        }
        return Err(publish_error.into());
    }
    Ok(())
}
fn install(
    root: &Path,
    domain: &str,
    base_dir: &str,
    runner: impl FnOnce(&Path, &str) -> Result<(), CommandError>,
    publishing: impl FnOnce(),
    setup: impl FnOnce(&Path, &str, &Path) -> Result<(), CommandError>,
) -> Result<Installed, CommandError> {
    let (dir, php, original) = prepared(root, domain, base_dir)?;
    let temp = ensure_dir(root, "temp")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let name = format!("osp-control-laravel-{}-{nonce}", std::process::id());
    let stage = child(&temp, &name)?;
    fs::create_dir(&stage)?;
    let stage = child(&temp, &name)?;
    let mut retain = false;
    let result = (|| {
        runner(&stage, &php)?;
        let application = payload(&stage)?;
        if prepared(root, domain, base_dir)?.2 != original {
            return Err(error("err.laravelConflict"));
        }
        setup(&application, &php, &dir)?;
        let mut expected = original.clone();
        let after_setup = snapshot(&dir)?;
        if let Some(value) = after_setup.get(Path::new(".osp/database.json")) {
            if original.get(Path::new(".osp/database.json")) != Some(value)
                && !crate::project_database::permitted_status_update(
                    original.get(Path::new(".osp/database.json")).and_then(Option::as_deref),
                    value.as_deref(),
                )
            {
                return Err(error("err.laravelConflict"));
            }

            expected.insert(PathBuf::from(".osp/database.json"), value.clone());
        }
        if expected != after_setup {
            return Err(error("err.laravelConflict"));
        }
        copy_configuration(&expected, &application, "laravel")?;
        publishing();
        let (current, current_php, files) = prepared(root, domain, base_dir)?;
        if current != dir || current_php != php || files != expected {
            return Err(error("err.laravelConflict"));
        }
        let backups = ensure_dir(&ensure_dir(root, "backups")?, "project-starters")?;
        let backup = child(&backups, &format!("laravel-{domain}-{nonce}"))?;
        // Retain a recovery record if a process interruption occurs during the final pair of moves.
        fs::write(stage.join("recovery.json"), serde_json::to_vec(&serde_json::json!({
            "project": external_path(&dir), "backup": external_path(&backup), "application": external_path(&application)
        })).map_err(|_| error("err.laravelInstall"))?)?;
        if let Err(error) =
            publish_project(&dir, &application, &backup, &stage, |from, to| fs::rename(from, to))
        {
            retain = error.code == "err.laravelRecovery";
            return Err(error);
        }
        Ok(Installed { backup_path: external_path(&backup).to_string_lossy().into_owned() })
    })();
    if !retain
        && stage.parent() == Some(temp.as_path())
        && child(&temp, &name).is_ok_and(|path| path == stage)
    {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}
#[tauri::command]
pub(crate) async fn install_project_laravel(
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<Installed, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
        progress(&on_progress, "preparing", String::new());
        install(
            &root,
            &domain,
            &base_dir,
            |stage, php| {
                progress(&on_progress, "installing", String::new());
                let mut command = composer_command(&root, php, stage)
                    .map_err(|e| error("err.laravelEnvironment").with("detail", e.code))?;
                run(&mut command, &on_progress)
            },
            || progress(&on_progress, "publishing", String::new()),
            |application, php, dir| bootstrap(&root, dir, &domain, application, php, &on_progress),
        )
    })
    .await
    .map_err(|_| error("err.laravelInstall"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self::localized("en")
        }
        fn localized(language: &str) -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-laravel-test-{}-{nonce}", std::process::id()));
            fs::create_dir_all(root.join("home")).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let template = crate::project_templates::template("laravel").unwrap();
            let files = template.files("site.test", "Nginx", "PHP-8.3", "", 3000, language).unwrap();
            let project = template.create(&root.join("home"), "site.test", &files).unwrap();
            Self { root, project }
        }
        fn install(
            &self,
            runner: impl FnOnce(&Path, &str) -> Result<(), CommandError>,
        ) -> Result<Installed, CommandError> {
            install(&self.root, "site.test", self.project.to_str().unwrap(), runner, || {}, |_, _, _| Ok(()))
        }
        fn commands(&self) {
            for path in ["modules/PHP-8.3", "config/PHP-8.3", "data/PHP-8.3/custom/composer", "bin"] {
                fs::create_dir_all(self.root.join(path)).unwrap();
            }
            for path in [
                "modules/PHP-8.3/php.exe",
                "modules/PHP-8.3/php.ini",
                "data/PHP-8.3/custom/composer/composer.phar",
            ] {
                fs::write(self.root.join(path), "fixture").unwrap();
            }
            fs::write(self.root.join("config/PHP-8.3/module.ini"), "[main]\nprofile = custom\nenabled = 1\n")
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn application(stage: &Path, php: &str) -> Result<(), CommandError> {
        assert_eq!(php, "PHP-8.3");
        for directory in ["application/public", "application/vendor", "application/app/Http"] {
            fs::create_dir_all(stage.join(directory))?;
        }
        for path in ["artisan", ".env", "vendor/autoload.php", "app/Http/Controller.php", "README.md"] {
            fs::write(stage.join("application").join(path), "synthetic application")?;
        }
        fs::write(stage.join("application/public/index.php"), "<?php // installed application")?;
        fs::write(stage.join("application/composer.json"), r#"{"name":"laravel/laravel"}"#)?;
        Ok(())
    }

    #[test]
    fn application_url_uses_the_domain_and_inherits_tls_and_ports() {
        let f = Fixture::new();
        assert_eq!(application_url(&f.root, &f.project, "site.test").unwrap(), "https://site.test");
        fs::create_dir(f.root.join("system")).unwrap();
        let scalar = |key, value| serde_json::json!({"key": key, "value": {"_value": value}});
        let defaults = serde_json::json!({"_children": [{"key": "projects", "value": {"_children": [
            scalar("tls_enabled", serde_json::json!(false)),
            scalar("http_port", serde_json::json!(8080)),
        ]}}]});
        fs::write(f.root.join("system/program.dat"), defaults.to_string()).unwrap();
        assert_eq!(application_url(&f.root, &f.project, "site.test").unwrap(), "http://site.test:8080");
        for (section, settings, expected) in [
            ("site.test", "tls_enabled = on\nhttps_port = 8443\n", "https://site.test:8443"),
            ("site", "tls_enabled = off\nhttp_port = 80\n", "http://site"),
            ("xn--caf-dma.test", "tls_enabled = auto\nhttp_port = auto\n", "http://xn--caf-dma.test:8080"),
        ] {
            fs::write(f.project.join(".osp/project.ini"), format!("[{section}]\n{settings}")).unwrap();
            assert_eq!(application_url(&f.root, &f.project, section).unwrap(), expected);
        }
    }

    #[test]
    fn successful_install_keeps_configuration_and_exact_original_backup_without_wrapper_directory() {
        let f = Fixture::new();
        fs::write(f.project.join(".osp/env.ini"), "\u{feff}[site.test]\r\nCUSTOM_VALUE = preserved\r\n")
            .unwrap();
        let before = snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
        let result = f.install(application).unwrap();
        assert!(f.project.join("app/Http/Controller.php").is_file());
        assert!(!f.project.join("app/app").exists());
        assert_eq!(fs::read_to_string(f.project.join("README.md")).unwrap(), "synthetic application");
        assert_eq!(state(&f.project).as_deref(), Some("installed"));
        assert_eq!(snapshot(&fs::canonicalize(&result.backup_path).unwrap()).unwrap(), before);
        let mut expected = before
            .iter()
            .filter(|(path, _)| path.starts_with(".osp"))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect::<Snapshot>();
        expected.insert(
            PathBuf::from(".osp/laravel.json"),
            Some(
                crate::project_starter_locale::installed_marker(
                    before[Path::new(".osp/laravel.json")].as_deref().unwrap(),
                )
                .unwrap()
                .into_bytes(),
            ),
        );
        let after = snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
        let after = after.into_iter().filter(|(path, _)| path.starts_with(".osp")).collect::<Snapshot>();
        assert_eq!(after, expected);
        assert_eq!(fs::read_dir(f.root.join("temp")).unwrap().count(), 0);
        assert!(f.install(application).is_err());
    }
    #[test]
    fn installs_every_localized_preparation_without_rewriting_its_instructions() {
        for language in crate::project_starter_locale::LANGUAGES {
            let f = Fixture::localized(language);
            let document = f.project.join(".osp/laravel-readme.md");
            fs::write(
                &document,
                format!(
                    "{}\nUser-maintained project instructions.\n",
                    fs::read_to_string(&document).unwrap()
                ),
            )
            .unwrap();
            let original = fs::read(&document).unwrap();
            f.install(application).unwrap();
            assert_eq!(fs::read(document).unwrap(), original);
            let marker: serde_json::Value =
                serde_json::from_slice(&fs::read(f.project.join(".osp/laravel.json")).unwrap()).unwrap();
            assert_eq!(marker["language"], language);
            assert_eq!(marker["status"], "installed");
            assert_eq!(fs::read_to_string(f.project.join("README.md")).unwrap(), "synthetic application");
        }
    }

    #[test]
    fn failed_composer_or_incomplete_payload_leaves_original_files_and_cleans_staging() {
        for incomplete in [false, true] {
            let f = Fixture::new();
            let before = snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
            let error = f
                .install(|stage, _| {
                    fs::create_dir(stage.join("application"))?;
                    fs::write(stage.join("application/partial.txt"), "partial")?;
                    if incomplete { Ok(()) } else { Err(error("err.laravelInstall")) }
                })
                .unwrap_err();
            assert_eq!(error.code, if incomplete { "err.laravelPayload" } else { "err.laravelInstall" });
            assert_eq!(snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap(), before);
            assert_eq!(state(&f.project).as_deref(), Some("pending"));
            assert_eq!(fs::read_dir(f.root.join("temp")).unwrap().count(), 0);
            assert!(!f.root.join("backups").exists());
        }
    }
    #[test]
    fn extra_project_files_and_edited_placeholder_prevent_installation_before_runner() {
        for path in ["public/keep.txt", "public/index.php", "composer.json"] {
            let f = Fixture::new();
            fs::write(f.project.join(path), "user content").unwrap();
            let before = snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
            let error = f.install(|_, _| panic!("must not start Composer")).unwrap_err();
            assert_eq!(error.code, "err.laravelConflict");
            assert_eq!(snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap(), before);
            assert!(!f.root.join("temp").exists());
        }
    }
    #[test]
    fn concurrent_configuration_edits_cancel_publication_without_losing_changes() {
        let f = Fixture::new();
        let error = f
            .install(|stage, php| {
                application(stage, php)?;
                fs::write(f.project.join(".osp/env.ini"), "changed externally")?;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "err.laravelConflict");
        assert_eq!(fs::read_to_string(f.project.join(".osp/env.ini")).unwrap(), "changed externally");
        assert_eq!(state(&f.project).as_deref(), Some("pending"));
        assert!(!f.project.join("artisan").exists());
        assert_eq!(fs::read_dir(f.root.join("temp")).unwrap().count(), 0);
    }
    #[test]
    fn publication_failure_restores_original_and_failed_restore_retains_both_trees() {
        for restore_fails in [false, true] {
            let f = Fixture::new();
            let app = f.root.join("application");
            fs::create_dir(&app).unwrap();
            fs::write(app.join("artisan"), "staged").unwrap();
            let backup = f.root.join("backup");
            let before = snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap();
            let mut count = 0;
            let error = publish_project(&f.project, &app, &backup, &f.root, |from, to| {
                count += 1;
                if count == 2 || (restore_fails && count == 3) {
                    Err(std::io::ErrorKind::PermissionDenied.into())
                } else {
                    fs::rename(from, to)
                }
            })
            .unwrap_err();
            assert!(app.join("artisan").is_file());
            if restore_fails {
                assert_eq!(error.code, "err.laravelRecovery");
                assert_eq!(snapshot(&fs::canonicalize(backup).unwrap()).unwrap(), before);
                assert!(!f.project.exists());
            } else {
                assert_eq!(snapshot(&fs::canonicalize(&f.project).unwrap()).unwrap(), before);
                assert!(!backup.exists());
            }
        }
    }
    #[test]
    fn command_uses_exact_php_and_active_composer_profile_without_shell_interpolation() {
        let f = Fixture::new();
        f.commands();
        let command = composer_command(&f.root, "PHP-8.3", &f.root).unwrap();
        assert_eq!(command.get_program(), external_path(&f.root.join("modules/PHP-8.3/php.exe")));
        let args = command.get_args().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(
            &args[5..],
            [
                "create-project",
                "laravel/laravel",
                "application",
                "--prefer-dist",
                "--no-interaction",
                "--no-progress",
                "--remove-vcs",
                "--no-scripts"
            ]
        );
        assert!(args[4].ends_with("data\\PHP-8.3\\custom\\composer\\composer.phar"));
        assert_eq!(command.get_current_dir().unwrap(), external_path(&f.root));
        assert!(composer_command(&f.root, "../outside", &f.root).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn composer_process_failure_retains_the_error_output() {
        let f = Fixture::new();
        let script = f.root.join("composer-fixture.bat");
        fs::write(&script, "@echo synthetic-composer-error 1>&2\r\n@exit /b 7\r\n").unwrap();
        let mut command = hidden_command(external_path(&script));
        command.current_dir(external_path(&f.root));
        let channel = Channel::<Progress>::new(|_| Ok(()));
        let error = run(&mut command, &channel).unwrap_err();
        assert_eq!(error.code, "err.laravelInstall");
        assert!(error.params["detail"].contains("synthetic-composer-error"));
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_LARAVEL_TEST_ROOT; installs official Laravel only in a temporary test project, using a private Composer home/cache and copied PHP configuration"]
    fn live_composer_installs_laravel_in_an_isolated_project() {
        let source = fs::canonicalize(
            std::env::var_os("OSP_CONTROL_LARAVEL_TEST_ROOT").expect("test installation root"),
        )
        .unwrap();
        let f = Fixture::new();
        let settings =
            serde_json::json!({"engine":"sqlite","name":"application_test","username":"","password":""});
        fs::write(f.project.join(".osp/database.json"), serde_json::to_vec(&settings).unwrap()).unwrap();
        let sandbox = f.root.join("php-sandbox");
        fs::create_dir_all(sandbox.join("temp")).unwrap();
        fs::create_dir_all(sandbox.join("composer")).unwrap();
        let ini = fs::read_to_string(source.join("modules/PHP-8.3/php.ini")).unwrap();
        let temp = external_path(&sandbox.join("temp")).to_string_lossy().replace('\\', "/");
        let ini = format!(
            "{ini}\n[PHP]\nerror_log = \"{temp}/php-error.log\"\nsys_temp_dir = \"{temp}\"\nupload_tmp_dir = \"{temp}\"\nsession.save_path = \"{temp}\"\nopcache.file_cache = \"\"\n"
        );
        let ini_path = sandbox.join("php.ini");
        fs::write(&ini_path, ini).unwrap();
        let channel = Channel::<Progress>::new(|_| Ok(()));
        let installed = f
            .install(|stage, php| {
                let original = composer_command(&source, php, stage)?;
                let mut args = original.get_args().map(|arg| arg.to_os_string()).collect::<Vec<_>>();
                args[3] = external_path(&ini_path).into_os_string();
                let mut command = hidden_command(original.get_program());
                command.args(args).current_dir(original.get_current_dir().unwrap());
                for (key, value) in original.get_envs() {
                    if let Some(value) = value {
                        command.env(key, value);
                    } else {
                        command.env_remove(key);
                    }
                }
                command
                    .env("PHPRC", external_path(&ini_path))
                    .env("COMPOSER_HOME", external_path(&sandbox.join("composer")))
                    .env("COMPOSER_CACHE_DIR", external_path(&sandbox.join("composer/cache")))
                    .env("TEMP", external_path(&sandbox.join("temp")))
                    .env("TMP", external_path(&sandbox.join("temp")));
                run(&mut command, &channel)?;
                bootstrap_with_ini(
                    &source,
                    &f.project,
                    "site.test",
                    &stage.join("application"),
                    php,
                    &ini_path,
                    &channel,
                )
            })
            .unwrap();
        assert!(f.project.join("app").is_dir());
        assert!(!f.project.join("app/app").exists());
        assert!(f.project.join("public/index.php").is_file());
        assert!(f.project.join("vendor/autoload.php").is_file());
        assert!(
            fs::read(f.project.join("database/application_test.sqlite"))
                .unwrap()
                .starts_with(b"SQLite format 3")
        );
        assert!(fs::read_to_string(f.project.join(".env")).unwrap().contains("application_test.sqlite"));
        assert!(Path::new(&installed.backup_path).join("public/index.php").is_file());
        assert_eq!(state(&f.project).as_deref(), Some("installed"));
    }

    #[test]
    #[cfg(windows)]
    fn redirected_public_directory_and_nvm_versions_are_not_followed() {
        use std::os::windows::fs::symlink_dir;
        let f = Fixture::new();
        let outside = f.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let public = f.project.join("public");
        fs::remove_dir_all(&public).unwrap();
        if symlink_dir(&outside, &public).is_err() {
            return;
        }
        assert!(f.install(|_, _| panic!("must not execute")).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir(public).unwrap();
        let nvm = f.root.join("addons/NVM");
        fs::create_dir_all(&nvm).unwrap();
        fs::write(nvm.join("nvm.exe"), "").unwrap();
        fs::write(outside.join("node.exe"), "").unwrap();
        let link = nvm.join("v24.0.0");
        symlink_dir(&outside, &link).unwrap();
        let options =
            crate::projects::project_module_options(Some(f.root.to_string_lossy().into_owned())).unwrap();
        assert_eq!(serde_json::to_value(options).unwrap()["nodeEngines"], serde_json::json!([]));
        fs::remove_dir(link).unwrap();
    }
}
