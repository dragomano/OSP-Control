//! Portable preferences. Read before every edit to retain hand-written TOML and unknown keys.

use crate::error::CommandError;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use toml_edit::{Array, DocumentMut, Item, Table, value};

type Values = BTreeMap<String, String>;
const TAG_PREFIX: &str = "ospanel.projectTags.v1:";
const MENU_PREFIX: &str = "ospanel.menuTree.";
const FIELDS: &[(&str, &str, &str, &str)] = &[
    ("ospanel.lang", "interface", "language", "string"),
    ("ospanel.theme", "interface", "theme", "string"),
    ("ospanel.accent", "interface", "accent", "string"),
    ("ospanel.font", "interface", "font", "string"),
    ("ospanel.scale", "interface", "scale", "integer"),
    ("ospanel.sidebar", "interface", "sidebar_collapsed", "bool"),
    ("ospanel.notify", "behavior", "notifications", "bool"),
    ("ospanel.autostartProjects", "behavior", "autostart_projects", "bool"),
    ("ospanel.closeToTray", "behavior", "close_to_tray", "bool"),
    ("ospanel.checkAppUpdates", "updates", "application", "bool"),
    ("ospanel.checkServiceUpdates", "updates", "modules", "bool"),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub values: Values,
    pub migration_needed: bool,
}

pub(crate) struct SettingsStore {
    path: PathBuf,
    legacy: Option<PathBuf>,
    lock: Mutex<()>,
}

fn invalid() -> CommandError {
    CommandError::new("err.settingsInvalid")
}
fn normalized(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}
fn array(strings: &[String]) -> Item {
    let mut result = Array::new();
    for s in strings {
        result.push(s);
    }
    value(result)
}
fn put(parent: &mut Item, key: &str, mut next: Item) {
    // Keep the value's leading whitespace and trailing comment when replacing it.
    if let (Some(old), Some(new)) = (parent.get(key).and_then(Item::as_value), next.as_value_mut()) {
        *new.decor_mut() = old.decor().clone();
    }
    parent[key] = next;
}
fn section(doc: &mut DocumentMut, name: &str) -> Result<(), CommandError> {
    if doc.get(name).is_none() {
        doc[name] = Item::Table(Table::new());
    }
    if !doc[name].is_table() {
        return Err(invalid());
    }
    Ok(())
}
fn strings(item: &Item) -> Result<Vec<String>, CommandError> {
    item.as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect()
}
fn valid_scalar(key: &str, v: &str) -> bool {
    match key {
        "ospanel.lang" => crate::paths::is_valid_lang(v),
        "ospanel.theme" => ["system", "dark", "light"].contains(&v),
        "ospanel.accent" => ["orange", "blue", "green", "purple", "red", "pink"].contains(&v),
        "ospanel.font" => ["dm-sans", "segoe", "arial", "tahoma", "verdana", "consolas"].contains(&v),
        "ospanel.scale" => v.parse::<i64>().is_ok_and(|n| (80..=130).contains(&n)),
        _ => ["0", "1"].contains(&v),
    }
}
fn active(doc: &DocumentMut) -> Option<&str> {
    doc.get("connection")?.get("installation")?.as_str()
}
fn installation(doc: &mut DocumentMut, root: &str) -> Result<String, CommandError> {
    section(doc, "installations")?;
    let target = normalized(root);
    let table = doc["installations"].as_table().ok_or_else(invalid)?;
    if let Some((id, _)) = table
        .iter()
        .find(|(_, item)| item.get("path").and_then(Item::as_str).is_some_and(|p| normalized(p) == target))
    {
        return Ok(id.into());
    }
    let mut id = "main".to_string();
    let mut n = 2;
    while doc["installations"].get(&id).is_some() {
        id = format!("installation_{n}");
        n += 1;
    }
    doc["installations"][&id] = Item::Table(Table::new());
    doc["installations"][&id]["path"] = value(root);
    Ok(id)
}
fn set_value(doc: &mut DocumentMut, key: &str, text: &str) -> Result<(), CommandError> {
    if let Some((_, group, field, kind)) = FIELDS.iter().find(|(k, ..)| *k == key) {
        if !valid_scalar(key, text) {
            return Err(invalid());
        }
        section(doc, group)?;
        let next = match *kind {
            "integer" => value(text.parse::<i64>().map_err(|_| invalid())?),
            "bool" => value(text == "1"),
            _ => value(text),
        };
        put(&mut doc[group], field, next);
    } else if key == "ospanel.path" {
        if text.trim().is_empty() || text.chars().any(char::is_control) {
            return Err(invalid());
        }
        section(doc, "connection")?;
        // Rebinding the active installation keeps its identity (and project metadata) stable.
        let matching = doc.get("installations").and_then(Item::as_table).and_then(|t| {
            t.iter()
                .find(|(_, i)| {
                    i.get("path").and_then(Item::as_str).is_some_and(|p| normalized(p) == normalized(text))
                })
                .map(|(id, _)| id.to_owned())
        });
        let id = if let Some(id) = matching {
            id
        } else if let Some(id) = active(doc).map(str::to_owned) {
            put(&mut doc["installations"][&id], "path", value(text));
            id
        } else {
            installation(doc, text)?
        };
        put(&mut doc["connection"], "installation", value(id));
    } else if let Some(root) = key.strip_prefix(TAG_PREFIX) {
        let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| invalid())?;
        if parsed["version"] != 1 {
            return Err(invalid());
        }
        let projects = parsed["projects"].as_object().ok_or_else(invalid)?;
        let id = installation(doc, root)?;
        let metadata = &mut doc["installations"][&id];
        if metadata.get("projects").is_none() {
            metadata["projects"] = Item::Table(Table::new());
        }
        let existing = metadata["projects"]
            .as_table()
            .ok_or_else(invalid)?
            .iter()
            .map(|(domain, _)| domain.to_owned())
            .collect::<Vec<_>>();
        for domain in existing {
            if !projects.contains_key(&domain) {
                metadata["projects"][&domain].as_table_mut().ok_or_else(invalid)?.remove("tags");
            }
        }
        for (domain, tags) in projects {
            if domain.is_empty() || domain.len() > 253 || domain.chars().any(char::is_control) {
                return Err(invalid());
            }
            let tags = tags
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
                .collect::<Result<Vec<_>, _>>()?;
            if tags.len() > 12
                || tags
                    .iter()
                    .any(|t| t.is_empty() || t.chars().count() > 32 || t.chars().any(char::is_control))
            {
                return Err(invalid());
            }
            if metadata["projects"].get(domain).is_none() {
                metadata["projects"][domain] = Item::Table(Table::new());
            }
            put(&mut metadata["projects"][domain], "tags", array(&tags));
        }
        // Metadata discovered with the default OSPanel path also defines the initial active installation.
        if active(doc).is_none() {
            section(doc, "connection")?;
            doc["connection"]["installation"] = value(id);
        }
    } else if let Some(root) = key.strip_prefix(MENU_PREFIX) {
        let collapsed: Vec<String> = serde_json::from_str(text).map_err(|_| invalid())?;
        let id = installation(doc, root)?;
        put(&mut doc["installations"][&id], "collapsed_menu_categories", array(&collapsed));
        if active(doc).is_none() {
            section(doc, "connection")?;
            doc["connection"]["installation"] = value(id);
        }
    } else {
        return Err(invalid());
    }
    Ok(())
}

fn values(doc: &DocumentMut) -> Result<Values, CommandError> {
    if doc.get("schema_version").is_some_and(|v| v.as_integer() != Some(1)) {
        return Err(invalid());
    }
    let mut result = Values::new();
    for (key, group, field, kind) in FIELDS {
        if let Some(parent) = doc.get(group) {
            if !parent.is_table() {
                return Err(invalid());
            }
            if let Some(item) = parent.get(field) {
                let text = match *kind {
                    "integer" => item.as_integer().ok_or_else(invalid)?.to_string(),
                    "bool" => if item.as_bool().ok_or_else(invalid)? { "1" } else { "0" }.into(),
                    _ => item.as_str().ok_or_else(invalid)?.into(),
                };
                if !valid_scalar(key, &text) {
                    return Err(invalid());
                }
                result.insert((*key).into(), text);
            }
        }
    }
    if let Some(connection) = doc.get("connection") {
        if !connection.is_table() || connection.get("installation").is_some_and(|v| v.as_str().is_none()) {
            return Err(invalid());
        }
    }
    if let Some(installations) = doc.get("installations") {
        for (id, entry) in installations.as_table().ok_or_else(invalid)?.iter() {
            if !entry.is_table() {
                return Err(invalid());
            }
            let root = entry.get("path").and_then(Item::as_str).ok_or_else(invalid)?;
            if Some(id) == active(doc) && root != "default" {
                result.insert("ospanel.path".into(), root.into());
            }
            if let Some(collapsed) = entry.get("collapsed_menu_categories") {
                result.insert(
                    format!("{MENU_PREFIX}{}", normalized(root)),
                    serde_json::to_string(&strings(collapsed)?).map_err(|_| invalid())?,
                );
            }
            if let Some(projects) = entry.get("projects") {
                let mut tags = BTreeMap::new();
                for (domain, project) in projects.as_table().ok_or_else(invalid)?.iter() {
                    if !project.is_table() {
                        return Err(invalid());
                    }
                    if let Some(list) = project.get("tags") {
                        let list = strings(list)?;
                        if list.len() > 12
                            || list.iter().any(|t| {
                                t.is_empty() || t.chars().count() > 32 || t.chars().any(char::is_control)
                            })
                        {
                            return Err(invalid());
                        }
                        tags.insert(domain, list);
                    }
                }
                result.insert(
                    format!("{TAG_PREFIX}{}", normalized(root)),
                    serde_json::json!({"version":1,"projects":tags}).to_string(),
                );
            }
        }
    }
    if let Some(id) = active(doc) {
        if doc.get("installations").and_then(|i| i.get(id)).is_none() {
            return Err(invalid());
        }
    }
    Ok(result)
}

impl SettingsStore {
    pub fn for_app(app: &tauri::AppHandle) -> Result<Self, CommandError> {
        let exe = std::env::current_exe()?;
        let path = exe.parent().ok_or_else(invalid)?.join("settings.toml");
        let legacy = app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"));
        Ok(Self { path, legacy, lock: Mutex::new(()) })
    }
    fn read(&self) -> Result<Option<DocumentMut>, CommandError> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if text.len() > 8 * 1024 * 1024 {
            return Err(invalid());
        }
        let doc = text.parse::<DocumentMut>().map_err(|_| invalid())?;
        values(&doc)?;
        Ok(Some(doc))
    }
    fn legacy_values(&self) -> Result<Values, CommandError> {
        let Some(path) = &self.legacy else {
            return Ok(Values::new());
        };
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Values::new()),
            Err(e) => return Err(e.into()),
        };
        let legacy: serde_json::Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        let mut result = Values::new();
        if let Some(v) = legacy["close_to_tray"].as_bool() {
            result.insert("ospanel.closeToTray".into(), if v { "1" } else { "0" }.into());
        }
        if let Some(v) = legacy["lang"].as_str().filter(|v| crate::paths::is_valid_lang(v)) {
            result.insert("ospanel.lang".into(), v.into());
        }
        Ok(result)
    }
    pub fn load(&self) -> Result<Snapshot, CommandError> {
        let _guard = self.lock.lock().map_err(|_| invalid())?;
        let doc = self.read().map_err(|e| self.error(e))?;
        Ok(Snapshot {
            values: match &doc {
                Some(doc) => values(doc)?,
                None => self.legacy_values().map_err(|e| self.error(e))?,
            },
            migration_needed: doc.is_none(),
        })
    }
    fn error(&self, e: CommandError) -> CommandError {
        CommandError::new(if e.code == "err.settingsInvalid" {
            "err.settingsInvalid"
        } else {
            "err.settingsSaveFailed"
        })
        .with("path", self.path.display().to_string())
    }
    pub fn save(&self, updates: Values, migration: bool) -> Result<Snapshot, CommandError> {
        let _guard = self.lock.lock().map_err(|_| invalid())?;
        let existing = self.read().map_err(|e| self.error(e))?;
        if migration && existing.is_some() {
            return Ok(Snapshot { values: values(&existing.unwrap())?, migration_needed: false });
        }
        let before = existing.as_ref().map(ToString::to_string);
        let mut doc = existing.unwrap_or_default();
        let mut updates = updates;
        if migration {
            for (key, value) in self.legacy_values().map_err(|e| self.error(e))? {
                updates.entry(key).or_insert(value);
            }
        }
        // Path migration follows metadata migration, so the selected installation can be matched.
        let root = updates.remove("ospanel.path");
        for (key, text) in updates {
            if values(&doc)?.get(&key) == Some(&text) {
                continue;
            }
            if migration {
                let mut candidate = doc.clone();
                if set_value(&mut candidate, &key, &text).is_ok() {
                    doc = candidate;
                }
            } else {
                set_value(&mut doc, &key, &text).map_err(|e| self.error(e))?;
            }
        }
        if let Some(root) = root {
            if migration {
                let id = installation(&mut doc, &root).map_err(|e| self.error(e))?;
                put(&mut doc["installations"][&id], "path", value(&root));
                section(&mut doc, "connection")?;
                doc["connection"]["installation"] = value(id);
            } else if values(&doc)?.get("ospanel.path") != Some(&root) {
                set_value(&mut doc, "ospanel.path", &root).map_err(|e| self.error(e))?;
            }
        }
        let snapshot = values(&doc).map_err(|e| self.error(e))?;
        if !snapshot.is_empty() && before.as_deref() != Some(&doc.to_string()) {
            if doc.get("schema_version").is_none() {
                doc["schema_version"] = value(1);
            }
            self.write(&doc.to_string()).map_err(|e| self.error(e))?;
            if migration {
                if let Some(path) = &self.legacy {
                    if path.exists() {
                        let _ = fs::rename(path, path.with_extension("json.migrated"));
                    }
                }
            }
        }
        Ok(Snapshot { values: snapshot, migration_needed: false })
    }
    fn write(&self, text: &str) -> Result<(), CommandError> {
        // A unique, exclusively created sibling prevents partial writes and stale-temp collisions.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_nanos();
        let temporary = self.path.with_extension(format!("toml.{}.{}.tmp", std::process::id(), nonce));
        let backup_temp = temporary.with_extension("bak.tmp");
        let result = (|| {
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
            drop(f);
            if self.path.exists() {
                let mut original = fs::File::open(&self.path)?;
                let mut backup = fs::OpenOptions::new().write(true).create_new(true).open(&backup_temp)?;
                std::io::copy(&mut original, &mut backup)?;
                backup.sync_all()?;
                drop(backup);
                replace(&backup_temp, &self.path.with_extension("toml.bak"))?;
            }
            replace(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
            let _ = fs::remove_file(backup_temp);
        }
        result
    }
}

fn replace(source: &Path, target: &Path) -> Result<(), CommandError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW},
            core::PCWSTR,
        };
        let a: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| CommandError::new("err.settingsSaveFailed"))?;
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, target)?;
    Ok(())
}

#[tauri::command]
pub fn load_settings(store: tauri::State<'_, SettingsStore>) -> Result<Snapshot, CommandError> {
    store.load()
}
#[tauri::command]
pub fn save_settings(
    store: tauri::State<'_, SettingsStore>,
    updates: Values,
) -> Result<Snapshot, CommandError> {
    store.save(updates, false)
}
#[tauri::command]
pub fn migrate_settings(
    store: tauri::State<'_, SettingsStore>,
    legacy: Values,
) -> Result<Snapshot, CommandError> {
    store.save(legacy, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        store: SettingsStore,
    }
    impl Fixture {
        fn new() -> Self {
            let nonce =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-settings-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            let store = SettingsStore {
                path: root.join("settings.toml"),
                legacy: Some(root.join("settings.json")),
                lock: Mutex::new(()),
            };
            Self { root, store }
        }
        fn save(&self, key: &str, text: &str) -> Snapshot {
            self.store.save([(key.into(), text.into())].into(), false).unwrap()
        }
        fn text(&self) -> String {
            fs::read_to_string(&self.store.path).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn fresh_launch_and_empty_migration_do_not_create_files() {
        let f = Fixture::new();
        assert!(f.store.load().unwrap().values.is_empty());
        f.store.save(Values::new(), true).unwrap();
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 0);
        f.save("ospanel.theme", "dark");
        assert_eq!(f.store.load().unwrap().values["ospanel.theme"], "dark");
        assert_eq!(f.text().parse::<DocumentMut>().unwrap()["schema_version"].as_integer(), Some(1));
    }
    #[test]
    fn preserves_comments_unknown_keys_and_unmodified_formatting() {
        let f = Fixture::new();
        let before = "# User preferences\nschema_version = 1\n\n[interface]\ntheme   = 'dark' # favourite\nfont = 'segoe'\n\n[custom]\nanswer = 42 # leave this\n";
        fs::write(&f.store.path, before).unwrap();
        f.save("ospanel.theme", "dark");
        assert_eq!(f.text(), before);
        assert!(!f.store.path.with_extension("toml.bak").exists());
        f.save("ospanel.theme", "light");
        assert!(f.text().contains("# User preferences"));
        assert!(f.text().contains("# favourite"));
        assert!(f.text().contains("font = 'segoe'"));
        assert!(f.text().contains("answer = 42 # leave this"));
        assert_eq!(fs::read_to_string(f.store.path.with_extension("toml.bak")).unwrap(), before);
    }
    #[test]
    fn invalid_and_future_files_are_never_overwritten() {
        let f = Fixture::new();
        for raw in [
            "[broken",
            "schema_version = 2",
            "[interface]\nscale = 'big'",
            "[behavior]\nclose_to_tray = 1",
            "[connection]\ninstallation = 'missing'",
        ] {
            fs::write(&f.store.path, raw).unwrap();
            assert_eq!(f.store.load().unwrap_err().code, "err.settingsInvalid");
            assert!(f.store.save([("ospanel.theme".into(), "dark".into())].into(), false).is_err());
            assert_eq!(f.text(), raw);
        }
    }
    #[test]
    fn migration_merges_native_and_webview_data_once_and_keeps_scopes() {
        let f = Fixture::new();
        fs::write(f.store.legacy.as_ref().unwrap(), r#"{"lang":"ru","close_to_tray":true}"#).unwrap();
        assert_eq!(f.store.load().unwrap().values["ospanel.closeToTray"], "1");
        let tags_a = r#"{"version":1,"projects":{"shop.test":{"invalid":true}}}"#;
        let tags_b = r#"{"version":1,"projects":{"api.test":["Laravel","Клиент"]}}"#;
        let old = [
            ("ospanel.lang", "en"),
            ("ospanel.theme", "light"),
            ("ospanel.path", r"D:\OSPanel6"),
            ("ospanel.projectTags.v1:c:/osp", tags_a),
            ("ospanel.projectTags.v1:d:/ospanel6", tags_b),
            ("ospanel.menuTree.d:/ospanel6", r#"["Development"]"#),
            ("ospanel.demoMenu", "ignored"),
        ]
        .map(|(k, v)| (k.into(), v.into()))
        .into();
        let snapshot = f.store.save(old, true).unwrap();
        assert_eq!(snapshot.values["ospanel.lang"], "en");
        assert_eq!(snapshot.values["ospanel.closeToTray"], "1");
        assert_eq!(snapshot.values["ospanel.path"], r"D:\OSPanel6");
        assert!(snapshot.values["ospanel.projectTags.v1:d:/ospanel6"].contains("Laravel"));
        assert!(!f.store.legacy.as_ref().unwrap().exists());
        assert!(f.root.join("settings.json.migrated").exists());
        let before = f.text();
        f.store.save([("ospanel.lang".into(), "es".into())].into(), true).unwrap();
        assert_eq!(f.text(), before);
    }
    #[test]
    fn path_change_keeps_installation_identity_and_tags() {
        let f = Fixture::new();
        f.save("ospanel.path", r"D:\OSPanel6");
        f.save("ospanel.projectTags.v1:d:/ospanel6", r#"{"version":1,"projects":{"shop.test":["Клиент"]}}"#);
        let before = f.text().parse::<DocumentMut>().unwrap()["connection"]["installation"]
            .as_str()
            .unwrap()
            .to_string();
        let snapshot = f.save("ospanel.path", r"E:\MovedPanel");
        assert_eq!(
            f.text().parse::<DocumentMut>().unwrap()["connection"]["installation"].as_str(),
            Some(before.as_str())
        );
        assert!(snapshot.values["ospanel.projectTags.v1:e:/movedpanel"].contains("Клиент"));
        assert!(!snapshot.values.contains_key("ospanel.projectTags.v1:d:/ospanel6"));
    }

    #[test]
    fn migration_selects_custom_path_without_rebinding_another_installation() {
        let f = Fixture::new();
        let data = r#"{"version":1,"projects":{"shop.test":["Client"]}}"#;
        let snapshot = f
            .store
            .save(
                [
                    ("ospanel.path".into(), r"E:\SelectedPanel".into()),
                    ("ospanel.projectTags.v1:c:/oldpanel".into(), data.into()),
                    ("ospanel.projectTags.v1:d:/ospanel6".into(), data.into()),
                ]
                .into(),
                true,
            )
            .unwrap();
        assert_eq!(snapshot.values["ospanel.path"], r"E:\SelectedPanel");
        assert!(snapshot.values.contains_key("ospanel.projectTags.v1:c:/oldpanel"));
        assert!(snapshot.values.contains_key("ospanel.projectTags.v1:d:/ospanel6"));
        assert_eq!(f.text().parse::<DocumentMut>().unwrap()["installations"].as_table().unwrap().len(), 3);
    }
    #[test]
    fn tag_update_retains_project_notes_and_unrelated_metadata() {
        let f = Fixture::new();
        fs::write(&f.store.path, "schema_version=1\n[installations.main]\npath='D:\\OSPanel6'\n[installations.main.projects.'shop.test']\n# important\ntags=['Old'] # tags comment\nnote='Keep'\n").unwrap();
        f.save("ospanel.projectTags.v1:d:/ospanel6", r#"{"version":1,"projects":{"shop.test":["New"]}}"#);
        assert!(f.text().contains("# important"));
        assert!(f.text().contains("# tags comment"));
        assert!(f.text().contains("note='Keep'"));
        f.save("ospanel.projectTags.v1:d:/ospanel6", r#"{"version":1,"projects":{}}"#);
        assert!(f.text().contains("note='Keep'"));
    }
    #[test]
    fn failed_backup_or_invalid_update_leaves_original_intact() {
        let f = Fixture::new();
        f.save("ospanel.theme", "dark");
        let before = f.text();
        fs::create_dir(f.store.path.with_extension("toml.bak")).unwrap();
        assert!(f.store.save([("ospanel.theme".into(), "light".into())].into(), false).is_err());
        assert!(f.store.save([("ospanel.theme".into(), "unknown".into())].into(), false).is_err());
        assert_eq!(f.text(), before);
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
    }
    #[test]
    fn concurrent_saves_are_serialized_and_reread_manual_changes() {
        let f = Fixture::new();
        std::thread::scope(|s| {
            s.spawn(|| {
                f.save("ospanel.theme", "light");
            });
            s.spawn(|| {
                f.save("ospanel.lang", "uk");
            });
        });
        let mut text = f.text();
        text.push_str("\n[manual]\nanswer = 42\n");
        fs::write(&f.store.path, text).unwrap();
        f.save("ospanel.scale", "110");
        let snapshot = f.store.load().unwrap();
        assert_eq!(snapshot.values["ospanel.lang"], "uk");
        assert_eq!(snapshot.values["ospanel.theme"], "light");
        assert!(f.text().contains("answer = 42"));
    }

    #[test]
    fn replacing_settings_and_backup_does_not_modify_external_hard_links() {
        let f = Fixture::new();
        let external = f.root.join("external.toml");
        fs::write(&external, "schema_version=1\n[interface]\ntheme='dark'\n").unwrap();
        fs::hard_link(&external, &f.store.path).unwrap();
        fs::hard_link(&external, f.store.path.with_extension("toml.bak")).unwrap();
        let before = fs::read_to_string(&external).unwrap();
        f.save("ospanel.theme", "light");
        f.save("ospanel.scale", "110");
        assert_eq!(fs::read_to_string(&external).unwrap(), before);
    }
}
