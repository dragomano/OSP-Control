//! Localized scaffold documents and safely encoded starter messages.
use crate::{error::CommandError, paths::is_valid_lang, project_workspace::child};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub(crate) const LANGUAGES: [&str; 5] = ["en", "ru", "uk", "be", "es"];

fn invalid() -> CommandError {
    CommandError::new("err.projectTemplateInvalid")
}

pub(crate) struct StarterLocale {
    pub(crate) language: &'static str,
    primary: Value,
    bundled: Value,
}
impl StarterLocale {
    pub(crate) fn new(language: &str) -> Result<Self, CommandError> {
        if !is_valid_lang(language) {
            return Err(CommandError::new("err.invalidLangCode"));
        }
        let base = language.split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
        let language = LANGUAGES.into_iter().find(|code| *code == base).unwrap_or("en");
        let bundled = serde_json::from_str(&crate::locales::read_locale(language.into(), false)?)
            .map_err(|_| invalid())?;
        let primary = crate::locales::read_locale(language.into(), true)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        Ok(Self { language, primary, bundled })
    }
    fn text(&self, key: &str) -> Result<&str, CommandError> {
        [&self.primary, &self.bundled]
            .into_iter()
            .find_map(|dict| dict.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
            .ok_or_else(invalid)
    }
    pub(crate) fn document(&self, kind: &str) -> Result<&'static str, CommandError> {
        // Only the built-in static template still reads its readme from the locale table;
        // starter packages carry their own docs/<lang>.md files.
        macro_rules! documents {
            ($lang:literal) => {
                [include_str!(concat!("../resources/builtin-starters/static/docs/", $lang, ".md"))]
            };
        }
        let docs = match self.language {
            "ru" => documents!("ru"),
            "uk" => documents!("uk"),
            "be" => documents!("be"),
            "es" => documents!("es"),
            _ => documents!("en"),
        };
        if kind == "static" {
            return Ok(docs[0]);
        }
        Err(invalid())
    }
    pub(crate) fn render(&self, source: &str) -> Result<String, CommandError> {
        // Only built-in and application-owned strings live in the dictionaries.
        // Starter-specific page texts come from each package's starter.json
        // (substituted before this renderer runs) — see starter_files().
        let mut values = vec![("__LANGUAGE__", self.language.to_string())];
        if source.contains("__STATIC_READY__") {
            values.push(("__STATIC_READY__", html(self.text("starters.static.ready")?)));
        }
        for (token, key) in [
            ("__OVERVIEW__", "workspace.tab.overview"),
            ("__TASKS__", "workspace.tab.tasks"),
            ("__CONFIGURE_LATER__", "projectDb.later"),
        ] {
            if source.contains(token) {
                values.push((token, self.text(key)?.to_string()));
            }
        }
        // Scan the template once so tokens inside translated text remain literal data.
        let mut result = String::new();
        let mut tail = source;
        while let Some(start) = tail.find("__") {
            result.push_str(&tail[..start]);
            let Some(end) = tail[start + 2..].find("__").map(|end| start + end + 4) else {
                result.push_str(&tail[start..]);
                return Ok(result);
            };
            let token = &tail[start..end];
            result.push_str(
                values
                    .iter()
                    .find(|(key, _)| *key == token)
                    .map(|(_, value)| value.as_str())
                    .unwrap_or(token),
            );
            tail = &tail[end..];
        }
        result.push_str(tail);
        Ok(result)
    }
    pub(crate) fn marker(&self, placeholder: &str) -> Result<String, CommandError> {
        serde_json::to_string(&Marker {
            version: 2,
            status: "pending".into(),
            language: self.language.into(),
            placeholder_sha256: checksum(placeholder),
        })
        .map(|s| s + "\n")
        .map_err(|_| invalid())
    }
}
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn checksum(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.replace("\r\n", "\n").as_bytes()))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: u32,
    status: String,
    language: String,
    placeholder_sha256: String,
}
fn parse_marker(bytes: &[u8]) -> Option<Marker> {
    let marker: Marker = serde_json::from_slice(bytes).ok()?;
    (marker.version == 2
        && LANGUAGES.contains(&marker.language.as_str())
        && matches!(marker.status.as_str(), "pending" | "installed")
        && marker.placeholder_sha256.len() == 64
        && marker.placeholder_sha256.bytes().all(|b| b.is_ascii_hexdigit()))
    .then_some(marker)
}
fn marker_at(dir: &Path, kind: &str) -> Option<Marker> {
    // The kind is a starter id from the catalog; the marker file itself carries
    // the validity checks (version, status, language, checksum).
    let file = child(&child(dir, ".osp").ok()?, &format!("{kind}.json")).ok()?;
    if fs::metadata(&file).ok()?.len() > 4096 {
        return None;
    }
    parse_marker(&fs::read(file).ok()?)
}
pub(crate) fn state(dir: &Path, kind: &str) -> Option<String> {
    marker_at(dir, kind).map(|marker| marker.status)
}
pub(crate) fn matches_placeholder(dir: &Path, kind: &str, bytes: &[u8]) -> bool {
    let Some(marker) = marker_at(dir, kind) else {
        return false;
    };
    marker.status == "pending"
        && std::str::from_utf8(bytes).is_ok_and(|text| checksum(text) == marker.placeholder_sha256)
}
pub(crate) fn installed_marker(bytes: &[u8]) -> Result<String, CommandError> {
    parse_marker(bytes).ok_or_else(invalid)?;
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    value["status"] = "installed".into();
    serde_json::to_string(&value).map(|s| s + "\n").map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn region_languages_are_resolved_and_invalid_path_codes_are_rejected() {
        assert_eq!(StarterLocale::new("ru-RU").unwrap().language, "ru");
        assert_eq!(StarterLocale::new("pt_BR").unwrap().language, "en");
        assert!(StarterLocale::new("../ru").is_err());
    }
    #[test]
    fn translated_text_is_html_escaped_and_unknown_tokens_stay_literal() {
        let mut locale = StarterLocale::new("ru").unwrap();
        locale.primary =
            serde_json::json!({"starters.static.ready":"<?php echo 'unsafe'; ?> & <script>bad()</script>"});
        assert!(!locale.render("__STATIC_READY__").unwrap().contains('<'));
        // Tokens inside translated text remain literal data instead of being re-resolved.
        locale.primary["starters.static.ready"] = "__OVERVIEW__".into();
        assert_eq!(locale.render("__STATIC_READY__").unwrap(), "__OVERVIEW__");
        // Unknown tokens are left untouched for the caller's own substitution passes.
        assert_eq!(locale.render("__NOT_A_KEY__").unwrap(), "__NOT_A_KEY__");
    }
    #[test]
    fn installed_marker_retains_language_fingerprint_and_unknown_fields() {
        let locale = StarterLocale::new("be").unwrap();
        let mut value: Value = serde_json::from_str(&locale.marker("placeholder").unwrap()).unwrap();
        value["custom"] = true.into();
        let installed = installed_marker(&serde_json::to_vec(&value).unwrap()).unwrap();
        value["status"] = "installed".into();
        assert_eq!(serde_json::from_str::<Value>(&installed).unwrap(), value);
        assert!(parse_marker(br#"{"version":1,"status":"pending"}"#).is_none());
    }
}
