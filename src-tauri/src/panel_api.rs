//! The panel's machine-readable sources: HTTP API (/getmodules, /getprojects) and program.dat parsing.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Service {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) port: String,
    pub(crate) status: String,
    pub(crate) detail: String,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Project {
    pub(crate) domain: String,
    pub(crate) path: String,
    pub(crate) php: String,
    pub(crate) r#type: String,
    pub(crate) ssl: bool,
}

// --- Panel state via its local HTTP API ---
// ospanel.exe serves an API with machine-readable endpoints /getmodules and /getprojects
// (the address is in system/program.dat: general.api_ip/api_port). We work with those, not
// with the text tables of `osp.bat status`: those are localized, and parsing breaks when
// the panel UI language changes.

// Known OSPanel modules: (name fragment, svc.detail.* category, default port).
// The API provides the category and port itself (module.category, profiles.<profile>.port);
// the values below are a fallback for modules without a port in their profile (like Bind).
const KNOWN_MODULES: &[(&str, &str, &str)] = &[
    ("Apache", "web", "80"),
    ("Nginx", "web", "80"),
    ("Caddy", "web", "80"),
    ("PHP", "runtime", "9000"),
    ("MySQL", "database", "3306"),
    ("MariaDB", "database", "3306"),
    ("Postgre", "database", "5432"),
    ("Mongo", "database", "27017"),
    ("PocketBase", "database", "8090"),
    ("Redis", "cache", "6379"),
    ("Memcached", "cache", "11211"),
    ("Bind", "dns", "53"),
    ("Unbound", "dns", "53"),
    ("Blackfire", "profiler", "8307"),
    ("Mailpit", "mail", "25"),
    ("Smtp4dev", "mail", "25"),
    ("RabbitMQ", "broker", "5672"),
    ("SFTPGo", "transfer", "443"),
    ("Vault", "security", "8200"),
];

// Module category from the API → category for the UI (svc.detail.*).
fn osp_category_kind(category: &str) -> Option<&'static str> {
    match category {
        "HTTP" => Some("web"),
        "PHP" => Some("runtime"),
        "MySQL" | "MariaDB" | "PostgreSQL" | "MongoDB" | "PocketBase" => Some("database"),
        "Redis" | "Memcached" => Some("cache"),
        "DNS" => Some("dns"),
        "Blackfire" => Some("profiler"),
        "Mail" => Some("mail"),
        "RabbitMQ" => Some("broker"),
        "SFTP" => Some("transfer"),
        "Vault" => Some("security"),
        _ => None,
    }
}

pub(crate) fn classify_module(name: &str, api_category: Option<&str>) -> &'static str {
    if let Some(kind) = api_category.and_then(osp_category_kind) {
        return kind;
    }
    KNOWN_MODULES
        .iter()
        .find(|(fragment, _, _)| name.contains(fragment))
        .map(|&(_, kind, _)| kind)
        .unwrap_or("module")
}

pub(crate) fn module_port(name: &str) -> String {
    match KNOWN_MODULES.iter().find(|(fragment, _, _)| name.contains(fragment)) {
        Some(&(_, _, port)) => format!(":{}", port),
        None => "—".into(),
    }
}

// The panel's JSON is not strictly valid: raw control bytes (NUL separators of env
// blocks) appear inside strings. Outside strings control characters are optional
// whitespace; inside they are always garbage, so they can simply be removed.
pub(crate) fn parse_osp_json(raw: &str) -> Option<serde_json::Value> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.strip_prefix('\u{feff}').unwrap_or(&cleaned);
    serde_json::from_str(cleaned).ok()
}

// API address from the panel's program.dat; factory default is 127.0.1.0:80.
fn api_address(root: &Path) -> String {
    const DEFAULT_IP: &str = "127.0.1.0";
    const DEFAULT_PORT: &str = "80";

    let default = || format!("{}:{}", DEFAULT_IP, DEFAULT_PORT);

    let Ok(text) = fs::read_to_string(root.join("system").join("program.dat")) else {
        return default();
    };
    let Some(json) = parse_osp_json(&text) else {
        return default();
    };

    let general = dat_field(&json, "general").and_then(dat_node_map);
    let field = |key: &str| {
        general
            .as_ref()
            .and_then(|map| map.get(key))
            .map(|node| dat_string_value(node))
            .filter(|value| !value.is_empty())
    };

    format!(
        "{}:{}",
        field("api_ip").unwrap_or_else(|| DEFAULT_IP.into()),
        field("api_port").unwrap_or_else(|| DEFAULT_PORT.into())
    )
}

// Minimal GET client on std::net: the panel API is plain HTTP
// with Content-Length and a closed connection (HTTP/1.0 + Connection: close).
fn api_get(address: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let addr = address.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: {address}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let response = String::from_utf8_lossy(&response);
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    (status.contains(" 200 ")).then(|| body.to_string())
}

pub(crate) fn api_json(root: &Path, path: &str) -> Option<serde_json::Value> {
    parse_osp_json(&api_get(&api_address(root), path)?)
}

fn service_from_dat(name: &str, node: &serde_json::Value) -> Option<Service> {
    let fields = dat_node_map(node)?;
    let text = |key: &str| fields.get(key).map(|field| dat_string_value(field)).unwrap_or_default();
    let enabled = fields
        .get("enabled")
        .and_then(|field| field.get("_value"))
        .and_then(serde_json::Value::as_bool);
    // handle — the module's process descriptor inside the panel; -1 means not running.
    let handle = fields
        .get("handle")
        .and_then(|field| field.get("_value"))
        .and_then(serde_json::Value::as_i64);
    let category = text("category");
    let kind = classify_module(name, Some(category.as_str()).filter(|value| !value.is_empty()));

    // Port of the active profile; some modules (Bind) have none — a known default.
    let profile = text("profile");
    let port = active_profile_settings(node, &profile)
        .and_then(|settings| dat_field(settings, "port"))
        .map(dat_string_value)
        .filter(|value| !value.is_empty() && value != "0")
        .map(|value| format!(":{}", value))
        .unwrap_or_else(|| module_port(name));

    let status = match (enabled, handle) {
        (Some(true), Some(handle)) if handle != -1 => "running",
        (Some(true), Some(-1)) => {
            // Enabled but no process — the module failed to start.
            "warning"
        }
        (Some(false), Some(_)) => "stopped",
        _ => "unknown",
    };

    Some(Service {
        name: name.to_string(),
        version: text("version"),
        port,
        status: status.into(),
        detail: format!("svc.detail.{}", kind),
        kind: kind.into(),
    })
}

pub(crate) fn services_from_json(json: &serde_json::Value) -> Vec<Service> {
    let Some(modules) = dat_node_map(json) else {
        return Vec::new();
    };
    let mut list: Vec<Service> =
        modules.iter().filter_map(|(name, node)| service_from_dat(name, node)).collect();
    list.sort_by_key(|a| a.name.to_lowercase());
    list
}

pub(crate) fn projects_from_json(json: &serde_json::Value, root: &Path) -> Vec<Project> {
    let Some(projects) = dat_node_map(json) else {
        return Vec::new();
    };

    let mut list: Vec<Project> = projects
        .iter()
        .filter_map(|(domain, node)| {
            let fields = dat_node_map(node)?;
            let text = |key: &str| fields.get(key).map(|field| dat_string_value(field)).unwrap_or_default();
            let base_dir = text("base_dir");
            let path = if base_dir.is_empty() {
                root.join("home").join(domain).to_string_lossy().into_owned()
            } else {
                base_dir
            };

            // php_engine = "PHP-8.2" → shown as "8.2", like in the panel's table.
            let php_engine = text("php_engine");
            let php = php_engine.strip_prefix("PHP-").unwrap_or(&php_engine);
            let http_engine = text("http_engine");
            Some(Project {
                domain: domain.to_string(),
                path,
                php: if php.is_empty() { "-".into() } else { php.into() },
                r#type: if http_engine.is_empty() { "-".into() } else { http_engine },
                ssl: fields
                    .get("tls_enabled")
                    .and_then(|field| field.get("_value"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();

    list.sort_by_key(|a| a.domain.to_lowercase());
    list
}

pub(crate) fn modules_from_api(root: &Path) -> Vec<Service> {
    api_json(root, "/getmodules").map(|json| services_from_json(&json)).unwrap_or_default()
}

pub(crate) fn projects_from_api(root: &Path) -> Vec<Project> {
    api_json(root, "/getprojects").map(|json| projects_from_json(&json, root)).unwrap_or_default()
}

// The panel version lives in the generated osp.bat: @set "OSP_VERSION=6.5.1".
pub(crate) fn read_osp_version(root: &Path) -> Option<String> {
    let bat = fs::read_to_string(root.join("bin").join("osp.bat")).ok()?;
    let line = bat.lines().find(|line| line.contains("OSP_VERSION="))?;
    let value = line.split("OSP_VERSION=").nth(1)?.trim().trim_matches('"').trim();
    (!value.is_empty()).then(|| value.to_string())
}

// program.dat infrastructure: nodes are described as {"key": ..., "value": ...} pairs
// inside a "_children" array; we turn such an array into a key → value map.
pub(crate) fn dat_node_map(
    node: &serde_json::Value,
) -> Option<std::collections::HashMap<&str, &serde_json::Value>> {
    node.get("_children")?.as_array().map(|children| {
        children.iter().filter_map(|item| Some((item.get("key")?.as_str()?, item.get("value")?))).collect()
    })
}

// String value of a program.dat node ({"_type":"UString","_value":...} or Bool/Integer).
pub(crate) fn dat_string_value(node: &serde_json::Value) -> String {
    match node.get("_value") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Bool(flag)) => {
            if *flag {
                "on".into()
            } else {
                "off".into()
            }
        }
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

// A child node of the dat structure by key ({"_children":[{key, value},...]}).
pub(crate) fn dat_field<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    dat_node_map(node)?.get(key).copied()
}

// Settings of the module's active profile (profiles.<profile>); with no name — default.
pub(crate) fn active_profile_settings<'a>(
    node: &'a serde_json::Value,
    profile: &str,
) -> Option<&'a serde_json::Value> {
    let profiles = dat_field(node, "profiles")?;
    let active = if profile.is_empty() { None } else { dat_field(profiles, profile) };
    active.or_else(|| dat_field(profiles, "default"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Global engines are read from the "projects" section of the program.dat summary.
    #[test]
    fn reads_global_engines_from_program_dat() {
        // A minimal fragment of the panel's real program.dat: UTF-8 BOM + the {"key","value"} structure.
        let dat = format!(
            "\u{feff}{}",
            r#"{"_type":"Empty","_strict":true,"_children":[
            {"key":"general","value":{"_type":"Empty","_children":[{"key":"lang","value":{"_type":"UString","_value":"System","_strict":true}}]}},
            {"key":"projects","value":{"_type":"Empty","_strict":true,"_children":[
                {"key":"project_enabled","value":{"_type":"Boolean","_value":true,"_strict":true}},
                {"key":"http_engine","value":{"_type":"UString","_value":"Apache","_strict":true}},
                {"key":"http_port","value":{"_type":"UString","_value":"80","_strict":true}},
                {"key":"node_engine","value":{"_type":"UString","_value":"","_strict":true}},
                {"key":"php_engine","value":{"_type":"UString","_value":"PHP-8.2","_strict":true}}
            ]}}
        ]}"#
        );
        let text = dat.strip_prefix('\u{feff}').unwrap_or(&dat);
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let projects =
            dat_field(&json, "projects").and_then(dat_node_map).expect("projects section must be found");
        let engine = |key: &str| projects.get(key).map(|node| dat_string_value(node)).unwrap_or_default();
        assert_eq!(engine("http_engine"), "Apache");
        assert_eq!(engine("php_engine"), "PHP-8.2");
        // An empty string in program.dat — not set globally.
        assert_eq!(engine("node_engine"), "");
        assert_eq!(engine("tls_enabled"), "");
    }

    // Services are built from the /getmodules JSON: category and port of the active
    // profile, state from enabled + handle (process descriptor; -1 — not running).
    #[test]
    fn services_built_from_modules_api_json() {
        let module = |name: &str, category: &str, version: &str, enabled: bool, handle: i64, port: &str| {
            serde_json::json!({
                "key": name, "value": {"_type": "Empty", "_children": [
                    {"key": "enabled", "value": {"_type": "Boolean", "_value": enabled}},
                    {"key": "handle", "value": {"_type": "UInt64", "_value": handle}},
                    {"key": "version", "value": {"_type": "UString", "_value": version}},
                    {"key": "category", "value": {"_type": "UString", "_value": category}},
                    {"key": "profile", "value": {"_type": "UString", "_value": "default"}},
                    {"key": "profiles", "value": {"_type": "Empty", "_children": [
                        {"key": "default", "value": {"_type": "Empty", "_children": [
                            {"key": "port", "value": {"_type": "UString", "_value": port}}
                        ]}}
                    ]}}
                ]}
            })
        };
        let json = serde_json::json!({"_type": "Empty", "_children": [
            module("MySQL-8.0", "MySQL", "8.0.44", true, 1804, "3306"),
            module("Bind", "DNS", "9.17.15", false, -1, "0"),
            module("Blackfire", "Blackfire", "2.30.1", false, -1, "8307"),
            // Enabled but no process — the module failed to start.
            module("PHP-8.3", "PHP", "8.3.29", true, -1, "9000"),
            // The panel returned a malformed enabled value, so the state cannot be trusted.
            {"key": "Incomplete", "value": {"_type": "Empty", "_children": [
                {"key": "enabled", "value": {"_type": "UString", "_value": "on"}},
                {"key": "handle", "value": {"_type": "UInt64", "_value": -1}},
                {"key": "version", "value": {"_type": "UString", "_value": "1.0"}},
                {"key": "category", "value": {"_type": "UString", "_value": "Module"}},
                {"key": "profile", "value": {"_type": "UString", "_value": "default"}}
            ]}}
        ]});

        let services = services_from_json(&json);
        let find = |name: &str| services.iter().find(|service| service.name == name).unwrap();
        assert_eq!(find("MySQL-8.0").status, "running");
        assert_eq!(find("MySQL-8.0").kind, "database");
        assert_eq!(find("MySQL-8.0").port, ":3306");
        assert_eq!(find("MySQL-8.0").version, "8.0.44");

        assert_eq!(find("Bind").kind, "dns");
        assert_eq!(find("Bind").status, "stopped");
        // Port "0" in the profile — the known default is used.
        assert_eq!(find("Bind").port, ":53");

        assert_eq!(find("Blackfire").kind, "profiler");
        assert_eq!(find("Blackfire").port, ":8307");

        assert_eq!(find("PHP-8.3").status, "warning");
        assert_eq!(find("PHP-8.3").detail, "svc.detail.runtime");
        assert_eq!(find("PHP-8.3").port, ":9000");

        assert_eq!(find("Incomplete").status, "unknown");
    }

    // The port comes from the active profile; without one — the default by module name.
    #[test]
    fn module_port_falls_back_to_known_defaults() {
        assert_eq!(module_port("Bind"), ":53");
        assert_eq!(module_port("MySQL-8.0"), ":3306");
        assert_eq!(module_port("UnknownTool"), "—");
    }

    // Projects from /getprojects: domain, real directory, engines, TLS.
    #[test]
    fn projects_built_from_projects_api_json() {
        let json = serde_json::json!({"_type": "Empty", "_children": [
            {"key": "mezzio.local", "value": {"_type": "Empty", "_children": [
                {"key": "base_dir", "value": {"_type": "UString", "_value": "D:\\OSPanel6\\home\\mezzio.local"}},
                {"key": "http_engine", "value": {"_type": "UString", "_value": "Apache"}},
                {"key": "php_engine", "value": {"_type": "UString", "_value": "PHP-8.2"}},
                {"key": "tls_enabled", "value": {"_type": "Boolean", "_value": true}}
            ]}},
            {"key": "old.local", "value": {"_type": "Empty", "_children": [
                {"key": "base_dir", "value": {"_type": "UString", "_value": ""}},
                {"key": "http_engine", "value": {"_type": "UString", "_value": ""}},
                {"key": "php_engine", "value": {"_type": "UString", "_value": ""}},
                {"key": "tls_enabled", "value": {"_type": "Boolean", "_value": false}}
            ]}}
        ]});
        let root = Path::new("D:\\OSPanel6");
        let projects = projects_from_json(&json, root);
        assert_eq!(projects.len(), 2);

        let mezzio = projects.iter().find(|p| p.domain == "mezzio.local").unwrap();
        assert_eq!(mezzio.path, "D:\\OSPanel6\\home\\mezzio.local");
        assert_eq!(mezzio.r#type, "Apache");
        assert_eq!(mezzio.php, "8.2");
        assert!(mezzio.ssl);

        let old = projects.iter().find(|p| p.domain == "old.local").unwrap();
        // Without base_dir the path is built from home/<domain>.
        assert!(old.path.ends_with("home\\old.local"));
        assert_eq!(old.r#type, "-");
        assert_eq!(old.php, "-");
        assert!(!old.ssl);
    }

    // The panel's JSON contains a BOM and raw control bytes (NUL env blocks) — we parse it.
    #[test]
    fn osp_json_tolerates_control_bytes_and_bom() {
        let json = parse_osp_json("\u{feff}{\"a\":\"x\u{0}y\",\"b\": 2}").unwrap();
        assert_eq!(json["a"], "xy");
        assert_eq!(json["b"], 2);
    }

    // The panel version — from the generated osp.bat (the machine-readable OSP_VERSION line).
    #[test]
    fn osp_version_read_from_bat() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-ver-{}", std::process::id()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("osp.bat"), "@set \"OSP_DIR=X\"\r\n@set \"OSP_VERSION=6.5.1\"\r\n").unwrap();
        assert_eq!(read_osp_version(&root).as_deref(), Some("6.5.1"));

        // An empty value (the variable cleanup section) — no version.
        fs::write(bin.join("osp.bat"), "@set \"OSP_VERSION=\"\r\n").unwrap();
        assert_eq!(read_osp_version(&root), None);
        fs::remove_dir_all(&root).unwrap();
    }
}
