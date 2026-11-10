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
        macro_rules! documents {
            ($lang:literal) => {
                [
                    include_str!(concat!("../resources/project-starters/docs/", $lang, "/static.md")),
                    include_str!(concat!("../resources/project-starters/docs/", $lang, "/php.md")),
                    include_str!(concat!("../resources/project-starters/docs/", $lang, "/node.md")),
                    include_str!(concat!("../resources/project-starters/docs/", $lang, "/laravel.md")),
                    include_str!(concat!("../resources/project-starters/docs/", $lang, "/wordpress.md")),
                ]
            };
        }
        let docs = match self.language {
            "ru" => documents!("ru"),
            "uk" => documents!("uk"),
            "be" => documents!("be"),
            "es" => documents!("es"),
            _ => documents!("en"),
        };
        let index = ["static", "php", "node", "laravel", "wordpress"]
            .iter()
            .position(|id| *id == kind)
            .ok_or_else(invalid)?;
        Ok(docs[index])
    }
    pub(crate) fn render(&self, source: &str) -> Result<String, CommandError> {
        let mut values = vec![("__LANGUAGE__", self.language.to_string())];
        for (token, key) in [
            ("__STATIC_READY__", "starters.static.ready"),
            ("__PHP_READY__", "starters.php.ready"),
            ("__LARAVEL_TITLE__", "starters.laravel.title"),
            ("__LARAVEL_HEADING__", "starters.laravel.heading"),
            ("__LARAVEL_INSTRUCTIONS__", "starters.laravel.instructions"),
            ("__LARAVEL_DETAILS__", "starters.laravel.details"),
            ("__WORDPRESS_TITLE__", "starters.wordpress.title"),
            ("__WORDPRESS_HEADING__", "starters.wordpress.heading"),
            ("__WORDPRESS_INSTRUCTIONS__", "starters.wordpress.instructions"),
            ("__WORDPRESS_DETAILS__", "starters.wordpress.details"),
        ] {
            if source.contains(token) {
                let value = self.text(key)?;
                let value = if value.contains("{install}") {
                    value.replace(
                        "{install}",
                        self.text(if key.contains("laravel") {
                            "laravel.install"
                        } else {
                            "wordpress.install"
                        })?,
                    )
                } else {
                    value.to_string()
                };
                values.push((token, html(&value)));
            }
        }
        for (token, key) in [
            ("__NODE_READY_JSON__", "starters.node.ready"),
            ("__NODE_LISTENING_JSON__", "starters.node.listening"),
        ] {
            if source.contains(token) {
                values.push((token, serde_json::to_string(self.text(key)?).map_err(|_| invalid())?));
            }
        }
        for (token, key) in
            [("__LARAVEL_TASK__", "starters.tasks.laravel"), ("__NODE_TASK__", "starters.tasks.node")]
        {
            if source.contains(token) {
                let text = self.text(key)?;
                if text.trim_start().starts_with([';', '#'])
                    || text.chars().any(|c| c.is_control() || "=[]".contains(c))
                {
                    return Err(invalid());
                }
                values.push((token, text.to_string()));
            }
        }
        for (token, key) in [
            ("__OVERVIEW__", "workspace.tab.overview"),
            ("__TASKS__", "workspace.tab.tasks"),
            ("__INSTALL_LARAVEL__", "laravel.install"),
            ("__INSTALL_WORDPRESS__", "wordpress.install"),
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
    if !matches!(kind, "laravel" | "wordpress") {
        return None;
    }
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
    fn translated_text_cannot_inject_html_javascript_or_task_definitions() {
        let mut locale = StarterLocale::new("ru").unwrap();
        locale.primary = serde_json::json!({"starters.php.ready":"<?php echo 'unsafe'; ?> & <script>bad()</script>","starters.node.ready":"quote\"\\\ntext","starters.tasks.node":"bad = injected"});
        assert!(!locale.render("__PHP_READY__").unwrap().contains('<'));
        let json = locale.render("__NODE_READY_JSON__").unwrap();
        assert_eq!(serde_json::from_str::<String>(&json).unwrap(), "quote\"\\\ntext");
        assert!(locale.render("__NODE_TASK__").is_err());
        assert!(!locale.render("__STATIC_READY__").unwrap().contains("starters."));
        locale.primary["starters.php.ready"] = "__NODE_READY_JSON__".into();
        locale.primary["starters.node.ready"] = "<?php echo 'unsafe'; ?>".into();
        assert_eq!(locale.render("__PHP_READY__").unwrap(), "__NODE_READY_JSON__");
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
