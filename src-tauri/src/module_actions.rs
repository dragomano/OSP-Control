//! Stock OSPanel module shortcuts. Only fixed CLI verbs are executed here.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Deserialize;

use crate::{
    error::{CommandError, spawn_failed},
    panel_api::{
        active_profile_settings, api_json, dat_field, dat_string_value, module_actions, parse_osp_json,
    },
    paths::{explorer_open, external_path, is_valid_module_name, resolve_installation},
    shell::open_in_browser,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ModuleOpenAction {
    Console,
    Explorer,
    Browser,
    Shell,
}

fn checked_path(root: &Path, relative: &Path) -> Result<PathBuf, CommandError> {
    let path = fs::canonicalize(root.join(relative))?;
    if !path.starts_with(root) {
        return Err(CommandError::new("err.accessDenied"));
    }
    Ok(path)
}

fn module_directory(root: &Path, name: &str) -> Result<PathBuf, CommandError> {
    if !is_valid_module_name(name) {
        return Err(CommandError::new("err.invalidModuleName"));
    }
    let directory = checked_path(root, &Path::new("modules").join(name))?;
    if !directory.is_dir() {
        return Err(CommandError::new("err.serviceNotFound"));
    }
    Ok(directory)
}

fn windows_terminal(root: &Path) -> bool {
    checked_path(root, Path::new("system/program.dat"))
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| parse_osp_json(&text))
        .and_then(|json| {
            dat_field(&json, "general")
                .and_then(|node| dat_field(node, "use_win_terminal"))
                .map(dat_string_value)
        })
        .is_some_and(|value| value == "on" || value == "1")
}

fn terminal_script(name: &str, shell: bool) -> String {
    let verb = if shell { "shell" } else { "use" };
    // The path is expanded once by cmd from an environment variable, never interpolated
    // as shell syntax. The module name has already passed the argument whitelist.
    format!(r#""%OSP_CONTROL_CLI%" reset init noprint & "%OSP_CONTROL_CLI%" {verb} {name}"#)
}

fn terminal_command(root: &Path, cli: &Path, name: &str, shell: bool, use_wt: bool) -> Command {
    let script = terminal_script(name, shell);
    let mut command = Command::new(if use_wt { "wt.exe" } else { "cmd.exe" });
    if use_wt {
        command.args(["nt", "-d"]).arg(external_path(root)).arg("cmd.exe");
    }
    command.args(["/D", "/V:OFF", "/K"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if use_wt {
            // Windows Terminal adds the outer quotes when rebuilding the child command line.
            command.arg(script);
        } else {
            command.raw_arg(format!("\"{script}\""));
            command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
        }
    }
    #[cfg(not(windows))]
    command.arg(format!("\"{script}\""));
    command.current_dir(external_path(root)).env("OSP_CONTROL_CLI", external_path(cli));
    command
}

// Recheck the live profile at click time: the panel may have changed since discovery.
fn live_target(node: &serde_json::Value, action: ModuleOpenAction) -> Result<Option<String>, CommandError> {
    let actions = module_actions(node);
    match action {
        ModuleOpenAction::Browser if actions.browser => {
            let profile = dat_field(node, "profile").map(dat_string_value).unwrap_or_default();
            Ok(active_profile_settings(node, &profile)
                .and_then(|settings| dat_field(settings, "web_ui_url"))
                .map(dat_string_value))
        }
        ModuleOpenAction::Shell if actions.shell => Ok(None),
        _ => Err(CommandError::new("err.operationNotAllowed")),
    }
}

#[tauri::command]
pub fn open_module(
    name: String,
    action: ModuleOpenAction,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    let _guard = crate::module_updates::mutation()?;
    let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
    let directory = module_directory(&root, &name)?;
    if matches!(action, ModuleOpenAction::Explorer) {
        return explorer_open(&external_path(&directory));
    }
    if matches!(action, ModuleOpenAction::Browser | ModuleOpenAction::Shell) {
        let json = api_json(&root, "/getmodules").ok_or_else(|| CommandError::new("err.panelNotReady"))?;
        let node = dat_field(&json, &name).ok_or_else(|| CommandError::new("err.serviceNotFound"))?;
        if let Some(url) = live_target(node, action)? {
            return open_in_browser(url);
        }
        // osp shell uses this generated script, not an arbitrary command from the UI.
        let script = checked_path(&root, &Path::new("data/cli").join(format!("shell_{name}.bat")))?;
        if !script.is_file() {
            return Err(CommandError::new("err.operationNotAllowed"));
        }
    }
    let cli = checked_path(&root, Path::new("bin/osp.bat"))?;
    if !cli.is_file() {
        return Err(CommandError::new("err.operationNotAllowed"));
    }
    terminal_command(&root, &cli, &name, matches!(action, ModuleOpenAction::Shell), windows_terminal(&root))
        .spawn()
        .map_err(spawn_failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn node(enabled: Value, profile: &str, shell: &str, url: &str) -> Value {
        let field = |key: &str, value: Value| json!({"key": key, "value": {"_value": value}});
        let profile_node = |name: &str, shell: &str, url: &str| {
            json!({
                "key": name, "value": {"_children": [
                    field("shell_command", json!(shell)), field("web_ui_url", json!(url))
                ]}
            })
        };
        json!({"_children": [
            field("enabled", enabled), field("profile", json!(profile)),
            {"key": "profiles", "value": {"_children": [
                profile_node("default", "", ""), profile_node("custom", shell, url)
            ]}}
        ]})
    }

    #[test]
    fn stock_conditions_use_enabled_and_the_active_profile() {
        let module = node(json!(true), "custom", "example-cli", "https://module.test:8443/ui");
        let actions = module_actions(&module);
        assert!(actions.browser && actions.shell);
        assert_eq!(
            live_target(&module, ModuleOpenAction::Browser).unwrap().as_deref(),
            Some("https://module.test:8443/ui")
        );
        assert_eq!(live_target(&module, ModuleOpenAction::Shell).unwrap(), None);

        for enabled in [json!(false), json!("on"), Value::Null] {
            let module = node(enabled, "custom", "example-cli", "https://module.test");
            assert_eq!(module_actions(&module), Default::default());
            assert_eq!(
                live_target(&module, ModuleOpenAction::Browser).unwrap_err().code,
                "err.operationNotAllowed"
            );
            assert!(live_target(&module, ModuleOpenAction::Shell).is_err());
        }
        for profile in ["default", "missing", ""] {
            assert_eq!(
                module_actions(&node(json!(true), profile, "example-cli", "https://module.test")),
                Default::default()
            );
        }
        let blank = node(json!(true), "custom", " \t", "\n ");
        assert_eq!(module_actions(&blank), Default::default());
    }

    #[test]
    fn browser_and_shell_are_independent_of_module_name_or_category() {
        let browser = node(json!(true), "custom", "", "https://module.test");
        assert!(module_actions(&browser).browser);
        assert!(!module_actions(&browser).shell);
        let shell = node(json!(true), "custom", "example-cli", "");
        assert!(!module_actions(&shell).browser);
        assert!(module_actions(&shell).shell);
        let json = json!({"_children": [{"key": "Example", "value": browser}]});
        assert!(crate::panel_api::services_from_json(&json)[0].module_actions.browser);
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-actions-{}-{nonce}", std::process::id()));
            fs::create_dir_all(root.join("installation/modules/Example")).unwrap();
            fs::create_dir_all(root.join("installation/system")).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn root(&self) -> PathBuf {
            self.0.join("installation")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path()));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn validates_module_names_and_canonical_paths() {
        let fixture = Fixture::new();
        let root = fixture.root();
        assert!(module_directory(&root, "Example").unwrap().starts_with(&root));
        for name in ["../Example", "Example & calc", "Example%PATH%", "Example\"", "-bad/arg", ""] {
            assert_eq!(module_directory(&root, name).unwrap_err().code, "err.invalidModuleName");
        }
        fs::write(fixture.0.join("outside.bat"), "").unwrap();
        assert_eq!(checked_path(&root, Path::new("../outside.bat")).unwrap_err().code, "err.accessDenied");
        assert!(serde_json::from_str::<ModuleOpenAction>("\"run-anything\"").is_err());
    }

    #[test]
    fn reads_windows_terminal_preference_without_changing_program_dat() {
        let fixture = Fixture::new();
        assert!(!windows_terminal(&fixture.root()));
        for enabled in [true, false] {
            let content = json!({"_children": [{"key": "general", "value": {"_children": [
                {"key": "use_win_terminal", "value": {"_value": enabled}}
            ]}}]})
            .to_string();
            let path = fixture.root().join("system/program.dat");
            fs::write(&path, &content).unwrap();
            assert_eq!(windows_terminal(&fixture.root()), enabled);
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
    }

    #[cfg(windows)]
    #[test]
    fn cmd_initializes_then_activates_the_module_without_reinterpreting_paths() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let bin = fixture.root().join("space %OSP_ACTION_TEST% & cli!");
        fs::create_dir(&bin).unwrap();
        let cli = bin.join("osp.bat");
        fs::write(&cli, "@echo %*\r\n@set OSP_CONTROL_CLI=\r\n").unwrap();
        for (shell, verb) in [(false, "use"), (true, "shell")] {
            let output = Command::new("cmd.exe")
                .args(["/D", "/V:OFF", "/C"])
                .raw_arg(format!("\"{}\"", terminal_script("Example-1.0", shell)))
                .env("OSP_CONTROL_CLI", external_path(&cli))
                .env("OSP_ACTION_TEST", "unexpected")
                .creation_flags(0x0800_0000)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert_eq!(
                stdout.lines().collect::<Vec<_>>(),
                ["reset init noprint", &format!("{verb} Example-1.0")]
            );
        }
    }
}
