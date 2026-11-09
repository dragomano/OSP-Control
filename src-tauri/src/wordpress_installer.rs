//! Official WordPress download, verified extraction and transactional publication.
use crate::{
    error::CommandError,
    laravel_installer::{
        Installed, Progress, copy_configuration, ensure_dir, progress, publish_project, snapshot,
    },
    paths::{external_path, resolve_installation},
    project_workspace::{base, child, parse},
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

const PLACEHOLDER: &str = include_str!("../resources/project-starters/wordpress-placeholder.php");
fn error(code: &str) -> CommandError {
    CommandError::new(code)
}
pub(crate) fn state(dir: &Path) -> Option<String> {
    let path = child(&child(dir, ".osp").ok()?, "wordpress.json").ok()?;
    if fs::metadata(&path).ok()?.len() > 4096 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let status = value["status"].as_str()?;
    (value["version"] == 1 && matches!(status, "pending" | "installed")).then(|| status.to_string())
}
fn prepared(
    root: &Path,
    domain: &str,
    base_dir: &str,
) -> Result<(PathBuf, crate::laravel_installer::Snapshot), CommandError> {
    let dir = base(root, domain, base_dir)?;
    if state(&dir).as_deref() != Some("pending") {
        return Err(error("err.wordpressNotPrepared"));
    }
    let files = snapshot(&dir)?;
    let placeholder = files
        .get(Path::new("public/index.php"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.wordpressConflict"))?;
    if String::from_utf8_lossy(placeholder).replace("\r\n", "\n") != PLACEHOLDER.replace("\r\n", "\n")
        || files.keys().any(|path| {
            !path.starts_with(".osp")
                && ![Path::new("public"), Path::new("public/index.php"), Path::new("public/.htaccess")]
                    .contains(&path.as_path())
        })
    {
        return Err(error("err.wordpressConflict"));
    }
    let ini = files
        .get(Path::new(".osp/project.ini"))
        .and_then(Option::as_deref)
        .ok_or_else(|| error("err.wordpressNotPrepared"))?;
    if parse(&String::from_utf8_lossy(ini))?.values().any(|v| {
        v.get("project_root").is_none_or(|p| p != "{base_dir}")
            || v.get("web_root").is_none_or(|p| p.replace('/', "\\") != r"{base_dir}\public")
    }) {
        return Err(error("err.wordpressDirectories"));
    }
    Ok((dir, files))
}
fn release(json: &[u8]) -> Result<String, CommandError> {
    let data: serde_json::Value = serde_json::from_slice(json).map_err(|_| error("err.wordpressDownload"))?;
    let offer = data["offers"]
        .as_array()
        .and_then(|offers| offers.iter().find(|o| o["response"] == "upgrade"))
        .ok_or_else(|| error("err.wordpressDownload"))?;
    let version = offer["current"].as_str().unwrap_or_default();
    if version.len() > 24
        || !(2..=3).contains(&version.split('.').count())
        || version.split('.').any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
        || offer["packages"]["full"]
            != format!("https://downloads.wordpress.org/release/wordpress-{version}.zip")
    {
        return Err(error("err.wordpressDownload"));
    }
    Ok(version.to_owned())
}
fn network(error: reqwest::Error) -> CommandError {
    #[cfg(test)]
    eprintln!("WordPress request failed: {error:?}");
    let _ = error;
    CommandError::new("err.wordpressDownload")
}
fn client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3
                || attempt.url().scheme() != "https"
                || !matches!(attempt.url().host_str(), Some("api.wordpress.org" | "downloads.wordpress.org"))
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| error("err.wordpressDownload"))
}
fn small(client: &reqwest::blocking::Client, url: &str, max: u64) -> Result<Vec<u8>, CommandError> {
    let response = client.get(url).send().and_then(|r| r.error_for_status()).map_err(network)?;
    let mut result = Vec::new();
    response.take(max + 1).read_to_end(&mut result).map_err(|_| error("err.wordpressDownload"))?;
    if result.len() as u64 > max {
        return Err(error("err.wordpressDownload"));
    }
    Ok(result)
}
fn checksum(path: &Path) -> Result<String, CommandError> {
    #[cfg(windows)]
    {
        use windows::Win32::Security::Cryptography::{BCRYPT_SHA1_ALG_HANDLE, BCryptHash};
        let bytes = fs::read(path)?;
        if bytes.len() > 100_000_000 {
            return Err(error("err.wordpressArchive"));
        }
        let mut digest = [0; 20];
        unsafe {
            BCryptHash(BCRYPT_SHA1_ALG_HANDLE, None, &bytes, &mut digest)
                .ok()
                .map_err(|_| error("err.wordpressChecksum"))?;
        }
        Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(error("err.wordpressChecksum"))
    }
}
fn download(stage: &Path, channel: &Channel<Progress>) -> Result<PathBuf, CommandError> {
    progress(channel, "downloading", String::new());
    let client = client()?;
    let version = release(&small(&client, "https://api.wordpress.org/core/version-check/1.7/", 1_048_576)?)?;
    let url = format!("https://downloads.wordpress.org/release/wordpress-{version}.zip");
    let expected = String::from_utf8(small(&client, &format!("{url}.sha1"), 128)?)
        .map_err(|_| error("err.wordpressChecksum"))?;
    let expected = expected.trim();
    if expected.len() != 40 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(error("err.wordpressChecksum"));
    }
    let mut response = client.get(url).send().and_then(|r| r.error_for_status()).map_err(network)?;
    let total = response.content_length();
    if total.is_some_and(|n| n > 100_000_000) {
        return Err(error("err.wordpressArchive"));
    }
    let archive = child(stage, "wordpress.zip")?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&archive)?;
    let mut downloaded = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = response.read(&mut buffer).map_err(|_| error("err.wordpressDownload"))?;
        if count == 0 {
            break;
        }
        downloaded += count as u64;
        if downloaded > 100_000_000 {
            return Err(error("err.wordpressArchive"));
        }
        file.write_all(&buffer[..count])?;
        let _ = channel.send(Progress {
            phase: "downloading",
            output: String::new(),
            downloaded: Some(downloaded),
            total,
        });
    }
    file.sync_all()?;
    drop(file);
    if !checksum(&archive)?.eq_ignore_ascii_case(expected) {
        return Err(error("err.wordpressChecksum"));
    }
    unpack(stage, &archive, &version, channel)
}
fn unpack(
    stage: &Path,
    archive: &Path,
    version: &str,
    channel: &Channel<Progress>,
) -> Result<PathBuf, CommandError> {
    progress(channel, "extracting", String::new());
    let unpacked = child(stage, "unpacked")?;
    extract(archive, &unpacked, version)?;
    let application = ensure_dir(stage, "application")?;
    fs::rename(child(&unpacked, "wordpress")?, child(&application, "public")?)?;
    Ok(application)
}
fn extract(archive: &Path, dir: &Path, version: &str) -> Result<(), CommandError> {
    let mut zip =
        zip::ZipArchive::new(fs::File::open(archive)?).map_err(|_| error("err.wordpressArchive"))?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|_| error("err.wordpressArchive"))?;
        if !entry.name().starts_with("wordpress/") {
            return Err(error("err.wordpressArchive"));
        }
        total = total.checked_add(entry.size()).ok_or_else(|| error("err.wordpressArchive"))?;
        if total > 300_000_000 {
            return Err(error("err.wordpressArchive"));
        }
    }
    drop(zip);
    crate::update_files::extract(archive, dir).map_err(|_| error("err.wordpressArchive"))?;
    let wordpress = child(dir, "wordpress")?;
    for path in [
        "index.php",
        "wp-settings.php",
        "wp-admin/install.php",
        "wp-includes/version.php",
        "wp-config-sample.php",
    ] {
        let mut file = wordpress.clone();
        for part in path.split('/') {
            file = child(&file, part)?;
        }
        if !file.is_file() {
            return Err(error("err.wordpressArchive"));
        }
    }
    let actual = fs::read_to_string(wordpress.join("wp-includes/version.php"))?;
    if !actual.lines().any(|line| line.trim() == format!("$wp_version = '{version}';"))
        || child(&wordpress, "wp-config.php")?.exists()
        || child(&wordpress, ".osp")?.exists()
    {
        return Err(error("err.wordpressArchive"));
    }
    Ok(())
}
fn config(connection: &crate::project_database::Connection, salts: &[u8]) -> String {
    use crate::project_database::php_string;
    let mut text = "<?php\n// Generated for this local project by OSP Control.\n".to_string();
    for (key, value) in [
        ("DB_NAME", connection.db.name.clone()),
        ("DB_USER", connection.db.username.clone()),
        ("DB_PASSWORD", connection.db.password.clone()),
        (
            "DB_HOST",
            if connection.host.contains(':') {
                format!("[{}]:{}", connection.host, connection.port)
            } else {
                format!("{}:{}", connection.host, connection.port)
            },
        ),
        ("DB_CHARSET", "utf8mb4".into()),
        ("DB_COLLATE", "".into()),
    ] {
        text.push_str(&format!("define('{}', {});\n", key, php_string(&value)));
    }
    for (i, key) in [
        "AUTH_KEY",
        "SECURE_AUTH_KEY",
        "LOGGED_IN_KEY",
        "NONCE_KEY",
        "AUTH_SALT",
        "SECURE_AUTH_SALT",
        "LOGGED_IN_SALT",
        "NONCE_SALT",
    ]
    .iter()
    .enumerate()
    {
        let value = salts[i * 32..(i + 1) * 32].iter().map(|b| format!("{b:02x}")).collect::<String>();
        text.push_str(&format!("define('{key}', '{value}');\n"));
    }
    text.push_str("$table_prefix = 'wp_';\ndefine('WP_DEBUG', false);\nif (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }\nrequire_once ABSPATH . 'wp-settings.php';\n");
    text
}
fn salts() -> Result<[u8; 256], CommandError> {
    let mut bytes = [0; 256];
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
        BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
            .ok()
            .map_err(|_| error("err.wordpressInstall"))?;
    }
    #[cfg(not(windows))]
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn install(
    root: &Path,
    domain: &str,
    base_dir: &str,
    channel: &Channel<Progress>,
    fetch: impl FnOnce(&Path, &Channel<Progress>) -> Result<PathBuf, CommandError>,
) -> Result<Installed, CommandError> {
    let (dir, original) = prepared(root, domain, base_dir)?;
    let temp = ensure_dir(root, "temp")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let name = format!("osp-control-wordpress-{}-{nonce}", std::process::id());
    let stage = child(&temp, &name)?;
    fs::create_dir(&stage)?;
    let stage = child(&temp, &name)?;
    let mut retain = false;
    let result = (|| {
        let application = fetch(&stage, channel)?;
        crate::update_files::safe_tree(&application)?;
        if prepared(root, domain, base_dir)?.1 != original {
            return Err(error("err.wordpressConflict"));
        }
        progress(channel, "database", String::new());
        let connection = crate::project_database::provision(root, &dir, &stage, true)?;
        let mut expected = original.clone();
        let after = snapshot(&dir)?;
        if let Some(value) = after.get(Path::new(".osp/database.json")) {
            if original.get(Path::new(".osp/database.json")) != Some(value)
                && !crate::project_database::permitted_status_update(
                    original.get(Path::new(".osp/database.json")).and_then(Option::as_deref),
                    value.as_deref(),
                )
            {
                return Err(error("err.wordpressConflict"));
            }

            expected.insert(PathBuf::from(".osp/database.json"), value.clone());
        }
        if after != expected {
            return Err(error("err.wordpressConflict"));
        }
        progress(channel, "configuring", String::new());
        if let Some(connection) = connection {
            fs::write(
                child(&child(&application, "public")?, "wp-config.php")?,
                config(&connection, &salts()?),
            )?;
        }
        copy_configuration(&expected, &application, "wordpress")?;
        fs::write(child(&application, ".gitignore")?, "/public/wp-config.php\n")?;
        if let Some(Some(rules)) = original.get(Path::new("public/.htaccess")) {
            fs::write(child(&child(&application, "public")?, ".htaccess")?, rules)?;
        }
        progress(channel, "publishing", String::new());
        if prepared(root, domain, base_dir)?.1 != expected {
            return Err(error("err.wordpressConflict"));
        }
        let backups = ensure_dir(&ensure_dir(root, "backups")?, "project-starters")?;
        let backup = child(&backups, &format!("wordpress-{domain}-{nonce}"))?;
        fs::write(stage.join("recovery.json"), serde_json::to_vec(&serde_json::json!({"project":external_path(&dir),"backup":external_path(&backup),"application":external_path(&application)})).map_err(|_| error("err.wordpressInstall"))?)?;
        if let Err(mut e) =
            publish_project(&dir, &application, &backup, &stage, |from, to| fs::rename(from, to))
        {
            retain = e.code == "err.laravelRecovery";
            if retain {
                e.code = "err.wordpressRecovery".into();
            }
            return Err(e);
        }
        Ok(Installed { backup_path: external_path(&backup).to_string_lossy().into_owned() })
    })();
    if !retain && stage.parent() == Some(temp.as_path()) && child(&temp, &name).is_ok_and(|p| p == stage) {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}
#[tauri::command]
pub(crate) async fn install_project_wordpress(
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<Installed, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
        progress(&on_progress, "preparing", String::new());
        install(&root, &domain, &base_dir, &on_progress, download)
    })
    .await
    .map_err(|_| error("err.wordpressInstall"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_requires_official_full_stable_archive() {
        assert_eq!(release(br#"{"offers":[{"response":"upgrade","current":"7.1.4","packages":{"full":"https://downloads.wordpress.org/release/wordpress-7.1.4.zip"}}]}"#).unwrap(), "7.1.4");
        for version in ["../outside", "7.1-beta", "7..1"] {
            let json = serde_json::json!({"offers":[{"response":"upgrade","current":version,"packages":{"full":format!("https://downloads.wordpress.org/release/wordpress-{version}.zip")}}]});
            assert!(release(&serde_json::to_vec(&json).unwrap()).is_err());
        }
        assert!(release(br#"{"offers":[{"response":"upgrade","current":"7.1.4","packages":{"full":"https://example.test/archive.zip"}}]}"#).is_err());
    }
    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "osp-wordpress-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(root.join("home")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let template = crate::project_templates::template("wordpress").unwrap();
        let files = template.files("site.test", "Nginx", "PHP-8.3", "", 3000).unwrap();
        let project = template.create(&root.join("home"), "site.test", &files).unwrap();
        (root, fs::canonicalize(project).unwrap())
    }
    #[test]
    fn publication_preserves_configuration_rules_and_original_backup() {
        let (root, project) = fixture();
        fs::write(project.join(".osp/menu.ini"), "custom menu").unwrap();
        let result =
            install(&root, "site.test", project.to_str().unwrap(), &Channel::new(|_| Ok(())), |stage, _| {
                let app = ensure_dir(stage, "application")?;
                let public = ensure_dir(&app, "public")?;
                fs::write(public.join("index.php"), "wordpress")?;
                Ok(app)
            })
            .unwrap();
        assert_eq!(fs::read_to_string(project.join(".osp/menu.ini")).unwrap(), "custom menu");
        assert!(project.join("public/.htaccess").is_file());
        assert!(!project.join(".osp/laravel.json").exists());
        assert_eq!(state(&project).as_deref(), Some("installed"));
        assert_eq!(state(Path::new(&result.backup_path)).as_deref(), Some("pending"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failure_and_user_changes_keep_original_project() {
        let (root, project) = fixture();
        let before = snapshot(&project).unwrap();
        assert!(
            install(&root, "site.test", project.to_str().unwrap(), &Channel::new(|_| Ok(())), |_, _| Err(
                error("err.wordpressDownload")
            ))
            .is_err()
        );
        assert_eq!(snapshot(&project).unwrap(), before);
        fs::write(project.join("public/index.php"), "user file").unwrap();
        assert_eq!(
            install(&root, "site.test", project.to_str().unwrap(), &Channel::new(|_| Ok(())), |_, _| panic!(
                "must not fetch"
            ))
            .unwrap_err()
            .code,
            "err.wordpressConflict"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn traversal_and_non_wordpress_archives_are_rejected() {
        for name in ["wordpress/../../outside.php", "unrelated/index.php"] {
            let (root, _) = fixture();
            let archive = root.join("archive.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"payload").unwrap();
            zip.finish().unwrap();
            assert!(extract(&archive, &root.join("unpacked"), "7.1.4").is_err());
            assert!(!root.join("outside.php").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    #[ignore = "Downloads official WordPress into an isolated temporary project; never connects to a database"]
    fn live_official_wordpress_installation() {
        let (root, project) = fixture();
        let result =
            install(&root, "site.test", project.to_str().unwrap(), &Channel::new(|_| Ok(())), download)
                .unwrap();
        assert!(project.join("public/wp-admin/install.php").is_file());
        assert!(Path::new(&result.backup_path).is_dir());
        assert!(project.join(".osp/project.ini").is_file());
        assert!(!project.join("public/wordpress").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Requires OSP_CONTROL_WORDPRESS_TEST_ARCHIVE and its .sha1 sidecar; verifies an official downloaded archive and publishes only into an isolated temporary project"]
    fn official_archive_is_verified_and_installed_offline() {
        let archive =
            PathBuf::from(std::env::var_os("OSP_CONTROL_WORDPRESS_TEST_ARCHIVE").expect("archive path"));
        let name = archive.file_name().unwrap().to_str().unwrap();
        let version = name.strip_prefix("wordpress-").and_then(|s| s.strip_suffix(".zip")).unwrap();
        let catalog = serde_json::json!({"offers":[{"response":"upgrade","current":version,"packages":{"full":format!("https://downloads.wordpress.org/release/wordpress-{version}.zip")}}]});
        release(&serde_json::to_vec(&catalog).unwrap()).unwrap();
        let expected = fs::read_to_string(archive.with_extension("zip.sha1")).unwrap();
        assert_eq!(checksum(&archive).unwrap(), expected.trim());
        let (root, project) = fixture();
        let result = install(
            &root,
            "site.test",
            project.to_str().unwrap(),
            &Channel::new(|_| Ok(())),
            |stage, channel| unpack(stage, &archive, version, channel),
        )
        .unwrap();
        assert!(project.join("public/wp-admin/install.php").is_file());
        assert!(Path::new(&result.backup_path).is_dir());
        assert!(project.join(".osp/project.ini").is_file());
        assert!(!project.join("public/wordpress").exists());
        assert_eq!(fs::read_to_string(project.join(".gitignore")).unwrap(), "/public/wp-config.php\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn generated_wordpress_configuration_quotes_credentials_and_uses_secure_salts() {
        let db = serde_json::from_str(
            r#"{"engine":"MySQL-8.4","name":"cms_test","username":"root","password":"a'\\b"}"#,
        )
        .unwrap();
        let connection = crate::project_database::Connection { db, host: "127.0.1.20".into(), port: 3306 };
        let first = salts().unwrap();
        assert_ne!(first, salts().unwrap());
        let text = config(&connection, &first);
        assert!(text.contains("define('DB_PASSWORD', 'a\\'\\\\b');"));
        assert!(text.contains("'127.0.1.20:3306'"));
        assert!(text.contains("require_once ABSPATH . 'wp-settings.php';"));
        assert!(!text.contains("put your unique phrase here"));
    }
}
