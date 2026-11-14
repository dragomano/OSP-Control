//! Shared machinery for composer-based application installers (Laravel, Symfony).
//! Each installer provides its own error codes, preparation checks, payload
//! validation and post-install setup; the orchestration below is generic.
use crate::{
    error::{CommandError, spawn_failed},
    paths::{external_path, hidden_command, is_valid_module_name},
    project_workspace::{child, parse},
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

fn error(code: &str) -> CommandError {
    CommandError::new(code)
}

pub(crate) type Snapshot = BTreeMap<PathBuf, Option<Vec<u8>>>;

// Error codes an installer uses, so Laravel and Symfony keep their own wording.
#[derive(Clone, Copy)]
pub(crate) struct Codes {
    pub(crate) install: &'static str,
    pub(crate) timeout: &'static str,
    pub(crate) environment: &'static str,
    pub(crate) conflict: &'static str,
    pub(crate) not_prepared: &'static str,
    pub(crate) recovery: &'static str,
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
pub(crate) fn run(codes: &Codes, command: &mut Command, channel: &Channel<Progress>) -> Result<(), CommandError> {
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
    let stdout = child.stdout.take().ok_or_else(|| CommandError::new(codes.install))?;
    let stderr = child.stderr.take().ok_or_else(|| CommandError::new(codes.install))?;
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
                break Err(CommandError::new(codes.timeout));
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let _ = stdout.join();
    let details = stderr.join().unwrap_or_default();
    if !result?.success() {
        return Err(CommandError::new(codes.install).with(
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
            return Err(error("err.installConflict"));
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
                    return Err(error("err.installConflict"));
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
// The composer command of the panel's PHP module: the module's own php.ini,
// its active Composer profile home and the CA bundle from the panel data.
pub(crate) fn composer_command(
    codes: &Codes,
    root: &Path,
    php: &str,
    stage: &Path,
    package: &str,
    scripts: bool,
) -> Result<Command, CommandError> {
    let module = child(&child(root, "modules")?, php)?;
    let executable = child(&module, "php.exe")?;
    let ini = child(&module, "php.ini")?;
    let config = child(&child(&child(root, "config")?, php)?, "module.ini")?;
    let config = parse(&fs::read_to_string(config)?)?;
    let profile =
        config.get("main").and_then(|values| values.get("profile")).map(String::as_str).unwrap_or("default");
    if !is_valid_module_name(profile) {
        return Err(CommandError::new(codes.environment));
    }
    let data = child(&child(root, "data")?, php)?;
    let composer_home = child(&child(&data, profile)?, "composer")?;
    let composer = child(&composer_home, "composer.phar")?;
    if !executable.is_file() || !ini.is_file() || !composer.is_file() {
        return Err(CommandError::new(codes.environment));
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
        .args(["create-project", package, "application", "--prefer-dist", "--no-interaction", "--no-progress", "--remove-vcs"]);
    // Flex recipes must run during a Symfony install; Laravel defers scripts to artisan.
    if !scripts {
        command.arg("--no-scripts");
    }
    command
        .env("PHPRC", external_path(&module))
        .env("COMPOSER_HOME", external_path(&composer_home))
        .env("COMPOSER_NO_INTERACTION", "1")
        .env("COMPOSER_PROCESS_TIMEOUT", "600")
        .env("PATH", std::env::join_paths(paths).map_err(|_| CommandError::new(codes.environment))?);
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

// A second composer run inside the created application (e.g. "require webapp").
pub(crate) fn composer_require(
    codes: &Codes,
    root: &Path,
    php: &str,
    application: &Path,
    args: &[&str],
) -> Result<Command, CommandError> {
    let module = child(&child(root, "modules")?, php)?;
    let executable = child(&module, "php.exe")?;
    let ini = child(&module, "php.ini")?;
    let config = child(&child(&child(root, "config")?, php)?, "module.ini")?;
    let config = parse(&fs::read_to_string(config)?)?;
    let profile =
        config.get("main").and_then(|values| values.get("profile")).map(String::as_str).unwrap_or("default");
    if !is_valid_module_name(profile) {
        return Err(CommandError::new(codes.environment));
    }
    let data = child(&child(root, "data")?, php)?;
    let composer_home = child(&child(&data, profile)?, "composer")?;
    let composer = child(&composer_home, "composer.phar")?;
    if !executable.is_file() || !ini.is_file() || !composer.is_file() {
        return Err(CommandError::new(codes.environment));
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
        .current_dir(external_path(application))
        .args(["-d", "output_buffering=0", "-c"])
        .arg(external_path(&ini))
        .arg(external_path(&composer))
        .args(args)
        .env("PHPRC", external_path(&module))
        .env("COMPOSER_HOME", external_path(&composer_home))
        .env("COMPOSER_NO_INTERACTION", "1")
        .env("COMPOSER_PROCESS_TIMEOUT", "600")
        .env("PATH", std::env::join_paths(paths).map_err(|_| CommandError::new(codes.environment))?);
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

// The site URL of the project: its domain plus TLS and port settings from
// project.ini, falling back to the panel's global values.
pub(crate) fn application_url(
    codes: &Codes,
    root: &Path,
    project: &Path,
    domain: &str,
) -> Result<String, CommandError> {
    use crate::panel_api::{dat_field, dat_string_value, parse_osp_json};
    let domain = crate::paths::normalize_project_domain(domain)?;
    let sections = parse(&fs::read_to_string(child(&child(project, ".osp")?, "project.ini")?)?)?;
    let values = sections.get(&domain).ok_or_else(|| CommandError::new(codes.not_prepared))?;
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
        port.parse().ok().filter(|p| *p > 0).ok_or_else(|| CommandError::new("err.projectWorkspaceInvalid"))?;
    let suffix = if port == default_port { String::new() } else { format!(":{number}") };
    Ok(format!("{scheme}://{domain}{suffix}"))
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
            dir = ensure_dir(
                &dir,
                part.as_os_str().to_str().ok_or_else(|| CommandError::new("err.accessDenied"))?,
            )?;
        }
        let target = child(
            &dir,
            path.file_name().and_then(|name| name.to_str()).ok_or_else(|| CommandError::new("err.accessDenied"))?,
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
        .ok_or_else(|| CommandError::new("err.projectTemplateInvalid"))?;
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
    codes: &Codes,
    mut move_dir: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), CommandError> {
    move_dir(dir, backup)?;
    if let Err(publish_error) = move_dir(application, dir) {
        if move_dir(backup, dir).is_err() {
            return Err(CommandError::new(codes.recovery)
                .with("path", external_path(backup).to_string_lossy())
                .with("staging", external_path(stage).to_string_lossy()));
        }
        return Err(publish_error.into());
    }
    Ok(())
}

// The whole one-click installation: prepare, run composer in isolation, verify the
// payload, set the application up, re-check for conflicts, then swap directories
// with an exact backup and rollback. kind names the marker (".osp/<kind>.json")
// and the backup folder prefix.
#[allow(clippy::too_many_arguments)]
pub(crate) fn install_application(
    kind: &str,
    codes: &Codes,
    root: &Path,
    domain: &str,
    base_dir: &str,
    prepared: impl Fn(&Path, &str, &str) -> Result<(PathBuf, String, Snapshot), CommandError>,
    payload: impl Fn(&Path) -> Result<PathBuf, CommandError>,
    runner: impl FnOnce(&Path, &str) -> Result<(), CommandError>,
    publishing: impl FnOnce(),
    setup: impl FnOnce(&Path, &str, &Path) -> Result<(), CommandError>,
) -> Result<Installed, CommandError> {
    let (dir, php, original) = prepared(root, domain, base_dir)?;
    let temp = ensure_dir(root, "temp")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let name = format!("osp-control-{kind}-{}-{nonce}", std::process::id());
    let stage = child(&temp, &name)?;
    fs::create_dir(&stage)?;
    let stage = child(&temp, &name)?;
    let mut retain = false;
    let result = (|| {
        runner(&stage, &php)?;
        let application = payload(&stage)?;
        if prepared(root, domain, base_dir)?.2 != original {
            return Err(CommandError::new(codes.conflict));
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
                return Err(CommandError::new(codes.conflict));
            }

            expected.insert(PathBuf::from(".osp/database.json"), value.clone());
        }
        if expected != after_setup {
            return Err(CommandError::new(codes.conflict));
        }
        copy_configuration(&expected, &application, kind)?;
        publishing();
        let (current, current_php, files) = prepared(root, domain, base_dir)?;
        if current != dir || current_php != php || files != expected {
            return Err(CommandError::new(codes.conflict));
        }
        let backups = ensure_dir(&ensure_dir(root, "backups")?, "starters")?;
        let backup = child(&backups, &format!("{kind}-{domain}-{nonce}"))?;
        // Retain a recovery record if a process interruption occurs during the final pair of moves.
        fs::write(stage.join("recovery.json"), serde_json::to_vec(&serde_json::json!({
            "project": external_path(&dir), "backup": external_path(&backup), "application": external_path(&application)
        })).map_err(|_| CommandError::new(codes.install))?)?;
        if let Err(error) =
            publish_project(&dir, &application, &backup, &stage, codes, |from, to| fs::rename(from, to))
        {
            retain = error.code == codes.recovery;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const CODES: Codes = Codes {
        install: "err.installFailed",
        timeout: "err.installTimeout",
        environment: "err.installEnvironment",
        conflict: "err.installConflict",
        not_prepared: "err.installNotPrepared",
        recovery: "err.installRecovery",
    };

    fn fixture(tag: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("osp-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn publication_failure_restores_original_and_failed_restore_retains_both_trees() {
        for restore_fails in [false, true] {
            let root = fixture("publish");
            let dir = root.join("project");
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("original.txt"), "original").unwrap();
            let app = root.join("application");
            fs::create_dir(&app).unwrap();
            fs::write(app.join("staged.txt"), "staged").unwrap();
            let backup = root.join("backup");
            let mut count = 0;
            let error = publish_project(&dir, &app, &backup, &root, &CODES, |from, to| {
                count += 1;
                if count == 2 || (restore_fails && count == 3) {
                    Err(std::io::ErrorKind::PermissionDenied.into())
                } else {
                    fs::rename(from, to)
                }
            })
            .unwrap_err();
            assert!(app.join("staged.txt").is_file());
            if restore_fails {
                assert_eq!(error.code, "err.installRecovery");
                assert!(backup.join("original.txt").is_file());
                assert!(!dir.exists());
            } else {
                assert_eq!(fs::read_to_string(dir.join("original.txt")).unwrap(), "original");
                assert!(!backup.exists());
            }
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn command_uses_exact_php_and_active_composer_profile_without_shell_interpolation() {
        let root = fixture("composer");
        for path in ["modules/PHP-8.3", "config/PHP-8.3", "data/PHP-8.3/custom/composer", "bin"] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        for path in ["modules/PHP-8.3/php.exe", "modules/PHP-8.3/php.ini", "data/PHP-8.3/custom/composer/composer.phar"] {
            fs::write(root.join(path), "fixture").unwrap();
        }
        fs::write(root.join("config/PHP-8.3/module.ini"), "[main]\nprofile = custom\nenabled = 1\n").unwrap();
        let command = composer_command(&CODES, &root, "PHP-8.3", &root, "laravel/laravel", false).unwrap();
        assert_eq!(command.get_program(), external_path(&root.join("modules/PHP-8.3/php.exe")));
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
        assert!(args[4].ends_with(r"data\PHP-8.3\custom\composer\composer.phar"));
        assert_eq!(command.get_current_dir().unwrap(), external_path(&root));
        assert!(composer_command(&CODES, &root, "../outside", &root, "laravel/laravel", false).is_err());
        // A manifest may allow flex recipes: the scripts flag drops --no-scripts.
        let symfony = composer_command(&CODES, &root, "PHP-8.3", &root, "symfony/skeleton", true).unwrap();
        let args = symfony.get_args().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(&args[6..], ["symfony/skeleton", "application", "--prefer-dist", "--no-interaction", "--no-progress", "--remove-vcs"]);
        let require = composer_require(&CODES, &root, "PHP-8.3", &root.join("application"), &["require", "webapp", "--no-interaction"]).unwrap();
        let args = require.get_args().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(&args[5..], ["require", "webapp", "--no-interaction"]);
        assert_eq!(require.get_current_dir().unwrap(), external_path(&root.join("application")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn application_url_uses_the_domain_and_inherits_tls_and_ports() {
        use crate::project_workspace::parse;
        let root = fixture("url");
        fs::create_dir_all(root.join("home/site.test/.osp")).unwrap();
        let project = root.join("home/site.test");
        fs::write(project.join(".osp/project.ini"), "[site.test]\n").unwrap();
        assert_eq!(application_url(&CODES, &root, &project, "site.test").unwrap(), "https://site.test");
        fs::create_dir(root.join("system")).unwrap();
        let scalar = |key: &str, value| serde_json::json!({"key": key, "value": {"_value": value}});
        let defaults = serde_json::json!({"_children": [{"key": "projects", "value": {"_children": [
            scalar("tls_enabled", serde_json::json!(false)),
            scalar("http_port", serde_json::json!(8080)),
        ]}}]});
        fs::write(root.join("system/program.dat"), defaults.to_string()).unwrap();
        assert_eq!(application_url(&CODES, &root, &project, "site.test").unwrap(), "http://site.test:8080");
        for (section, settings, expected) in [
            ("site.test", "tls_enabled = on\nhttps_port = 8443\n", "https://site.test:8443"),
            ("site", "tls_enabled = off\nhttp_port = 80\n", "http://site"),
            ("xn--caf-dma.test", "tls_enabled = auto\nhttp_port = auto\n", "http://xn--caf-dma.test:8080"),
        ] {
            fs::write(project.join(".osp/project.ini"), format!("[{section}]\n{settings}")).unwrap();
            assert_eq!(application_url(&CODES, &root, &project, section).unwrap(), expected);
        }
        let _ = parse;
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn composer_process_failure_retains_the_error_output() {
        let root = fixture("run");
        let script = root.join("composer-fixture.bat");
        fs::write(&script, "@echo synthetic-composer-error 1>&2\r\n@exit /b 7\r\n").unwrap();
        let mut command = hidden_command(external_path(&script));
        command.current_dir(external_path(&root));
        let channel = Channel::<Progress>::new(|_| Ok(()));
        let error = run(&CODES, &mut command, &channel).unwrap_err();
        assert_eq!(error.code, "err.installFailed");
        assert!(error.params["detail"].contains("synthetic-composer-error"));
        fs::remove_dir_all(&root).unwrap();
    }
}
