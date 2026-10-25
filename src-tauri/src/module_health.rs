//! Module probes use the active OSPanel profile and only fresh log bytes.
use crate::module_releases::{self as releases, Kind};
use crate::{
    error::CommandError,
    panel_api::{active_profile_settings, api_json, dat_field, dat_string_value},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Profile {
    environment: BTreeMap<String, String>,
    ip: String,
    port: u16,
    #[serde(default)]
    log_directory: String,
}
pub(crate) fn profile(root: &Path, name: &str) -> Result<Profile, CommandError> {
    let json = api_json(root, "/getmodules").ok_or_else(|| CommandError::new("err.updateState"))?;
    profile_from_json(&json, name)
}
fn profile_from_json(json: &serde_json::Value, name: &str) -> Result<Profile, CommandError> {
    let node = dat_field(json, name).ok_or_else(|| CommandError::new("err.updateState"))?;
    let active = dat_field(node, "profile").map(dat_string_value).unwrap_or_default();
    let settings =
        active_profile_settings(node, &active).ok_or_else(|| CommandError::new("err.updateState"))?;
    let value = |key| dat_field(settings, key).map(dat_string_value).unwrap_or_default();
    let ip = value("ip");
    let port = value("port").parse::<u16>().map_err(|_| CommandError::new("err.updateState"))?;
    let log_directory = value("log_directory");
    if Kind::of(name)? == Kind::Php {
        return Ok(Profile { environment: BTreeMap::new(), ip, port, log_directory: String::new() });
    }
    // Parse assignments as data. Never execute environment_cmd or the profile's start_command.
    let mut environment: BTreeMap<String, String> = BTreeMap::new();
    for line in value("environment_cmd").lines() {
        let line = line.trim();
        if !line.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("set ")) {
            continue;
        }
        let assignment = line[4..].trim();
        let assignment = assignment.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(assignment);
        let Some((key, value)) = assignment.split_once('=') else {
            continue;
        };
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(CommandError::new("err.updateState"));
        }
        let mut expanded = String::new();
        let mut rest = value;
        while let Some((before, after)) = rest.split_once('%') {
            expanded.push_str(before);
            let Some((key, tail)) = after.split_once('%') else {
                return Err(CommandError::new("err.updateState"));
            };
            let value = environment
                .iter()
                .find(|(name, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
                .or_else(|| std::env::vars().find(|(name, _)| key.eq_ignore_ascii_case(name)).map(|(_, v)| v))
                .ok_or_else(|| CommandError::new("err.updateState"))?;
            expanded.push_str(&value);
            rest = tail;
        }
        expanded.push_str(rest);
        environment.insert(key.to_string(), expanded);
    }
    Ok(Profile { environment, ip, port, log_directory })
}
pub(crate) fn compatible(installed: &Path, candidate: &Path) -> Result<(), CommandError> {
    fn modules(dir: &Path) -> Result<std::collections::BTreeSet<String>, CommandError> {
        let dir = crate::paths::external_path(dir);
        let output = releases::run(
            crate::paths::hidden_command(dir.join("caddy.exe")).arg("list-modules").current_dir(&dir),
        )?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.contains(char::is_whitespace))
            .map(str::to_owned)
            .collect())
    }
    let old = modules(installed)?;
    let new = modules(candidate)?;
    let missing: Vec<_> = old.difference(&new).cloned().collect();
    if !missing.is_empty() {
        return Err(CommandError::new("err.updateModules")
            .with("detail", missing.join(", ").chars().take(400).collect::<String>()));
    }
    Ok(())
}
pub(crate) fn configuration(
    kind: Kind,
    dir: &Path,
    profile: &Profile,
    scratch: &Path,
) -> Result<(), CommandError> {
    let cli_dir = crate::paths::external_path(dir);
    let mut command = crate::paths::hidden_command(cli_dir.join(kind.executable()));
    command
        .current_dir(if kind == Kind::Apache { cli_dir.join("bin") } else { cli_dir.clone() })
        .envs(&profile.environment);
    match kind {
        Kind::Apache => {
            command
                .arg("-t")
                .arg("-d")
                .arg(&cli_dir)
                .arg("-f")
                .arg(cli_dir.join("conf/httpd.conf"))
                .env("SRVROOT", &cli_dir);
        }
        Kind::Nginx => {
            // Relative CLI paths avoid the Windows C runtime's ANSI conversion of Unicode argv.
            command.args(["-t", "-p", "./", "-c", "conf/nginx.conf", "-e", "stderr"]);
        }
        Kind::Caddy => {
            // Provisioning during validation must not modify the active certificate/state storage.
            let sandbox = crate::paths::external_path(scratch).join("validation");
            fs::create_dir_all(&sandbox)?;
            command
                .args(["validate", "--adapter", "caddyfile", "--config"])
                .arg(cli_dir.join("Caddyfile"))
                .env("XDG_CONFIG_HOME", sandbox.join("config"))
                .env("XDG_DATA_HOME", sandbox.join("data"))
                .env("XDG_STATE_HOME", sandbox.join("state"))
                .env("HOME", &sandbox)
                .env("USERPROFILE", &sandbox);
        }
        Kind::Php => return Ok(()),
    }
    releases::run(&mut command).map(|_| ()).map_err(|e| {
        if e.params.contains_key("detail") {
            CommandError { code: "err.updateConfig".into(), params: e.params }
        } else {
            e
        }
    })
}
pub(crate) type Logs = BTreeMap<PathBuf, (u64, Vec<u8>)>;
pub(crate) fn capture(root: &Path, name: &str, profile: Option<&Profile>) -> Result<Logs, CommandError> {
    let dir = root.join("logs");
    let mut logs = BTreeMap::new();
    let mut paths = Vec::new();
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
            if path.is_file()
                && filename.starts_with(&name.to_ascii_lowercase())
                && filename.ends_with(".log")
            {
                paths.push(path);
            }
        }
    }
    let module_logs = profile
        .filter(|p| !p.log_directory.is_empty())
        .map(|p| PathBuf::from(&p.log_directory))
        .unwrap_or_else(|| dir.join(name));
    if module_logs.is_dir() {
        crate::update_files::safe_tree(&module_logs)?;
        if !fs::canonicalize(&module_logs)?.starts_with(fs::canonicalize(root)?) {
            return Err(CommandError::new("err.accessDenied"));
        }
        for entry in fs::read_dir(&module_logs)? {
            let path = entry?.path();
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
            if path.is_file()
                && !filename.contains("access")
                && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("log"))
            {
                paths.push(path);
            }
        }
    }
    for path in paths {
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(fs::canonicalize(root)?) {
            return Err(CommandError::new("err.accessDenied"));
        }
        let mut f = fs::File::open(&path)?;
        let size = f.metadata()?.len();
        logs.insert(path, (size, digest_prefix(&mut f, size)?));
    }
    Ok(logs)
}
fn digest_prefix(file: &mut fs::File, size: u64) -> Result<Vec<u8>, CommandError> {
    use sha2::{Digest, Sha256};
    file.seek(SeekFrom::Start(0))?;
    let mut input = file.take(size);
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash.finalize().to_vec())
}
fn fresh_logs(root: &Path, name: &str, before: &Logs, profile: Option<&Profile>) -> Result<(), CommandError> {
    for (path, (size, _)) in capture(root, name, profile)? {
        let mut f = fs::File::open(&path)?;
        let offset = if let Some((old, hash)) = before.get(&path) {
            if *old <= size && digest_prefix(&mut f, *old)? == *hash { *old } else { 0 }
        } else {
            0
        };
        if size - offset > 1_000_000 {
            return Err(CommandError::new("err.updateHealth"));
        }
        f.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        f.take(1_000_001).read_to_end(&mut bytes)?;
        if bytes.len() > 1_000_000 || critical(&String::from_utf8_lossy(&bytes)) {
            return Err(CommandError::new("err.updateHealth"));
        }
    }
    Ok(())
}
pub(crate) fn verify(root: &Path, name: &str, before: &Logs) -> Result<(), CommandError> {
    std::thread::sleep(Duration::from_secs(3));
    let profile = profile(root, name)?;
    let ip = if profile.ip.is_empty() || profile.ip == "auto" { "127.0.0.1" } else { &profile.ip };
    let mut ip: std::net::IpAddr = ip.parse().map_err(|_| CommandError::new("err.updateState"))?;
    if ip.is_unspecified() {
        ip = if ip.is_ipv4() {
            std::net::Ipv4Addr::LOCALHOST.into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        };
    }
    let ports = if profile.port > 0 {
        vec![profile.port]
    } else if Kind::of(name)? != Kind::Php {
        web_ports(root, name, &profile)?
    } else {
        return Err(CommandError::new("err.updateState"));
    };
    if !ip.is_loopback()
        || ports.is_empty()
        || ports.iter().any(|port| {
            TcpStream::connect_timeout(&SocketAddr::new(ip, *port), Duration::from_secs(2)).is_err()
        })
    {
        return Err(CommandError::new("err.updateState"));
    }
    fresh_logs(root, name, before, Some(&profile))?;
    let module = crate::update_files::child(&root.join("modules"), name)?;
    if !crate::panel_api::modules_from_api(root).iter().any(|s| s.name == name && s.status == "running")
        || !crate::module_updates::processes(&module)?
    {
        return Err(CommandError::new("err.updateState"));
    }
    Ok(())
}
fn web_ports(root: &Path, name: &str, profile: &Profile) -> Result<Vec<u16>, CommandError> {
    let dir = crate::update_files::child(&root.join("modules"), name)?;
    let mut ports = std::collections::BTreeSet::new();
    if name == "Caddy" {
        let cli_dir = crate::paths::external_path(&dir);
        let output = releases::run(
            crate::paths::hidden_command(cli_dir.join("caddy.exe"))
                .args(["adapt", "--adapter", "caddyfile", "--config"])
                .arg(cli_dir.join("Caddyfile"))
                .envs(&profile.environment)
                .current_dir(&cli_dir),
        )?;
        let json: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|_| CommandError::new("err.updateState"))?;
        if let Some(servers) = json.pointer("/apps/http/servers").and_then(serde_json::Value::as_object) {
            for server in servers.values() {
                if let Some(listeners) = server["listen"].as_array() {
                    for listener in listeners.iter().filter_map(serde_json::Value::as_str) {
                        if let Some(port) =
                            listener.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0)
                        {
                            ports.insert(port);
                        }
                    }
                }
            }
        }
    } else {
        let path = dir.join(if name == "Apache" { "conf/httpd.conf" } else { "conf/nginx.conf" });
        let mut text = String::new();
        fs::File::open(path)?.take(4_000_001).read_to_string(&mut text)?;
        if text.len() > 4_000_000 {
            return Err(CommandError::new("err.updateState"));
        }
        for line in text.lines() {
            let words: Vec<_> = line.split_whitespace().collect();
            if words.first().is_some_and(|s| s.eq_ignore_ascii_case("listen"))
                && let Some(address) = words.get(1)
                && let Some(port) = address
                    .trim_end_matches(';')
                    .rsplit(':')
                    .next()
                    .and_then(|p| p.parse::<u16>().ok())
                    .filter(|p| *p > 0)
            {
                ports.insert(port);
            }
        }
    }
    Ok(ports.into_iter().collect())
}
fn critical(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "fatal",
        "unable to load dynamic library",
        "[error]",
        "[critical]",
        "[emerg]",
        "[alert]",
        "[crit]",
        ":error]",
        ":crit]",
        ":alert]",
        ":emerg]",
        "\"level\":\"error\"",
        "\"level\": \"error\"",
        "ошибка",
        "сбой",
    ]
    .iter()
    .any(|s| text.contains(s))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    #[ignore = "Requires OSP_CONTROL_WEB_ARCHIVES; extracts and validates isolated configurations without touching OSPanel"]
    fn real_web_server_syntax_checks_accept_canonical_paths_with_spaces() {
        let archives = PathBuf::from(std::env::var_os("OSP_CONTROL_WEB_ARCHIVES").unwrap());
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        for (kind, file) in [
            (Kind::Nginx, "nginx-1.29.6.zip"),
            (Kind::Apache, "httpd-2.4.69-261002-Win64-VS18.zip"),
            (Kind::Caddy, "caddy-v2.11.1-windows-amd64.zip"),
        ] {
            let nonce =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = temporary.join(format!(
                "osp syntax {} {} {nonce}",
                char::from_u32(0x0416).unwrap(),
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            let staging = root.join("archive");
            crate::update_files::extract(&archives.join(file), &staging).unwrap();
            let module = fs::canonicalize(releases::payload(kind, &staging).unwrap()).unwrap();
            let regular = crate::paths::external_path(&module).to_string_lossy().replace('\\', "/");
            let (config, text) = match kind {
                Kind::Nginx => (
                    "conf/nginx.conf",
                    "error_log stderr;\nevents {}\nhttp { access_log off; }\n".to_string(),
                ),
                Kind::Apache => (
                    "conf/httpd.conf",
                    format!(
                        "ServerRoot \"${{SRVROOT}}\"\nServerName localhost\nListen 127.0.0.1:49123\nErrorLog \"{regular}/logs/error.log\"\nDocumentRoot \"{regular}/htdocs\"\n"
                    ),
                ),
                _ => ("Caddyfile", "http://127.0.0.1:49125 {\n respond \"ok\"\n}\n".to_string()),
            };
            fs::write(module.join(config), text).unwrap();
            let profile = Profile {
                environment: BTreeMap::new(),
                ip: "127.0.0.1".into(),
                port: 0,
                log_directory: String::new(),
            };
            configuration(kind, &module, &profile, &root).unwrap();
            eprintln!("{kind:?}: syntax check passed with a canonical path containing spaces and Unicode");
            assert_eq!(root.parent(), Some(temporary.as_path()));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn warnings_are_not_critical() {
        assert!(!critical("PHP Deprecated: old API"));
        assert!(critical("PHP Warning: Unable to load dynamic library"));
    }
    #[test]
    fn web_server_log_formats_are_recognized() {
        for text in [
            "[ssl:error] Cannot load certificate",
            "[emerg] unknown directive",
            r#"{"level":"error","msg":"startup failed"}"#,
        ] {
            assert!(critical(text));
        }
        assert!(!critical(r#"{"level":"info","msg":"server running"}"#));
    }
    #[test]
    fn active_profile_environment_is_parsed_without_executing_shell_commands() {
        fn scalar(value: impl Into<serde_json::Value>) -> serde_json::Value {
            serde_json::json!({"_value":value.into()})
        }
        fn fields(items: Vec<(&str, serde_json::Value)>) -> serde_json::Value {
            serde_json::json!({"_children":items.into_iter().map(|(key,value)|serde_json::json!({"key":key,"value":value})).collect::<Vec<_>>()})
        }
        let settings = fields(vec![
            ("ip", scalar("127.0.1.12")),
            ("port", scalar("0")),
            (
                "environment_cmd",
                scalar(
                    "if /i ignored\r\nset \"OSP_TEST_BASE=D:\\Example\"\r\nset \"ROOT_DIR=%osp_test_base%\\Caddy\"\r\nset \"LITERAL=value & echo unused\"\r\n",
                ),
            ),
        ]);
        let json = fields(vec![(
            "Caddy",
            fields(vec![("profile", scalar("custom")), ("profiles", fields(vec![("custom", settings)]))]),
        )]);
        let profile = profile_from_json(&json, "Caddy").unwrap();
        assert_eq!(profile.port, 0);
        assert_eq!(profile.ip, "127.0.1.12");
        assert_eq!(profile.environment["ROOT_DIR"], r"D:\Example\Caddy");
        assert_eq!(profile.environment["LITERAL"], "value & echo unused");
    }
    #[test]
    fn nested_web_logs_ignore_old_errors_but_detect_new_errors() {
        let root = std::env::temp_dir().join(format!("osp-web-log-{}", std::process::id()));
        let dir = root.join("logs/Nginx");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("error.log");
        fs::write(&path, "[emerg] old failure\n").unwrap();
        let before = capture(&root, "Nginx", None).unwrap();
        fresh_logs(&root, "Nginx", &before, None).unwrap();
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"[emerg] new failure\n").unwrap();
        assert!(fresh_logs(&root, "Nginx", &before, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn custom_profile_log_directory_is_used_and_access_logs_do_not_fail_health_checks() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("osp-custom-web-log-{}", std::process::id()));
        let dir = root.join("custom-logs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("access.log"), "GET /fatal 200\n").unwrap();
        fs::write(dir.join("error.log"), "healthy\n").unwrap();
        let profile = Profile {
            environment: BTreeMap::new(),
            ip: "127.0.1.11".into(),
            port: 0,
            log_directory: dir.to_string_lossy().into_owned(),
        };
        let logs = capture(&root, "Apache", Some(&profile)).unwrap();
        assert_eq!(logs.len(), 1);
        fresh_logs(&root, "Apache", &logs, Some(&profile)).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replaced_log_with_same_prefix_is_checked_from_start() {
        let root = std::env::temp_dir().join(format!("osp-php-logs-{}", std::process::id()));
        fs::create_dir_all(root.join("logs")).unwrap();
        let path = root.join("logs/PHP-8.4.log");
        let prefix = "x".repeat(128);
        fs::write(&path, format!("{prefix}old fatal error\n")).unwrap();
        let before = capture(&root, "PHP-8.4", None).unwrap();
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"healthy startup\n").unwrap();
        fresh_logs(&root, "PHP-8.4", &before, None).unwrap();
        fs::write(&path, format!("{prefix}new fatal error\n{}", "x".repeat(256))).unwrap();
        assert!(fresh_logs(&root, "PHP-8.4", &before, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
