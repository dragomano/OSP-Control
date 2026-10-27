//! Read-only project activity scans, isolated from the panel snapshot and UI thread.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;

use crate::error::CommandError;
use crate::panel_api::{Project, projects_from_api};
use crate::paths::{is_valid_domain, resolve_installation};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectActivity {
    domain: String,
    modified_at: Option<u64>,
    last_file: Option<String>,
    status: &'static str,
}

impl ProjectActivity {
    fn unavailable(domain: &str) -> Self {
        Self { domain: domain.into(), modified_at: None, last_file: None, status: "unavailable" }
    }
}

fn project_directory(root: &Path, domain: &str, projects: &[Project]) -> Result<PathBuf, CommandError> {
    if !is_valid_domain(domain) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    // API paths are a whitelist: a registered project may live outside home/.
    // New projects are absent from the API until a panel restart, so allow their
    // validated home/<domain> directory too, without accepting arbitrary paths.
    if let Some(project) = projects.iter().find(|p| p.domain.eq_ignore_ascii_case(domain)) {
        let path = fs::canonicalize(&project.path)?;
        if !path.is_dir() {
            return Err(CommandError::new("err.projectNotFound").with("domain", domain));
        }
        return Ok(path);
    }
    let home = fs::canonicalize(root.join("home"))?;
    let path = fs::canonicalize(home.join(domain))?;
    if !path.starts_with(&home) || path == home || !path.is_dir() {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(path)
}

fn project_ignore(root: &Path) -> (Gitignore, bool) {
    let mut builder = GitignoreBuilder::new(root);
    let path = root.join(".gitignore");
    let mut incomplete = false;
    match fs::canonicalize(&path) {
        Ok(canonical) if canonical.starts_with(root) && canonical.is_file() => {
            incomplete = builder.add(&path).is_some();
        }
        Ok(_) => incomplete = true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => incomplete = true,
    }
    match builder.build() {
        Ok(matcher) => (matcher, incomplete),
        Err(_) => (Gitignore::empty(), true),
    }
}

fn excluded_directory(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        ["vendor", "node_modules", ".git"].iter().any(|excluded| name.eq_ignore_ascii_case(excluded))
    })
}

fn inside_excluded_directory(path: &Path, root: &Path, is_dir: bool) -> bool {
    let directory = if is_dir { path } else { path.parent().unwrap_or(path) };
    directory.strip_prefix(root).is_ok_and(|relative| {
        relative.components().any(|component| excluded_directory(Path::new(component.as_os_str())))
    })
}

fn scan_project(domain: &str, root: &Path) -> ProjectActivity {
    let mut directories = vec![root.to_path_buf()];
    let mut visited = HashSet::new();
    let mut latest: Option<(SystemTime, String)> = None;
    let (ignore, mut incomplete) = project_ignore(root);

    while let Some(directory) = directories.pop() {
        if !visited.insert(directory.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        for entry in entries {
            let result = (|| -> std::io::Result<()> {
                let entry = entry?;
                let source = entry.path();
                let is_dir = entry.file_type()?.is_dir();
                if (is_dir && excluded_directory(&source))
                    || ignore.matched_path_or_any_parents(&source, is_dir).is_ignore()
                {
                    return Ok(());
                }
                let path = fs::canonicalize(&source)?;
                // Resolve every entry before following it: junctions and symlinks
                // must neither escape the project nor introduce traversal cycles.
                if !path.starts_with(root) {
                    return Ok(());
                }
                let metadata = fs::metadata(&path)?;
                let is_dir = metadata.is_dir();
                if (is_dir && excluded_directory(&source))
                    || inside_excluded_directory(&path, root, is_dir)
                    || ignore.matched_path_or_any_parents(&source, is_dir).is_ignore()
                    || ignore.matched_path_or_any_parents(&path, is_dir).is_ignore()
                {
                    return Ok(());
                }
                if metadata.is_dir() {
                    directories.push(path);
                } else if metadata.is_file() {
                    let modified = metadata.modified()?;
                    if modified.duration_since(UNIX_EPOCH).is_err() {
                        return Err(std::io::Error::other("file timestamp predates the Unix epoch"));
                    }
                    let file = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    if latest
                        .as_ref()
                        .is_none_or(|(time, name)| modified > *time || (modified == *time && file < *name))
                    {
                        latest = Some((modified, file));
                    }
                }
                Ok(())
            })();
            incomplete |= result.is_err();
        }
    }

    let (modified_at, last_file) = latest
        .map(|(time, file)| (Some(time.duration_since(UNIX_EPOCH).unwrap().as_secs()), Some(file)))
        .unwrap_or((None, None));
    let status = match (modified_at.is_some(), incomplete) {
        (true, false) => "ready",
        (true, true) => "partial",
        (false, false) => "empty",
        (false, true) => "unavailable",
    };
    ProjectActivity { domain: domain.into(), modified_at, last_file, status }
}

#[tauri::command]
pub async fn project_activity(
    domains: Vec<String>,
    custom_path: Option<String>,
) -> Result<Vec<ProjectActivity>, CommandError> {
    if domains.iter().any(|domain| !is_valid_domain(domain)) {
        return Err(CommandError::new("err.invalidDomain"));
    }
    if domains.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_installation(custom_path.as_deref())?;
        let projects = projects_from_api(&root);
        let mut seen = HashSet::new();
        Ok(domains
            .iter()
            .filter(|domain| seen.insert(domain.to_lowercase()))
            .map(|domain| match project_directory(&root, domain, &projects) {
                Ok(path) => scan_project(domain, &path),
                Err(_) => ProjectActivity::unavailable(domain),
            })
            .collect())
    })
    .await
    .map_err(|error| CommandError::new("err.ioFailed").with("detail", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, FileTimes};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "osp-activity-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }

        fn file(&self, name: &str, seconds: u64) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            File::create(path)
                .unwrap()
                .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_latest_nested_file_including_hidden_directories_but_skips_dependencies() {
        let fixture = Fixture::new();
        fixture.file("index.php", 100);
        fixture.file("src/deep/routes.php", 300);
        fixture.file(".osp/project.ini", 200);
        fixture.file(".git/config", 900);
        fixture.file("node_modules/package/index.js", 900);
        fixture.file("nested/vendor/library/index.php", 900);
        let activity = scan_project("test.local", &fixture.0);
        assert_eq!(activity.modified_at, Some(300));
        assert_eq!(activity.last_file.as_deref(), Some("src/deep/routes.php"));
        assert_eq!(activity.status, "ready");
        // A newer directory timestamp must not count as an edited file.
        fs::create_dir(fixture.0.join("new-directory")).unwrap();
        assert_eq!(scan_project("test.local", &fixture.0), activity);
    }

    #[test]
    fn respects_root_gitignore_patterns_and_negations_without_a_git_repository() {
        let fixture = Fixture::new();
        fixture.file(".gitignore", 50);
        fs::write(
            fixture.0.join(".gitignore"),
            "# Generated files\n/cache/\n*.log\n/build/**\n!/build/keep.php\n**/generated/\n!node_modules/\n",
        )
        .unwrap();
        File::options()
            .write(true)
            .open(fixture.0.join(".gitignore"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(50)))
            .unwrap();
        fixture.file("src/index.php", 100);
        fixture.file("cache/output.php", 900);
        fixture.file("debug.log", 900);
        fixture.file("nested/generated/output.php", 900);
        fixture.file("build/output.php", 900);
        fixture.file("build/keep.php", 300);
        fixture.file("node_modules/package/index.js", 900);
        let activity = scan_project("test.local", &fixture.0);
        assert_eq!(activity.status, "ready");
        assert_eq!(activity.modified_at, Some(300));
        assert_eq!(activity.last_file.as_deref(), Some("build/keep.php"));
        // An anchored rule applies only at the project root.
        fixture.file("nested/cache/allowed.php", 400);
        assert_eq!(scan_project("test.local", &fixture.0).modified_at, Some(400));
    }

    #[test]
    fn reports_malformed_ignore_rules_instead_of_claiming_a_complete_scan() {
        let fixture = Fixture::new();
        fixture.file("index.php", 100);
        fs::write(fixture.0.join(".gitignore"), "[z-a]\n").unwrap();
        assert_eq!(scan_project("test.local", &fixture.0).status, "partial");
    }

    #[test]
    fn distinguishes_empty_and_unavailable_projects_and_breaks_timestamp_ties() {
        let fixture = Fixture::new();
        assert_eq!(scan_project("empty.local", &fixture.0).status, "empty");
        assert_eq!(scan_project("gone.local", &fixture.0.join("gone")).status, "unavailable");
        fixture.file("b.php", 100);
        fixture.file("a.php", 100);
        assert_eq!(scan_project("test.local", &fixture.0).last_file.as_deref(), Some("a.php"));
    }

    #[test]
    fn accepts_only_registered_paths_or_validated_home_domains() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("home/test.local")).unwrap();
        assert!(project_directory(&fixture.0, "test.local", &[]).is_ok());
        assert!(project_directory(&fixture.0, "../home", &[]).is_err());
        assert!(project_directory(&fixture.0, "unknown.local", &[]).is_err());
        let external = Fixture::new();
        let registered = Project {
            domain: "external.local".into(),
            path: external.0.to_string_lossy().into_owned(),
            php: "-".into(),
            r#type: "-".into(),
            ssl: false,
        };
        assert_eq!(project_directory(&fixture.0, "external.local", &[registered]).unwrap(), external.0);
    }

    #[test]
    #[cfg(windows)]
    fn junctions_cannot_escape_the_project_or_create_cycles() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let external = Fixture::new();
        fixture.file("inside.php", 100);
        fixture.file("node_modules/package/index.js", 900);
        external.file("outside.php", 900);
        let dependencies = fixture.0.join("node_modules/package");
        for (name, target) in
            [("outside", &external.0), ("loop", &fixture.0), ("dependency-alias", &dependencies)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(fixture.0.join(name))
                .arg(target)
                .creation_flags(0x0800_0000)
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        let activity = scan_project("test.local", &fixture.0);
        assert_eq!(activity.modified_at, Some(100));
        assert_eq!(activity.last_file.as_deref(), Some("inside.php"));
        fs::create_dir(fixture.0.join("home")).unwrap();
        let home_link = fixture.0.join("home/escape.local");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&home_link)
            .arg(&external.0)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(project_directory(&fixture.0, "escape.local", &[]).is_err());
        for link in
            [home_link, fixture.0.join("outside"), fixture.0.join("loop"), fixture.0.join("dependency-alias")]
        {
            fs::remove_dir(link).unwrap();
        }
        assert!(external.0.join("outside.php").exists());
    }
}
