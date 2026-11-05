//! The system hosts file only: no caller-provided paths, shells or panel restarts.

use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: usize = 1024 * 1024;
static SAVE_LOCK: Mutex<()> = Mutex::new(());
const START: &str = "# OPEN SERVER PANEL: START OF THE LIST";
const END: &str = "# OPEN SERVER PANEL: END OF THE LIST";

#[path = "hosts_elevation.rs"]
mod elevation;
pub(crate) use elevation::early_mode;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsDocument {
    path: String,
    content: String,
    revision: String,
    encoding: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsSaveResult {
    document: HostsDocument,
    backup_path: Option<String>,
    dns_flushed: bool,
}

#[derive(Clone, Copy, Debug)]
enum Encoding {
    Utf8(bool),
    Utf16(bool),
    #[cfg(windows)]
    Ansi(u32),
}

fn invalid() -> CommandError {
    CommandError::new("err.hostsEncoding")
}
fn io_error(error: std::io::Error) -> CommandError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        CommandError::new("err.hostsPermission")
    } else {
        error.into()
    }
}

#[cfg(windows)]
fn system_directory() -> Result<PathBuf, CommandError> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0u16; 32768];
    let count =
        unsafe { windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if count == 0 || count >= buffer.len() {
        return Err(CommandError::new("err.hostsPath"));
    }
    fs::canonicalize(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..count]))).map_err(io_error)
}

#[cfg(not(windows))]
fn system_directory() -> Result<PathBuf, CommandError> {
    Err(CommandError::new("err.hostsPlatform"))
}

fn checked_path(root: &Path) -> Result<PathBuf, CommandError> {
    let root = fs::canonicalize(root).map_err(io_error)?;
    let mut path = root.clone();
    for part in ["drivers", "etc", "hosts"] {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = metadata.file_type().is_symlink();
        if linked {
            return Err(CommandError::new("err.hostsPath"));
        }
    }
    let canonical = fs::canonicalize(&path).map_err(io_error)?;
    if !canonical.starts_with(&root) || !canonical.is_file() || canonical != path {
        return Err(CommandError::new("err.hostsPath"));
    }
    Ok(canonical)
}

fn bytes(path: &Path) -> Result<Vec<u8>, CommandError> {
    let mut content = Vec::new();
    fs::File::open(path)
        .map_err(io_error)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut content)
        .map_err(io_error)?;
    if content.len() > MAX_BYTES {
        return Err(CommandError::new("err.hostsTooLarge"));
    }
    Ok(content)
}

fn decode(bytes: &[u8]) -> Result<(String, Encoding), CommandError> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err(invalid());
        }
        let little = bytes[0] == 0xff;
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        return Ok((String::from_utf16(&words).map_err(|_| invalid())?, Encoding::Utf16(little)));
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    if let Ok(text) = std::str::from_utf8(if bom { &bytes[3..] } else { bytes }) {
        return Ok((text.into(), Encoding::Utf8(bom)));
    }
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{GetACP, MB_ERR_INVALID_CHARS, MultiByteToWideChar};
        let page = unsafe { GetACP() };
        let size = unsafe { MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, bytes, None) };
        if size <= 0 {
            return Err(invalid());
        }
        let mut words = vec![0u16; size as usize];
        if unsafe { MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, bytes, Some(&mut words)) } != size {
            return Err(invalid());
        }
        let text = String::from_utf16(&words).map_err(|_| invalid())?;
        if encode(&text, Encoding::Ansi(page))? != bytes {
            return Err(invalid());
        }
        Ok((text, Encoding::Ansi(page)))
    }
    #[cfg(not(windows))]
    Err(invalid())
}

fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, CommandError> {
    match encoding {
        Encoding::Utf8(bom) => {
            let mut output = if bom { vec![0xef, 0xbb, 0xbf] } else { Vec::new() };
            output.extend_from_slice(text.as_bytes());
            Ok(output)
        }
        Encoding::Utf16(little) => {
            let mut output = if little { vec![0xff, 0xfe] } else { vec![0xfe, 0xff] };
            for word in text.encode_utf16() {
                output.extend(if little { word.to_le_bytes() } else { word.to_be_bytes() });
            }
            Ok(output)
        }
        #[cfg(windows)]
        Encoding::Ansi(page) => {
            use windows::{
                Win32::Globalization::{WC_NO_BEST_FIT_CHARS, WideCharToMultiByte},
                core::{BOOL, PCSTR},
            };
            if text.is_empty() {
                return Ok(Vec::new());
            }
            let words: Vec<u16> = text.encode_utf16().collect();
            let mut substituted = BOOL(0);
            let size = unsafe {
                WideCharToMultiByte(
                    page,
                    WC_NO_BEST_FIT_CHARS,
                    &words,
                    None,
                    PCSTR::null(),
                    Some(&mut substituted),
                )
            };
            if size <= 0 || substituted.as_bool() {
                return Err(invalid());
            }
            let mut output = vec![0u8; size as usize];
            let count = unsafe {
                WideCharToMultiByte(
                    page,
                    WC_NO_BEST_FIT_CHARS,
                    &words,
                    Some(&mut output),
                    PCSTR::null(),
                    Some(&mut substituted),
                )
            };
            if count != size || substituted.as_bool() {
                return Err(invalid());
            }
            Ok(output)
        }
    }
}

fn revision(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}
fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
fn document(path: &Path, content: &[u8]) -> Result<HostsDocument, CommandError> {
    let (text, encoding) = decode(content)?;
    let label = match encoding {
        Encoding::Utf8(false) => "UTF-8".into(),
        Encoding::Utf8(true) => "UTF-8 BOM".into(),
        Encoding::Utf16(true) => "UTF-16 LE".into(),
        Encoding::Utf16(false) => "UTF-16 BE".into(),
        #[cfg(windows)]
        Encoding::Ansi(page) => format!("Windows-{page}"),
    };
    Ok(HostsDocument {
        path: crate::paths::external_path(path).to_string_lossy().into_owned(),
        content: normalize(&text),
        revision: revision(content),
        encoding: label,
    })
}

fn valid_name(host: &str) -> bool {
    host.len() <= 253
        && host.strip_suffix('.').unwrap_or(host).split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label.starts_with(|c: char| c.is_ascii_alphanumeric())
                && label.ends_with(|c: char| c.is_ascii_alphanumeric())
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

fn validate(text: &str) -> Result<(), CommandError> {
    if text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(CommandError::new("err.hostsControl"));
    }
    let mut managed = false;
    let mut names: HashMap<(bool, String), IpAddr> = HashMap::new();
    for (line, raw) in text.lines().enumerate() {
        let fail = |code: &str| CommandError::new(code).with("line", (line + 1).to_string());
        let mut value = raw.trim();
        if value.eq_ignore_ascii_case(START) || value.eq_ignore_ascii_case(END) {
            let start = value.eq_ignore_ascii_case(START);
            if start == managed {
                return Err(fail("err.hostsMarkers"));
            }
            managed = start;
            continue;
        }
        if value.is_empty() {
            continue;
        }
        let active = !value.starts_with('#');
        if !active {
            value = value[1..].trim();
            if value.split_whitespace().next().and_then(|ip| ip.parse::<IpAddr>().ok()).is_none() {
                continue;
            }
        }
        let mut parts = value.split('#').next().unwrap_or_default().split_whitespace();
        let ip = parts.next().and_then(|ip| ip.parse::<IpAddr>().ok()).ok_or_else(|| fail("err.hostsIp"))?;
        let hosts: Vec<_> = parts.collect();
        if hosts.is_empty() || hosts.iter().any(|host| !valid_name(host)) {
            return Err(fail("err.hostsName"));
        }
        if !active {
            continue;
        }
        let mut row_names = HashSet::new();
        for host in hosts {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            if !row_names.insert(name.clone()) {
                return Err(fail("err.hostsRepeatedName").with("host", host));
            }
            if active {
                if let Some(previous) = names.insert((ip.is_ipv6(), name), ip) {
                    if previous != ip {
                        return Err(fail("err.hostsNameConflict")
                            .with("host", host)
                            .with("ip", previous.to_string()));
                    }
                }
            }
        }
    }
    if managed {
        return Err(CommandError::new("err.hostsMarkers").with("line", text.lines().count().to_string()));
    }
    Ok(())
}

#[cfg(windows)]
fn replace(path: &Path, temporary: &Path) -> Result<(), CommandError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{REPLACE_FILE_FLAGS, ReplaceFileW},
        core::PCWSTR,
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    // ReplaceFile preserves the destination's ACL instead of installing a new file's permissions.
    unsafe {
        ReplaceFileW(
            PCWSTR(path.as_ptr()),
            PCWSTR(temporary.as_ptr()),
            PCWSTR::null(),
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|error| io_error(std::io::Error::from_raw_os_error((error.code().0 & 0xffff) as i32)))
}
#[cfg(not(windows))]
fn replace(path: &Path, temporary: &Path) -> Result<(), CommandError> {
    fs::rename(temporary, path).map_err(io_error)
}

fn save_at(root: &Path, content: &str, expected_revision: &str) -> Result<HostsSaveResult, CommandError> {
    let _guard = SAVE_LOCK.lock().map_err(|_| CommandError::new("err.hostsBusy"))?;
    if content.len() > MAX_BYTES {
        return Err(CommandError::new("err.hostsTooLarge"));
    }
    validate(content)?;
    let path = checked_path(root)?;
    let original = bytes(&path)?;
    if revision(&original) != expected_revision {
        return Err(CommandError::new("err.hostsConflict"));
    }
    let (old_text, encoding) = decode(&original)?;
    if normalize(&old_text) == normalize(content) {
        return Ok(HostsSaveResult {
            document: document(&path, &original)?,
            backup_path: None,
            dns_flushed: false,
        });
    }
    let normalized = normalize(content);
    let next_text = if old_text.contains("\r\n") {
        normalized.replace('\n', "\r\n")
    } else if old_text.contains('\r') {
        normalized.replace('\n', "\r")
    } else {
        normalized
    };
    let next = encode(&next_text, encoding)?;
    if next.len() > MAX_BYTES {
        return Err(CommandError::new("err.hostsTooLarge"));
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let parent = path.parent().ok_or_else(|| CommandError::new("err.hostsPath"))?;
    let backup = parent.join(format!("hosts_OSPControlBackup_{nonce}"));
    let temporary = parent.join(format!(".hosts-ospcontrol-{nonce}.tmp"));
    let mut snapshot = OpenOptions::new().create_new(true).write(true).open(&backup).map_err(io_error)?;
    if let Err(error) = snapshot.write_all(&original).and_then(|_| snapshot.sync_all()) {
        drop(snapshot);
        let _ = fs::remove_file(&backup);
        return Err(io_error(error));
    }
    drop(snapshot);
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(io_error)?;
        file.write_all(&next).and_then(|_| file.sync_all()).map_err(io_error)?;
        drop(file);
        if checked_path(root)? != path || bytes(&path)? != original {
            return Err(CommandError::new("err.hostsConflict"));
        }
        replace(&path, &temporary)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(HostsSaveResult {
        document: document(&path, &next)?,
        backup_path: Some(crate::paths::external_path(&backup).to_string_lossy().into_owned()),
        dns_flushed: false,
    })
}

fn flush_dns() -> Result<(), CommandError> {
    let root = system_directory()?;
    let binary = fs::canonicalize(root.join("ipconfig.exe")).map_err(io_error)?;
    if !binary.starts_with(&root) {
        return Err(CommandError::new("err.hostsPath"));
    }
    let output = crate::paths::hidden_command(binary).arg("/flushdns").output().map_err(io_error)?;
    if !output.status.success() {
        return Err(CommandError::new("err.hostsDns"));
    }
    Ok(())
}

#[tauri::command]
pub fn read_hosts() -> Result<HostsDocument, CommandError> {
    let path = checked_path(&system_directory()?)?;
    document(&path, &bytes(&path)?)
}

#[tauri::command]
pub async fn write_hosts(
    content: String,
    expected_revision: String,
) -> Result<HostsSaveResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || elevation::save(content, expected_revision))
        .await
        .map_err(|_| CommandError::new("err.hostsBusy"))?
}

#[tauri::command]
pub async fn flush_hosts_dns() -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(elevation::flush)
        .await
        .map_err(|_| CommandError::new("err.hostsBusy"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(content: &[u8]) -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("osp-hosts-{}-{nonce}", std::process::id()));
            fs::create_dir_all(root.join("drivers/etc")).unwrap();
            fs::write(root.join("drivers/etc/hosts"), content).unwrap();
            Self(root)
        }
        fn file(&self) -> PathBuf {
            self.0.join("drivers/etc/hosts")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn saves_with_exact_backup_bom_and_line_endings() {
        let original = b"\xef\xbb\xbf# Header\r\n127.0.0.1\tapi.test\r\n";
        let fixture = Fixture::new(original);
        let saved = save_at(&fixture.0, "# Header\n127.0.0.2\tapi.test\n", &revision(original)).unwrap();
        assert_eq!(fs::read(saved.backup_path.unwrap()).unwrap(), original);
        assert_eq!(fs::read(fixture.file()).unwrap(), b"\xef\xbb\xbf# Header\r\n127.0.0.2\tapi.test\r\n");
        assert_eq!(saved.document.content, "# Header\n127.0.0.2\tapi.test\n");
    }
    #[test]
    fn external_changes_and_invalid_input_are_never_overwritten() {
        let fixture = Fixture::new(b"127.0.0.1 one.test\n");
        let revision = revision(&fs::read(fixture.file()).unwrap());
        fs::write(fixture.file(), "127.0.0.2 two.test\n").unwrap();
        assert_eq!(
            save_at(&fixture.0, "127.0.0.3 three.test\n", &revision).unwrap_err().code,
            "err.hostsConflict"
        );
        assert_eq!(save_at(&fixture.0, "999.0.0.1 bad.test\n", &revision).unwrap_err().code, "err.hostsIp");
        assert_eq!(fs::read_to_string(fixture.file()).unwrap(), "127.0.0.2 two.test\n");
        assert_eq!(fs::read_dir(fixture.file().parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn unchanged_content_does_not_make_backups_or_change_encoding() {
        let original = encode("# Header\r\n::1 localhost\r\n", Encoding::Utf16(true)).unwrap();
        let fixture = Fixture::new(&original);
        let result = save_at(&fixture.0, "# Header\n::1 localhost\n", &revision(&original)).unwrap();
        assert!(result.backup_path.is_none());
        assert_eq!(fs::read(fixture.file()).unwrap(), original);
    }
    #[test]
    fn encodings_round_trip_without_loss() {
        for encoding in
            [Encoding::Utf8(false), Encoding::Utf8(true), Encoding::Utf16(true), Encoding::Utf16(false)]
        {
            let original = "# Unicode: \u{0414}\u{1f680}\r\n127.0.0.1 localhost\r\n";
            let data = encode(original, encoding).unwrap();
            let (text, detected) = decode(&data).unwrap();
            assert_eq!(text, original);
            assert_eq!(encode(&text, detected).unwrap(), data);
        }
        assert!(decode(&[0xff, 0xfe, 0x01]).is_err());
    }
    #[test]
    fn validation_understands_comments_aliases_ipv6_and_managed_blocks() {
        validate(&format!("# arbitrary comment\n{START}\n127.0.0.1 site.test www.site.test\n{END}\n::1 site.test\n# 127.0.0.2 site.test\n")).unwrap();
        for (text, code) in [
            ("127.0.0.1 a.test\n127.0.0.2 A.test", "err.hostsNameConflict"),
            ("127.0.0.1 -bad.test", "err.hostsName"),
            ("127.0.0.1 a.test a.test", "err.hostsRepeatedName"),
            (START, "err.hostsMarkers"),
            ("# \0", "err.hostsControl"),
        ] {
            assert_eq!(validate(text).unwrap_err().code, code);
        }
    }
}
