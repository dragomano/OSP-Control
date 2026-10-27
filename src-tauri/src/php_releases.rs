//! Official Windows PHP release metadata and installed binary identification.
use crate::{error::CommandError, paths::hidden_command};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

const BASE: &str = "https://downloads.php.net/~windows/releases/";
// PHP_EXTENSION_BUILD is a C macro, not a PHP constant. Read it from CLI phpinfo.
const BUILD_PROBE: &str = concat!(
    "ob_start(); phpinfo(INFO_GENERAL); $info = ob_get_clean(); ",
    "preg_match('/^PHP Extension Build => (.+)$/m', $info, $build); ",
    "echo json_encode([PHP_VERSION, PHP_ZTS, PHP_INT_SIZE, PHP_EXTRA_VERSION, trim($build[1] ?? '')]);"
);
pub(crate) fn invalid() -> CommandError {
    CommandError::new("err.phpUnsupported")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Build {
    pub version: String,
    pub arch: String,
    pub toolchain: String,
}

pub(crate) fn version(value: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}
// Windows package revisions are stable rebuilds, not PHP prereleases.
pub(crate) fn package_version(value: &str) -> Option<(u32, u32, u32, u32)> {
    let (base, revision) = match value.split_once('-') {
        Some((base, revision)) => {
            if revision.is_empty() || !revision.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let revision: u32 = revision.parse().ok()?;
            if revision == 0 {
                return None;
            }
            (base, revision)
        }
        None => (value, 0),
    };
    let (major, minor, patch) = version(base)?;
    Some((major, minor, patch, revision))
}
pub(crate) fn branch(name: &str) -> Option<&str> {
    let value = name.strip_prefix("PHP-")?;
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some(value)
}

pub(crate) fn identify(dir: &Path) -> Result<Build, CommandError> {
    let mut child = hidden_command(dir.join("php.exe"))
        .args(["-n", "-r", BUILD_PROBE])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(invalid());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(invalid());
    }
    parse_build(&output.stdout)
}

fn parse_build(output: &[u8]) -> Result<Build, CommandError> {
    let info: serde_json::Value = serde_json::from_slice(output).map_err(|_| invalid())?;
    let v = info[0].as_str().ok_or_else(invalid)?.to_string();
    // PHP_ZTS changed from int to bool in PHP 8.4; both NTS representations are valid.
    let nts = info[1].as_i64() == Some(0) || info[1].as_bool() == Some(false);
    if version(&v).is_none() || !nts || info[3].as_str() != Some("") {
        return Err(invalid());
    }
    let extension_build = info[4].as_str().ok_or_else(invalid)?;
    if !extension_build.contains(",NTS,") {
        return Err(invalid());
    }
    let compiler = if extension_build.ends_with(",VS17") {
        "vs17"
    } else if extension_build.ends_with(",VS16") {
        "vs16"
    } else if extension_build.ends_with(",VC15") {
        "vc15"
    } else {
        return Err(invalid());
    };
    Ok(Build {
        version: v,
        arch: match info[2].as_u64() {
            Some(8) => "x64",
            Some(4) => "x86",
            _ => return Err(invalid()),
        }
        .into(),
        toolchain: compiler.into(),
    })
}

fn client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("OSP-Control/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(network)
}
fn network(e: reqwest::Error) -> CommandError {
    use std::error::Error;
    let mut detail = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    CommandError::new("err.phpNetwork").with("detail", detail)
}
type CatalogCache = Mutex<Option<(Instant, serde_json::Value)>>;
static CACHE: CatalogCache = Mutex::new(None);

pub(crate) fn catalog(force: bool) -> Result<serde_json::Value, CommandError> {
    cached_catalog(&CACHE, force, fetch_catalog)
}
fn cached_catalog(
    cache: &CatalogCache,
    force: bool,
    fetch: impl FnOnce() -> Result<serde_json::Value, CommandError>,
) -> Result<serde_json::Value, CommandError> {
    if !force
        && let Some((checked, json)) = cache.lock().map_err(|_| invalid())?.as_ref()
        && checked.elapsed() < Duration::from_secs(6 * 3600)
    {
        return Ok(json.clone());
    }
    // Failed checks never replace the cache or masquerade as a current catalog.
    let json = fetch()?;
    *cache.lock().map_err(|_| invalid())? = Some((Instant::now(), json.clone()));
    Ok(json)
}
fn retry_request<T>(mut request: impl FnMut() -> Result<T, reqwest::Error>) -> Result<T, CommandError> {
    let mut attempt = 0;
    loop {
        match request() {
            Ok(response) => return Ok(response),
            Err(e)
                if attempt == 0
                    && (e.is_connect()
                        || e.is_timeout()
                        || e.status().is_some_and(|s| s.is_server_error())) =>
            {
                attempt += 1;
            }
            Err(e) => return Err(network(e)),
        }
    }
}
fn fetch_catalog() -> Result<serde_json::Value, CommandError> {
    let client = client()?;
    let response = retry_request(|| {
        client.get(format!("{BASE}releases.json")).send().and_then(|r| r.error_for_status())
    })?;
    let mut bytes = Vec::new();
    response
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|e| CommandError::new("err.phpNetwork").with("detail", e.to_string()))?;
    if bytes.len() > 2_000_000 {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| CommandError::new("err.phpCatalog"))
}
#[derive(Debug, Clone)]
pub(crate) struct Release {
    pub version: String,
    pub file: String,
    pub sha256: String,
}
pub(crate) fn select(
    json: &serde_json::Value,
    family: &str,
    build: &Build,
) -> Result<Option<Release>, CommandError> {
    let old = package_version(&build.version).ok_or_else(invalid)?;
    if format!("{}.{}", old.0, old.1) != family || build.toolchain.is_empty() {
        return Err(invalid());
    }
    let node = &json[family];
    if node.is_null() {
        return Err(invalid());
    }
    let latest = node["version"].as_str().ok_or_else(|| CommandError::new("err.phpCatalog"))?;
    let new = package_version(latest).ok_or_else(|| CommandError::new("err.phpCatalog"))?;
    if (old.0, old.1) != (new.0, new.1) {
        return Err(invalid());
    }
    if new <= old {
        return Ok(None);
    }
    let key = format!("nts-{}-{}", build.toolchain, build.arch);
    let zip = &node[&key]["zip"];
    let file = zip["path"].as_str().ok_or_else(invalid)?;
    let expected = format!("php-{latest}-nts-Win32-{}-{}.zip", build.toolchain, build.arch);
    let hash = zip["sha256"].as_str().ok_or_else(invalid)?;
    if file != expected || hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    Ok(Some(Release { version: latest.into(), file: file.into(), sha256: hash.to_ascii_lowercase() }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn windows_revisions_sort_after_the_base_release_and_before_the_next_patch() {
        let versions = ["8.5.11-10", "8.5.12", "8.5.12-1", "8.5.12-2", "8.5.12-10", "8.5.13"];
        for pair in versions.windows(2) {
            assert!(package_version(pair[0]).unwrap() < package_version(pair[1]).unwrap());
        }
        for value in [
            "8.5.12RC1",
            "8.5.12-rc1",
            "8.5.12-",
            "8.5.12-0",
            "8.5.12--1",
            "8.5.12-1-2",
            "8.5.12-1/../file",
            "8.5.12-4294967296",
            "8.5.+12",
            "8.5.12- 1",
            "8.5.12-1\n",
        ] {
            assert!(package_version(value).is_none(), "{value}");
        }
        assert!(version("8.5.12-1").is_none());
    }

    #[test]
    fn stable_windows_rebuilds_are_selected_without_downgrading_or_changing_the_branch() {
        let mut b = Build { version: "8.5.12".into(), arch: "x64".into(), toolchain: "vs17".into() };
        let mut json = serde_json::json!({"8.5": {
            "version": "8.5.12-1",
            "nts-vs17-x64": {"zip": {
                "path": "php-8.5.12-1-nts-Win32-vs17-x64.zip",
                "sha256": "2a36a2edcb7a5b9252f638fd5e4cf84d7f6e066092654220dc0b63e5cf4e9723"
            }}
        }});
        let release = select(&json, "8.5", &b).unwrap().unwrap();
        assert_eq!(release.version, "8.5.12-1");
        assert_eq!(release.file, "php-8.5.12-1-nts-Win32-vs17-x64.zip");
        for installed in ["8.5.12-1", "8.5.12-2", "8.5.13"] {
            b.version = installed.into();
            assert!(select(&json, "8.5", &b).unwrap().is_none());
        }
        b.version = "8.5.12".into();
        assert!(select(&json, "8.4", &b).is_err());
        json["8.5"]["nts-vs17-x64"]["zip"]["path"] = "php-8.5.12-nts-Win32-vs17-x64.zip".into();
        assert!(select(&json, "8.5", &b).is_err());
    }

    #[test]
    fn catalog_cache_respects_expiry_force_and_failed_refreshes() {
        let cache = Mutex::new(None);
        let first = serde_json::json!({"8.5": {"version": "8.5.12"}});
        let next = serde_json::json!({"8.5": {"version": "8.5.12-1"}});
        assert_eq!(cached_catalog(&cache, false, || Ok(first.clone())).unwrap(), first);
        assert_eq!(cached_catalog(&cache, false, || panic!("Fresh catalog must be reused")).unwrap(), first);
        assert_eq!(cached_catalog(&cache, true, || Ok(next.clone())).unwrap(), next);
        let failed = || Err(CommandError::new("err.phpNetwork"));
        assert_eq!(cached_catalog(&cache, true, failed).unwrap_err().code, "err.phpNetwork");
        assert_eq!(
            cached_catalog(&cache, false, || panic!("Failed refresh must preserve the cache")).unwrap(),
            next
        );
        cache.lock().unwrap().as_mut().unwrap().0 = Instant::now() - Duration::from_secs(6 * 3600 + 1);
        assert!(cached_catalog(&cache, false, failed).is_err());
        assert_eq!(cached_catalog(&cache, false, || Ok(first.clone())).unwrap(), first);
        let empty = Mutex::new(None);
        assert!(cached_catalog(&empty, false, failed).is_err());
        assert!(empty.lock().unwrap().is_none());
    }

    #[test]
    fn catalog_requests_retry_transient_errors_once_and_preserve_permanent_failures() {
        use std::{io::Write, net::TcpListener};
        for (statuses, expected_attempts, success) in
            [(vec![503, 200], 2, true), (vec![503, 503], 2, false), (vec![404], 1, false)]
        {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/releases.json", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                for status in statuses {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut request = [0; 8192];
                    stream.read(&mut request).unwrap();
                    write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                    )
                    .unwrap();
                }
            });
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let mut attempts = 0;
            let result = retry_request(|| {
                attempts += 1;
                client.get(&url).send().and_then(|r| r.error_for_status())
            });
            assert_eq!(attempts, expected_attempts);
            assert_eq!(result.is_ok(), success);
            if let Err(error) = result {
                assert_eq!(error.code, "err.phpNetwork");
                assert!(error.params["detail"].contains(&url));
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn identifies_observed_php_7_and_8_nts_builds() {
        for (payload, expected_version, expected_toolchain) in [
            (r#"["7.2.34",0,8,"","API20170718,NTS,VC15"]"#, "7.2.34", "vc15"),
            (r#"["7.3.33",0,8,"","API20180731,NTS,VC15"]"#, "7.3.33", "vc15"),
            (r#"["7.4.33",0,8,"","API20190902,NTS,VC15"]"#, "7.4.33", "vc15"),
            (r#"["8.0.30",0,8,"","API20200930,NTS,VS16"]"#, "8.0.30", "vs16"),
            (r#"["8.1.34",0,8,"","API20210902,NTS,VS16"]"#, "8.1.34", "vs16"),
            (r#"["8.2.30",0,8,"","API20220829,NTS,VS16"]"#, "8.2.30", "vs16"),
            (r#"["8.3.30",0,8,"","API20230831,NTS,VS16"]"#, "8.3.30", "vs16"),
            (r#"["8.4.19",false,8,"","API20240924,NTS,VS17"]"#, "8.4.19", "vs17"),
            (r#"["8.5.4",false,8,"","API20250925,NTS,VS17"]"#, "8.5.4", "vs17"),
        ] {
            let build = parse_build(payload.as_bytes()).unwrap();
            assert_eq!(build.version, expected_version);
            assert_eq!(build.arch, "x64");
            assert_eq!(build.toolchain, expected_toolchain);
        }
        let x86 = parse_build(br#"["8.3.30",0,4,"","API20230831,NTS,VS16"]"#).unwrap();
        assert_eq!(x86.arch, "x86");
    }

    #[test]
    fn rejects_thread_safe_prerelease_and_unrecognized_builds() {
        for payload in [
            r#"["8.4.19",true,8,"","API20240924,TS,VS17"]"#,
            r#"["8.3.30",1,8,"","API20230831,TS,VS16"]"#,
            r#"["8.4.19",false,8,"","API20240924,TS,VS17"]"#,
            r#"["8.4.19","0",8,"","API20240924,NTS,VS17"]"#,
            r#"["8.4.20RC1",false,8,"RC1","API20240924,NTS,VS17"]"#,
            r#"["8.4.19",false,8,"custom","API20240924,NTS,VS17"]"#,
            r#"["8.4.19",false,16,"","API20240924,NTS,VS17"]"#,
            r#"["8.4.19",false,8,"","API20240924,NTS,UNKNOWN"]"#,
            r#"["8.4.19",false,8,"","PHP_EXTENSION_BUILD"]"#,
            r#"["8.4.19",false,8,"",""]"#,
        ] {
            assert!(parse_build(payload.as_bytes()).is_err(), "{payload}");
        }
    }

    // Relevant official NTS x64 catalog entries captured on 2026-10-22.
    const CATALOG_SNAPSHOT: &str = include_str!("../tests/fixtures/php-releases-2026-10-22.json");

    #[test]
    fn observed_outdated_modules_have_compatible_patch_updates() {
        let json = serde_json::from_str(CATALOG_SNAPSHOT).unwrap();
        for (family, payload, expected) in [
            ("8.2", r#"["8.2.30",0,8,"","API20220829,NTS,VS16"]"#, "8.2.35"),
            ("8.3", r#"["8.3.30",0,8,"","API20230831,NTS,VS16"]"#, "8.3.36"),
            ("8.4", r#"["8.4.19",false,8,"","API20240924,NTS,VS17"]"#, "8.4.27"),
            ("8.5", r#"["8.5.4",false,8,"","API20250925,NTS,VS17"]"#, "8.5.12"),
        ] {
            let build = parse_build(payload.as_bytes()).unwrap();
            let release = select(&json, family, &build).unwrap().unwrap();
            assert_eq!(release.version, expected);
        }
    }

    fn check_installed_modules(json: &serde_json::Value) {
        let root = std::env::var_os("OSP_CONTROL_PHP_TEST_ROOT")
            .expect("Set OSP_CONTROL_PHP_TEST_ROOT to an OSPanel installation");
        let modules = fs::canonicalize(Path::new(&root).join("modules")).unwrap();
        let mut checked = 0;
        for entry in fs::read_dir(&modules).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(family) = branch(&name) else {
                continue;
            };
            let dir = fs::canonicalize(entry.path()).unwrap();
            assert_eq!(dir.parent(), Some(modules.as_path()));
            let build = identify(&dir).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            checked += 1;
            if json.get(family).is_none() {
                eprintln!("{name}: {} (not in the current catalog)", build.version);
                continue;
            }
            let release = select(json, family, &build).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            eprintln!(
                "{name}: {} -> {}",
                build.version,
                release.map(|r| r.version).as_deref().unwrap_or("current")
            );
        }
        assert!(checked > 0, "The installation must contain PHP modules");
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_PHP_TEST_ROOT and network access to the official PHP catalog"]
    fn installed_modules_match_live_catalog() {
        check_installed_modules(&catalog(true).expect("The official PHP catalog must be reachable"));
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_PHP_TEST_ROOT; reads installed binaries without changing modules"]
    fn installed_modules_match_catalog_snapshot() {
        check_installed_modules(&serde_json::from_str(CATALOG_SNAPSHOT).unwrap());
    }

    #[test]
    fn only_stable_patch_releases_are_selected() {
        let b = Build { version: "8.4.9".into(), arch: "x64".into(), toolchain: "vs17".into() };
        let mut j = serde_json::json!({"8.4":{"version":"8.4.10","nts-vs17-x64":{"zip":{"path":"php-8.4.10-nts-Win32-vs17-x64.zip","sha256":"a".repeat(64)}}}});
        assert_eq!(select(&j, "8.4", &b).unwrap().unwrap().version, "8.4.10");
        j["8.4"]["version"] = "8.5.0".into();
        assert!(select(&j, "8.4", &b).is_err());
        j["8.4"]["version"] = "8.4.11RC1".into();
        assert!(select(&j, "8.4", &b).is_err());
        j["8.4"]["version"] = "8.4.8".into();
        assert!(select(&j, "8.4", &b).unwrap().is_none());
        assert!(branch("PHP-8.4/../../config").is_none());
    }
}
