//! Built-in scaffolds. All paths and commands come from bundled assets; no installers are run.
use crate::project_starter_locale::StarterLocale;
use crate::{error::CommandError, paths::external_path, project_workspace::child};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Template {
    pub(crate) id: String,
    pub(crate) php: bool,
    pub(crate) node: bool,
    project_root: String,
    web_root: Option<String>,
    directories: Vec<String>,
    settings: BTreeMap<String, String>,
    files: Vec<TemplateFile>,
    #[serde(skip)]
    pub(crate) starter: Option<crate::project_starters::Document>,
}
#[derive(Debug, Deserialize)]
struct TemplateFile {
    path: String,
    source: String,
}
pub(crate) fn template(id: &str) -> Result<Template, CommandError> {
    if !matches!(id, "empty" | "static") {
        let starter = crate::project_starters::load(id)?;
        let m = &starter.manifest;
        return Ok(Template { id: m.id.clone(), php: m.php, node: m.node, project_root: m.project_root.clone(), web_root: m.web_root.clone(), directories: m.directories.clone(), settings: m.settings.clone(), files: Vec::new(), starter: Some(starter) });
    }
    let templates: Vec<Template> = serde_json::from_str(include_str!("../resources/project-templates.json"))
        .map_err(|_| CommandError::new("err.projectTemplateInvalid"))?;
    templates
        .into_iter()
        .find(|template| template.id == id)
        .ok_or_else(|| CommandError::new("err.projectTemplateInvalid"))
}
pub(crate) fn preferred(options: &[String], global: &str) -> Option<String> {
    if options.iter().any(|option| option == global) {
        return Some(global.into());
    }
    options
        .iter()
        .max_by_key(|name| {
            (
                name.split(|c: char| !c.is_ascii_digit())
                    .filter_map(|part| part.parse::<u32>().ok())
                    .collect::<Vec<_>>(),
                name.to_ascii_lowercase(),
            )
        })
        .cloned()
}

// preference: "any" or a server family ("apache"/"nginx"/"caddy") from the starter manifest.
pub(crate) fn preferred_http(preference: &str, options: &[String], global: &str) -> Option<String> {
    if !matches!(preference, "any" | "") {
        let matching: Vec<_> = options
            .iter()
            .filter(|engine| engine.to_ascii_lowercase().starts_with(preference))
            .cloned()
            .collect();
        if !matching.is_empty() {
            return preferred(&matching, global);
        }
    }
    preferred(options, global)
}

pub(crate) fn php_port(modules: &serde_json::Value, engine: &str) -> Result<u16, CommandError> {
    use crate::panel_api::{active_profile_settings, dat_field, dat_string_value};
    let module = dat_field(modules, engine).ok_or_else(|| CommandError::new("err.panelNotReady"))?;
    let profile = dat_field(module, "profile").map(dat_string_value).unwrap_or_default();
    active_profile_settings(module, &profile)
        .and_then(|settings| dat_field(settings, "port"))
        .map(dat_string_value)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| CommandError::new("err.invalidSettingValue").with("value", "PHP port"))
}

impl Template {
    fn content(
        &self,
        source: &str,
        domain: &str,
        php: &str,
        port: u16,
        php_port: u16,
        ini: &str,
        locale: &StarterLocale,
    ) -> Result<String, CommandError> {
        let text = match source {
            "ini" => return Ok(ini.into()),
            "html" => include_str!("../resources/builtin-starters/static/index.html"),
            "css" => include_str!("../resources/builtin-starters/static/styles.css"),
            "static-readme" => locale.document("static")?,
            _ => return Err(CommandError::new("err.projectTemplateInvalid")),
        };
        Ok(locale
            .render(text)?
            .replace("__DOMAIN__", domain)
            .replace("__PHP_ENGINE__", php)
            .replace("__PHP_PORT__", &php_port.to_string())
            .replace("__PORT__", &port.to_string())
            .replace("\r\n", "\n")
            .replace('\n', "\r\n"))
    }
    pub(crate) fn files(
        &self,
        domain: &str,
        http: &str,
        php: &str,
        node: &str,
        port: u16,
        php_port: u16,
        language: &str,
    ) -> Result<Vec<(String, String)>, CommandError> {
        let locale = StarterLocale::new(language)?;
        let mut ini = format!(
            "\u{feff}[{domain}]\r\n\r\nhttp_engine       = {http}\r\nphp_engine        = {php}\r\nnode_engine       = {node}\r\n"
        );
        if self.id != "empty" {
            ini.push_str(&format!("project_root      = {}\r\n", self.project_root));
            if let Some(root) = &self.web_root {
                ini.push_str(&format!("web_root          = {root}\r\n"));
            }
            for (key, value) in &self.settings {
                ini.push_str(&format!("{key:<17} = {}\r\n", value.replace("{port}", &port.to_string())));
            }
        }
        if let Some(starter) = &self.starter {
            return starter_files(starter, domain, php, php_port, port, &ini, &locale);
        }
        self.files
            .iter()
            .map(|file| {
                Ok((
                    file.path.replace("{domain}", domain),
                    self.content(&file.source, domain, php, port, php_port, &ini, &locale)?,
                ))
            })
            .collect()
    }
    pub(crate) fn create(
        &self,
        home: &Path,
        domain: &str,
        files: &[(String, String)],
    ) -> Result<PathBuf, CommandError> {
        publish(home, domain, &self.directories, files)
    }
}

// Renders the file set of an editable starter package. Package-owned texts
// (manifest "messages") are substituted first: keys ending in _JSON become
// JSON string literals, the rest are inserted as-is. What remains is resolved
// by the shared locale renderer (application UI labels) and the direct
// creation placeholders.
fn starter_files(
    starter: &crate::project_starters::Document,
    domain: &str,
    php: &str,
    php_port: u16,
    port: u16,
    ini: &str,
    locale: &StarterLocale,
) -> Result<Vec<(String, String)>, CommandError> {
    let mut files = vec![(".osp/project.ini".into(), ini.to_string())];
    let render = |text: &str| -> Result<String, CommandError> {
        let mut text = text.to_string();
        for (key, value) in &starter.manifest.messages {
            let token = format!("__{key}__");
            if !text.contains(&token) {
                continue;
            }
            let value = value.resolve(locale.language);
            let value = if key.ends_with("_JSON") {
                serde_json::to_string(&value).map_err(|_| CommandError::new("err.projectTemplateInvalid"))?
            } else {
                value
            };
            text = text.replace(&token, &value);
        }
        Ok(locale
            .render(&text)?
            .replace("__DOMAIN__", domain)
            .replace("__PHP_ENGINE__", php)
            .replace("__PHP_PORT__", &php_port.to_string())
            .replace("__PORT__", &port.to_string())
            .replace("\r\n", "\n")
            .replace('\n', "\r\n"))
    };
    for (path, content) in &starter.assets {
        if let Some(path) = path.strip_prefix("files/") {
            let content = if starter.manifest.readme_path.as_deref() == Some(path) {
                starter
                    .assets
                    .get(&format!("docs/{}.md", locale.language))
                    .or_else(|| starter.assets.get("docs/en.md"))
                    .unwrap_or(content)
            } else {
                content
            };
            files.push((path.replace("{domain}", domain), render(content)?));
        }
    }
    for engine in ["nginx", "apache", "caddy"] {
        if let Some(content) = starter.assets.get(&format!("{engine}.conf")) {
            files.push((format!(".osp/{engine}/{domain}.conf"), render(content)?));
        }
    }
    // Any installer (manifest-driven or the native WordPress download) records its
    // readiness in .osp/<starter id>.json.
    if starter.manifest.install.is_some() {
        let placeholder = files
            .iter()
            .find(|(p, _)| p == "public/index.php")
            .ok_or_else(|| CommandError::new("err.projectTemplateInvalid"))?;
        let marker = locale.marker(&placeholder.1)?.replace('\n', "\r\n");
        files.push((format!(".osp/{}.json", starter.manifest.id), marker));
    }
    Ok(files)
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(path).components().all(|part| matches!(part, Component::Normal(_)))
}
fn mkdir(base: &Path, relative: &str) -> Result<PathBuf, CommandError> {
    let mut dir = base.to_path_buf();
    for part in relative.split('/') {
        let next = child(&dir, part)?;
        if !next.exists() {
            fs::create_dir(&next)?;
        }
        dir = child(&dir, part)?;
        if !dir.is_dir() || !dir.starts_with(base) {
            return Err(CommandError::new("err.accessDenied"));
        }
    }
    Ok(dir)
}
fn publish(
    home: &Path,
    domain: &str,
    directories: &[String],
    files: &[(String, String)],
) -> Result<PathBuf, CommandError> {
    if crate::paths::normalize_project_domain(domain)? != domain {
        return Err(CommandError::new("err.invalidDomain"));
    }
    if directories.iter().any(|path| !relative(path)) || files.iter().any(|(path, _)| !relative(path)) {
        return Err(CommandError::new("err.projectTemplateInvalid"));
    }
    let target = child(home, domain)?;
    if target.exists() {
        return Err(CommandError::new("err.projectExists").with("domain", domain));
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let stage = home.join(format!(".osp-control-create-{}-{nonce}", std::process::id()));
    fs::create_dir(&stage)?;
    let stage = fs::canonicalize(stage)?;
    let result = (|| -> Result<PathBuf, CommandError> {
        for directory in directories {
            mkdir(&stage, directory)?;
        }
        for (path, content) in files {
            let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
            let parent = if parent.is_empty() { stage.clone() } else { mkdir(&stage, parent)? };
            let path = child(&parent, name)?;
            let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
            output.write_all(content.as_bytes())?;
            output.sync_all()?;
        }
        // Repeat the containment and collision checks immediately before publishing the complete tree.
        if stage.parent() != Some(fs::canonicalize(home)?.as_path())
            || child(home, stage.file_name().unwrap().to_str().unwrap())? != stage
        {
            return Err(CommandError::new("err.accessDenied"));
        }
        if target.exists() {
            return Err(CommandError::new("err.projectExists").with("domain", domain));
        }
        fs::rename(&stage, &target)?;
        Ok(external_path(&target))
    })();
    if result.is_err()
        && stage.parent() == Some(home)
        && child(home, stage.file_name().unwrap().to_str().unwrap()).is_ok_and(|path| path == stage)
    {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("osp-template-test-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn renders_every_bundled_file_with_crlf_and_no_unresolved_markers() {
        for language in crate::project_starter_locale::LANGUAGES {
            for id in ["empty", "static", "php", "laravel", "wordpress", "symfony", "bitrix", "node"] {
                let template = template(id).unwrap();
                let files = template
                    .files("example.test", "Nginx", "PHP-8.3", "Node-24", 4321, 9123, language)
                    .unwrap();
                let home = Home::new();
                let created = template.create(&home.0, "example.test", &files).unwrap();
                for (path, text) in &files {
                    assert!(relative(path), "{id}: {path}");
                    assert!(!text.contains("__"), "unresolved marker in {language}/{id}/{path}");
                    assert!(!text.contains("\r\r\n"));
                    assert!(!text.replace("\r\n", "").contains('\n'));
                    assert_eq!(fs::read_to_string(created.join(path)).unwrap(), *text);
                }
                assert_eq!(fs::read_dir(&home.0).unwrap().count(), 1);
                let ini = &files[0].1;
                assert!(ini.starts_with("\u{feff}[example.test]\r\n\r\n"));
                assert!(crate::project_workspace::parse(ini).unwrap().contains_key("example.test"));
                if id == "laravel" {
                    assert!(!created.join("app").exists());
                    assert!(created.join("public/index.php").is_file());
                    assert!(ini.contains("project_root      = {base_dir}\r\n"));
                    assert!(ini.contains("web_root          = {base_dir}\\public\r\n"));
                    assert_eq!(crate::starter_install::state(&created, "laravel").as_deref(), Some("pending"));
                    assert!(
                        fs::read_to_string(created.join(".osp/laravel-readme.md"))
                            .unwrap()
                            .contains("PHP-8.3")
                    );
                }
                if matches!(id, "laravel" | "wordpress" | "symfony") {
                    let placeholder = fs::read(created.join("public/index.php")).unwrap();
                    assert!(crate::project_starter_locale::matches_placeholder(&created, id, &placeholder));
                    assert!(!crate::project_starter_locale::matches_placeholder(
                        &created,
                        id,
                        b"user-edited file"
                    ));
                    let marker: serde_json::Value =
                        serde_json::from_slice(&fs::read(created.join(format!(".osp/{id}.json"))).unwrap())
                            .unwrap();
                    assert_eq!(marker["language"], language);
                    assert_eq!(marker["version"], 2);
                    assert!(
                        String::from_utf8(placeholder).unwrap().contains(&format!("lang=\"{language}\""))
                    );
                    for engine in ["nginx", "apache", "caddy"] {
                        assert!(created.join(format!(".osp/{engine}/example.test.conf")).is_file());
                    }
                }
                if id == "node" {
                    assert!(ini.contains("backend_port      = 4321\r\n"));
                    assert!(
                        fs::read_to_string(created.join("server.mjs")).unwrap().contains("Number('4321')")
                    );
                    let package = fs::read_to_string(created.join("package.json")).unwrap();
                    let package: serde_json::Value = serde_json::from_str(&package).unwrap();
                    assert_eq!(package["scripts"]["start"], "node server.mjs");
                }
                if matches!(id, "node" | "laravel") {
                    let task = fs::read_to_string(created.join(".osp/tasks.ini")).unwrap();
                    assert!(task.contains(" 0 cmd.exe"));
                }
            }
        }
    }

    #[test]
    fn framework_server_configs_preserve_handlers_and_panel_placeholders() {
        for id in ["laravel", "wordpress"] {
            for domain in ["example.test", "other.test"] {
                let files =
                    template(id).unwrap().files(domain, "Nginx", "PHP-8.3", "", 3000, 9123, "en").unwrap();
                let home = Home::new();
                let created = template(id).unwrap().create(&home.0, domain, &files).unwrap();
                let config = |engine: &str| {
                    fs::read_to_string(created.join(format!(".osp/{engine}/{domain}.conf"))).unwrap()
                };
                let nginx = config("nginx");
                assert!(nginx.contains("include snippets/maintenance_mode.conf;"));
                assert!(nginx.contains("include snippets/fallback_redirect.conf;"));
                assert!(nginx.contains("fastcgi_pass $backend_ip:$backend_port;"));
                assert!(nginx.contains("try_files    $fastcgi_script_name =404;"));
                assert!(nginx.contains("include      fastcgi.conf;"));
                assert!(nginx.contains(&format!("include      env/{domain}.conf;")));
                assert!(nginx.contains("index         index.php index.html index.htm;"));
                assert!(nginx.contains("Cache-Control \"max-age=0, must-revalidate\" always;"));
                let apache = config("apache");
                assert!(apache.is_ascii());
                assert!(apache.lines().all(|line| line.trim().is_empty() || line.starts_with('#')));
                let caddy = config("caddy");
                assert!(caddy.contains("import common_host {host}"));
                assert!(caddy.contains("php_fastcgi {php_engine}:9123 {"));
                assert!(caddy.contains("request_header X-Request-Id {http.request.uuid}"));
                assert!(caddy.contains("env X_REQUEST_ID {http.request.uuid}"));
                assert!(caddy.contains("import env_{host}"));
                assert!(caddy.contains("import timeouts_config"));
                assert!(caddy.contains("\r\nfile_server\r\n"));
                assert!(!caddy.lines().any(|line| line.trim() == "import fastcgi_intercept_errors"));
                let custom_try_files = caddy.lines().any(|line| line.trim().starts_with("try_files "));
                assert_eq!(custom_try_files, id == "laravel");
                if id == "laravel" {
                    assert!(caddy.contains("try_files {path} /index.php"));
                } else {
                    let htaccess = fs::read_to_string(created.join("public/.htaccess")).unwrap();
                    assert!(htaccess.contains("RewriteRule . /index.php [L]"));
                }
            }
        }
    }

    #[test]
    fn php_port_requires_the_selected_module_and_valid_profile_port() {
        let snapshot = |port: serde_json::Value| {
            serde_json::json!({"_children":[
                {"key":"PHP-8.3", "value":{"_children":[
                    {"key":"profiles", "value":{"_children":[
                        {"key":"default", "value":{"_children":[{"key":"port", "value":{"_value":port}}]}}
                    ]}}
                ]}}
            ]})
        };
        for port in [serde_json::json!(9123), serde_json::json!("65535")] {
            assert!(php_port(&snapshot(port), "PHP-8.3").is_ok());
        }
        for port in [
            serde_json::json!("0"),
            serde_json::json!("65536"),
            serde_json::json!("bad"),
            serde_json::Value::Null,
        ] {
            assert_eq!(php_port(&snapshot(port), "PHP-8.3").unwrap_err().code, "err.invalidSettingValue");
        }
        assert_eq!(php_port(&snapshot(9123.into()), "PHP-8.4").unwrap_err().code, "err.panelNotReady");
    }

    #[test]
    fn starter_documents_and_pages_use_the_requested_language() {
        for (language, heading, ready) in [
            ("en", "# Local static site", "Your local site is ready."),
            ("ru", "# Локальный статический сайт", "Локальный сайт готов."),
            ("uk", "# Локальний статичний сайт", "Локальний сайт готовий."),
            ("be", "# Лакальны статычны сайт", "Лакальны сайт гатовы."),
            ("es", "# Sitio estático local", "Tu sitio local está listo."),
        ] {
            let files = template("static")
                .unwrap()
                .files("site.test", "Nginx", "", "", 3000, 9123, language)
                .unwrap();
            let file = |name: &str| &files.iter().find(|(path, _)| path == name).unwrap().1;
            assert!(file("README.md").starts_with(heading));
            assert!(file("README.md").contains("site.test"));
            assert!(file("public/index.html").contains(ready));
            assert!(file("public/index.html").contains(&format!("lang=\"{language}\"")));
        }
    }

    #[test]
    fn rejects_unknown_templates_unsafe_paths_and_existing_projects_without_writes() {
        assert_eq!(template("../static").unwrap_err().code, "err.projectTemplateInvalid");
        let home = Home::new();
        for path in
            ["", "../escape", "/escape", "x/../../escape", "x\\escape", "C:/escape", "x/./file", "x//file"]
        {
            let error =
                publish(&home.0, "example.test", &[], &[(path.into(), "content".into())]).unwrap_err();
            assert_eq!(error.code, "err.projectTemplateInvalid", "{path}");
            assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
        }
        assert!(publish(&home.0, "../escape", &[], &[]).is_err());
        fs::create_dir(home.0.join("example.test")).unwrap();
        fs::write(home.0.join("example.test/keep.txt"), "original").unwrap();
        fs::write(home.0.join("example.test/README.md"), "user documentation").unwrap();
        assert_eq!(publish(&home.0, "example.test", &[], &[]).unwrap_err().code, "err.projectExists");
        assert_eq!(fs::read_to_string(home.0.join("example.test/keep.txt")).unwrap(), "original");
        assert_eq!(fs::read_to_string(home.0.join("example.test/README.md")).unwrap(), "user documentation");
        assert_eq!(fs::read_dir(&home.0).unwrap().count(), 1);
    }

    #[test]
    fn discards_incomplete_staging_tree_after_a_write_failure() {
        let home = Home::new();
        let files =
            vec![(".osp/project.ini".into(), "first".into()), (".osp/project.ini".into(), "second".into())];
        assert!(publish(&home.0, "example.test", &["public".into()], &files).is_err());
        assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
    }

    #[test]
    fn prefers_installed_global_engine_then_latest_numeric_version() {
        let versions = vec!["PHP-8.9".into(), "PHP-8.10".into(), "PHP-8.3".into()];
        assert_eq!(preferred(&versions, "PHP-8.3").as_deref(), Some("PHP-8.3"));
        assert_eq!(preferred(&versions, "PHP-9.0").as_deref(), Some("PHP-8.10"));
        assert_eq!(preferred(&[], "Node-24"), None);
    }

    #[test]
    fn starter_messages_resolve_from_the_package_manifest() {
        let starter = crate::project_starters::Document {
            manifest: serde_json::from_value(serde_json::json!({
                "schemaVersion": 1, "id": "msg", "name": "Msg", "httpPreference": "any",
                "php": false, "node": false, "installer": null, "readmePath": null,
                "database": {"enabled": false, "engines": [], "defaultEngine": "none"},
                "projectRoot": "{base_dir}", "webRoot": null, "settings": {}, "directories": [],
                "messages": {"HELLO": {"en": "Hello", "ru": "Привет"}, "DATA_JSON": {"en": "quote\"x"}}
            }))
            .unwrap(),
            assets: [
                ("files/index.html".to_string(), "<p>__HELLO__</p>".to_string()),
                ("files/data.mjs".to_string(), "const v = __DATA_JSON__;".to_string()),
            ]
            .into_iter()
            .collect(),
            revision: None,
            builtin: false,
        };
        crate::project_starters::validate(&starter).unwrap();
        fn find<'a>(files: &'a [(String, String)], path: &str) -> &'a str {
            files.iter().find(|(p, _)| p == path).map(|(_, c)| c.as_str()).unwrap()
        }
        let ru = starter_files(
            &starter,
            "example.test",
            "PHP-8.3",
            0,
            3000,
            "\u{feff}[x]\r\n",
            &StarterLocale::new("ru").unwrap(),
        )
        .unwrap();
        assert!(find(&ru, "index.html").contains("Привет"));
        assert_eq!(find(&ru, "data.mjs").trim(), "const v = \"quote\\\"x\";");
        // A language missing from the package falls back to English.
        let es = starter_files(
            &starter,
            "example.test",
            "PHP-8.3",
            0,
            3000,
            "\u{feff}[x]\r\n",
            &StarterLocale::new("es").unwrap(),
        )
        .unwrap();
        assert!(find(&es, "index.html").contains("Hello"));
    }
}
