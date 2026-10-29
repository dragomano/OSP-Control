//! Locating the installation, path/URL validation and small fs+time helpers shared by commands.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{CommandError, spawn_failed};

// Detection only: the first existing candidate wins, so the conventional installation
// location comes first. The remaining entries are fallbacks for non-default drives.
fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from(r"C:\OSPanel"),
        PathBuf::from(r"C:\OSPanel6"),
        PathBuf::from(r"D:\OSPanel"),
        PathBuf::from(r"D:\OSPanel6"),
    ];
    if let Ok(program_data) = std::env::var("PROGRAMDATA") {
        paths.push(PathBuf::from(program_data).join("OSPanel"));
    }
    paths
}

fn find_installation() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| {
        path.join("bin").join("osp.bat").exists()
            || path.join("home").exists()
            || path.join("modules").exists()
    })
}

pub(crate) fn now_iso() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|_| "unknown".into())
}

pub(crate) fn within_installation(canonical: &Path, custom_path: Option<&str>) -> bool {
    custom_path
        .map(PathBuf::from)
        .into_iter()
        .filter(|path| path.exists())
        .chain(candidate_paths())
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(&root))
}

// Shared explorer spawn for an already-verified path (whitelisted up the call stack).
pub(crate) fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

// Keep canonical paths for filesystem checks. External CLIs may interpret verbatim paths as relative.
pub(crate) fn external_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let prefix = match components.next() {
            Some(Component::Prefix(prefix)) => prefix.kind(),
            _ => return path.to_path_buf(),
        };
        let mut result = match prefix {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
            Prefix::VerbatimUNC(server, share) => {
                let mut path = PathBuf::from(r"\\");
                path.push(server);
                path.push(share);
                path
            }
            _ => return path.to_path_buf(),
        };
        for component in components {
            if component != Component::RootDir {
                result.push(component.as_os_str());
            }
        }
        result
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

pub(crate) fn explorer_open(target: &Path) -> Result<(), CommandError> {
    Command::new("explorer").arg(target).spawn().map_err(spawn_failed)?;
    Ok(())
}

pub(crate) fn is_valid_lang(code: &str) -> bool {
    (2..=8).contains(&code.len())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && code.chars().any(|c| c.is_ascii_alphabetic())
}

pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn modified_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn dir_stats(path: &Path) -> (u64, u64) {
    let mut size = 0;
    let mut files = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                let (s, f) = dir_stats(&child);
                size += s;
                files += f;
            } else if let Ok(meta) = entry.metadata() {
                size += meta.len();
                files += 1;
            }
        }
    }

    (size, files)
}

pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;

    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copied += copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
            copied += 1;
        }
    }

    Ok(copied)
}

// A single path component (a module directory in modules/, a project folder in home/):
// ASCII letters/digits, hyphen, underscore, dot; no ".." and no leading dot, so the path
// cannot "escape". The limits differ: module names are short, domains may be longer.
fn is_safe_component(value: &str, max_len: usize) -> bool {
    (1..=max_len).contains(&value.len())
        && !value.starts_with('.')
        && !value.contains("..")
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub(crate) fn is_valid_module_name(name: &str) -> bool {
    is_safe_component(name, 100)
}

pub(crate) fn resolve_installation(custom_path: Option<&str>) -> Result<PathBuf, CommandError> {
    custom_path
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(find_installation)
        .ok_or_else(|| CommandError::new("err.ospanelNotFound"))
}

// A domain is a directory name in home/: ASCII letters, digits, dot, hyphen, underscore only.
pub(crate) fn is_valid_domain(domain: &str) -> bool {
    is_safe_component(domain, 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn external_program_paths_preserve_drive_unc_and_unicode_names_without_verbatim_prefixes() {
        for (source, expected) in [
            (r"\\?\D:\Panel Folder\modules\Nginx", r"D:\Panel Folder\modules\Nginx"),
            (r"\\?\UNC\server\share\Panel Folder\Apache", r"\\server\share\Panel Folder\Apache"),
            (r"D:\Panel Folder\modules\Caddy", r"D:\Panel Folder\modules\Caddy"),
        ] {
            assert_eq!(external_path(Path::new(source)), PathBuf::from(expected));
        }
        let name = format!("Panel {}", char::from_u32(0x0416).unwrap());
        assert_eq!(
            external_path(Path::new(&format!(r"\\?\D:\{name}"))),
            PathBuf::from(format!(r"D:\{name}"))
        );
    }

    #[test]
    fn the_conventional_location_is_the_default_candidate() {
        assert_eq!(candidate_paths().first(), Some(&PathBuf::from(r"C:\OSPanel")));
    }

    #[test]
    fn domain_validation_rejects_traversal() {
        assert!(is_valid_domain("dune.loc"));
        assert!(is_valid_domain("my-shop.test"));
        assert!(!is_valid_domain("..\\Apache"));
        assert!(!is_valid_domain(".hidden"));
        assert!(!is_valid_domain(""));
        assert!(!is_valid_domain("сайт.лок"));
    }
}
