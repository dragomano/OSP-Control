//! Database choices for new applications. Credentials stay outside the public directory.
use crate::{
    error::CommandError,
    paths::{external_path, hidden_command, is_valid_module_name},
    project_workspace::child,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, process::Command};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Database {
    pub(crate) engine: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) username: String,
    #[serde(default)]
    pub(crate) password: String,
    #[serde(default)]
    created: bool,
}
fn error(code: &str) -> CommandError {
    CommandError::new(code)
}
pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}
pub(crate) fn engines(root: &Path) -> Vec<String> {
    let mut result = Vec::new();
    let Ok(modules) = child(root, "modules") else { return result };
    if let Ok(entries) = fs::read_dir(&modules) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_valid_module_name(&name)
                && (name.starts_with("MySQL-")
                    || name.starts_with("MariaDB-")
                    || name.starts_with("PostgreSQL-"))
                && child(&modules, &name).is_ok_and(|p| p.is_dir())
            {
                result.push(name);
            }
        }
    }
    result.sort();
    result
}
pub(crate) fn validate(db: &Database, template: &str, available: &[String]) -> Result<(), CommandError> {
    if !matches!(template, "laravel" | "wordpress")
        || db.created
        || !(db.engine == "none"
            || (db.engine == "sqlite" && template == "laravel")
            || (available.contains(&db.engine)
                && (template == "laravel" || !db.engine.starts_with("PostgreSQL-"))))
        || (db.engine != "none" && !valid_name(&db.name))
        || db.username.len() > 128
        || db.password.len() > 1024
        || db.username.chars().any(char::is_control)
        || db.password.chars().any(char::is_control)
        || (!matches!(db.engine.as_str(), "none" | "sqlite") && db.username.is_empty())
    {
        return Err(error("err.projectDatabaseInvalid"));
    }
    Ok(())
}
pub(crate) fn files(db: &Database) -> Result<Vec<(String, String)>, CommandError> {
    Ok(vec![
        (
            ".osp/database.json".into(),
            serde_json::to_string_pretty(db).map_err(|_| error("err.projectDatabaseInvalid"))?,
        ),
        (".osp/.gitignore".into(), "/database.json\n/database-created.json\n".into()),
    ])
}
fn read(project: &Path) -> Result<Option<Database>, CommandError> {
    let path = child(&child(project, ".osp")?, "database.json")?;
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path)?.len() > 8192 {
        return Err(error("err.projectDatabaseInvalid"));
    }
    let db: Database =
        serde_json::from_slice(&fs::read(path)?).map_err(|_| error("err.projectDatabaseInvalid"))?;
    let mut input = db.clone();
    input.created = false;
    validate(&input, "laravel", &[db.engine.clone()])?;
    Ok(Some(db))
}
pub(crate) fn permitted_status_update(before: Option<&[u8]>, after: Option<&[u8]>) -> bool {
    let Some(mut before) = before.and_then(|b| serde_json::from_slice::<Database>(b).ok()) else {
        return false;
    };
    let Some(after) = after.and_then(|b| serde_json::from_slice::<Database>(b).ok()) else { return false };
    if before.created || !after.created || matches!(before.engine.as_str(), "none" | "sqlite") {
        return false;
    }
    before.created = true;
    before == after
}
#[derive(Debug)]
pub(crate) struct Connection {
    pub(crate) db: Database,
    pub(crate) host: String,
    pub(crate) port: u16,
}
fn quote_option(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
fn client(root: &Path, stage: &Path, db: &Database, host: &str, port: u16) -> Result<Command, CommandError> {
    if !engines(root).contains(&db.engine) {
        return Err(error("err.projectDatabaseModule"));
    }
    let bin = child(&child(&child(root, "modules")?, &db.engine)?, "bin")?;
    let postgres = db.engine.starts_with("PostgreSQL-");
    let tool = child(
        &bin,
        if postgres {
            "psql.exe"
        } else if child(&bin, "mysql.exe")?.is_file() {
            "mysql.exe"
        } else {
            "mariadb.exe"
        },
    )?;
    if !tool.is_file() {
        return Err(error("err.projectDatabaseModule"));
    }
    let credentials = child(stage, "database-credentials")?;
    let text = if postgres {
        let escape = |s: &str| s.replace('\\', "\\\\").replace(':', "\\:");
        format!("{}:{port}:*:{}:{}\n", escape(host), escape(&db.username), escape(&db.password))
    } else {
        format!("[client]\nuser={}\npassword={}\n", quote_option(&db.username), quote_option(&db.password))
    };
    use std::io::Write;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&credentials)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    let mut command = hidden_command(external_path(&tool));
    if postgres {
        command
            .args([
                "--no-psqlrc",
                "--no-password",
                "--tuples-only",
                "--no-align",
                "--set=ON_ERROR_STOP=1",
                "--dbname=postgres",
            ])
            .arg(format!("--username={}", db.username))
            .env("PGPASSFILE", external_path(&credentials));
        for key in [
            "PGPASSWORD",
            "PGSERVICE",
            "PGSERVICEFILE",
            "PGOPTIONS",
            "PGHOSTADDR",
            "PGHOST",
            "PGPORT",
            "PGDATABASE",
            "PGUSER",
        ] {
            command.env_remove(key);
        }
    } else {
        command
            .arg(format!("--defaults-file={}", external_path(&credentials).display()))
            .arg(format!("--user={}", db.username))
            .args(["--protocol=TCP", "--batch", "--skip-column-names"])
            .env_remove("MYSQL_PWD");
    }
    command.arg(format!("--host={host}")).arg(format!("--port={port}"));
    Ok(command)
}
fn query(
    root: &Path,
    stage: &Path,
    db: &Database,
    host: &str,
    port: u16,
    sql: &str,
) -> Result<String, CommandError> {
    let mut command = client(root, stage, db, host, port)?;
    command.arg(if db.engine.starts_with("PostgreSQL-") { "--command" } else { "--execute" }).arg(sql);
    let result = crate::module_releases::run(&mut command);
    let _ = fs::remove_file(child(stage, "database-credentials")?);
    // Never return client output: it may repeat connection credentials or SQL values.
    result
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .map_err(|_| error("err.projectDatabaseConnect"))
}
fn ensure_database(
    db: &Database,
    mut execute: impl FnMut(&str) -> Result<String, CommandError>,
) -> Result<(), CommandError> {
    let pg = db.engine.starts_with("PostgreSQL-");
    let exists = execute(&if pg {
        format!("SELECT 1 FROM pg_database WHERE datname = '{}';", db.name)
    } else {
        format!("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{}';", db.name)
    })?;
    if !db.created && !exists.is_empty() {
        return Err(error("err.projectDatabaseExists").with("name", &db.name));
    }
    if exists.is_empty() {
        execute(&if pg {
            format!("CREATE DATABASE \"{}\";", db.name)
        } else {
            format!("CREATE DATABASE `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", db.name)
        })?;
    }
    Ok(())
}
pub(crate) fn provision(
    root: &Path,
    project: &Path,
    stage: &Path,
    wordpress: bool,
) -> Result<Option<Connection>, CommandError> {
    let Some(mut db) = read(project)? else { return Ok(None) };
    if db.engine == "none" {
        return Ok(None);
    }
    if db.engine == "sqlite" {
        if wordpress {
            return Err(error("err.projectDatabaseInvalid"));
        }
        return Ok(Some(Connection { db, host: String::new(), port: 0 }));
    }
    if wordpress && db.engine.starts_with("PostgreSQL-") {
        return Err(error("err.projectDatabaseInvalid"));
    }
    let (running, profile) = crate::db::db_module_state(root, &db.engine)
        .ok_or_else(|| error("err.projectDatabaseStopped").with("module", &db.engine))?;
    if !running {
        return Err(error("err.projectDatabaseStopped").with("module", &db.engine));
    }
    let pg = db.engine.starts_with("PostgreSQL-");
    let config = if pg {
        let profile = if is_valid_module_name(&profile) { profile.as_str() } else { "default" };
        child(&child(&child(&child(root, "data")?, &db.engine)?, profile)?, "postgresql.conf")?
    } else {
        child(&child(&child(root, "modules")?, &db.engine)?, "my.ini")?
    };
    let text = fs::read_to_string(config).map_err(|_| error("err.projectDatabaseModule"))?;
    let host = crate::db::ini_first_value(&text, if pg { "listen_addresses" } else { "bind_address" })
        .ok_or_else(|| error("err.projectDatabaseInvalid"))?;
    let port = crate::db::ini_first_value(&text, "port")
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p != 0)
        .ok_or_else(|| error("err.projectDatabaseInvalid"))?;
    let endpoint = crate::db::DbEndpoint { host: crate::db::normalize_bind_host(&host, pg), port };
    if endpoint.host != "localhost"
        && !endpoint.host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    {
        return Err(error("err.projectDatabaseInvalid"));
    }
    ensure_database(&db, |sql| query(root, stage, &db, &endpoint.host, endpoint.port, sql))?;
    if !db.created {
        if read(project)?.as_ref() != Some(&db) {
            return Err(error("err.projectWorkspaceConflict"));
        }
        db.created = true;
        let osp = child(project, ".osp")?;
        let path = child(&osp, "database.json")?;
        let temp = child(&osp, "database-created.json")?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(
            serde_json::to_string_pretty(&db).map_err(|_| error("err.projectDatabaseInvalid"))?.as_bytes(),
        )?;
        file.sync_all()?;
        drop(file);
        fs::rename(temp, path)?;
    }
    Ok(Some(Connection { db, host: endpoint.host, port: endpoint.port }))
}
fn env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$"))
}
pub(crate) fn env_set(content: &str, key: &str, value: &str) -> String {
    let mut found = false;
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| {
            if line.split_once('=').is_some_and(|(name, _)| name.trim() == key) {
                found = true;
                format!("{key}={}", env_value(value))
            } else {
                line.to_string()
            }
        })
        .collect();
    if !found {
        lines.push(format!("{key}={}", env_value(value)));
    }
    lines.join("\n") + "\n"
}
pub(crate) fn laravel_env(content: &str, connection: Option<&Connection>, sqlite_path: &str) -> String {
    let mut result = content.to_string();
    if let Some(c) = connection {
        for (key, value) in [
            (
                "DB_CONNECTION",
                if c.db.engine == "sqlite" {
                    "sqlite"
                } else if c.db.engine.starts_with("PostgreSQL-") {
                    "pgsql"
                } else {
                    "mysql"
                },
            ),
            ("DB_HOST", &c.host),
            ("DB_PORT", &c.port.to_string()),
            ("DB_DATABASE", if c.db.engine == "sqlite" { sqlite_path } else { &c.db.name }),
            ("DB_USERNAME", &c.db.username),
            ("DB_PASSWORD", &c.db.password),
        ] {
            result = env_set(&result, key, value);
        }
    } else {
        for (key, value) in
            [("SESSION_DRIVER", "file"), ("CACHE_STORE", "file"), ("QUEUE_CONNECTION", "sync")]
        {
            result = env_set(&result, key, value);
        }
    }
    result
}
pub(crate) fn php_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_identifiers_and_compatibility_are_restricted() {
        for name in ["", "1site", "site-name", "site';DROP DATABASE x", "../outside", "site\n"] {
            assert!(!valid_name(name));
        }
        let mut db = Database {
            engine: "sqlite".into(),
            name: "site_test".into(),
            username: "".into(),
            password: "".into(),
            created: false,
        };
        assert!(validate(&db, "laravel", &[]).is_ok());
        assert!(validate(&db, "wordpress", &[]).is_err());
        db.engine = "PostgreSQL-17".into();
        db.username = "postgres".into();
        assert!(validate(&db, "wordpress", &[db.engine.clone()]).is_err());
        assert!(validate(&db, "laravel", &[db.engine.clone()]).is_ok());
        db.created = true;
        assert!(validate(&db, "laravel", &[db.engine.clone()]).is_err());
    }
    #[test]
    fn credentials_are_escaped_in_configuration_files() {
        assert_eq!(php_string("a'\\b"), "'a\\'\\\\b'");
        assert_eq!(
            env_set("DB_PASSWORD=old\nOTHER=kept\n", "DB_PASSWORD", "a\"$\\b"),
            "DB_PASSWORD=\"a\\\"\\$\\\\b\"\nOTHER=kept\n"
        );
        assert_eq!(quote_option("a\"\\b"), "\"a\\\"\\\\b\"");
    }
    #[test]
    fn existing_database_is_never_reused_without_installer_ownership() {
        let mut db: Database =
            serde_json::from_str(r#"{"engine":"MySQL-8.4","name":"site_test","username":"root"}"#).unwrap();
        let mut calls = Vec::new();
        let error = ensure_database(&db, |sql| {
            calls.push(sql.to_string());
            Ok("1".into())
        })
        .unwrap_err();
        assert_eq!(error.code, "err.projectDatabaseExists");
        assert_eq!(calls.len(), 1);
        db.created = true;
        ensure_database(&db, |_| Ok("1".into())).unwrap();
        db.created = false;
        calls.clear();
        ensure_database(&db, |sql| {
            calls.push(sql.to_string());
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].starts_with("CREATE DATABASE `site_test`"));
        assert!(!calls[1].contains("IF NOT EXISTS"));
        db.engine = "PostgreSQL-17".into();
        calls.clear();
        ensure_database(&db, |sql| {
            calls.push(sql.to_string());
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(calls[1], "CREATE DATABASE \"site_test\";");
    }
    #[test]
    fn database_client_keeps_passwords_out_of_arguments_and_connection_configuration() {
        let root = std::env::temp_dir().join(format!(
            "osp-db-client-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(root.join("modules/MySQL-8.4/bin")).unwrap();
        fs::write(root.join("modules/MySQL-8.4/bin/mysql.exe"), []).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let db: Database = serde_json::from_str(
            r#"{"engine":"MySQL-8.4","name":"site_test","username":"root","password":"synthetic-secret"}"#,
        )
        .unwrap();
        let command = client(&root, &root, &db, "127.0.1.20", 3306).unwrap();
        assert!(!command.get_args().any(|a| a.to_string_lossy().contains("synthetic-secret")));
        assert!(
            fs::read_to_string(root.join("database-credentials"))
                .unwrap()
                .contains("password=\"synthetic-secret\"")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_update_allows_only_the_installer_creation_flag() {
        let before = br#"{"engine":"MySQL-8.4","name":"site_test","username":"root"}"#;
        let mut after: serde_json::Value = serde_json::from_slice(before).unwrap();
        after["created"] = true.into();
        assert!(permitted_status_update(Some(before), Some(&serde_json::to_vec(&after).unwrap())));
        after["name"] = "changed".into();
        assert!(!permitted_status_update(Some(before), Some(&serde_json::to_vec(&after).unwrap())));
        assert!(!permitted_status_update(None, Some(before)));
    }
}
