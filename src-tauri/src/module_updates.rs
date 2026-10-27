//! Transactional module updates. Legacy PHP journals keep their original location and shape.
use crate::{
    error::CommandError,
    module_releases::{self as releases, Kind},
    paths::{hidden_command, resolve_installation},
    update_files as files,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{Duration, Instant},
};
struct UpdateLocks {
    gate: RwLock<()>,
    modules: Mutex<Vec<PathBuf>>,
}
impl UpdateLocks {
    const fn new() -> Self {
        Self { gate: RwLock::new(()), modules: Mutex::new(Vec::new()) }
    }
    fn mutation(&self) -> Result<RwLockWriteGuard<'_, ()>, CommandError> {
        self.gate.try_write().map_err(|_| CommandError::new("err.updateBusy"))
    }
    fn module(&self, path: &Path) -> Result<ModuleGuard<'_>, CommandError> {
        let shared = self.gate.try_read().map_err(|_| CommandError::new("err.updateBusy"))?;
        let path = fs::canonicalize(path)?;
        let mut modules = self.modules.lock().map_err(|_| CommandError::new("err.updateBusy"))?;
        if modules.contains(&path) {
            return Err(CommandError::new("err.updateBusy"));
        }
        modules.push(path.clone());
        Ok(ModuleGuard { locks: self, path, _shared: shared })
    }
}
struct ModuleGuard<'a> {
    locks: &'a UpdateLocks,
    path: PathBuf,
    _shared: RwLockReadGuard<'a, ()>,
}
impl Drop for ModuleGuard<'_> {
    fn drop(&mut self) {
        self.locks.modules.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != &self.path);
    }
}
static MUTATION: UpdateLocks = UpdateLocks::new();
static WEB: Mutex<()> = Mutex::new(());
pub(crate) fn mutation() -> Result<RwLockWriteGuard<'static, ()>, CommandError> {
    MUTATION.mutation()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    name: String,
    installed: String,
    available: Option<String>,
    error: Option<String>,
    recovery: bool,
    expected: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    error_params: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    name: String,
    backup: String,
    was_running: bool,
    phase: String,
    #[serde(default)]
    manifest: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    profile: Option<crate::module_health::Profile>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    name: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    declared_version: Option<String>,
}
fn root(custom: Option<&str>) -> Result<PathBuf, CommandError> {
    if custom.is_some_and(|p| !Path::new(p).is_dir()) {
        return Err(CommandError::new("err.ospanelNotFound"));
    }
    let root = fs::canonicalize(resolve_installation(custom)?)?;
    let modules = fs::canonicalize(root.join("modules"))?;
    if modules.parent() != Some(root.as_path()) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(root)
}
fn work(root: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let mut parent = root.to_path_buf();
    for name in ["backups", if Kind::of(name)? == Kind::Php { "php-updates" } else { "module-updates" }] {
        let path = parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        // Other modules may be writing their own staging/backup trees here.
        // Validate only this shared directory; validate each owned tree before using it.
        let meta = fs::symlink_metadata(&path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(CommandError::new("err.accessDenied"));
            }
        }
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(CommandError::new("err.accessDenied"));
        }
        let canonical = fs::canonicalize(&path)?;
        if canonical.parent() != Some(parent.as_path()) {
            return Err(CommandError::new("err.accessDenied"));
        }
        parent = canonical;
    }
    Ok(parent)
}
fn journal_path(root: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = work(root, name)?.join(format!("{name}.json"));
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if !meta.is_file() {
                return Err(CommandError::new("err.accessDenied"));
            }
            files::safe_tree(&path)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(path)
}
fn save(root: &Path, j: &Journal) -> Result<(), CommandError> {
    let p = journal_path(root, &j.name)?;
    let tmp = p.with_extension("tmp");
    let bytes = serde_json::to_vec(j).map_err(|_| releases::unsupported())?;
    use std::io::Write;
    if tmp.exists() {
        fs::remove_file(&tmp)?;
    }
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(&bytes)?;
    f.sync_all()?;
    drop(f);
    // Replace atomically on Windows; interruption must not erase the recovery journal.
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW},
            core::PCWSTR,
        };
        let source: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| CommandError::new("err.updateRecovery"))?;
        }
    }
    #[cfg(not(windows))]
    fs::rename(tmp, p)?;
    Ok(())
}
fn progress(app: &tauri::AppHandle, name: &str, value: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "module-update-progress",
        Progress { name: name.into(), phase: value.into(), actual_version: None, declared_version: None },
    );
}
fn candidate_version(app: &tauri::AppHandle, name: &str, declared: &str, actual: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "module-update-progress",
        Progress {
            name: name.into(),
            phase: "preparing".into(),
            actual_version: Some(actual.into()),
            declared_version: Some(declared.into()),
        },
    );
}
fn phase(app: &tauri::AppHandle, root: &Path, j: &mut Journal, value: &str) -> Result<(), CommandError> {
    j.phase = value.into();
    save(root, j)?;
    progress(app, &j.name, value);
    Ok(())
}
fn failed(code: &str, cause: CommandError) -> CommandError {
    let mut params = cause.params;
    params.insert("cause".into(), cause.code);
    CommandError { code: code.into(), params }
}
fn rollback_failed(cause: CommandError, rollback: CommandError) -> CommandError {
    let mut error = failed("err.updateRollback", cause);
    error.params.insert("rollbackCause".into(), rollback.code);
    for (key, value) in rollback.params {
        error.params.insert(format!("rollback.{key}"), value);
    }
    error
}
fn state(root: &Path, name: &str) -> Result<bool, CommandError> {
    crate::panel_api::modules_from_api(root)
        .into_iter()
        .find(|s| s.name == name)
        .and_then(|s| match s.status.as_str() {
            "running" => Some(true),
            "stopped" => Some(false),
            _ => None,
        })
        .ok_or_else(|| CommandError::new("err.updateState"))
}
fn reach_state(
    mut reached: impl FnMut() -> Result<bool, CommandError>,
    request: impl FnOnce() -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    if reached()? {
        return Ok(());
    }
    let requested = request();
    // A concurrent stop can make the CLI return an error even though the target state was reached.
    if reached()? {
        return Ok(());
    }
    requested?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if reached()? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err(CommandError::new("err.updateState"))
}
fn command(root: &Path, name: &str, on: bool) -> Result<(), CommandError> {
    let target = files::child(&root.join("modules"), name)?;
    let cli_root = crate::paths::external_path(root);
    reach_state(
        || Ok(state(root, name).ok() == Some(on) && processes(&target)? == on),
        || {
            releases::run(
                hidden_command(cli_root.join("bin/osp.bat"))
                    .args([if on { "on" } else { "off" }, name])
                    .current_dir(&cli_root),
            )
            .map(|_| ())
        },
    )
}
#[cfg(windows)]
pub(crate) fn processes(dir: &Path) -> Result<bool, CommandError> {
    use windows::{
        Win32::{
            Foundation::CloseHandle,
            System::{
                ProcessStatus::EnumProcesses,
                Threading::{
                    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                    QueryFullProcessImageNameW,
                },
            },
        },
        core::PWSTR,
    };
    let prefix = format!(
        "{}\\",
        crate::paths::external_path(dir).to_string_lossy().trim_end_matches('\\').to_ascii_lowercase()
    );
    let mut pids = vec![0u32; 65536];
    let mut returned = 0;
    unsafe {
        EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut returned)
            .map_err(|_| CommandError::new("err.updateState"))?;
    }
    if returned as usize >= pids.len() * 4 {
        return Err(CommandError::new("err.updateState"));
    }
    for pid in &pids[..returned as usize / 4] {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, *pid) else {
                continue;
            };
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            let ok =
                QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                    .is_ok();
            let _ = CloseHandle(handle);
            if ok && String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase().starts_with(&prefix)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
#[cfg(not(windows))]
pub(crate) fn processes(_: &Path) -> Result<bool, CommandError> {
    Err(CommandError::new("err.desktopOnly"))
}

#[tauri::command]
pub async fn check_module_updates(
    custom_path: Option<String>,
    force: Option<bool>,
) -> Result<Vec<UpdateInfo>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = mutation()?;
        let root = root(custom_path.as_deref())?;
        let mut catalog = releases::Catalog::new(force.unwrap_or(false));
        let mut out = Vec::new();
        for entry in fs::read_dir(root.join("modules"))? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let Ok(kind) = Kind::of(&name) else {
                continue;
            };
            let mut installed = String::new();
            let check = (|| {
                let dir = files::child(&root.join("modules"), &name)?;
                let b = releases::identify(kind, &dir)?;
                installed = releases::installed_version(kind, &dir, &b)?;
                catalog.select(&name, &b, &dir)
            })();
            let recovery = journal_path(&root, &name)?.exists();
            out.push(match check {
                Ok(release) => UpdateInfo {
                    name,
                    installed,
                    available: release.as_ref().map(|r| r.display.clone()),
                    expected: release.map(|r| r.identity),
                    error: None,
                    recovery,
                    error_params: Default::default(),
                },
                Err(e) => UpdateInfo {
                    name,
                    installed,
                    available: None,
                    expected: None,
                    error: Some(e.code),
                    recovery,
                    error_params: e.params,
                },
            });
        }
        Ok(out)
    })
    .await
    .map_err(|_| releases::unsupported())?
}

fn rollback(root: &Path, dir: &Path, j: &Journal) -> Result<(), CommandError> {
    let kind = Kind::of(&j.name)?;
    let source = files::child(&work(root, &j.name)?, &j.backup)?;
    files::validate_backup(&source, &j.manifest, kind.executable())?;
    command(root, &j.name, false)?;
    files::exact_restore(&source, dir)?;
    files::validate_backup(dir, &j.manifest, kind.executable())?;
    if j.was_running {
        let logs = crate::module_health::capture(root, &j.name, j.profile.as_ref())?;
        command(root, &j.name, true)?;
        crate::module_health::verify(root, &j.name, &logs)?;
    }
    fs::remove_file(journal_path(root, &j.name)?)?;
    Ok(())
}
#[tauri::command]
pub async fn install_module_update(
    app: tauri::AppHandle,
    name: String,
    expected: String,
    custom_path: Option<String>,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = Kind::of(&name)?;
        let _web = if kind == Kind::Php {
            None
        } else {
            Some(WEB.try_lock().map_err(|_| CommandError::new("err.updateBusy"))?)
        };
        let root = root(custom_path.as_deref())?;
        let _guard = MUTATION.module(&root.join("modules").join(&name))?;
        let dir = files::child(&root.join("modules"), &name)?;
        if journal_path(&root, &name)?.exists() {
            return Err(CommandError::new("err.updateRecovery"));
        }
        progress(&app, &name, "preparing");
        let b = releases::identify(kind, &dir)?;
        let mut release =
            releases::Catalog::new(true).select(&name, &b, &dir)?.ok_or_else(releases::unsupported)?;
        if release.identity != expected {
            return Err(CommandError::new("err.updateChanged"));
        }
        let stamp =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let backup = format!("{name}-{stamp}");
        let backup_dir = work(&root, &name)?.join(&backup);
        let zip = work(&root, &name)?.join(format!("{name}-{stamp}.zip"));
        let staging = work(&root, &name)?.join(format!("stage-{name}-{stamp}"));
        let result = (|| {
            // Network and archive failures must leave the running module untouched.
            progress(&app, &name, "download");
            releases::download(&release, &zip)?;
            files::extract(&zip, &staging)?;
            let payload = releases::payload(kind, &staging)?;
            let fresh = releases::validate_candidate(kind, &payload, &b, &release)?;
            if kind != Kind::Php && fresh.version != release.version {
                candidate_version(&app, &name, &release.version, &fresh.version);
                release.version = fresh.version.clone();
                release.display = release.version.clone();
            }
            if kind == Kind::Caddy {
                crate::module_health::compatible(&dir, &payload)?;
            }
            let profile =
                if kind == Kind::Php { None } else { Some(crate::module_health::profile(&root, &name)?) };
            let was_running = state(&root, &name)?;
            let mut j = Journal {
                name: name.clone(),
                backup,
                was_running,
                phase: "stopping".into(),
                manifest: Default::default(),
                profile,
            };
            phase(&app, &root, &mut j, "stopping")?;
            let mut changed = false;
            let mut backed_up = false;
            let result = (|| {
                command(&root, &name, false)?;
                phase(&app, &root, &mut j, "backup")?;
                j.manifest = files::manifest(&dir)?;
                fs::create_dir(&backup_dir)?;
                files::overlay(&dir, &backup_dir)?;
                files::validate_backup(&backup_dir, &j.manifest, kind.executable())?;
                backed_up = true;
                phase(&app, &root, &mut j, "install")?;
                changed = true;
                releases::install_files(kind, &payload, &dir)?;
                files::update_metadata(&dir, &release.version)?;
                releases::save_receipt(&dir, &release)?;
                let logs = crate::module_health::capture(&root, &name, j.profile.as_ref())?;
                phase(&app, &root, &mut j, "verify")?;
                if let Some(profile) = &j.profile {
                    crate::module_health::configuration(kind, &dir, profile, &staging)?;
                }
                // Stopped HTTP servers must never be started just to test an update.
                if was_running || kind == Kind::Php {
                    command(&root, &name, true)?;
                    crate::module_health::verify(&root, &name, &logs)?;
                    if !was_running {
                        command(&root, &name, false)?;
                    }
                }
                if releases::identify(kind, &dir)?.version != fresh.version {
                    return Err(releases::unsupported());
                }
                fs::remove_file(journal_path(&root, &name)?)?;
                Ok(release.version.clone())
            })();
            if let Err(e) = result {
                let recovered = if changed && backed_up {
                    let _ = phase(&app, &root, &mut j, "rollback");
                    rollback(&root, &dir, &j)
                } else {
                    if was_running { command(&root, &name, true) } else { command(&root, &name, false) }
                };
                if let Err(rollback) = recovered {
                    return Err(rollback_failed(e, rollback));
                }
                let _ = fs::remove_file(journal_path(&root, &name)?);
                return Err(failed("err.updateFailed", e));
            }
            result
        })();
        // Temporary downloads are never needed for recovery; the verified backup is retained.
        let _ = fs::remove_file(&zip);
        if files::safe_tree(&staging).is_ok()
            && fs::canonicalize(&staging).ok().and_then(|p| p.parent().map(Path::to_path_buf))
                == Some(work(&root, &name)?)
        {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    })
    .await
    .map_err(|_| releases::unsupported())?
}
#[tauri::command]
pub async fn recover_module_update(
    name: String,
    custom_path: Option<String>,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = Kind::of(&name)?;
        let _web = if kind == Kind::Php {
            None
        } else {
            Some(WEB.try_lock().map_err(|_| CommandError::new("err.updateBusy"))?)
        };
        let root = root(custom_path.as_deref())?;
        let _guard = MUTATION.module(&root.join("modules").join(&name))?;
        let dir = files::child(&root.join("modules"), &name)?;
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(journal_path(&root, &name)?)?.take(16_000_001).read_to_end(&mut bytes)?;
        if bytes.len() > 16_000_000 {
            return Err(releases::unsupported());
        }
        let j: Journal = serde_json::from_slice(&bytes).map_err(|_| releases::unsupported())?;
        if j.name != name
            || !j.backup.starts_with(&format!("{name}-"))
            || !crate::paths::is_valid_module_name(&j.backup)
            || !["stopping", "backup", "install", "verify", "rollback"].contains(&j.phase.as_str())
        {
            return Err(releases::unsupported());
        }
        if ["install", "verify", "rollback"].contains(&j.phase.as_str()) {
            rollback(&root, &dir, &j)
        } else {
            command(&root, &name, j.was_running)?;
            fs::remove_file(journal_path(&root, &name)?)?;
            Ok(())
        }?;
        releases::installed_version(kind, &dir, &releases::identify(kind, &dir)?)
    })
    .await
    .map_err(|_| releases::unsupported())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_already_stopped_module_does_not_receive_a_second_stop_request() {
        reach_state(|| Ok(true), || panic!("The CLI must not run for a module already in the target state"))
            .unwrap();
    }
    #[test]
    fn a_cli_error_is_accepted_only_when_the_actual_target_state_is_confirmed() {
        let reached = std::cell::Cell::new(false);
        reach_state(
            || Ok(reached.get()),
            || {
                reached.set(true);
                Err(CommandError::new("err.updateProbe"))
            },
        )
        .unwrap();
        let error = reach_state(
            || Ok(false),
            || Err(CommandError::new("err.updateProbe").with("detail", "stop failed")),
        )
        .unwrap_err();
        assert_eq!(error.code, "err.updateProbe");
        assert_eq!(error.params["detail"], "stop failed");
    }
    #[test]
    fn rollback_failure_preserves_both_errors_without_overwriting_their_details() {
        let error = rollback_failed(
            CommandError::new("err.updateConfig").with("detail", "invalid config"),
            CommandError::new("err.updateProbe").with("detail", "stop failed"),
        );
        assert_eq!(error.params["cause"], "err.updateConfig");
        assert_eq!(error.params["detail"], "invalid config");
        assert_eq!(error.params["rollbackCause"], "err.updateProbe");
        assert_eq!(error.params["rollback.detail"], "stop failed");
    }

    #[test]
    fn legacy_php_journals_remain_readable_and_keep_the_original_workspace() {
        let journal: Journal = serde_json::from_str(
            r#"{"name":"PHP-8.4","backup":"PHP-8.4-123","wasRunning":false,"phase":"backup","manifest":{}}"#,
        )
        .unwrap();
        assert!(journal.profile.is_none());
        assert!(!journal.was_running);
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("osp-legacy-journal-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        save(&root, &journal).unwrap();
        assert!(root.join("backups/php-updates/PHP-8.4.json").is_file());
        assert!(work(&root, "Apache").unwrap().ends_with("backups/module-updates"));
        let mut next = journal;
        next.phase = "install".into();
        save(&root, &next).unwrap();
        let saved: Journal =
            serde_json::from_slice(&fs::read(journal_path(&root, &next.name).unwrap()).unwrap()).unwrap();
        assert_eq!(saved.phase, "install");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn separate_modules_can_update_while_duplicate_and_global_mutations_are_blocked() {
        let locks = UpdateLocks::new();
        let first = locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let second = locks.module(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path()).unwrap();
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
        assert!(locks.mutation().is_err());
        drop(first);
        assert!(locks.mutation().is_err());
        // Releasing one module does not release another module's lock.
        let first = locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        drop(second);
        assert!(locks.mutation().is_err());
        drop(first);
        let exclusive = locks.mutation().unwrap();
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
        drop(exclusive);
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_ok());
    }

    #[test]
    fn concurrent_threads_hold_independent_module_locks_and_release_them_on_error() {
        let locks = UpdateLocks::new();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let attempt = || -> Result<(), CommandError> {
                    let _guard = locks.module(Path::new(env!("CARGO_MANIFEST_DIR")))?;
                    barrier.wait();
                    barrier.wait();
                    Err(CommandError::new("err.updateFailed"))
                };
                assert!(attempt().is_err());
            });
            let _guard = locks.module(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).unwrap();
            barrier.wait();
            assert!(locks.mutation().is_err());
            assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
            barrier.wait();
            worker.join().unwrap();
            assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_ok());
        });
        assert!(locks.mutation().is_ok());
    }

    #[test]
    fn concurrent_updates_create_the_shared_workspace_without_directory_races() {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = temp.join(format!("osp-php-concurrent-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for id in 0..4 {
                let root = &root;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..20 {
                        let work = work(root, "PHP-8.4").unwrap();
                        let staging = work.join(format!("stage-PHP-{id}"));
                        fs::create_dir(&staging).unwrap();
                        fs::write(staging.join("file"), b"module data").unwrap();
                        assert_eq!(
                            fs::canonicalize(work).unwrap().parent(),
                            Some(root.join("backups").as_path())
                        );
                        fs::remove_file(staging.join("file")).unwrap();
                        fs::remove_dir(staging).unwrap();
                    }
                });
            }
        });
        assert_eq!(root.parent(), Some(temp.as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_failure_keeps_the_underlying_error_code_and_details() {
        for code in ["err.updateFailed", "err.updateRollback"] {
            let error =
                failed(code, CommandError::new("err.updateNetwork").with("detail", "Connection timed out"));
            assert_eq!(error.code, code);
            assert_eq!(error.params.get("cause").map(String::as_str), Some("err.updateNetwork"));
            assert_eq!(error.params.get("detail").map(String::as_str), Some("Connection timed out"));
        }
    }
}
