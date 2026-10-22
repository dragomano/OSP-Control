//! Health checks use only fresh module log bytes and the configured FastCGI endpoint.
use std::{collections::BTreeMap,fs,io::{Read,Seek,SeekFrom},net::{SocketAddr,TcpStream},path::{Path,PathBuf},time::Duration};
use crate::{error::CommandError,panel_api::{api_json,dat_node_map,dat_field,dat_string_value,active_profile_settings}};
pub(crate) type Logs=BTreeMap<PathBuf,(u64,Vec<u8>)>;
pub(crate) fn capture(root:&Path,name:&str)->Result<Logs,CommandError>{
    let dir=root.join("logs");let mut logs=BTreeMap::new();
    if !dir.is_dir(){return Ok(logs);}
    for entry in fs::read_dir(&dir)? {let path=entry?.path();
        let filename=path.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        if path.is_file() && filename.starts_with(&name.to_ascii_lowercase()) && filename.ends_with(".log") {
            let canonical=fs::canonicalize(&path)?;if !canonical.starts_with(fs::canonicalize(&dir)?){return Err(CommandError::new("err.accessDenied"));}
            let mut f=fs::File::open(&path)?;
            let size=f.metadata()?.len();
            logs.insert(path,(size,digest_prefix(&mut f,size)?));
        }
    }Ok(logs)
}
fn digest_prefix(file:&mut fs::File,size:u64)->Result<Vec<u8>,CommandError>{
    use sha2::{Digest,Sha256};
    file.seek(SeekFrom::Start(0))?;
    let mut input=file.take(size);let mut hash=Sha256::new();let mut buf=[0;65536];
    loop {let n=input.read(&mut buf)?;if n==0 {break;}hash.update(&buf[..n]);}
    Ok(hash.finalize().to_vec())
}
fn fresh_logs(root:&Path,name:&str,before:&Logs)->Result<(),CommandError>{
    for (path,(size,_)) in capture(root,name)? {
        let mut f=fs::File::open(&path)?;
        let offset=if let Some((old,hash))=before.get(&path) {
            if *old<=size && digest_prefix(&mut f,*old)?==*hash {*old} else {0}
        } else {0};
        if size-offset>1_000_000 {return Err(CommandError::new("err.phpHealth"));}
        f.seek(SeekFrom::Start(offset))?;let mut bytes=Vec::new();f.take(1_000_001).read_to_end(&mut bytes)?;
        if bytes.len()>1_000_000 || critical(&String::from_utf8_lossy(&bytes)){return Err(CommandError::new("err.phpHealth"));}
    }
    Ok(())
}
pub(crate) fn verify(root:&Path,name:&str,before:&Logs)->Result<(),CommandError>{
    std::thread::sleep(Duration::from_secs(3));
    let json=api_json(root,"/getmodules").ok_or_else(||CommandError::new("err.phpState"))?;
    let modules=dat_node_map(&json).ok_or_else(||CommandError::new("err.phpState"))?;
    let node=modules.get(name).ok_or_else(||CommandError::new("err.phpState"))?;
    let profile=dat_field(node,"profile").map(dat_string_value).unwrap_or_default();
    let settings=active_profile_settings(node,&profile).ok_or_else(||CommandError::new("err.phpState"))?;
    let port=dat_field(settings,"port").map(dat_string_value).and_then(|v|v.parse::<u16>().ok()).filter(|p|*p>0).ok_or_else(||CommandError::new("err.phpState"))?;
    let ip=dat_field(settings,"ip").map(dat_string_value).unwrap_or_default();
    let ip=if ip.is_empty()||ip=="auto" {"127.0.0.1"} else {&ip};
    let mut ip:std::net::IpAddr=ip.parse().map_err(|_|CommandError::new("err.phpState"))?;
    if ip.is_unspecified(){ip=if ip.is_ipv4(){std::net::Ipv4Addr::LOCALHOST.into()}else{std::net::Ipv6Addr::LOCALHOST.into()};}
    let addr=SocketAddr::new(ip,port);
    if !addr.ip().is_loopback() || TcpStream::connect_timeout(&addr,Duration::from_secs(2)).is_err(){return Err(CommandError::new("err.phpState"));}
    fresh_logs(root,name,before)?;
    if !crate::panel_api::modules_from_api(root).iter().any(|s|s.name==name && s.status=="running"){return Err(CommandError::new("err.phpState"));}Ok(())
}
fn critical(text:&str)->bool{let text=text.to_ascii_lowercase();["fatal", "unable to load dynamic library", "[error]", "[critical]", "ошибка", "сбой"].iter().any(|s|text.contains(s))}
#[cfg(test)] mod tests {
    use super::*;
    #[test]fn warnings_are_not_critical(){assert!(!critical("PHP Deprecated: old API"));assert!(critical("PHP Warning: Unable to load dynamic library"));}
    #[test]fn replaced_log_with_same_prefix_is_checked_from_start(){
        let root=std::env::temp_dir().join(format!("osp-php-logs-{}",std::process::id()));
        fs::create_dir_all(root.join("logs")).unwrap();
        let path=root.join("logs/PHP-8.4.log");
        let prefix="x".repeat(128);
        fs::write(&path,format!("{prefix}old fatal error\n")).unwrap();
        let before=capture(&root,"PHP-8.4").unwrap();
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"healthy startup\n").unwrap();
        fresh_logs(&root,"PHP-8.4",&before).unwrap();
        fs::write(&path,format!("{prefix}new fatal error\n{}","x".repeat(256))).unwrap();
        assert!(fresh_logs(&root,"PHP-8.4",&before).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
