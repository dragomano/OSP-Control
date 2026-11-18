//! One-off runs from the project task editor.

use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
    thread,
};

use serde::Serialize;

use crate::{
    error::{CommandError, spawn_failed},
    panel_api::{dat_field, dat_string_value, parse_osp_json},
    paths::{external_path, hidden_command, normalize_project_domain, resolve_installation},
    project_workspace::{base, child, read, sections_at},
};

const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTaskResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}

fn invalid() -> CommandError {
    CommandError::new("err.projectWorkspaceInvalid")
}

fn expand(text: &str, variables: &BTreeMap<&str, String>, depth: u8) -> Result<String, CommandError> {
    if depth > 8 {
        return Err(invalid());
    }
    let mut result = String::new();
    for part in text.split_inclusive('}') {
        if let Some((prefix, key)) = part.strip_suffix('}').and_then(|part| part.rsplit_once('{'))
            && let Some(value) = variables.get(key)
        {
            result.push_str(prefix);
            result.push_str(&expand(value, variables, depth + 1)?);
        } else {
            result.push_str(part);
        }
        if result.len() > 32768 {
            return Err(invalid());
        }
    }
    Ok(result)
}

fn expand_command(command: &str, root: &Path, dir: &Path, domain: &str) -> Result<String, CommandError> {
    if !command.contains('{') {
        return Ok(command.to_string());
    }
    let sections = sections_at(dir)?;
    let local = sections.get(domain);
    let program = child(&child(root, "system")?, "program.dat")?;
    let global = read(&program)?.and_then(|source| parse_osp_json(&source));
    let defaults = global.as_ref().and_then(|node| dat_field(node, "projects"));
    let setting = |key, fallback: &str| {
        local
            .and_then(|local| local.get(key))
            .filter(|value| !value.is_empty() && value.as_str() != "auto")
            .cloned()
            .or_else(|| {
                let value = dat_string_value(dat_field(defaults?, key)?);
                (!value.is_empty() && value != "auto").then_some(value)
            })
            .unwrap_or_else(|| fallback.to_string())
    };
    let root_dir = external_path(root).to_string_lossy().into_owned();
    let drive = root_dir.get(..2).filter(|text| text.ends_with(':')).unwrap_or("");
    let tls = matches!(setting("tls_enabled", "on").as_str(), "on" | "1");
    let http_port = setting("http_port", "80");
    let https_port = setting("https_port", "443");
    let (port, default_port) = if tls { (&https_port, "443") } else { (&http_port, "80") };
    let scheme_port = if port == default_port { String::new() } else { format!(":{port}") };
    expand(
        command,
        &BTreeMap::from([
            ("app_start_command", setting("app_start_command", "")),
            ("backend_ip", setting("backend_ip", "")),
            ("backend_port", setting("backend_port", "3000")),
            ("base_dir", external_path(dir).to_string_lossy().into_owned()),
            ("base_url", setting("base_url", "{host_scheme}://{host}{scheme_port}")),
            ("date_time", "%DATE% %TIME%".into()),
            ("host", domain.into()),
            ("host_decoded", idna::domain_to_unicode(domain).0),
            ("host_scheme", if tls { "https".into() } else { "http".into() }),
            ("http_engine", setting("http_engine", "")),
            ("http_port", http_port),
            ("https_port", https_port),
            ("node_engine", setting("node_engine", "")),
            ("php_engine", setting("php_engine", "")),
            ("project_root", setting("project_root", "{base_dir}")),
            ("root_drive", drive.into()),
            ("root_path", root_dir.strip_prefix(drive).unwrap_or(&root_dir).into()),
            ("root_dir", root_dir),
            ("scheme_port", scheme_port),
            ("terminal_codepage", setting("terminal_codepage", "65001")),
            ("web_root", setting("web_root", "{project_root}")),
        ]),
        0,
    )
}

fn task_command(root: &Path, dir: &Path, command: &str) -> Result<Command, CommandError> {
    if command.trim().is_empty() || command.chars().any(|ch| ch.is_control() && ch != '\t') {
        return Err(invalid());
    }
    let bin = external_path(&child(root, "bin")?);
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&path)))
        .map_err(|_| invalid())?;
    let mut shell = hidden_command("cmd.exe");
    shell.args(["/D", "/E:ON", "/V:OFF", "/S", "/C"]).current_dir(external_path(dir)).env("PATH", path);
    // /S removes just the outer quotes, preserving the task's own quoting and shell operators.
    let script = format!("\"{command}\"");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        shell.raw_arg(script);
    }
    #[cfg(not(windows))]
    shell.arg(script);
    Ok(shell)
}

fn decode_output(bytes: &[u8], truncated: bool) -> String {
    if let Some(utf16) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let words =
            utf16.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        return String::from_utf16_lossy(&words);
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => return text.to_string(),
        Err(error) if truncated && error.error_len().is_none() => {
            return String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned();
        }
        Err(_) => {}
    }
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{GetOEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS, MultiByteToWideChar};
        let page = unsafe { GetOEMCP() };
        let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
        let size = unsafe { MultiByteToWideChar(page, flags, bytes, None) };
        if size > 0 {
            let mut words = vec![0; size as usize];
            if unsafe { MultiByteToWideChar(page, flags, bytes, Some(&mut words)) } == size {
                return String::from_utf16_lossy(&words);
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn read_output(mut stream: impl Read) -> io::Result<(String, bool)> {
    let mut bytes = Vec::new();
    stream.by_ref().take(MAX_OUTPUT_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    if truncated {
        bytes.truncate(MAX_OUTPUT_BYTES);
        // Drain the pipe so the command can continue writing and finish normally.
        io::copy(&mut stream, &mut io::sink())?;
    }
    Ok((decode_output(&bytes, truncated), truncated))
}

fn capture(command: &mut Command) -> Result<ProjectTaskResult, CommandError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_failed)?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let (stdout, stderr) = thread::scope(|scope| {
        let stdout = scope.spawn(|| read_output(stdout));
        let stderr = read_output(stderr);
        (stdout.join(), stderr)
    });
    let status = child.wait()?;
    let (stdout, stdout_truncated) = stdout.map_err(|_| CommandError::new("err.taskRunFailed"))??;
    let (stderr, stderr_truncated) = stderr?;
    Ok(ProjectTaskResult {
        exit_code: status.code(),
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
    })
}

#[tauri::command]
pub async fn run_project_task(
    domain: String,
    base_dir: String,
    command: String,
    custom_path: Option<String>,
) -> Result<ProjectTaskResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let domain = normalize_project_domain(&domain)?;
        let root = fs::canonicalize(resolve_installation(custom_path.as_deref())?)?;
        let dir = base(&root, &domain, &base_dir)?;
        let command = expand_command(&command, &root, &dir, &domain)?;
        capture(&mut task_command(&root, &dir, &command)?)
    })
    .await
    .map_err(|_| CommandError::new("err.taskRunFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_multiline_commands_before_launch() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for command in ["", " \t ", "echo one\r\necho two", "echo one\0echo two"] {
            assert_eq!(task_command(root, root, command).unwrap_err().code, "err.projectWorkspaceInvalid");
        }
    }

    #[test]
    fn expands_nested_variables_without_touching_shell_syntax() {
        let variables = BTreeMap::from([
            ("base_dir", r"C:\Dev Folder\example.test".into()),
            ("web_root", r"{base_dir}\public".into()),
        ]);
        assert_eq!(
            expand(r#"echo {json} & cd "{web_root}" & echo %PATH%"#, &variables, 0).unwrap(),
            r#"echo {json} & cd "C:\Dev Folder\example.test\public" & echo %PATH%"#
        );
    }

    #[test]
    fn keeps_bounded_output_and_drains_the_pipe() {
        let mut stream = io::repeat(b'x').take(MAX_OUTPUT_BYTES as u64 + 100);
        let (text, truncated) = read_output(&mut stream).unwrap();
        assert_eq!(text.len(), MAX_OUTPUT_BYTES);
        assert!(truncated);
        assert_eq!(stream.limit(), 0);
    }

    #[test]
    fn decodes_unicode_output() {
        assert_eq!(decode_output("команда".as_bytes(), false), "команда");
        assert_eq!(decode_output(&[0xff, 0xfe, 0x16, 0x04], false), "Ж");
        assert_eq!(decode_output(b"done \xd0", true), "done ");
    }

    #[cfg(windows)]
    #[test]
    fn captures_both_streams_and_the_exit_code_from_a_native_task() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let command = r#"cmd.exe /D /S /C "if exist Cargo.toml echo Project directory & echo x=y" & echo Task error 1>&2 & exit /b 7"#;
        let result = capture(&mut task_command(root, root, command).unwrap()).unwrap();
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(
            result.stdout.lines().map(str::trim_end).collect::<Vec<_>>(),
            ["Project directory", "x=y"]
        );
        assert_eq!(result.stderr.trim(), "Task error");
        assert!(!result.truncated);
    }
}
