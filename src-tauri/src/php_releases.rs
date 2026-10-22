//! Official Windows PHP release metadata and installed binary identification.
use std::{fs, io::Read, path::Path, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use crate::{error::CommandError, paths::hidden_command};

const BASE: &str = "https://downloads.php.net/~windows/releases/";
// PHP_EXTENSION_BUILD is a C macro, not a PHP constant. Read it from CLI phpinfo.
const BUILD_PROBE: &str = concat!(
    "ob_start(); phpinfo(INFO_GENERAL); $info = ob_get_clean(); ",
    "preg_match('/^PHP Extension Build => (.+)$/m', $info, $build); ",
    "echo json_encode([PHP_VERSION, PHP_ZTS, PHP_INT_SIZE, PHP_EXTRA_VERSION, trim($build[1] ?? '')]);"
);
pub(crate) fn invalid() -> CommandError { CommandError::new("err.phpUnsupported") }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Build {
    pub version: String,
    pub arch: String,
    pub toolchain: String,
}

pub(crate) fn version(value: &str) -> Option<(u32,u32,u32)> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 { return None; }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}
pub(crate) fn branch(name: &str) -> Option<&str> {
    let value = name.strip_prefix("PHP-")?;
    let parts: Vec<_> = value.split('.').collect();
    if parts.len()!=2 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit())) { return None; }
    Some(value)
}

pub(crate) fn identify(dir: &Path) -> Result<Build, CommandError> {
    let mut child = hidden_command(dir.join("php.exe"))
        .args(["-n", "-r", BUILD_PROBE])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait()?.is_some() { break; }
        if Instant::now() > deadline { let _ = child.kill(); let _ = child.wait(); return Err(invalid()); }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() { return Err(invalid()); }
    parse_build(&output.stdout)
}

fn parse_build(output: &[u8]) -> Result<Build, CommandError> {
    let info: serde_json::Value = serde_json::from_slice(output).map_err(|_| invalid())?;
    let v = info[0].as_str().ok_or_else(invalid)?.to_string();
    // PHP_ZTS changed from int to bool in PHP 8.4; both NTS representations are valid.
    let nts = info[1].as_i64() == Some(0) || info[1].as_bool() == Some(false);
    if version(&v).is_none() || !nts || info[3].as_str()!=Some("") { return Err(invalid()); }
    let extension_build=info[4].as_str().ok_or_else(invalid)?;
    if !extension_build.contains(",NTS,") { return Err(invalid()); }
    let compiler = if extension_build.ends_with(",VS17") { "vs17" }
        else if extension_build.ends_with(",VS16") { "vs16" }
        else if extension_build.ends_with(",VC15") { "vc15" }
        else { return Err(invalid()); };
    Ok(Build { version: v, arch: match info[2].as_u64() { Some(8)=>"x64", Some(4)=>"x86", _=>return Err(invalid()) }.into(), toolchain: compiler.into() })
}

pub(crate) fn client() -> Result<reqwest::blocking::Client, CommandError> {
    reqwest::blocking::Client::builder().https_only(true).connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180)).redirect(reqwest::redirect::Policy::none())
        .build().map_err(network)
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
pub(crate) fn catalog() -> Result<serde_json::Value, CommandError> {
    let mut bytes = Vec::new();
    client()?.get(format!("{BASE}releases.json")).send().map_err(network)?.error_for_status().map_err(network)?
        .take(2_000_001).read_to_end(&mut bytes)?;
    if bytes.len()>2_000_000 { return Err(invalid()); }
    serde_json::from_slice(&bytes).map_err(|_| CommandError::new("err.phpCatalog"))
}
#[derive(Debug, Clone)]
pub(crate) struct Release { pub version: String, pub file: String, pub sha256: String }
pub(crate) fn select(json: &serde_json::Value, family: &str, build: &Build) -> Result<Option<Release>, CommandError> {
    let old = version(&build.version).ok_or_else(invalid)?;
    if format!("{}.{}", old.0, old.1)!=family || build.toolchain.is_empty() { return Err(invalid()); }
    let node = &json[family];
    if node.is_null() { return Err(invalid()); }
    let latest = node["version"].as_str().ok_or_else(|| CommandError::new("err.phpCatalog"))?;
    let new = version(latest).ok_or_else(invalid)?;
    if (old.0,old.1)!=(new.0,new.1) { return Err(invalid()); }
    if new<=old { return Ok(None); }
    let key = format!("nts-{}-{}", build.toolchain, build.arch);
    let zip = &node[&key]["zip"];
    let file = zip["path"].as_str().ok_or_else(invalid)?;
    let expected = format!("php-{latest}-nts-Win32-{}-{}.zip", build.toolchain, build.arch);
    let hash = zip["sha256"].as_str().ok_or_else(invalid)?;
    if file!=expected || hash.len()!=64 || !hash.bytes().all(|c|c.is_ascii_hexdigit()) { return Err(invalid()); }
    Ok(Some(Release{ version: latest.into(), file:file.into(), sha256:hash.to_ascii_lowercase() }))
}
pub(crate) fn download(release: &Release, target: &Path) -> Result<(), CommandError> {
    use sha2::{Digest, Sha256};
    let response = client()?.get(format!("{BASE}{}", release.file)).send().map_err(network)?.error_for_status().map_err(network)?;
    let mut input = response.take(160_000_001);
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
    let size = std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    if size>160_000_000 { return Err(invalid()); }
    let mut digest = Sha256::new();
    let mut file = fs::File::open(target)?;
    let mut buf = [0;65536];
    loop { let n=file.read(&mut buf)?; if n==0 {break;} digest.update(&buf[..n]); }
    if format!("{:x}",digest.finalize())!=release.sha256 { return Err(CommandError::new("err.phpChecksum")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
            if !entry.file_type().unwrap().is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(family) = branch(&name) else { continue; };
            let dir = fs::canonicalize(entry.path()).unwrap();
            assert_eq!(dir.parent(), Some(modules.as_path()));
            let build = identify(&dir).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            checked += 1;
            if json.get(family).is_none() {
                eprintln!("{name}: {} (not in the current catalog)", build.version);
                continue;
            }
            let release = select(json, family, &build).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            eprintln!("{name}: {} -> {}", build.version, release.map(|r| r.version).as_deref().unwrap_or("current"));
        }
        assert!(checked > 0, "The installation must contain PHP modules");
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_PHP_TEST_ROOT and network access to the official PHP catalog"]
    fn installed_modules_match_live_catalog() {
        check_installed_modules(&catalog().expect("The official PHP catalog must be reachable"));
    }

    #[test]
    #[ignore = "Requires OSP_CONTROL_PHP_TEST_ROOT; reads installed binaries without changing modules"]
    fn installed_modules_match_catalog_snapshot() {
        check_installed_modules(&serde_json::from_str(CATALOG_SNAPSHOT).unwrap());
    }

    #[test] fn only_stable_patch_releases_are_selected() {
        let b=Build{version:"8.4.9".into(),arch:"x64".into(),toolchain:"vs17".into()};
        let mut j=serde_json::json!({"8.4":{"version":"8.4.10","nts-vs17-x64":{"zip":{"path":"php-8.4.10-nts-Win32-vs17-x64.zip","sha256":"a".repeat(64)}}}});
        assert_eq!(select(&j,"8.4",&b).unwrap().unwrap().version,"8.4.10");
        j["8.4"]["version"]="8.5.0".into(); assert!(select(&j,"8.4",&b).is_err());
        j["8.4"]["version"]="8.4.11RC1".into(); assert!(select(&j,"8.4",&b).is_err());
        j["8.4"]["version"]="8.4.8".into(); assert!(select(&j,"8.4",&b).unwrap().is_none());
        assert!(branch("PHP-8.4/../../config").is_none());
    }
}
