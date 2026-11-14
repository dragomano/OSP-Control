//! Editable starter packages beside the executable. File contents are data, never executed here.
use crate::{error::CommandError, project_workspace::child, update_files::safe_tree};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use sha2::{Digest, Sha256};

static MUTATION: Mutex<()> = Mutex::new(());
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILES: usize = 256;
include!(concat!(env!("OUT_DIR"), "/starter_assets.rs"));

pub(crate) fn invalid() -> CommandError { CommandError::new("err.projectTemplateInvalid") }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum Text { Plain(String), Localized(BTreeMap<String, String>) }
impl Default for Text { fn default() -> Self { Self::Plain(String::new()) } }
impl Text {
    // Resolves a localized value: the requested language, then English, then the first
    // non-empty translation — the same order the frontend uses for starter texts.
    pub(crate) fn resolve(&self, language: &str) -> String {
        match self {
            Text::Plain(s) => s.clone(),
            Text::Localized(map) => map
                .get(language)
                .or_else(|| map.get("en"))
                .or_else(|| map.values().find(|s| !s.trim().is_empty()))
                .cloned()
                .unwrap_or_default(),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseOptions {
    pub enabled: bool,
    pub engines: Vec<String>,
    pub default_engine: String,
    // Starter-owned database hints; the core only falls back to neutral wording.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub sqlite_hint: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub missing: Option<Text>,
}
// The optional one-click installer declared by the starter author. Every text and
// command lives here; the application core only knows that an install section
// means "show the button" — never the wording or the composer package.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub composer_name: Option<String>,
    #[serde(default)] pub files: Vec<String>,
}
// The archive engine: download (optionally resolving {version} from a release
// catalog), verify, extract and move a directory of the archive into the app.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallRelease {
    pub url: String,
    // Key path to the version string inside the catalog JSON ("offers" → [0] → "current").
    #[serde(default)] pub path: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallExtract {
    pub from_dir: String,
    pub to: String,
    #[serde(default)] pub required_files: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallArchive {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub release: Option<InstallRelease>,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub checksum_url: Option<String>,
    #[serde(default)] pub max_archive_bytes: u64,
    pub extract: InstallExtract,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallConfigFile {
    // A template asset of the starter package, rendered with the database
    // placeholders (PHP-escaped) and the randomHex values (raw hex).
    pub template: String,
    pub to: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallConfig {
    pub title: Text,
    #[serde(default)] pub pending: Text,
    pub button: Text,
    #[serde(default)] pub hint: Text,
    #[serde(default)] pub unsaved: Text,
    #[serde(default)] pub done: Text,
    #[serde(default)] pub log: Text,
    #[serde(default)] pub backup: Text,
    #[serde(default)] pub phases: BTreeMap<String, Text>,
    // Exactly one engine: composer create-project or an archive download.
    #[serde(default)] pub create_project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub archive: Option<InstallArchive>,
    #[serde(default)] pub scripts: bool,
    #[serde(default)] pub then: Vec<Vec<String>>,
    // What a successful run must have produced.
    #[serde(default)] pub payload: InstallPayload,
    // Environment file: read env_source (default ".env"), apply env plus the
    // engine-specific map, write ".env". Placeholders: {url}, {dbUrl},
    // {dbConnection}, {dbHost}, {dbPort}, {dbName}, {dbUsername}, {dbPassword},
    // {sqliteFile}.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub env_source: Option<String>,
    #[serde(default)] pub env: BTreeMap<String, String>,
    #[serde(default)] pub env_sqlite: BTreeMap<String, String>,
    #[serde(default)] pub env_server: BTreeMap<String, String>,
    // Where the SQLite file lives inside the project; fallback treats a scaffold
    // without database metadata as SQLite with the default name.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub sqlite_dir: Option<String>,
    #[serde(default)] pub sqlite_fallback: bool,
    // Files copied from the scaffold into the installed application (create_new).
    #[serde(default)] pub keep: Vec<String>,
    // Console steps run with the module's PHP inside the application; the
    // console_with_db set runs only when a database connection is available.
    #[serde(default)] pub console: Vec<Vec<String>>,
    #[serde(default)] pub console_with_db: Vec<Vec<String>>,
    // Per-placeholder random hex (for example application salts), generated locally.
    #[serde(default)] pub random_hex: BTreeMap<String, u32>,
    // Configuration files rendered from package templates when a database is
    // configured (config files without credentials are written before installation).
    #[serde(default)] pub config_files: Vec<InstallConfigFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub schema_version: u32,
    pub id: String,
    #[serde(default)] pub order: u32,
    pub name: Text,
    #[serde(default)] pub description: Text,
    #[serde(default)] pub next_step: Text,
    pub http_preference: String,
    pub php: bool,
    pub node: bool,
    // Manifest-driven one-click installer; absent means the starter has no button.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub install: Option<InstallConfig>,
    pub readme_path: Option<String>,
    pub database: DatabaseOptions,
    pub project_root: String,
    pub web_root: Option<String>,
    #[serde(default)] pub settings: BTreeMap<String, String>,
    #[serde(default)] pub directories: Vec<String>,
    // Starter-owned page texts: __KEY__ tokens in the package files resolve here first,
    // so no starter-specific strings live in the application locale dictionaries.
    #[serde(default)] pub messages: BTreeMap<String, Text>,
    // Optional toast shown after a project is created from this starter.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub created_message: Option<Text>,
    #[serde(flatten)] pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub manifest: Manifest,
    pub assets: BTreeMap<String, String>,
    #[serde(default)] pub revision: Option<String>,
    #[serde(default)] pub builtin: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry { pub id: String, pub document: Option<Document>, pub error: Option<CommandError> }

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}
pub(crate) fn relative(path: &str) -> bool {
    !path.is_empty() && path.len() <= 240 && path.split('/').all(|part| {
        let stem = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
        !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
            && !part.chars().any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            && !["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&stem.as_str())
    })
}
pub(crate) fn validate(doc: &Document) -> Result<(), CommandError> {
    let m = &doc.manifest;
    let text_valid = |t: &Text| match t { Text::Plain(s) => s.len() <= 16000, Text::Localized(map) => map.len() <= 64 && map.values().all(|s| s.len() <= 16000) };
    let message_key_valid = |k: &str| k.len() <= 64 && k.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    let env_map_valid = |map: &BTreeMap<String, String>| {
        map.len() <= 64
            && map.keys().all(|k| !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
            && map.values().all(|v| v.len() <= 16000 && !v.chars().any(char::is_control))
    };
    let url_valid = |url: &str| {
        url.starts_with("https://") && url.len() <= 512 && url.chars().all(|c| c.is_ascii() && !c.is_control())
    };
    let install_valid = |install: &InstallConfig, has_archive: bool| {
        // Exactly one engine: the archive download or a composer create-project.
        (has_archive ^ !install.create_project.is_empty())
            && install.create_project.len() <= 128
            && install.create_project.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'/' | b'_' | b'-'))
            && install.then.len() <= 16 && install.then.iter().all(|args| !args.is_empty() && args.len() <= 32 && args.iter().all(|a| !a.is_empty() && a.len() <= 512 && !a.chars().any(char::is_control)))
            && install.payload.files.len() <= MAX_FILES && install.payload.files.iter().all(|f| relative(f))
            && install.payload.composer_name.as_deref().is_none_or(|n| !n.is_empty() && n.len() <= 128 && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'/' | b'_' | b'-')))
            && text_valid(&install.title) && text_valid(&install.pending) && text_valid(&install.button)
            && text_valid(&install.hint) && text_valid(&install.unsaved) && text_valid(&install.done)
            && text_valid(&install.log) && text_valid(&install.backup)
            && install.phases.len() <= 8 && install.phases.keys().all(|k| matches!(k.as_str(), "preparing" | "installing" | "publishing" | "database" | "configuring" | "downloading" | "extracting"))
            && install.phases.values().all(|v| text_valid(v))
            && install.env.len() <= 64 && install.env_sqlite.len() <= 64 && install.env_server.len() <= 64
            && env_map_valid(&install.env) && env_map_valid(&install.env_sqlite) && env_map_valid(&install.env_server)
            && install.env_source.as_deref().is_none_or(|s| relative(s))
            && install.sqlite_dir.as_deref().is_none_or(|s| relative(s))
            && install.keep.len() <= MAX_FILES && install.keep.iter().all(|f| relative(f))
            && install.console.len() <= 16 && install.console_with_db.len() <= 16
            && install.console.iter().chain(install.console_with_db.iter()).all(|args| !args.is_empty() && args.len() <= 32 && args.iter().all(|a| !a.is_empty() && a.len() <= 512 && !a.chars().any(char::is_control)))
            && install.random_hex.len() <= 32
            && install.random_hex.iter().all(|(k, b)| {
                !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && (8..=128).contains(b)
            })
            && install.config_files.len() <= 8
            && install.config_files.iter().all(|f| relative(&f.template) && relative(&f.to) && doc.assets.contains_key(&f.template))
            && install.archive.as_ref().is_none_or(|a| {
                url_valid(&a.url)
                    && a.checksum_url.as_deref().is_none_or(url_valid)
                    && (1_000..=1_000_000_000).contains(&a.max_archive_bytes)
                    && relative(&a.extract.from_dir)
                    && relative(&a.extract.to)
                    && a.extract.required_files.len() <= MAX_FILES
                    && a.extract.required_files.iter().all(|f| relative(f))
                    && a.release.as_ref().is_none_or(|r| {
                        url_valid(&r.url)
                            && r.path.len() <= 8
                            && r.path.iter().all(|k| !k.is_empty() && k.len() <= 48 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                    })
                    && a.url.contains("{version}") == a.release.is_some()
                    && a.checksum_url.as_deref().is_none_or(|u| u.contains("{version}") == a.release.is_some())
            })
    };
    let has_install = m.install.is_some();
    let group_a = !valid_id(&m.id)
        || m.schema_version != 1
        || !text_valid(&m.name)
        || !text_valid(&m.description)
        || !text_valid(&m.next_step)
        || !matches!(m.http_preference.as_str(), "any" | "apache" | "nginx" | "caddy");
    let group_b = has_install && (!m.php || m.node || m.project_root != "{base_dir}" || m.web_root.as_deref() != Some("{base_dir}\\public"))
        || m.database.engines.iter().any(|s| !matches!(s.as_str(), "sqlite" | "mysql" | "mariadb" | "postgresql"))
        || m.database.default_engine != "none" && !m.database.engines.contains(&m.database.default_engine)
        || m.database.sqlite_hint.as_ref().is_some_and(|v| !text_valid(v))
        || m.database.missing.as_ref().is_some_and(|v| !text_valid(v));
    let group_c = m.install.as_ref().is_some_and(|install| !install_valid(install, m.install.as_ref().is_some_and(|a| a.archive.is_some())));
    let group_d = m.directories.len() > MAX_FILES
        || m.directories.iter().any(|s| !relative(s))
        || m.readme_path.as_deref().is_some_and(|s| !relative(s))
        || m.messages.len() > MAX_FILES
        || m.messages.keys().any(|k| !message_key_valid(k))
        || m.messages.values().any(|v| !text_valid(v))
        || m.created_message.as_ref().is_some_and(|v| !text_valid(v))
        || [&m.project_root].into_iter().chain(m.web_root.iter()).any(|s| s.chars().any(char::is_control) || s.contains(['[', ']']))
        || m.settings.iter().any(|(k,v)| k.is_empty() || !k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_' || b.is_ascii_digit()) || matches!(k.as_str(), "http_engine" | "php_engine" | "node_engine" | "project_root" | "web_root") || v.chars().any(char::is_control))
        || doc.assets.len() > MAX_FILES
        || doc.assets.iter().map(|(p,s)| p.len() + s.len()).sum::<usize>() > MAX_BYTES;
    if group_a || group_b || group_c || group_d {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    for path in doc.assets.keys() {
        if !relative(path) || path == "starter.json" || !names.insert(path.to_ascii_lowercase()) { return Err(invalid()); }
        if let Some(output) = path.strip_prefix("files/") {
            // The .osp directory is app-owned: project settings, database metadata and
            // installer markers are never shipped inside a starter package.
            if output.eq_ignore_ascii_case(".osp/project.ini") || output.eq_ignore_ascii_case(".osp/database.json")
                || output.to_ascii_lowercase().starts_with(".osp/") && output.to_ascii_lowercase().ends_with(".json")
            {
                return Err(invalid());
            }
        }
    }
    if has_install && !doc.assets.contains_key("files/public/index.php") { return Err(invalid()); }
    Ok(())
}
fn digest(doc: &Document) -> String {
    let bytes = serde_json::to_vec(&(&doc.manifest, &doc.assets)).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn directory() -> Result<PathBuf, CommandError> {
    Ok(std::env::current_exe()?.parent().ok_or_else(invalid)?.join("starters"))
}
pub(crate) fn defaults() -> Result<Vec<Document>, CommandError> {
    let mut packages: BTreeMap<String, BTreeMap<String,String>> = BTreeMap::new();
    for (path, content) in STARTER_ASSETS {
        let (id, path) = path.split_once('/').ok_or_else(invalid)?;
        packages.entry(id.into()).or_default().insert(path.into(), (*content).into());
    }
    packages.into_values().map(|mut assets| {
        let manifest = serde_json::from_str(&assets.remove("starter.json").ok_or_else(invalid)?).map_err(|_| invalid())?;
        let doc = Document { manifest, assets, revision: None, builtin: false };
        validate(&doc)?;
        Ok(doc)
    }).collect()
}
fn read_at(dir: &Path, id: &str) -> Result<Document, CommandError> {
    if !valid_id(id) { return Err(invalid()); }
    let base = child(dir, id)?;
    safe_tree(&base)?;
    let mut assets = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, assets: &mut BTreeMap<String,String>, remaining: &mut usize) -> Result<(), CommandError> {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() { walk(base, &path, assets, remaining)?; }
            else {
                if assets.len() >= MAX_FILES || fs::metadata(&path)?.len() > *remaining as u64 { return Err(invalid()); }
                let text = fs::read_to_string(&path)?;
                *remaining = remaining.checked_sub(text.len()).ok_or_else(invalid)?;
                let name = path.strip_prefix(base).map_err(|_| invalid())?.to_string_lossy().replace('\\', "/");
                assets.insert(name, text);
            }
        }
        Ok(())
    }
    walk(&base, &base, &mut assets, &mut MAX_BYTES.clone())?;
    let raw = assets.remove("starter.json").ok_or_else(invalid)?;
    let manifest: Manifest = serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|_| invalid())?;
    if manifest.id != id { return Err(invalid()); }
    let mut doc = Document { manifest, assets, revision: None, builtin: false };
    validate(&doc)?;
    doc.revision = Some(digest(&doc));
    Ok(doc)
}
pub(crate) fn load(id: &str) -> Result<Document, CommandError> {
    let dir = directory()?;
    if dir.exists() { read_at(&dir, id) }
    else { defaults()?.into_iter().find(|d| d.manifest.id == id).ok_or_else(invalid) }
}
pub(crate) fn list() -> Result<Vec<Entry>, CommandError> {
    let dir = directory()?;
    if !dir.exists() { return Ok(defaults()?.into_iter().map(|document| Entry { id: document.manifest.id.clone(), document: Some(document), error: None }).collect()); }
    safe_tree(&dir)?;
    let mut list = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || !valid_id(&id) || matches!(id.as_str(), "empty" | "static") { continue; }
        let (document, error) = match read_at(&dir, &id) { Ok(doc) => (Some(doc), None), Err(e) => (None, Some(e)) };
        list.push(Entry { id, document, error });
    }
    list.sort_by_key(|e| (e.document.as_ref().map(|d| d.manifest.order).unwrap_or(u32::MAX), e.id.clone()));
    Ok(list)
}
#[tauri::command]
pub(crate) fn list_project_starters() -> Result<Vec<Entry>, CommandError> {
    list()
}
#[tauri::command]
pub(crate) fn read_project_starter(id: String) -> Result<Document, CommandError> { load(&id) }
fn ensure_dir() -> Result<PathBuf, CommandError> {
    let dir = directory()?;
    if !dir.exists() { fs::create_dir(&dir)?; }
    safe_tree(&dir)?;
    Ok(fs::canonicalize(dir)?)
}
fn save_at(dir: &Path, doc: &Document, overwrite: bool) -> Result<Document, CommandError> {
    validate(doc)?;
    let id = &doc.manifest.id;
    if matches!(id.as_str(), "empty" | "static") { return Err(invalid()); }
    let target = child(dir, id)?;
    if target.exists() && !overwrite {
        let current = read_at(dir, id)?;
        if current.revision != doc.revision || doc.revision.is_none() { return Err(CommandError::new("err.projectWorkspaceConflict")); }
    } else if !target.exists() && doc.revision.is_some() && !overwrite { return Err(CommandError::new("err.projectWorkspaceConflict")); }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| invalid())?.as_nanos();
    let stage = dir.join(format!(".starter-stage-{}-{nonce}", std::process::id()));
    let backup = dir.join(format!(".starter-backup-{}-{nonce}", std::process::id()));
    fs::create_dir(&stage)?;
    let result = (|| {
        let mut assets = doc.assets.clone();
        assets.insert("starter.json".into(), serde_json::to_string_pretty(&doc.manifest).map_err(|_| invalid())? + "\n");
        for (name, content) in assets {
            let path = stage.join(name);
            fs::create_dir_all(path.parent().ok_or_else(invalid)?)?;
            let mut out = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
            out.write_all(content.as_bytes())?;
            out.sync_all()?;
        }
        safe_tree(&stage)?;
        if target.exists() { safe_tree(&target)?; fs::rename(&target, &backup)?; }
        if let Err(error) = fs::rename(&stage, &target) {
            if backup.exists() { fs::rename(&backup, &target)?; }
            return Err(error.into());
        }
        if backup.exists() { fs::remove_dir_all(&backup)?; }
        read_at(dir, id)
    })();
    if stage.exists() { let _ = fs::remove_dir_all(stage); }
    result
}
#[tauri::command]
pub(crate) fn save_project_starter(starter: Document) -> Result<Document, CommandError> {
    let _guard = MUTATION.lock().map_err(|_| invalid())?;
    save_at(&ensure_dir()?, &starter, false)
}
#[tauri::command]
pub(crate) fn delete_project_starter(id: String, revision: String) -> Result<(), CommandError> {
    let _guard = MUTATION.lock().map_err(|_| invalid())?;
    if matches!(id.as_str(), "empty" | "static") { return Err(invalid()); }
    let dir = ensure_dir()?;
    if read_at(&dir, &id)?.revision.as_deref() != Some(revision.as_str()) { return Err(CommandError::new("err.projectWorkspaceConflict")); }
    fs::remove_dir_all(child(&dir, &id)?)?;
    Ok(())
}
#[tauri::command]
pub(crate) fn restore_default_project_starters(id: Option<String>) -> Result<(), CommandError> {
    let _guard = MUTATION.lock().map_err(|_| invalid())?;
    let dir = ensure_dir()?;
    let docs: Vec<_> = defaults()?.into_iter().filter(|d| id.as_ref().is_none_or(|id| id == &d.manifest.id)).collect();
    if docs.is_empty() { return Err(invalid()); }
    for doc in docs { save_at(&dir, &doc, true)?; }
    Ok(())
}
#[tauri::command]
pub(crate) fn open_project_starters_folder() -> Result<(), CommandError> {
    crate::paths::hidden_command("explorer.exe").arg(crate::paths::external_path(&ensure_dir()?)).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("osp-starters-{tag}-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(id: &str) -> Document {
        let mut doc = defaults().unwrap().into_iter().find(|doc| doc.manifest.id == "php").unwrap();
        doc.manifest.id = id.into();
        doc
    }

    fn has_null(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Null => true,
            serde_json::Value::Array(items) => items.iter().any(has_null),
            serde_json::Value::Object(map) => map.values().any(has_null),
            _ => false,
        }
    }

    #[test]
    fn shipped_packages_validate_and_omit_absent_optional_sections() {
        for doc in defaults().unwrap() {
            validate(&doc).unwrap();
            let manifest = serde_json::to_value(&doc).unwrap()["manifest"].clone();
            // The editor reads an absent section as "disabled"; a null value made
            // starters without a one-click install crash when opened.
            assert_eq!(
                manifest.get("install").is_some(),
                doc.manifest.install.is_some(),
                "{}",
                doc.manifest.id
            );
            assert!(!manifest.get("install").is_some_and(has_null), "{}", doc.manifest.id);
        }
    }
    #[test]
    fn identifiers_reject_reserved_names_and_unsafe_paths() {
        for id in ["", "Empty", "a b", "x/y", "x\\y", "a".repeat(49).as_str(), ".hidden"] {
            assert!(!valid_id(id), "{id:?}");
        }
        assert!(valid_id("php") && valid_id("my-template_2") && valid_id("1x"));
        for path in ["", "..", "../x", "a/../../b", "a\\b", "C:/x", "CON.txt", "x.", "x ", "a//b"] {
            assert!(!relative(path), "{path:?}");
        }
        assert!(relative("files/public/index.php") && relative(".htaccess") && relative("docs/ru.md"));
    }

    #[test]
    fn manifests_reject_unknown_schema_engines_and_protected_outputs() {
        let mut doc = sample("custom");
        assert!(validate(&doc).is_ok());
        doc.manifest.schema_version = 2;
        assert!(validate(&doc).is_err());
        doc = sample("custom");
        doc.manifest.http_preference = "iis".into();
        assert!(validate(&doc).is_err());
        doc = sample("custom");
        doc.manifest.database.engines.push("oracle".into());
        assert!(validate(&doc).is_err());
        doc = sample("custom");
        doc.assets.insert("files/.osp/project.ini".into(), "x".into());
        assert!(validate(&doc).is_err());
        doc = sample("custom");
        doc.assets.insert("files/../escape".into(), "x".into());
        assert!(validate(&doc).is_err());
        doc = sample("custom");
        // Any UTF-8 payload is data; only duplicate case-insensitive names are rejected here.
        doc.assets.insert("Files/x.txt".into(), "a".into());
        doc.assets.insert("files/x.txt".into(), "b".into());
        assert!(validate(&doc).is_err());
    }

    #[test]
    fn save_roundtrip_revision_conflicts_and_reserved_ids_are_enforced() {
        let dir = Dir::new("save");
        let mut doc = sample("custom");
        doc.revision = None;
        let saved = save_at(&dir.0, &doc, false).unwrap();
        assert_eq!(saved.manifest.id, "custom");
        assert_eq!(saved.revision.as_deref(), Some(read_at(&dir.0, "custom").unwrap().revision.as_deref().unwrap()));
        assert!(saved.assets.contains_key("files/public/index.php"));

        // A stale revision never overwrites a newer file on disk.
        let mut stale = saved.clone();
        stale.assets.insert("files/extra.txt".into(), "x".into());
        save_at(&dir.0, &stale, false).unwrap();
        let older = read_at(&dir.0, "custom").unwrap();
        let mut conflicting = older.clone();
        conflicting.manifest.name = Text::Plain("older edit".into());
        conflicting.revision = Some("0".repeat(64));
        assert_eq!(
            save_at(&dir.0, &conflicting, false).unwrap_err().code,
            "err.projectWorkspaceConflict"
        );
        // The current revision still saves.
        save_at(&dir.0, &older, false).unwrap();

        for id in ["empty", "static"] {
            assert_eq!(save_at(&dir.0, &sample(id), true).unwrap_err().code, "err.projectTemplateInvalid");
        }
        // A folder may be created without a prior revision; a missing one cannot be deleted blindly.
        let fresh = sample("fresh");
        save_at(&dir.0, &fresh, false).unwrap();
        let loaded = read_at(&dir.0, "fresh").unwrap();
        delete_reserved_and_conflicts(&dir.0, &loaded);
    }

    fn delete_reserved_and_conflicts(dir: &Path, loaded: &Document) {
        assert_eq!(
            delete_at(dir, "empty", loaded.revision.clone().unwrap()).unwrap_err().code,
            "err.projectTemplateInvalid"
        );
        assert_eq!(
            delete_at(dir, "fresh", "stale".into()).unwrap_err().code,
            "err.projectWorkspaceConflict"
        );
        delete_at(dir, "fresh", loaded.revision.clone().unwrap()).unwrap();
        assert!(!dir.join("fresh").exists());
    }

    #[test]
    fn restore_overwrites_edited_packages_with_the_shipped_state() {
        let dir = Dir::new("restore");
        let mut doc = sample("php");
        doc.assets.insert("files/public/index.php".into(), "edited".into());
        save_at(&dir.0, &doc, true).unwrap();
        restore_at(&dir.0, Some("php")).unwrap();
        let restored = read_at(&dir.0, "php").unwrap();
        assert_ne!(restored.assets["files/public/index.php"], "edited");
        restore_at(&dir.0, Some("missing-id")).unwrap_err();
    }

    #[test]
    fn a_broken_user_folder_is_reported_without_breaking_the_rest() {
        let dir = Dir::new("broken");
        fs::create_dir(dir.0.join("broken-json")).unwrap();
        fs::write(dir.0.join("broken-json/starter.json"), "{oops").unwrap();
        save_at(&dir.0, &sample("custom"), true).unwrap();
        let list = list_at(&dir.0).unwrap();
        let entry = list.iter().find(|entry| entry.id == "broken-json").unwrap();
        assert!(entry.document.is_none() && entry.error.is_some());
        assert!(list.iter().any(|entry| entry.id == "custom"));
    }

    fn list_at(dir: &Path) -> Result<Vec<Entry>, CommandError> {
        let mut list = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_dir() || !valid_id(&id) || matches!(id.as_str(), "empty" | "static") {
                continue;
            }
            let (document, error) =
                match read_at(dir, &id) { Ok(doc) => (Some(doc), None), Err(e) => (None, Some(e)) };
            list.push(Entry { id, document, error });
        }
        list.sort_by_key(|e| (e.document.as_ref().map(|d| d.manifest.order).unwrap_or(u32::MAX), e.id.clone()));
        Ok(list)
    }
    fn delete_at(dir: &Path, id: &str, revision: String) -> Result<(), CommandError> {
        if matches!(id, "empty" | "static") {
            return Err(invalid());
        }
        if read_at(dir, id)?.revision.as_deref() != Some(revision.as_str()) {
            return Err(CommandError::new("err.projectWorkspaceConflict"));
        }
        fs::remove_dir_all(child(dir, id)?)?;
        Ok(())
    }
    fn restore_at(dir: &Path, id: Option<&str>) -> Result<(), CommandError> {
        let docs: Vec<_> = defaults()?.into_iter().filter(|d| id.is_none_or(|id| Some(id) == d.manifest.id.as_str().into())).collect();
        if docs.is_empty() {
            return Err(invalid());
        }
        for doc in docs {
            save_at(dir, &doc, true)?;
        }
        Ok(())
    }
}
