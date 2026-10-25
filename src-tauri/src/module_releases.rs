//! Release providers share transport and identity checks, but retain their compatibility rules.
use crate::{
    error::CommandError,
    php_releases::{self as php, Build},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const APACHE: &str = "https://www.apachelounge.com/download/";
const PHP: &str = "https://downloads.php.net/~windows/releases/";
const MAX_DOWNLOAD: u64 = 160_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Php,
    Apache,
    Nginx,
    Caddy,
}
impl Kind {
    pub(crate) fn of(name: &str) -> Result<Self, CommandError> {
        match name {
            "Apache" => Ok(Self::Apache),
            "Nginx" => Ok(Self::Nginx),
            "Caddy" => Ok(Self::Caddy),
            _ if php::branch(name).is_some() => Ok(Self::Php),
            _ => Err(unsupported()),
        }
    }
    pub(crate) fn executable(self) -> &'static str {
        match self {
            Self::Php => "php.exe",
            Self::Apache => "bin/httpd.exe",
            Self::Nginx => "nginx.exe",
            Self::Caddy => "caddy.exe",
        }
    }
}
pub(crate) fn unsupported() -> CommandError {
    CommandError::new("err.updateUnsupported")
}
fn catalog_error() -> CommandError {
    CommandError::new("err.updateCatalog")
}
fn network(error: reqwest::Error) -> CommandError {
    use std::error::Error;
    let mut detail = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    CommandError::new("err.updateNetwork").with("detail", detail)
}
fn allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "www.apachelounge.com"
                    | "apachelounge.com"
                    | "downloads.php.net"
            )
        )
}
fn client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .user_agent(concat!("OSP-Control/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                attempt.error("Untrusted release redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(network)
}
fn status(response: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, CommandError> {
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err(CommandError::new("err.updateRateLimit"));
    }
    response.error_for_status().map_err(network)
}
#[derive(Clone)]
struct Cached {
    body: Vec<u8>,
    etag: Option<String>,
    checked: Instant,
}
static CACHE: OnceLock<Mutex<BTreeMap<String, Cached>>> = OnceLock::new();
fn metadata(url: &str, force: bool) -> Result<Vec<u8>, CommandError> {
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    let old = cache.lock().map_err(|_| catalog_error())?.get(url).cloned();
    if !force
        && let Some(old) = &old
        && old.checked.elapsed() < Duration::from_secs(6 * 3600)
    {
        return Ok(old.body.clone());
    }
    let url = reqwest::Url::parse(url).map_err(|_| catalog_error())?;
    if !allowed_url(&url) {
        return Err(catalog_error());
    }
    let mut request = client()?.get(url.clone()).header("Accept", "application/vnd.github+json");
    if let Some(etag) = old.as_ref().and_then(|v| v.etag.as_ref()) {
        request = request.header("If-None-Match", etag);
    }
    let response = request.timeout(Duration::from_secs(30)).send().map_err(network)?;
    let entry = if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        let mut entry = old.ok_or_else(catalog_error)?;
        entry.checked = Instant::now();
        entry
    } else {
        let response = status(response)?;
        let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let mut body = Vec::new();
        response.take(3_000_001).read_to_end(&mut body)?;
        if body.len() > 3_000_000 {
            return Err(catalog_error());
        }
        Cached { body, etag, checked: Instant::now() }
    };
    let body = entry.body.clone();
    cache.lock().map_err(|_| catalog_error())?.insert(url.to_string(), entry);
    Ok(body)
}

#[derive(Debug, Clone)]
pub(crate) struct Release {
    pub version: String,
    pub display: String,
    pub url: String,
    pub sha256: String,
    pub identity: String,
    pub revision: String,
    pub size: Option<u64>,
}
fn release(
    version: String,
    display: String,
    url: String,
    sha256: String,
    revision: String,
    asset: String,
    size: Option<u64>,
) -> Release {
    let identity = format!("{asset}:{sha256}");
    Release { version, display, url, sha256, identity, revision, size }
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Receipt {
    pub version: String,
    pub revision: String,
    pub identity: String,
}
pub(crate) fn receipt(dir: &Path) -> Result<Option<Receipt>, CommandError> {
    let path = dir.join("ospanel_data/osp-control-update.json");
    if !path.try_exists()? {
        return Ok(None);
    }
    crate::update_files::safe_tree(&path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(16_385).read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 {
        return Err(catalog_error());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| catalog_error())
}
pub(crate) fn save_receipt(dir: &Path, release: &Release) -> Result<(), CommandError> {
    use std::io::Write;
    let data = crate::update_files::child(dir, "ospanel_data")?;
    let path = data.join("osp-control-update.json");
    let temporary = data.join("osp-control-update.tmp");
    let receipt = Receipt {
        version: release.version.clone(),
        revision: release.revision.clone(),
        identity: release.identity.clone(),
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|_| catalog_error())?;
    if temporary.try_exists()? {
        crate::update_files::safe_tree(&temporary)?;
        fs::remove_file(&temporary)?;
    }
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);
    // The full module backup includes this receipt, so rollback also restores build identity.
    if path.try_exists()? {
        crate::update_files::safe_tree(&path)?;
        fs::remove_file(&path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

pub(crate) struct Catalog {
    force: bool,
    php: Option<Result<serde_json::Value, CommandError>>,
}
impl Catalog {
    pub(crate) fn new(force: bool) -> Self {
        Self { force, php: None }
    }
    pub(crate) fn select(
        &mut self,
        name: &str,
        build: &Build,
        dir: &Path,
    ) -> Result<Option<Release>, CommandError> {
        let kind = Kind::of(name)?;
        if kind == Kind::Php {
            let json = self
                .php
                .get_or_insert_with(php::catalog)
                .as_ref()
                .map_err(|e| CommandError { code: e.code.clone(), params: e.params.clone() })?;
            return php::select(json, php::branch(name).ok_or_else(unsupported)?, build).map(|r| {
                r.map(|r| {
                    release(
                        r.version.clone(),
                        r.version,
                        format!("{PHP}{}", r.file),
                        r.sha256,
                        String::new(),
                        r.file,
                        None,
                    )
                })
            });
        }
        let installed = receipt(dir)?;
        let installed = installed.as_ref().filter(|r| r.version == build.version);
        let candidate = if kind == Kind::Apache {
            let html = String::from_utf8(metadata(APACHE, self.force)?).map_err(|_| catalog_error())?;
            let candidates = apache_links(&html)?;
            let candidate = candidates
                .into_iter()
                .max_by_key(|r| (php::version(&r.version), r.revision.clone(), r.compiler));
            match candidate {
                Some(candidate) => {
                    let sums = String::from_utf8(metadata(&format!("{}.txt", candidate.url), self.force)?)
                        .map_err(|_| catalog_error())?;
                    let hash = apache_checksum(&sums, &candidate.file)?;
                    Some(release(
                        candidate.version.clone(),
                        format!("{} ({}, VS{})", candidate.version, candidate.revision, candidate.compiler),
                        candidate.url,
                        hash,
                        candidate.revision,
                        candidate.file,
                        None,
                    ))
                }
                None => return Err(unsupported()),
            }
        } else {
            let repo = if kind == Kind::Nginx { "nginx" } else { "caddy" };
            let mut releases = Vec::new();
            for page in 1..=5 {
                let body = metadata(
                    &format!("https://api.github.com/repos/OSPanel/{repo}/releases?per_page=100&page={page}"),
                    self.force,
                )?;
                let entries: Vec<serde_json::Value> =
                    serde_json::from_slice(&body).map_err(|_| catalog_error())?;
                let count = entries.len();
                releases.extend(entries);
                if count < 100 {
                    break;
                }
            }
            github_release(kind, &releases, build)?
        };
        Ok(candidate.filter(|r| newer(r, build, installed)))
    }
}
fn newer(release: &Release, build: &Build, installed: Option<&Receipt>) -> bool {
    if installed
        .is_some_and(|old| old.identity.rsplit_once(':').is_some_and(|(_, hash)| hash == release.sha256))
    {
        return false;
    }
    match (php::version(&release.version), php::version(&build.version)) {
        (Some(new), Some(old)) if new > old => true,
        (Some(new), Some(old)) if new == old => installed.is_some_and(|old| {
            release.identity != old.identity
                && (release.revision.is_empty() || release.revision >= old.revision)
        }),
        _ => false,
    }
}
fn sha256(value: &str) -> Result<String, CommandError> {
    if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(CommandError::new("err.updateChecksumMissing"));
    }
    Ok(value.to_ascii_lowercase())
}
fn github_release(
    kind: Kind,
    entries: &[serde_json::Value],
    build: &Build,
) -> Result<Option<Release>, CommandError> {
    let old = php::version(&build.version).ok_or_else(unsupported)?;
    let repo = if kind == Kind::Nginx { "nginx" } else { "caddy" };
    let mut ordered: Vec<_> = entries.iter().collect();
    ordered.sort_by_key(|entry| {
        let version = entry["tag_name"]
            .as_str()
            .and_then(|tag| tag.strip_prefix(if kind == Kind::Nginx { "release-" } else { "v" }))
            .and_then(php::version);
        let id = entry["assets"]
            .as_array()
            .and_then(|assets| assets.iter().filter_map(|a| a["id"].as_u64()).max());
        (version, id)
    });
    for entry in ordered.into_iter().rev() {
        if entry["draft"].as_bool() != Some(false) || entry["prerelease"].as_bool() != Some(false) {
            continue;
        }
        let tag = entry["tag_name"].as_str().ok_or_else(catalog_error)?;
        let Some(version) = tag.strip_prefix(if kind == Kind::Nginx { "release-" } else { "v" }) else {
            continue;
        };
        let Some(v) = php::version(version) else {
            continue;
        };
        if (kind == Kind::Nginx && (v.0, v.1) != (old.0, old.1)) || (kind == Kind::Caddy && v.0 != 2) {
            continue;
        }
        let filename = if kind == Kind::Nginx {
            format!("nginx-{version}.zip")
        } else {
            format!("caddy-v{version}-windows-amd64.zip")
        };
        let assets = entry["assets"].as_array().ok_or_else(catalog_error)?;
        let matches: Vec<_> = assets.iter().filter(|a| a["name"].as_str() == Some(&filename)).collect();
        if matches.is_empty() {
            continue;
        }
        if matches.len() != 1 {
            return Err(catalog_error());
        }
        let asset = matches[0];
        let expected = format!("https://github.com/OSPanel/{repo}/releases/download/{tag}/{filename}");
        if asset["browser_download_url"].as_str() != Some(&expected) {
            return Err(catalog_error());
        }
        let hash = sha256(
            asset["digest"]
                .as_str()
                .and_then(|s| s.strip_prefix("sha256:"))
                .ok_or_else(|| CommandError::new("err.updateChecksumMissing"))?,
        )?;
        let size =
            asset["size"].as_u64().filter(|s| *s > 0 && *s <= MAX_DOWNLOAD).ok_or_else(catalog_error)?;
        let id = asset["id"].as_u64().ok_or_else(catalog_error)?;
        return Ok(Some(release(
            version.into(),
            version.into(),
            expected,
            hash,
            String::new(),
            format!("{repo}/{tag}/{id}"),
            Some(size),
        )));
    }
    Ok(None)
}

struct ApacheArchive {
    file: String,
    version: String,
    revision: String,
    compiler: u32,
    url: String,
}
// Only href attributes are relevant. Accept either quote style and resolve against the fixed origin.
fn hrefs(html: &str) -> Vec<String> {
    let mut result = Vec::new();
    for tag in html.split('<').skip(1).filter_map(|s| s.split_once('>').map(|v| v.0)) {
        let bytes = tag.as_bytes();
        if bytes.first().is_none_or(|b| !b.eq_ignore_ascii_case(&b'a'))
            || bytes.get(1).is_none_or(|b| !b.is_ascii_whitespace())
        {
            continue;
        }
        let mut i = 1;
        while i < bytes.len() {
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
                i += 1;
            }
            let key = &tag[start..i];
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if bytes.get(i) != Some(&b'=') {
                if i == start {
                    i += 1;
                }
                continue;
            }
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let quote = bytes.get(i).copied().filter(|b| matches!(b, b'\'' | b'"'));
            if quote.is_some() {
                i += 1;
            }
            let start = i;
            while i < bytes.len()
                && if let Some(quote) = quote { bytes[i] != quote } else { !bytes[i].is_ascii_whitespace() }
            {
                i += 1;
            }
            if key.eq_ignore_ascii_case("href") {
                result.push(tag[start..i].replace("&amp;", "&"));
            }
            if quote.is_some() {
                i += 1;
            }
        }
    }
    result
}
fn apache_links(html: &str) -> Result<Vec<ApacheArchive>, CommandError> {
    let base = reqwest::Url::parse(APACHE).map_err(|_| catalog_error())?;
    let mut out = Vec::new();
    for href in hrefs(html) {
        let Ok(url) = base.join(&href) else {
            continue;
        };
        if !allowed_url(&url)
            || url.host_str() != base.host_str()
            || !url.path().starts_with("/download/")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let file = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("").to_string();
        let lower = file.to_ascii_lowercase();
        let Some(stem) = lower.strip_prefix("httpd-").and_then(|s| s.strip_suffix(".zip")) else {
            continue;
        };
        let parts: Vec<_> = stem.split('-').collect();
        let (version, revision, arch, compiler) = match parts.as_slice() {
            [v, revision, arch, compiler]
                if revision.len() == 6 && revision.bytes().all(|b| b.is_ascii_digit()) =>
            {
                (*v, *revision, *arch, *compiler)
            }
            [v, arch, compiler] => (*v, "", *arch, *compiler),
            _ => continue,
        };
        if php::version(version).is_none_or(|v| (v.0, v.1) != (2, 4)) || arch != "win64" {
            continue;
        }
        let compiler = match compiler {
            "vs17" => 17,
            "vs18" => 18,
            _ => continue,
        };
        out.push(ApacheArchive {
            file,
            version: version.into(),
            revision: revision.into(),
            compiler,
            url: url.to_string(),
        });
    }
    Ok(out)
}
fn apache_checksum(text: &str, file: &str) -> Result<String, CommandError> {
    let lines: Vec<_> = text.lines().map(str::trim).collect();
    let header = format!("SHA256-Checksum for: {file}:");
    let mut matches = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start_matches('\u{feff}').eq_ignore_ascii_case(&header) {
            matches.push(sha256(lines.get(i + 1).copied().unwrap_or(""))?);
        }
    }
    if matches.len() != 1 {
        return Err(CommandError::new("err.updateChecksumMissing"));
    }
    Ok(matches.remove(0))
}
pub(crate) fn download(release: &Release, target: &Path) -> Result<(), CommandError> {
    use sha2::{Digest, Sha256};
    let url = reqwest::Url::parse(&release.url).map_err(|_| catalog_error())?;
    if !allowed_url(&url) {
        return Err(catalog_error());
    }
    let response = status(client()?.get(url).send().map_err(network)?)?;
    let mut input = response.take(MAX_DOWNLOAD + 1);
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
    let size = std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    if size > MAX_DOWNLOAD || release.size.is_some_and(|expected| size != expected) {
        return Err(CommandError::new("err.updateArchive"));
    }
    let mut digest = Sha256::new();
    let mut file = fs::File::open(target)?;
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    if format!("{:x}", digest.finalize()) != release.sha256 {
        return Err(CommandError::new("err.updateChecksum"));
    }
    Ok(())
}

pub(crate) fn identify(kind: Kind, dir: &Path) -> Result<Build, CommandError> {
    if kind == Kind::Php {
        return php::identify(dir);
    }
    let exe = dir.join(kind.executable());
    if !pe_x64(&exe)? {
        return Err(unsupported());
    }
    let mut command = crate::paths::hidden_command(crate::paths::external_path(&exe));
    command.current_dir(crate::paths::external_path(dir)).arg(match kind {
        Kind::Apache => "-V",
        Kind::Nginx => "-v",
        _ => "version",
    });
    let output = run(&mut command)?;
    let text =
        format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let prefix = match kind {
        Kind::Apache => "Apache/",
        Kind::Nginx => "nginx/",
        _ => "v",
    };
    let raw = if kind == Kind::Caddy {
        text.trim().strip_prefix(prefix)
    } else {
        text.split_once(prefix).map(|v| v.1)
    }
    .ok_or_else(unsupported)?;
    let version = raw.split_whitespace().next().ok_or_else(unsupported)?;
    let v = php::version(version).ok_or_else(unsupported)?;
    if (kind == Kind::Apache && (v.0, v.1) != (2, 4)) || (kind == Kind::Caddy && v.0 != 2) {
        return Err(unsupported());
    }
    let toolchain = if kind == Kind::Apache {
        if text.contains("VS18") {
            "vs18"
        } else if text.contains("VS17") {
            "vs17"
        } else {
            return Err(unsupported());
        }
    } else {
        ""
    };
    Ok(Build { version: version.into(), arch: "x64".into(), toolchain: toolchain.into() })
}
fn pe_x64(path: &Path) -> Result<bool, CommandError> {
    let mut file = fs::File::open(path)?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Ok(false);
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if !(64..=1_048_576).contains(&offset) {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe)?;
    Ok(&pe[..4] == b"PE\0\0" && pe[4..6] == [0x64, 0x86])
}
pub(crate) fn run(command: &mut std::process::Command) -> Result<std::process::Output, CommandError> {
    use std::process::Stdio;
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().ok_or_else(unsupported)?;
    let stderr = child.stderr.take().ok_or_else(unsupported)?;
    fn read(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        stream.by_ref().take(1_000_001).read_to_end(&mut out)?;
        Ok(out)
    }
    let out = std::thread::spawn(move || read(stdout));
    let err = std::thread::spawn(move || read(stderr));
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            return Err(CommandError::new("err.updateState"));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = std::process::Output {
        status,
        stdout: out.join().map_err(|_| unsupported())??,
        stderr: err.join().map_err(|_| unsupported())??,
    };
    if output.stdout.len() > 1_000_000 || output.stderr.len() > 1_000_000 {
        return Err(CommandError::new("err.updateState"));
    }
    if !output.status.success() {
        return Err(crate::error::command_failed("err.updateProbe", &output));
    }
    Ok(output)
}

pub(crate) fn payload(kind: Kind, staging: &Path) -> Result<PathBuf, CommandError> {
    if kind == Kind::Apache {
        crate::update_files::child(staging, "Apache24")
    } else {
        Ok(staging.to_path_buf())
    }
}
pub(crate) fn validate_candidate(
    kind: Kind,
    payload: &Path,
    installed: &Build,
    release: &Release,
) -> Result<Build, CommandError> {
    let fresh = identify(kind, payload)?;
    validate_version(kind, &installed.version, &release.version, &fresh.version)?;
    if fresh.arch != installed.arch
        || (kind == Kind::Php
            && (fresh.toolchain != installed.toolchain || !payload.join("php-cgi.exe").is_file()))
        || (kind == Kind::Apache
            && !release.url.to_ascii_lowercase().ends_with(&format!("-{}.zip", fresh.toolchain)))
    {
        return Err(unsupported());
    }
    Ok(fresh)
}
fn validate_version(kind: Kind, installed: &str, declared: &str, actual: &str) -> Result<(), CommandError> {
    let old = php::version(installed).ok_or_else(unsupported)?;
    let expected = php::version(declared).ok_or_else(unsupported)?;
    let found = php::version(actual).ok_or_else(unsupported)?;
    let corrected_patch = kind == Kind::Caddy
        && (found.0, found.1) == (expected.0, expected.1)
        && found.0 == 2
        && found > expected;
    if found < old || (found != expected && !corrected_patch) {
        return Err(CommandError::new("err.updateVersionMismatch")
            .with("expected", declared)
            .with("actual", actual));
    }
    Ok(())
}
pub(crate) fn managed(kind: Kind, relative: &Path) -> bool {
    let name = relative.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let parts: Vec<_> = name.split('/').collect();
    match kind {
        Kind::Php => !name.starts_with("ospanel_data/") && !name.ends_with(".ini"),
        Kind::Caddy => name == "caddy.exe",
        Kind::Nginx => parts.len() == 1 && (name.ends_with(".exe") || name.ends_with(".dll")),
        Kind::Apache => {
            parts.len() == 2
                && ((parts[0] == "bin" && (name.ends_with(".exe") || name.ends_with(".dll")))
                    || (parts[0] == "modules" && name.ends_with(".so")))
        }
    }
}
pub(crate) fn install_files(kind: Kind, source: &Path, destination: &Path) -> Result<(), CommandError> {
    crate::update_files::safe_tree(source)?;
    crate::update_files::safe_tree(destination)?;
    fn walk(kind: Kind, base: &Path, source: &Path, destination: &Path) -> Result<(), CommandError> {
        for entry in fs::read_dir(source)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(kind, base, &path, destination)?;
            } else {
                let relative = path.strip_prefix(base).map_err(|_| unsupported())?;
                if !managed(kind, relative) {
                    continue;
                }
                let target = destination.join(relative);
                fs::create_dir_all(target.parent().ok_or_else(unsupported)?)?;
                if target.try_exists()? {
                    fs::remove_file(&target)?;
                }
                let mut input = fs::File::open(&path)?;
                let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
                std::io::copy(&mut input, &mut output)?;
                output.sync_all()?;
            }
        }
        Ok(())
    }
    walk(kind, source, source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn build(version: &str) -> Build {
        Build { version: version.into(), arch: "x64".into(), toolchain: "".into() }
    }
    fn github(kind: Kind, version: &str, id: u64) -> serde_json::Value {
        let (repo, tag, file) = if kind == Kind::Nginx {
            ("nginx", format!("release-{version}"), format!("nginx-{version}.zip"))
        } else {
            ("caddy", format!("v{version}"), format!("caddy-v{version}-windows-amd64.zip"))
        };
        serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[{"id":id,"name":file,"size":1024,"digest":format!("sha256:{}","a".repeat(64)),"browser_download_url":format!("https://github.com/OSPanel/{repo}/releases/download/{tag}/{file}")}]})
    }
    #[test]
    fn module_names_are_a_fixed_whitelist_with_the_existing_php_branch_rules() {
        for name in ["Apache", "Nginx", "Caddy", "PHP-8.4"] {
            assert!(Kind::of(name).is_ok());
        }
        for name in ["apache", "Nginx-custom", "../Apache", "PHP-8.4/../../", "Caddy & calc"] {
            assert!(Kind::of(name).is_err());
        }
    }
    #[test]
    fn observed_release_metadata_matches_all_three_provider_parsers() {
        let snapshot: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/web-releases-2026-10-25.json")).unwrap();
        for (kind, key, installed, expected) in
            [(Kind::Nginx, "nginx", "1.29.4", "1.29.6"), (Kind::Caddy, "caddy", "2.10.2", "2.11.1")]
        {
            let release =
                github_release(kind, snapshot[key].as_array().unwrap(), &build(installed)).unwrap().unwrap();
            assert_eq!(release.version, expected);
            assert_eq!(release.sha256.len(), 64);
        }
        let links = apache_links(snapshot["apacheHtml"].as_str().unwrap()).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].version, "2.4.69");
        assert_eq!(links[0].revision, "261002");
        assert_eq!(
            apache_checksum(snapshot["apacheChecksums"].as_str().unwrap(), &links[0].file).unwrap(),
            "77d715d0d9cee731e2251e7ddc2090a7a8e6d41fedef2e9827cd918593c5a652"
        );
    }
    #[test]
    fn github_selection_uses_versions_not_response_order_and_preserves_nginx_branch() {
        let mut beta = github(Kind::Nginx, "1.29.9", 9);
        beta["prerelease"] = true.into();
        let releases = [
            github(Kind::Nginx, "1.30.1", 10),
            github(Kind::Nginx, "1.29.5", 5),
            beta,
            github(Kind::Nginx, "1.29.6", 6),
        ];
        let selected = github_release(Kind::Nginx, &releases, &build("1.29.4")).unwrap().unwrap();
        assert_eq!(selected.version, "1.29.6");
        assert!(selected.identity.contains("nginx/release-1.29.6/6:"));
        let releases = [github(Kind::Caddy, "3.0.0", 3), github(Kind::Caddy, "2.11.1", 2)];
        assert_eq!(
            github_release(Kind::Caddy, &releases, &build("2.10.2")).unwrap().unwrap().version,
            "2.11.1"
        );
    }
    #[test]
    fn github_rejects_missing_hash_wrong_origin_ambiguous_assets_and_oversized_downloads() {
        for field in ["digest", "browser_download_url", "size"] {
            let mut entry = github(Kind::Nginx, "1.29.6", 1);
            entry["assets"][0][field] = match field {
                "digest" => serde_json::Value::Null,
                "size" => (MAX_DOWNLOAD + 1).into(),
                _ => "https://example.org/nginx.zip".into(),
            };
            assert!(github_release(Kind::Nginx, &[entry], &build("1.29.4")).is_err());
        }
        let mut entry = github(Kind::Caddy, "2.11.1", 1);
        let asset = entry["assets"][0].clone();
        entry["assets"].as_array_mut().unwrap().push(asset);
        assert!(github_release(Kind::Caddy, &[entry], &build("2.10.2")).is_err());
    }
    #[test]
    fn apache_selects_only_win64_httpd_links_and_binds_sha256_to_the_exact_filename() {
        let html = r#"<a href="VS18/binaries/httpd-2.4.69-261002-Win64-VS18.zip">64</a>
            <A HREF = 'VS17/binaries/httpd-2.4.68-260601-Win64-VS17.zip'>old</A>
            <a href=VS18/binaries/httpd-2.4.69-261002-Win32-VS18.zip>32</a>
            <a href='https://evil.example/httpd-2.4.99-Win64-VS18.zip'>foreign</a>
            <a href='VS18/binaries/mod_security-win64-VS18.zip'>module</a>"#;
        let links = apache_links(html).unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].revision, "261002");
        assert_eq!(links[0].compiler, 18);
        let sums = format!(
            "SHA1-Checksum for: {}:\n{}\nSHA256-Checksum for: {}:\n{}\n",
            links[0].file,
            "b".repeat(40),
            links[0].file,
            "A".repeat(64)
        );
        assert_eq!(apache_checksum(&sums, &links[0].file).unwrap(), "a".repeat(64));
        assert!(apache_checksum(&sums, &links[1].file).is_err());
        assert!(apache_checksum(&format!("{sums}{sums}"), &links[0].file).is_err());
    }
    #[test]
    fn redirects_are_https_only_and_cannot_leak_to_other_origins_or_ports() {
        for url in [
            "http://github.com/x",
            "https://github.com.evil/x",
            "https://user:secret@github.com/x",
            "https://github.com:444/x",
            "https://127.0.0.1/x",
        ] {
            assert!(!allowed_url(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(allowed_url(&reqwest::Url::parse("https://release-assets.githubusercontent.com/x").unwrap()));
    }
    #[test]
    fn receipt_detects_rebuilds_without_offering_downgrades() {
        let candidate = release(
            "2.4.69".into(),
            "2.4.69".into(),
            String::new(),
            "a".repeat(64),
            "261002".into(),
            "apache".into(),
            None,
        );
        assert!(newer(&candidate, &build("2.4.68"), None));
        assert!(!newer(&candidate, &build("2.4.70"), None));
        assert!(!newer(&candidate, &build("2.4.69"), None));
        let old =
            Receipt { version: "2.4.69".into(), revision: "260901".into(), identity: "previous".into() };
        assert!(newer(&candidate, &build("2.4.69"), Some(&old)));
        let same = Receipt { identity: candidate.identity.clone(), ..old };
        assert!(!newer(&candidate, &build("2.4.69"), Some(&same)));
    }
    #[test]
    fn mislabeled_caddy_archives_allow_a_newer_stable_patch_but_never_a_downgrade_or_branch_change() {
        validate_version(Kind::Caddy, "2.10.2", "2.11.1", "2.11.2").unwrap();
        validate_version(Kind::Caddy, "2.10.2", "2.11.1", "2.11.1").unwrap();
        for (installed, declared, actual) in [
            ("2.10.2", "2.11.1", "2.11.0"),
            ("2.11.3", "2.11.1", "2.11.2"),
            ("2.10.2", "2.11.1", "2.12.0"),
            ("2.10.2", "2.11.1", "3.0.0"),
            ("2.10.2", "2.11.1", "2.11.2-rc1"),
        ] {
            assert!(validate_version(Kind::Caddy, installed, declared, actual).is_err());
        }
        for kind in [Kind::Nginx, Kind::Apache, Kind::Php] {
            assert!(validate_version(kind, "2.10.2", "2.11.1", "2.11.2").is_err());
        }
    }
    #[test]
    fn a_corrected_caddy_tag_does_not_reoffer_the_same_verified_binary() {
        let release = release(
            "2.11.2".into(),
            "2.11.2".into(),
            String::new(),
            "a".repeat(64),
            String::new(),
            "caddy/v2.11.2/2".into(),
            None,
        );
        let installed = Receipt {
            version: "2.11.2".into(),
            revision: String::new(),
            identity: format!("caddy/v2.11.1/1:{}", "a".repeat(64)),
        };
        assert!(!newer(&release, &build("2.11.2"), Some(&installed)));
    }
    fn temporary(label: &str) -> PathBuf {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = base.join(format!("osp-module-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn payload_installation_preserves_configuration_custom_modules_and_supports_exact_rollback() {
        use crate::update_files as files;
        for kind in [Kind::Apache, Kind::Nginx, Kind::Caddy] {
            let root = temporary("payload");
            let source = root.join("source");
            let dest = root.join("module");
            let backup = root.join("backup");
            for path in [&source, &dest, &backup] {
                fs::create_dir(path).unwrap();
            }
            for path in [&source, &dest] {
                fs::create_dir_all(path.join("conf")).unwrap();
                fs::create_dir_all(path.join("ospanel_data")).unwrap();
                fs::create_dir_all(path.join("modules")).unwrap();
                fs::create_dir_all(path.join("bin")).unwrap();
            }
            let exe = Path::new(kind.executable());
            fs::write(dest.join(exe), "old executable").unwrap();
            fs::write(source.join(exe), "new executable").unwrap();
            for path in [
                "conf/httpd.conf",
                "conf/nginx.conf",
                "Caddyfile",
                "ospanel_data/module.ini",
                "modules/custom.so",
            ] {
                fs::write(dest.join(path), "user data").unwrap();
                fs::write(source.join(path), "archive default").unwrap();
            }
            fs::write(source.join("new.dll"), "new dependency").unwrap();
            fs::write(dest.join("modules/user-only.so"), "custom extension").unwrap();
            let original = files::manifest(&dest).unwrap();
            files::overlay(&dest, &backup).unwrap();
            install_files(kind, &source, &dest).unwrap();
            assert_eq!(fs::read_to_string(dest.join("modules/user-only.so")).unwrap(), "custom extension");
            assert_eq!(fs::read_to_string(dest.join(exe)).unwrap(), "new executable");
            for path in ["conf/httpd.conf", "conf/nginx.conf", "Caddyfile", "ospanel_data/module.ini"] {
                assert_eq!(fs::read_to_string(dest.join(path)).unwrap(), "user data");
            }
            assert_eq!(
                fs::read_to_string(dest.join("modules/custom.so")).unwrap(),
                if kind == Kind::Apache { "archive default" } else { "user data" }
            );
            files::exact_restore(&backup, &dest).unwrap();
            files::validate_backup(&dest, &original, kind.executable()).unwrap();
            assert_eq!(root.parent(), Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path()));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn rollback_restores_the_previous_build_receipt_and_removes_a_new_receipt() {
        let root = temporary("receipt");
        let module = root.join("module");
        let backup = root.join("backup");
        fs::create_dir_all(module.join("ospanel_data")).unwrap();
        fs::create_dir(&backup).unwrap();
        fs::write(module.join("nginx.exe"), "binary").unwrap();
        let old = crate::update_files::manifest(&module).unwrap();
        crate::update_files::overlay(&module, &backup).unwrap();
        let update = release(
            "1.29.6".into(),
            "1.29.6".into(),
            String::new(),
            "a".repeat(64),
            String::new(),
            "asset".into(),
            None,
        );
        save_receipt(&module, &update).unwrap();
        assert_eq!(receipt(&module).unwrap().unwrap().identity, update.identity);
        crate::update_files::exact_restore(&backup, &module).unwrap();
        assert!(receipt(&module).unwrap().is_none());
        crate::update_files::validate_backup(&module, &old, "nginx.exe").unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Requires OSP_CONTROL_WEB_ARCHIVES pointing to downloaded, SHA-256 verified release ZIPs; never modifies OSPanel"]
    fn downloaded_web_archives_use_the_verified_caddy_patch_version() {
        let archives = PathBuf::from(std::env::var_os("OSP_CONTROL_WEB_ARCHIVES").unwrap());
        for (kind, file, version) in [
            (Kind::Nginx, "nginx-1.29.6.zip", "1.29.6"),
            (Kind::Caddy, "caddy-v2.11.1-windows-amd64.zip", "2.11.1"),
            (Kind::Apache, "httpd-2.4.69-261002-Win64-VS18.zip", "2.4.69"),
        ] {
            let root = temporary("archive");
            let staging = root.join("stage");
            crate::update_files::extract(&archives.join(file), &staging).unwrap();
            let payload = payload(kind, &staging).unwrap();
            let found = identify(kind, &payload).unwrap();
            eprintln!("{file}: declared {version}, actual {}", found.version);
            if kind == Kind::Caddy {
                // The observed OSPanel v2.11.1 asset contains a v2.11.2 executable.
                let release = release(
                    version.into(),
                    version.into(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    None,
                );
                let verified = validate_candidate(kind, &payload, &build("2.10.2"), &release).unwrap();
                assert_eq!(verified.version, "2.11.2");
            } else {
                assert_eq!(found.version, version);
            }
            assert_eq!(found.arch, "x64");
            assert!(managed(kind, Path::new(kind.executable())));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    #[ignore = "Requires OSP_CONTROL_WEB_TEST_ROOT and HTTPS access; reads installed binaries and release metadata only"]
    fn installed_web_modules_match_live_sources() {
        let root = PathBuf::from(std::env::var_os("OSP_CONTROL_WEB_TEST_ROOT").unwrap());
        let mut catalog = Catalog::new(true);
        for name in ["Apache", "Nginx", "Caddy"] {
            let dir = crate::update_files::child(&root.join("modules"), name).unwrap();
            let build = identify(Kind::of(name).unwrap(), &dir).unwrap();
            let candidate = catalog.select(name, &build, &dir).unwrap();
            eprintln!(
                "{name}: {} -> {}",
                build.version,
                candidate.map(|r| r.display).as_deref().unwrap_or("current")
            );
        }
    }
}
