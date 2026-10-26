//! Portable application updates. GitHub is the trust root; no shell or external updater is used.
use crate::{error::CommandError, update_files};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;

const API: &str = "https://api.github.com/repos/dragomano/OSP-Control/releases/latest";
const REPO: &str = "https://github.com/dragomano/OSP-Control/releases/download/";
const MAX_SIZE: u64 = 160_000_000;
static BUSY: AtomicBool = AtomicBool::new(false);

fn invalid() -> CommandError {
    CommandError::new("err.appUpdateCatalog")
}

fn network(e: reqwest::Error) -> CommandError {
    CommandError::new("err.appUpdateNetwork").with("detail", e.to_string())
}

fn client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .user_agent("OSP-Control-Updater")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            let u = a.url();
            if a.previous().len() >= 5
                || u.scheme() != "https"
                || !u.username().is_empty()
                || u.password().is_some()
                || u.port_or_known_default() != Some(443)
                || !matches!(
                    u.host_str(),
                    Some(
                        "api.github.com"
                            | "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                a.error("Untrusted update redirect")
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(network)
}

fn response(r: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, CommandError> {
    if matches!(r.status().as_u16(), 403 | 429) {
        return Err(CommandError::new("err.updateRateLimit"));
    }
    r.error_for_status().map_err(network)
}

// Stable release tags only; prereleases are deliberately never installed automatically.
fn version(s: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = s.strip_prefix('v').unwrap_or(s).split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut out = [0; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

fn arch() -> Result<&'static str, CommandError> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        "x86" => Ok("x86"),
        _ => Err(invalid()),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdate {
    pub version: String,
    pub notes: String,
    pub published_at: String,
    pub size: u64,
    pub url: String,
    pub sha256: String,
}

fn parse_release(body: &[u8], current: &str, arch: &str) -> Result<Option<AppUpdate>, CommandError> {
    let data: serde_json::Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    if data["draft"].as_bool() != Some(false) || data["prerelease"].as_bool() != Some(false) {
        return Err(invalid());
    }
    let tag = data["tag_name"].as_str().ok_or_else(invalid)?;
    let next = version(tag).ok_or_else(invalid)?;
    if next <= version(current).ok_or_else(invalid)? {
        return Ok(None);
    }
    let ver = tag.strip_prefix('v').unwrap_or(tag);
    let name = format!("OSP_Control_{ver}_{arch}.zip");
    let assets = data["assets"].as_array().ok_or_else(invalid)?;
    let matches: Vec<_> = assets.iter().filter(|a| a["name"].as_str() == Some(&name)).collect();
    if matches.len() != 1 {
        return Err(invalid());
    }
    let a = matches[0];
    let url = a["browser_download_url"].as_str().ok_or_else(invalid)?;
    if url != format!("{REPO}{tag}/{name}") {
        return Err(invalid());
    }
    let sha = a["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| CommandError::new("err.updateChecksumMissing"))?;
    let size = a["size"].as_u64().filter(|n| *n > 0 && *n <= MAX_SIZE).ok_or_else(invalid)?;
    Ok(Some(AppUpdate {
        version: ver.into(),
        notes: data["body"].as_str().unwrap_or("").into(),
        published_at: data["published_at"].as_str().unwrap_or("").into(),
        size,
        url: url.into(),
        sha256: sha.to_ascii_lowercase(),
    }))
}

fn check(current: &str) -> Result<Option<AppUpdate>, CommandError> {
    let r = response(
        client()?
            .get(API)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(network)?,
    )?;
    let mut body = Vec::new();
    r.take(3_000_001).read_to_end(&mut body)?;
    if body.len() > 3_000_000 {
        return Err(invalid());
    }
    parse_release(&body, current, arch()?)
}

#[tauri::command]
pub(crate) async fn check_app_update(app: tauri::AppHandle) -> Result<Option<AppUpdate>, CommandError> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || check(&current)).await.map_err(|_| invalid())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    phase: &'static str,
    received: u64,
    total: u64,
}

fn progress(ch: &Channel<Progress>, phase: &'static str, received: u64, total: u64) {
    let _ = ch.send(Progress { phase, received, total });
}

fn download(update: &AppUpdate, path: &Path, ch: &Channel<Progress>) -> Result<(), CommandError> {
    let mut input = response(client()?.get(&update.url).send().map_err(network)?)?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    let mut received = 0;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > update.size {
            return Err(CommandError::new("err.appUpdateArchive"));
        }
        output.write_all(&buf[..n])?;
        hash.update(&buf[..n]);
        progress(ch, "download", received, update.size);
    }
    output.sync_all()?;
    progress(ch, "verify", received, update.size);
    if received != update.size || format!("{:x}", hash.finalize()) != update.sha256 {
        return Err(CommandError::new("err.appUpdateChecksum"));
    }
    Ok(())
}

fn payload(dir: &Path, ver: &str) -> Result<PathBuf, CommandError> {
    let arch = arch()?;
    let nested = dir.join(format!("OSP_Control_{ver}_{arch}"));
    let root = if dir.join("osp-control.exe").is_file() { dir.to_path_buf() } else { nested };
    update_files::safe_tree(&root)?;
    // Replacing the whole directory requires a complete set of shipped dictionaries.
    for lang in ["en", "ru", "uk", "be", "es"] {
        let path = root.join("locales").join(format!("{lang}.json"));
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).map_err(|_| CommandError::new("err.appUpdateArchive"))?)
                .map_err(|_| CommandError::new("err.appUpdateArchive"))?;
        let object = value.as_object().ok_or_else(|| CommandError::new("err.appUpdateArchive"))?;
        if object.get("lang.code").and_then(|v| v.as_str()) != Some(lang)
            || object.get("lang.name").and_then(|v| v.as_str()).is_none_or(|s| s.trim().is_empty())
            || object.values().any(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            return Err(CommandError::new("err.appUpdateArchive"));
        }
    }
    for e in fs::read_dir(&root)? {
        let p = e?.path();
        if p.file_name().is_some_and(|n| n == "osp-control.exe") && p.is_file() {
            continue;
        }
        if p.file_name().is_some_and(|n| n == "locales") && p.is_dir() {
            for locale in fs::read_dir(p)? {
                let locale = locale?.path();
                if !locale.is_file() || locale.extension().is_none_or(|e| e != "json") {
                    return Err(CommandError::new("err.appUpdateArchive"));
                }
                let _: serde_json::Value = serde_json::from_slice(&fs::read(locale)?)
                    .map_err(|_| CommandError::new("err.appUpdateArchive"))?;
            }
            continue;
        }
        return Err(CommandError::new("err.appUpdateArchive"));
    }
    let exe = root.join("osp-control.exe");
    let mut file = fs::File::open(&exe)?;
    let mut header = [0; 64];
    file.read_exact(&mut header)?;
    if &header[..2] != b"MZ" {
        return Err(CommandError::new("err.appUpdateArchive"));
    }
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(u32::from_le_bytes(header[60..64].try_into().unwrap()) as u64))?;
    let mut pe = [0; 6];
    file.read_exact(&mut pe)?;
    let machine = match arch {
        "x64" => 0x8664u16,
        "arm64" => 0xaa64,
        _ => 0x14c,
    };
    if &pe[..4] != b"PE\0\0" || u16::from_le_bytes([pe[4], pe[5]]) != machine {
        return Err(CommandError::new("err.appUpdateArchive"));
    }
    Ok(root)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Handoff {
    pub target: PathBuf,
    pub parent: u32,
    pub payload: PathBuf,
}

fn prepare(app: &tauri::AppHandle, expected: &str, ch: Channel<Progress>) -> Result<(), CommandError> {
    if cfg!(debug_assertions) {
        return Err(CommandError::new("err.appUpdateDev"));
    }
    let _mutation = crate::module_updates::mutation()?;
    let update = check(&app.package_info().version.to_string())?
        .filter(|u| u.version == expected)
        .ok_or_else(|| CommandError::new("err.appUpdateChanged"))?;
    let target = fs::canonicalize(std::env::current_exe()?)?;
    // A fixed staging name is also an inter-process lock. Never erase an interrupted transaction.
    let stage = target.parent().ok_or_else(invalid)?.join(".osp-control-update");
    fs::create_dir(&stage).map_err(|_| CommandError::new("err.appUpdateStaging"))?;
    let result = (|| {
        progress(&ch, "download", 0, update.size);
        download(&update, &stage.join("release.zip"), &ch)?;
        update_files::extract(&stage.join("release.zip"), &stage.join("unpacked"))
            .map_err(|_| CommandError::new("err.appUpdateArchive"))?;
        let root = payload(&stage.join("unpacked"), &update.version)?;
        fs::copy(&target, stage.join("helper.exe"))?;
        let handoff = Handoff { target: target.clone(), parent: std::process::id(), payload: root };
        fs::write(stage.join("handoff.json"), serde_json::to_vec(&handoff).map_err(|_| invalid())?)?;
        let mut helper = Command::new(stage.join("helper.exe")).arg("--app-update-helper").spawn()?;
        let deadline = Instant::now() + Duration::from_secs(15);
        while !stage.join("ready").exists() {
            if helper.try_wait()?.is_some() || Instant::now() >= deadline {
                let _ = helper.kill();
                let _ = helper.wait();
                return Err(CommandError::new("err.appUpdateHandoff"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        progress(&ch, "restart", update.size, update.size);
        // AppHandle::exit bypasses close-to-tray; only exit after the helper holds the parent handle.
        app.exit(0);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[tauri::command]
pub(crate) async fn install_app_update(
    app: tauri::AppHandle,
    expected: String,
    on_progress: Channel<Progress>,
) -> Result<(), CommandError> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(CommandError::new("err.appUpdateBusy"));
    }
    let result = tauri::async_runtime::spawn_blocking(move || prepare(&app, &expected, on_progress))
        .await
        .map_err(|_| invalid())
        .and_then(|r| r);
    BUSY.store(false, Ordering::SeqCst);
    result
}

pub(crate) fn early_mode() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--app-update-helper") {
        return false;
    }
    if let Err(error) = crate::app_update_handoff::run() {
        eprintln!("{}", error.code);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(ver: &str) -> serde_json::Value {
        serde_json::json!({"tag_name":format!("v{ver}"),"draft":false,"prerelease":false,"assets":[{
            "name":format!("OSP_Control_{ver}_x64.zip"),"size":42,"digest":format!("sha256:{}", "a".repeat(64)),
            "browser_download_url":format!("{REPO}v{ver}/OSP_Control_{ver}_x64.zip")}]})
    }

    #[test]
    fn payload_rejects_non_pe_and_unexpected_files() {
        let root = std::env::temp_dir().join(format!("osp-app-payload-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("osp-control.exe"), vec![0u8; 64]).unwrap();
        assert!(payload(&root, "0.3.0").is_err());
        let mut pe = vec![0u8; 70];
        pe[..2].copy_from_slice(b"MZ");
        pe[60..64].copy_from_slice(&64u32.to_le_bytes());
        pe[64..68].copy_from_slice(b"PE\0\0");
        let machine: u16 = match arch().unwrap() {
            "x64" => 0x8664,
            "arm64" => 0xaa64,
            _ => 0x14c,
        };
        pe[68..70].copy_from_slice(&machine.to_le_bytes());
        fs::write(root.join("osp-control.exe"), &pe).unwrap();
        assert!(payload(&root, "0.3.0").is_err());
        fs::create_dir(root.join("locales")).unwrap();
        for lang in ["en", "ru", "uk", "be", "es"] {
            fs::write(
                root.join("locales").join(format!("{lang}.json")),
                serde_json::to_vec(&serde_json::json!({"lang.code":lang,"lang.name":lang})).unwrap(),
            )
            .unwrap();
        }
        assert!(payload(&root, "0.3.0").is_ok());
        fs::write(root.join("osp-control.exe"), vec![0u8; 70]).unwrap();
        assert!(payload(&root, "0.3.0").is_err());
        fs::write(root.join("osp-control.exe"), &pe).unwrap();
        fs::write(root.join("locales/ru.json"), b"null").unwrap();
        assert!(payload(&root, "0.3.0").is_err());
        fs::write(root.join("locales/ru.json"), br#"{"lang.code":"ru","lang.name":"Russian"}"#).unwrap();
        fs::write(root.join("unexpected.dll"), b"no").unwrap();
        assert!(payload(&root, "0.3.0").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stable_versions_are_numeric_and_strict() {
        assert!(version("0.10.0") > version("0.9.0"));
        for bad in ["1.2", "1.2.3-beta", "01.2.3", "1.2.3/evil", "1.2.3.4"] {
            assert!(version(bad).is_none());
        }
    }

    #[test]
    fn catalog_binds_asset_to_repository_version_arch_and_digest() {
        let good = release("0.10.0");
        let parse = |v: &serde_json::Value| parse_release(&serde_json::to_vec(v).unwrap(), "0.2.0", "x64");
        assert_eq!(parse(&good).unwrap().unwrap().version, "0.10.0");
        for (key, value) in [
            ("browser_download_url", serde_json::json!("https://evil.test/update.zip")),
            ("digest", serde_json::Value::Null),
            ("size", serde_json::json!(MAX_SIZE + 1)),
        ] {
            let mut bad = good.clone();
            bad["assets"][0][key] = value;
            assert!(parse(&bad).is_err());
        }
        let mut duplicate = good.clone();
        duplicate["assets"].as_array_mut().unwrap().push(good["assets"][0].clone());
        assert!(parse(&duplicate).is_err());
        assert!(parse_release(&serde_json::to_vec(&good).unwrap(), "0.10.0", "x64").unwrap().is_none());
        assert!(parse_release(&serde_json::to_vec(&good).unwrap(), "0.11.0", "x64").unwrap().is_none());
        assert!(parse_release(&serde_json::to_vec(&good).unwrap(), "0.2.0", "arm64").is_err());
    }
}
