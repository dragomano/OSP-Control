//! Projects: project.ini settings, create/delete, engines, and autostart from project settings.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, spawn_failed};
use crate::panel_api::{
    Service, dat_field, dat_node_map, dat_string_value, modules_from_api, parse_osp_json, projects_from_api,
};
use crate::paths::{
    external_path, hidden_command, is_valid_domain, normalize_project_domain, resolve_installation,
};

// --- Per-project module versions (home/<domain>/.osp/project.ini) ---
// The file is edited by the user: only the values of the needed keys are changed,
// preserving the BOM, line endings, alignment and comments.

const ENGINE_AUTO: &str = "auto";
// Allowed values for the per-project tls_enabled key in project.ini.
// "auto" follows the global panel setting; "on"/"off" force TLS for the domain.
const TLS_VALUES: [&str; 3] = ["auto", "on", "off"];
// Key column width in the panel's own project.ini (the section is aligned to the 17th character).
const PROJECT_INI_KEY_WIDTH: usize = 17;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectModuleOptions {
    http_engines: Vec<String>,
    php_engines: Vec<String>,
    node_engines: Vec<String>,
    nvm_available: bool,
    database_engines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectModuleOverride {
    http_engine: String,
    php_engine: String,
    node_engine: String,
    // "on" | "off" | "auto" — per-project TLS toggle (tls_enabled in project.ini).
    tls_enabled: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSettings {
    domain: String,
    http_engine: String,
    php_engine: String,
    node_engine: String,
    tls_enabled: String,
    // false — the file does not exist yet, all values are considered auto.
    file_exists: bool,
}

impl ProjectSettings {
    fn defaults(domain: &str) -> Self {
        Self {
            domain: domain.to_string(),
            http_engine: ENGINE_AUTO.into(),
            php_engine: ENGINE_AUTO.into(),
            node_engine: ENGINE_AUTO.into(),
            tls_enabled: ENGINE_AUTO.into(),
            file_exists: false,
        }
    }
}

// Path to the project's project.ini, verifying the domain directory lies inside home/.
fn project_ini_path(root: &Path, domain: &str) -> Result<PathBuf, CommandError> {
    if !is_valid_domain(domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    let home = root.join("home");
    let canonical_home = fs::canonicalize(&home).map_err(|_| CommandError::new("err.ospanelNotFound"))?;
    let project_dir = fs::canonicalize(home.join(domain))
        .map_err(|_| CommandError::new("err.projectNotFound").with("domain", domain))?;
    if !project_dir.starts_with(&canonical_home) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(project_dir.join(".osp").join("project.ini"))
}

fn scan_modules(root: &Path, prefix: &str) -> Vec<String> {
    let mut list = Vec::new();

    if let Ok(entries) = fs::read_dir(root.join("modules")) {
        for entry in entries.flatten() {
            // modules/ also holds archives like PHP-8.4.rar — only module directories count.
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix) {
                list.push(name);
            }
        }
    }

    list.sort();
    list
}

fn node_options(root: &Path) -> (bool, Vec<String>) {
    let scan = || -> Result<(bool, Vec<String>), CommandError> {
        let root = fs::canonicalize(root)?;
        let addons = crate::project_workspace::child(&root, "addons")?;
        let nvm = crate::project_workspace::child(&addons, "NVM")?;
        let available = crate::project_workspace::child(&nvm, "nvm.exe")?.is_file();
        let mut versions = Vec::new();
        if !available {
            return Ok((false, versions));
        }
        for entry in fs::read_dir(&nvm)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(version) = name.strip_prefix('v') else { continue };
            let parts: Vec<_> = version.split('.').collect();
            if parts.len() != 3
                || parts.iter().any(|part| {
                    part.is_empty()
                        || !part.bytes().all(|b| b.is_ascii_digit())
                        || part.parse::<u32>().is_err()
                })
            {
                continue;
            }
            let Ok(dir) = crate::project_workspace::child(&nvm, &name) else { continue };
            if dir.is_dir()
                && crate::project_workspace::child(&dir, "node.exe").is_ok_and(|path| path.is_file())
            {
                versions.push(format!("Node-{version}"));
            }
        }
        versions.sort_by_key(|version| {
            version[5..].split('.').filter_map(|part| part.parse::<u32>().ok()).collect::<Vec<_>>()
        });
        Ok((available, versions))
    };
    scan().unwrap_or_default()
}

fn scan_module_options(root: &Path) -> ProjectModuleOptions {
    let modules = root.join("modules");
    let http_engines = ["Apache", "Nginx", "Caddy"]
        .into_iter()
        .filter(|name| modules.join(name).is_dir())
        .map(str::to_string)
        .collect();
    let (nvm_available, node_engines) = node_options(root);
    ProjectModuleOptions {
        http_engines,
        php_engines: scan_modules(root, "PHP-"),
        node_engines,
        nvm_available,
        database_engines: crate::project_database::engines(root),
    }
}

fn validate_engine_value(options: &ProjectModuleOptions, key: &str, value: &str) -> Result<(), CommandError> {
    if value == ENGINE_AUTO {
        return Ok(());
    }

    let allowed: &[String] = match key {
        "http_engine" => &options.http_engines,
        "php_engine" => &options.php_engines,
        "node_engine" => &options.node_engines,
        _ => &[],
    };

    if allowed.iter().any(|item| item == value) {
        Ok(())
    } else {
        Err(CommandError::new("err.invalidSettingValue").with("value", value))
    }
}

fn is_section_header(trimmed: &str) -> Option<&str> {
    if trimmed.len() >= 2 && trimmed.starts_with('[') && trimmed.ends_with(']') {
        Some(&trimmed[1..trimmed.len() - 1])
    } else {
        None
    }
}

fn ini_sections(content: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut sections: Vec<(String, BTreeMap<String, String>)> = Vec::new();
    // A BOM at the start of the file is normal for the panel's project.ini; otherwise the section header is not recognized.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(name) = is_section_header(trimmed) {
            sections.push((name.to_string(), BTreeMap::new()));
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }
        if let Some((_, values)) = sections.last_mut() {
            if let Some((key, value)) = trimmed.split_once('=') {
                values.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
    }

    sections
}

// The project section's values; if there is no section named after the domain, take the
// only one (a project may store settings under a different spelling of its name).
fn find_project_section(content: &str, domain: &str) -> Option<BTreeMap<String, String>> {
    let sections = ini_sections(content);
    sections
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(domain))
        .or_else(|| sections.first().filter(|_| sections.len() == 1))
        .map(|(_, values)| values.clone())
}

// Editing a single INI section key: only the value after "=" is replaced, preserving
// the line's indentation. A missing key is appended to the end of the section; a missing
// section is created at the end of the file. insert_if_missing=false avoids littering
// the file with explicit "= auto" entries.
fn ini_set_value(
    content: &str,
    section: &str,
    key: &str,
    value: &str,
    insert_if_missing: bool,
) -> (String, bool) {
    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let had_bom = content.starts_with('\u{feff}');
    let body = if had_bom { &content['\u{feff}'.len_utf8()..] } else { content };
    let ends_with_newline = body.ends_with('\n');

    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    let mut current_section: Option<String> = None;
    let mut key_line: Option<usize> = None;
    let mut section_last: Option<usize> = None;
    let mut section_found = false;

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if let Some(name) = is_section_header(trimmed) {
            section_found = section_found || name.eq_ignore_ascii_case(section);
            current_section = Some(name.to_string());
        } else if current_section.as_deref().map(|name| name.eq_ignore_ascii_case(section)).unwrap_or(false) {
            if let Some(eq) = trimmed.find('=') {
                if trimmed[..eq].trim().eq_ignore_ascii_case(key) {
                    key_line = Some(index);
                }
            }
            if !trimmed.is_empty() {
                section_last = Some(index);
            }
        }
    }

    if let Some(index) = key_line {
        let old_value = lines[index].split_once('=').map(|(_, value)| value.trim()).unwrap_or("");
        if old_value == value {
            return (content.to_string(), false);
        }
        // The "key = value" alignment of the original line is preserved.
        let source = lines[index].clone();
        let updated = match source.find('=') {
            Some(eq) => {
                let after = &source[eq + 1..];
                let padding = after.len() - after.trim_start().len();
                format!("{}{}{}", &source[..=eq], &after[..padding], value)
            }
            None => format!("{:<width$} = {}", key, value, width = PROJECT_INI_KEY_WIDTH),
        };
        lines[index] = updated;
    } else if section_found && insert_if_missing {
        let new_line = format!("{:<width$} = {}", key, value, width = PROJECT_INI_KEY_WIDTH);
        match section_last {
            Some(index) => lines.insert(index + 1, new_line),
            None => lines.push(new_line),
        }
    } else if !section_found && insert_if_missing {
        lines.push(String::new());
        lines.push(format!("[{}]", section));
        lines.push(format!("{:<width$} = {}", key, value, width = PROJECT_INI_KEY_WIDTH));
    } else {
        return (content.to_string(), false);
    }

    let mut result = String::with_capacity(content.len() + 32);
    if had_bom {
        result.push('\u{feff}');
    }
    result.push_str(&lines.join(newline));
    if ends_with_newline {
        result.push_str(newline);
    }
    (result, true)
}

#[tauri::command]
pub fn project_module_options(custom_path: Option<String>) -> Result<ProjectModuleOptions, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    Ok(scan_module_options(&root))
}

#[tauri::command]
pub fn read_project_settings(
    domain: String,
    custom_path: Option<String>,
) -> Result<ProjectSettings, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let ini = project_ini_path(&root, &domain)?;
    if !ini.exists() {
        return Ok(ProjectSettings::defaults(&domain));
    }

    let content = fs::read_to_string(&ini)?;
    let values = find_project_section(&content, &domain);

    // Every project option falls back to the panel's default "auto" value.
    let engine =
        |key: &str| values.as_ref().and_then(|v| v.get(key)).cloned().unwrap_or_else(|| ENGINE_AUTO.into());

    Ok(ProjectSettings {
        domain,
        http_engine: engine("http_engine"),
        php_engine: engine("php_engine"),
        node_engine: engine("node_engine"),
        tls_enabled: engine("tls_enabled"),
        file_exists: true,
    })
}

#[tauri::command]
pub fn write_project_settings(
    domain: String,
    settings: ProjectModuleOverride,
    custom_path: Option<String>,
) -> Result<ProjectSettings, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let options = scan_module_options(&root);
    validate_engine_value(&options, "http_engine", &settings.http_engine)?;
    validate_engine_value(&options, "php_engine", &settings.php_engine)?;
    validate_engine_value(&options, "node_engine", &settings.node_engine)?;
    if !TLS_VALUES.contains(&settings.tls_enabled.as_str()) {
        return Err(CommandError::new("err.invalidSettingValue").with("value", &settings.tls_enabled));
    }

    let ini = project_ini_path(&root, &domain)?;
    let mut content = if ini.exists() {
        fs::read_to_string(&ini)?
    } else {
        // A new file — in the panel's own format: BOM, a section named after the domain, CRLF.
        format!("\u{feff}[{}]\r\n\r\n", domain)
    };

    let mut changed = !ini.exists();
    for (key, value) in [
        ("http_engine", settings.http_engine.as_str()),
        ("php_engine", settings.php_engine.as_str()),
        ("node_engine", settings.node_engine.as_str()),
        ("tls_enabled", settings.tls_enabled.as_str()),
    ] {
        // Missing keys with the auto value are not added: that is the default anyway.
        let insert = value != ENGINE_AUTO || !ini.exists();
        let (next, key_changed) = ini_set_value(&content, &domain, key, value, insert);
        changed = changed || key_changed;
        content = next;
    }

    if changed {
        let osp_dir = ini.parent().ok_or_else(|| CommandError::new("err.accessDenied"))?;
        fs::create_dir_all(osp_dir)?;
        // The domain was already validated in project_ini_path; .osp may turn out to be a symlink —
        // write only if the directory lies inside the canonical project directory.
        let project_dir = fs::canonicalize(root.join("home").join(&domain))?;
        let canonical_osp = fs::canonicalize(osp_dir)?;
        if !canonical_osp.starts_with(&project_dir) {
            return Err(CommandError::new("err.accessDenied"));
        }
        fs::write(canonical_osp.join("project.ini"), content)?;
    }

    Ok(ProjectSettings {
        domain,
        http_engine: settings.http_engine,
        php_engine: settings.php_engine,
        node_engine: settings.node_engine,
        tls_enabled: settings.tls_enabled,
        file_exists: true,
    })
}

// --- Project log cleanup and deletion ---

fn remove_project_logs(root: &Path, domain: &str) -> Result<(), CommandError> {
    if !is_valid_domain(domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    let root = fs::canonicalize(root)?;
    let mut directory = root.clone();
    for component in ["logs", "domains"] {
        let expected = directory.join(component);
        directory = match fs::canonicalize(&expected) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        // Do not follow redirected log folders, even to another location inside the installation.
        if !directory.starts_with(&root) || directory != expected {
            return Err(CommandError::new("err.accessDenied"));
        }
    }

    let mut files = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        // OSPanel uses <domain>_<kind>.log (access, error, caddy, 404, etc.).
        // Split at the last underscore so domains containing underscores stay distinct.
        // Include rotated logs such as error.log.1 and caddy-<timestamp>.log.gz.
        let Some((owner, suffix)) = name.rsplit_once('_') else {
            continue;
        };
        if !owner.eq_ignore_ascii_case(domain) || !(suffix.ends_with(".log") || suffix.contains(".log.")) {
            continue;
        }
        let path = fs::canonicalize(entry.path())?;
        if !path.starts_with(&directory) || path != entry.path() {
            return Err(CommandError::new("err.accessDenied"));
        }
        if path.is_file() {
            files.push(path);
        }
    }
    // Validate the entire selection before removing anything, and propagate cleanup failures.
    for path in files {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

// The home/<domain> directory is wiped entirely (together with .osp and project.ini),
// and its logs are removed from logs/domains/.
// A dangerous operation: the frontend must show a confirmation first, and here the
// check is strict that the directory lies inside home/.

#[tauri::command]
pub fn delete_project(domain: String, custom_path: Option<String>) -> Result<(), CommandError> {
    if !is_valid_domain(&domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }

    let root = resolve_installation(custom_path.as_deref())?;
    let home = fs::canonicalize(root.join("home")).map_err(|_| CommandError::new("err.ospanelNotFound"))?;
    let project_dir = fs::canonicalize(home.join(&domain))
        .map_err(|_| CommandError::new("err.projectNotFound").with("domain", domain.clone()))?;

    // starts_with also returns true for equal paths — home itself must not be deleted.
    if project_dir == home || !project_dir.starts_with(&home) {
        return Err(CommandError::new("err.accessDenied"));
    }

    remove_project_logs(&root, &domain)?;
    fs::remove_dir_all(&project_dir)?;
    Ok(())
}

// --- Domain renaming ---
// Keep this operation deliberately limited to one-domain home/<domain> projects:
// moving a shared directory would silently invalidate other domains and API paths.
static PROJECT_RENAME_LOCK: Mutex<()> = Mutex::new(());
static PROJECT_RENAME_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenamedProject {
    domain: String,
    path: String,
}

fn rename_project_section(content: &str, domain: &str, new_domain: &str) -> Result<String, CommandError> {
    let sections = ini_sections(content);
    if sections.len() != 1 || !sections[0].0.eq_ignore_ascii_case(domain) {
        return Err(CommandError::new("err.projectRenameLayout"));
    }
    // Replace only the section name; preserve all values, comments, BOM and line endings.
    let mut updated = String::with_capacity(content.len() + new_domain.len());
    for line in content.split_inclusive('\n') {
        if is_section_header(line.trim_start_matches('\u{feff}').trim())
            .is_some_and(|section| section.eq_ignore_ascii_case(domain))
        {
            let start = line.find('[').unwrap() + 1;
            let end = line.rfind(']').unwrap();
            updated.push_str(&line[..start]);
            updated.push_str(new_domain);
            updated.push_str(&line[end..]);
        } else {
            updated.push_str(line);
        }
    }
    Ok(updated)
}

fn rename_project_directory(
    root: &Path,
    domain: &str,
    new_domain: &str,
    expected_path: &Path,
    registered: &[crate::panel_api::Project],
) -> Result<RenamedProject, CommandError> {
    let normalized = normalize_project_domain(new_domain)?;
    let new_domain = normalized.as_str();
    if !is_valid_domain(domain) || domain.eq_ignore_ascii_case(new_domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    let home = fs::canonicalize(root.join("home"))?;
    let source = fs::canonicalize(home.join(domain))
        .map_err(|_| CommandError::new("err.projectNotFound").with("domain", domain))?;
    // The displayed API path must identify this exact directory; never move a different project
    // merely because its folder happens to match the selected domain.
    if !source.starts_with(&home)
        || source.parent() != Some(home.as_path())
        || !source.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(domain))
        || fs::canonicalize(expected_path)? != source
        || !source.is_dir()
        || registered.iter().any(|project| {
            fs::canonicalize(&project.path).is_ok_and(|path| path == source)
                && !project.domain.eq_ignore_ascii_case(domain)
        })
    {
        return Err(CommandError::new("err.projectRenameLayout"));
    }
    let target = home.join(new_domain);
    if fs::symlink_metadata(&target).is_ok()
        || registered.iter().any(|project| project.domain.eq_ignore_ascii_case(new_domain))
        || root.join("modules").join(new_domain).exists()
    {
        return Err(CommandError::new("err.projectExists").with("domain", new_domain));
    }
    // Include domains defined in other project.ini files before the panel has been restarted.
    for entry in fs::read_dir(&home)? {
        let path = entry?.path().join(".osp/project.ini");
        if let Ok(content) = fs::read_to_string(&path) {
            if ini_sections(&content).iter().any(|(section, _)| section.eq_ignore_ascii_case(new_domain)) {
                return Err(CommandError::new("err.projectExists").with("domain", new_domain));
            }
        }
    }
    let osp = fs::canonicalize(source.join(".osp"))?;
    let ini = fs::canonicalize(osp.join("project.ini"))?;
    if !osp.starts_with(&source)
        || osp != source.join(".osp")
        || !ini.starts_with(&osp)
        || ini != osp.join("project.ini")
    {
        return Err(CommandError::new("err.accessDenied"));
    }
    let original = fs::read_to_string(&ini)?;
    let updated = rename_project_section(&original, domain, new_domain)?;
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        crate::paths::unix_now(),
        PROJECT_RENAME_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let backup = osp.join(format!("project.ini.before-rename-{id}.bak"));
    let temporary = osp.join(format!("project.ini.rename-{id}.tmp"));
    // create_new prevents overwriting existing files or following a planted backup/temp link.
    let write_new = |path: &Path, content: &str| -> Result<(), CommandError> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    };
    let rollback_failed = |path: &Path| {
        CommandError::new("err.projectRenameRollbackFailed")
            .with("path", external_path(path).to_string_lossy().into_owned())
    };
    write_new(&backup, &original)?;
    write_new(&temporary, &updated)?;
    if let Err(error) = fs::rename(&temporary, &ini) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&source, &target) {
        // Restore the exact original file if Windows denies moving a directory with open handles.
        if fs::rename(&backup, &ini).is_err() {
            return Err(rollback_failed(&backup));
        }
        return Err(error.into());
    }
    // Clean up only after the move succeeds, preserving logs when the directory is locked.
    // If cleanup fails, restore the old project name and settings before reporting the error.
    if let Err(error) = remove_project_logs(root, domain) {
        if fs::rename(&target, &source).is_err() {
            return Err(rollback_failed(&target.join(".osp").join(backup.file_name().unwrap())));
        }
        if fs::rename(&backup, &ini).is_err() {
            return Err(rollback_failed(&backup));
        }
        return Err(error);
    }
    Ok(RenamedProject {
        domain: new_domain.into(),
        path: external_path(&target).to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn rename_project(
    domain: String,
    new_domain: String,
    path: String,
    custom_path: Option<String>,
) -> Result<RenamedProject, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PROJECT_RENAME_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = resolve_installation(custom_path.as_deref())?;
        let registered = projects_from_api(&root);
        rename_project_directory(&root, &domain, &new_domain, Path::new(&path), &registered)
    })
    .await
    .map_err(|error| CommandError::new("err.ioFailed").with("detail", error.to_string()))?
}

// --- Global project engine values (the panel's own Settings → Projects) ---
// Stored in system/program.dat (a JSON summary of the panel's settings) in the "projects" section.
// Read-only: editing global settings must be done in OSPanel itself — the panel keeps the
// same file in memory and may overwrite it.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalProjectEngines {
    http_engine: String,
    php_engine: String,
    node_engine: String,
}

#[tauri::command]
pub fn global_project_engines(custom_path: Option<String>) -> Result<GlobalProjectEngines, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let dat = root.join("system").join("program.dat");
    let text = fs::read_to_string(&dat)?;

    // The panel file starts with a UTF-8 BOM and contains raw control bytes —
    // parse_osp_json cleans up both.
    let json = parse_osp_json(&text).ok_or_else(|| CommandError::new("err.programDatCorrupt"))?;
    let projects = dat_field(&json, "projects")
        .and_then(dat_node_map)
        .ok_or_else(|| CommandError::new("err.programDatCorrupt"))?;

    let engine = |key: &str| projects.get(key).map(|node| dat_string_value(node)).unwrap_or_default();
    Ok(GlobalProjectEngines {
        http_engine: engine("http_engine"),
        php_engine: engine("php_engine"),
        node_engine: engine("node_engine"),
    })
}

// --- Autostart of modules per project settings (like the native panel) ---
// We read the home/<domain>/.osp/project.ini of every domain, collect the modules
// pinned there, and start the not-yet-running ones via osp.bat.
// Start only: the command never stops anything.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartReport {
    // Modules pinned in the projects' project.ini.
    required: Vec<String>,
    // Started during this pass.
    started: Vec<String>,
    // Already running, no start was required.
    already_running: Vec<String>,
    // ini values for which no module was found in the panel.
    unmatched: Vec<String>,
}

// "PHP-8.2", "PHP_8.2", "php 8.2" — one name: separators and case are stripped.
fn normalize_module_name(value: &str) -> String {
    value.chars().filter(|c| !matches!(c, '_' | '-' | ' ')).flat_map(|c| c.to_lowercase()).collect()
}

fn collect_project_engines(root: &Path) -> Vec<String> {
    let mut engines: Vec<String> = Vec::new();
    let Ok(home) = fs::canonicalize(root.join("home")) else {
        return engines;
    };
    let Ok(entries) = fs::read_dir(&home) else {
        return engines;
    };

    for entry in entries.flatten() {
        // A domain is a directory in home/ with a valid name (the same check as for the ini).
        let Some(domain) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !entry.path().is_dir() || !is_valid_domain(&domain) {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path().join(".osp").join("project.ini")) else {
            continue;
        };
        let Some(values) = find_project_section(&content, &domain) else {
            continue;
        };
        for key in ["http_engine", "php_engine", "node_engine"] {
            if let Some(value) = values.get(key) {
                if value != ENGINE_AUTO && !engines.iter().any(|e| e == value) {
                    engines.push(value.clone());
                }
            }
        }
    }
    engines
}

// Match a project.ini engine against the available modules supplied by the panel API:
// first the full name, then the prefix ("Apache" → "Apache_2.4"),
// finally the family "PHP-8.2" → "PHP_x".
fn find_module_for_engine<'a>(engine: &str, services: &'a [Service]) -> Option<&'a Service> {
    let target = normalize_module_name(engine);

    services
        .iter()
        .find(|s| normalize_module_name(&s.name) == target)
        .or_else(|| services.iter().find(|s| normalize_module_name(&s.name).starts_with(&target)))
        .or_else(|| {
            let family: String = target.chars().take_while(char::is_ascii_alphabetic).collect();
            if family.is_empty() || family == target {
                return None;
            }
            services.iter().find(|s| normalize_module_name(&s.name).starts_with(&family))
        })
}

#[tauri::command]
pub fn autostart_from_projects(custom_path: Option<String>) -> Result<AutostartReport, CommandError> {
    let _guard = crate::module_updates::mutation()?;
    let root = resolve_installation(custom_path.as_deref())?;
    let osp_bat = root.join("bin").join("osp.bat");
    if !osp_bat.exists() {
        return Err(CommandError::new("err.ospanelNotFound"));
    }

    let required = collect_project_engines(&root);
    if required.is_empty() {
        return Ok(AutostartReport {
            required,
            started: Vec::new(),
            already_running: Vec::new(),
            unmatched: Vec::new(),
        });
    }

    let services = modules_from_api(&root);

    let mut started = Vec::new();
    let mut already_running = Vec::new();
    let mut unmatched = Vec::new();
    for engine in &required {
        let Some(service) = find_module_for_engine(engine, &services) else {
            unmatched.push(engine.clone());
            continue;
        };
        if service.status == "running" {
            already_running.push(service.name.clone());
            continue;
        }
        let status = hidden_command(&osp_bat).args(["on", &service.name]).status().map_err(spawn_failed)?;
        if status.success() {
            started.push(service.name.clone());
        }
    }
    Ok(AutostartReport { required, started, already_running, unmatched })
}

// --- Creating a new project ---
// Publishes a complete bundled scaffold under home/<domain>. The default template
// keeps the original settings-only skeleton (BOM, alignment, CRLF).

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateProjectParams {
    domain: String,
    http_engine: Option<String>,
    php_engine: Option<String>,
    node_engine: Option<String>,
    template: Option<String>,
    backend_port: Option<u16>,
    language: Option<String>,
    database: Option<crate::project_database::Database>,
}

// The path is returned so the frontend can show the created project right away:
// the live panel API /getprojects scans home/ only at panel startup and does not
// see new domains created on disk (verified on 6.5.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedProject {
    domain: String,
    path: String,
    http: String,
    php: String,
    ssl: bool,
}

#[tauri::command]
pub fn create_project(
    params: CreateProjectParams,
    custom_path: Option<String>,
) -> Result<CreatedProject, CommandError> {
    let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
    let domain = normalize_project_domain(&params.domain)?;
    let template = crate::project_templates::template(params.template.as_deref().unwrap_or("empty"))?;
    let options = scan_module_options(&root);
    let globals = global_project_engines(Some(root.to_string_lossy().into_owned())).ok();
    let choose = |input: Option<String>,
                  available: &[String],
                  global: &str,
                  required: bool,
                  key: &str|
     -> Result<String, CommandError> {
        let value = if template.id == "empty" {
            input.unwrap_or_else(|| ENGINE_AUTO.into())
        } else {
            match input.as_deref() {
                Some(value) if value != "auto" => value.into(),
                _ if required => crate::project_templates::preferred(available, global).unwrap_or_default(),
                Some("auto") => ENGINE_AUTO.into(),
                _ => String::new(),
            }
        };
        if required && value.is_empty() {
            let module = match key {
                "php_engine" => "PHP",
                "node_engine" => "Node.js",
                _ => "HTTP",
            };
            return Err(CommandError::new("err.projectTemplateModule").with("module", module));
        }
        if !value.is_empty() {
            validate_engine_value(&options, key, &value)?;
        }
        Ok(value)
    };
    let http = choose(
        params.http_engine,
        &options.http_engines,
        globals.as_ref().map(|g| g.http_engine.as_str()).unwrap_or(""),
        template.id != "empty",
        "http_engine",
    )?;
    let php = choose(
        params.php_engine,
        &options.php_engines,
        globals.as_ref().map(|g| g.php_engine.as_str()).unwrap_or(""),
        template.php,
        "php_engine",
    )?;
    let node = choose(
        params.node_engine,
        &options.node_engines,
        globals.as_ref().map(|g| g.node_engine.as_str()).unwrap_or(""),
        template.node,
        "node_engine",
    )?;
    let port = params.backend_port.unwrap_or(3000);
    if template.node && port == 0 {
        return Err(CommandError::new("err.invalidSettingValue").with("value", "0"));
    }
    let mut files =
        template.files(&domain, &http, &php, &node, port, params.language.as_deref().unwrap_or("en"))?;
    if let Some(db) = &params.database {
        crate::project_database::validate(db, &template.id, &options.database_engines)?;
        files.extend(crate::project_database::files(db)?);
        if !matches!(db.engine.as_str(), "none" | "sqlite") {
            if let Some((_, ini)) = files.iter_mut().find(|(path, _)| path == ".osp/project.ini") {
                ini.push_str(&format!("environment       = {}\r\n", db.engine));
            }
        }
    }
    let home = crate::project_workspace::child(&root, "home")?;
    if !home.exists() {
        fs::create_dir(&home)?;
    }
    let home = crate::project_workspace::child(&root, "home")?;
    let project_dir = template.create(&home, &domain, &files)?;

    // Engines for the project table: in the panel's table an implicitly set engine is "-".
    let engine_display = |value: &str, strip_php: bool| -> String {
        let stripped = if strip_php { value.strip_prefix("PHP-").unwrap_or(value) } else { value };
        if stripped.is_empty() || stripped == ENGINE_AUTO { "-".into() } else { stripped.into() }
    };
    Ok(CreatedProject {
        domain,
        path: project_dir.to_string_lossy().into_owned(),
        http: engine_display(&http, false),
        php: engine_display(&php, true),
        ssl: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Format and alignment are as in the panel's real home/<domain>/.osp/project.ini.
    const SAMPLE: &str = "\u{feff}[example.test]\r\n\r\nhttp_engine = Apache\r\nphp_engine  = PHP-8.2\r\nweb_root    = {base_dir}\\public\r\n";

    struct RenameFixture(PathBuf);

    impl RenameFixture {
        fn empty() -> Self {
            let root = std::env::temp_dir().join(format!(
                "osp-rename-test-{}-{}",
                std::process::id(),
                PROJECT_RENAME_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("home")).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }

        fn new() -> Self {
            let fixture = Self::empty();
            fs::create_dir_all(fixture.0.join("home/example.test/.osp")).unwrap();
            fs::write(fixture.0.join("home/example.test/.osp/project.ini"), SAMPLE).unwrap();
            fs::write(fixture.0.join("home/example.test/index.php"), "<?php echo 'unchanged';").unwrap();
            fixture
        }

        fn rename(&self, new_domain: &str) -> Result<RenamedProject, CommandError> {
            rename_project_directory(
                &self.0,
                "example.test",
                new_domain,
                &self.0.join("home/example.test"),
                &[],
            )
        }

        fn logs(&self, names: &[&str]) {
            let directory = self.0.join("logs/domains");
            fs::create_dir_all(&directory).unwrap();
            for name in names {
                fs::write(directory.join(name), "log contents\n").unwrap();
            }
        }
    }

    impl Drop for RenameFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_domains_are_normalized_and_validated_after_idna_conversion() {
        for (input, expected) in [
            (" Shop.TEST ", "shop.test"),
            ("my_app.test", "my_app.test"),
            ("café.test", "xn--caf-dma.test"),
            ("CAFE\u{0301}.TEST", "xn--caf-dma.test"),
            ("XN--CAF-DMA.TEST", "xn--caf-dma.test"),
            ("\u{0432}\u{0430}\u{043b}\u{044e}\u{0442}\u{0430}.test", "xn--80aae1b9a9d.test"),
            (
                "\u{0432}\u{0430}\u{043b}\u{044e}\u{0442}\u{0430}.\u{0440}\u{0444}.test",
                "xn--80aae1b9a9d.xn--p1ai.test",
            ),
            ("café\u{3002}test", "xn--caf-dma.test"),
            ("123", "123"),
        ] {
            assert_eq!(normalize_project_domain(input).unwrap(), expected);
        }
        let max_label = format!("{}.test", "a".repeat(63));
        assert_eq!(normalize_project_domain(&max_label).unwrap(), max_label);
        let long_domain = format!("{}.test", vec!["a".repeat(60); 4].join("."));
        assert_eq!(normalize_project_domain(&long_domain).unwrap(), long_domain);
        for invalid in [
            "",
            "   ",
            "../escape",
            "..\\escape",
            "bad/name.test",
            "https://café.test",
            "user@café.test",
            "café.test:80",
            "café.test?query",
            "café.test#fragment",
            "caf%65.test",
            "caf\té.test",
            "bad name.test",
            "café..test",
            ".café.test",
            "café.test.",
            "-bad.test",
            "bad-.test",
            "xn--.test",
            "xn--a.test",
            "CON.test",
            "lpt1.test",
            "bad\u{200d}.test",
            &format!("{}.test", "a".repeat(64)),
            &format!("{}.test", "é".repeat(58)),
            &format!("{}.test", vec!["a".repeat(63); 4].join(".")),
        ] {
            assert_eq!(
                normalize_project_domain(invalid).unwrap_err().code,
                "err.invalidDomain",
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn node_versions_come_from_complete_nvm_installations_and_sort_numerically() {
        let fixture = RenameFixture::empty();
        fs::create_dir_all(fixture.0.join("modules/Node-99.0.0")).unwrap();
        fs::create_dir_all(fixture.0.join("addons/NVM")).unwrap();
        fs::write(fixture.0.join("addons/NVM/nvm.exe"), "").unwrap();
        for version in ["v24.9.0", "v24.10.0", "v22.0.0", "v1.2", "vlatest", "v1.2.3-extra"] {
            fs::create_dir(fixture.0.join("addons/NVM").join(version)).unwrap();
            fs::write(fixture.0.join("addons/NVM").join(version).join("node.exe"), "").unwrap();
        }
        fs::create_dir(fixture.0.join("addons/NVM/v25.0.0")).unwrap();
        let options = scan_module_options(&fixture.0);
        assert!(options.nvm_available);
        assert_eq!(options.node_engines, ["Node-22.0.0", "Node-24.9.0", "Node-24.10.0"]);
        fs::remove_file(fixture.0.join("addons/NVM/nvm.exe")).unwrap();
        let options = scan_module_options(&fixture.0);
        assert!(!options.nvm_available);
        assert!(options.node_engines.is_empty());
    }

    #[test]
    fn creates_template_settings_and_validates_requirements_before_writing() {
        let fixture = RenameFixture::empty();
        let custom = Some(fixture.0.to_string_lossy().into_owned());
        let create = |id: &str, port: Option<u16>| {
            create_project(
                CreateProjectParams {
                    domain: format!("{id}.test"),
                    template: Some(id.into()),
                    backend_port: port,
                    ..Default::default()
                },
                custom.clone(),
            )
        };
        for (id, module) in [("static", "HTTP"), ("php", "HTTP"), ("node", "HTTP")] {
            let error = create(id, None).unwrap_err();
            assert_eq!(error.code, "err.projectTemplateModule");
            assert_eq!(error.params["module"], module);
        }
        fs::create_dir_all(fixture.0.join("modules/Apache")).unwrap();
        for (id, module) in [("php", "PHP"), ("laravel", "PHP"), ("wordpress", "PHP"), ("node", "Node.js")] {
            let error = create(id, None).unwrap_err();
            assert_eq!(error.code, "err.projectTemplateModule");
            assert_eq!(error.params["module"], module);
        }
        assert_eq!(create("unknown", None).unwrap_err().code, "err.projectTemplateInvalid");
        assert_eq!(fs::read_dir(fixture.0.join("home")).unwrap().count(), 0);
        for module in ["PHP-8.9", "PHP-8.10"] {
            fs::create_dir_all(fixture.0.join("modules").join(module)).unwrap();
        }
        fs::create_dir_all(fixture.0.join("addons/NVM/v24.0.0")).unwrap();
        fs::write(fixture.0.join("addons/NVM/nvm.exe"), "").unwrap();
        fs::write(fixture.0.join("addons/NVM/v24.0.0/node.exe"), "").unwrap();
        assert_eq!(create("node", Some(0)).unwrap_err().code, "err.invalidSettingValue");
        for id in ["static", "php", "laravel", "wordpress", "node"] {
            let created = create(id, Some(4321)).unwrap();
            assert_eq!(created.http, "Apache");
            let text = fs::read_to_string(Path::new(&created.path).join(".osp/project.ini")).unwrap();
            let sections = crate::project_workspace::parse(&text).unwrap();
            let values = &sections[&format!("{id}.test")];
            assert_eq!(values["http_engine"], "Apache");
            assert_eq!(
                values["php_engine"],
                if matches!(id, "php" | "laravel" | "wordpress") { "PHP-8.10" } else { "" }
            );
            assert_eq!(values["node_engine"], if id == "node" { "Node-24.0.0" } else { "" });
            assert_eq!(values["backend_enabled"], if id == "node" { "on" } else { "off" });
            assert!(!values["web_root"].is_empty());
        }
        assert_eq!(fs::read_dir(fixture.0.join("home")).unwrap().count(), 5);
    }

    #[test]
    fn idn_projects_use_punycode_on_disk_and_reject_equivalent_duplicates() {
        for (input, duplicate, domain) in [
            (" CAFÉ.test ", "cafe\u{0301}.test", "xn--caf-dma.test"),
            ("xn--caf-dma.test", "café.test", "xn--caf-dma.test"),
            (
                "\u{0432}\u{0430}\u{043b}\u{044e}\u{0442}\u{0430}.\u{0440}\u{0444}.test",
                "XN--80AAE1B9A9D.XN--P1AI.TEST",
                "xn--80aae1b9a9d.xn--p1ai.test",
            ),
        ] {
            let fixture = RenameFixture::empty();
            let custom = Some(fixture.0.to_string_lossy().into_owned());
            let create = |name: &str| {
                create_project(
                    CreateProjectParams {
                        domain: name.into(),
                        http_engine: None,
                        php_engine: None,
                        node_engine: None,
                        ..Default::default()
                    },
                    custom.clone(),
                )
            };
            let created = create(input).unwrap();
            assert_eq!(created.domain, domain);
            assert_eq!(fs::canonicalize(&created.path).unwrap(), fixture.0.join("home").join(domain));
            let ini = Path::new(&created.path).join(".osp/project.ini");
            let content = fs::read_to_string(&ini).unwrap();
            assert!(content.starts_with(&format!("\u{feff}[{domain}]\r\n\r\n")));
            assert_eq!(read_project_settings(domain.into(), custom.clone()).unwrap().domain, domain);
            let error = create(duplicate).unwrap_err();
            assert_eq!(error.code, "err.projectExists");
            assert_eq!(error.params["domain"], domain);
            assert_eq!(fs::read_to_string(ini).unwrap(), content);
            assert_eq!(fs::read_dir(fixture.0.join("home")).unwrap().count(), 1);
        }
    }

    #[test]
    fn creating_invalid_idns_leaves_no_project_files() {
        let fixture = RenameFixture::empty();
        for invalid in ["xn--.test", "café/escape.test", "caf\té.test"] {
            let error = create_project(
                CreateProjectParams {
                    domain: invalid.into(),
                    http_engine: None,
                    php_engine: None,
                    node_engine: None,
                    ..Default::default()
                },
                Some(fixture.0.to_string_lossy().into_owned()),
            )
            .unwrap_err();
            assert_eq!(error.code, "err.invalidDomain");
            assert_eq!(fs::read_dir(fixture.0.join("home")).unwrap().count(), 0);
        }
    }

    #[test]
    fn renaming_to_an_idn_normalizes_the_folder_and_ini_section() {
        for input in [" café.test ", "XN--CAF-DMA.TEST"] {
            let fixture = RenameFixture::new();
            let renamed = fixture.rename(input).unwrap();
            assert_eq!(renamed.domain, "xn--caf-dma.test");
            assert_eq!(fs::canonicalize(&renamed.path).unwrap(), fixture.0.join("home/xn--caf-dma.test"));
            assert_eq!(
                fs::read_to_string(Path::new(&renamed.path).join(".osp/project.ini")).unwrap(),
                SAMPLE.replacen("[example.test]", "[xn--caf-dma.test]", 1),
            );
            assert!(!fixture.0.join("home/example.test").exists());
        }
        let fixture = RenameFixture::new();
        fs::create_dir(fixture.0.join("home/xn--caf-dma.test")).unwrap();
        assert_eq!(fixture.rename("café.test").unwrap_err().code, "err.projectExists");
    }

    #[test]
    fn generated_domains_work_through_the_project_lifecycle_in_a_fresh_installation() {
        for (index, (suffix, new_suffix)) in
            [("test", "example"), ("example", "test"), ("sub.test", "sub.example")].into_iter().enumerate()
        {
            let fixture = RenameFixture::empty();
            let custom = Some(fixture.0.to_string_lossy().into_owned());
            let sequence = PROJECT_RENAME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let domain = format!("project-{sequence}-{index}.{suffix}");
            let new_domain = format!("renamed-{sequence}-{index}.{new_suffix}");
            fs::create_dir_all(fixture.0.join("modules/Apache")).unwrap();

            let created = create_project(
                CreateProjectParams {
                    domain: domain.clone(),
                    http_engine: Some("Apache".into()),
                    php_engine: None,
                    node_engine: None,
                    ..Default::default()
                },
                custom.clone(),
            )
            .unwrap();
            assert_eq!(fs::canonicalize(&created.path).unwrap(), fixture.0.join("home").join(&domain));
            write_project_settings(
                domain.clone(),
                ProjectModuleOverride {
                    http_engine: "Apache".into(),
                    php_engine: ENGINE_AUTO.into(),
                    node_engine: ENGINE_AUTO.into(),
                    tls_enabled: "on".into(),
                },
                custom.clone(),
            )
            .unwrap();
            let backup = crate::backups::create_project_backup(domain.clone(), custom.clone()).unwrap();
            assert_eq!(serde_json::to_value(backup).unwrap()["subject"], domain);

            let old_log = format!("{domain}_access.log");
            fixture.logs(&[old_log.as_str()]);
            let renamed =
                rename_project_directory(&fixture.0, &domain, &new_domain, Path::new(&created.path), &[])
                    .unwrap();
            assert_eq!(renamed.domain, new_domain);
            assert_eq!(fs::canonicalize(renamed.path).unwrap(), fixture.0.join("home").join(&new_domain));
            assert!(!fixture.0.join("home").join(&domain).exists());
            assert!(!fixture.0.join("logs/domains").join(old_log).exists());
            let settings = read_project_settings(new_domain.clone(), custom.clone()).unwrap();
            assert_eq!(settings.domain, new_domain);
            assert_eq!(settings.http_engine, "Apache");
            assert_eq!(settings.tls_enabled, "on");

            let new_log = format!("{new_domain}_error.log");
            fixture.logs(&[new_log.as_str()]);
            delete_project(new_domain.clone(), custom).unwrap();
            assert!(!fixture.0.join("home").join(new_domain).exists());
            assert!(!fixture.0.join("logs/domains").join(new_log).exists());
        }
    }

    #[test]
    fn rename_moves_project_and_changes_only_domain_header_with_original_backup() {
        let fixture = RenameFixture::new();
        let renamed = fixture.rename("renamed.test").unwrap();
        let target = fixture.0.join("home/renamed.test");
        assert_eq!(renamed.domain, "renamed.test");
        assert_eq!(fs::canonicalize(renamed.path).unwrap(), target);
        assert!(!fixture.0.join("home/example.test").exists());
        assert_eq!(
            fs::read_to_string(target.join(".osp/project.ini")).unwrap(),
            SAMPLE.replacen("[example.test]", "[renamed.test]", 1)
        );
        assert_eq!(fs::read_to_string(target.join("index.php")).unwrap(), "<?php echo 'unchanged';");
        let backups: Vec<_> = fs::read_dir(target.join(".osp"))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), SAMPLE);
    }

    #[test]
    fn project_operations_remove_only_the_selected_domains_logs() {
        let removed = [
            "EXAMPLE.TEST_access.LOG",
            "example.test_error.log",
            "example.test_caddy.log",
            "example.test_404.log",
            "example.test_error.log.1",
            "example.test_caddy-2026-11-05T00-00-00.000.log.gz",
        ];
        let kept = [
            "other.test_error.log",
            "example.test.extra.test_access.log",
            "prefix-example.test_error.log",
            "example.test_extra_error.log",
            "renamed.test_access.log",
            "example.test_error.txt",
        ];
        for rename in [false, true] {
            let fixture = RenameFixture::new();
            fixture.logs(&removed);
            fixture.logs(&kept);
            let nested = fixture.0.join("logs/domains/example.test_archive.log/nested.log");
            fs::create_dir_all(nested.parent().unwrap()).unwrap();
            fs::write(&nested, "keep nested log").unwrap();
            let module_log = fixture.0.join("logs/example.test_error.log");
            fs::write(&module_log, "keep module log").unwrap();
            if rename {
                fixture.rename("renamed.test").unwrap();
                assert!(fixture.0.join("home/renamed.test/.osp/project.ini").is_file());
            } else {
                delete_project("example.test".into(), Some(fixture.0.to_string_lossy().into_owned()))
                    .unwrap();
            }
            assert!(!fixture.0.join("home/example.test").exists());
            for name in removed {
                assert!(!fixture.0.join("logs/domains").join(name).exists(), "{name}");
            }
            for name in kept {
                assert_eq!(
                    fs::read_to_string(fixture.0.join("logs/domains").join(name)).unwrap(),
                    "log contents\n",
                    "{name}"
                );
            }
            assert_eq!(fs::read_to_string(&module_log).unwrap(), "keep module log");
            assert_eq!(fs::read_to_string(&nested).unwrap(), "keep nested log");
        }
    }

    #[test]
    fn project_operations_accept_missing_log_directories() {
        for rename in [false, true] {
            for logs_exist in [false, true] {
                let fixture = RenameFixture::new();
                if logs_exist {
                    fs::create_dir(fixture.0.join("logs")).unwrap();
                }
                if rename {
                    fixture.rename("new.test").unwrap();
                } else {
                    delete_project("example.test".into(), Some(fixture.0.to_string_lossy().into_owned()))
                        .unwrap();
                }
                assert!(!fixture.0.join("home/example.test").exists());
            }
        }
    }

    #[test]
    fn log_cleanup_handles_domains_with_underscores() {
        let fixture = RenameFixture::new();
        fixture.logs(&["my_site.test_error.log", "my_site.test_extra_error.log"]);
        remove_project_logs(&fixture.0, "MY_SITE.test").unwrap();
        assert!(!fixture.0.join("logs/domains/my_site.test_error.log").exists());
        assert!(fixture.0.join("logs/domains/my_site.test_extra_error.log").is_file());
    }

    #[test]
    #[cfg(windows)]
    fn locked_logs_prevent_project_deletion_and_renaming() {
        use std::os::windows::fs::OpenOptionsExt;
        for rename in [false, true] {
            let fixture = RenameFixture::new();
            fixture.logs(&["example.test_access.log"]);
            let log = fixture.0.join("logs/domains/example.test_access.log");
            let _handle = fs::OpenOptions::new().read(true).share_mode(3).open(&log).unwrap();
            let result = if rename {
                fixture.rename("new.test").map(|_| ())
            } else {
                delete_project("example.test".into(), Some(fixture.0.to_string_lossy().into_owned()))
            };
            assert_eq!(result.unwrap_err().code, "err.ioFailed");
            assert_eq!(
                fs::read_to_string(fixture.0.join("home/example.test/.osp/project.ini")).unwrap(),
                SAMPLE
            );
            assert!(!fixture.0.join("home/new.test").exists());
            assert_eq!(fs::read_to_string(log).unwrap(), "log contents\n");
        }
    }

    #[test]
    #[cfg(windows)]
    fn project_operations_reject_redirected_log_directories() {
        for rename in [false, true] {
            for component in ["logs", "logs/domains"] {
                let fixture = RenameFixture::new();
                let external = RenameFixture::new();
                external.logs(&["example.test_access.log"]);
                let link = fixture.0.join(component);
                fs::create_dir_all(link.parent().unwrap()).unwrap();
                let output = hidden_command("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&link)
                    .arg(external.0.join(component))
                    .output()
                    .unwrap();
                assert!(output.status.success());
                let result = if rename {
                    fixture.rename("new.test").map(|_| ())
                } else {
                    delete_project("example.test".into(), Some(fixture.0.to_string_lossy().into_owned()))
                };
                fs::remove_dir(&link).unwrap();
                assert_eq!(result.unwrap_err().code, "err.accessDenied");
                assert!(fixture.0.join("home/example.test/.osp/project.ini").is_file());
                assert_eq!(
                    fs::read_to_string(external.0.join("logs/domains/example.test_access.log")).unwrap(),
                    "log contents\n"
                );
            }
        }
    }

    #[test]
    fn rename_preserves_formatting_and_rejects_ambiguous_domain_sections() {
        let content =
            "\u{feff}; comment\n  [EXAMPLE.TEST]  \nphp_engine = PHP-8.3\n; example.test is not replaced";
        assert_eq!(
            rename_project_section(content, "example.test", "new.test").unwrap(),
            content.replacen("[EXAMPLE.TEST]", "[new.test]", 1)
        );
        for invalid in
            ["[example.test]\n[second.test]\n", "[other.test]\n", "[example.test]\n[EXAMPLE.TEST]\n", ""]
        {
            assert_eq!(
                rename_project_section(invalid, "example.test", "new.test").unwrap_err().code,
                "err.projectRenameLayout"
            );
        }
    }

    #[test]
    fn rename_rejects_conflicts_invalid_names_and_wrong_paths_without_changes() {
        let fixture = RenameFixture::new();
        fixture.logs(&["example.test_access.log"]);
        for invalid in
            ["../escape", "..\\escape", "EXAMPLE.TEST", "new.test.", "-bad.test", "con.test", "bad..test", ""]
        {
            assert_eq!(fixture.rename(invalid).unwrap_err().code, "err.invalidDomain");
        }
        fs::create_dir(fixture.0.join("home/taken.test")).unwrap();
        assert_eq!(fixture.rename("taken.test").unwrap_err().code, "err.projectExists");
        fs::create_dir_all(fixture.0.join("home/another/.osp")).unwrap();
        fs::write(fixture.0.join("home/another/.osp/project.ini"), "[pending.test]\n").unwrap();
        assert_eq!(fixture.rename("pending.test").unwrap_err().code, "err.projectExists");
        let wrong = rename_project_directory(
            &fixture.0,
            "example.test",
            "new.test",
            &fixture.0.join("home/another"),
            &[],
        )
        .unwrap_err();
        assert_eq!(wrong.code, "err.projectRenameLayout");
        let registered = crate::panel_api::Project {
            domain: "api.test".into(),
            path: fixture.0.join("home/example.test").to_string_lossy().into_owned(),
            php: "8.2".into(),
            r#type: "Apache".into(),
            ssl: true,
        };
        assert_eq!(
            rename_project_directory(
                &fixture.0,
                "example.test",
                "new.test",
                &fixture.0.join("home/example.test"),
                &[registered]
            )
            .unwrap_err()
            .code,
            "err.projectRenameLayout"
        );
        fs::write(fixture.0.join("home/example.test/.osp/project.ini"), "[example.test]\n[shared.test]\n")
            .unwrap();
        assert_eq!(fixture.rename("new.test").unwrap_err().code, "err.projectRenameLayout");
        assert!(!fixture.0.join("home/new.test").exists());
        assert!(fixture.0.join("logs/domains/example.test_access.log").is_file());
    }

    #[test]
    #[cfg(windows)]
    fn rename_restores_original_ini_when_directory_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = RenameFixture::new();
        fixture.logs(&["example.test_access.log"]);
        // FILE_FLAG_BACKUP_SEMANTICS opens the directory itself; omitting FILE_SHARE_DELETE
        // reproduces an editor/server preventing Windows from moving that directory.
        let _handle = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .share_mode(3)
            .open(fixture.0.join("home/example.test"))
            .unwrap();
        assert_eq!(fixture.rename("new.test").unwrap_err().code, "err.ioFailed");
        assert_eq!(fs::read_to_string(fixture.0.join("home/example.test/.osp/project.ini")).unwrap(), SAMPLE);
        assert!(!fixture.0.join("home/new.test").exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("logs/domains/example.test_access.log")).unwrap(),
            "log contents\n"
        );
    }

    #[test]
    #[cfg(windows)]
    fn rename_rejects_junctions_outside_home_and_redirected_settings() {
        let fixture = RenameFixture::new();
        let external = RenameFixture::new();
        let link = fixture.0.join("home/escape.test");
        let output = hidden_command("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(external.0.join("home/example.test"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            rename_project_directory(&fixture.0, "escape.test", "new.test", &link, &[]).unwrap_err().code,
            "err.projectRenameLayout"
        );
        fs::remove_dir(&link).unwrap();
        let osp = fixture.0.join("home/example.test/.osp");
        fs::remove_file(osp.join("project.ini")).unwrap();
        fs::remove_dir(&osp).unwrap();
        let output = hidden_command("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&osp)
            .arg(external.0.join("home/example.test/.osp"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(fixture.rename("new.test").unwrap_err().code, "err.accessDenied");
        fs::remove_dir(&osp).unwrap();
        assert_eq!(
            fs::read_to_string(external.0.join("home/example.test/.osp/project.ini")).unwrap(),
            SAMPLE
        );
    }

    #[test]
    fn replaces_value_preserving_line_formatting() {
        let (next, changed) = ini_set_value(SAMPLE, "example.test", "php_engine", "PHP-8.4", true);
        assert!(changed);
        assert!(next.contains("php_engine  = PHP-8.4"));
        assert!(next.contains("http_engine = Apache"));
        assert!(next.contains("web_root    = {base_dir}\\public"));
        assert!(next.starts_with('\u{feff}'));
        assert!(next.contains("\r\n"));
    }

    #[test]
    fn keeps_file_untouched_when_value_is_the_same() {
        let (next, changed) = ini_set_value(SAMPLE, "example.test", "php_engine", "PHP-8.2", true);
        assert!(!changed);
        assert_eq!(next, SAMPLE);
    }

    #[test]
    fn inserts_missing_key_into_existing_section() {
        let (next, changed) = ini_set_value(SAMPLE, "example.test", "node_engine", "Node-22.11.0", true);
        assert!(changed);
        assert!(next.contains("node_engine       = Node-22.11.0"));
        assert!(next.contains("web_root    = {base_dir}\\public\r\n"));
    }

    #[test]
    fn skips_missing_key_when_insert_not_allowed() {
        let (next, changed) = ini_set_value(SAMPLE, "example.test", "node_engine", ENGINE_AUTO, false);
        assert!(!changed);
        assert_eq!(next, SAMPLE);
    }

    #[test]
    fn appends_new_section_for_unknown_domain() {
        let (next, changed) = ini_set_value(SAMPLE, "other.test", "php_engine", "PHP-8.3", true);
        assert!(changed);
        assert!(next.contains("[other.test]"));
        assert!(next.contains("php_engine        = PHP-8.3"));
    }

    #[test]
    fn reads_section_values_case_insensitively() {
        let values = find_project_section(SAMPLE, "EXAMPLE.TEST").expect("section must be found");
        assert_eq!(values.get("http_engine").map(String::as_str), Some("Apache"));
        assert_eq!(values.get("php_engine").map(String::as_str), Some("PHP-8.2"));
        assert!(!values.contains_key("node_engine"));
    }

    // A full write→read cycle on a temporary "OSPanel root": the file is created,
    // read back, and writing the same values again does not change it.
    #[test]
    fn write_read_roundtrip_on_temporary_install() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-{}", std::process::id()));
        let home = root.join("home").join("fixture.test");
        let modules = root.join("modules");
        fs::create_dir_all(&home).unwrap();
        for module in ["Apache", "Nginx", "PHP-8.2", "PHP-8.4"] {
            fs::create_dir_all(modules.join(module)).unwrap();
        }
        let custom = Some(root.to_string_lossy().into_owned());

        let settings = write_project_settings(
            "fixture.test".into(),
            ProjectModuleOverride {
                http_engine: "Apache".into(),
                php_engine: "PHP-8.4".into(),
                node_engine: ENGINE_AUTO.into(),
                tls_enabled: "on".into(),
            },
            custom.clone(),
        )
        .unwrap();
        assert!(settings.file_exists);

        let content =
            fs::read_to_string(root.join("home").join("fixture.test").join(".osp").join("project.ini"))
                .unwrap();
        assert!(content.starts_with("\u{feff}[fixture.test]"));
        assert!(content.contains("http_engine"));
        assert!(content.contains("php_engine        = PHP-8.4"));
        // For a new file all three keys are written explicitly, like in the panel's skeleton, including "= auto".
        assert!(content.contains("node_engine       = auto"));
        assert!(content.contains("tls_enabled       = on"));

        let reread = read_project_settings("fixture.test".into(), custom.clone()).unwrap();
        assert_eq!(reread.http_engine, "Apache");
        assert_eq!(reread.php_engine, "PHP-8.4");
        assert_eq!(reread.node_engine, ENGINE_AUTO);
        assert_eq!(reread.tls_enabled, "on");

        let options = project_module_options(custom.clone()).unwrap();
        assert_eq!(options.http_engines, vec!["Apache", "Nginx"]);
        assert_eq!(options.php_engines, vec!["PHP-8.2", "PHP-8.4"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_rejects_module_missing_from_installation() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-miss-{}", std::process::id()));
        fs::create_dir_all(root.join("home").join("fixture.test")).unwrap();
        let error = write_project_settings(
            "fixture.test".into(),
            ProjectModuleOverride {
                http_engine: ENGINE_AUTO.into(),
                php_engine: "PHP-9.9".into(),
                node_engine: ENGINE_AUTO.into(),
                tls_enabled: ENGINE_AUTO.into(),
            },
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert_eq!(error.code, "err.invalidSettingValue");
        fs::remove_dir_all(&root).unwrap();
    }

    // The TLS toggle writes tls_enabled on/off into project.ini and rejects junk values.
    #[test]
    fn tls_toggle_writes_and_validates() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-tls-{}", std::process::id()));
        let home = root.join("home").join("fixture.test");
        let modules = root.join("modules");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(modules.join("Apache")).unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        // Turning TLS off writes an explicit tls_enabled = off.
        write_project_settings(
            "fixture.test".into(),
            ProjectModuleOverride {
                http_engine: ENGINE_AUTO.into(),
                php_engine: ENGINE_AUTO.into(),
                node_engine: ENGINE_AUTO.into(),
                tls_enabled: "off".into(),
            },
            custom.clone(),
        )
        .unwrap();
        let reread = read_project_settings("fixture.test".into(), custom.clone()).unwrap();
        assert_eq!(reread.tls_enabled, "off");

        // A value outside auto/on/off is rejected before anything is written.
        let error = write_project_settings(
            "fixture.test".into(),
            ProjectModuleOverride {
                http_engine: ENGINE_AUTO.into(),
                php_engine: ENGINE_AUTO.into(),
                node_engine: ENGINE_AUTO.into(),
                tls_enabled: "yes".into(),
            },
            custom.clone(),
        )
        .unwrap_err();
        assert_eq!(error.code, "err.invalidSettingValue");

        fs::remove_dir_all(&root).unwrap();
    }

    // Creating a project: directory structure, ini format, duplicates and junk engines.
    #[test]
    fn create_project_builds_structure_and_validates() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-create-{}", std::process::id()));
        let modules = root.join("modules");
        fs::create_dir_all(&modules).unwrap();
        for module in ["Apache", "PHP-8.3"] {
            fs::create_dir_all(modules.join(module)).unwrap();
        }
        let custom = Some(root.to_string_lossy().into_owned());

        let created = create_project(
            CreateProjectParams {
                domain: "new.test".into(),
                http_engine: Some("Apache".into()),
                php_engine: None,
                node_engine: None,
                ..Default::default()
            },
            custom.clone(),
        )
        .unwrap();
        assert_eq!(created.domain, "new.test");
        assert!(created.path.ends_with("home\\new.test"));
        assert_eq!(created.http, "Apache");
        assert_eq!(created.php, "-");

        let ini = root.join("home").join("new.test").join(".osp").join("project.ini");
        let content = fs::read_to_string(&ini).unwrap();
        assert!(content.starts_with("\u{feff}[new.test]\r\n\r\n"));
        assert!(content.contains("http_engine       = Apache\r\n"));
        assert!(content.contains("php_engine        = auto\r\n"));
        assert!(content.contains("node_engine       = auto\r\n"));

        // A duplicate is an err.projectExists error.
        let duplicate = create_project(
            CreateProjectParams {
                domain: "new.test".into(),
                http_engine: None,
                php_engine: None,
                node_engine: None,
                ..Default::default()
            },
            custom.clone(),
        )
        .unwrap_err();
        assert_eq!(duplicate.code, "err.projectExists");

        // An invalid engine errors before directories are created (no garbage in home/).
        let bad_domain = "rejected.test";
        let bad_engine = create_project(
            CreateProjectParams {
                domain: bad_domain.into(),
                http_engine: None,
                php_engine: Some("PHP-9.9".into()),
                node_engine: None,
                ..Default::default()
            },
            custom.clone(),
        )
        .unwrap_err();
        assert_eq!(bad_engine.code, "err.invalidSettingValue");
        assert!(!root.join("home").join(bad_domain).exists());

        fs::remove_dir_all(&root).unwrap();
    }

    // Project deletion: the directory is wiped, a repeated call and a path escape are errors.
    #[test]
    fn delete_project_removes_directory_and_validates() {
        let root = std::env::temp_dir().join(format!("osp-ui-test-del-{}", std::process::id()));
        let project = root.join("home").join("gone.test");
        fs::create_dir_all(project.join(".osp")).unwrap();
        fs::write(project.join(".osp").join("project.ini"), "\u{feff}[gone.test]\r\n").unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        delete_project("gone.test".into(), custom.clone()).unwrap();
        assert!(!project.exists());

        let missing = delete_project("gone.test".into(), custom.clone()).unwrap_err();
        assert_eq!(missing.code, "err.projectNotFound");

        fs::create_dir_all(root.join("logs/domains")).unwrap();
        fs::write(root.join("logs/domains/gone.test_error.log"), "keep orphan log").unwrap();
        let missing = delete_project("gone.test".into(), custom.clone()).unwrap_err();
        assert_eq!(missing.code, "err.projectNotFound");
        assert!(root.join("logs/domains/gone.test_error.log").is_file());

        let traversal = delete_project("..\\evil".into(), custom).unwrap_err();
        assert_eq!(traversal.code, "err.invalidDomain");

        fs::remove_dir_all(&root).unwrap();
    }
}
