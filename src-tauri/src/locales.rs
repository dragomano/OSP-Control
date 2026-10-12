//! Language dictionaries: embedded fallbacks, the user-editable files in locales/, and their commands.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CommandError;
use crate::paths::is_valid_lang;

// Embedded translations — the fallback when files in locales/ are missing or corrupted.
// The base language is English (also for unknown locale codes), as in src/i18n.ts.
const LOCALE_EN: &str = include_str!("../resources/locales/en.json");
const LOCALE_RU: &str = include_str!("../resources/locales/ru.json");
const LOCALE_ES: &str = include_str!("../resources/locales/es.json");
const LOCALE_UK: &str = include_str!("../resources/locales/uk.json");
const LOCALE_BE: &str = include_str!("../resources/locales/be.json");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocaleInfo {
    code: String,
    name: String,
}

// Extracts the language name from the dictionary content (the lang.name key).
fn locale_name_from_content(raw: &str) -> Option<String> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let name = value.get("lang.name")?.as_str()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// The locales folder next to the exe — the place the user edits dictionaries in.
fn locales_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("locales"))
}

// The content of locales/<code>.json (without the BOM), if the file is readable.
fn locale_file_content_in(dir: &Path, code: &str) -> Option<String> {
    let content = fs::read_to_string(dir.join(format!("{}.json", code))).ok()?;
    Some(content.strip_prefix('\u{feff}').unwrap_or(&content).to_string())
}

// Language name: taken from the dictionary itself (the lang.name key),
// falling back to the code in upper case.
fn locale_display_name_in(dir: Option<&Path>, code: &str) -> String {
    if let Some(name) = dir
        .and_then(|dir| locale_file_content_in(dir, code))
        .and_then(|content| locale_name_from_content(&content))
    {
        return name;
    }

    // Only the embedded dictionaries carry a name; an unknown code (a user file with
    // its own locale) has nothing to take a name from and falls back to upper case.
    let embedded = match code {
        "en" => Some(LOCALE_EN),
        "ru" => Some(LOCALE_RU),
        "es" => Some(LOCALE_ES),
        "uk" => Some(LOCALE_UK),
        "be" => Some(LOCALE_BE),
        _ => None,
    };

    embedded.and_then(locale_name_from_content).unwrap_or_else(|| code.to_uppercase())
}

// A language dictionary: first the file next to the app (edited by the user),
// then the embedded fallback.
fn load_locale_content_in(dir: Option<&Path>, lang: &str, allow_file: bool) -> String {
    if allow_file {
        if let Some(content) = dir.and_then(|dir| locale_file_content_in(dir, lang)) {
            return content;
        }
    }

    match lang {
        "ru" => LOCALE_RU,
        "es" => LOCALE_ES,
        "uk" => LOCALE_UK,
        "be" => LOCALE_BE,
        _ => LOCALE_EN,
    }
    .to_string()
}

// A single dictionary line — needed for the tray icon labels.
fn locale_key_string_in(dir: Option<&Path>, lang: &str, key: &str) -> String {
    serde_json::from_str::<serde_json::Value>(&load_locale_content_in(dir, lang, true))
        .ok()
        .and_then(|value| value.get(key)?.as_str().map(str::to_string))
        .unwrap_or_else(|| key.to_string())
}

pub(crate) fn locale_key_string(lang: &str, key: &str) -> String {
    locale_key_string_in(locales_dir().as_deref(), lang, key)
}

fn read_locale_in(dir: Option<&Path>, lang: &str, allow_file: bool) -> Result<String, CommandError> {
    if !is_valid_lang(lang) {
        return Err(CommandError::new("err.invalidLangCode"));
    }
    Ok(load_locale_content_in(dir, lang, allow_file))
}

#[tauri::command]
pub fn read_locale(lang: String, allow_file: bool) -> Result<String, CommandError> {
    read_locale_in(locales_dir().as_deref(), &lang, allow_file)
}

fn list_locales_in(dir: Option<&Path>) -> Result<Vec<LocaleInfo>, CommandError> {
    let mut list = vec![
        LocaleInfo { code: "en".into(), name: locale_display_name_in(dir, "en") },
        LocaleInfo { code: "ru".into(), name: locale_display_name_in(dir, "ru") },
        LocaleInfo { code: "be".into(), name: locale_display_name_in(dir, "be") },
        LocaleInfo { code: "uk".into(), name: locale_display_name_in(dir, "uk") },
        LocaleInfo { code: "es".into(), name: locale_display_name_in(dir, "es") },
    ];

    if let Some(dir) = dir {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let Some(code) = file_name.strip_suffix(".json") else { continue };
                if !is_valid_lang(code) || list.iter().any(|item| item.code == code) {
                    continue;
                }
                let Ok(content) = fs::read_to_string(entry.path()) else { continue };
                let Some(name) = locale_name_from_content(&content) else { continue };
                list.push(LocaleInfo { code: code.to_string(), name });
            }
        }
    }

    list.sort_by_key(|a| a.name.to_lowercase());
    Ok(list)
}

#[tauri::command]
pub fn list_locales() -> Result<Vec<LocaleInfo>, CommandError> {
    list_locales_in(locales_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway locales folder per test: the pid keeps parallel runs apart.
    fn temp_locales_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("osp-ui-locales-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_locale_display_name_from_json_content() {
        assert_eq!(
            locale_name_from_content(r#"{"lang.name":"Esperanto","lang.code":"eo"}"#),
            Some("Esperanto".to_string())
        );
        // With a BOM
        assert_eq!(
            locale_name_from_content("\u{feff}{\"lang.name\":\"Esperanto\"}"),
            Some("Esperanto".to_string())
        );
        // Empty or blank values are dropped
        assert_eq!(locale_name_from_content(r#"{"lang.name":"   "}"#), None);
        assert_eq!(locale_name_from_content(r#"{"other":"key"}"#), None);
        assert_eq!(locale_name_from_content(r#"{"lang.name":123}"#), None);
        assert_eq!(locale_name_from_content("invalid json"), None);
    }

    #[test]
    fn embedded_locales_declare_their_display_names() {
        // No user folder: only the embedded dictionaries answer.
        assert_eq!(locale_display_name_in(None, "en"), "English");
        assert_eq!(locale_display_name_in(None, "ru"), "Русский");
        assert_eq!(locale_display_name_in(None, "be"), "Беларуская");
        assert_eq!(locale_display_name_in(None, "uk"), "Українська");
        assert_eq!(locale_display_name_in(None, "es"), "Español");
        // An unknown language falls back to the code in upper case
        assert_eq!(locale_display_name_in(None, "unknown_lang"), "UNKNOWN_LANG");
    }

    // The command is the security boundary for the language code: traversal, separators
    // and non-ASCII names never reach the file system.
    #[test]
    fn read_locale_command_rejects_invalid_lang_codes() {
        for code in ["", "a", "123", "ru RU", "ru/../x", "де", "verylongcode", "-_-"] {
            let error = read_locale(code.to_string(), true).unwrap_err();
            assert_eq!(error.code, "err.invalidLangCode", "must reject {code:?}");
        }
        // A legitimate code passes validation.
        assert!(read_locale("ru".to_string(), false).is_ok());
    }

    // The file next to the app wins over the embedded dictionary, allow_file=false
    // ignores it, and a missing file or folder falls back to the embedded base.
    #[test]
    fn read_locale_reads_the_file_and_falls_back_to_embedded() {
        let dir = temp_locales_dir("read");
        // A user file wins over the embedded dictionary; a BOM is tolerated.
        fs::write(dir.join("ru.json"), "\u{feff}{\"lang.name\":\"Русский\",\"hi\":\"Файл\"}").unwrap();
        let from_file = read_locale_in(Some(&dir), "ru", true).unwrap();
        assert!(from_file.contains("\"hi\":\"Файл\""), "the file must win: {from_file}");
        assert!(!from_file.contains('\u{feff}'), "the BOM must be stripped");
        // Without allow_file the embedded dictionary is returned even when the file exists.
        assert_eq!(read_locale_in(Some(&dir), "ru", false).unwrap(), LOCALE_RU);
        // A code with no embedded dictionary and no file falls back to the English base.
        assert_eq!(read_locale_in(Some(&dir), "de", true).unwrap(), LOCALE_EN);
        // A missing directory behaves like an empty one.
        let missing = dir.join("nope");
        assert_eq!(read_locale_in(Some(&missing), "ru", true).unwrap(), LOCALE_RU);

        fs::remove_dir_all(&dir).unwrap();
    }

    // The settings language list: user files join the embedded five, a user file may
    // rename an embedded language but never duplicates it, and unusable files
    // (broken JSON, no lang.name, an invalid code) are skipped silently.
    #[test]
    fn list_locales_scans_the_folder_and_skips_unusable_files() {
        let dir = temp_locales_dir("list");
        fs::write(dir.join("de.json"), "{\"lang.name\":\"Deutsch\",\"hi\":\"Hallo\"}").unwrap();
        // Overrides the name of an embedded language instead of adding a second entry.
        fs::write(dir.join("ru.json"), "{\"lang.name\":\"Мой русский\"}").unwrap();
        fs::write(dir.join("broken.json"), "{oops").unwrap();
        fs::write(dir.join("noname.json"), "{\"hi\":\"Hallo\"}").unwrap();
        fs::write(dir.join("d!.json"), "{\"lang.name\":\"Bad\"}").unwrap();

        let list = list_locales_in(Some(&dir)).unwrap();
        let codes: Vec<&str> = list.iter().map(|item| item.code.as_str()).collect();
        assert_eq!(codes, ["de", "en", "es", "be", "ru", "uk"], "picked up, sorted by name, no duplicates or junk");

        let name = |code: &str| list.iter().find(|item| item.code == code).unwrap().name.clone();
        assert_eq!(name("de"), "Deutsch");
        assert_eq!(name("ru"), "Мой русский");
        assert_eq!(name("en"), "English");

        fs::remove_dir_all(&dir).unwrap();
    }

    // The real command with no locales folder next to the test binary: exactly the
    // five embedded languages, sorted by the lowercased native name.
    #[test]
    fn list_locales_command_returns_the_embedded_five() {
        let list = list_locales().unwrap();
        let codes: Vec<&str> = list.iter().map(|item| item.code.as_str()).collect();
        assert_eq!(codes, ["en", "es", "be", "ru", "uk"]);
    }

    // Tray labels: the user file answers first, a missing key degrades to the key
    // itself, an unknown language falls back to the English base dictionary.
    #[test]
    fn locale_key_string_reads_the_file_and_falls_back_to_the_key() {
        let dir = temp_locales_dir("keystring");
        fs::write(dir.join("de.json"), "{\"lang.name\":\"Deutsch\",\"tray.show\":\"Fenster zeigen\"}").unwrap();
        assert_eq!(locale_key_string_in(Some(&dir), "de", "tray.show"), "Fenster zeigen");
        assert_eq!(locale_key_string_in(Some(&dir), "de", "tray.missing"), "tray.missing");
        assert_eq!(locale_key_string_in(Some(&dir), "fr", "tray.show"), "Show window");

        fs::remove_dir_all(&dir).unwrap();
    }
}
