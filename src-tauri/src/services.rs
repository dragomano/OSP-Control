//! Services (modules): the discovery snapshot, overview metrics, start/stop and panel restart.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{spawn_failed, CommandError};
use crate::panel_api::{
    active_profile_settings, api_json, classify_module, dat_field, dat_node_map, dat_string_value,
    module_port, modules_from_api, projects_from_api, read_osp_version, services_from_json, Project, Service,
};
use crate::paths::{hidden_command, is_valid_module_name, now_iso, resolve_installation};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    detected: bool,
    // The panel is running: its HTTP API answered /getmodules. detected only means
    // the installation was found on disk; the panel itself may be stopped.
    panel_running: bool,
    version: Option<String>,
    path: Option<String>,
    checked_at: String,
    source: String,
    services: Vec<Service>,
    projects: Vec<Project>,
}

// --- Overview page metrics ---
// Computed from live data: modules and ports from /getmodules, projects from /getprojects,
// memory from the real module processes (exes under <root>\modules\).

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewMetrics {
    services_running: u32,
    services_total: u32,
    projects_total: u32,
    ram_bytes: u64,
    ports_open: u32,
    ports_total: u32,
    port_problems: u32,
}

#[tauri::command]
pub fn overview_metrics(custom_path: Option<String>) -> Result<OverviewMetrics, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;

    // While the panel API is silent (panel off) the aggregates stay at their defaults — zeros.
    let agg = api_json(&root, "/getmodules")
        .map(|json| aggregate_module_metrics(&json, endpoint_is_reachable))
        .unwrap_or_default();

    Ok(OverviewMetrics {
        services_running: agg.running,
        services_total: agg.total,
        projects_total: projects_from_api(&root).len() as u32,
        ram_bytes: module_processes_ram(&root),
        ports_open: agg.ports_open,
        ports_total: agg.ports_total,
        port_problems: agg.problems,
    })
}

#[derive(Default)]
struct ModuleAggregates {
    running: u32,
    total: u32,
    ports_open: u32,
    ports_total: u32,
    problems: u32,
}

// Aggregate counters over the /getmodules JSON. Endpoint reachability is injected
// as a check, so aggregation can be tested separately from the network.
// Each module listens on its own IP: endpoints (ip:port) are counted per module.
fn aggregate_module_metrics(
    json: &serde_json::Value,
    endpoint_reachable: impl Fn(&str, u16) -> bool,
) -> ModuleAggregates {
    let mut agg = ModuleAggregates::default();
    let Some(modules) = dat_node_map(json) else {
        return agg;
    };

    for (_name, node) in modules {
        agg.total += 1;
        let Some(fields) = dat_node_map(node) else { continue };
        let enabled = fields
            .get("enabled")
            .and_then(|field| field.get("_value"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !enabled {
            continue;
        }
        agg.running += 1;

        let profile = fields.get("profile").map(|field| dat_string_value(field)).unwrap_or_default();
        let settings = active_profile_settings(node, &profile);
        let port = settings
            .and_then(|settings| dat_field(settings, "port"))
            .map(dat_string_value)
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0);
        let Some(port) = port else { continue };

        agg.ports_total += 1;
        // ip may be empty or "auto" — in both cases it is the local loopback.
        let ip = settings
            .and_then(|settings| dat_field(settings, "ip"))
            .map(dat_string_value)
            .filter(|value| !value.is_empty() && value != "auto")
            .unwrap_or_else(|| "127.0.0.1".into());
        if endpoint_reachable(&ip, port) {
            agg.ports_open += 1;
        }
    }

    agg.problems = agg.ports_total - agg.ports_open;
    agg
}

// Whether the ip:port TCP address is being listened on. OSPanel modules each live
// on their own IP in 127.0.0.0/8, so we check the address from the module's profile.
fn endpoint_is_reachable(ip: &str, port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    use std::time::Duration;

    // An unparseable address counts as the local loopback.
    let addr = ip.parse::<IpAddr>().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));

    TcpStream::connect_timeout(&SocketAddr::new(addr, port), Duration::from_millis(700)).is_ok()
}

// Total memory (working set) of module processes: those whose exe lives
// under <root>\modules\. Unreachable processes are skipped.
#[cfg(windows)]
fn module_processes_ram(root: &Path) -> u64 {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        EnumProcesses, GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // canonicalize adds the \\?\ prefix — process paths do not have it.
    let modules_dir = fs::canonicalize(root.join("modules")).ok();
    let Some(prefix) = modules_dir
        .as_ref()
        .and_then(|path| path.to_str())
        .map(|path| path.trim_start_matches(r"\\?\").to_ascii_lowercase())
        .filter(|prefix| !prefix.is_empty())
    else {
        return 0;
    };

    let mut pids = [0u32; 4096];
    let mut returned = 0u32;
    unsafe {
        if EnumProcesses(pids.as_mut_ptr(), std::mem::size_of_val(&pids) as u32, &mut returned).is_err() {
            return 0;
        }
    }
    let count = (returned as usize).min(pids.len()) / std::mem::size_of::<u32>();

    let mut total = 0u64;
    for &pid in &pids[..count] {
        if pid == 0 {
            continue;
        }
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                continue;
            };
            let mut ram = 0u64;
            let mut path_buf = [0u16; 1024];
            let mut len = path_buf.len() as u32;
            if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(path_buf.as_mut_ptr()), &mut len)
                .is_ok()
            {
                let path = String::from_utf16_lossy(&path_buf[..len as usize]).to_ascii_lowercase();
                if path.starts_with(&prefix) {
                    let mut counters = PROCESS_MEMORY_COUNTERS::default();
                    if GetProcessMemoryInfo(handle, &mut counters, std::mem::size_of_val(&counters) as u32)
                        .is_ok()
                    {
                        ram = counters.WorkingSetSize as u64;
                    }
                }
            }
            let _ = CloseHandle(handle);
            total += ram;
        }
    }
    total
}

#[cfg(not(windows))]
fn module_processes_ram(_root: &Path) -> u64 {
    0
}

#[tauri::command]
pub fn discover_ospanel(custom_path: Option<String>) -> Snapshot {
    // The same resolution the other commands use — here a missing installation is not
    // an error but the "not detected" state.
    let root = resolve_installation(custom_path.as_deref()).ok();

    let detected = root.is_some();
    let root_path = root.as_ref();

    let mut services = Vec::new();
    let mut projects = Vec::new();
    let mut version = detected.then(|| "6.x".to_string());
    let mut panel_running = false;

    if let Some(path) = root_path {
        // A single /getmodules request yields both the module list and the "panel is running" flag.
        if let Some(json) = api_json(path, "/getmodules") {
            services = services_from_json(&json);
            panel_running = true;
        }
        projects = projects_from_api(path);
        if let Some(v) = read_osp_version(path) {
            version = Some(v);
        }
    }

    if services.is_empty() {
        services = vec![
            Service {
                name: "Apache".into(),
                version: "2.4".into(),
                port: ":80".into(),
                status: "stopped".into(),
                detail: "svc.detail.web".into(),
                kind: "web".into(),
            },
            Service {
                name: "PHP".into(),
                version: "8.3".into(),
                port: ":9000".into(),
                status: "stopped".into(),
                detail: "svc.detail.runtime".into(),
                kind: "runtime".into(),
            },
            Service {
                name: "MySQL".into(),
                version: "8.0".into(),
                port: ":3306".into(),
                status: "stopped".into(),
                detail: "svc.detail.database".into(),
                kind: "database".into(),
            },
        ];
    }

    Snapshot {
        detected,
        panel_running,
        version,
        path: root_path.map(|p| p.to_string_lossy().into_owned()),
        checked_at: now_iso(),
        source: "tauri".into(),
        services,
        projects,
    }
}

// Live panel status for the sidebar card: a lightweight poll without a full snapshot.
// The installation exists but the API is silent — the panel is stopped.
#[tauri::command]
pub fn panel_online(custom_path: Option<String>) -> bool {
    resolve_installation(custom_path.as_deref())
        .map(|root| api_json(&root, "/getmodules").is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub fn service_action(
    name: String,
    action: String,
    custom_path: Option<String>,
) -> Result<Service, CommandError> {
    // One match serves both as validation and as the osp.bat argument.
    let cmd = match action.as_str() {
        "start" => "on",
        "stop" => "off",
        "restart" => "restart",
        _ => return Err(CommandError::new("err.operationNotAllowed")),
    };

    if !is_valid_module_name(&name) {
        return Err(CommandError::new("err.invalidModuleName"));
    }

    let root = resolve_installation(custom_path.as_deref())?;
    let osp_bat = root.join("bin").join("osp.bat");

    if osp_bat.exists() {
        let status = hidden_command(&osp_bat).args([cmd, &name]).status().map_err(spawn_failed)?;

        if !status.success() {
            return Err(CommandError::new("err.ospCommandFailed")
                .with("cmd", cmd)
                .with("name", name.clone()));
        }

        // Reread the state via the API to return up-to-date module data.
        let services = modules_from_api(&root);
        if let Some(service) = services.into_iter().find(|s| s.name == name) {
            return Ok(service);
        }
    }

    let new_status = if action == "stop" { "stopped" } else { "running" };
    let kind = classify_module(&name, None);
    let port = module_port(&name);

    Ok(Service {
        name,
        version: "—".into(),
        port,
        status: new_status.into(),
        detail: format!("svc.detail.{}", kind),
        kind: kind.into(),
    })
}

// --- Restarting the OSPanel panel ---
// osp.bat exit stops the panel together with the modules, then we launch
// ospanel.exe again. This is the same fast path as the panel's own restart
// button and avoids one shell/API round-trip per module.
#[tauri::command]
pub fn restart_ospanel(custom_path: Option<String>) -> Result<(), CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let osp_bat = root.join("bin").join("osp.bat");
    let panel_exe = root.join("bin").join("ospanel.exe");
    if !osp_bat.exists() || !panel_exe.exists() {
        return Err(CommandError::new("err.ospanelNotFound"));
    }

    let status = hidden_command(&osp_bat).args(["exit"]).status().map_err(spawn_failed)?;
    if !status.success() {
        return Err(CommandError::new("err.ospCommandFailed").with("cmd", "exit").with("name", ""));
    }

    hidden_command(&panel_exe).spawn().map_err(spawn_failed)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Overview metrics: enabled modules and their addresses; reachability is stubbed.
    #[test]
    fn overview_metrics_aggregate_from_modules_json() {
        let module = |name: &str, enabled: bool, ip: &str, port: &str| {
            serde_json::json!({
                "key": name, "value": {"_type": "Empty", "_children": [
                    {"key": "enabled", "value": {"_type": "Boolean", "_value": enabled}},
                    {"key": "profile", "value": {"_type": "UString", "_value": "default"}},
                    {"key": "profiles", "value": {"_type": "Empty", "_children": [
                        {"key": "default", "value": {"_type": "Empty", "_children": [
                            {"key": "ip", "value": {"_type": "UString", "_value": ip}},
                            {"key": "port", "value": {"_type": "UString", "_value": port}}
                        ]}}
                    ]}}
                ]}
            })
        };
        let json = serde_json::json!({"_type": "Empty", "_children": [
            module("Apache", true, "127.0.1.11", "80"),
            module("Nginx", true, "127.0.1.12", "80"),
            module("MySQL-8.0", true, "127.0.1.30", "3306"),
            module("Bind", true, "", "0"),
            module("Redis", false, "127.0.1.55", "6379"),
        ]});

        // Each module has its own IP, so the shared port 80 is two endpoints;
        // Bind's "0" is not checked; Redis is disabled — not counted.
        let agg = aggregate_module_metrics(&json, |ip, port| ip == "127.0.1.11" && port == 80);
        assert_eq!(agg.total, 5);
        assert_eq!(agg.running, 4);
        assert_eq!(agg.ports_total, 3);
        assert_eq!(agg.ports_open, 1);
        assert_eq!(agg.problems, 2);
    }
}
