//! Ordered, explicitly configured release catalogs. Defaults are shared with the settings editor.
use crate::error::CommandError;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const KEY: &str = "ospanel.moduleUpdateSources";
pub(crate) const FAMILIES: [&str; 4] = ["php", "apache", "nginx", "caddy"];
pub(crate) type Sources = BTreeMap<String, Vec<String>>;

pub(crate) fn defaults() -> Sources {
    serde_json::from_str(include_str!("../../src/moduleUpdateSources.defaults.json"))
        .expect("bundled release sources")
}

pub(crate) fn source_url(text: &str) -> Option<reqwest::Url> {
    if text.len() > 2048 || text.bytes().any(|b| b <= 32 || b == 127 || b == b'\\') {
        return None;
    }
    let url = reqwest::Url::parse(text).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none())
    .then_some(url)
}

pub(crate) fn parse(text: Option<&str>) -> Result<Sources, CommandError> {
    let mut result = defaults();
    if let Some(text) = text {
        let parsed: Sources =
            serde_json::from_str(text).map_err(|_| CommandError::new("err.settingsInvalid"))?;
        for (family, urls) in parsed {
            if !FAMILIES.contains(&family.as_str()) || urls.len() > 32 {
                return Err(CommandError::new("err.settingsInvalid"));
            }
            let mut seen = BTreeSet::new();
            for url in &urls {
                let url = source_url(url).ok_or_else(|| CommandError::new("err.settingsInvalid"))?;
                if !seen.insert(url.to_string()) {
                    return Err(CommandError::new("err.settingsInvalid"));
                }
            }
            result.insert(family, urls);
        }
    }
    Ok(result)
}

pub(crate) fn github_repo(url: &reqwest::Url) -> Option<String> {
    if url.host_str()? != "github.com" || url.query().is_some() {
        return None;
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !matches!(parts.as_slice(), [_, _, "releases"]) {
        return None;
    }
    if parts[..2].iter().any(|p| {
        p.is_empty()
            || *p == "."
            || *p == ".."
            || !p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    }) {
        return None;
    }
    Some(format!("{}/{}", parts[0], parts[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_urls_and_preserves_priority_and_explicit_empty_lists() {
        let sources = parse(Some(
            r#"{"php":["https://example.org/php/","https://github.com/team/php/releases"],"nginx":[]}"#,
        ))
        .unwrap();
        assert_eq!(sources["php"][0], "https://example.org/php/");
        assert!(sources["nginx"].is_empty());
        assert_eq!(sources["caddy"], defaults()["caddy"]);
        for text in [
            r#"{"php":["http://example.org/"]}"#,
            r#"{"php":["https://user:secret@example.org/"]}"#,
            r#"{"php":["https://example.org:444/"]}"#,
            r#"{"php":["https://example.org/#part"]}"#,
            r#"{"php":["https://example.org", "https://example.org/"]}"#,
            r#"{"unknown":[]}"#,
        ] {
            assert!(parse(Some(text)).is_err(), "{text}");
        }
    }
    #[test]
    fn github_sources_are_scoped_to_one_repository() {
        let url = source_url("https://github.com/Jamalofski/php-eol-security/releases").unwrap();
        assert_eq!(github_repo(&url).as_deref(), Some("Jamalofski/php-eol-security"));
        for text in [
            "https://github.com.evil/team/repo/releases",
            "https://github.com/team/repo/releases/download/v1/a.zip",
            "https://github.com/team/repo/releases?x=1",
        ] {
            assert!(github_repo(&source_url(text).unwrap()).is_none());
        }
    }
}
