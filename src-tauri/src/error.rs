//! Errors sent to the frontend: a code + params structure, translated via t() on the TS side.

use std::collections::BTreeMap;

use serde::Serialize;

// Command errors travel to the frontend as a {code, params} structure and are translated there via t();
// the texts live in locales under the err.* keys — no human-readable strings in Rust.
#[derive(Debug, Serialize)]
pub(crate) struct CommandError {
    pub(crate) code: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) params: BTreeMap<String, String>,
}

impl CommandError {
    pub(crate) fn new(code: &str) -> Self {
        Self { code: code.into(), params: BTreeMap::new() }
    }

    pub(crate) fn with(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }
}

// I/O errors default to err.ioFailed, with the OS text in detail.
impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        CommandError::new("err.ioFailed").with("detail", error.to_string())
    }
}

// A child process could not be started — same shape as the From impl above, but with
// its own code: the caller knows it was a spawn, not a file operation.
pub(crate) fn spawn_failed(error: std::io::Error) -> CommandError {
    CommandError::new("err.spawnFailed").with("detail", error.to_string())
}

// A short stderr excerpt for the {detail} parameter of the error translation.
fn stderr_detail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().chars().take(400).collect()
}

// A non-zero exit of a child process: the stderr excerpt, or the exit status itself
// when the process said nothing (e.g. the shell reported a missing binary).
pub(crate) fn command_failed(code: &str, output: &std::process::Output) -> CommandError {
    let mut detail = stderr_detail(&output.stderr);
    if detail.is_empty() {
        detail = output.status.to_string();
    }
    CommandError::new(code).with("detail", detail)
}
