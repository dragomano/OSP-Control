//! The same executable runs this mode before creating a webview or tray.
use crate::{app_updates::Handoff, error::CommandError, update_files};
use std::{fs, path::Path, process::Command, time::Duration};
fn invalid() -> CommandError {
    CommandError::new("err.appUpdateHandoff")
}

#[cfg(windows)]
fn wait_parent(pid: u32, stage: &Path) -> Result<(), CommandError> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    // Holding the handle prevents PID reuse while waiting. Failure never authorizes replacement.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, false, pid).map_err(|_| invalid())?;
        fs::write(stage.join("ready"), b"ready")?;
        let result = WaitForSingleObject(handle, 60_000);
        let _ = CloseHandle(handle);
        if result.0 != 0 {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn wait_parent(_: u32, _: &Path) -> Result<(), CommandError> {
    Err(invalid())
}

fn rename_retry(from: &Path, to: &Path) -> Result<(), CommandError> {
    for _ in 0..100 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    fs::rename(from, to).map_err(Into::into)
}

/// A verified snapshot is retained independently of staging and never rotated automatically.
fn snapshot(target: &Path, stage: &Path) -> Result<(), CommandError> {
    let parent = target.parent().ok_or_else(invalid)?;
    let locales = parent.join("locales");
    if locales.exists() {
        update_files::safe_tree(&locales)?;
        if !locales.is_dir() {
            return Err(invalid());
        }
    }
    let backups = parent.join(".osp-control-backups");
    if !backups.exists() {
        fs::create_dir(&backups)?;
    }
    update_files::safe_tree(&backups)?;
    let nonce =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| invalid())?.as_nanos();
    let backup = backups.join(format!("{nonce}-{}", std::process::id()));
    fs::create_dir(&backup)?;
    let result = (|| {
        // Copy and verify the complete backup before moving any installed file.
        fs::copy(target, backup.join("osp-control.exe"))?;
        if locales.exists() {
            fs::create_dir(backup.join("locales"))?;
            update_files::overlay(&locales, &backup.join("locales"))?;
            if update_files::manifest(&locales)? != update_files::manifest(&backup.join("locales"))? {
                return Err(invalid());
            }
        } else {
            fs::write(backup.join("no-locales"), b"The previous installation had no locales directory.")?;
        }
        use sha2::{Digest, Sha256};
        if Sha256::digest(fs::read(target)?) != Sha256::digest(fs::read(backup.join("osp-control.exe"))?) {
            return Err(invalid());
        }
        fs::write(stage.join("backup-path.txt"), backup.to_string_lossy().as_bytes())?;
        fs::write(backup.join("complete"), b"Backup verified before installation")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(backup);
    }
    result
}

struct Replacement<'a> {
    target: &'a Path,
    stage: &'a Path,
    payload: &'a Path,
    old_exe: bool,
    old_locales: bool,
    new_exe: bool,
    new_locales: bool,
}
impl<'a> Replacement<'a> {
    fn new(target: &'a Path, stage: &'a Path, payload: &'a Path) -> Self {
        Self {
            target,
            stage,
            payload,
            old_exe: false,
            old_locales: false,
            new_exe: false,
            new_locales: false,
        }
    }

    fn install(
        &mut self,
        mut move_file: impl FnMut(&Path, &Path) -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        let locales = self.target.parent().ok_or_else(invalid)?.join("locales");
        move_file(self.target, &self.stage.join("previous.exe"))?;
        self.old_exe = true;
        if locales.exists() {
            move_file(&locales, &self.stage.join("previous-locales"))?;
            self.old_locales = true;
        }
        move_file(&self.payload.join("osp-control.exe"), self.target)?;
        self.new_exe = true;
        move_file(&self.payload.join("locales"), &locales)?;
        self.new_locales = true;
        Ok(())
    }

    fn rollback(&self) -> Result<(), CommandError> {
        self.rollback_with(rename_retry)
    }

    fn rollback_with(
        &self,
        mut move_file: impl FnMut(&Path, &Path) -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        let locales = self.target.parent().ok_or_else(invalid)?.join("locales");
        let restore_locales = (|| {
            if self.new_locales {
                move_file(&locales, &self.stage.join("failed-locales"))?;
            }
            if self.old_locales {
                move_file(&self.stage.join("previous-locales"), &locales)?;
            }
            Ok(())
        })();
        // An inaccessible dictionary must not prevent recovery of the executable.
        // Neither failure permits a restart or a successful-rollback marker.
        let restore_exe = (|| {
            if self.new_exe {
                move_file(self.target, &self.stage.join("failed.exe"))?;
            }
            if self.old_exe {
                move_file(&self.stage.join("previous.exe"), self.target)?;
            }
            Ok(())
        })();
        restore_locales.and(restore_exe)
    }
}

pub(crate) fn run() -> Result<(), CommandError> {
    let exe = fs::canonicalize(std::env::current_exe()?)?;
    let stage = exe.parent().ok_or_else(invalid)?;
    if exe.file_name().is_none_or(|n| n != "helper.exe")
        || stage.file_name().is_none_or(|n| n != ".osp-control-update")
    {
        return Err(invalid());
    }
    update_files::safe_tree(stage)?;
    let handoff: Handoff =
        serde_json::from_slice(&fs::read(stage.join("handoff.json"))?).map_err(|_| invalid())?;
    let target = fs::canonicalize(&handoff.target)?;
    if target.parent() != stage.parent() || target != handoff.target || handoff.parent == std::process::id() {
        return Err(invalid());
    }
    let payload = fs::canonicalize(&handoff.payload)?;
    if !payload.starts_with(fs::canonicalize(stage.join("unpacked"))?) {
        return Err(invalid());
    }
    update_files::safe_tree(&payload)?;
    wait_parent(handoff.parent, stage)?;
    if let Err(error) = snapshot(&target, stage) {
        let _ = Command::new(&target).spawn();
        return Err(error);
    }
    let mut replacement = Replacement::new(&target, stage, &payload);
    if let Err(error) = replacement.install(rename_retry) {
        replacement.rollback()?;
        fs::write(stage.join("rolled-back"), b"rollback")?;
        let _ = Command::new(&target).spawn();
        return Err(error);
    }
    let launched = Command::new(&target).arg("--app-update-confirm").spawn();
    match launched {
        Ok(mut child) => {
            for _ in 0..600 {
                if stage.join("confirmed").is_file() {
                    return Ok(());
                }
                if !matches!(child.try_wait(), Ok(None)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // A failed startup must release its exe before rollback.
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(_) => {}
    }
    replacement.rollback()?;
    fs::write(stage.join("rolled-back"), b"rollback")?;
    Command::new(&target).spawn()?;
    Err(invalid())
}

/// Called only once the new webview has mounted and invoked its startup command.
pub(crate) fn acknowledge() -> Result<Option<String>, CommandError> {
    let exe = fs::canonicalize(std::env::current_exe()?)?;
    let stage = exe.parent().ok_or_else(invalid)?.join(".osp-control-update");
    if !stage.exists() {
        return Ok(None);
    }
    update_files::safe_tree(&stage)?;
    let handoff: Handoff =
        match fs::read(stage.join("handoff.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(handoff) => handoff,
            None => return Ok(Some("interrupted".into())),
        };
    if handoff.target != exe {
        return Err(invalid());
    }
    let confirming = std::env::args().nth(1).as_deref() == Some("--app-update-confirm");
    let result = if confirming {
        fs::write(stage.join("confirmed"), b"ok")?;
        Some("updated".to_string())
    } else if stage.join("rolled-back").exists() {
        Some("rollback".to_string())
    } else {
        return Ok(Some("interrupted".into()));
    };
    // The helper is still running briefly. Cleanup is bounded and never touches the application tree.
    std::thread::spawn(move || {
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(200));
            // Never remove the confirmation marker until the helper has released its executable.
            let removed = match fs::remove_file(stage.join("helper.exe")) {
                Ok(()) => true,
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
            if removed && fs::remove_dir_all(&stage).is_ok() {
                break;
            }
        }
    });
    Ok(result)
}

#[tauri::command]
pub(crate) fn app_update_startup() -> Result<Option<String>, CommandError> {
    acknowledge()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(label: &str, locales: bool) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("osp-handoff-{label}-{}-{nonce}", std::process::id()));
        let stage = root.join(".osp-control-update");
        let payload = stage.join("unpacked");
        fs::create_dir_all(payload.join("locales")).unwrap();
        let target = root.join("osp-control.exe");
        fs::write(&target, b"old exe").unwrap();
        fs::write(root.join("settings.ini"), b"user settings").unwrap();
        if locales {
            fs::create_dir(root.join("locales")).unwrap();
            fs::write(root.join("locales/ru.json"), b"custom translation").unwrap();
            fs::write(root.join("locales/de.json"), b"custom language").unwrap();
        }
        fs::write(payload.join("osp-control.exe"), b"new exe").unwrap();
        fs::write(payload.join("locales/ru.json"), b"new translation").unwrap();
        (root, target, stage, payload)
    }

    #[test]
    fn replacement_is_exact_and_snapshot_survives_staging_cleanup_and_next_update() {
        let (root, target, stage, payload) = fixture("success", true);
        snapshot(&target, &stage).unwrap();
        let backup = PathBuf::from(fs::read_to_string(stage.join("backup-path.txt")).unwrap());
        let mut transaction = Replacement::new(&target, &stage, &payload);
        transaction.install(|a, b| fs::rename(a, b).map_err(Into::into)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new exe");
        assert_eq!(fs::read(root.join("locales/ru.json")).unwrap(), b"new translation");
        assert!(!root.join("locales/de.json").exists());
        fs::remove_dir_all(&stage).unwrap();
        assert_eq!(fs::read(backup.join("osp-control.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(backup.join("locales/ru.json")).unwrap(), b"custom translation");
        assert_eq!(fs::read(backup.join("locales/de.json")).unwrap(), b"custom language");
        assert!(backup.join("complete").is_file());
        fs::create_dir(&stage).unwrap();
        snapshot(&target, &stage).unwrap();
        assert_eq!(fs::read_dir(root.join(".osp-control-backups")).unwrap().count(), 2);
        assert_eq!(fs::read(backup.join("osp-control.exe")).unwrap(), b"old exe");
        assert_eq!(fs::read(root.join("settings.ini")).unwrap(), b"user settings");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_failed_move_and_failed_startup_restore_the_original_pair() {
        for had_locales in [false, true] {
            let count = if had_locales { 4 } else { 3 };
            // The last iteration represents a fully installed release that failed startup.
            for fail_at in 0..=count {
                let (root, target, stage, payload) = fixture("rollback", had_locales);
                snapshot(&target, &stage).unwrap();
                let mut transaction = Replacement::new(&target, &stage, &payload);
                let mut step = 0;
                let result = transaction.install(|a, b| {
                    let current = step;
                    step += 1;
                    if current == fail_at {
                        return Err(invalid());
                    }
                    fs::rename(a, b).map_err(Into::into)
                });
                assert_eq!(result.is_ok(), fail_at == count);
                transaction.rollback().unwrap();
                assert_eq!(fs::read(&target).unwrap(), b"old exe");
                assert_eq!(root.join("locales").exists(), had_locales);
                if had_locales {
                    assert_eq!(fs::read(root.join("locales/ru.json")).unwrap(), b"custom translation");
                    assert_eq!(fs::read(root.join("locales/de.json")).unwrap(), b"custom language");
                }
                assert_eq!(fs::read(root.join("settings.ini")).unwrap(), b"user settings");
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn failed_locales_rollback_still_recovers_exe_and_preserves_backups() {
        for fail_at in [0, 1] {
            let (root, target, stage, payload) = fixture("rollback-failure", true);
            snapshot(&target, &stage).unwrap();
            let backup = PathBuf::from(fs::read_to_string(stage.join("backup-path.txt")).unwrap());
            let mut transaction = Replacement::new(&target, &stage, &payload);
            transaction.install(|a, b| fs::rename(a, b).map_err(Into::into)).unwrap();
            let mut step = 0;
            assert!(transaction.rollback_with(|a, b| {
                let current = step;
                step += 1;
                if current == fail_at {
                    return Err(invalid());
                }
                fs::rename(a, b).map_err(Into::into)
            }).is_err());
            assert_eq!(fs::read(target).unwrap(), b"old exe");
            assert_eq!(fs::read(backup.join("locales/ru.json")).unwrap(), b"custom translation");
            assert!(stage.join("previous-locales").exists());
            assert!(!stage.join("rolled-back").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn backup_failure_leaves_installed_files_untouched() {
        let (root, target, stage, _) = fixture("backup-failure", true);
        fs::write(root.join(".osp-control-backups"), b"not a directory").unwrap();
        assert!(snapshot(&target, &stage).is_err());
        assert_eq!(fs::read(target).unwrap(), b"old exe");
        assert_eq!(fs::read(root.join("locales/ru.json")).unwrap(), b"custom translation");
        assert!(!stage.join("previous.exe").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
