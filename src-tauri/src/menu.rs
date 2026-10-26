//! Lossless menu.dat editing. Commands are configuration data and are never executed here.

use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::CommandError, paths::resolve_installation, update_files::safe_tree};

const MAX_BYTES: usize = 2 * 1024 * 1024;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MenuItem {
    id: String,
    fields: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MenuDocument {
    items: Vec<MenuItem>,
    revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MenuSaveResult {
    document: MenuDocument,
    backup_path: Option<String>,
}

struct Section {
    item: MenuItem,
    header: String,
    lines: Vec<String>,
}

fn invalid() -> CommandError {
    CommandError::new("err.menuInvalid")
}

fn revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 128 && !id.chars().any(|c| c.is_control() || "[]".contains(c))
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
}

fn property(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.starts_with([';', '#']) {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}

fn parse(content: &str) -> Result<(String, Vec<Section>), CommandError> {
    if content.len() > MAX_BYTES || content.contains('\0') {
        return Err(invalid());
    }
    let mut preamble = String::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut ids = HashSet::new();
    for line in content.split_inclusive('\n') {
        let text = line.trim_start_matches('\u{feff}').trim();
        if text.starts_with('[') {
            let end = text.find(']').ok_or_else(invalid)?;
            let id = text[1..end].trim();
            let suffix = text[end + 1..].trim();
            if !valid_id(id)
                || (!suffix.is_empty() && !suffix.starts_with([';', '#']))
                || !ids.insert(id.to_lowercase())
                || sections.len() >= 2000
            {
                return Err(invalid());
            }
            // A BOM belongs to the document, not the section that may be moved or deleted.
            if line.starts_with('\u{feff}') {
                preamble.push('\u{feff}');
            }
            sections.push(Section {
                item: MenuItem { id: id.into(), fields: BTreeMap::new() },
                header: line.trim_start_matches('\u{feff}').into(),
                lines: Vec::new(),
            });
        } else if let Some(section) = sections.last_mut() {
            if let Some((key, value)) = property(line) {
                if !valid_key(key)
                    || section.item.fields.insert(key.to_ascii_lowercase(), value.into()).is_some()
                {
                    return Err(invalid());
                }
            } else if !text.is_empty() && !text.starts_with([';', '#']) {
                return Err(invalid());
            }
            section.lines.push(line.into());
        } else if text.is_empty() || text.starts_with([';', '#']) {
            preamble.push_str(line);
        } else {
            return Err(invalid());
        }
    }
    Ok((preamble, sections))
}

fn document(content: &str) -> Result<MenuDocument, CommandError> {
    let (_, sections) = parse(content)?;
    Ok(MenuDocument { items: sections.into_iter().map(|s| s.item).collect(), revision: revision(content) })
}

fn render(original: &str, items: &[MenuItem]) -> Result<String, CommandError> {
    let (mut output, sections) = parse(original)?;
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let mut ids = HashSet::new();
    if items.len() > 2000 {
        return Err(invalid());
    }
    if items
        .iter()
        .filter(|item| item.fields.get("need_alias").is_some_and(|v| v.eq_ignore_ascii_case("on")))
        .count()
        > 1
    {
        return Err(CommandError::new("err.menuAliasRepeated"));
    }
    for item in items {
        if !valid_id(&item.id) || !ids.insert(item.id.to_lowercase()) || item.fields.len() > 128 {
            return Err(invalid());
        }
        for (key, value) in &item.fields {
            if !valid_key(key)
                || key != &key.to_ascii_lowercase()
                || value.len() > 32768
                || value.chars().any(|c| c.is_control() && c != '\t')
            {
                return Err(invalid());
            }
        }
        if !output.is_empty() && !output.ends_with(['\n', '\u{feff}']) {
            output.push_str(newline);
        }
        let source = sections.iter().find(|s| s.item.id == item.id);
        if let Some(source) = source {
            output.push_str(&source.header);
            let mut written = HashSet::new();
            for line in &source.lines {
                if let Some((key, _)) = property(line) {
                    let key = key.to_ascii_lowercase();
                    let Some(value) = item.fields.get(&key) else { continue };
                    written.insert(key.clone());
                    if source.item.fields.get(&key) == Some(value) {
                        output.push_str(line);
                    } else {
                        let eq = line.find('=').ok_or_else(invalid)?;
                        let tail = &line[eq + 1..];
                        let padding = tail.len() - tail.trim_start_matches([' ', '\t']).len();
                        output.push_str(&line[..eq + 1 + padding]);
                        output.push_str(value);
                        if line.ends_with('\n') {
                            output.push_str(if line.ends_with("\r\n") { "\r\n" } else { "\n" });
                        }
                    }
                } else {
                    output.push_str(line);
                }
            }
            for (key, value) in &item.fields {
                if written.contains(key) {
                    continue;
                }
                if !output.ends_with('\n') {
                    output.push_str(newline);
                }
                output.push_str(&format!("{key:<21} = {value}{newline}"));
            }
        } else {
            output.push_str(&format!("[{}]{newline}{newline}", item.id));
            for (key, value) in &item.fields {
                output.push_str(&format!("{key:<21} = {value}{newline}"));
            }
            output.push_str(newline);
        }
        if output.len() > MAX_BYTES {
            return Err(invalid());
        }
    }
    document(&output)?;
    Ok(output)
}

fn menu_path(root: &Path) -> Result<PathBuf, CommandError> {
    let root = fs::canonicalize(root)?;
    let system = fs::canonicalize(root.join("system"))?;
    if !system.starts_with(&root) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let menu = system.join("menu.dat");
    safe_tree(&menu)?;
    let menu = fs::canonicalize(menu)?;
    if menu.parent() != Some(system.as_path()) || !menu.is_file() {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(menu)
}

fn read_content(path: &Path) -> Result<String, CommandError> {
    if fs::metadata(path)?.len() > MAX_BYTES as u64 {
        return Err(invalid());
    }
    fs::read_to_string(path).map_err(Into::into)
}

#[tauri::command]
pub fn read_menu(custom_path: Option<String>) -> Result<MenuDocument, CommandError> {
    let root = resolve_installation(custom_path.as_deref())?;
    document(&read_content(&menu_path(&root)?)?)
}

fn save(root: &Path, items: &[MenuItem], expected_revision: &str) -> Result<MenuSaveResult, CommandError> {
    let _lock = SAVE_LOCK.lock().map_err(|_| CommandError::new("err.menuBusy"))?;
    let root = fs::canonicalize(root)?;
    let path = menu_path(&root)?;
    let original = read_content(&path)?;
    if revision(&original) != expected_revision {
        return Err(CommandError::new("err.menuConflict"));
    }
    let next = render(&original, items)?;
    let next_document = document(&next)?;
    if next == original {
        return Ok(MenuSaveResult { document: next_document, backup_path: None });
    }
    let backups = root.join("backups");
    fs::create_dir_all(&backups)?;
    let backups = fs::canonicalize(backups)?;
    if !backups.starts_with(&root) {
        return Err(CommandError::new("err.accessDenied"));
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let backup = backups.join(format!("menu-{nonce}.dat.bak"));
    let temporary = path.parent().ok_or_else(invalid)?.join(format!(".menu-{nonce}.tmp"));
    let result = (|| -> Result<(), CommandError> {
        let mut backup_file = fs::OpenOptions::new().create_new(true).write(true).open(&backup)?;
        backup_file.write_all(original.as_bytes())?;
        backup_file.sync_all()?;
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
        file.write_all(next.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Another application may have saved the template while the new file was prepared.
        if read_content(&path)? != original || menu_path(&root)? != path {
            return Err(CommandError::new("err.menuConflict"));
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(MenuSaveResult { document: next_document, backup_path: Some(backup.to_string_lossy().into_owned()) })
}

#[tauri::command]
pub fn write_menu(
    items: Vec<MenuItem>,
    expected_revision: String,
    custom_path: Option<String>,
) -> Result<MenuSaveResult, CommandError> {
    save(&resolve_installation(custom_path.as_deref())?, &items, &expected_revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\u{feff}; template\r\n[terminal]\r\n\r\nCaption  = {lang_cli}\r\ncommand = cmd.exe /k \"echo a=b & echo ; #\"\r\nneed_use_wt = off\r\ncustom_future = keep\r\n; comment\r\n\r\n[browser]\r\ncaption = Browser\r\ncommand = command_open_options";

    #[test]
    fn untouched_template_is_byte_identical() {
        let doc = document(SAMPLE).unwrap();
        assert_eq!(render(SAMPLE, &doc.items).unwrap(), SAMPLE);
    }

    #[test]
    fn edits_preserve_comments_unknown_fields_shell_characters_and_bom() {
        let mut items = document(SAMPLE).unwrap().items;
        items[0].fields.insert("caption".into(), "My terminal".into());
        items[0].fields.insert("category".into(), "Tools\\Shells".into());
        let next = render(SAMPLE, &items).unwrap();
        assert!(next.starts_with("\u{feff}; template\r\n"));
        assert!(next.contains("Caption  = My terminal\r\n"));
        assert!(next.contains("custom_future = keep\r\n; comment\r\n"));
        assert_eq!(document(&next).unwrap().items, items);
        items.swap(0, 1);
        let reordered = render(SAMPLE, &items).unwrap();
        assert!(reordered.find("[browser]").unwrap() < reordered.find("[terminal]").unwrap());
        assert!(reordered.starts_with('\u{feff}'));
    }

    #[test]
    fn rejects_ambiguous_templates_and_section_injection() {
        for text in ["[one]\na=1\nA=2", "[one]\na=1\n[ONE]\na=2", "outside=1", "[bad", "[a]\ngarbage"] {
            assert!(document(text).is_err());
        }
        let mut items = document(SAMPLE).unwrap().items;
        items[0].fields.insert("caption".into(), "name\n[evil]".into());
        assert!(render(SAMPLE, &items).is_err());
        items[0].fields.remove("caption");
        items[0].id = "evil]\n[section".into();
        assert!(render(SAMPLE, &items).is_err());
    }

    #[test]
    fn writes_backup_and_rejects_stale_saves_without_touching_the_file() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("osp-menu-test-{nonce}"));
        fs::create_dir_all(root.join("system")).unwrap();
        let path = root.join("system/menu.dat");
        fs::write(&path, SAMPLE).unwrap();
        let doc = document(SAMPLE).unwrap();
        let mut items = doc.items;
        items[0].fields.insert("caption".into(), "Edited".into());
        let saved = save(&root, &items, &doc.revision).unwrap();
        assert_eq!(fs::read_to_string(saved.backup_path.unwrap()).unwrap(), SAMPLE);
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(document(&content).unwrap().items, items);
        assert_eq!(save(&root, &items, &doc.revision).unwrap_err().code, "err.menuConflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        assert!(save(&root, &items, &saved.document.revision).unwrap().backup_path.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_multiple_alias_actions() {
        let mut items = document(SAMPLE).unwrap().items;
        for item in &mut items {
            item.fields.insert("need_alias".into(), "on".into());
        }
        assert_eq!(render(SAMPLE, &items).unwrap_err().code, "err.menuAliasRepeated");
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_MENU_TEST_ROOT; reads the installed template without writing anything"]
    fn installed_template_roundtrip() {
        let root = PathBuf::from(std::env::var("OSP_CONTROL_MENU_TEST_ROOT").expect("test root"));
        let path = menu_path(&root).unwrap();
        let original = read_content(&path).unwrap();
        let doc = read_menu(Some(root.to_string_lossy().into_owned())).unwrap();
        assert!(!doc.items.is_empty());
        assert_eq!(render(&original, &doc.items).unwrap(), original);
        assert_eq!(read_content(&path).unwrap(), original);
    }
}
