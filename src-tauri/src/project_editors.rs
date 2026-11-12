//! Project program shortcuts loaded from saved menus, never from frontend command strings.
use std::{fs, path::Path, process::Command};

use serde::Serialize;

use crate::{
    error::{CommandError, spawn_failed},
    menu::{MenuItem, read_menu},
    paths::{external_path, normalize_project_domain, resolve_installation},
    project_workspace::{base, read_project_menu},
};

#[derive(Serialize)]
pub(crate) struct ProjectEditor {
    id: String,
    name: String,
    exe: String,
}

const SHELLS: [&str; 7] =
    ["cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe", "explorer.exe"];
const PROJECT_TOKENS: [&str; 3] = ["{base_dir}", "{project_dir}", "{project_root}"];
const GENERIC_DIRS: [&str; 12] = [
    "bin", "apps", "app", "program", "programs", "x64", "x86", "win", "windows", "dist", "release",
    "portable",
];

// Follow Windows backslash-before-quote rules without invoking a command interpreter.
fn arguments(text: &str) -> Option<Vec<String>> {
    let mut chars = text.chars().peekable();
    let mut args = Vec::new();
    let mut arg = String::new();
    let mut quoted = false;
    let mut started = false;
    while let Some(c) = chars.next() {
        if c.is_control() {
            return None;
        }
        if c == '\\' {
            let mut count = 1;
            while chars.peek() == Some(&'\\') {
                chars.next();
                count += 1;
            }
            if chars.peek() == Some(&'"') {
                arg.extend(std::iter::repeat_n('\\', count / 2));
                chars.next();
                if count % 2 == 1 {
                    arg.push('"');
                } else {
                    quoted = !quoted;
                }
            } else {
                arg.extend(std::iter::repeat_n('\\', count));
            }
            started = true;
        } else if c == '"' {
            quoted = !quoted;
            started = true;
        } else if c.is_whitespace() && !quoted {
            if started {
                args.push(std::mem::take(&mut arg));
                started = false;
            }
        } else {
            arg.push(c);
            started = true;
        }
    }
    if quoted {
        return None;
    }
    if started {
        args.push(arg);
    }
    Some(args)
}

fn executable_in_token(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".com"] {
        let mut offset = 0;
        while let Some(index) = lower[offset..].find(extension) {
            let end = offset + index + extension.len();
            let next = lower[end..].chars().next();
            if next.is_none_or(|c| c.is_whitespace() || "\"',;)]}".contains(c)) {
                let before = &token[..end];
                let start = before.rfind(|c| c == '"' || c == '\'' || c == '=').map_or(0, |i| i + 1);
                let path = before[start..].trim();
                if !path.is_empty() {
                    return Some(path.into());
                }
            }
            offset = end;
        }
    }
    None
}

// Find the program a menu command launches, skipping shells and command wrappers.
fn executable_path(command: &str) -> Option<String> {
    for token in arguments(command)? {
        let Some(path) = executable_in_token(&token) else { continue };
        let lower = path.to_ascii_lowercase();
        let filename = lower.rsplit(['\\', '/']).next().unwrap_or(&lower);
        if !SHELLS.contains(&filename) {
            return Some(path);
        }
    }
    None
}

fn executable_stem(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let file = normalized.rsplit('/').next().unwrap_or(&normalized);
    file.rsplit_once('.').map_or(file, |(stem, _)| stem).to_ascii_lowercase()
}

// Prefer the install folder ("Sublime", "Microsoft VS Code") over generic launcher names
// such as "subl" or "code"; fall back to the executable stem for bare commands.
fn program_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let file = normalized.rsplit('/').next().unwrap_or(&normalized);
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    let parent = normalized.rsplit('/').nth(1).unwrap_or("");
    if !parent.is_empty() && !GENERIC_DIRS.contains(&parent.to_ascii_lowercase().as_str()) {
        parent.into()
    } else {
        stem.into()
    }
}

// The executable path gives the stable program identity, while the caption may contain its full
// public name ("Sublime Text" for apps\Sublime\subl.exe). Extend the path-derived name only when
// the caption contains it as a whole word and has more text after it; no language-specific words.
fn display_name(caption: &str, path: &str) -> String {
    let base = program_name(path);
    let stem = executable_stem(path);
    let lower_caption = caption.to_lowercase();
    if lower_caption.len() == caption.len() {
        for candidate in [base.as_str(), stem.as_str()] {
            if candidate.is_empty() {
                continue;
            }
            let lower_candidate = candidate.to_lowercase();
            let mut offset = 0;
            while let Some(index) = lower_caption[offset..].find(&lower_candidate) {
                let start = offset + index;
                let end = start + lower_candidate.len();
                let before = lower_caption[..start].chars().next_back();
                let after = lower_caption[end..].chars().next();
                let boundary =
                    before.is_none_or(|c| !c.is_alphanumeric()) && after.is_none_or(|c| !c.is_alphanumeric());
                if boundary && !lower_caption[end..].trim().is_empty() {
                    return caption[start..].trim().into();
                }
                offset = end;
            }
        }
    }
    base
}

fn needs_shell(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    command.contains(['%', '!', '&', '|', '<', '>', '^', '(', ')'])
        || lower.starts_with("start ")
        || lower.starts_with("cmd ")
        || lower.starts_with("cmd.exe ")
        || lower.starts_with("powershell")
        || lower.starts_with("pwsh")
        || lower.starts_with("%comspec%")
        || lower.contains(" /c ")
}

fn eligible(item: &MenuItem, domain: &str) -> bool {
    let field = |key: &str| item.fields.get(key).map(String::as_str).unwrap_or("");
    let category = field("category");
    if ["modules", "addons"]
        .iter()
        .any(|scope| category == *scope || category.starts_with(&format!("{scope}\\")))
    {
        return false;
    }
    if !category.is_empty() && category != "projects" && category != format!("projects\\{domain}") {
        // Custom global groups may also contain project-aware editor shortcuts.
        if category.starts_with("projects\\")
            || !PROJECT_TOKENS.iter().any(|token| field("command").contains(token))
        {
            return false;
        }
    }
    if field("enabled").eq_ignore_ascii_case("off") {
        return false;
    }
    if item.fields.iter().any(|(key, value)| key.starts_with("need_") && !value.is_empty() && value != "off")
    {
        return false;
    }
    let command = field("command");
    PROJECT_TOKENS.iter().any(|token| command.contains(token)) && executable_path(command).is_some()
}

fn items(
    domain: &str,
    base_dir: &str,
    custom_path: Option<String>,
) -> Result<Vec<(String, MenuItem)>, CommandError> {
    // Listing is best-effort: a broken global or project menu must not hide the other source.
    let global = read_menu(custom_path.clone()).map(|document| document.items).unwrap_or_default();
    let project = read_project_menu(domain.into(), base_dir.into(), custom_path)
        .map(|document| document.items)
        .unwrap_or_default();
    Ok(global
        .into_iter()
        .map(|item| (format!("global:{}", item.id), item))
        .chain(project.into_iter().map(|item| (format!("project:{}", item.id), item)))
        .filter(|(_, item)| eligible(item, domain))
        .collect())
}

#[tauri::command]
pub fn list_project_editors(
    domain: String,
    base_dir: String,
    custom_path: Option<String>,
) -> Result<Vec<ProjectEditor>, CommandError> {
    let domain = normalize_project_domain(&domain)?;
    fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
    Ok(items(&domain, &base_dir, custom_path)?
        .into_iter()
        .map(|(id, item)| {
            let path = executable_path(item.fields.get("command").map(String::as_str).unwrap_or(""))
                .unwrap_or_default();
            let caption = item.fields.get("caption").map(String::as_str).unwrap_or("");
            ProjectEditor { id, name: display_name(caption, &path), exe: executable_stem(&path) }
        })
        .collect())
}

fn launch(root: &Path, directory: &Path, domain: &str, item: &MenuItem) -> Result<Command, CommandError> {
    let invalid = || CommandError::new("err.operationNotAllowed");
    let ini =
        crate::project_workspace::child(&crate::project_workspace::child(directory, ".osp")?, "project.ini")?;
    let sections =
        crate::project_workspace::parse(&crate::project_workspace::read(&ini)?.unwrap_or_default())?;
    let project_root = sections
        .get(domain)
        .and_then(|fields| fields.get("project_root"))
        .map(String::as_str)
        .unwrap_or("{base_dir}");
    let expand = |text: &str| -> Result<String, CommandError> {
        let text = text
            .replace("{project_root}", project_root)
            .replace("{base_dir}", &external_path(directory).to_string_lossy())
            .replace("{project_dir}", &external_path(directory).to_string_lossy())
            .replace("{root_dir}", &external_path(root).to_string_lossy())
            .replace("{host}", domain);
        if ["{base_dir}", "{project_dir}", "{project_root}", "{root_dir}", "{host}"]
            .iter()
            .any(|token| text.contains(token))
        {
            return Err(invalid());
        }
        Ok(text)
    };
    let raw = &item.fields["command"];
    let mut command = if needs_shell(raw) {
        let mut command = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd".into()));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.raw_arg(format!("/S /C \"{}\"", expand(raw)?));
        }
        #[cfg(not(windows))]
        command.arg("/C").arg(expand(raw)?);
        command
    } else {
        let args = arguments(raw).ok_or_else(invalid)?;
        let exe = expand(args.first().ok_or_else(invalid)?)?;
        let mut command = Command::new(exe);
        for arg in &args[1..] {
            command.arg(expand(arg)?);
        }
        command
    };
    let work = item.fields.get("work_directory").filter(|s| !s.trim().is_empty());
    command.current_dir(
        work.map(|s| expand(s.trim().trim_matches('"')))
            .transpose()?
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| external_path(directory)),
    );
    #[cfg(windows)]
    if item.fields.get("hide").is_some_and(|v| v == "on") {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

#[tauri::command]
pub fn open_project_editor(
    domain: String,
    base_dir: String,
    editor_id: String,
    custom_path: Option<String>,
) -> Result<(), CommandError> {
    let domain = normalize_project_domain(&domain)?;
    let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
    let directory = base(&root, &domain, &base_dir)?;
    // Re-read persisted definitions at click time; an ID cannot supply arbitrary command text.
    let (_, item) = items(&domain, &base_dir, custom_path)?
        .into_iter()
        .find(|(id, _)| id == &editor_id)
        .ok_or_else(|| CommandError::new("err.operationNotAllowed"))?;
    launch(&root, &directory, &domain, &item)?.spawn().map_err(spawn_failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(command: &str) -> MenuItem {
        MenuItem {
            id: "custom".into(),
            fields: [("caption", "Open with SomeProgram"), ("category", "projects"), ("command", command)]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        }
    }
    #[test]
    fn direct_programs_keep_quoted_paths_and_shell_characters_as_arguments() {
        let item = item(r#""C:\Programs\Some Program.exe" --folder "{base_dir}""#);
        assert!(eligible(&item, "shop.test"));
        let command =
            launch(Path::new("C:/OSPanel"), Path::new("C:/OSPanel/home/a & b"), "shop.test", &item).unwrap();
        assert_eq!(command.get_program(), r"C:\Programs\Some Program.exe");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["--folder", "C:/OSPanel/home/a & b"]);
    }
    #[test]
    fn saved_menus_are_scoped_and_launches_revalidate_ids() {
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(format!(
            "osp-editors-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let fixture = Fixture(root);
        let root = &fixture.0;
        let directory = root.join("home/shared");
        fs::create_dir_all(directory.join(".osp")).unwrap();
        fs::create_dir_all(root.join("system")).unwrap();
        fs::write(
            directory.join(".osp/project.ini"),
            "[shop.test]\nproject_root = {base_dir}/application\n[api.shop.test]\n",
        )
        .unwrap();
        fs::write(
            root.join("system/menu.dat"),
            "[custom]\ncaption = Open with SomeProgram\ncategory = projects\ncommand = app.exe {base_dir}\n",
        )
        .unwrap();
        let menu_path = directory.join(".osp/menu.ini");
        fs::write(&menu_path, "[local]\ncaption = Open with SomeProgram\ncategory = projects\\shop.test\ncommand = app.exe {project_root}\nwork_directory = \"{base_dir}\"\n").unwrap();
        let base_dir = directory.to_string_lossy().into_owned();
        let custom = Some(root.to_string_lossy().into_owned());
        let listed = list_project_editors("shop.test".into(), base_dir.clone(), custom.clone()).unwrap();
        assert_eq!(
            listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["global:custom", "project:local"]
        );
        assert_eq!(
            list_project_editors("api.shop.test".into(), base_dir.clone(), custom.clone()).unwrap().len(),
            1
        );
        let saved = items("shop.test", &base_dir, custom.clone()).unwrap();
        let command = launch(root, &directory, "shop.test", &saved[1].1).unwrap();
        assert_eq!(
            command.get_args().next().unwrap().to_string_lossy(),
            format!("{}/application", directory.to_string_lossy())
        );
        assert_eq!(command.get_current_dir().unwrap(), directory.as_path());
        fs::write(&menu_path, "[local]\ncaption = Open with SomeProgram\ncategory = projects\ncommand = app.exe {base_dir}\nenabled = off\n").unwrap();
        assert!(
            open_project_editor("shop.test".into(), base_dir.clone(), "project:local".into(), custom.clone())
                .is_err()
        );
        fs::write(&menu_path, "[broken\n").unwrap();
        let listed = list_project_editors("shop.test".into(), base_dir.clone(), custom.clone()).unwrap();
        assert_eq!(listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["global:custom"]);
        fs::write(&menu_path, "").unwrap();
        assert!(open_project_editor("shop.test".into(), base_dir, "project:local".into(), custom).is_err());
    }

    #[test]
    fn preserves_escaped_quotes_and_trailing_backslashes() {
        assert_eq!(
            arguments(r#"app.exe "say \"hello\"" "C:\folder\\""#).unwrap(),
            ["app.exe", "say \"hello\"", "C:\\folder\\"]
        );
    }

    #[test]
    fn finds_programs_inside_shell_wrappers_and_derives_names_from_paths() {
        let command =
            r#"%COMSPEC% /c "{root_dir}\apps\Sublime\subl.exe --launch-or-new-window {project_root}""#;
        assert!(eligible(&item(command), "shop.test"));
        let path = executable_path(command).unwrap();
        assert_eq!(path, r"{root_dir}\apps\Sublime\subl.exe");
        assert_eq!(program_name(&path), "Sublime");
        assert_eq!(executable_stem(&path), "subl");
        assert_eq!(display_name("Открыть в Sublime Text", &path), "Sublime Text");
        assert_eq!(
            display_name("Открыть в VS Code", r"C:\Program Files\Microsoft VS Code\Code.exe"),
            "Microsoft VS Code"
        );
        assert_eq!(display_name("Открыть в Zed", r"C:\Tools\Zed\zed.exe"), "Zed");

        let command = r#"start "" "C:\Tools\Editor\bin\editor.exe" "{base_dir}""#;
        assert!(eligible(&item(command), "shop.test"));
        assert_eq!(program_name(&executable_path(command).unwrap()), "editor");

        let command = r#"cmd.exe /c "C:\Program Files\Some Program\Some Program.exe" "{base_dir}""#;
        assert!(eligible(&item(command), "shop.test"));
        assert_eq!(program_name(&executable_path(command).unwrap()), "Some Program");

        let command = r#"powershell.exe -Command "& 'C:\Tools\Editor\editor.exe' '{base_dir}'""#;
        assert!(eligible(&item(command), "shop.test"));
        assert_eq!(program_name(&executable_path(command).unwrap()), "Editor");
    }

    #[test]
    fn shell_commands_are_launched_through_comspec() {
        let item =
            item(r#"%COMSPEC% /c "{root_dir}\apps\Sublime\subl.exe --launch-or-new-window {project_root}""#);
        let command =
            launch(Path::new("C:/OSPanel"), Path::new("C:/OSPanel/home/shop"), "shop.test", &item).unwrap();
        let program = command.get_program().to_string_lossy().to_ascii_lowercase();
        assert!(program.ends_with("cmd") || program.ends_with("cmd.exe"));
    }

    #[test]
    #[cfg(windows)]
    fn shell_commands_expand_placeholders_and_run() {
        let root = std::env::temp_dir().join(format!("osp-editors-shell-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let item = item(r#"%COMSPEC% /c "echo {base_dir}""#);
        let output = launch(&root, &root, "shop.test", &item).unwrap().output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains(&root.to_string_lossy().to_string()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn excludes_internal_actions_shells_disabled_items_and_other_domains() {
        for command in
            ["command_open_browser", "powershell.exe {base_dir}", "app.exe", "app.exe \"{base_dir}"]
        {
            assert!(!eligible(&item(command), "shop.test"));
        }
        assert!(eligible(&item("cmd.exe /c app.exe {base_dir}"), "shop.test"));
        for (key, value) in [
            ("enabled", "off"),
            ("category", "projects\\other.test"),
            ("category", "modules"),
            ("category", "addons\\tools"),
            ("need_state", "on"),
        ] {
            let mut item = item("app.exe {base_dir}");
            item.fields.insert(key.into(), value.into());
            assert!(!eligible(&item, "shop.test"));
        }
        assert!(
            launch(
                Path::new("C:/OSPanel"),
                Path::new("C:/OSPanel/home/shop"),
                "shop.test",
                &item("app.exe {base_dir} {unknown}")
            )
            .is_ok()
        );
    }
}
