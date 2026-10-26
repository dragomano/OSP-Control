//! Opening things (URLs, folders, files, editors) plus the config and log table readers.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{CommandError, spawn_failed};
use crate::paths::{explorer_open, modified_secs, resolve_installation, within_installation};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogSource {
    name: String,
    label: String,
    // true for domain logs — the label is translated in the frontend via logs.sourceDomain.
    domain: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigFile {
    name: String,
    service: String,
    path: String,
    size_bytes: u64,
    modified_at: u64,
}

#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), CommandError> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(CommandError::new("err.urlProtocolOnly"));
    }
    if !url.chars().all(|c| c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c)) {
        return Err(CommandError::new("err.urlInvalid"));
    }
    Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(spawn_failed)?;
    Ok(())
}

#[tauri::command]
pub fn open_folder(path: String, custom_path: Option<String>) -> Result<(), CommandError> {
    let canonical = fs::canonicalize(Path::new(&path))
        .map_err(|_| CommandError::new("err.folderNotFound").with("path", path.clone()))?;

    if !within_installation(&canonical, custom_path.as_deref()) {
        return Err(CommandError::new("err.folderOutsideRoot"));
    }

    // For a file, open the folder containing it.
    let target = if canonical.is_file() {
        canonical.parent().map(Path::to_path_buf).unwrap_or_else(|| canonical.clone())
    } else {
        canonical.clone()
    };
    explorer_open(&target)
}

#[tauri::command]
pub fn open_file(path: String, custom_path: Option<String>) -> Result<(), CommandError> {
    let canonical = fs::canonicalize(Path::new(&path))
        .map_err(|_| CommandError::new("err.fileNotFound").with("path", path.clone()))?;
    if !canonical.is_file() {
        return Err(CommandError::new("err.notAFile"));
    }
    if !within_installation(&canonical, custom_path.as_deref()) {
        return Err(CommandError::new("err.fileOutsideRoot"));
    }
    // Launch the original path (without the \\?\ prefix) with the default app.
    Command::new("cmd").args(["/C", "start", "", &path]).spawn().map_err(spawn_failed)?;
    Ok(())
}

#[tauri::command]
pub fn open_panel_folder(custom_path: Option<String>) -> Result<(), CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let canonical = fs::canonicalize(&root)
        .map_err(|_| CommandError::new("err.folderNotFound").with("path", root.display().to_string()))?;
    if !within_installation(&canonical, custom_path.as_deref()) {
        return Err(CommandError::new("err.folderOutsideRoot"));
    }
    explorer_open(&canonical)
}

#[tauri::command]
pub fn read_config(path: String, custom_path: Option<String>) -> Result<String, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let canonical_root = fs::canonicalize(root)?;
    let canonical_file = fs::canonicalize(Path::new(&path))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(fs::read_to_string(canonical_file)?)
}

fn is_config_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".conf", ".ini", ".cnf", ".cfg", ".yaml", ".yml", ".json", ".toml", ".vhost", ".htaccess"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn scan_config_dir(dir: &Path, service: &str, depth: u32, list: &mut Vec<ConfigFile>) {
    if depth > 2 {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_config_dir(&path, service, depth + 1, list);
        } else if let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) {
            if !is_config_file(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified_at = modified_secs(&meta);
            list.push(ConfigFile {
                name,
                service: service.to_string(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                modified_at,
            });
        }
    }
}

#[tauri::command]
pub fn list_configs(custom_path: Option<String>) -> Result<Vec<ConfigFile>, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let config_dir = root.join("config");
    let mut list = Vec::new();

    let services = fs::read_dir(&config_dir).map_err(|_| CommandError::new("err.configDirNotFound"))?;
    for service in services.flatten() {
        if !service.path().is_dir() {
            continue;
        }
        let service_name = service.file_name().to_string_lossy().into_owned();
        scan_config_dir(&service.path(), &service_name, 0, &mut list);
    }

    list.sort_by(|a, b| {
        b.modified_at.cmp(&a.modified_at).then(a.service.cmp(&b.service)).then(a.name.cmp(&b.name))
    });
    list.truncate(120);
    Ok(list)
}

// A *.log file — the rule both log folders are scanned with.
fn is_log_file(path: &Path) -> bool {
    path.is_file() && path.extension().map(|ext| ext.eq_ignore_ascii_case("log")).unwrap_or(false)
}

#[tauri::command]
pub fn list_log_sources(custom_path: Option<String>) -> Result<Vec<LogSource>, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let logs = root.join("logs");

    // The folders are scanned identically — only the source built from a file name differs.
    let scan = |dir: &Path| -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };

        entries
            .flatten()
            .filter(|entry| is_log_file(&entry.path()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    };

    let mut sources: Vec<LogSource> = scan(&logs)
        .into_iter()
        .map(|file| LogSource { label: file.clone(), name: file, domain: false })
        .collect();

    for file in scan(&logs.join("domains")) {
        let label = file.trim_end_matches(".log").replacen('_', " ", 1);
        sources.push(LogSource { label, name: format!("domains/{}", file), domain: true });
    }

    sources.sort_by_key(|a| a.label.to_lowercase());
    Ok(sources)
}

#[tauri::command]
pub fn read_log_tail(
    source: String,
    max_lines: usize,
    custom_path: Option<String>,
) -> Result<Vec<String>, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let logs_root = fs::canonicalize(root.join("logs"))?;

    if source.contains("..") || source.contains('\\') || source.starts_with('/') {
        return Err(CommandError::new("err.invalidLogName"));
    }
    if !source.chars().all(|c| c.is_alphanumeric() || "/._- ".contains(c)) {
        return Err(CommandError::new("err.invalidLogName"));
    }

    let path = fs::canonicalize(logs_root.join(&source))
        .map_err(|_| CommandError::new("err.logNotFound").with("source", source.clone()))?;
    if !path.starts_with(&logs_root) {
        return Err(CommandError::new("err.accessDenied"));
    }

    let mut file = fs::File::open(&path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(256 * 1024);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text
        .lines()
        .skip(if start > 0 { 1 } else { 0 })
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    let limit = max_lines.clamp(10, 2000);
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    Ok(lines)
}

// --- Editors for the "Open in" menu ---
// We look for installed IDEs in standard installation locations. The list is fixed,
// the id is used as a whitelist at launch: the exe path is never handed out.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorInfo {
    id: String,
    name: String,
}

// Directories in base whose name starts with prefix (case-insensitive) —
// installs like "PhpStorm 263.3889.75" or "Zed i18n".
fn scan_dirs_with_prefix(base: &Path, prefix: &str) -> Vec<PathBuf> {
    let lower_prefix = prefix.to_ascii_lowercase();
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };

    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_ascii_lowercase().starts_with(&lower_prefix))
                    .unwrap_or(false)
        })
        .collect();

    dirs.sort();
    dirs
}

fn editor_executables() -> Vec<(EditorInfo, PathBuf)> {
    let env_path = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let local = env_path("LOCALAPPDATA");
    let appdata = env_path("APPDATA");
    let program_files = env_path("ProgramFiles");
    let program_files_x86 = env_path("ProgramFiles(x86)");

    let mut found: Vec<(EditorInfo, PathBuf)> = Vec::new();
    let mut add = |id: &str, name: &str, candidates: Vec<PathBuf>| {
        if found.iter().any(|(info, _)| info.id == id) {
            return;
        }
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            found.push((EditorInfo { id: id.into(), name: name.into() }, path));
        }
    };

    // VS Code: the CLI on PATH, then the user and system installations.
    let mut vscode: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|dir| dir.join("code.cmd")).collect())
        .unwrap_or_default();
    if let Some(local) = &local {
        vscode.push(local.join(r"Programs\Microsoft VS Code\bin\code.cmd"));
    }
    if let Some(pf) = &program_files {
        vscode.push(pf.join(r"Microsoft VS Code\bin\code.cmd"));
    }
    add("vscode", "VS Code", vscode);

    // PhpStorm: Toolbox (new and old layouts), a standalone install
    // in %LOCALAPPDATA%\Programs and in Program Files (in the root and in JetBrains\);
    // in the Toolbox we pick the directory with the highest version number.
    let mut phpstorm: Vec<PathBuf> = Vec::new();
    for base in [&local, &appdata] {
        let Some(base) = base else { continue };
        for apps in ["apps/phpstorm", "apps/PhpStorm"] {
            let ch0 = base.join("JetBrains").join("Toolbox").join(apps).join("ch-0");
            let Ok(entries) = fs::read_dir(&ch0) else { continue };
            let mut versions: Vec<PathBuf> =
                entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
            versions.sort_by_key(|path| {
                path.file_name()
                    .map(|name| {
                        name.to_string_lossy()
                            .split('.')
                            .map(|part| part.parse::<u64>().unwrap_or(0))
                            .collect::<Vec<u64>>()
                    })
                    .unwrap_or_default()
            });
            if let Some(latest) = versions.last() {
                phpstorm.push(latest.join(r"bin\phpstorm64.exe"));
            }
        }
        if let Some(dir) = scan_dirs_with_prefix(&base.join("Programs"), "phpstorm").first() {
            phpstorm.push(dir.join(r"bin\phpstorm64.exe"));
        }
    }
    if let Some(pf) = &program_files {
        for base in [pf.clone(), pf.join("JetBrains")] {
            for dir in scan_dirs_with_prefix(&base, "PhpStorm") {
                phpstorm.push(dir.join(r"bin\phpstorm64.exe"));
            }
        }
    }
    add("phpstorm", "PhpStorm", phpstorm);

    // Zed: the exe in the install directory, in bin\ next to it, and on PATH; the folder
    // name may differ from "Zed" (forks like "Zed i18n") — searching by prefix.
    let mut zed: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|dir| dir.join("zed.exe")).collect())
        .unwrap_or_default();
    if let Some(local) = &local {
        for dir in scan_dirs_with_prefix(&local.join("Programs"), "zed") {
            zed.push(dir.join("Zed.exe"));
            zed.push(dir.join(r"bin\Zed.exe"));
            zed.push(dir.join("zed.exe"));
        }
    }
    if let Some(pf) = &program_files {
        for dir in scan_dirs_with_prefix(pf, "zed") {
            zed.push(dir.join("Zed.exe"));
        }
    }
    add("zed", "Zed", zed);

    let mut sublime: Vec<PathBuf> = Vec::new();
    for base in [&program_files, &local].into_iter().flatten() {
        sublime.push(base.join(r"Sublime Text\subl.exe"));
        sublime.push(base.join(r"Sublime Text 3\subl.exe"));
    }
    add("sublime", "Sublime Text", sublime);

    let mut npp: Vec<PathBuf> = Vec::new();
    if let Some(pf) = &program_files {
        npp.push(pf.join(r"Notepad++\notepad++.exe"));
    }
    if let Some(pf86) = &program_files_x86 {
        npp.push(pf86.join(r"Notepad++\notepad++.exe"));
    }
    add("notepadpp", "Notepad++", npp);

    found
}

#[tauri::command]
pub fn list_editors() -> Vec<EditorInfo> {
    editor_executables().into_iter().map(|(info, _)| info).collect()
}

#[tauri::command]
pub fn open_in_editor(
    editor_id: String,
    path: String,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    // Check that the installation was found — root itself is not needed here.
    resolve_installation(custom_path.as_deref())?;
    let canonical = fs::canonicalize(Path::new(&path))
        .map_err(|_| CommandError::new("err.folderNotFound").with("path", path.clone()))?;
    if !canonical.is_dir() {
        return Err(CommandError::new("err.notADirectory"));
    }
    if !within_installation(&canonical, custom_path.as_deref()) {
        return Err(CommandError::new("err.folderOutsideRoot"));
    }

    let editors = editor_executables();
    let (_, exe) = editors
        .into_iter()
        .find(|(info, _)| info.id == editor_id)
        .ok_or_else(|| CommandError::new("err.editorNotFound").with("id", editor_id.clone()))?;

    // Editor CLI launchers (.cmd) run through cmd.exe, everything else directly.
    let is_cmd = exe.extension().map(|e| e.eq_ignore_ascii_case("cmd")).unwrap_or(false);
    let spawn_result = if is_cmd {
        Command::new("cmd").arg("/C").arg(&exe).arg(&path).spawn()
    } else {
        Command::new(&exe).arg(&path).spawn()
    };
    spawn_result.map_err(spawn_failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Prefix-based scan of installation directories — case-insensitive.
    #[test]
    fn scan_dirs_with_prefix_matches_case_insensitively() {
        let base = std::env::temp_dir().join(format!("osp-ui-scan-{}", std::process::id()));
        fs::create_dir_all(base.join("Zed i18n")).unwrap();
        fs::create_dir_all(base.join("zed-app")).unwrap();
        fs::create_dir_all(base.join("Other")).unwrap();

        let found = scan_dirs_with_prefix(&base, "ZED");
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_ascii_lowercase().starts_with("zed"))
                .unwrap_or(false)
        }));

        fs::remove_dir_all(&base).unwrap();
    }
}
