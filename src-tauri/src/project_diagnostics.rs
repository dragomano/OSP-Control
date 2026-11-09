//! Read-only project checks. No project commands, scripts, HTTP requests or repairs are executed.
use crate::{
    error::CommandError,
    panel_api::{api_json, dat_field, dat_node_map, dat_string_value, parse_osp_json, services_from_json},
    paths::{external_path, is_valid_module_name, normalize_project_domain, resolve_installation},
    project_workspace::{child, parse, read},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Check {
    id: String,
    group: String,
    status: String,
    title: String,
    message: String,
    hint: Option<String>,
    params: BTreeMap<String, String>,
    evidence: String,
    tab: Option<String>,
    file_path: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    domain: String,
    checked_at: u64,
    checks: Vec<Check>,
}
fn check(
    id: &str,
    group: &str,
    kind: &str,
    status: &str,
    outcome: &str,
    evidence: impl Into<String>,
    tab: Option<&str>,
) -> Check {
    Check {
        id: id.into(),
        group: group.into(),
        status: status.into(),
        title: format!("diag.title.{kind}"),
        message: format!("diag.{kind}.{outcome}"),
        hint: (status == "error" || status == "warning").then(|| format!("diag.hint.{kind}")),
        params: BTreeMap::new(),
        evidence: evidence.into(),
        tab: tab.map(str::to_string),
        file_path: None,
    }
}
fn field(node: Option<&Value>, key: &str) -> String {
    node.and_then(|node| dat_field(node, key)).map(dat_string_value).unwrap_or_default()
}
fn project_node<'a>(projects: Option<&'a Value>, domain: &str) -> Option<&'a Value> {
    dat_node_map(projects?)?
        .into_iter()
        .find(|(key, _)| normalize_project_domain(key).is_ok_and(|key| key == domain))
        .map(|(_, node)| node)
}
fn globals(root: &Path) -> Option<Value> {
    let text = read(&child(&child(root, "system").ok()?, "program.dat").ok()?).ok()??;
    parse_osp_json(&text)
}

// A malformed project.ini can still be diagnosed when its folder or the live API establishes ownership.
fn project_dir(
    root: &Path,
    owner: &str,
    base_dir: &str,
    projects: Option<&Value>,
) -> Result<PathBuf, CommandError> {
    let home = child(root, "home")?;
    let expected = fs::canonicalize(base_dir)?;
    if expected.parent() != Some(home.as_path()) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let folder =
        expected.file_name().and_then(|s| s.to_str()).ok_or_else(|| CommandError::new("err.accessDenied"))?;
    let dir = child(&home, folder)?;
    if dir != expected || !dir.is_dir() {
        return Err(CommandError::new("err.accessDenied"));
    }
    let by_folder = normalize_project_domain(folder).is_ok_and(|name| name == owner);
    let by_api = project_node(projects, owner)
        .is_some_and(|node| fs::canonicalize(field(Some(node), "base_dir")).is_ok_and(|path| path == dir));
    let ini = child(&child(&dir, ".osp")?, "project.ini")?;
    let by_ini = read(&ini)
        .ok()
        .flatten()
        .and_then(|text| parse(&text).ok())
        .is_some_and(|sections| sections.contains_key(owner));
    if !by_folder && !by_api && !by_ini {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(dir)
}

fn expand(value: &str, root: &Path, dir: &Path, domain: &str, project_root: &str) -> Option<String> {
    let base = external_path(dir).to_string_lossy().into_owned();
    let root_text = external_path(root).to_string_lossy().into_owned();
    let drive = root_text.get(..2).filter(|s| s.ends_with(':')).unwrap_or("");
    let mut value = value.trim_matches('"').to_string();
    for _ in 0..6 {
        let previous = value.clone();
        for (key, replacement) in [
            ("base_dir", base.as_str()),
            ("root_dir", &root_text),
            ("root_drive", drive),
            ("root_path", root_text.strip_prefix(drive).unwrap_or(&root_text)),
            ("host", domain),
            ("host_decoded", &idna::domain_to_unicode(domain).0),
            ("project_root", project_root),
        ] {
            value = value.replace(&format!("{{{key}}}"), replacement);
        }
        if previous == value {
            break;
        }
    }
    if value.contains(['{', '}', '%']) {
        return None;
    }
    Some(value)
}
fn path_check(
    root: &Path,
    dir: &Path,
    domain: &str,
    project_root: &str,
    value: &str,
    kind: &str,
    directory: bool,
) -> Check {
    let mut result = check(kind, "files", kind, "skipped", "unresolved", value, Some("web"));
    let Some(expanded) = expand(value, root, dir, domain, project_root) else {
        return result;
    };
    let path = PathBuf::from(expanded.replace('\\', "/"));
    let path = if path.is_absolute() { path } else { dir.join(path) };
    result.evidence = external_path(&path).to_string_lossy().into_owned();
    // Stat only approved locations. Do not read arbitrary external paths from project settings.
    let mut ancestor = path.as_path();
    while !ancestor.exists() {
        let Some(parent) = ancestor.parent() else {
            return result;
        };
        ancestor = parent;
    }
    if !fs::canonicalize(ancestor).is_ok_and(|path| path.starts_with(root)) {
        result.message = format!("diag.{kind}.outside");
        return result;
    }
    match fs::metadata(&path) {
        Ok(meta) if if directory { meta.is_dir() } else { meta.is_file() } => {
            result.status = "ok".into();
            result.message = format!("diag.{kind}.ok");
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            result.status = "error".into();
            result.message = format!("diag.{kind}.missing");
            result.hint = Some(format!("diag.hint.{kind}"));
        }
        _ => {
            result.status = "warning".into();
            result.message = format!("diag.{kind}.unreadable");
            result.hint = Some(format!("diag.hint.{kind}"));
        }
    }
    result
}
fn tcp(ip: &str, port: u16) -> bool {
    let Ok(mut ip) = ip.parse::<IpAddr>() else {
        return false;
    };
    if ip.is_unspecified() {
        ip = if ip.is_ipv4() { "127.0.0.1".parse().unwrap() } else { "::1".parse().unwrap() };
    }
    TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(800)).is_ok()
}
fn resolve(domain: &str) -> Option<Vec<IpAddr>> {
    let (send, receive) = mpsc::sync_channel(1);
    let domain = domain.to_string();
    std::thread::spawn(move || {
        let result = (domain.as_str(), 80)
            .to_socket_addrs()
            .ok()
            .map(|addresses| addresses.map(|address| address.ip()).collect());
        let _ = send.send(result);
    });
    receive.recv_timeout(Duration::from_secs(2)).ok().flatten()
}
fn log_check(root: &Path, domain: &str) -> Check {
    let mut result = check("log", "files", "log", "skipped", "missing", "", None);
    let load = || -> Result<Option<(PathBuf, String)>, CommandError> {
        let logs = child(&child(root, "logs")?, "domains")?;
        if !logs.exists() {
            return Ok(None);
        }
        let path = child(&logs, &format!("{domain}_error.log"))?;
        if !path.exists() {
            return Ok(None);
        }
        let mut file = fs::File::open(&path)?;
        let size = file.metadata()?.len();
        let offset = size.saturating_sub(65536);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(65536).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Ok(Some((path, text)))
    };
    match load() {
        Ok(Some((path, text))) => {
            let errors: Vec<_> = text
                .lines()
                .rev()
                .filter(|line| {
                    let line = line.to_lowercase();
                    [
                        "[error]",
                        ":error]",
                        "[crit]",
                        "[alert]",
                        "[emerg]",
                        "fatal error",
                        "uncaught",
                        "\"level\":\"error\"",
                        "\"level\": \"error\"",
                    ]
                    .iter()
                    .any(|marker| line.contains(marker))
                })
                .take(3)
                .map(|line| line.chars().take(500).collect::<String>())
                .collect();
            result.status = if errors.is_empty() { "ok" } else { "warning" }.into();
            result.message = format!("diag.log.{}", if errors.is_empty() { "ok" } else { "errors" });
            result.hint = (!errors.is_empty()).then(|| "diag.hint.log".into());
            result.evidence = errors.into_iter().rev().collect::<Vec<_>>().join("\n");
            result.file_path = Some(external_path(&path).to_string_lossy().into_owned());
        }
        Err(_) => {
            result.status = "warning".into();
            result.message = "diag.log.unreadable".into();
            result.hint = Some("diag.hint.log".into());
        }
        _ => {}
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "osp-diagnostics-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            for path in [
                "home/shared/.osp",
                "home/shared/public",
                "home/shared/api",
                "modules/Nginx",
                "modules/PHP-8.3",
                "logs/domains",
                "system",
            ] {
                fs::create_dir_all(root.join(path)).unwrap();
            }
            fs::write(root.join("home/shared/.osp/project.ini"), "[shop.test]\nhttp_engine = Nginx\nphp_engine = PHP-8.3\nweb_root = {base_dir}\\public\nbind_ip = 127.0.2.1\n\n[api.shop.test]\nhttp_engine = Nginx\nweb_root = {base_dir}\\api\nbind_ip = 127.0.2.2\nhttp_port = 8080\n").unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn dir(&self) -> String {
            self.0.join("home/shared").to_string_lossy().into_owned()
        }
        fn source(&self) -> String {
            fs::read_to_string(self.0.join("home/shared/.osp/project.ini")).unwrap()
        }
        fn write(&self, value: &str) {
            fs::write(self.0.join("home/shared/.osp/project.ini"), value).unwrap();
        }
        fn projects(&self) -> Value {
            tree(vec![(
                "shop.test",
                tree(vec![
                    ("base_dir", scalar(&self.dir())),
                    ("project_enabled", scalar(true)),
                    ("defected", scalar(false)),
                    ("http_engine", scalar("Nginx")),
                    ("php_engine", scalar("PHP-8.3")),
                    ("web_root", scalar(external_path(&self.0.join("home/shared/public")).to_string_lossy())),
                    ("bind_ip", scalar("127.0.2.1")),
                    ("tls_enabled", scalar(false)),
                    ("tls_cert_file", scalar("auto")),
                    ("tls_key_file", scalar("auto")),
                ]),
            )])
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scalar(value: impl Serialize) -> Value {
        serde_json::json!({ "_value": value })
    }
    fn tree(values: Vec<(&str, Value)>) -> Value {
        serde_json::json!({ "_children": values.into_iter().map(|(key,value)| serde_json::json!({"key":key,"value":value})).collect::<Vec<_>>() })
    }
    fn modules() -> Value {
        tree(vec![
            ("Nginx", tree(vec![("enabled", scalar(true)), ("handle", scalar(1))])),
            ("PHP-8.3", tree(vec![("enabled", scalar(false)), ("handle", scalar(-1))])),
        ])
    }
    fn status<'a>(report: &'a Report, id: &str) -> &'a str {
        &report.checks.iter().find(|check| check.id == id).unwrap().status
    }
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                result.insert(path.clone(), Vec::new());
                result.extend(snapshot(&path));
            } else {
                result.insert(path.clone(), fs::read(path).unwrap());
            }
        }
        result
    }
    #[test]
    fn diagnoses_the_selected_domain_with_no_mutations_and_localized_results() {
        let f = Fixture::new();
        let projects = f.projects();
        let modules = modules();
        let before = snapshot(&f.0);
        let calls = RefCell::new(Vec::new());
        let report = inspect(
            &f.0,
            "shop.test",
            "shop.test",
            &f.dir(),
            Some(&projects),
            Some(&modules),
            |_| Some(vec!["127.0.2.1".parse().unwrap()]),
            |ip, port| {
                calls.borrow_mut().push((ip.to_string(), port));
                true
            },
        )
        .unwrap();
        assert_eq!(status(&report, "config"), "ok");
        assert_eq!(status(&report, "webRoot"), "ok");
        assert_eq!(status(&report, "module:PHP-8.3"), "warning");
        assert_eq!(status(&report, "applied"), "ok");
        assert_eq!(*calls.borrow(), vec![("127.0.2.1".into(), 80)]);
        assert_eq!(before, snapshot(&f.0));
        for text in [
            include_str!("../resources/locales/en.json"),
            include_str!("../resources/locales/ru.json"),
            include_str!("../resources/locales/uk.json"),
            include_str!("../resources/locales/be.json"),
            include_str!("../resources/locales/es.json"),
        ] {
            let dict: Value = serde_json::from_str(text).unwrap();
            for check in &report.checks {
                assert!(dict.get(&check.title).is_some(), "{}", check.title);
                assert!(dict.get(&check.message).is_some(), "{}", check.message);
                if let Some(hint) = &check.hint {
                    assert!(dict.get(hint).is_some(), "{hint}");
                }
            }
        }
        calls.borrow_mut().clear();
        let report = inspect(
            &f.0,
            "shop.test",
            "api.shop.test",
            &f.dir(),
            Some(&projects),
            Some(&modules),
            |_| None,
            |ip, port| {
                calls.borrow_mut().push((ip.to_string(), port));
                false
            },
        )
        .unwrap();
        assert_eq!(report.domain, "api.shop.test");
        assert_eq!(status(&report, "webRoot"), "ok");
        assert_eq!(status(&report, "project"), "skipped");
        assert_eq!(calls.borrow()[0], ("127.0.2.2".into(), 8080));
    }
    #[test]
    fn reports_missing_paths_modules_invalid_ports_menu_and_historical_errors() {
        let f = Fixture::new();
        f.write(
            &f.source()
                .replace("{base_dir}\\public", "{base_dir}\\missing")
                .replace("PHP-8.3", "PHP-9.9")
                .replace(
                    "bind_ip = 127.0.2.1",
                    "bind_ip = 127.0.2.1\nhttp_port = 99999\ntls_cert_file = {base_dir}\\missing.pem",
                ),
        );
        fs::write(f.0.join("home/shared/.osp/menu.ini"), "[broken\n").unwrap();
        fs::write(f.0.join("logs/domains/shop.test_error.log"), "[2001-01-01] [php:error] example failure\n")
            .unwrap();
        fs::write(f.0.join("logs/domains/api.shop.test_error.log"), "other domain secret\n").unwrap();
        let report =
            inspect(&f.0, "shop.test", "shop.test", &f.dir(), None, None, |_| None, |_, _| false).unwrap();
        for id in ["settings", "webRoot", "module:PHP-9.9", "http", "tls_cert_file", "menu"] {
            assert_eq!(status(&report, id), "error", "{id}");
        }
        assert_eq!(status(&report, "api"), "warning");
        assert_eq!(status(&report, "log"), "warning");
        let log = report.checks.iter().find(|check| check.id == "log").unwrap();
        assert!(log.evidence.contains("2001"));
        assert!(!log.evidence.contains("secret"));
    }
    #[test]
    fn detects_pending_settings_and_never_guesses_an_auto_ip_when_offline() {
        let f = Fixture::new();
        f.write(
            &f.source()
                .replace("bind_ip = 127.0.2.1", "bind_ip = auto")
                .replace("http_engine = Nginx", "http_engine = Apache"),
        );
        let mut projects = f.projects();
        let fields = projects["_children"][0]["value"]["_children"].as_array_mut().unwrap();
        fields.iter_mut().find(|field| field["key"] == "bind_ip").unwrap()["value"] = scalar("auto");
        let report = inspect(
            &f.0,
            "shop.test",
            "shop.test",
            &f.dir(),
            Some(&projects),
            None,
            |_| Some(vec!["127.0.0.1".parse().unwrap()]),
            |_, _| panic!("unresolved endpoints must not be probed"),
        )
        .unwrap();
        assert_eq!(status(&report, "applied"), "warning");
        assert_eq!(status(&report, "http"), "skipped");
        let report = inspect(
            &f.0,
            "shop.test",
            "shop.test",
            &f.dir(),
            None,
            None,
            |_| None,
            |_, _| panic!("must not fall back to localhost"),
        )
        .unwrap();
        assert_eq!(status(&report, "http"), "skipped");
    }
    #[test]
    fn malformed_settings_can_be_diagnosed_but_unowned_domains_and_paths_are_rejected() {
        let f = Fixture::new();
        let projects = f.projects();
        f.write("[shop.test\nbroken");
        let report = inspect(
            &f.0,
            "shop.test",
            "shop.test",
            &f.dir(),
            Some(&projects),
            None,
            |_| panic!(),
            |_, _| panic!(),
        )
        .unwrap();
        assert_eq!(status(&report, "config"), "error");
        assert_eq!(status(&report, "dependent"), "skipped");
        assert!(
            inspect(&f.0, "shop.test", "other.test", &f.dir(), Some(&projects), None, |_| None, |_, _| false)
                .is_err()
        );
        assert!(
            inspect(
                &f.0,
                "shop.test",
                "shop.test",
                f.0.to_str().unwrap(),
                Some(&projects),
                None,
                |_| None,
                |_, _| false
            )
            .is_err()
        );
        assert!(
            inspect(&f.0, "unowned.test", "unowned.test", &f.dir(), None, None, |_| None, |_, _| false)
                .is_err()
        );
    }
    #[test]
    fn external_and_unresolved_paths_are_skipped_without_reading_their_content() {
        let f = Fixture::new();
        let result = path_check(
            &f.0,
            &PathBuf::from(f.dir()),
            "shop.test",
            "{base_dir}",
            "{unknown}\\private",
            "webRoot",
            true,
        );
        assert_eq!(result.status, "skipped");
        let result = path_check(
            &f.0,
            &PathBuf::from(f.dir()),
            "shop.test",
            "{base_dir}",
            &std::env::temp_dir().to_string_lossy(),
            "webRoot",
            true,
        );
        assert_eq!(result.status, "skipped");
        assert_eq!(result.message, "diag.webRoot.outside");
    }
    #[cfg(windows)]
    #[test]
    fn redirected_project_directories_are_not_followed() {
        let f = Fixture::new();
        let link = f.0.join("home/linked.test");
        // Junction creation works without developer-mode privileges.
        let output = crate::paths::hidden_command("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(f.0.join("home/shared"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(project_dir(&f.0, "linked.test", link.to_str().unwrap(), None).is_err());
        let _ = fs::remove_dir(&link);
    }
    #[test]
    #[ignore = "Requires OSP_CONTROL_DIAGNOSTIC_ROOT and OSP_CONTROL_DIAGNOSTIC_DOMAIN; reads local state and connects to configured ports without running project code"]
    fn installed_project_diagnostics_are_read_only() {
        let root = fs::canonicalize(std::env::var("OSP_CONTROL_DIAGNOSTIC_ROOT").unwrap()).unwrap();
        let domain = std::env::var("OSP_CONTROL_DIAGNOSTIC_DOMAIN").unwrap();
        let projects = api_json(&root, "/getprojects").unwrap();
        let modules = api_json(&root, "/getmodules").unwrap();
        let dir = field(project_node(Some(&projects), &domain), "base_dir");
        let before = fs::read(Path::new(&dir).join(".osp/project.ini")).unwrap();
        let report =
            inspect(&root, &domain, &domain, &dir, Some(&projects), Some(&modules), resolve, tcp).unwrap();
        assert_eq!(status(&report, "config"), "ok");
        assert_eq!(before, fs::read(Path::new(&dir).join(".osp/project.ini")).unwrap());
        assert!(report.checks.len() > 10);
    }
}

fn inspect(
    root: &Path,
    owner: &str,
    selected: &str,
    base_dir: &str,
    projects: Option<&Value>,
    modules: Option<&Value>,
    dns: impl Fn(&str) -> Option<Vec<IpAddr>>,
    connect: impl Fn(&str, u16) -> bool,
) -> Result<Report, CommandError> {
    let owner = normalize_project_domain(owner)?;
    let domain = normalize_project_domain(selected)?;
    let dir = project_dir(root, &owner, base_dir, projects)?;
    let osp = child(&dir, ".osp")?;
    let ini_path = child(&osp, "project.ini")?;
    let source = read(&ini_path);
    let sections = source.as_ref().ok().and_then(|text| parse(text.as_deref().unwrap_or("")).ok());
    if domain != owner && !sections.as_ref().is_some_and(|sections| sections.contains_key(&domain)) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    let mut checks = vec![check(
        "api",
        "runtime",
        "api",
        if projects.is_some() && modules.is_some() { "ok" } else { "warning" },
        if projects.is_some() && modules.is_some() { "ok" } else { "unavailable" },
        "",
        None,
    )];
    let valid = sections.as_ref().is_some_and(|sections| sections.contains_key(&domain));
    let mut config = check(
        "config",
        "configuration",
        "config",
        if valid { "ok" } else { "error" },
        if valid {
            "ok"
        } else if matches!(source, Ok(None)) {
            "missing"
        } else {
            "invalid"
        },
        "",
        Some("overview"),
    );
    if ini_path.exists() {
        config.file_path = Some(external_path(&ini_path).to_string_lossy().into_owned());
    }
    checks.push(config);
    if !valid {
        checks.push(check("dependent", "configuration", "dependent", "skipped", "config", "", None));
        return Ok(Report { domain, checked_at: now(), checks });
    }
    let settings = &sections.as_ref().unwrap()[&domain];
    let invalid_keys: Vec<_> = settings
        .iter()
        .filter(|(key, value)| {
            if value.is_empty() || value.as_str() == "auto" {
                return false;
            }
            match key.as_str() {
                "http_port" | "https_port" | "backend_port" => {
                    value.parse::<u16>().ok().filter(|port| *port > 0).is_none()
                }
                "project_enabled" | "tls_enabled" | "backend_enabled" | "http2_enabled" => {
                    !["on", "off"].contains(&value.as_str())
                }
                "bind_ip" => !value.split_whitespace().all(|ip| ip.parse::<IpAddr>().is_ok()),
                "http_engine" => !["Apache", "Nginx", "Caddy"].contains(&value.as_str()),
                "php_engine" => !value.starts_with("PHP-") || !is_valid_module_name(value),
                "node_engine" => !value.starts_with("Node-") || !is_valid_module_name(value),
                "server_aliases" => value.split_whitespace().any(|alias| {
                    let alias = alias.replace("{host}", &domain);
                    let plain = alias.strip_prefix("*.").unwrap_or(&alias);
                    plain.parse::<IpAddr>().is_err() && normalize_project_domain(plain).is_err()
                }),
                _ => false,
            }
        })
        .map(|(key, _)| key.as_str())
        .collect();
    checks.push(check(
        "settings",
        "configuration",
        "settings",
        if invalid_keys.is_empty() { "ok" } else { "error" },
        if invalid_keys.is_empty() { "ok" } else { "invalid" },
        invalid_keys.join(", "),
        Some("web"),
    ));
    let global = globals(root);
    let defaults = global.as_ref().and_then(|json| dat_field(json, "projects"));
    let live = project_node(projects, &domain);
    let value = |key: &str, fallback: &str| {
        settings
            .get(key)
            .filter(|v| !v.is_empty() && v.as_str() != "auto")
            .cloned()
            .or_else(|| {
                let global = field(defaults, key);
                if !global.is_empty() && global != "auto" {
                    Some(global)
                } else {
                    let runtime = field(live, key);
                    (!runtime.is_empty()).then_some(runtime)
                }
            })
            .unwrap_or_else(|| fallback.into())
    };
    let enabled = value("project_enabled", "on") != "off";
    checks.push(check(
        "project",
        "runtime",
        "project",
        if !enabled {
            "warning"
        } else if live.is_none() {
            "skipped"
        } else if field(live, "defected") == "on" || field(live, "superdefect") == "on" {
            "error"
        } else if field(live, "project_enabled") == "off" {
            "warning"
        } else {
            "ok"
        },
        if !enabled || field(live, "project_enabled") == "off" {
            "disabled"
        } else if live.is_none() {
            "unknown"
        } else if field(live, "defected") == "on" || field(live, "superdefect") == "on" {
            "error"
        } else {
            "ok"
        },
        "",
        Some("domains"),
    ));
    let project_root = value("project_root", "{base_dir}");
    let expanded_root =
        expand(&project_root, root, &dir, &domain, "{base_dir}").unwrap_or(project_root.clone());
    checks.push(path_check(root, &dir, &domain, &expanded_root, &project_root, "projectRoot", true));
    checks.push(path_check(
        root,
        &dir,
        &domain,
        &expanded_root,
        &value("web_root", "{project_root}"),
        "webRoot",
        true,
    ));
    if let Some(live) = live {
        let changed: Vec<_> = [
            "http_engine",
            "php_engine",
            "node_engine",
            "project_enabled",
            "tls_enabled",
            "http_port",
            "https_port",
            "backend_enabled",
            "backend_ip",
            "backend_port",
            "web_root",
            "project_root",
        ]
        .into_iter()
        .filter(|key| {
            let Some(saved) = settings.get(*key).filter(|v| !v.is_empty() && v.as_str() != "auto") else {
                return false;
            };
            let runtime = field(Some(live), key);
            let saved = expand(saved, root, &dir, &domain, &expanded_root).unwrap_or(saved.clone());
            !saved.replace('\\', "/").eq_ignore_ascii_case(&runtime.replace('\\', "/"))
        })
        .collect();
        checks.push(check(
            "applied",
            "configuration",
            "applied",
            if changed.is_empty() { "ok" } else { "warning" },
            if changed.is_empty() { "ok" } else { "pending" },
            changed.join(", "),
            None,
        ));
    } else {
        checks.push(check("applied", "configuration", "applied", "skipped", "unknown", "", None));
    }
    let services = modules.map(services_from_json).unwrap_or_default();
    let http = value("http_engine", "");
    let mut required = vec![http.clone(), value("php_engine", ""), value("node_engine", "")];
    required.extend(value("environment", "").split_whitespace().map(str::to_string));
    required.sort();
    required.dedup();
    for module in required.into_iter().filter(|name| !name.is_empty() && name != "auto") {
        let safe = is_valid_module_name(&module);
        let installed = safe && child(&child(root, "modules")?, &module).is_ok_and(|path| path.is_dir());
        let addon = safe && child(&child(root, "addons")?, &module).is_ok_and(|path| path.is_dir());
        let status = services
            .iter()
            .find(|service| service.name.eq_ignore_ascii_case(&module))
            .map(|service| service.status.as_str());
        let (severity, outcome) = if !installed && !addon {
            ("error", "missing")
        } else if addon {
            ("ok", "addon")
        } else {
            match status {
                Some("running") => ("ok", "ok"),
                Some("stopped") => ("warning", "stopped"),
                Some("warning") => ("error", "failed"),
                _ => ("skipped", "unknown"),
            }
        };
        let mut result = check(
            &format!("module:{module}"),
            "runtime",
            "module",
            severity,
            outcome,
            "",
            Some("environment"),
        );
        result.params.insert("name".into(), module);
        checks.push(result);
    }
    let ip_text = value("bind_ip", "auto");
    let dip = field(live, "dip");
    let ips: Vec<IpAddr> = if ip_text == "auto" {
        dip.split_whitespace().filter_map(|s| s.parse().ok()).collect()
    } else {
        ip_text.split_whitespace().filter_map(|s| s.parse().ok()).collect()
    };
    let addresses = dns(&domain);
    let mut dns_check = match addresses.filter(|ips| !ips.is_empty()) {
        Some(addresses) => {
            let mismatch =
                !ips.is_empty() && !ips.iter().any(|ip| ip.is_unspecified() || addresses.contains(ip));
            check(
                "dns",
                "network",
                "dns",
                if mismatch { "warning" } else { "ok" },
                if mismatch { "mismatch" } else { "ok" },
                addresses.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "),
                None,
            )
        }
        None => check("dns", "network", "dns", "warning", "failed", "", None),
    };
    dns_check.params.insert("domain".into(), domain.clone());
    checks.push(dns_check);
    for (id, port, active) in [
        ("http", value("http_port", "80"), !http.is_empty() && enabled),
        (
            "https",
            value("https_port", "443"),
            !http.is_empty() && enabled && value("tls_enabled", "on") != "off",
        ),
        ("backend", value("backend_port", ""), enabled && value("backend_enabled", "off") == "on"),
    ] {
        let target = if id == "backend" {
            value("backend_ip", "127.0.0.1").parse::<IpAddr>().ok()
        } else {
            ips.first().copied()
        };
        let endpoint = target.zip(port.parse::<u16>().ok().filter(|p| *p > 0));
        let (severity, outcome) = if !active {
            ("skipped", "off")
        } else if port.parse::<u16>().ok().filter(|port| *port > 0).is_none()
            || (id == "backend" && target.is_none())
        {
            ("error", "invalid")
        } else if let Some((ip, port)) = endpoint {
            if connect(&ip.to_string(), port) { ("ok", "ok") } else { ("warning", "failed") }
        } else {
            ("skipped", "unknown")
        };
        checks.push(check(
            id,
            "network",
            "connection",
            severity,
            outcome,
            endpoint.map(|(ip, port)| format!("{ip}:{port}")).unwrap_or_default(),
            Some("web"),
        ));
        checks.last_mut().unwrap().title = format!("diag.title.{id}");
    }
    for key in ["tls_cert_file", "tls_key_file"] {
        let path = value(key, "auto");
        if value("tls_enabled", "on") == "off" || ["", "auto", "acme"].contains(&path.as_str()) {
            let mut result = check(key, "files", "tlsFile", "skipped", "managed", "", Some("web"));
            result.title = format!("diag.title.{key}");
            checks.push(result);
        } else {
            let mut result = path_check(root, &dir, &domain, &expanded_root, &path, "tlsFile", false);
            result.id = key.into();
            result.title = format!("diag.title.{key}");
            checks.push(result);
        }
    }
    let menu = child(&osp, "menu.ini").and_then(|path| read(&path));
    checks.push(match menu {
        Ok(Some(text)) => {
            match crate::menu::document(&text).and_then(|doc| crate::menu::render(&text, &doc.items)) {
                Ok(_) => check("menu", "configuration", "menu", "ok", "ok", "", Some("menu")),
                Err(_) => check("menu", "configuration", "menu", "error", "invalid", "", Some("menu")),
            }
        }
        Ok(None) => check("menu", "configuration", "menu", "skipped", "missing", "", Some("menu")),
        Err(_) => check("menu", "configuration", "menu", "warning", "unreadable", "", Some("menu")),
    });
    if ["Apache", "Nginx", "Caddy"].contains(&http.as_str()) {
        let conf = child(&osp, &http.to_lowercase()).and_then(|dir| child(&dir, &format!("{domain}.conf")));
        let content =
            conf.as_ref().map_err(|_| CommandError::new("err.accessDenied")).and_then(|path| read(path));
        checks.push(match content {
            Ok(Some(_)) => check(
                "localConfig",
                "configuration",
                "localConfig",
                "ok",
                "ok",
                external_path(conf.as_ref().unwrap()).to_string_lossy(),
                Some("configs"),
            ),
            Ok(None) => check(
                "localConfig",
                "configuration",
                "localConfig",
                "skipped",
                "missing",
                "",
                Some("configs"),
            ),
            Err(_) => check(
                "localConfig",
                "configuration",
                "localConfig",
                "warning",
                "unreadable",
                "",
                Some("configs"),
            ),
        });
    }
    checks.push(log_check(root, &domain));
    Ok(Report { domain, checked_at: now(), checks })
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[tauri::command]
pub async fn diagnose_project(
    domain: String,
    selected_domain: String,
    base_dir: String,
    custom_path: Option<String>,
) -> Result<Report, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
        let projects = api_json(&root, "/getprojects");
        let modules = api_json(&root, "/getmodules");
        inspect(
            &root,
            &domain,
            &selected_domain,
            &base_dir,
            projects.as_ref(),
            modules.as_ref(),
            resolve,
            tcp,
        )
    })
    .await
    .map_err(|_| CommandError::new("err.projectWorkspaceInvalid"))?
}
