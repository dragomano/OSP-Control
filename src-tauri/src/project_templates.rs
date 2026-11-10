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
}
#[derive(Debug, Deserialize)]
struct TemplateFile {
    path: String,
    source: String,
}
pub(crate) fn template(id: &str) -> Result<Template, CommandError> {
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

pub(crate) fn preferred_http(template: &str, options: &[String], global: &str) -> Option<String> {
    if matches!(template, "wordpress" | "laravel") {
        let apache: Vec<_> = options.iter().filter(|engine| engine.starts_with("Apache")).cloned().collect();
        if !apache.is_empty() {
            return preferred(&apache, global);
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
            "html" => include_str!("../resources/project-starters/index.html"),
            "php" => include_str!("../resources/project-starters/index.php"),
            "css" => include_str!("../resources/project-starters/styles.css"),
            "node-server" => include_str!("../resources/project-starters/server.mjs"),
            "node-package" => include_str!("../resources/project-starters/package.json"),
            "static-readme" => locale.document("static")?,
            "php-readme" => locale.document("php")?,
            "laravel-readme" => locale.document("laravel")?,
            "laravel-placeholder" => include_str!("../resources/project-starters/laravel-placeholder.php"),
            "laravel-state" | "wordpress-state" => {
                let placeholder = self.content(
                    &format!("{}-placeholder", self.id),
                    domain,
                    php,
                    port,
                    php_port,
                    ini,
                    locale,
                )?;
                return Ok(locale.marker(&placeholder)?.replace('\n', "\r\n"));
            }
            "wordpress-placeholder" => {
                include_str!("../resources/project-starters/wordpress-placeholder.php")
            }
            "wordpress-readme" => locale.document("wordpress")?,
            "node-readme" => locale.document("node")?,
            "laravel-nginx" => include_str!("../resources/project-starters/laravel/nginx.conf"),
            "laravel-apache" => include_str!("../resources/project-starters/laravel/apache.conf"),
            "laravel-caddy" => include_str!("../resources/project-starters/laravel/caddy.conf"),
            "wordpress-nginx" => include_str!("../resources/project-starters/wordpress/nginx.conf"),
            "wordpress-apache" => include_str!("../resources/project-starters/wordpress/apache.conf"),
            "wordpress-caddy" => include_str!("../resources/project-starters/wordpress/caddy.conf"),
            "wordpress-rewrite" => {
                "# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n# END WordPress\n"
            }
            "laravel-tasks" => {
                "\u{feff}[__DOMAIN__]\n\n__LARAVEL_TASK__ = * * * * * * 0 cmd.exe /c \"osp project {host} & php artisan schedule:run\"\n"
            }
            "node-tasks" => {
                "\u{feff}[__DOMAIN__]\n\n__NODE_TASK__ = * * * * * 1 0 cmd.exe /c \"osp project {host} start\"\n"
            }
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
            for id in ["empty", "static", "php", "laravel", "wordpress", "node"] {
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
                    assert_eq!(crate::laravel_installer::state(&created).as_deref(), Some("pending"));
                    assert!(
                        fs::read_to_string(created.join(".osp/laravel-readme.md"))
                            .unwrap()
                            .contains("PHP-8.3")
                    );
                }
                if matches!(id, "laravel" | "wordpress") {
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
}
