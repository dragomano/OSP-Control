//! Project-scoped configuration files with optimistic concurrency and exact backups.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    error::CommandError,
    paths::{external_path, normalize_project_domain, resolve_installation},
};

const MAX_FILE: u64 = 1_048_576;
static SAVE_LOCK: Mutex<()> = Mutex::new(());
type Sections = BTreeMap<String, BTreeMap<String, String>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkspace {
    base_dir: String,
    content: Option<String>,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFileSave {
    content: String,
    backup_path: Option<String>,
}

fn invalid() -> CommandError {
    CommandError::new("err.projectWorkspaceInvalid")
}
fn conflict() -> CommandError {
    CommandError::new("err.projectWorkspaceConflict")
}

// Validate each existing component, including Windows junctions, before following it.
pub(crate) fn child(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = parent.join(name);
    if let Ok(meta) = fs::symlink_metadata(&path) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(CommandError::new("err.accessDenied"));
            }
        }
        if meta.file_type().is_symlink() {
            return Err(CommandError::new("err.accessDenied"));
        }
        let canonical = fs::canonicalize(&path)?;
        if canonical.parent() != Some(fs::canonicalize(parent)?.as_path()) {
            return Err(CommandError::new("err.accessDenied"));
        }
        return Ok(canonical);
    }
    Ok(path)
}

pub(crate) fn read(path: &Path) -> Result<Option<String>, CommandError> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE => Err(invalid()),
        Ok(_) => Ok(Some(fs::read_to_string(path)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn name(value: &str) -> Result<String, CommandError> {
    let domain = normalize_project_domain(value)?;
    if domain == "auto" || domain == "localhost" {
        return Err(invalid());
    }
    Ok(domain)
}

fn value_text(value: &str) -> &str {
    let mut quote = None;
    let mut previous = None;
    for (index, ch) in value.char_indices() {
        if matches!(ch, '\'' | '"') && previous != Some('\\') {
            quote = if quote == Some(ch) { None } else { quote.or(Some(ch)) };
        }
        if quote.is_none() && matches!(ch, ';' | '#') && previous.is_none_or(char::is_whitespace) {
            return value[..index].trim();
        }
        previous = Some(ch);
    }
    value.trim()
}

pub(crate) fn parse(content: &str) -> Result<Sections, CommandError> {
    let mut sections = Sections::new();
    let mut current = None;
    for line in content.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with([';', '#']) {
            continue;
        }
        if line.starts_with('[') {
            let end = line.find(']').ok_or_else(invalid)?;
            let suffix = line[end + 1..].trim();
            if !suffix.is_empty() && !suffix.starts_with([';', '#']) {
                return Err(invalid());
            }
            let section = name(line[1..end].trim())?;
            if sections.insert(section.clone(), BTreeMap::new()).is_some() {
                return Err(invalid());
            }
            current = Some(section);
        } else {
            let (key, value) = line.split_once('=').ok_or_else(invalid)?;
            let key = key.trim().to_ascii_lowercase();
            if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                return Err(invalid());
            }
            let section = sections.get_mut(current.as_ref().ok_or_else(invalid)?).ok_or_else(invalid)?;
            if section.insert(key, value_text(value).into()).is_some() {
                return Err(invalid());
            }
        }
    }
    if sections.len() > 128 {
        return Err(invalid());
    }
    Ok(sections)
}

fn base(root: &Path, domain: &str, base_dir: &str) -> Result<PathBuf, CommandError> {
    let domain = name(domain)?;
    let home = child(root, "home")?;
    let expected = fs::canonicalize(base_dir)?;
    // Projects may share a folder, but configuration is always owned by one direct home child.
    if expected.parent() != Some(home.as_path()) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let folder = expected.file_name().and_then(|s| s.to_str()).ok_or_else(invalid)?;
    let dir = child(&home, folder)?;
    if dir != expected || !dir.is_dir() {
        return Err(CommandError::new("err.accessDenied"));
    }
    let osp = child(&dir, ".osp")?;
    let ini = if osp.exists() { child(&osp, "project.ini")? } else { osp.join("project.ini") };
    if let Some(content) = read(&ini)? {
        if !parse(&content)?.contains_key(&domain) {
            return Err(invalid());
        }
    } else if name(folder)? != domain {
        return Err(invalid());
    }
    Ok(dir)
}

fn sections_at(dir: &Path) -> Result<Sections, CommandError> {
    let osp = child(dir, ".osp")?;
    let ini = if osp.exists() { child(&osp, "project.ini")? } else { osp.join("project.ini") };
    read(&ini)?.map(|c| parse(&c)).unwrap_or_else(|| Ok(Sections::new()))
}

fn file_path(dir: &Path, domain: &str, file: &str, create: bool) -> Result<PathBuf, CommandError> {
    let fixed = ["project.ini", "env.ini", "menu.ini", "tasks.ini"];
    let mut osp = child(dir, ".osp")?;
    if !osp.exists() && create {
        fs::create_dir(&osp)?;
        osp = child(dir, ".osp")?;
    }
    if fixed.contains(&file) {
        return if osp.exists() { child(&osp, file) } else { Ok(osp.join(file)) };
    }
    let parts: Vec<_> = file.split('/').collect();
    if parts.len() != 2 || !["apache", "nginx", "caddy"].contains(&parts[0]) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let target = parts[1].strip_suffix(".conf").ok_or_else(invalid)?;
    if name(target)? != target || (target != name(domain)? && !sections_at(dir)?.contains_key(target)) {
        return Err(invalid());
    }
    let mut parent = child(&osp, parts[0])?;
    if !parent.exists() && create {
        fs::create_dir(&parent)?;
        parent = child(&osp, parts[0])?;
    }
    if parent.exists() { child(&parent, parts[1]) } else { Ok(parent.join(parts[1])) }
}

fn workspace(root: &Path, domain: &str, base_dir: &str) -> Result<ProjectWorkspace, CommandError> {
    let dir = base(root, domain, base_dir)?;
    let content = read(&file_path(&dir, domain, "project.ini", false)?)?;
    let mut domains: Vec<_> =
        content.as_ref().map(|c| parse(c)).transpose()?.unwrap_or_default().into_keys().collect();
    if domains.is_empty() {
        domains.push(name(domain)?);
    }
    let mut files = vec!["project.ini".into(), "env.ini".into(), "menu.ini".into(), "tasks.ini".into()];
    for domain in domains {
        for engine in ["nginx", "apache", "caddy"] {
            files.push(format!("{engine}/{domain}.conf"));
        }
    }
    Ok(ProjectWorkspace { base_dir: external_path(&dir).to_string_lossy().into_owned(), content, files })
}

fn aliases(domain: &str, values: &BTreeMap<String, String>) -> Vec<String> {
    values
        .get("server_aliases")
        .map(|s| {
            s.split_whitespace()
                .map(|a| {
                    let alias = a.replace("{host}", domain).to_lowercase();
                    if let Some(plain) = alias.strip_prefix("*.") {
                        format!("*.{}", name(plain).unwrap_or_else(|_| plain.into()))
                    } else {
                        name(&alias).unwrap_or(alias)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn validate(root: &Path, dir: &Path, old: &str, next: &str) -> Result<(), CommandError> {
    let before = parse(old)?;
    let after = parse(next)?;
    if after.is_empty() {
        return Err(invalid());
    }
    let mut added = BTreeSet::new();
    for (domain, fields) in &after {
        if !before.contains_key(domain) {
            added.insert(domain.clone());
        }
        let old_fields = before.get(domain);
        for (key, value) in fields {
            if old_fields.and_then(|f| f.get(key)) == Some(value) {
                continue;
            }
            if value.chars().any(|c| c.is_control()) {
                return Err(invalid());
            }
            match key.as_str() {
                "http_port" | "https_port" | "backend_port" if !value.is_empty() && value != "auto" => {
                    if value.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
                        return Err(invalid());
                    }
                }
                "tls_enabled" | "project_enabled" | "primary_domain" | "backend_enabled"
                | "http2_enabled" => {
                    if !["", "auto", "on", "off"].contains(&value.as_str()) {
                        return Err(invalid());
                    }
                }
                "http_engine" | "php_engine" | "node_engine" if !value.is_empty() && value != "auto" => {
                    let category_matches = match key.as_str() {
                        "http_engine" => ["Apache", "Nginx", "Caddy"].contains(&value.as_str()),
                        "php_engine" => value.starts_with("PHP-"),
                        "node_engine" => value.starts_with("Node-"),
                        _ => false,
                    };
                    if !category_matches
                        || !crate::paths::is_valid_module_name(value)
                        || !root.join("modules").join(value).is_dir()
                    {
                        return Err(invalid());
                    }
                }
                "server_aliases" => {
                    let previous = old_fields.map(|f| aliases(domain, f)).unwrap_or_default();
                    for alias in aliases(domain, fields) {
                        let plain = alias.strip_prefix("*.").unwrap_or(&alias);
                        if plain.parse::<std::net::IpAddr>().is_err() && name(plain).is_err() {
                            return Err(invalid());
                        }
                        if !previous.contains(&alias) {
                            added.insert(alias);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    // Compare new domain names and aliases against the complete current installation.
    for candidate in &added {
        if root.join("modules").join(candidate).exists() || root.join("addons").join(candidate).exists() {
            return Err(CommandError::new("err.projectExists").with("domain", candidate));
        }
    }
    if !added.is_empty() {
        let home = child(root, "home")?;
        for entry in fs::read_dir(&home)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let other = child(&home, entry.file_name().to_str().ok_or_else(invalid)?)?;
            if other == dir {
                continue;
            }
            if added.contains(&entry.file_name().to_string_lossy().to_lowercase()) {
                return Err(CommandError::new("err.projectExists")
                    .with("domain", entry.file_name().to_string_lossy().into_owned()));
            }
            for (domain, fields) in sections_at(&other)? {
                for candidate in std::iter::once(domain.clone()).chain(aliases(&domain, &fields)) {
                    if added.contains(&candidate) {
                        return Err(CommandError::new("err.projectExists").with("domain", candidate));
                    }
                }
            }
        }
    }
    let mut owned = BTreeSet::new();
    for (domain, fields) in &after {
        if !owned.insert(domain.clone()) {
            return Err(invalid());
        }
        for alias in aliases(domain, fields) {
            if !owned.insert(alias) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn ensure_dir(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = child(parent, name)?;
    if !path.exists() {
        fs::create_dir(&path)?;
    }
    let path = child(parent, name)?;
    if !path.is_dir() {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(path)
}

fn save(
    root: &Path,
    domain: &str,
    base_dir: &str,
    file: &str,
    original: Option<&str>,
    content: &str,
) -> Result<ProjectFileSave, CommandError> {
    let _lock = SAVE_LOCK.lock().map_err(|_| conflict())?;
    if content.len() as u64 > MAX_FILE || content.contains('\0') {
        return Err(invalid());
    }
    let dir = base(root, domain, base_dir)?;
    let path = file_path(&dir, domain, file, false)?;
    if read(&path)?.as_deref() != original {
        return Err(conflict());
    }
    if original == Some(content) {
        return Ok(ProjectFileSave { content: content.into(), backup_path: None });
    }
    let mut next = content.replace("\r\n", "\n");
    if original.is_some_and(|s| s.contains("\r\n")) {
        next = next.replace('\n', "\r\n");
    }
    if original.is_some_and(|s| s.starts_with('\u{feff}')) && !next.starts_with('\u{feff}') {
        next.insert(0, '\u{feff}');
    }
    if next.len() as u64 > MAX_FILE {
        return Err(invalid());
    }
    if file == "project.ini" {
        validate(root, &dir, original.unwrap_or(""), &next)?;
        if !parse(&next)?.contains_key(&name(domain)?) {
            return Err(invalid());
        }
    }
    if original == Some(next.as_str()) {
        return Ok(ProjectFileSave { content: next, backup_path: None });
    }
    let stamp = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
    );
    let backups = ensure_dir(&ensure_dir(&ensure_dir(root, "backups")?, "project-settings")?, &stamp)?;
    let backup = if let Some(original) = original {
        let backup = backups.join("original.bak");
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&backup)?;
        out.write_all(original.as_bytes())?;
        out.sync_all()?;
        Some(external_path(&backup).to_string_lossy().into_owned())
    } else {
        None
    };
    fs::write(backups.join("source.txt"), format!("{}\n{file}\n", external_path(&dir).display()))?;
    let path = file_path(&dir, domain, file, true)?;
    let temporary = path.parent().ok_or_else(invalid)?.join(format!(".project-settings-{stamp}.tmp"));
    let result = (|| -> Result<(), CommandError> {
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        out.write_all(next.as_bytes())?;
        out.sync_all()?;
        drop(out);
        if base(root, domain, base_dir)? != dir
            || file_path(&dir, domain, file, false)? != path
            || read(&path)?.as_deref() != original
        {
            return Err(conflict());
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(ProjectFileSave { content: next, backup_path: backup })
}

#[tauri::command]
pub fn read_project_workspace(
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
) -> Result<ProjectWorkspace, CommandError> {
    workspace(&fs::canonicalize(resolve_installation(custom_path.as_deref())?)?, &domain, &base_dir)
}

fn project_menu_document(content: Option<&str>) -> Result<crate::menu::MenuDocument, CommandError> {
    let mut document = crate::menu::document(content.unwrap_or(""))?;
    // A missing file and an externally created empty file must have different revisions.
    document.revision =
        format!("{}:{}", if content.is_some() { "file" } else { "missing" }, document.revision);
    Ok(document)
}

fn read_menu(root: &Path, domain: &str, base_dir: &str) -> Result<crate::menu::MenuDocument, CommandError> {
    let dir = base(root, domain, base_dir)?;
    project_menu_document(read(&file_path(&dir, domain, "menu.ini", false)?)?.as_deref())
}

fn write_menu(
    root: &Path,
    domain: &str,
    base_dir: &str,
    items: &[crate::menu::MenuItem],
    expected_revision: &str,
) -> Result<crate::menu::MenuSaveResult, CommandError> {
    let dir = base(root, domain, base_dir)?;
    let original = read(&file_path(&dir, domain, "menu.ini", false)?)?;
    if project_menu_document(original.as_deref())?.revision != expected_revision {
        return Err(conflict());
    }
    let content = crate::menu::render(original.as_deref().unwrap_or(""), items)?;
    let saved = save(root, domain, base_dir, "menu.ini", original.as_deref(), &content)?;
    Ok(crate::menu::MenuSaveResult {
        document: project_menu_document(Some(&saved.content))?,
        backup_path: saved.backup_path,
    })
}

#[tauri::command]
pub fn read_project_menu(
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
) -> Result<crate::menu::MenuDocument, CommandError> {
    read_menu(&fs::canonicalize(resolve_installation(custom_path.as_deref())?)?, &domain, &base_dir)
}

#[tauri::command]
pub fn write_project_menu(
    domain: String,
    base_dir: String,
    items: Vec<crate::menu::MenuItem>,
    expected_revision: String,
    custom_path: Option<String>,
) -> Result<crate::menu::MenuSaveResult, CommandError> {
    write_menu(
        &fs::canonicalize(resolve_installation(custom_path.as_deref())?)?,
        &domain,
        &base_dir,
        &items,
        &expected_revision,
    )
}

#[tauri::command]
pub fn read_project_file(
    domain: String,
    base_dir: String,
    file: String,
    custom_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
    read(&file_path(&base(&root, &domain, &base_dir)?, &domain, &file, false)?)
}

#[tauri::command]
pub fn save_project_file(
    domain: String,
    base_dir: String,
    file: String,
    original: Option<String>,
    content: String,
    custom_path: Option<String>,
) -> Result<ProjectFileSave, CommandError> {
    save(
        &fs::canonicalize(resolve_installation(custom_path.as_deref())?)?,
        &domain,
        &base_dir,
        &file,
        original.as_deref(),
        &content,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "osp-workspace-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(root.join("home/shared/.osp")).unwrap();
            fs::create_dir_all(root.join("modules/Nginx")).unwrap();
            fs::write(root.join("home/shared/.osp/project.ini"), "\u{feff}; Keep\r\n[shop.test]\r\nhttp_engine = Nginx\r\nweb_root = {base_dir}\\public\r\n\r\n[api.shop.test]\r\nweb_root = {base_dir}\\api\r\n").unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn dir(&self) -> String {
            self.0.join("home/shared").to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    #[ignore = "Requires OSP_CONTROL_PROJECT_SAMPLE; reads the installed sample without writing"]
    fn installed_project_sample_is_readable() {
        let sample = PathBuf::from(std::env::var("OSP_CONTROL_PROJECT_SAMPLE").unwrap());
        let sample = fs::canonicalize(sample).unwrap();
        let root = sample.parent().unwrap().parent().unwrap();
        let content = fs::read_to_string(sample.join(".osp/project.ini")).unwrap();
        let domains = parse(&content).unwrap();
        assert!(domains.len() > 1);
        let original_menu = fs::read_to_string(sample.join(".osp/menu.ini")).unwrap();
        for domain in domains.keys() {
            let doc = workspace(root, domain, sample.to_str().unwrap()).unwrap();
            assert!(doc.files.contains(&format!("caddy/{domain}.conf")));
            assert!(doc.files.contains(&format!("nginx/{domain}.conf")));
            assert!(doc.files.contains(&format!("apache/{domain}.conf")));
            let menu = read_menu(root, domain, sample.to_str().unwrap()).unwrap();
            assert!(!menu.items.is_empty());
            assert_eq!(crate::menu::render(&original_menu, &menu.items).unwrap(), original_menu);
        }
    }
    #[test]
    fn shared_domains_use_the_base_directory_and_all_three_config_languages() {
        let f = Fixture::new();
        let doc = workspace(&f.0, "api.shop.test", &f.dir()).unwrap();
        assert!(doc.files.contains(&"caddy/api.shop.test.conf".into()));
        assert!(doc.files.contains(&"nginx/shop.test.conf".into()));
        assert!(base(&f.0, "unknown.test", &f.dir()).is_err());
        assert!(base(&f.0, "shop.test", f.0.to_str().unwrap()).is_err());
        assert!(file_path(&PathBuf::from(f.dir()), "shop.test", "../../system/program.dat", false).is_err());
        assert!(file_path(&PathBuf::from(f.dir()), "shop.test", "nginx/unknown.test.conf", false).is_err());
    }
    #[test]
    fn exact_backup_conflict_detection_and_new_file_creation() {
        let f = Fixture::new();
        let doc = workspace(&f.0, "shop.test", &f.dir()).unwrap();
        let old = doc.content.unwrap();
        let next = old.replace("web_root = {base_dir}\\public", "web_root = {base_dir}\\www");
        let result = save(&f.0, "shop.test", &f.dir(), "project.ini", Some(&old), &next).unwrap();
        assert_eq!(fs::read_to_string(result.backup_path.unwrap()).unwrap(), old);
        assert!(result.content.starts_with('\u{feff}'));
        assert!(result.content.contains("[api.shop.test]\r\nweb_root = {base_dir}\\api"));
        assert_eq!(
            save(&f.0, "shop.test", &f.dir(), "project.ini", Some(&old), &next).unwrap_err().code,
            "err.projectWorkspaceConflict"
        );
        assert!(
            save(&f.0, "shop.test", &f.dir(), "caddy/shop.test.conf", None, "file_server\n")
                .unwrap()
                .backup_path
                .is_none()
        );
        assert!(save(&f.0, "shop.test", &f.dir(), "caddy/shop.test.conf", None, "changed").is_err());
    }
    #[test]
    fn rejects_duplicate_domains_invalid_ports_and_cross_project_aliases() {
        let f = Fixture::new();
        let old = workspace(&f.0, "shop.test", &f.dir()).unwrap().content.unwrap();
        fs::create_dir_all(f.0.join("home/other/.osp")).unwrap();
        fs::write(f.0.join("home/other/.osp/project.ini"), "[taken.test]\n").unwrap();
        for suffix in ["\n[SHOP.TEST]\n", "\nbackend_port = 70000\n", "\nserver_aliases = taken.test\n"] {
            assert!(
                save(&f.0, "shop.test", &f.dir(), "project.ini", Some(&old), &format!("{old}{suffix}"))
                    .is_err()
            );
            assert_eq!(
                workspace(&f.0, "shop.test", &f.dir()).unwrap().content.as_deref(),
                Some(old.as_str())
            );
        }
    }
    #[test]
    fn project_menu_uses_shared_codec_and_leaves_global_menu_and_settings_untouched() {
        let f = Fixture::new();
        let original = "\u{feff}; Project menu\r\n[shop.test-action]\r\n\r\ncaption  = {lang_project_action}\r\ncategory = projects\\shop.test\r\ncommand  = cmd.exe /c \"echo {host} & echo {base_dir}\"\r\nfuture_key = retain\r\n";
        let path = f.0.join("home/shared/.osp/menu.ini");
        fs::write(&path, original).unwrap();
        fs::create_dir_all(f.0.join("system")).unwrap();
        fs::write(f.0.join("system/menu.dat"), "global menu sentinel").unwrap();
        let project_ini = workspace(&f.0, "shop.test", &f.dir()).unwrap().content;
        let mut doc = read_menu(&f.0, "shop.test", &f.dir()).unwrap();
        doc.items[0].fields.insert("caption".into(), "Project action".into());
        let result = write_menu(&f.0, "shop.test", &f.dir(), &doc.items, &doc.revision).unwrap();
        assert_eq!(fs::read_to_string(result.backup_path.unwrap()).unwrap(), original);
        let changed = fs::read_to_string(&path).unwrap();
        assert_eq!(changed, original.replace("{lang_project_action}", "Project action"));
        assert_eq!(fs::read_to_string(f.0.join("system/menu.dat")).unwrap(), "global menu sentinel");
        assert_eq!(workspace(&f.0, "api.shop.test", &f.dir()).unwrap().content, project_ini);
        assert_eq!(read_menu(&f.0, "api.shop.test", &f.dir()).unwrap().revision, result.document.revision);
        assert_eq!(
            write_menu(&f.0, "shop.test", &f.dir(), &doc.items, &doc.revision).unwrap_err().code,
            "err.projectWorkspaceConflict"
        );
    }
    #[test]
    fn project_menu_creation_rejects_external_empty_creation_and_unsafe_source_paths() {
        let f = Fixture::new();
        let path = f.0.join("home/shared/.osp/menu.ini");
        let missing = read_menu(&f.0, "shop.test", &f.dir()).unwrap();
        assert!(!path.exists());
        fs::write(&path, "").unwrap();
        assert_eq!(
            write_menu(&f.0, "shop.test", &f.dir(), &[], &missing.revision).unwrap_err().code,
            "err.projectWorkspaceConflict"
        );
        fs::remove_file(&path).unwrap();
        let item = crate::menu::MenuItem {
            id: "project_shop_action".into(),
            fields: BTreeMap::from([
                ("caption".into(), "Open tools".into()),
                ("category".into(), "projects\\shop.test".into()),
                ("command".into(), "echo {project_root}".into()),
            ]),
        };
        let saved = write_menu(&f.0, "shop.test", &f.dir(), &[item.clone()], &missing.revision).unwrap();
        assert!(saved.backup_path.is_none());
        assert_eq!(saved.document.items.len(), 1);
        let mut invalid = item;
        invalid.fields.insert("caption".into(), "unsafe\n[injected]".into());
        let previous = fs::read(&path).unwrap();
        assert_eq!(
            write_menu(&f.0, "shop.test", &f.dir(), &[invalid], &saved.document.revision).unwrap_err().code,
            "err.menuInvalid"
        );
        assert_eq!(fs::read(&path).unwrap(), previous);
        assert!(read_menu(&f.0, "unknown.test", &f.dir()).is_err());
        assert!(read_menu(&f.0, "shop.test", f.0.to_str().unwrap()).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn redirected_configuration_directory_is_rejected() {
        use std::os::windows::fs::symlink_dir;
        let f = Fixture::new();
        let outside = f.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = f.0.join("home/shared/.osp/nginx");
        if symlink_dir(&outside, &link).is_err() {
            return;
        }
        assert!(save(&f.0, "shop.test", &f.dir(), "nginx/shop.test.conf", None, "test").is_err());
        assert!(!outside.join("shop.test.conf").exists());
        fs::remove_dir(link).unwrap();
    }
}
