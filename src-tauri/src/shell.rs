//! Opening things (URLs, folders, files, editors) plus the config and log table readers.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{CommandError, spawn_failed};
use crate::panel_api::{api_json, dat_field, services_from_json};
use crate::paths::{
    explorer_open, external_path, hidden_command, is_valid_module_name, modified_secs, resolve_installation,
    within_installation,
};

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
    scan_log_sources(&logs_directory(&root)?)
}

fn logs_directory(root: &Path) -> Result<PathBuf, CommandError> {
    let root = fs::canonicalize(root)?;
    let logs = fs::canonicalize(root.join("logs"))?;
    if !logs.starts_with(&root) || logs == root {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(logs)
}

fn scan_log_sources(logs: &Path) -> Result<Vec<LogSource>, CommandError> {
    // The folders are scanned identically — only the source built from a file name differs.
    let scan = |dir: &Path| -> Result<Vec<String>, CommandError> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            if is_log_file(&entry.path()) {
                files.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        Ok(files)
    };

    let mut sources: Vec<LogSource> = scan(logs)?
        .into_iter()
        .map(|file| LogSource { label: file.clone(), name: file, domain: false })
        .collect();

    for file in scan(&logs.join("domains"))? {
        let label = file.trim_end_matches(".log").replacen('_', " ", 1);
        sources.push(LogSource { label, name: format!("domains/{}", file), domain: true });
    }

    sources.sort_by_key(|a| a.label.to_lowercase());
    Ok(sources)
}

// Only files exposed by the log picker are accepted, including domain logs.
fn log_path(logs_root: &Path, source: &str) -> Result<PathBuf, CommandError> {
    let parts: Vec<_> = source.split('/').collect();
    if !(parts.len() == 1 || (parts.len() == 2 && parts[0] == "domains"))
        || source.contains("..")
        || !source.chars().all(|c| c.is_alphanumeric() || "/._- ".contains(c))
        || !Path::new(source).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
    {
        return Err(CommandError::new("err.invalidLogName"));
    }
    let path = fs::canonicalize(logs_root.join(source))
        .map_err(|_| CommandError::new("err.logNotFound").with("source", source))?;
    if !path.starts_with(logs_root) {
        return Err(CommandError::new("err.accessDenied"));
    }
    if !is_log_file(&path) {
        return Err(CommandError::new("err.invalidLogName"));
    }
    Ok(path)
}

fn truncate_log(logs_root: &Path, source: &str) -> Result<(), CommandError> {
    let path = log_path(logs_root, source)?;
    // Keep the file and its permissions; active modules may still have it open.
    // Opening without create/truncate also avoids recreating a file removed during the scan.
    let clear = || -> std::io::Result<()> {
        let file = fs::OpenOptions::new().write(true).open(path)?;
        // A hard link may refer to data outside logs even after canonicalization.
        if log_has_multiple_links(&file)? {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        file.set_len(0)
    };
    clear().map_err(|error| {
        if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) {
            return CommandError::new("err.logLocked").with("source", source);
        }
        CommandError::new("err.logClearFailed").with("source", source).with("detail", error.to_string())
    })
}

fn log_has_multiple_links(file: &fs::File) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(information.nNumberOfLinks > 1)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(file.metadata()?.nlink() > 1)
    }
}

trait LogPanel {
    fn pause(&mut self) -> Result<bool, CommandError>;
    fn resume(&mut self) -> Result<(), CommandError>;
}

fn log_modules_to_restore(snapshot: &serde_json::Value, expected: &[String]) -> Vec<String> {
    expected
        .iter()
        .filter(|name| {
            dat_field(snapshot, name)
                .and_then(|module| dat_field(module, "enabled"))
                .and_then(|field| field.get("_value"))
                .and_then(serde_json::Value::as_bool)
                == Some(false)
        })
        .cloned()
        .collect()
}

struct NativeLogPanel<'a> {
    root: &'a Path,
    running_modules: Option<Vec<String>>,
}

impl NativeLogPanel<'_> {
    fn executable(&self, name: &str) -> Result<PathBuf, CommandError> {
        let root = fs::canonicalize(self.root)?;
        let executable = fs::canonicalize(root.join("bin").join(name))
            .map_err(|_| CommandError::new("err.ospanelNotFound"))?;
        if !executable.starts_with(&root) || !executable.is_file() {
            return Err(CommandError::new("err.accessDenied"));
        }
        Ok(external_path(&executable))
    }

    fn command(&self, args: &[&str]) -> std::io::Result<()> {
        use std::process::Stdio;
        let executable = self.executable("osp.bat").map_err(|error| std::io::Error::other(error.code))?;
        let mut child =
            hidden_command(executable).args(args).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if let Some(status) = child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(std::io::Error::other(status.to_string()))
                };
            }
            if Instant::now() >= deadline {
                // Only the CLI helper is terminated; OSPanel and database processes shut down normally.
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn wait_for<T>(&self, mut probe: impl FnMut() -> Option<T>) -> std::io::Result<T> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(value) = probe() {
                return Ok(value);
            }
            if Instant::now() >= deadline {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

impl LogPanel for NativeLogPanel<'_> {
    fn pause(&mut self) -> Result<bool, CommandError> {
        let Some(snapshot) = api_json(self.root, "/getmodules") else { return Ok(false) };
        let modules: Vec<_> = services_from_json(&snapshot)
            .into_iter()
            .filter(|service| service.status == "running")
            .map(|service| service.name)
            .collect();
        if modules.iter().any(|name| !is_valid_module_name(name)) {
            return Err(CommandError::new("err.invalidModuleName"));
        }
        // Validate both fixed executables before asking the panel to exit.
        self.executable("osp.bat")?;
        self.executable("ospanel.exe")?;
        self.running_modules = Some(modules);
        self.command(&["exit", "silent"])
            .and_then(|()| self.wait_for(|| (!self.root.join("temp/OSPanel.lock").exists()).then_some(())))
            .map_err(|error| CommandError::new("err.logPanelStopFailed").with("detail", error.to_string()))?;
        Ok(true)
    }

    fn resume(&mut self) -> Result<(), CommandError> {
        let Some(expected) = &self.running_modules else { return Ok(()) };
        let restore = || -> Result<(), CommandError> {
            if api_json(self.root, "/getmodules").is_none() {
                self.wait_for(|| (!self.root.join("temp/OSPanel.lock").exists()).then_some(()))?;
                hidden_command(self.executable("ospanel.exe")?).spawn()?;
            }
            self.wait_for(|| api_json(self.root, "/getmodules"))?;
            let check_ready = || {
                let snapshot = api_json(self.root, "/getmodules")?;
                let services = services_from_json(&snapshot);
                expected
                    .iter()
                    .all(|name| {
                        services.iter().any(|service| service.name == *name && service.status == "running")
                    })
                    .then_some(())
            };
            // The API becomes available before module autostart completes. Let OSPanel finish
            // first: an enabled module without a process handle must not receive another "on".
            let mut ready = self.wait_for(check_ready);
            if ready.is_err() {
                let pending = api_json(self.root, "/getmodules")
                    .map(|snapshot| log_modules_to_restore(&snapshot, expected))
                    .unwrap_or_default();
                if !pending.is_empty() {
                    for name in pending {
                        // Recheck before each request: a dependency may have enabled this module.
                        let disabled = api_json(self.root, "/getmodules")
                            .map(|snapshot| {
                                !log_modules_to_restore(&snapshot, std::slice::from_ref(&name)).is_empty()
                            })
                            .unwrap_or(false);
                        if disabled {
                            let _ = self.command(&["on", &name]);
                        }
                    }
                    ready = self.wait_for(check_ready);
                }
            }
            if ready.is_err() {
                let actual = api_json(self.root, "/getmodules")
                    .map(|json| services_from_json(&json))
                    .unwrap_or_default();
                let missing: Vec<_> = expected
                    .iter()
                    .filter(|name| {
                        !actual.iter().any(|service| service.name == **name && service.status == "running")
                    })
                    .cloned()
                    .collect();
                return Err(CommandError::new("err.logModulesResumeFailed").with("names", missing.join(", ")));
            }
            Ok(())
        };
        restore().map_err(|error| {
            if error.code == "err.logModulesResumeFailed" {
                return error;
            }
            let detail = error.params.get("detail").cloned().unwrap_or(error.code);
            CommandError::new("err.logPanelResumeFailed").with("detail", detail)
        })
    }
}

fn clear_logs_with_panel(
    root: &Path,
    source: Option<&str>,
    panel: &mut impl LogPanel,
) -> Result<usize, CommandError> {
    let logs = logs_directory(root)?;
    let targets = match source {
        Some(source) => vec![source.to_string()],
        None => scan_log_sources(&logs)?.into_iter().map(|source| source.name).collect(),
    };
    let mut cleared = 0;
    let mut failed = Vec::new();
    for name in targets {
        match truncate_log(&logs, &name) {
            Ok(()) => cleared += 1,
            Err(error) => failed.push((name, error)),
        }
    }
    if failed.iter().any(|(_, error)| error.code == "err.logLocked") {
        match panel.pause() {
            Ok(true) => {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let previous = std::mem::take(&mut failed);
                    for (name, error) in previous {
                        if error.code != "err.logLocked" {
                            failed.push((name, error));
                        } else if let Err(error) = truncate_log(&logs, &name) {
                            failed.push((name, error));
                        } else {
                            cleared += 1;
                        }
                    }
                    if !failed.iter().any(|(_, error)| error.code == "err.logLocked")
                        || Instant::now() >= deadline
                    {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                // Recovery is unconditional: a failed truncation must not leave the panel stopped.
                panel.resume()?;
            }
            Ok(false) => {}
            Err(error) => {
                panel.resume()?;
                return Err(error);
            }
        }
    }
    if !failed.is_empty() {
        if source.is_some() {
            return Err(failed.remove(0).1);
        }
        return Err(CommandError::new("err.logClearPartial")
            .with("count", cleared.to_string())
            .with("sources", failed.into_iter().map(|(name, _)| name).collect::<Vec<_>>().join(", ")));
    }
    Ok(cleared)
}

#[tauri::command]
pub async fn clear_logs(source: Option<String>, custom_path: Option<String>) -> Result<usize, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = resolve_installation(custom_path.as_deref())?;
        let mut panel = NativeLogPanel { root: &root, running_modules: None };
        clear_logs_with_panel(&root, source.as_deref(), &mut panel)
    })
    .await
    .map_err(|error| CommandError::new("err.ioFailed").with("detail", error.to_string()))?
}

#[tauri::command]
pub fn read_log_tail(
    source: String,
    max_lines: usize,
    custom_path: Option<String>,
) -> Result<Vec<String>, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let logs_root = logs_directory(&root)?;
    let path = log_path(&logs_root, &source)?;

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

    #[test]
    fn module_recovery_only_starts_explicitly_disabled_modules() {
        let module = |name: &str, enabled: Option<bool>, handle: i64| {
            serde_json::json!({
                "key": name,
                "value": { "_children": [
                    { "key": "enabled", "value": { "_value": enabled } },
                    { "key": "handle", "value": { "_value": handle } }
                ] }
            })
        };
        let snapshot = serde_json::json!({ "_children": [
            module("Apache", Some(true), -1),
            module("Nginx", Some(true), 100),
            module("PHP-8.3", Some(false), -1),
            module("Unknown", None, -1),
            module("Other", Some(false), -1)
        ] });
        let expected = ["Apache", "Nginx", "PHP-8.3", "Unknown", "Missing"].map(str::to_string);
        assert_eq!(log_modules_to_restore(&snapshot, &expected), ["PHP-8.3"]);
        // Enabled modules may still be warming up; a missing handle is not a disabled state.
        assert_eq!(
            services_from_json(&snapshot).iter().find(|service| service.name == "Apache").unwrap().status,
            "warning"
        );
    }

    struct TestPanel<P, R> {
        pause: P,
        resume: R,
    }

    impl<P, R> LogPanel for TestPanel<P, R>
    where
        P: FnMut() -> Result<bool, CommandError>,
        R: FnMut() -> Result<(), CommandError>,
    {
        fn pause(&mut self) -> Result<bool, CommandError> {
            (self.pause)()
        }
        fn resume(&mut self) -> Result<(), CommandError> {
            (self.resume)()
        }
    }

    fn clear_logs_in(root: &Path, source: Option<&str>) -> Result<usize, CommandError> {
        clear_logs_with_panel(root, source, &mut TestPanel { pause: || Ok(false), resume: || Ok(()) })
    }

    #[test]
    fn writable_logs_do_not_restart_the_panel() {
        let fixture = LogFixture::new();
        let mut panel = TestPanel {
            pause: || panic!("writable logs must not pause the panel"),
            resume: || panic!("writable logs must not start the panel"),
        };
        assert_eq!(clear_logs_with_panel(&fixture.0, Some("general.log"), &mut panel).unwrap(), 1);
    }

    #[test]
    #[cfg(windows)]
    fn locked_log_is_cleared_between_automatic_stop_and_start() {
        use std::cell::RefCell;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let mut locked = Some(
            fs::OpenOptions::new().read(true).share_mode(0).open(fixture.0.join("logs/general.log")).unwrap(),
        );
        let events = RefCell::new(Vec::new());
        let mut panel = TestPanel {
            pause: || {
                events.borrow_mut().push("stop");
                drop(locked.take());
                Ok(true)
            },
            resume: || {
                assert_eq!(fs::metadata(fixture.0.join("logs/general.log")).unwrap().len(), 0);
                assert_eq!(fs::read_to_string(fixture.0.join("logs/Apache.LOG")).unwrap(), "module events\n");
                events.borrow_mut().push("start");
                Ok(())
            },
        };
        assert_eq!(clear_logs_with_panel(&fixture.0, Some("general.log"), &mut panel).unwrap(), 1);
        assert_eq!(*events.borrow(), ["stop", "start"]);
    }

    #[test]
    #[cfg(windows)]
    fn bulk_cleanup_restarts_once_for_multiple_locked_logs() {
        use std::cell::Cell;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let mut locked: Vec<_> = ["general.log", "domains/shop.local_error.log"]
            .into_iter()
            .map(|name| {
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(fixture.0.join("logs").join(name))
                    .unwrap()
            })
            .collect();
        let stops = Cell::new(0);
        let starts = Cell::new(0);
        let mut panel = TestPanel {
            pause: || {
                stops.set(stops.get() + 1);
                locked.clear();
                Ok(true)
            },
            resume: || {
                starts.set(starts.get() + 1);
                Ok(())
            },
        };
        assert_eq!(clear_logs_with_panel(&fixture.0, None, &mut panel).unwrap(), 3);
        assert_eq!((stops.get(), starts.get()), (1, 1));
    }

    #[test]
    #[cfg(windows)]
    fn panel_is_restarted_even_when_cleanup_fails_after_shutdown() {
        use std::cell::Cell;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let log = fixture.0.join("logs/general.log");
        let mut locked = Some(fs::OpenOptions::new().read(true).share_mode(0).open(&log).unwrap());
        let restored = Cell::new(false);
        let protected = fixture.0.join("protected.log");
        fs::write(&protected, "keep").unwrap();
        let mut panel = TestPanel {
            pause: || {
                drop(locked.take());
                fs::remove_file(&log).unwrap();
                fs::hard_link(&protected, &log).unwrap();
                Ok(true)
            },
            resume: || {
                restored.set(true);
                Ok(())
            },
        };
        assert_eq!(
            clear_logs_with_panel(&fixture.0, Some("general.log"), &mut panel).unwrap_err().code,
            "err.logClearFailed"
        );
        assert!(restored.get());
        assert_eq!(fs::read_to_string(protected).unwrap(), "keep");
    }

    #[test]
    #[cfg(windows)]
    fn a_failed_shutdown_still_attempts_panel_recovery() {
        use std::cell::Cell;
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let locked =
            fs::OpenOptions::new().read(true).share_mode(0).open(fixture.0.join("logs/general.log")).unwrap();
        let restored = Cell::new(false);
        let mut panel = TestPanel {
            pause: || Err(CommandError::new("err.logPanelStopFailed").with("detail", "test")),
            resume: || {
                restored.set(true);
                Ok(())
            },
        };
        assert_eq!(
            clear_logs_with_panel(&fixture.0, Some("general.log"), &mut panel).unwrap_err().code,
            "err.logPanelStopFailed"
        );
        assert!(restored.get());
        drop(locked);
    }

    #[test]
    #[cfg(windows)]
    fn failed_panel_recovery_is_reported_instead_of_cleanup_success() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let mut locked = Some(
            fs::OpenOptions::new().read(true).share_mode(0).open(fixture.0.join("logs/general.log")).unwrap(),
        );
        let mut panel = TestPanel {
            pause: || {
                drop(locked.take());
                Ok(true)
            },
            resume: || Err(CommandError::new("err.logPanelResumeFailed").with("detail", "test")),
        };
        assert_eq!(
            clear_logs_with_panel(&fixture.0, Some("general.log"), &mut panel).unwrap_err().code,
            "err.logPanelResumeFailed"
        );
        assert_eq!(fs::metadata(fixture.0.join("logs/general.log")).unwrap().len(), 0);
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_LOG_CLEANUP_TEST_ROOT; restarts that installation and clears general.log"]
    fn installed_general_log_cleanup_restores_the_panel_and_running_modules() {
        let root = PathBuf::from(
            std::env::var_os("OSP_CONTROL_LOG_CLEANUP_TEST_ROOT")
                .expect("explicit test installation required"),
        );
        let before = api_json(&root, "/getmodules").expect("test panel must be running");
        let expected: Vec<_> = services_from_json(&before)
            .into_iter()
            .filter(|service| service.status == "running")
            .map(|service| service.name)
            .collect();
        if let Some(report) = std::env::var_os("OSP_CONTROL_LOG_CLEANUP_TEST_REPORT") {
            fs::write(PathBuf::from(report), serde_json::to_string_pretty(&expected).unwrap()).unwrap();
        }
        let mut panel = NativeLogPanel { root: &root, running_modules: None };
        assert_eq!(clear_logs_with_panel(&root, Some("general.log"), &mut panel).unwrap(), 1);
        assert!(panel.running_modules.is_some(), "the installed log must exercise automatic restart");
        let after = api_json(&root, "/getmodules").expect("panel API must recover");
        let actual = services_from_json(&after);
        for name in expected {
            assert!(
                actual.iter().any(|service| service.name == name && service.status == "running"),
                "module {name} must recover"
            );
        }
        assert!(root.join("logs/general.log").is_file());
        let log =
            read_log_tail("general.log".into(), 2000, Some(root.to_string_lossy().into_owned())).unwrap();
        assert!(
            !log.iter().any(|line| line.contains("Включение невозможно (модуль уже включён)")),
            "module recovery must not issue duplicate enable commands"
        );
    }

    struct LogFixture(PathBuf);

    impl LogFixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "osp-log-cleanup-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("logs/domains")).unwrap();
            fs::write(root.join("logs/general.log"), "panel events\n").unwrap();
            fs::write(root.join("logs/Apache.LOG"), "module events\n").unwrap();
            fs::write(root.join("logs/domains/shop.local_error.log"), "domain events\n").unwrap();
            Self(root)
        }
    }

    impl Drop for LogFixture {
        fn drop(&mut self) {
            let canonical = fs::canonicalize(&self.0).unwrap();
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert!(canonical.starts_with(&temp) && canonical != temp);
            assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("osp-log-cleanup-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn clears_only_the_selected_log_and_keeps_it_writable() {
        use std::io::Write;
        let fixture = LogFixture::new();
        let path = fixture.0.join("logs/general.log");
        // An active writer can keep its handle while the contents are truncated.
        let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
        assert_eq!(clear_logs_in(&fixture.0, Some("general.log")).unwrap(), 1);
        assert!(path.is_file());
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(fs::read_to_string(fixture.0.join("logs/Apache.LOG")).unwrap(), "module events\n");
        assert_eq!(
            fs::read_to_string(fixture.0.join("logs/domains/shop.local_error.log")).unwrap(),
            "domain events\n"
        );
        writer.write_all(b"new event\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new event\n");
    }

    #[test]
    fn bulk_clear_includes_domain_logs_and_preserves_other_files() {
        let fixture = LogFixture::new();
        fs::write(fixture.0.join("logs/settings.ini"), "keep").unwrap();
        fs::create_dir_all(fixture.0.join("logs/archive.log")).unwrap();
        assert_eq!(clear_logs_in(&fixture.0, None).unwrap(), 3);
        assert_eq!(scan_log_sources(&logs_directory(&fixture.0).unwrap()).unwrap().len(), 3);
        for name in ["general.log", "Apache.LOG", "domains/shop.local_error.log"] {
            assert_eq!(fs::metadata(fixture.0.join("logs").join(name)).unwrap().len(), 0);
        }
        assert_eq!(fs::read_to_string(fixture.0.join("logs/settings.ini")).unwrap(), "keep");
        assert!(fixture.0.join("logs/archive.log").is_dir());
    }

    #[test]
    fn clear_rejects_traversal_unlisted_folders_and_non_logs() {
        let fixture = LogFixture::new();
        fs::write(fixture.0.join("logs/settings.ini"), "keep").unwrap();
        for source in [
            "",
            "../general.log",
            "/general.log",
            r"domains\shop.local_error.log",
            "domains/../general.log",
            "domains//general.log",
            "general.log:stream",
            "settings.ini",
            "archive/history.log",
            "domains/",
            "C:/general.log",
        ] {
            assert_eq!(clear_logs_in(&fixture.0, Some(source)).unwrap_err().code, "err.invalidLogName");
        }
        assert_eq!(clear_logs_in(&fixture.0, Some("missing.log")).unwrap_err().code, "err.logNotFound");
        assert_eq!(fs::read_to_string(fixture.0.join("logs/general.log")).unwrap(), "panel events\n");
        assert_eq!(fs::read_to_string(fixture.0.join("logs/settings.ini")).unwrap(), "keep");
    }

    #[test]
    #[cfg(windows)]
    fn bulk_clear_reports_locked_files_and_continues_with_the_others() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = LogFixture::new();
        let locked =
            fs::OpenOptions::new().read(true).share_mode(0).open(fixture.0.join("logs/general.log")).unwrap();
        let error = clear_logs_in(&fixture.0, Some("general.log")).unwrap_err();
        assert_eq!(error.code, "err.logLocked");
        assert_eq!(error.params["source"], "general.log");
        let error = clear_logs_in(&fixture.0, None).unwrap_err();
        assert_eq!(error.code, "err.logClearPartial");
        assert_eq!(error.params["count"], "2");
        assert_eq!(error.params["sources"], "general.log");
        drop(locked);
        assert_eq!(fs::read_to_string(fixture.0.join("logs/general.log")).unwrap(), "panel events\n");
        assert_eq!(fs::metadata(fixture.0.join("logs/Apache.LOG")).unwrap().len(), 0);
        assert_eq!(fs::metadata(fixture.0.join("logs/domains/shop.local_error.log")).unwrap().len(), 0);
    }

    #[test]
    fn canonical_log_paths_cannot_escape_the_logs_directory() {
        let fixture = LogFixture::new();
        let outside = fixture.0.join("protected.log");
        fs::write(&outside, "keep").unwrap();
        let link = fixture.0.join("logs/escape.log");
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&outside, &link);
        // Windows may require Developer Mode or an elevated token to create symlinks.
        if let Err(error) = result {
            if error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("cannot create test symlink: {error}");
        }
        assert_eq!(clear_logs_in(&fixture.0, Some("escape.log")).unwrap_err().code, "err.accessDenied");
        let error = clear_logs_in(&fixture.0, None).unwrap_err();
        assert_eq!(error.code, "err.logClearPartial");
        assert_eq!(error.params["sources"], "escape.log");
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
    }

    #[test]
    fn clearing_a_hard_link_does_not_modify_data_outside_logs() {
        let fixture = LogFixture::new();
        let outside = fixture.0.join("protected.log");
        fs::write(&outside, "keep").unwrap();
        fs::hard_link(&outside, fixture.0.join("logs/linked.log")).unwrap();
        let error = clear_logs_in(&fixture.0, Some("linked.log")).unwrap_err();
        assert_eq!(error.code, "err.logClearFailed");
        assert_eq!(error.params["source"], "linked.log");
        let error = clear_logs_in(&fixture.0, None).unwrap_err();
        assert_eq!(error.code, "err.logClearPartial");
        assert_eq!(error.params["sources"], "linked.log");
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
    }

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
