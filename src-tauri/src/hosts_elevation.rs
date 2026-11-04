//! One-shot elevation over an authenticated local pipe. No shell commands or staging files.

use super::{HostsSaveResult, MAX_BYTES};
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, sync::Mutex};

const FLAG: &str = "--hosts-helper";
const PIPE_PREFIX: &str = r"\\.\pipe\OSPControl.Hosts.";
const MAX_WIRE: usize = 8 * MAX_BYTES;
static ELEVATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Save { content: String, expected_revision: String },
    FlushDns {},
}

#[derive(Debug, Deserialize, Serialize)]
enum Reply {
    Saved(HostsSaveResult),
    DnsFlushed,
}

fn failed() -> CommandError {
    CommandError::new("err.hostsElevation")
}
fn valid_pipe(name: &str) -> bool {
    name.strip_prefix(PIPE_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(|c| c.is_ascii_hexdigit()))
}

fn helper_args(args: &[OsString]) -> Result<(&str, u32), CommandError> {
    if args.len() != 3 || args[0] != FLAG {
        return Err(failed());
    }
    let name = args[1].to_str().filter(|name| valid_pipe(name)).ok_or_else(failed)?;
    let pid = args[2]
        .to_str()
        .and_then(|pid| {
            if pid.is_empty() || !pid.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            pid.parse::<u32>().ok().filter(|pid| *pid > 0)
        })
        .ok_or_else(failed)?;
    Ok((name, pid))
}

fn validate_request(request: &Request) -> Result<(), CommandError> {
    if let Request::Save { content, expected_revision } = request {
        if content.len() > MAX_BYTES {
            return Err(CommandError::new("err.hostsTooLarge"));
        }
        if expected_revision.len() != 64 || !expected_revision.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(failed());
        }
        super::validate(content)?;
    }
    Ok(())
}

// The elevated side accepts exactly two operations, both with fixed system targets.
fn execute(request: Request) -> Result<Reply, CommandError> {
    validate_request(&request)?;
    match request {
        Request::Save { content, expected_revision } => {
            let mut saved = super::save_at(&super::system_directory()?, &content, &expected_revision)?;
            saved.dns_flushed = super::flush_dns().is_ok();
            Ok(Reply::Saved(saved))
        }
        Request::FlushDns {} => {
            super::flush_dns()?;
            Ok(Reply::DnsFlushed)
        }
    }
}

fn send(request: Request) -> Result<Reply, CommandError> {
    validate_request(&request)?;
    #[cfg(windows)]
    {
        if platform::is_elevated()? {
            return execute(request);
        }
        // Avoid prompting for invalid or already-stale drafts. Check again in the helper after UAC.
        if let Request::Save { expected_revision, .. } = &request {
            let path = super::checked_path(&super::system_directory()?)?;
            if super::revision(&super::bytes(&path)?) != *expected_revision {
                return Err(CommandError::new("err.hostsConflict"));
            }
        }
        platform::request(request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        Err(CommandError::new("err.hostsPlatform"))
    }
}

pub(super) fn save(content: String, expected_revision: String) -> Result<HostsSaveResult, CommandError> {
    let _guard = ELEVATION_LOCK.try_lock().map_err(|_| CommandError::new("err.hostsBusy"))?;
    match send(Request::Save { content, expected_revision })? {
        Reply::Saved(saved) => Ok(saved),
        _ => Err(failed()),
    }
}

pub(super) fn flush() -> Result<(), CommandError> {
    let _guard = ELEVATION_LOCK.try_lock().map_err(|_| CommandError::new("err.hostsBusy"))?;
    match send(Request::FlushDns {})? {
        Reply::DnsFlushed => Ok(()),
        _ => Err(failed()),
    }
}

pub(crate) fn early_mode() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|arg| arg != FLAG) {
        return false;
    }
    let result = helper_args(&args).and_then(|(name, parent)| {
        #[cfg(windows)]
        {
            platform::helper(name, parent)
        }
        #[cfg(not(windows))]
        {
            let _ = (name, parent);
            Err(CommandError::new("err.hostsPlatform"))
        }
    });
    if let Err(error) = result {
        eprintln!("{}", error.code);
    }
    // Even malformed helper arguments must never reach the GUI or single-instance plugin.
    true
}

#[cfg(windows)]
mod platform {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::{
        fs,
        mem::size_of,
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::PathBuf,
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{
            Foundation::{
                ERROR_CANCELLED, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL, LocalFree,
            },
            Security::{
                Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
                Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
                GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY,
                TokenElevation,
            },
            Storage::FileSystem::{
                CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE,
                OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
                WriteFile,
            },
            System::{
                Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
                IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED},
                Pipes::{
                    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
                    GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_TYPE_BYTE, PIPE_WAIT,
                },
                Threading::{
                    CreateEventW, GetCurrentProcess, GetProcessId, OpenProcess, OpenProcessToken,
                    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
                },
            },
            UI::{
                Shell::{
                    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                    ShellExecuteExW,
                },
                WindowsAndMessaging::SW_HIDE,
            },
        },
        core::{PCWSTR, PWSTR, w},
    };

    fn raw(handle: &OwnedHandle) -> HANDLE {
        HANDLE(handle.as_raw_handle())
    }
    fn own(handle: HANDLE) -> Result<OwnedHandle, CommandError> {
        if handle.is_invalid() {
            return Err(failed());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
    }
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }
    fn win_code(error: &windows::core::Error) -> u32 {
        error.code().0 as u32 & 0xffff
    }

    pub(super) fn is_elevated() -> Result<bool, CommandError> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(|_| failed())?;
        let token = own(token)?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        unsafe {
            GetTokenInformation(
                raw(&token),
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        }
        .map_err(|_| failed())?;
        Ok(elevation.TokenIsElevated != 0)
    }

    fn new_name() -> Result<String, CommandError> {
        let mut nonce = [0u8; 32];
        unsafe { BCryptGenRandom(None, &mut nonce, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
            .ok()
            .map_err(|_| failed())?;
        Ok(format!("{PIPE_PREFIX}{}", nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
    }

    fn server(name: &str) -> Result<OwnedHandle, CommandError> {
        if !valid_pipe(name) {
            return Err(failed());
        }
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // Only the creator/owner, elevated administrators and SYSTEM can open the pipe.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                w!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)"),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|_| failed())?;
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let name = wide(std::ffi::OsStr::new(name));
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                Some(&security),
            )
        };
        unsafe {
            LocalFree(Some(HLOCAL(descriptor.0)));
        }
        own(handle)
    }

    fn client(name: &str) -> Result<OwnedHandle, CommandError> {
        if !valid_pipe(name) {
            return Err(failed());
        }
        let name = wide(std::ffi::OsStr::new(name));
        // Identification-only prevents a non-elevated pipe server from impersonating this admin token.
        own(unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                0x8000_0000 | 0x4000_0000,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            )
        }
        .map_err(|_| failed())?)
    }

    fn same_image(pid: u32) -> Result<(), CommandError> {
        let process =
            own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .map_err(|_| failed())?)?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                raw(&process),
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .map_err(|_| failed())?;
        let image = fs::canonicalize(PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
            .map_err(|_| failed())?;
        let own_image =
            fs::canonicalize(std::env::current_exe().map_err(|_| failed())?).map_err(|_| failed())?;
        if image != own_image {
            return Err(failed());
        }
        Ok(())
    }

    fn authenticate(pipe: &OwnedHandle, pid: u32, server_side: bool) -> Result<(), CommandError> {
        let mut peer = 0;
        unsafe {
            if server_side {
                GetNamedPipeClientProcessId(raw(pipe), &mut peer)
            } else {
                GetNamedPipeServerProcessId(raw(pipe), &mut peer)
            }
        }
        .map_err(|_| failed())?;
        if peer != pid {
            return Err(failed());
        }
        same_image(peer)
    }

    fn complete(
        pipe: &OwnedHandle,
        overlapped: &mut OVERLAPPED,
        result: windows::core::Result<()>,
        count: u32,
        deadline: Instant,
    ) -> Result<usize, CommandError> {
        match result {
            Ok(()) => Ok(count as usize),
            Err(error) if win_code(&error) == ERROR_IO_PENDING.0 => {
                let mut count = 0;
                let timeout =
                    deadline.saturating_duration_since(Instant::now()).as_millis().min(u32::MAX as u128)
                        as u32;
                let result =
                    unsafe { GetOverlappedResultEx(raw(pipe), overlapped, &mut count, timeout, false) };
                if result.is_err() {
                    // Drain cancellation before stack-owned OVERLAPPED and buffers are released.
                    unsafe {
                        let _ = CancelIoEx(raw(pipe), Some(overlapped));
                        let _ = GetOverlappedResult(raw(pipe), overlapped, &mut count, true);
                    }
                    return Err(CommandError::new("err.hostsHelperTimeout"));
                }
                Ok(count as usize)
            }
            Err(_) => Err(failed()),
        }
    }

    fn event() -> Result<OwnedHandle, CommandError> {
        own(unsafe { CreateEventW(None, true, false, None) }.map_err(|_| failed())?)
    }
    fn connect(pipe: &OwnedHandle, deadline: Instant) -> Result<(), CommandError> {
        let event = event()?;
        let mut overlapped = OVERLAPPED { hEvent: raw(&event), ..Default::default() };
        let result = unsafe { ConnectNamedPipe(raw(pipe), Some(&mut overlapped)) };
        if result.as_ref().is_err_and(|error| win_code(error) == ERROR_PIPE_CONNECTED.0) {
            return Ok(());
        }
        complete(pipe, &mut overlapped, result, 0, deadline).map(|_| ())
    }

    fn transfer(
        pipe: &OwnedHandle,
        bytes: &mut [u8],
        writing: bool,
        deadline: Instant,
    ) -> Result<(), CommandError> {
        let mut position = 0;
        while position < bytes.len() {
            if Instant::now() >= deadline {
                return Err(CommandError::new("err.hostsHelperTimeout"));
            }
            let event = event()?;
            let mut overlapped = OVERLAPPED { hEvent: raw(&event), ..Default::default() };
            let end = (position + 65536).min(bytes.len());
            let mut count = 0;
            let result = unsafe {
                if writing {
                    WriteFile(raw(pipe), Some(&bytes[position..end]), Some(&mut count), Some(&mut overlapped))
                } else {
                    ReadFile(
                        raw(pipe),
                        Some(&mut bytes[position..end]),
                        Some(&mut count),
                        Some(&mut overlapped),
                    )
                }
            };
            let done = complete(pipe, &mut overlapped, result, count, deadline)?;
            if done == 0 {
                return Err(failed());
            }
            position += done;
        }
        Ok(())
    }

    fn write_frame(
        pipe: &OwnedHandle,
        value: &impl Serialize,
        deadline: Instant,
    ) -> Result<(), CommandError> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| failed())?;
        if bytes.is_empty() || bytes.len() > MAX_WIRE {
            return Err(failed());
        }
        transfer(pipe, &mut (bytes.len() as u32).to_le_bytes(), true, deadline)?;
        transfer(pipe, &mut bytes, true, deadline)
    }
    fn read_frame<T: DeserializeOwned>(pipe: &OwnedHandle, deadline: Instant) -> Result<T, CommandError> {
        let mut length = [0u8; 4];
        transfer(pipe, &mut length, false, deadline)?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_WIRE {
            return Err(failed());
        }
        let mut bytes = vec![0u8; length];
        transfer(pipe, &mut bytes, false, deadline)?;
        serde_json::from_slice(&bytes).map_err(|_| failed())
    }

    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    fn launch_error(error: windows::core::Error) -> CommandError {
        if win_code(&error) == ERROR_CANCELLED.0 {
            CommandError::new("err.hostsElevationCancelled")
        } else {
            failed()
        }
    }
    fn launch(name: &str) -> Result<OwnedHandle, CommandError> {
        if !valid_pipe(name) {
            return Err(failed());
        }
        let _com =
            Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok());
        let executable = std::env::current_exe().map_err(|_| failed())?;
        let executable = wide(executable.as_os_str());
        // The generated pipe identifier and PID are the only command-line data; neither contains shell text.
        let parameters = wide(std::ffi::OsStr::new(&format!("{FLAG} {name} {}", std::process::id())));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(executable.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(launch_error)?;
        own(info.hProcess)
    }

    pub(super) fn request(request: Request) -> Result<Reply, CommandError> {
        let name = new_name()?;
        let pipe = server(&name)?;
        let child = launch(&name)?;
        let pid = unsafe { GetProcessId(raw(&child)) };
        if pid == 0 {
            return Err(failed());
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        connect(&pipe, deadline)?;
        authenticate(&pipe, pid, true)?;
        write_frame(&pipe, &request, deadline)?;
        read_frame::<Result<Reply, CommandError>>(&pipe, deadline)?
    }

    pub(super) fn helper(name: &str, parent: u32) -> Result<(), CommandError> {
        if !is_elevated()? {
            return Err(CommandError::new("err.hostsPermission"));
        }
        let pipe = client(name)?;
        authenticate(&pipe, parent, false)?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let request: Request = read_frame(&pipe, deadline)?;
        let reply = execute(request);
        write_frame(&pipe, &reply, deadline)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn reads_the_current_token_and_distinguishes_uac_cancellation_from_launch_errors() {
            assert!(is_elevated().is_ok());
            let canceled =
                windows::core::Error::from_hresult(windows::core::HRESULT::from_win32(ERROR_CANCELLED.0));
            assert_eq!(launch_error(canceled).code, "err.hostsElevationCancelled");
            let denied = windows::core::Error::from_hresult(windows::core::HRESULT::from_win32(5));
            assert_eq!(launch_error(denied).code, "err.hostsElevation");
        }
        #[test]
        fn local_pipe_transfers_large_drafts_and_structured_errors_without_elevation() {
            let name = new_name().unwrap();
            let pipe = server(&name).unwrap();
            let client_name = name.clone();
            let text = "# Unicode \u{0414}\n".repeat(15000);
            let next = text.clone();
            let worker = std::thread::spawn(move || {
                let connection = client(&client_name).unwrap();
                authenticate(&connection, std::process::id(), false).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                let request: Request = read_frame(&connection, deadline).unwrap();
                assert!(matches!(request, Request::Save { content, .. } if content == next));
                let reply: Result<Reply, CommandError> =
                    Err(CommandError::new("err.hostsConflict").with("detail", "kept"));
                write_frame(&connection, &reply, deadline).unwrap();
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            connect(&pipe, deadline).unwrap();
            authenticate(&pipe, std::process::id(), true).unwrap();
            assert!(server(&name).is_err());
            assert!(authenticate(&pipe, 0, true).is_err());
            write_frame(&pipe, &Request::Save { content: text, expected_revision: "a".repeat(64) }, deadline)
                .unwrap();
            let reply: Result<Reply, CommandError> = read_frame(&pipe, deadline).unwrap();
            assert_eq!(reply.unwrap_err().code, "err.hostsConflict");
            worker.join().unwrap();
        }
        #[test]
        fn pipe_wait_is_bounded_and_canceled_safely() {
            let pipe = server(&new_name().unwrap()).unwrap();
            let start = Instant::now();
            assert_eq!(
                connect(&pipe, start + Duration::from_millis(30)).unwrap_err().code,
                "err.hostsHelperTimeout"
            );
            assert!(start.elapsed() < Duration::from_secs(2));
        }
        #[test]
        fn oversized_frame_is_rejected_before_allocation() {
            let name = new_name().unwrap();
            let pipe = server(&name).unwrap();
            let worker = std::thread::spawn(move || {
                let connection = client(&name).unwrap();
                transfer(
                    &connection,
                    &mut (MAX_WIRE as u32 + 1).to_le_bytes(),
                    true,
                    Instant::now() + Duration::from_secs(2),
                )
                .unwrap();
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            connect(&pipe, deadline).unwrap();
            assert!(read_frame::<Request>(&pipe, deadline).is_err());
            worker.join().unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_arguments_and_operation_schema_have_no_path_or_command_escape() {
        let pipe = format!("{PIPE_PREFIX}{}", "a".repeat(64));
        let args: Vec<OsString> = [FLAG, &pipe, "123"].into_iter().map(Into::into).collect();
        assert_eq!(helper_args(&args).unwrap(), (pipe.as_str(), 123));
        for bad in [
            r"C:\Windows\hosts",
            r"\\other\pipe\name",
            &format!("{pipe}\" & whoami"),
            &format!("{PIPE_PREFIX}abc"),
        ] {
            let mut args = args.clone();
            args[1] = bad.into();
            assert!(helper_args(&args).is_err());
        }
        let mut extra = args.clone();
        extra.push("extra".into());
        assert!(helper_args(&extra).is_err());
        for json in [
            r#"{"operation":"flushDns","path":"C:/anything"}"#,
            r#"{"operation":"run","command":"whoami"}"#,
            r#"{"operation":"save","content":"x","expected_revision":"a","path":"C:/anything"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(json).is_err());
        }
    }
    #[test]
    fn invalid_requests_fail_before_any_elevation_or_file_access() {
        for (content, revision, code) in [
            ("127.0.0.1 site.local".into(), "wrong".into(), "err.hostsElevation"),
            ("999.0.0.1 site.local".into(), "a".repeat(64), "err.hostsIp"),
            ("#".repeat(MAX_BYTES + 1), "a".repeat(64), "err.hostsTooLarge"),
        ] {
            assert_eq!(
                validate_request(&Request::Save { content, expected_revision: revision }).unwrap_err().code,
                code
            );
        }
        let error: CommandError = serde_json::from_str(r#"{"code":"err.hostsElevationCancelled"}"#).unwrap();
        assert!(error.params.is_empty());
    }
}
