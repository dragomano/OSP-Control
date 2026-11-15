//! Disk-based discovery fallback used when the panel's HTTP API is silent (the
//! panel process is not running). Reconstructs modules and projects straight from
//! the installation directory, so the app stays useful without `ospanel.exe`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::panel_api::{ModuleActions, Project, Service, classify_module, module_port};
use crate::paths::normalize_project_domain;

/// A service reconstructed from disk. Carries the extra fields (`ip`, `listen_port`,
/// `enabled`, `running`) that only the UI service needs, so the overview page can
/// probe reachability without a second read of the configuration.
#[derive(Clone)]
pub(crate) struct ScanService {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) port: String,
    pub(crate) listen_port: Option<u16>,
    pub(crate) profile: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) kind: &'static str,
    pub(crate) module_actions: ModuleActions,
}

impl ScanService {
    /// Convert to the UI-facing `Service` (the same shape the panel API produces).
    pub(crate) fn into_service(self) -> Service {
        let status = if !self.enabled {
            "stopped"
        } else if self.running {
            "running"
        } else {
            // Enabled but no process — the module failed to start.
            "warning"
        };
        Service {
            name: self.name,
            version: self.version,
            port: self.port,
            profile: self.profile,
            status: status.into(),
            detail: format!("svc.detail.{}", self.kind),
            kind: self.kind.into(),
            module_actions: self.module_actions,
        }
    }
}

/// First `key = value` assignment in a flat INI text. Section headers, comments and
/// empty lines are skipped; keys compare case-insensitively, like the rest of the
/// panel's configuration handling.
fn ini_value(content: &str, key: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with([';', '#']) && !line.starts_with('[')
        })
        .find_map(|line| {
            let (k, v) = line.split_once('=')?;
            k.trim().eq_ignore_ascii_case(key).then(|| v.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

/// Read `key` from a `file` (module.ini / settings.ini) inside `dir`.
fn read_pair(dir: &Path, file: &str, key: &str) -> Option<String> {
    fs::read_to_string(dir.join(file)).ok().and_then(|text| ini_value(&text, key))
}

/// Entry of one module directory; returns `None` for non-directory entries (archives).
fn scan_module(root: &Path, name: &str, module_dir: &Path) -> Option<ScanService> {
    if !module_dir.is_dir() {
        return None;
    }

    let cfg = root.join("config").join(name);

    // Enabled state lives in config/<module>/module.ini. An explicit "off" disables
    // the module; otherwise an installed module is treated as startable — with the
    // panel stopped there is no other way to tell a configured-but-idle module from a
    // disabled one, and the user must be able to start it from the UI.
    let enabled =
        !matches!(read_pair(&cfg, "module.ini", "enabled").as_deref(), Some("0" | "off" | "false"));

    // Active profile: the name in module.ini, falling back to `default` when the
    // named profile (or the config folder) has no settings.ini.
    let mut profile = read_pair(&cfg, "module.ini", "profile");
    let mut profile_dir = match &profile {
        Some(name) => cfg.join(name),
        None => cfg.join("default"),
    };
    if !profile_dir.join("settings.ini").is_file() {
        profile_dir = cfg.join("default");
        profile = profile_dir.join("settings.ini").is_file().then(|| "default".to_string());
    }

    let listen_port = read_pair(&profile_dir, "settings.ini", "port")
        .as_deref()
        .and_then(|value| value.trim().trim_start_matches(':').parse::<u16>().ok())
        .filter(|port| *port > 0);
    let port = listen_port.map(|p| format!(":{}", p)).unwrap_or_else(|| module_port(name));

    let web_ui = read_pair(&profile_dir, "settings.ini", "web_ui_url").is_some();
    let shell_cmd = read_pair(&profile_dir, "settings.ini", "shell_command").is_some();

    // Without the panel's process table we do not probe running state — probing
    // every process is too expensive for the cold startup path. Offline, a module
    // shows as stopped/warning based on its config alone.
    let running = false;

    // The module's version is recorded in its own ospanel_data/module.ini — read it
    // straight from disk instead of launching the binary to ask.
    let version = read_pair(&module_dir.join("ospanel_data"), "module.ini", "version").unwrap_or_default();

    Some(ScanService {
        name: name.to_string(),
        version,
        port,
        listen_port,
        profile,
        enabled,
        running,
        kind: classify_module(name, None),
        module_actions: ModuleActions { browser: enabled && web_ui, shell: enabled && shell_cmd },
    })
}

/// Module list from the installation directory, sorted by name. This is a pure
/// disk read (no binary launches), so it is cheap enough to run at startup.
pub(crate) fn scan_services(root: &Path) -> Vec<ScanService> {
    let Ok(modules_dir) = fs::read_dir(root.join("modules")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in modules_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(service) = scan_module(root, &name, &entry.path()) {
            out.push(service);
        }
    }
    out.sort_by_key(|service| service.name.to_lowercase());
    out
}

/// Sections of an INI text as (name, key → value), mirroring the panel's parser.
fn ini_sections(content: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut sections = Vec::new();
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with([';', '#']) {
            continue;
        }
        if trimmed.len() >= 2 && trimmed.starts_with('[') && trimmed.ends_with(']') {
            sections.push((trimmed[1..trimmed.len() - 1].to_string(), BTreeMap::new()));
            continue;
        }
        if let Some((_, values)) = sections.last_mut()
            && let Some((key, value)) = trimmed.split_once('=')
        {
            values.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    sections
}

/// Values of the section named after the domain; with no such section, the only one.
fn project_section(content: &str, domain: &str) -> BTreeMap<String, String> {
    let sections = ini_sections(content);
    sections
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(domain))
        .or_else(|| sections.first().filter(|_| sections.len() == 1))
        .map(|(_, values)| values.clone())
        .unwrap_or_default()
}

/// The raw per-project TLS state from `.osp/project.ini`: "on" | "off" | "auto".
/// Read from disk rather than the panel API, which reports the *effective* state
/// (the `auto` value resolved against the global default) and reads as enabled for
/// every project, hiding which projects actually configure TLS.
pub(crate) fn project_tls_state(root: &Path, domain: &str) -> &'static str {
    let Some(content) =
        fs::read_to_string(root.join("home").join(domain).join(".osp").join("project.ini")).ok()
    else {
        return "auto";
    };
    match project_section(&content, domain).get("tls_enabled").map(String::as_str) {
        Some("on") => "on",
        Some("off") => "off",
        _ => "auto",
    }
}

/// Projects from `home/<domain>` directories, mirroring the `/getprojects` shape.
pub(crate) fn scan_projects(root: &Path) -> Vec<Project> {
    let home = root.join("home");
    let Ok(entries) = fs::read_dir(&home) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let domain = entry.file_name().to_string_lossy().into_owned();
        let domain = normalize_project_domain(&domain).unwrap_or(domain);

        let values =
            fs::read_to_string(entry.path().join(".osp").join("project.ini"))
                .ok()
                .map(|content| project_section(&content, &domain))
                .unwrap_or_default();

        let base_dir = values.get("base_dir").filter(|value| !value.is_empty());
        let path = match base_dir {
            Some(dir) => dir.clone(),
            None => home.join(&domain).to_string_lossy().into_owned(),
        };

        let php_engine = values.get("php_engine").cloned().unwrap_or_default();
        let php = if php_engine.is_empty() {
            "-".into()
        } else {
            php_engine.strip_prefix("PHP-").unwrap_or(&php_engine).to_string()
        };

        let http_engine = values.get("http_engine").cloned().unwrap_or_default();
        let r#type = if http_engine.is_empty() { "-".into() } else { http_engine };

        let tls_state = match values.get("tls_enabled").map(String::as_str) {
            Some("on") => "on",
            Some("off") => "off",
            _ => "auto",
        };
        out.push(Project {
            domain,
            path,
            php,
            r#type,
            ssl: tls_state == "on",
            tls: tls_state.to_string(),
        });
    }

    out.sort_by_key(|p| p.domain.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-offline-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn file(&self, path: &str, content: &str) {
            let full = self.0.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            let mut f = fs::File::create(full).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ini_value_skips_sections_and_comments() {
        let text = "[main]\n; comment\nprofile = custom\nenabled = 1\n";
        assert_eq!(ini_value(text, "profile").as_deref(), Some("custom"));
        assert_eq!(ini_value(text, "enabled").as_deref(), Some("1"));
        assert_eq!(ini_value(text, "missing"), None);
    }

    #[test]
    fn projects_are_built_from_home_directories() {
        let f = Fixture::new();
        f.file(
            "home/site.test/.osp/project.ini",
            "\u{feff}[site.test]\r\nhttp_engine = Apache\r\nphp_engine = PHP-8.3\r\ntls_enabled = on\r\n",
        );
        f.file("home/static.test/index.html", "<html></html>");
        f.file("home/not-a-project.txt", "");

        let projects = scan_projects(&f.0);
        assert_eq!(projects.len(), 2);

        let site = projects.iter().find(|p| p.domain == "site.test").unwrap();
        assert_eq!(site.path, f.0.join("home").join("site.test").to_string_lossy());
        assert_eq!(site.php, "8.3");
        assert_eq!(site.r#type, "Apache");
        assert!(site.ssl);
        assert_eq!(site.tls, "on");

        let static_site = projects.iter().find(|p| p.domain == "static.test").unwrap();
        assert_eq!(static_site.php, "-");
        assert_eq!(static_site.r#type, "-");
        assert!(!static_site.ssl);
        // A missing project.ini means "auto" — following the panel's global default.
        assert_eq!(static_site.tls, "auto");
    }

    #[test]
    fn services_report_enabled_and_profile_from_disk() {
        let f = Fixture::new();
        f.file("modules/Example/example.exe", "");
        f.file("modules/Example/ospanel_data/module.ini", "[main]\nversion = 1.2.3\n");
        f.file("config/Example/module.ini", "[main]\nprofile = dev\nenabled = 1\n");
        f.file("config/Example/dev/settings.ini", "ip = 127.0.1.10\nport = 4040\n");
        f.file("modules/Stopped/binary.exe", "");
        f.file("config/Stopped/module.ini", "[main]\nprofile = default\nenabled = 0\n");
        f.file("modules/Idle/idle.exe", "");

        let services = scan_services(&f.0);
        assert_eq!(services.len(), 3);

        let example = services.iter().find(|s| s.name == "Example").unwrap();
        assert!(example.enabled);
        assert_eq!(example.version, "1.2.3");
        assert_eq!(example.profile.as_deref(), Some("dev"));
        assert_eq!(example.port, ":4040");
        assert_eq!(example.listen_port, Some(4040));

        let stopped = services.iter().find(|s| s.name == "Stopped").unwrap();
        assert!(!stopped.enabled);
        assert_eq!(stopped.clone().into_service().status, "stopped");

        let idle = services.iter().find(|s| s.name == "Idle").unwrap();
        assert!(idle.enabled);
        assert_eq!(idle.profile.as_deref(), None);
        assert_eq!(idle.port, "—");
        assert_eq!(idle.clone().into_service().status, "warning");
    }
}
