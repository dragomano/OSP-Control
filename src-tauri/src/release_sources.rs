//! Configured GitHub repositories and HTTPS catalogs retain the module's binary compatibility rules.
use super::*;

struct Archive {
    file: String,
    version: String,
    revision: String,
    compiler: u32,
}

fn archive(kind: Kind, name: &str, build: &Build) -> Option<Archive> {
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let version = match kind {
        Kind::Php => lower
            .strip_prefix("php-")?
            .strip_suffix(&format!("-nts-win32-{}-{}.zip", build.toolchain, build.arch))?,
        Kind::Nginx => lower.strip_prefix("nginx-")?.strip_suffix(".zip")?,
        Kind::Caddy => lower
            .strip_prefix("caddy-v")
            .and_then(|v| v.strip_suffix("-windows-amd64.zip"))
            .or_else(|| lower.strip_prefix("caddy_")?.strip_suffix("_windows_amd64.zip"))?,
        Kind::Apache => {
            let parsed = apache_links(&format!("<a href=\"{name}\">archive</a>")).ok()?.pop()?;
            return Some(Archive {
                file: parsed.file,
                version: parsed.version,
                revision: parsed.revision,
                compiler: parsed.compiler,
            });
        }
    };
    let old = php::package_version(&build.version)?;
    let new = if kind == Kind::Php {
        php::package_version(version)?
    } else {
        let v = php::version(version)?;
        (v.0, v.1, v.2, 0, 0)
    };
    if (matches!(kind, Kind::Php | Kind::Nginx) && (old.0, old.1) != (new.0, new.1))
        || (kind == Kind::Caddy && new.0 != 2)
    {
        return None;
    }
    Some(Archive { file: name.into(), version: version.into(), revision: String::new(), compiler: 0 })
}

fn order(archive: &Archive) -> (Option<(u32, u32, u32, u32, u32)>, &str, u32) {
    (php::package_version(&archive.version), &archive.revision, archive.compiler)
}

pub(super) fn github(
    kind: Kind,
    entries: &[serde_json::Value],
    build: &Build,
    repo: &str,
) -> Result<Option<Release>, CommandError> {
    if (kind == Kind::Nginx && repo == "OSPanel/nginx") || (kind == Kind::Caddy && repo == "OSPanel/caddy") {
        return github_release(kind, entries, build);
    }
    let mut candidates = Vec::new();
    for entry in entries {
        if entry["draft"].as_bool() != Some(false) || entry["prerelease"].as_bool() != Some(false) {
            continue;
        }
        let Some(tag) = entry["tag_name"].as_str() else {
            continue;
        };
        let Some(assets) = entry["assets"].as_array() else {
            continue;
        };
        for asset in assets {
            let Some(name) = asset["name"].as_str() else {
                continue;
            };
            let Some(archive) = archive(kind, name, build) else {
                continue;
            };
            if assets.iter().filter(|a| a["name"].as_str() == Some(name)).count() != 1 {
                return Err(catalog_error());
            }
            candidates.push((archive, asset, tag));
        }
    }
    candidates.sort_by(|a, b| {
        order(&a.0).cmp(&order(&b.0)).then_with(|| a.1["id"].as_u64().cmp(&b.1["id"].as_u64()))
    });
    let Some((archive, asset, tag)) = candidates.pop() else {
        return Ok(None);
    };
    let expected = format!("https://github.com/{repo}/releases/download/{tag}/{}", archive.file);
    if asset["browser_download_url"].as_str() != Some(&expected)
        || update_sources::source_url(&expected).is_none_or(|url| url.as_str() != expected)
    {
        return Err(catalog_error());
    }
    let hash = sha256(
        asset["digest"]
            .as_str()
            .and_then(|s| s.strip_prefix("sha256:"))
            .ok_or_else(|| CommandError::new("err.updateChecksumMissing"))?,
    )?;
    let size = asset["size"].as_u64().filter(|n| *n > 0 && *n <= MAX_DOWNLOAD).ok_or_else(catalog_error)?;
    let id = asset["id"].as_u64().ok_or_else(catalog_error)?;
    let display = display(kind, &archive);
    Ok(Some(release(
        archive.version,
        display,
        expected,
        hash,
        archive.revision,
        format!("{repo}/{tag}/{id}"),
        Some(size),
    )))
}

fn directory(url: &reqwest::Url) -> reqwest::Url {
    let mut result = url.clone();
    if !result.path().ends_with('/')
        && !result.path_segments().and_then(|mut p| p.next_back()).unwrap_or("").contains('.')
    {
        result.set_path(&format!("{}/", result.path()));
    }
    result
}
fn display(kind: Kind, archive: &Archive) -> String {
    if kind == Kind::Apache {
        format!("{} ({}, VS{})", archive.version, archive.revision, archive.compiler)
    } else {
        archive.version.clone()
    }
}

pub(super) fn catalog(
    kind: Kind,
    url: &reqwest::Url,
    build: &Build,
    force: bool,
) -> Result<Option<Release>, CommandError> {
    let base = directory(url);
    if kind == Kind::Php {
        let json_url = if url.path().ends_with(".json") {
            url.clone()
        } else {
            base.join("releases.json").map_err(|_| catalog_error())?
        };
        let json = metadata(json_url.as_str(), force)
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).map_err(|_| catalog_error()));
        match json {
            Ok(json) => {
                let old = php::package_version(&build.version).ok_or_else(unsupported)?;
                let family = format!("{}.{}", old.0, old.1);
                if json[&family].is_null() {
                    return Ok(None);
                }
                return php::select(&json, &family, build).map(|candidate| {
                    candidate.map(|r| {
                        let download = base.join(&r.file).map(|url| url.to_string()).unwrap_or_default();
                        release(r.version.clone(), r.version, download, r.sha256, String::new(), r.file, None)
                    })
                });
            }
            Err(error) if url.path().ends_with(".json") => return Err(error),
            Err(_) => {}
        }
    }
    let html = String::from_utf8(metadata(url.as_str(), force)?).map_err(|_| catalog_error())?;
    let parent = base.join(".").map_err(|_| catalog_error())?;
    let mut candidates = Vec::new();
    for href in hrefs(&html) {
        let Ok(target) = base.join(&href) else {
            continue;
        };
        if target.origin() != base.origin()
            || !target.path().starts_with(parent.path())
            || target.query().is_some()
            || update_sources::source_url(target.as_str()).is_none()
        {
            continue;
        }
        let name = target.path_segments().and_then(|mut p| p.next_back()).unwrap_or("");
        if let Some(archive) = archive(kind, name, build) {
            candidates.push((archive, target));
        }
    }
    candidates.sort_by(|a, b| order(&a.0).cmp(&order(&b.0)));
    let Some((archive, target)) = candidates.pop() else {
        return Ok(None);
    };
    let mut sums = Vec::new();
    if kind == Kind::Apache {
        sums.push((format!("{target}.txt"), false));
    }
    sums.push((format!("{target}.sha256"), true));
    sums.push((parent.join("SHA256SUMS").map_err(|_| catalog_error())?.to_string(), false));
    let mut hash = None;
    for (url, plain) in sums {
        if let Ok(body) = metadata(&url, force)
            && let Ok(text) = String::from_utf8(body)
            && let Ok(sum) = checksum(&text, &archive.file, plain)
        {
            hash = Some(sum);
            break;
        }
    }
    let hash = hash.ok_or_else(|| CommandError::new("err.updateChecksumMissing"))?;
    let display = display(kind, &archive);
    Ok(Some(release(
        archive.version,
        display,
        target.to_string(),
        hash,
        archive.revision,
        archive.file,
        None,
    )))
}

fn checksum(text: &str, file: &str, plain: bool) -> Result<String, CommandError> {
    if let Ok(sum) = apache_checksum(text, file) {
        return Ok(sum);
    }
    let mut hashes = Vec::new();
    for line in text.lines().map(str::trim) {
        let parts: Vec<_> = line.split_whitespace().collect();
        match parts.as_slice() {
            [hash] if plain => {
                if let Ok(hash) = sha256(hash) {
                    hashes.push(hash);
                }
            }
            [hash, name] if name.trim_start_matches('*').trim_start_matches("./") == file => {
                hashes.push(sha256(hash)?);
            }
            _ => {}
        }
    }
    if hashes.len() != 1 {
        return Err(CommandError::new("err.updateChecksumMissing"));
    }
    Ok(hashes.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires HTTPS access to GitHub; checks metadata only, without downloading or running modules"]
    fn live_php_security_sources_offer_compatible_archives() {
        let body =
            metadata("https://api.github.com/repos/Jamalofski/php-eol-security/releases?per_page=100", true)
                .unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        for (version, toolchain) in [("7.4.33", "vc15"), ("8.0.30", "vs16"), ("8.1.34", "vs16")] {
            let build = Build { version: version.into(), arch: "x64".into(), toolchain: toolchain.into() };
            let release =
                github(Kind::Php, &entries, &build, "Jamalofski/php-eol-security").unwrap().unwrap();
            assert!(php::package_version(&release.version) > php::package_version(version));
            eprintln!("PHP {version}: {} ({toolchain}, x64, NTS, SHA-256)", release.version);
        }
    }
    fn build(version: &str) -> Build {
        Build { version: version.into(), arch: "x64".into(), toolchain: "vc15".into() }
    }
    fn asset(name: &str, tag: &str) -> serde_json::Value {
        serde_json::json!({"id":1,"name":name,"digest":format!("sha256:{}","a".repeat(64)),"size":1024,"browser_download_url":format!("https://github.com/team/php/releases/download/{tag}/{name}")})
    }
    #[test]
    fn php_security_releases_keep_branch_nts_architecture_and_compiler() {
        let tag = "php-7.4.33-pl2";
        let entries = [serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[
            asset("php-7.4.33-pl2-nts-Win32-vc15-x64.zip",tag),
            asset("php-7.4.33-pl2-Win32-vc15-x64.zip",tag),
            asset("php-7.4.33-pl2-nts-Win32-vc15-x86.zip",tag),
            asset("php-8.1.34-pl2-nts-Win32-vs16-x64.zip",tag)
        ]})];
        let selected = github(Kind::Php, &entries, &build("7.4.33"), "team/php").unwrap().unwrap();
        assert_eq!(selected.version, "7.4.33-pl2");
        assert!(selected.url.ends_with("-nts-Win32-vc15-x64.zip"));
        assert!(github(Kind::Php, &entries, &build("8.0.30"), "team/php").unwrap().is_none());
        assert!(github(Kind::Php, &entries, &build("7.4.33"), "other/php").is_err());
        let mut prerelease = entries[0].clone();
        prerelease["prerelease"] = true.into();
        assert!(github(Kind::Php, &[prerelease], &build("7.4.33"), "team/php").unwrap().is_none());
    }
    #[test]
    fn custom_web_catalogs_accept_only_compatible_windows_archives() {
        assert!(archive(Kind::Caddy, "caddy_2.11.1_windows_amd64.zip", &build("2.10.2")).is_some());
        assert!(archive(Kind::Caddy, "caddy_2.11.1_linux_amd64.tar.gz", &build("2.10.2")).is_none());
        assert!(archive(Kind::Nginx, "nginx-1.29.6.zip", &build("1.29.4")).is_some());
        assert!(archive(Kind::Nginx, "nginx-1.30.0.zip", &build("1.29.4")).is_none());
        assert!(archive(Kind::Apache, "httpd-2.4.69-261002-Win64-VS18.zip", &build("2.4.68")).is_some());
    }
    #[test]
    fn sidecar_checksums_are_bound_to_the_selected_archive() {
        let hash = "a".repeat(64);
        assert_eq!(checksum(&format!("{hash} *nginx-1.29.6.zip"), "nginx-1.29.6.zip", false).unwrap(), hash);
        assert!(checksum(&format!("{hash} other.zip"), "nginx-1.29.6.zip", false).is_err());
        assert!(checksum(&hash, "nginx-1.29.6.zip", false).is_err());
        assert_eq!(checksum(&hash, "nginx-1.29.6.zip", true).unwrap(), hash);
    }
}
