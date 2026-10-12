//! Backups: zip archiving of configs and projects, plus list/create/restore/delete commands.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CommandError;
use crate::paths::{
    copy_dir_recursive, dir_stats, explorer_open, is_valid_domain, is_valid_module_name, modified_secs,
    resolve_installation, unix_now, within_installation,
};

// kind: "config" | "db" | "project"; subject — the module for a dump, the domain for a project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupEntry {
    pub(crate) id: String,
    pub(crate) created_at: u64,
    pub(crate) size_bytes: u64,
    pub(crate) files: u64,
    pub(crate) kind: String,
    pub(crate) subject: Option<String>,
}

pub(crate) fn backups_root(custom_path: Option<&str>) -> Result<PathBuf, CommandError> {
    let root = resolve_installation(custom_path)?;
    let backups = root.join("backups");
    fs::create_dir_all(&backups)?;
    Ok(backups)
}

// Opens the backups folder in Explorer: all dumps live in one backups/,
// so /select is unnecessary — selecting a file there is redundant.
#[tauri::command]
pub fn open_backups_folder(custom_path: Option<String>) -> Result<(), CommandError> {
    let backups = backups_root(custom_path.as_deref())?;
    let canonical = fs::canonicalize(&backups)
        .map_err(|_| CommandError::new("err.folderNotFound").with("path", backups.display().to_string()))?;
    if !within_installation(&canonical, custom_path.as_deref()) {
        return Err(CommandError::new("err.folderOutsideRoot"));
    }
    explorer_open(&canonical)
}

// --- Backups ---
// Backups are stored in backups/ as files: backup-<unix>.zip (configs),
// backup-<unix>-db-<module>.sql (DB dumps), backup-<unix>-proj-<domain>.zip
// (projects). The -auto suffix marks an automatic copy made before a restore.
// Legacy directory backups backup-<unix>/config/ are still supported (readable).

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BackupKind {
    Config,
    Db(String),
    Project(String),
}

impl BackupKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            BackupKind::Config => "config",
            BackupKind::Db(_) => "db",
            BackupKind::Project(_) => "project",
        }
    }

    pub(crate) fn subject(&self) -> Option<String> {
        match self {
            BackupKind::Config => None,
            BackupKind::Db(module) => Some(module.clone()),
            BackupKind::Project(domain) => Some(domain.clone()),
        }
    }
}

// Parsing a backup identifier: backup-<unix>[-auto][-db-<module>|-proj-<domain>].
// The module and domain are encoded in the id — the list and restore commands need
// no separate parameters and cannot diverge from the file.
pub(crate) fn parse_backup_id(id: &str) -> Option<(u64, bool, BackupKind)> {
    let rest = id.strip_prefix("backup-")?;
    let digits_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if digits_end == 0 {
        return None;
    }
    let secs: u64 = rest[..digits_end].parse().ok()?;
    let mut tail = &rest[digits_end..];
    if let Some(stripped) = tail.strip_prefix('-') {
        tail = stripped;
    } else if !tail.is_empty() {
        return None;
    }

    let mut auto = false;
    if tail == "auto" {
        auto = true;
        tail = "";
    } else if let Some(stripped) = tail.strip_prefix("auto-") {
        auto = true;
        tail = stripped;
    }

    if tail.is_empty() {
        return Some((secs, auto, BackupKind::Config));
    }
    if let Some(module) = tail.strip_prefix("db-") {
        if !is_valid_module_name(module) {
            return None;
        }
        return Some((secs, auto, BackupKind::Db(module.to_string())));
    }
    if let Some(domain) = tail.strip_prefix("proj-") {
        if !is_valid_domain(domain) {
            return None;
        }
        return Some((secs, auto, BackupKind::Project(domain.to_string())));
    }
    None
}

// Canonicalize a backup path and check that it stays inside the backups directory.
pub(crate) fn backup_target(
    path: PathBuf,
    backups_canonical: &Path,
    id: &str,
) -> Result<PathBuf, CommandError> {
    let target =
        fs::canonicalize(path).map_err(|_| CommandError::new("err.backupNotFound").with("id", id))?;
    if !target.starts_with(backups_canonical) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(target)
}

// Project folders excluded from the archive: package managers reinstall them.
const PROJECT_BACKUP_EXCLUDES: &[&str] = &["node_modules", "vendor"];

// Directory walk depth while archiving — protection against symlink/junction loops.
const ZIP_MAX_DEPTH: usize = 64;

// zip crate errors are reported the same way as ordinary I/O errors.
fn zip_error(error: zip::result::ZipError) -> CommandError {
    CommandError::new("err.ioFailed").with("detail", error.to_string())
}

// Packing a directory into a zip: all entries live under top/ (on restore the first
// path component is checked against that name). Returns (size, files).
fn zip_dir(src: &Path, top: &str, out: &Path, skip: &[&str]) -> Result<(u64, u64), CommandError> {
    let file = fs::File::create(out)?;
    let mut writer = zip::ZipWriter::new(file);
    let files = zip_add_dir(&mut writer, src, top, skip, 0)?;
    writer.finish().map_err(zip_error)?;
    let size_bytes = fs::metadata(out).map(|meta| meta.len()).unwrap_or(0);
    Ok((size_bytes, files))
}

fn zip_add_dir(
    writer: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    skip: &[&str],
    depth: usize,
) -> Result<u64, CommandError> {
    if depth > ZIP_MAX_DEPTH {
        return Err(CommandError::new("err.ioFailed").with("detail", "archive depth limit"));
    }

    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut files = 0;

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if skip.iter().any(|excluded| excluded.eq_ignore_ascii_case(&name)) {
                continue;
            }
            // A directory entry also preserves empty folders on restore.
            let child = format!("{}/{}", prefix, name);
            writer.add_directory(&child, options).map_err(zip_error)?;
            files += zip_add_dir(writer, &path, &child, skip, depth + 1)?;
        } else {
            // The entry path is the file name inside the current directory (prefix
            // already contains all the levels above it).
            let relative = path.strip_prefix(dir).unwrap_or(&path);
            let mut entry_name = prefix.to_string();
            for part in relative.components() {
                entry_name.push('/');
                entry_name.push_str(&part.as_os_str().to_string_lossy());
            }
            let mut source = fs::File::open(&path)?;
            writer.start_file(&entry_name, options).map_err(zip_error)?;
            std::io::copy(&mut source, writer)?;
            files += 1;
        }
    }

    Ok(files)
}

// Unpacking an archive into a directory: enclosed_name() rejects absolute paths and
// "..", and the first entry component must match the source directory (config/ or
// <domain>/) — a foreign archive cannot write anything past the target.
fn unzip_to(archive_path: &Path, dst: &Path, top: &str) -> Result<(), CommandError> {
    let file = fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(CommandError::new("err.accessDenied"));
        };
        let first = relative
            .components()
            .next()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_default();
        if !first.eq_ignore_ascii_case(top) {
            return Err(CommandError::new("err.accessDenied"));
        }

        let target = dst.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut output)?;
    }
    Ok(())
}

// Number of files in an archive (excluding directory entries) — for the backup list.
fn zip_file_count(path: &Path) -> Option<u64> {
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut count = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).ok()?;
        if !entry.is_dir() {
            count += 1;
        }
    }
    Some(count)
}

#[tauri::command]
pub fn list_backups(custom_path: Option<String>) -> Result<Vec<BackupEntry>, CommandError> {
    let backups = backups_root(custom_path.as_deref())?;
    let mut file_entries: Vec<BackupEntry> = Vec::new();
    let mut dir_entries: Vec<BackupEntry> = Vec::new();

    if let Ok(entries) = fs::read_dir(&backups) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata().ok();
            let created_at = meta.as_ref().map(modified_secs).unwrap_or(0);

            if path.is_file() {
                let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
                if extension != "zip" && extension != "sql" {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                let Some((_, _, kind)) = parse_backup_id(stem) else {
                    continue;
                };
                file_entries.push(BackupEntry {
                    id: stem.to_string(),
                    created_at,
                    size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    files: if extension == "zip" { zip_file_count(&path).unwrap_or(1) } else { 1 },
                    kind: kind.as_str().into(),
                    subject: kind.subject(),
                });
            } else if path.is_dir() {
                // Legacy backups are backup-<unix>/ directories; unrelated ones are not shown.
                let Some((_, _, kind)) = parse_backup_id(&name) else {
                    continue;
                };
                let (size_bytes, files) = dir_stats(&path);
                dir_entries.push(BackupEntry {
                    id: name,
                    created_at,
                    size_bytes,
                    files,
                    kind: kind.as_str().into(),
                    subject: kind.subject(),
                });
            }
        }
    }

    // A same-named directory (leftover of the old format) is not shown when a file with
    // the same id already exists — the file is newer and its restore takes priority.
    let mut list = file_entries;
    for dir in dir_entries {
        if !list.iter().any(|item| item.id == dir.id) {
            list.push(dir);
        }
    }
    list.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(list)
}

#[tauri::command]
pub fn create_backup(custom_path: Option<String>) -> Result<BackupEntry, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    let config = root.join("config");
    if !config.is_dir() {
        return Err(CommandError::new("err.configDirNotFound"));
    }

    let backups = backups_root(custom_path.as_deref())?;
    let secs = unix_now();
    let id = format!("backup-{}", secs);
    let (size_bytes, files) = zip_dir(&config, "config", &backups.join(format!("{}.zip", id)), &[])?;

    Ok(BackupEntry {
        id,
        created_at: secs,
        size_bytes,
        files,
        kind: BackupKind::Config.as_str().into(),
        subject: None,
    })
}

// Automatic copy of the current configs before a restore — now also an archive.
fn safety_backup_config(root: &Path, backups: &Path) -> Result<(), CommandError> {
    let config = root.join("config");
    if !config.is_dir() {
        return Ok(());
    }
    let id = format!("backup-{}-auto", unix_now());
    zip_dir(&config, "config", &backups.join(format!("{}.zip", id)), &[])?;
    Ok(())
}

#[tauri::command]
pub fn restore_backup(id: String, custom_path: Option<String>) -> Result<(), CommandError> {
    let Some((_, _, kind)) = parse_backup_id(&id) else {
        return Err(CommandError::new("err.invalidBackupId"));
    };
    if kind != BackupKind::Config {
        return Err(CommandError::new("err.operationNotAllowed"));
    }

    let root = resolve_installation(custom_path.as_deref())?;
    let backups = backups_root(custom_path.as_deref())?;
    let backups_canonical = fs::canonicalize(&backups)?;
    let config = root.join("config");

    // The new backup is a backup-<unix>.zip archive.
    let archive_path = backups.join(format!("{}.zip", id));
    if archive_path.is_file() {
        let archive = fs::canonicalize(&archive_path)?;
        if !archive.starts_with(&backups_canonical) {
            return Err(CommandError::new("err.accessDenied"));
        }
        safety_backup_config(&root, &backups)?;
        // Archive entries already start with config/ — unpack into the installation root.
        unzip_to(&archive, &root, "config")?;
        return Ok(());
    }

    // Legacy backups are backup-<unix>/config/ directories.
    let source = backup_target(backups.join(&id), &backups_canonical, &id)?;
    let source = source.join("config");
    if !source.is_dir() {
        return Err(CommandError::new("err.backupNoConfig"));
    }

    // Before overwriting, save the current configs into a separate backup.
    safety_backup_config(&root, &backups)?;
    copy_dir_recursive(&source, &config)?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(id: String, custom_path: Option<String>) -> Result<(), CommandError> {
    if parse_backup_id(&id).is_none() {
        return Err(CommandError::new("err.invalidBackupId"));
    }

    let backups = backups_root(custom_path.as_deref())?;
    let backups_canonical = fs::canonicalize(&backups)?;

    // The file is preferred over the same-named directory leftover of the old format.
    let mut target = backups.join(format!("{}.zip", id));
    if !target.is_file() {
        target = backups.join(format!("{}.sql", id));
        if !target.is_file() {
            target = backups.join(&id);
        }
    }
    let target = backup_target(target, &backups_canonical, &id)?;

    if target.is_dir() {
        fs::remove_dir_all(&target)?;
    } else {
        fs::remove_file(&target)?;
    }
    Ok(())
}

// --- Project archives ---

#[tauri::command]
pub fn create_project_backup(
    domain: String,
    custom_path: Option<String>,
) -> Result<BackupEntry, CommandError> {
    if !is_valid_domain(&domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    let root = resolve_installation(custom_path.as_deref())?;
    let home = fs::canonicalize(root.join("home")).map_err(|_| CommandError::new("err.ospanelNotFound"))?;
    let project = fs::canonicalize(home.join(&domain))
        .map_err(|_| CommandError::new("err.projectNotFound").with("domain", domain.clone()))?;
    if project == home || !project.starts_with(&home) {
        return Err(CommandError::new("err.accessDenied"));
    }
    if !project.is_dir() {
        return Err(CommandError::new("err.notADirectory"));
    }

    let backups = backups_root(custom_path.as_deref())?;
    let secs = unix_now();
    let id = format!("backup-{}-proj-{}", secs, domain);
    let (size_bytes, files) =
        zip_dir(&project, &domain, &backups.join(format!("{}.zip", id)), PROJECT_BACKUP_EXCLUDES)?;
    Ok(BackupEntry {
        id,
        created_at: secs,
        size_bytes,
        files,
        kind: BackupKind::Project(domain.clone()).as_str().into(),
        subject: Some(domain),
    })
}

#[tauri::command]
pub fn restore_project_backup(id: String, custom_path: Option<String>) -> Result<(), CommandError> {
    let Some((_, _, kind)) = parse_backup_id(&id) else {
        return Err(CommandError::new("err.invalidBackupId"));
    };
    let BackupKind::Project(domain) = kind else {
        return Err(CommandError::new("err.operationNotAllowed"));
    };

    let root = resolve_installation(custom_path.as_deref())?;
    let home = fs::canonicalize(root.join("home")).map_err(|_| CommandError::new("err.ospanelNotFound"))?;
    let backups = backups_root(custom_path.as_deref())?;
    let backups_canonical = fs::canonicalize(&backups)?;
    let archive = backup_target(backups.join(format!("{}.zip", id)), &backups_canonical, &id)?;

    // Before the restore the current project folder is archived automatically
    // (with the same excludes — node_modules/vendor reinstall anyway).
    let project = home.join(&domain);
    if project.is_dir() {
        let safety_id = format!("backup-{}-auto-proj-{}", unix_now(), domain);
        zip_dir(&project, &domain, &backups.join(format!("{}.zip", safety_id)), PROJECT_BACKUP_EXCLUDES)?;
    }

    // Unpacking into home/: entries are <domain>/..., files merge on top of the
    // existing ones — foreign and uncommitted changes are not silently overwritten.
    unzip_to(&archive, &home, &domain)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The id encodes the kind, the subject and the "auto" flag — the restore commands
    // need no separate parameters and cannot diverge from the file.
    #[test]
    fn backup_ids_encode_kind_subject_and_auto_flag() {
        assert_eq!(parse_backup_id("backup-1700000000"), Some((1700000000, false, BackupKind::Config)));
        assert_eq!(parse_backup_id("backup-1700000000-auto"), Some((1700000000, true, BackupKind::Config)));
        assert_eq!(
            parse_backup_id("backup-1700000000-db-MySQL-8.0"),
            Some((1700000000, false, BackupKind::Db("MySQL-8.0".into())))
        );
        assert_eq!(
            parse_backup_id("backup-1700000000-auto-db-PostgreSQL-17"),
            Some((1700000000, true, BackupKind::Db("PostgreSQL-17".into())))
        );
        assert_eq!(
            parse_backup_id("backup-1700000000-proj-dune.loc"),
            Some((1700000000, false, BackupKind::Project("dune.loc".into())))
        );
        assert_eq!(
            parse_backup_id("backup-1700000000-auto-proj-dune.loc"),
            Some((1700000000, true, BackupKind::Project("dune.loc".into())))
        );
    }

    #[test]
    fn backup_id_parser_rejects_trash_and_traversal() {
        for id in [
            "",
            "backup-",
            "backup-x1",
            "backup-1-x",
            "backup-1-autoX",
            "backup-1-db-",
            "backup-1-db-../evil",
            "backup-1-auto-db-..",
            "backup-1-proj-..",
            "backup-1-proj-.hidden",
            "backup-1.zip",
            "../../etc",
        ] {
            assert!(parse_backup_id(id).is_none(), "must reject {id}");
        }
    }

    // Project archive: node_modules/vendor (including nested ones) are left out of the zip,
    // the rest restores; a foreign archive is not unpacked past <domain>/.
    #[test]
    fn project_archive_skips_dependency_dirs_and_restores() {
        let root = std::env::temp_dir().join(format!("osp-ui-zip-{}", std::process::id()));
        let project = root.join("home").join("dune.loc");
        fs::create_dir_all(project.join("app").join("node_modules")).unwrap();
        fs::create_dir_all(project.join("vendor")).unwrap();
        fs::create_dir_all(project.join("empty")).unwrap();
        fs::write(project.join("app").join("index.php"), "<?php v1").unwrap();
        fs::write(project.join("app").join("node_modules").join("x.js"), "1").unwrap();
        fs::write(project.join("vendor").join("lib.php"), "2").unwrap();

        let archive = root.join("out.zip");
        let (size_bytes, files) = zip_dir(&project, "dune.loc", &archive, PROJECT_BACKUP_EXCLUDES).unwrap();
        assert_eq!(files, 1, "node_modules/vendor must not be archived");
        assert!(size_bytes > 0);

        let restored = root.join("restored");
        unzip_to(&archive, &restored, "dune.loc").unwrap();
        assert_eq!(
            fs::read_to_string(restored.join("dune.loc").join("app").join("index.php")).unwrap(),
            "<?php v1"
        );
        assert!(!restored.join("dune.loc").join("vendor").exists());
        assert!(!restored.join("dune.loc").join("app").join("node_modules").exists());
        // An empty folder is preserved — a directory entry stays in the archive.
        assert!(restored.join("dune.loc").join("empty").is_dir());

        // Entries outside the source directory (first component mismatch) are rejected.
        let mut evil = zip::ZipWriter::new(fs::File::create(root.join("evil.zip")).unwrap());
        {
            use std::io::Write;
            evil.start_file("other.site/x.txt", zip::write::SimpleFileOptions::default()).unwrap();
            evil.write_all(b"x").unwrap();
            evil.finish().unwrap();
        }
        let denied = unzip_to(&root.join("evil.zip"), &restored, "dune.loc").unwrap_err();
        assert_eq!(denied.code, "err.accessDenied");

        fs::remove_dir_all(&root).unwrap();
    }

    // Full config backup cycle: a zip instead of a directory, an auto copy before
    // restore, the list with kind, deletion, unrelated files do not interfere.
    #[test]
    fn config_backup_lifecycle_on_temp_install() {
        let root = std::env::temp_dir().join(format!("osp-ui-bkconf-{}", std::process::id()));
        fs::create_dir_all(root.join("config").join("Apache")).unwrap();
        fs::write(root.join("config").join("Apache").join("httpd.conf"), "old").unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        let created = create_backup(custom.clone()).unwrap();
        assert_eq!(created.kind, "config");
        assert!(created.subject.is_none());
        assert_eq!(created.files, 1);
        assert!(root.join("backups").join(format!("{}.zip", created.id)).is_file());

        // Change the config and restore: the old content comes back,
        // the current state goes into the automatic copy.
        fs::write(root.join("config").join("Apache").join("httpd.conf"), "new").unwrap();
        restore_backup(created.id.clone(), custom.clone()).unwrap();
        assert_eq!(fs::read_to_string(root.join("config").join("Apache").join("httpd.conf")).unwrap(), "old");

        // Unrelated files in backups/ do not appear in the list.
        fs::write(root.join("backups").join("notes.txt"), "x").unwrap();
        fs::create_dir_all(root.join("backups").join("scratch")).unwrap();

        let list = list_backups(custom.clone()).unwrap();
        assert_eq!(list.len(), 2, "the created backup + the auto copy before the restore");
        assert!(list.iter().all(|item| item.kind == "config"));
        assert!(list.iter().any(|item| item.id.ends_with("-auto")));

        delete_backup(created.id.clone(), custom.clone()).unwrap();
        assert_eq!(list_backups(custom.clone()).unwrap().len(), 1);

        let missing = delete_backup(created.id, custom.clone()).unwrap_err();
        assert_eq!(missing.code, "err.backupNotFound");

        fs::remove_dir_all(&root).unwrap();
    }

    // Legacy format (a backup-<ts>/config/ directory) is read and restored.
    #[test]
    fn legacy_directory_backup_still_restores() {
        let root = std::env::temp_dir().join(format!("osp-ui-bklegacy-{}", std::process::id()));
        fs::create_dir_all(root.join("config").join("Nginx")).unwrap();
        fs::write(root.join("config").join("Nginx").join("conf"), "current").unwrap();
        let legacy = root.join("backups").join("backup-1600000000").join("config").join("Nginx");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("conf"), "saved").unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        let list = list_backups(custom.clone()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "backup-1600000000");
        assert_eq!(list[0].kind, "config");

        restore_backup("backup-1600000000".into(), custom.clone()).unwrap();
        assert_eq!(fs::read_to_string(root.join("config").join("Nginx").join("conf")).unwrap(), "saved");

        fs::remove_dir_all(&root).unwrap();
    }

    // Full project archive cycle: the list with kind/subject, restoring an older
    // version, auto-archiving the current folder before the restore.
    #[test]
    fn project_backup_lifecycle_on_temp_install() {
        let root = std::env::temp_dir().join(format!("osp-ui-bkproj-{}", std::process::id()));
        let project = root.join("home").join("dune.loc");
        fs::create_dir_all(project.join("app")).unwrap();
        fs::write(project.join("app").join("index.php"), "<?php v1").unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        let created = create_project_backup("dune.loc".into(), custom.clone()).unwrap();
        assert_eq!(created.kind, "project");
        assert_eq!(created.subject.as_deref(), Some("dune.loc"));
        assert_eq!(created.files, 1);
        assert!(root.join("backups").join(format!("{}.zip", created.id)).is_file());

        fs::write(project.join("app").join("index.php"), "<?php v2").unwrap();
        restore_project_backup(created.id.clone(), custom.clone()).unwrap();
        assert_eq!(fs::read_to_string(project.join("app").join("index.php")).unwrap(), "<?php v1");

        let list = list_backups(custom.clone()).unwrap();
        assert_eq!(list.len(), 2, "the project archive + the auto archive before the restore");
        assert!(list
            .iter()
            .all(|item| item.kind == "project" && item.subject.as_deref() == Some("dune.loc")));

        let bad = create_project_backup("..\\evil".into(), custom.clone()).unwrap_err();
        assert_eq!(bad.code, "err.invalidDomain");

        fs::remove_dir_all(&root).unwrap();
    }
}
