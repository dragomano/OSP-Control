//! Restricted filesystem operations for module archives and exact rollback.
use crate::error::CommandError;
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

pub(crate) fn safe_tree(dir: &Path) -> Result<(), CommandError> {
    fn walk(path: &Path, depth: usize) -> io::Result<()> {
        let meta = fs::symlink_metadata(path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
        if meta.file_type().is_symlink() || depth > 64 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if meta.is_dir() {
            for e in fs::read_dir(path)? {
                walk(&e?.path(), depth + 1)?;
            }
        }
        Ok(())
    }
    walk(dir, 0)?;
    Ok(())
}
pub(crate) fn child(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let target = parent.join(name);
    safe_tree(&target)?;
    let target = fs::canonicalize(target)?;
    if target.parent() != Some(fs::canonicalize(parent)?.as_path()) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(target)
}
fn relative(name: &str) -> Result<PathBuf, CommandError> {
    let name = name.trim_end_matches('/');
    let mut path = PathBuf::new();
    for part in name.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
                "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
            ]
            .contains(&stem.as_str())
        {
            return Err(CommandError::new("err.accessDenied"));
        }
        path.push(part);
    }
    Ok(path)
}
pub(crate) fn extract(archive: &Path, dst: &Path) -> Result<(), CommandError> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive)?).map_err(zip_err)?;
    if zip.len() > 10000 {
        return Err(CommandError::new("err.updateArchive"));
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    // Validate the complete archive before creating any file.
    for i in 0..zip.len() {
        let e = zip.by_index(i).map_err(zip_err)?;
        relative(e.name())?;
        if !names.insert(e.name().trim_end_matches('/').to_ascii_lowercase())
            || e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(CommandError::new("err.updateArchive"));
        }
        total = total.checked_add(e.size()).ok_or_else(|| CommandError::new("err.updateArchive"))?;
        if total > 800_000_000 {
            return Err(CommandError::new("err.updateArchive"));
        }
    }
    fs::create_dir(dst)?;
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(zip_err)?;
        let out = dst.join(relative(e.name())?);
        if e.is_dir() {
            fs::create_dir_all(out)?;
        } else {
            fs::create_dir_all(out.parent().unwrap())?;
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(out)?;
            io::copy(&mut e, &mut f)?;
            f.sync_all()?;
        }
    }
    safe_tree(dst)?;
    Ok(())
}
fn zip_err(e: zip::result::ZipError) -> CommandError {
    CommandError::new("err.updateArchive").with("detail", e.to_string())
}

fn metadata_error() -> CommandError {
    CommandError::new("err.updateMetadata")
}

fn metadata_content(content: &str, version: &str, timestamp: u64) -> Result<String, CommandError> {
    if crate::php_releases::version(version).is_none() || timestamp == 0 {
        return Err(metadata_error());
    }
    let timestamp = timestamp.to_string();
    let mut result = String::with_capacity(content.len() + 32);
    let mut main = false;
    let mut main_seen = false;
    let mut seen = [false; 2];
    for line in content.split_inclusive('\n') {
        let body = line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\n')).unwrap_or(line);
        let trimmed = body.trim_start_matches('\u{feff}').trim();
        if let Some(section) = trimmed.strip_prefix('[').and_then(|s| s.split_once(']')) {
            main = section.0.trim().eq_ignore_ascii_case("main");
            if main && main_seen {
                return Err(metadata_error());
            }
            main_seen |= main;
        } else if main && !trimmed.starts_with([';', '#']) {
            if let Some(eq) = body.find('=') {
                let key = body[..eq].trim();
                let field = if key.eq_ignore_ascii_case("version") {
                    Some((0, version))
                } else if key.eq_ignore_ascii_case("timestamp") {
                    Some((1, timestamp.as_str()))
                } else {
                    None
                };
                if let Some((index, value)) = field {
                    if seen[index] {
                        return Err(metadata_error());
                    }
                    seen[index] = true;
                    let after = &body[eq + 1..];
                    let padding = after.len() - after.trim_start_matches([' ', '\t']).len();
                    let old = &after[padding..];
                    let comment = old.find([';', '#']).unwrap_or(old.len());
                    let old_len = old[..comment].trim_end_matches([' ', '\t']).len();
                    let start = eq + 1 + padding;
                    result.push_str(&line[..start]);
                    result.push_str(value);
                    result.push_str(&line[start + old_len..]);
                    continue;
                }
            }
        }
        result.push_str(line);
    }
    if !seen.into_iter().all(|present| present) {
        return Err(metadata_error());
    }
    Ok(result)
}

fn update_metadata_at(dir: &Path, version: &str, timestamp: u64) -> Result<(), CommandError> {
    use std::io::Write;
    let data = child(dir, "ospanel_data")?;
    let ini = child(&data, "module.ini")?;
    let content = metadata_content(&fs::read_to_string(&ini)?, version, timestamp)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| metadata_error())?
        .as_nanos();
    let temporary = data.join(format!("module.ini-update-{}-{nonce}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Replace the file instead of truncating a possible hard link outside the module.
        fs::rename(&temporary, &ini)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(Into::into)
}

pub(crate) fn update_metadata(dir: &Path, version: &str) -> Result<(), CommandError> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| metadata_error())?
        .as_secs();
    update_metadata_at(dir, version, timestamp)
}

pub(crate) fn overlay(src: &Path, dst: &Path) -> Result<(), CommandError> {
    safe_tree(src)?;
    safe_tree(dst)?;
    for entry in fs::read_dir(src)? {
        let source = entry?.path();
        let target = dst.join(source.file_name().unwrap());
        if source.is_dir() {
            fs::create_dir_all(&target)?;
            overlay(&source, &target)?;
        } else {
            // Unlink rather than truncate: an existing hard link must not alter another file.
            if target.exists() {
                fs::remove_file(&target)?;
            }
            let mut input = fs::File::open(&source)?;
            let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
            io::copy(&mut input, &mut output)?;
            output.sync_all()?;
        }
    }
    Ok(())
}
/// Include directories as well as file digests, so empty/missing trees cannot pass recovery.
pub(crate) fn manifest(dir: &Path) -> Result<std::collections::BTreeMap<String, String>, CommandError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    safe_tree(dir)?;
    fn walk(
        root: &Path,
        dir: &Path,
        out: &mut std::collections::BTreeMap<String, String>,
    ) -> Result<(), CommandError> {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let key = path
                .strip_prefix(root)
                .map_err(|_| CommandError::new("err.updateRecovery"))?
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.insert(key, "directory".into());
                walk(root, &path, out)?;
            } else {
                let mut hash = Sha256::new();
                let mut input = fs::File::open(&path)?;
                let mut buf = [0; 65536];
                loop {
                    let n = input.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hash.update(&buf[..n]);
                }
                out.insert(key, format!("{:x}", hash.finalize()));
            }
        }
        Ok(())
    }
    let mut out = std::collections::BTreeMap::new();
    walk(dir, dir, &mut out)?;
    Ok(out)
}
pub(crate) fn validate_backup(
    dir: &Path,
    expected: &std::collections::BTreeMap<String, String>,
    executable: &str,
) -> Result<(), CommandError> {
    let executable = executable.replace('/', std::path::MAIN_SEPARATOR_STR);
    if !expected.contains_key(&executable) || manifest(dir)? != *expected {
        return Err(CommandError::new("err.updateRecovery"));
    }
    Ok(())
}
pub(crate) fn exact_restore(src: &Path, dst: &Path) -> Result<(), CommandError> {
    safe_tree(src)?;
    safe_tree(dst)?;
    for entry in fs::read_dir(dst)? {
        let path = entry?.path();
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    overlay(src, dst)
}
#[cfg(test)]
mod tests {
    use super::*;
    const METADATA: &str = "[main]\n\narchitecture             = x64\ntimestamp                = 1651770000\nversion                  = 8.2.30\n\n[docs]\nversion = documentation\ntimestamp = unchanged\n";

    fn metadata_test_dir(label: &str) -> PathBuf {
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = temporary.join(format!("osp-php-metadata-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        assert_eq!(dir.parent(), Some(temporary.as_path()));
        dir
    }

    #[test]
    fn metadata_updates_only_main_fields_preserving_bom_and_line_endings() {
        for (bom, newline, trailing) in [("", "\n", true), ("\u{feff}", "\r\n", true), ("", "\r\n", false)] {
            let mut source = format!("{bom}{}", METADATA.replace('\n', newline));
            if !trailing {
                source.truncate(source.len() - newline.len());
            }
            let expected = source.replace("1651770000", "1792616076").replace("8.2.30", "8.2.35");
            assert_eq!(metadata_content(&source, "8.2.35", 1792616076).unwrap(), expected);
        }
    }

    #[test]
    fn metadata_preserves_comments_spacing_and_case_insensitive_keys() {
        let source = "[MAIN] ; metadata\n  VERSION\t=\t8.2.30  ; installed version\nTimestamp = 1651770000 # installed time\n; version = example\n";
        let expected = "[MAIN] ; metadata\n  VERSION\t=\t8.2.35  ; installed version\nTimestamp = 1792616076 # installed time\n; version = example\n";
        assert_eq!(metadata_content(source, "8.2.35", 1792616076).unwrap(), expected);
    }

    #[test]
    fn metadata_rejects_missing_duplicate_or_invalid_fields() {
        for source in [
            "[main]\nversion = 8.2.30\n",
            "[main]\ntimestamp = 1651770000\n",
            "[docs]\nversion = 8.2.30\ntimestamp = 1651770000\n",
            "[main]\nversion = 8.2.30\ntimestamp = 1651770000\nversion = 8.2.29\n",
            "[main]\nversion = 8.2.30\ntimestamp = 1651770000\n[main]\n",
        ] {
            assert_eq!(
                metadata_content(source, "8.2.35", 1792616076).unwrap_err().code,
                "err.updateMetadata"
            );
        }
        assert!(metadata_content(METADATA, "8.2.35\narchitecture = x86", 1792616076).is_err());
        assert!(metadata_content(METADATA, "8.2.35", 0).is_err());
    }

    #[test]
    fn module_metadata_is_updated_and_restored_with_the_full_backup() {
        let root = metadata_test_dir("rollback");
        let module = root.join("module");
        let backup = root.join("backup");
        fs::create_dir_all(module.join("ospanel_data")).unwrap();
        fs::create_dir(&backup).unwrap();
        fs::write(module.join("php.exe"), "old binary").unwrap();
        let ini = module.join("ospanel_data/module.ini");
        fs::write(&ini, METADATA).unwrap();
        let before = manifest(&module).unwrap();
        overlay(&module, &backup).unwrap();
        fs::write(module.join("php.exe"), "new binary").unwrap();
        update_metadata_at(&module, "8.2.35", 1792616076).unwrap();
        let updated = fs::read_to_string(&ini).unwrap();
        assert!(updated.contains("version                  = 8.2.35"));
        assert!(updated.contains("timestamp                = 1792616076"));
        assert_eq!(fs::read_dir(module.join("ospanel_data")).unwrap().count(), 1);
        exact_restore(&backup, &module).unwrap();
        validate_backup(&module, &before, "php.exe").unwrap();
        assert_eq!(fs::read_to_string(ini).unwrap(), METADATA);
        assert_eq!(fs::read_to_string(module.join("php.exe")).unwrap(), "old binary");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_metadata_is_left_untouched() {
        let root = metadata_test_dir("invalid");
        fs::create_dir(root.join("ospanel_data")).unwrap();
        let ini = root.join("ospanel_data/module.ini");
        let original = "[main]\narchitecture = x64\n";
        fs::write(&ini, original).unwrap();
        assert!(update_metadata_at(&root, "8.2.35", 1792616076).is_err());
        assert_eq!(fs::read_to_string(ini).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_replacement_does_not_modify_an_external_hard_link() {
        let root = metadata_test_dir("hard-link");
        let module = root.join("module");
        fs::create_dir_all(module.join("ospanel_data")).unwrap();
        let external = root.join("external.ini");
        fs::write(&external, METADATA).unwrap();
        let ini = module.join("ospanel_data/module.ini");
        fs::hard_link(&external, &ini).unwrap();
        update_metadata_at(&module, "8.2.35", 1792616076).unwrap();
        assert_eq!(fs::read_to_string(&external).unwrap(), METADATA);
        assert!(fs::read_to_string(ini).unwrap().contains("version                  = 8.2.35"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_windows_escape_names() {
        for name in ["../config/a", "/a", "a\\..\\b", "C:/a", "a:stream", "CON.txt", "a./b", "a /b", "LPT1"] {
            assert!(relative(name).is_err(), "{name}");
        }
        assert_eq!(relative("ext/php_zip.dll").unwrap(), PathBuf::from("ext/php_zip.dll"));
    }
    #[test]
    fn damaged_backup_is_rejected_before_restore() {
        let root = std::env::temp_dir().join(format!("osp-php-integrity-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("php.exe"), "original").unwrap();
        let expected = manifest(&root).unwrap();
        validate_backup(&root, &expected, "php.exe").unwrap();
        fs::write(root.join("php.exe"), "corrupted").unwrap();
        assert!(validate_backup(&root, &expected, "php.exe").is_err());
        fs::remove_file(root.join("php.exe")).unwrap();
        assert!(validate_backup(&root, &expected, "php.exe").is_err());
        assert!(validate_backup(&root, &Default::default(), "php.exe").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn overlay_preserves_extras_and_rollback_removes_new_files() {
        let root = std::env::temp_dir().join(format!("osp-php-files-{}", std::process::id()));
        let src = root.join("src");
        let dst = root.join("dst");
        let backup = root.join("backup");
        for d in [&src, &dst, &backup] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(dst.join("extra.dll"), "custom").unwrap();
        fs::write(dst.join("php.exe"), "old").unwrap();
        overlay(&dst, &backup).unwrap();
        fs::write(src.join("php.exe"), "new").unwrap();
        fs::write(src.join("new.dll"), "new").unwrap();
        overlay(&src, &dst).unwrap();
        assert!(dst.join("extra.dll").exists());
        exact_restore(&backup, &dst).unwrap();
        assert!(!dst.join("new.dll").exists());
        assert_eq!(fs::read_to_string(dst.join("php.exe")).unwrap(), "old");
        fs::remove_dir_all(root).unwrap();
    }
}
