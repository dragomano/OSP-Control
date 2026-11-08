//! Module profiles are editable user configuration, never the factory originals.
use crate::{
    error::{CommandError, spawn_failed},
    panel_api::{api_json, dat_field, dat_string_value},
    paths::{copy_dir_recursive, external_path, hidden_command, is_valid_module_name, resolve_installation},
    update_files::safe_tree,
};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILE: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileInfo {
    name: String,
    builtin: bool,
    has_data: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profiles {
    active: String,
    online: bool,
    profiles: Vec<ProfileInfo>,
    factory_available: bool,
    factory_data: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileFile {
    name: String,
    size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDocument {
    files: Vec<ProfileFile>,
    path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSave {
    content: String,
    backup_path: String,
}

fn invalid() -> CommandError {
    CommandError::new("err.profileName")
}
// Parent lookups inspect only that component: traversing all modules or database
// files on every profile read would make large installations unnecessarily slow.
fn child(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let path = parent.join(name);
    let metadata = fs::symlink_metadata(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(CommandError::new("err.accessDenied"));
        }
    }
    if metadata.file_type().is_symlink() {
        return Err(CommandError::new("err.accessDenied"));
    }
    let path = fs::canonicalize(path)?;
    if path.parent() != Some(fs::canonicalize(parent)?.as_path()) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(path)
}
fn nonce() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
}
fn valid_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    (1..=100).contains(&name.len())
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"-+_.".contains(&c))
        && ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
            "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
}
fn installation(custom: Option<&str>) -> Result<PathBuf, CommandError> {
    Ok(fs::canonicalize(resolve_installation(custom)?)?)
}
fn module_dir(root: &Path, module: &str) -> Result<PathBuf, CommandError> {
    if !is_valid_module_name(module) {
        return Err(CommandError::new("err.invalidModuleName"));
    }
    let config = child(root, "config")?;
    child(&config, module)
}
fn profile_dir(root: &Path, module: &str, profile: &str) -> Result<PathBuf, CommandError> {
    if !valid_name(profile) {
        return Err(invalid());
    }
    let dir = child(&module_dir(root, module)?, profile)?;
    if !dir.is_dir() || !dir.join("settings.ini").is_file() {
        return Err(CommandError::new("err.profileMissing"));
    }
    safe_tree(&dir)?;
    Ok(dir)
}
fn factory(root: &Path, module: &str) -> Result<PathBuf, CommandError> {
    if !is_valid_module_name(module) {
        return Err(CommandError::new("err.invalidModuleName"));
    }
    child(&child(&child(root, "modules")?, module)?, "ospanel_data")
}
fn is_builtin(root: &Path, module: &str, name: &str) -> bool {
    name.eq_ignore_ascii_case("default")
        || factory(root, module)
            .ok()
            .and_then(|dir| child(&dir, name).ok())
            .is_some_and(|dir| dir.join("settings.ini").is_file())
}
fn ensure_dir(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let path = parent.join(name);
    if !path.exists() {
        fs::create_dir(&path)?;
    }
    child(parent, name)
}
fn data_parent(root: &Path, module: &str) -> Result<PathBuf, CommandError> {
    ensure_dir(&ensure_dir(root, "data")?, module)
}
fn data_dir(root: &Path, module: &str, name: &str) -> Result<Option<PathBuf>, CommandError> {
    let path = root.join("data").join(module).join(name);
    if !path.try_exists()? {
        return Ok(None);
    }
    Ok(Some(child(&child(&child(root, "data")?, module)?, name)?))
}
struct ModuleState {
    active: String,
    running: bool,
    enabled: bool,
}
fn state(root: &Path, module: &str) -> Result<ModuleState, CommandError> {
    let json = api_json(root, "/getmodules").ok_or_else(|| CommandError::new("err.profileOffline"))?;
    let node = dat_field(&json, module).ok_or_else(|| CommandError::new("err.serviceNotFound"))?;
    state_from_node(node)
}
fn state_from_node(node: &serde_json::Value) -> Result<ModuleState, CommandError> {
    let active = dat_field(node, "profile")
        .map(dat_string_value)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into());
    let handle = dat_field(node, "handle")
        .and_then(|n| n.get("_value"))
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| CommandError::new("err.profileOffline"))?;
    let enabled = match dat_field(node, "enabled").map(dat_string_value).as_deref() {
        Some("on" | "1" | "true") => true,
        Some("off" | "0" | "false") => false,
        _ => return Err(CommandError::new("err.profileOffline")),
    };
    Ok(ModuleState { active, running: handle != -1, enabled })
}
fn disk_active(dir: &Path) -> String {
    fs::read_to_string(dir.join("module.ini"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case("profile"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|s| valid_name(s))
        .unwrap_or_else(|| "default".into())
}
fn list(root: &Path, module: &str) -> Result<Profiles, CommandError> {
    let dir = module_dir(root, module)?;
    let current = state(root, module).ok();
    let mut profiles = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_name(&name) && entry.path().is_dir() && entry.path().join("settings.ini").is_file() {
            profile_dir(root, module, &name)?;
            profiles.push(ProfileInfo {
                builtin: is_builtin(root, module, &name),
                has_data: data_dir(root, module, &name)?.is_some(),
                name,
            });
        }
    }
    profiles.sort_by_key(|p| (!p.builtin, p.name.to_ascii_lowercase()));
    let source = factory(root, module).ok();
    let active = current.as_ref().map(|s| s.active.clone()).unwrap_or_else(|| disk_active(&dir));
    let active = profiles
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(&active))
        .map(|p| p.name.clone())
        .unwrap_or(active);
    Ok(Profiles {
        active,
        online: current.is_some(),
        profiles,
        factory_available: source.as_ref().is_some_and(|d| d.join("default/settings.ini").is_file()),
        factory_data: source.as_ref().is_some_and(|d| d.join("default_data").is_dir()),
    })
}
fn available(parent: &Path, name: &str) -> Result<(), CommandError> {
    if !valid_name(name) {
        return Err(invalid());
    }
    if fs::read_dir(parent)?
        .any(|entry| entry.is_ok_and(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)))
    {
        return Err(CommandError::new("err.profileExists"));
    }
    Ok(())
}
fn file_path(dir: &Path, file: &str) -> Result<PathBuf, CommandError> {
    let parts: Vec<_> = file.split('/').collect();
    if file != "settings.ini" && (parts.len() < 2 || parts[0] != "templates") {
        return Err(CommandError::new("err.accessDenied"));
    }
    let mut path = dir.to_path_buf();
    for part in parts {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
        {
            return Err(CommandError::new("err.accessDenied"));
        }
        path = child(&path, part)?;
    }
    if !path.is_file() || !path.starts_with(dir) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(path)
}
fn text(path: &Path) -> Result<String, CommandError> {
    if fs::metadata(path)?.len() > MAX_FILE as u64 {
        return Err(CommandError::new("err.profileFileSize"));
    }
    let bytes = fs::read(path)?;
    let text = String::from_utf8(bytes).map_err(|_| CommandError::new("err.profileEncoding"))?;
    if text.contains('\0') {
        return Err(CommandError::new("err.profileEncoding"));
    }
    Ok(text)
}
fn document(root: &Path, module: &str, profile: &str) -> Result<ProfileDocument, CommandError> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<ProfileFile>) -> Result<(), CommandError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                walk(&entry.path(), &name, out)?;
            } else {
                out.push(ProfileFile { name, size_bytes: entry.metadata()?.len() });
            }
        }
        Ok(())
    }
    let dir = profile_dir(root, module, profile)?;
    let mut files = vec![ProfileFile {
        name: "settings.ini".into(),
        size_bytes: fs::metadata(dir.join("settings.ini"))?.len(),
    }];
    if dir.join("templates").exists() {
        walk(&child(&dir, "templates")?, "templates", &mut files)?;
    }
    files.sort_by_key(|f| (f.name != "settings.ini", f.name.to_lowercase()));
    Ok(ProfileDocument { files, path: external_path(&dir).to_string_lossy().into_owned() })
}
fn snapshot(root: &Path, module: &str, profile: &str) -> Result<PathBuf, CommandError> {
    let dir = profile_dir(root, module, profile)?;
    let parent = ensure_dir(&ensure_dir(&ensure_dir(root, "backups")?, "module-profiles")?, module)?;
    let path = parent.join(format!("{profile}-{}", nonce()));
    fs::create_dir(&path)?;
    copy_dir_recursive(&dir, &path)?;
    safe_tree(&path)?;
    Ok(path)
}
fn save(
    root: &Path,
    module: &str,
    profile: &str,
    file: &str,
    original: &str,
    content: &str,
) -> Result<ProfileSave, CommandError> {
    if content.len() > MAX_FILE || content.contains('\0') {
        return Err(CommandError::new("err.profileFileSize"));
    }
    let dir = profile_dir(root, module, profile)?;
    let path = file_path(&dir, file)?;
    if text(&path)? != original {
        return Err(CommandError::new("err.profileConflict"));
    }
    let backup = snapshot(root, module, profile)?;
    let mut next = content.replace("\r\n", "\n");
    if original.contains("\r\n") && !original.replace("\r\n", "").contains('\n') {
        next = next.replace('\n', "\r\n");
    }
    if original.starts_with('\u{feff}') && !next.starts_with('\u{feff}') {
        next.insert(0, '\u{feff}');
    }
    if next.len() > MAX_FILE {
        return Err(CommandError::new("err.profileFileSize"));
    }
    let temporary = path.parent().unwrap().join(format!(".profile-{}.tmp", nonce()));
    let result = (|| -> Result<(), CommandError> {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        output.write_all(next.as_bytes())?;
        output.sync_all()?;
        drop(output);
        if file_path(&profile_dir(root, module, profile)?, file)? != path || text(&path)? != original {
            return Err(CommandError::new("err.profileConflict"));
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(ProfileSave { content: next, backup_path: external_path(&backup).to_string_lossy().into_owned() })
}
fn create(
    root: &Path,
    module: &str,
    name: &str,
    source: &str,
    factory_source: bool,
    copy_data: bool,
) -> Result<(), CommandError> {
    let parent = module_dir(root, module)?;
    available(&parent, name)?;
    if data_dir(root, module, name)?.is_some() {
        return Err(CommandError::new("err.profileExists"));
    }
    let source = if factory_source {
        child(&factory(root, module)?, "default")?
    } else {
        profile_dir(root, module, source)?
    };
    if !source.join("settings.ini").is_file() {
        return Err(CommandError::new("err.profileMissing"));
    }
    let data = if copy_data && !factory_source {
        let data = data_dir(root, module, source.file_name().unwrap().to_str().ok_or_else(invalid)?)?;
        if data.is_some() && state(root, module)?.running {
            let command = child(&child(root, "bin")?, "osp.bat")?;
            let status = hidden_command(&external_path(&command))
                .current_dir(external_path(root))
                .args(["off", module])
                .status()
                .map_err(spawn_failed)?;
            if !status.success() {
                return Err(CommandError::new("err.profileStopRequired"));
            }
            let mut stopped = false;
            for _ in 0..30 {
                if !state(root, module)?.running {
                    stopped = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if !stopped {
                return Err(CommandError::new("err.profileStopRequired"));
            }
        }
        data
    } else {
        let data = match factory(root, module).ok() {
            Some(factory) if factory.join("default_data").exists() => Some(child(&factory, "default_data")?),
            _ => None,
        };
        if data.is_none()
            && !factory_source
            && data_dir(root, module, source.file_name().unwrap().to_str().ok_or_else(invalid)?)?.is_some()
        {
            return Err(CommandError::new("err.profileDataMissing"));
        }
        data
    };
    let staging = parent.join(format!(".profile-{}", nonce()));
    fs::create_dir(&staging)?;
    let mut staged_data = None;
    let mut published_data = None;
    let result = (|| -> Result<(), CommandError> {
        safe_tree(&source)?;
        copy_dir_recursive(&source, &staging)?;
        if let Some(data) = data {
            safe_tree(&data)?;
            let parent = data_parent(root, module)?;
            available(&parent, name)?;
            let stage = parent.join(format!(".profile-{}", nonce()));
            fs::create_dir(&stage)?;
            staged_data = Some(stage.clone());
            copy_dir_recursive(&data, &stage)?;
            safe_tree(&stage)?;
            fs::rename(&stage, parent.join(name))?;
            published_data = Some(parent.join(name));
        }
        safe_tree(&staging)?;
        available(&parent, name)?;
        fs::rename(&staging, parent.join(name))?;
        Ok(())
    })();
    // These paths were created by this transaction, beneath verified installation parents.
    if result.is_err() {
        for path in [Some(staging), staged_data, published_data].into_iter().flatten() {
            if path.exists() && safe_tree(&path).is_ok() && fs::canonicalize(&path)?.starts_with(root) {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    result
}
fn editable_identity(root: &Path, module: &str, name: &str) -> Result<PathBuf, CommandError> {
    let dir = profile_dir(root, module, name)?;
    if is_builtin(root, module, name) {
        return Err(CommandError::new("err.profileBuiltin"));
    }
    if state(root, module)?.active.eq_ignore_ascii_case(name)
        || disk_active(&module_dir(root, module)?).eq_ignore_ascii_case(name)
    {
        return Err(CommandError::new("err.profileActive"));
    }
    Ok(dir)
}
fn rename(root: &Path, module: &str, name: &str, next: &str) -> Result<(), CommandError> {
    let dir = editable_identity(root, module, name)?;
    let parent = module_dir(root, module)?;
    available(&parent, next)?;
    let data = data_dir(root, module, name)?;
    if data_dir(root, module, next)?.is_some() {
        return Err(CommandError::new("err.profileExists"));
    }
    snapshot(root, module, name)?;
    if let Some(data) = &data {
        fs::rename(data, data.parent().unwrap().join(next))?;
    }
    if let Err(error) = fs::rename(&dir, parent.join(next)) {
        if let Some(data) = &data {
            fs::rename(data.parent().unwrap().join(next), data)?;
        }
        return Err(error.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_module_profiles(
    name: String,
    custom_path: Option<String>,
) -> Result<Profiles, CommandError> {
    tauri::async_runtime::spawn_blocking(move || list(&installation(custom_path.as_deref())?, &name))
        .await
        .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn read_module_profile(
    name: String,
    profile: String,
    custom_path: Option<String>,
) -> Result<ProfileDocument, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        document(&installation(custom_path.as_deref())?, &name, &profile)
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn read_profile_file(
    name: String,
    profile: String,
    file: String,
    custom_path: Option<String>,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = installation(custom_path.as_deref())?;
        text(&file_path(&profile_dir(&root, &name, &profile)?, &file)?)
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn save_profile_file(
    name: String,
    profile: String,
    file: String,
    original: String,
    content: String,
    custom_path: Option<String>,
) -> Result<ProfileSave, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        save(&installation(custom_path.as_deref())?, &name, &profile, &file, &original, &content)
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn create_module_profile(
    name: String,
    profile: String,
    source: String,
    factory_source: bool,
    copy_data: bool,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        create(&installation(custom_path.as_deref())?, &name, &profile, &source, factory_source, copy_data)
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn rename_module_profile(
    name: String,
    profile: String,
    next: String,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        rename(&installation(custom_path.as_deref())?, &name, &profile, &next)
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn delete_module_profile(
    name: String,
    profile: String,
    custom_path: Option<String>,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = installation(custom_path.as_deref())?;
        let dir = editable_identity(&root, &name, &profile)?;
        let backup = snapshot(&root, &name, &profile)?;
        fs::remove_dir_all(&dir)?;
        Ok(external_path(&backup).to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}
#[tauri::command]
pub async fn activate_module_profile(
    name: String,
    profile: String,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::module_updates::mutation()?;
        let root = installation(custom_path.as_deref())?;
        profile_dir(&root, &name, &profile)?;
        let enabled = state(&root, &name)?.enabled;
        let bin = child(&root, "bin")?;
        let command = child(&bin, "osp.bat")?;
        let action = if enabled { "restart" } else { "init" };
        let status = hidden_command(&external_path(&command))
            .current_dir(external_path(&root))
            .args([action, &name, &profile])
            .status()
            .map_err(spawn_failed)?;
        if !status.success() {
            return Err(CommandError::new("err.ospCommandFailed").with("cmd", action).with("name", &name));
        }
        for _ in 0..30 {
            if state(&root, &name).is_ok_and(|s| s.active.eq_ignore_ascii_case(&profile)) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err(CommandError::new("err.profileActivation"))
    })
    .await
    .map_err(|_| CommandError::new("err.profileFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("osp-profiles-{}-{}", std::process::id(), nonce()));
            fs::create_dir_all(root.join("config/Example/default/templates/nested")).unwrap();
            fs::create_dir_all(root.join("modules/Example/ospanel_data/default/templates")).unwrap();
            fs::write(root.join("config/Example/module.ini"), "[main]\nprofile = default\nenabled = 0\n")
                .unwrap();
            fs::write(
                root.join("config/Example/default/settings.ini"),
                "[main]\r\n; Keep this comment\r\nip = 127.0.1.10\r\ncustom_option = yes\r\n",
            )
            .unwrap();
            fs::write(
                root.join("config/Example/default/templates/nested/example.conf"),
                b"example = original\n",
            )
            .unwrap();
            fs::write(
                root.join("modules/Example/ospanel_data/default/settings.ini"),
                b"[main]\nfactory = yes\n",
            )
            .unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path()));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn names_reject_shell_arguments_reserved_names_and_traversal() {
        for value in [
            "",
            ".",
            "..",
            "../default",
            "a\\b",
            "test&echo",
            "a b",
            "a:stream",
            "nul",
            "CON.ini",
            "COM1",
            "name.",
            ".hidden",
        ] {
            assert!(!valid_name(value), "{value}");
        }
        for value in ["default", "development", "test+debug", "local_2.0"] {
            assert!(valid_name(value), "{value}");
        }
    }
    #[test]
    fn api_state_distinguishes_disabled_modules_from_failed_or_starting_enabled_modules() {
        let node = serde_json::json!({"_children": [
            {"key":"profile", "value":{"_value":"testing"}},
            {"key":"handle", "value":{"_value":-1}},
            {"key":"enabled", "value":{"_value":true}}
        ]});
        let state = state_from_node(&node).unwrap();
        assert_eq!(state.active, "testing");
        assert!(!state.running);
        assert!(state.enabled);
        let mut disabled = node;
        disabled["_children"][2]["value"]["_value"] = false.into();
        assert!(!state_from_node(&disabled).unwrap().enabled);
        disabled["_children"][1]["value"]["_value"] = serde_json::Value::Null;
        assert!(state_from_node(&disabled).is_err());
    }
    #[test]
    fn creating_a_copy_preserves_nested_templates_comments_and_source() {
        let f = Fixture::new();
        create(&f.0, "Example", "debug+local", "default", false, false).unwrap();
        let source = fs::read(f.0.join("config/Example/default/settings.ini")).unwrap();
        assert_eq!(fs::read(f.0.join("config/Example/debug+local/settings.ini")).unwrap(), source);
        assert_eq!(
            fs::read(f.0.join("config/Example/debug+local/templates/nested/example.conf")).unwrap(),
            b"example = original\n"
        );
        assert_eq!(disk_active(&module_dir(&f.0, "Example").unwrap()), "default");
        assert_eq!(
            create(&f.0, "Example", "DEBUG+LOCAL", "default", false, false).unwrap_err().code,
            "err.profileExists"
        );
    }
    #[test]
    fn factory_profiles_are_copied_with_fresh_data_and_never_modified() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("modules/Example/ospanel_data/default_data")).unwrap();
        fs::write(f.0.join("modules/Example/ospanel_data/default_data/initial.dat"), b"clean").unwrap();
        create(&f.0, "Example", "clean", "", true, false).unwrap();
        assert_eq!(fs::read(f.0.join("data/Example/clean/initial.dat")).unwrap(), b"clean");
        assert_eq!(
            fs::read(f.0.join("config/Example/clean/settings.ini")).unwrap(),
            b"[main]\nfactory = yes\n"
        );
        assert_eq!(
            fs::read(f.0.join("modules/Example/ospanel_data/default/settings.ini")).unwrap(),
            b"[main]\nfactory = yes\n"
        );
    }
    #[test]
    fn saving_builtin_settings_keeps_a_backup_crlf_and_unknown_options() {
        let f = Fixture::new();
        let file = f.0.join("config/Example/default/settings.ini");
        let original = text(&file).unwrap();
        let next = original.replace("127.0.1.10", "127.0.1.20").replace("\r\n", "\n");
        let saved = save(&f.0, "Example", "default", "settings.ini", &original, &next).unwrap();
        assert!(saved.content.contains("custom_option = yes\r\n"));
        assert_eq!(fs::read_to_string(Path::new(&saved.backup_path).join("settings.ini")).unwrap(), original);
        assert_eq!(text(&file).unwrap(), saved.content);
        fs::write(&file, "external edit").unwrap();
        assert_eq!(
            save(&f.0, "Example", "default", "settings.ini", &saved.content, "replacement")
                .err()
                .unwrap()
                .code,
            "err.profileConflict"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "external edit");
    }
    #[test]
    fn editing_cannot_reach_module_ini_factory_files_or_other_profiles() {
        let f = Fixture::new();
        let dir = profile_dir(&f.0, "Example", "default").unwrap();
        for file in [
            "module.ini",
            "../module.ini",
            "templates/../../module.ini",
            "templates\\example.conf",
            "C:/other.ini",
            "settings.ini:stream",
        ] {
            assert!(file_path(&dir, file).is_err(), "{file}");
        }
        assert!(file_path(&dir, "templates/nested/example.conf").is_ok());
        assert_eq!(editable_identity(&f.0, "Example", "default").err().unwrap().code, "err.profileBuiltin");
        assert_eq!(document(&f.0, "Example", "default").unwrap().files.len(), 2);
    }
    #[test]
    fn existing_orphan_data_is_not_overwritten_and_failed_creations_publish_nothing() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("data/Example/orphan")).unwrap();
        fs::write(f.0.join("data/Example/orphan/database.dat"), b"keep").unwrap();
        assert_eq!(
            create(&f.0, "Example", "orphan", "default", false, false).unwrap_err().code,
            "err.profileExists"
        );
        assert!(!f.0.join("config/Example/orphan").exists());
        assert_eq!(fs::read(f.0.join("data/Example/orphan/database.dat")).unwrap(), b"keep");
        fs::create_dir_all(f.0.join("data/Example/default")).unwrap();
        assert_eq!(
            create(&f.0, "Example", "missing-data", "default", false, false).unwrap_err().code,
            "err.profileDataMissing"
        );
        assert!(!f.0.join("config/Example/missing-data").exists());
    }
    #[test]
    fn non_utf8_and_binary_files_are_never_lossily_rewritten() {
        let f = Fixture::new();
        let file = f.0.join("config/Example/default/settings.ini");
        fs::write(&file, [0xff, 0xfe]).unwrap();
        assert_eq!(text(&file).unwrap_err().code, "err.profileEncoding");
        fs::write(&file, b"data\0binary").unwrap();
        assert_eq!(text(&file).unwrap_err().code, "err.profileEncoding");
    }
    #[test]
    fn atomic_save_does_not_modify_factory_hard_links_and_preserves_bom() {
        let f = Fixture::new();
        let factory = f.0.join("modules/Example/ospanel_data/default/settings.ini");
        let file = f.0.join("config/Example/default/settings.ini");
        fs::write(&factory, "\u{feff}[main]\r\nvalue = original\r\n").unwrap();
        fs::remove_file(&file).unwrap();
        fs::hard_link(&factory, &file).unwrap();
        let original = text(&file).unwrap();
        let saved =
            save(&f.0, "Example", "default", "settings.ini", &original, "[main]\nvalue = changed\n").unwrap();
        assert_eq!(saved.content, "\u{feff}[main]\r\nvalue = changed\r\n");
        assert_eq!(text(&factory).unwrap(), original);
    }
}
