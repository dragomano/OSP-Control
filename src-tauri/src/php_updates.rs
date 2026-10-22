//! PHP update coordinator. Only the selected module and its OSPanel metadata are changed.
use std::{fs, path::{Path, PathBuf}, sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use crate::{error::CommandError, paths::{hidden_command, resolve_installation}, php_files as files, php_releases as releases};
struct UpdateLocks {
    gate: RwLock<()>,
    modules: Mutex<Vec<PathBuf>>,
}
impl UpdateLocks {
    const fn new() -> Self {
        Self { gate: RwLock::new(()), modules: Mutex::new(Vec::new()) }
    }
    fn mutation(&self) -> Result<RwLockWriteGuard<'_, ()>, CommandError> {
        self.gate.try_write().map_err(|_| CommandError::new("err.phpBusy"))
    }
    fn module(&self, path: &Path) -> Result<ModuleGuard<'_>, CommandError> {
        let shared = self.gate.try_read().map_err(|_| CommandError::new("err.phpBusy"))?;
        let path = fs::canonicalize(path)?;
        let mut modules = self.modules.lock().map_err(|_| CommandError::new("err.phpBusy"))?;
        if modules.contains(&path) { return Err(CommandError::new("err.phpBusy")); }
        modules.push(path.clone());
        Ok(ModuleGuard { locks: self, path, _shared: shared })
    }
}
struct ModuleGuard<'a> {
    locks: &'a UpdateLocks,
    path: PathBuf,
    _shared: RwLockReadGuard<'a, ()>,
}
impl Drop for ModuleGuard<'_> {
    fn drop(&mut self) {
        self.locks.modules.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != &self.path);
    }
}
static MUTATION: UpdateLocks = UpdateLocks::new();
pub(crate) fn mutation() -> Result<RwLockWriteGuard<'static, ()>, CommandError> {
    MUTATION.mutation()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct UpdateInfo {
    name: String, installed: String, available: Option<String>, error: Option<String>, recovery: bool,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    error_params: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Journal {
    name: String, backup: String, was_running: bool, phase: String,
    #[serde(default)]
    manifest: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Progress { name: String, phase: String }
fn root(custom: Option<&str>) -> Result<PathBuf,CommandError> {
    if custom.is_some_and(|p|!Path::new(p).is_dir()) {return Err(CommandError::new("err.ospanelNotFound"));}
    let root=fs::canonicalize(resolve_installation(custom)?)?;
    let modules=fs::canonicalize(root.join("modules"))?;
    if modules.parent()!=Some(root.as_path()) {return Err(CommandError::new("err.accessDenied"));}
    Ok(root)
}
fn work(root:&Path)->Result<PathBuf,CommandError>{
    let mut parent=root.to_path_buf();
    for name in ["backups", "php-updates"] {
        let path=parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => {},
            Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(e.into()),
        }
        // Other modules may be writing their own staging/backup trees here.
        // Validate only this shared directory; validate each owned tree before using it.
        let meta=fs::symlink_metadata(&path)?;
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {return Err(CommandError::new("err.accessDenied"));}
        }
        if !meta.is_dir() || meta.file_type().is_symlink() {return Err(CommandError::new("err.accessDenied"));}
        let canonical=fs::canonicalize(&path)?;
        if canonical.parent()!=Some(parent.as_path()) {return Err(CommandError::new("err.accessDenied"));}
        parent=canonical;
    }
    Ok(parent)
}
fn journal_path(root:&Path,name:&str)->Result<PathBuf,CommandError>{
    let path=work(root)?.join(format!("{name}.json"));
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if !meta.is_file() {return Err(CommandError::new("err.accessDenied"));}
            files::safe_tree(&path)?;
        }
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(e.into()),
    }
    Ok(path)
}
fn save(root:&Path,j:&Journal)->Result<(),CommandError>{
    let p=journal_path(root,&j.name)?; let tmp=p.with_extension("tmp");
    let bytes=serde_json::to_vec(j).map_err(|_|releases::invalid())?;
    use std::io::Write;
    if tmp.exists(){fs::remove_file(&tmp)?;}
    let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?; f.write_all(&bytes)?; f.sync_all()?; drop(f);
    // Replace atomically on Windows; interruption must not erase the recovery journal.
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR,Win32::Storage::FileSystem::{MoveFileExW,MOVEFILE_REPLACE_EXISTING,MOVEFILE_WRITE_THROUGH}};
        let source:Vec<u16>=tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let target:Vec<u16>=p.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {MoveFileExW(PCWSTR(source.as_ptr()),PCWSTR(target.as_ptr()),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH).map_err(|_|CommandError::new("err.phpRecovery"))?;}
    }
    #[cfg(not(windows))] fs::rename(tmp,p)?;
    Ok(())
}
fn progress(app:&tauri::AppHandle,name:&str,value:&str){
    use tauri::Emitter;
    let _=app.emit("php-update-progress",Progress{name:name.into(),phase:value.into()});
}
fn phase(app:&tauri::AppHandle,root:&Path,j:&mut Journal,value:&str)->Result<(),CommandError>{
    j.phase=value.into(); save(root,j)?;
    progress(app,&j.name,value); Ok(())
}
fn failed(code:&str,cause:CommandError)->CommandError{
    let mut params=cause.params;
    params.insert("cause".into(),cause.code);
    CommandError{code:code.into(),params}
}
fn state(root:&Path,name:&str)->Result<bool,CommandError>{
    crate::panel_api::modules_from_api(root).into_iter().find(|s|s.name==name)
        .and_then(|s|match s.status.as_str(){"running"=>Some(true),"stopped"=>Some(false),_=>None})
        .ok_or_else(||CommandError::new("err.phpState"))
}
fn command(root:&Path,name:&str,on:bool)->Result<(),CommandError>{
    let mut child=hidden_command(root.join("bin/osp.bat")).args([if on{"on"}else{"off"},name])
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
    let deadline=Instant::now()+Duration::from_secs(30);
    loop { if let Some(status)=child.try_wait()? {if !status.success(){return Err(CommandError::new("err.phpState"));} break;}
        if Instant::now()>deadline {let _=child.kill();let _=child.wait();return Err(CommandError::new("err.phpState"));}
        std::thread::sleep(Duration::from_millis(100)); }
    let target=files::child(&root.join("modules"),name)?;
    let deadline=Instant::now()+Duration::from_secs(30);
    while Instant::now()<deadline {
        if state(root,name).ok()==Some(on) && processes(&target)?==on {return Ok(());}
        std::thread::sleep(Duration::from_millis(400));
    }
    Err(CommandError::new("err.phpState"))
}
#[cfg(windows)]
fn processes(dir:&Path)->Result<bool,CommandError>{
    use windows::{core::PWSTR,Win32::{Foundation::CloseHandle,System::{ProcessStatus::EnumProcesses,Threading::{OpenProcess,QueryFullProcessImageNameW,PROCESS_NAME_WIN32,PROCESS_QUERY_LIMITED_INFORMATION}}}};
    let prefix=format!("{}\\",dir.to_string_lossy().trim_start_matches(r"\\?\").to_ascii_lowercase());
    let mut pids=vec![0u32;65536];let mut returned=0;
    unsafe {EnumProcesses(pids.as_mut_ptr(),(pids.len()*4) as u32,&mut returned).map_err(|_|CommandError::new("err.phpState"))?;}
    if returned as usize>=pids.len()*4 {return Err(CommandError::new("err.phpState"));}
    for pid in &pids[..returned as usize/4] {unsafe {
        let Ok(handle)=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,*pid) else {continue;};
        let mut buf=vec![0u16;32768];let mut len=buf.len() as u32;
        let ok=QueryFullProcessImageNameW(handle,PROCESS_NAME_WIN32,PWSTR(buf.as_mut_ptr()),&mut len).is_ok();let _=CloseHandle(handle);
        if ok && String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase().starts_with(&prefix){return Ok(true);}
    }} Ok(false)
}
#[cfg(not(windows))] fn processes(_: &Path)->Result<bool,CommandError>{Err(CommandError::new("err.desktopOnly"))}

#[tauri::command]
pub async fn check_php_updates(custom_path:Option<String>)->Result<Vec<UpdateInfo>,CommandError>{
    tauri::async_runtime::spawn_blocking(move||{
        let _guard=mutation()?;
        let root=root(custom_path.as_deref())?; let json=releases::catalog(); let mut out=Vec::new();
        for entry in fs::read_dir(root.join("modules"))? {
            let name=entry?.file_name().to_string_lossy().into_owned(); let Some(branch)=releases::branch(&name) else {continue;};
            let check=(||{let dir=files::child(&root.join("modules"),&name)?;let b=releases::identify(&dir)?;
                let catalog=json.as_ref().map_err(|e|CommandError { code: e.code.clone(), params: e.params.clone() })?;
                let release=releases::select(catalog,branch,&b)?;Ok::<_,CommandError>((b.version,release.map(|r|r.version)))})();
            let recovery=journal_path(&root,&name)?.exists();
            out.push(match check {
                Ok((installed,available))=>UpdateInfo{name,installed,available,error:None,recovery,error_params:Default::default()},
                Err(e)=>UpdateInfo{name,installed:String::new(),available:None,error:Some(e.code),recovery,error_params:e.params},
            });
        } Ok(out)
    }).await.map_err(|_|releases::invalid())?
}

fn rollback(root:&Path,dir:&Path,j:&Journal)->Result<(),CommandError>{
    let source=files::child(&work(root)?,&j.backup)?;
    files::validate_backup(&source,&j.manifest)?;
    command(root,&j.name,false)?;
    files::exact_restore(&source,dir)?;
    files::validate_backup(dir,&j.manifest)?;
    if j.was_running {
        let logs=crate::php_health::capture(root,&j.name)?;
        command(root,&j.name,true)?;
        crate::php_health::verify(root,&j.name,&logs)?;
    }
    fs::remove_file(journal_path(root,&j.name)?)?;Ok(())
}
#[tauri::command]
pub async fn install_php_update(app:tauri::AppHandle,name:String,expected:String,custom_path:Option<String>)->Result<String,CommandError>{
    tauri::async_runtime::spawn_blocking(move||{
        let family=releases::branch(&name).ok_or_else(releases::invalid)?.to_string();
        let root=root(custom_path.as_deref())?;
        let _guard=MUTATION.module(&root.join("modules").join(&name))?;
        let dir=files::child(&root.join("modules"),&name)?;
        if journal_path(&root,&name)?.exists(){return Err(CommandError::new("err.phpRecovery"));}
        progress(&app,&name,"preparing");
        let b=releases::identify(&dir)?;
        let release=releases::select(&releases::catalog()?,&family,&b)?.ok_or_else(releases::invalid)?;
        if release.version!=expected {return Err(CommandError::new("err.phpChanged"));}
        let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let backup=format!("{name}-{stamp}");let backup_dir=work(&root)?.join(&backup);
        let zip=work(&root)?.join(format!("{name}-{stamp}.zip"));
        let staging=work(&root)?.join(format!("stage-{name}-{stamp}"));
        let result=(||{
            // Network and archive failures must leave the running module untouched.
            progress(&app,&name,"download");
            releases::download(&release,&zip)?;
            files::extract(&zip,&staging)?;
            let fresh=releases::identify(&staging)?;
            if fresh.version!=release.version || fresh.arch!=b.arch || fresh.toolchain!=b.toolchain || !staging.join("php-cgi.exe").is_file(){return Err(releases::invalid());}
            let was_running=state(&root,&name)?;
            let mut j=Journal{name:name.clone(),backup,was_running,phase:"stopping".into(),manifest:Default::default()};
            phase(&app,&root,&mut j,"stopping")?;
            let mut changed=false;let mut backed_up=false;
            let result=(||{
                command(&root,&name,false)?;
                phase(&app,&root,&mut j,"backup")?;
                j.manifest=files::manifest(&dir)?;
                fs::create_dir(&backup_dir)?; files::overlay(&dir,&backup_dir)?;
                files::validate_backup(&backup_dir,&j.manifest)?; backed_up=true;
                phase(&app,&root,&mut j,"install")?; changed=true;files::overlay(&staging,&dir)?;
                files::update_metadata(&dir,&release.version)?;
                let logs=crate::php_health::capture(&root,&name)?;
                phase(&app,&root,&mut j,"verify")?;command(&root,&name,true)?;
                crate::php_health::verify(&root,&name,&logs)?;
                if releases::identify(&dir)?.version!=release.version {return Err(releases::invalid());}
                if !was_running {command(&root,&name,false)?;}
                fs::remove_file(journal_path(&root,&name)?)?;
                Ok(release.version.clone())
            })();
            if let Err(e)=result {
                let recovered=if changed && backed_up {let _=phase(&app,&root,&mut j,"rollback");rollback(&root,&dir,&j)}
                    else {if was_running {command(&root,&name,true)} else {command(&root,&name,false)}};
                if recovered.is_err(){return Err(failed("err.phpRollback",e));}
                let _=fs::remove_file(journal_path(&root,&name)?);
                return Err(failed("err.phpFailed",e));
            }
            result
        })();
        // Temporary downloads are never needed for recovery; the verified backup is retained.
        let _=fs::remove_file(&zip);let _=fs::remove_dir_all(&staging);
        result
    }).await.map_err(|_|releases::invalid())?
}
#[tauri::command]
pub async fn recover_php_update(name:String,custom_path:Option<String>)->Result<String,CommandError>{
    tauri::async_runtime::spawn_blocking(move||{
        releases::branch(&name).ok_or_else(releases::invalid)?;
        let root=root(custom_path.as_deref())?;
        let _guard=MUTATION.module(&root.join("modules").join(&name))?;
        let dir=files::child(&root.join("modules"),&name)?;
        let j:Journal=serde_json::from_slice(&fs::read(journal_path(&root,&name)?)?).map_err(|_|releases::invalid())?;
        if j.name!=name || !j.backup.starts_with(&format!("{name}-")) || !crate::paths::is_valid_module_name(&j.backup){return Err(releases::invalid());}
        if ["install","verify","rollback"].contains(&j.phase.as_str()){rollback(&root,&dir,&j)}else{
            command(&root,&name,j.was_running)?;fs::remove_file(journal_path(&root,&name)?)?;Ok(())
        }?;
        Ok(releases::identify(&dir)?.version)
    }).await.map_err(|_|releases::invalid())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_modules_can_update_while_duplicate_and_global_mutations_are_blocked() {
        let locks=UpdateLocks::new();
        let first=locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let second=locks.module(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path()).unwrap();
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
        assert!(locks.mutation().is_err());
        drop(first);
        assert!(locks.mutation().is_err());
        // Releasing one module does not release another module's lock.
        let first=locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        drop(second);
        assert!(locks.mutation().is_err());
        drop(first);
        let exclusive=locks.mutation().unwrap();
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
        drop(exclusive);
        assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_ok());
    }

    #[test]
    fn concurrent_threads_hold_independent_module_locks_and_release_them_on_error() {
        let locks=UpdateLocks::new();
        let barrier=std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker=scope.spawn(|| {
                let attempt=|| -> Result<(),CommandError> {
                    let _guard=locks.module(Path::new(env!("CARGO_MANIFEST_DIR")))?;
                    barrier.wait();
                    barrier.wait();
                    Err(CommandError::new("err.phpFailed"))
                };
                assert!(attempt().is_err());
            });
            let _guard=locks.module(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).unwrap();
            barrier.wait();
            assert!(locks.mutation().is_err());
            assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
            barrier.wait();
            worker.join().unwrap();
            assert!(locks.module(Path::new(env!("CARGO_MANIFEST_DIR"))).is_ok());
        });
        assert!(locks.mutation().is_ok());
    }

    #[test]
    fn concurrent_updates_create_the_shared_workspace_without_directory_races() {
        let temp=fs::canonicalize(std::env::temp_dir()).unwrap();
        let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root=temp.join(format!("osp-php-concurrent-{}-{stamp}",std::process::id()));
        fs::create_dir(&root).unwrap();
        let root=fs::canonicalize(root).unwrap();
        let barrier=std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for id in 0..4 {
                let root=&root;
                let barrier=&barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..20 {
                        let work=work(root).unwrap();
                        let staging=work.join(format!("stage-PHP-{id}"));
                        fs::create_dir(&staging).unwrap();
                        fs::write(staging.join("file"),b"module data").unwrap();
                        assert_eq!(fs::canonicalize(work).unwrap().parent(),Some(root.join("backups").as_path()));
                        fs::remove_file(staging.join("file")).unwrap();
                        fs::remove_dir(staging).unwrap();
                    }
                });
            }
        });
        assert_eq!(root.parent(),Some(temp.as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_failure_keeps_the_underlying_error_code_and_details() {
        for code in ["err.phpFailed", "err.phpRollback"] {
            let error = failed(code, CommandError::new("err.phpNetwork").with("detail", "Connection timed out"));
            assert_eq!(error.code, code);
            assert_eq!(error.params.get("cause").map(String::as_str), Some("err.phpNetwork"));
            assert_eq!(error.params.get("detail").map(String::as_str), Some("Connection timed out"));
        }
    }
}
