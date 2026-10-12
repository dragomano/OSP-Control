//! Logical dumps of the database modules (MySQL/MariaDB, PostgreSQL) into backups/.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::backups::{backup_target, backups_root, parse_backup_id, BackupEntry, BackupKind};
use crate::error::{command_failed, spawn_failed, CommandError};
use crate::panel_api::{api_json, dat_node_map, dat_string_value};
use crate::paths::{is_valid_module_name, resolve_installation, unix_now};

// --- Logical database dumps (MySQL/MariaDB/PostgreSQL) ---

// Engines we can dump (see KNOWN_MODULES).
enum DbEngine {
    Mysql,
    Postgres,
}

fn db_engine(module: &str) -> Option<DbEngine> {
    if module.starts_with("MySQL") || module.starts_with("MariaDB") {
        Some(DbEngine::Mysql)
    } else if module.starts_with("Postgre") {
        Some(DbEngine::Postgres)
    } else {
        None
    }
}

// Module state from /getmodules: (process running, active profile).
// handle — the process descriptor inside the panel; -1 means not running. With the
// panel stopped or the module missing, the module is considered not running.
fn db_module_state(root: &Path, module: &str) -> Option<(bool, String)> {
    let json = api_json(root, "/getmodules")?;
    let node = dat_node_map(&json)?.get(module).copied()?;
    let fields = dat_node_map(node)?;
    let handle = fields
        .get("handle")
        .and_then(|field| field.get("_value"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(-1);
    let profile = fields.get("profile").map(|field| dat_string_value(field)).unwrap_or_default();
    Some((handle != -1, profile))
}

// A key's value in an ini-like file: the first "key = value" line;
// comments (";"/"#" and a trailing "#") are dropped, quotes are stripped.
fn ini_first_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let value = value.split('#').next().unwrap_or(value);
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

// Normalizing a bind/listen address to a connect address: for PostgreSQL it is
// a list ("localhost, 127.0.1.49") or "*"; empty/0.0.0.0 → 127.0.0.1.
fn normalize_bind_host(value: &str, is_list: bool) -> String {
    if !is_list {
        return if value == "0.0.0.0" { "127.0.0.1".into() } else { value.to_string() };
    }
    if value.contains('*') || value.contains("localhost") {
        return "127.0.0.1".into();
    }
    value.split(',').map(str::trim).find(|part| !part.is_empty()).unwrap_or("127.0.0.1").to_string()
}

// Address of the running DBMS: bind/listen and port come from the module's own
// config (modules/<module>/my.ini or data/<module>/<profile>/postgresql.conf) —
// OSPanel assigns modules local addresses of the 127.0.1.x form.
struct DbEndpoint {
    host: String,
    port: u16,
}

fn db_endpoint(root: &Path, module: &str) -> DbEndpoint {
    let is_postgres = matches!(db_engine(module), Some(DbEngine::Postgres));
    let default_port = if is_postgres { 5432 } else { 3306 };

    let (_, profile) = db_module_state(root, module).unwrap_or((false, String::new()));
    let profile = if is_valid_module_name(&profile) { profile } else { "default".into() };

    let path = if is_postgres {
        root.join("data").join(module).join(profile).join("postgresql.conf")
    } else {
        root.join("modules").join(module).join("my.ini")
    };
    let text = fs::read_to_string(path).unwrap_or_default();
    let port = ini_first_value(&text, "port")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(default_port);
    let host = ini_first_value(&text, if is_postgres { "listen_addresses" } else { "bind_address" })
        .map(|value| normalize_bind_host(&value, is_postgres))
        .unwrap_or_else(|| "127.0.0.1".into());
    DbEndpoint { host, port }
}

// Logical DB dump: the utility's stdout is written to the future backup file. The dump
// is taken only from a running server (in a stream of consistent data —
// mysqldump --single-transaction), usually hundreds of megabytes instead of gigabytes.
fn make_db_dump(root: &Path, backups: &Path, module: &str, id: &str) -> Result<u64, CommandError> {
    let engine =
        db_engine(module).ok_or_else(|| CommandError::new("err.dumpUnsupported").with("module", module))?;
    let bin = root.join("modules").join(module).join("bin");
    let tool = match engine {
        DbEngine::Mysql => bin.join("mysqldump.exe"),
        DbEngine::Postgres => bin.join("pg_dumpall.exe"),
    };
    if !tool.is_file() {
        return Err(CommandError::new("err.dumpToolNotFound").with("module", module));
    }

    let endpoint = db_endpoint(root, module);
    let out = backups.join(format!("{}.sql", id));
    let output_file = fs::File::create(&out)?;
    let mut command = Command::new(&tool);
    command.arg(format!("--host={}", endpoint.host)).arg(format!("--port={}", endpoint.port));
    match engine {
        DbEngine::Mysql => {
            command.args([
                "--protocol=TCP",
                "--user=root",
                "--single-transaction",
                "--routines",
                "--triggers",
                "--events",
                "--all-databases",
            ]);
        }
        DbEngine::Postgres => {
            // pg_dumpall grabs all databases and roles in one file; --clean emits
            // DROP before CREATE — restoring overwrites the state.
            command.args(["--username=postgres", "--no-password", "--clean", "--if-exists"]);
        }
    }

    let output = command
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|child| child.wait_with_output())
        .map_err(spawn_failed)?;
    if !output.status.success() {
        let _ = fs::remove_file(&out);
        return Err(command_failed("err.dumpFailed", &output));
    }
    Ok(fs::metadata(&out).map(|meta| meta.len()).unwrap_or(0))
}

#[tauri::command]
pub fn create_db_backup(module: String, custom_path: Option<String>) -> Result<BackupEntry, CommandError> {
    if !is_valid_module_name(&module) {
        return Err(CommandError::new("err.invalidModuleName"));
    }
    if db_engine(&module).is_none() {
        return Err(CommandError::new("err.dumpUnsupported").with("module", module));
    }

    let root = resolve_installation(custom_path.as_deref())?;
    let (running, _) = db_module_state(&root, &module).unwrap_or((false, String::new()));
    if !running {
        return Err(CommandError::new("err.dbNotRunning").with("module", module));
    }

    let backups = backups_root(custom_path.as_deref())?;
    let secs = unix_now();
    let id = format!("backup-{}-db-{}", secs, module);
    let size_bytes = make_db_dump(&root, &backups, &module, &id)?;
    Ok(BackupEntry {
        id,
        created_at: secs,
        size_bytes,
        files: 1,
        kind: BackupKind::Db(module.clone()).as_str().into(),
        subject: Some(module),
    })
}

#[tauri::command]
pub fn restore_db_backup(id: String, custom_path: Option<String>) -> Result<(), CommandError> {
    let Some((_, _, kind)) = parse_backup_id(&id) else {
        return Err(CommandError::new("err.invalidBackupId"));
    };
    let BackupKind::Db(module) = kind else {
        return Err(CommandError::new("err.operationNotAllowed"));
    };
    let engine = db_engine(&module)
        .ok_or_else(|| CommandError::new("err.dumpUnsupported").with("module", module.as_str()))?;

    let root = resolve_installation(custom_path.as_deref())?;
    let (running, _) = db_module_state(&root, &module).unwrap_or((false, String::new()));
    if !running {
        return Err(CommandError::new("err.dbNotRunning").with("module", module));
    }

    let backups = backups_root(custom_path.as_deref())?;
    let backups_canonical = fs::canonicalize(&backups)?;
    let dump = backup_target(backups.join(format!("{}.sql", id)), &backups_canonical, &id)?;

    // Before importing, the current server state is dumped automatically.
    let safety_id = format!("backup-{}-auto-db-{}", unix_now(), module);
    make_db_dump(&root, &backups, &module, &safety_id)?;

    let endpoint = db_endpoint(&root, &module);
    let bin = root.join("modules").join(&module).join("bin");
    let tool = match engine {
        DbEngine::Mysql => bin.join("mysql.exe"),
        DbEngine::Postgres => bin.join("psql.exe"),
    };
    if !tool.is_file() {
        return Err(CommandError::new("err.dumpToolNotFound").with("module", module));
    }

    let input = fs::File::open(&dump)?;
    let mut command = Command::new(&tool);
    command
        .arg(format!("--host={}", endpoint.host))
        .arg(format!("--port={}", endpoint.port))
        .stdin(Stdio::from(input))
        .stderr(Stdio::piped());
    match engine {
        DbEngine::Mysql => {
            command.args(["--protocol=TCP", "--user=root"]);
        }
        DbEngine::Postgres => {
            // psql reads SQL from stdin; we connect to the service database postgres,
            // the pg_dumpall dump switches to the right databases itself (\connect).
            command.args(["--username=postgres", "--no-password", "--dbname=postgres"]);
        }
    }
    let output = command.spawn().and_then(|child| child.wait_with_output()).map_err(spawn_failed)?;
    if !output.status.success() {
        return Err(command_failed("err.importFailed", &output));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values from module configs: bind/listen and port (with comments,
    // quotes and the PostgreSQL address list).
    #[test]
    fn ini_values_read_from_module_configs() {
        let mysql = "[mysqld]\nbind_address = 127.0.1.30\nport = 3306\n";
        assert_eq!(ini_first_value(mysql, "bind_address").as_deref(), Some("127.0.1.30"));
        assert_eq!(ini_first_value(mysql, "port").as_deref(), Some("3306"));
        assert_eq!(ini_first_value(mysql, "missing"), None);

        let pg = "listen_addresses = '127.0.1.49'    # comment\nport = 5432\n";
        assert_eq!(ini_first_value(pg, "listen_addresses").as_deref(), Some("127.0.1.49"));
        assert_eq!(ini_first_value(pg, "port").as_deref(), Some("5432"));

        assert_eq!(normalize_bind_host("0.0.0.0", false), "127.0.0.1");
        assert_eq!(normalize_bind_host("127.0.1.30", false), "127.0.1.30");
        assert_eq!(normalize_bind_host("localhost, 127.0.1.49", true), "127.0.0.1");
        assert_eq!(normalize_bind_host("*", true), "127.0.0.1");
        assert_eq!(normalize_bind_host("127.0.1.49", true), "127.0.1.49");
    }

    // DB commands: name whitelist, supported engine, running module.
    // The API is raised on a dead address (127.0.0.1:1) so the test does not depend
    // on a panel actually running on the machine.
    #[test]
    fn db_backup_guards_module_engine_and_running_state() {
        let root = std::env::temp_dir().join(format!("osp-ui-bkdb-{}", std::process::id()));
        fs::create_dir_all(root.join("system")).unwrap();
        fs::write(
            root.join("system").join("program.dat"),
            r#"{"_type":"Empty","_strict":true,"_children":[
                {"key":"general","value":{"_type":"Empty","_children":[
                    {"key":"api_ip","value":{"_type":"UString","_value":"127.0.0.1"}},
                    {"key":"api_port","value":{"_type":"UString","_value":"1"}}
                ]}}
            ]}"#,
        )
        .unwrap();
        let custom = Some(root.to_string_lossy().into_owned());

        let bad_name = create_db_backup("..\\evil".into(), custom.clone()).unwrap_err();
        assert_eq!(bad_name.code, "err.invalidModuleName");

        let mongo = create_db_backup("MongoDB-7.0".into(), custom.clone()).unwrap_err();
        assert_eq!(mongo.code, "err.dumpUnsupported");

        let stopped = create_db_backup("MySQL-8.0".into(), custom.clone()).unwrap_err();
        assert_eq!(stopped.code, "err.dbNotRunning");

        // A config backup cannot be restored by the DB command and vice versa.
        let wrong = restore_db_backup("backup-1700000000".into(), custom.clone()).unwrap_err();
        assert_eq!(wrong.code, "err.operationNotAllowed");
        let trash = restore_db_backup("trash".into(), custom.clone()).unwrap_err();
        assert_eq!(trash.code, "err.invalidBackupId");

        fs::remove_dir_all(&root).unwrap();
    }
}
