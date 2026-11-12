//! Application-level integration: tray icon, Windows autostart, user info, UI zoom.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use crate::error::{CommandError, spawn_failed};
use crate::locales::locale_key_string;
use crate::paths::{hidden_command, is_valid_lang};
use crate::settings::SettingsStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserInfo {
    name: String,
}

// The autostart value name in HKCU\...\Run.
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "OSPControl";

// Registry processes may be slow (for example under antivirus scanning). Never wait
// for them on Tauri's event loop, which also handles input and the folder dialog.
async fn autostart_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| CommandError::new("err.autostartWriteFailed"))?
}

#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<(), CommandError> {
    autostart_task(move || write_autostart(enabled)).await
}

fn write_autostart(enabled: bool) -> Result<(), CommandError> {
    let exe = std::env::current_exe()?;
    let value = format!("\"{}\"", exe.display());
    // A missing entry being deleted is normal; an error only matters when we failed
    // to write the enabled autostart.
    let status = if enabled {
        hidden_command("reg")
            .args(["add", AUTOSTART_KEY, "/v", AUTOSTART_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])
            .status()
    } else {
        hidden_command("reg").args(["delete", AUTOSTART_KEY, "/v", AUTOSTART_VALUE, "/f"]).status()
    }
    .map_err(spawn_failed)?;

    if !status.success() && enabled {
        return Err(CommandError::new("err.autostartWriteFailed"));
    }
    Ok(())
}

#[tauri::command]
pub async fn autostart_enabled() -> Result<bool, CommandError> {
    autostart_task(|| {
        let out = hidden_command("reg")
            .args(["query", AUTOSTART_KEY, "/v", AUTOSTART_VALUE])
            .output()
            .map_err(spawn_failed)?;
        Ok(out.status.success())
    })
    .await
}

// Windows user name for the sidebar card; taken from the process environment,
// no arguments — no user input involved.
#[tauri::command]
pub fn get_user_info() -> UserInfo {
    let name = std::env::var("USERNAME")
        .or_else(|_| {
            std::env::var("USERPROFILE").map(|profile| {
                Path::new(&profile)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
        })
        .unwrap_or_default();
    UserInfo { name }
}

#[tauri::command]
pub fn set_ui_zoom(window: tauri::WebviewWindow, zoom: f64) -> Result<(), CommandError> {
    window.set_zoom(zoom.clamp(0.8, 1.3)).map_err(|_| CommandError::new("err.zoomFailed"))
}

// --- Minimize to tray instead of closing ---
// Portable settings are read before the frontend because CloseRequested needs this flag.

const TRAY_ID: &str = "main-tray";

// The "minimize to tray instead of closing" flag — shared by commands and window events.
pub(crate) struct TrayState {
    pub(crate) close_to_tray: AtomicBool,
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Creates the tray icon with labels from the selected language's dictionary. An existing
// icon is recreated — that way the labels update on language change. The tooltip is the
// product name, it is not translated: taken from the productName of tauri.conf.json
// (the package name is built from it at compile time too).
fn ensure_tray(app: &tauri::AppHandle, lang: &str) -> Result<(), CommandError> {
    let tray_failed = || CommandError::new("err.trayFailed");
    let icon = app.default_window_icon().cloned().ok_or_else(tray_failed)?;
    let show_item = MenuItem::with_id(app, "show", locale_key_string(lang, "tray.show"), true, None::<&str>)
        .map_err(|_| tray_failed())?;
    let create_item = MenuItem::with_id(
        app,
        "create_project",
        locale_key_string(lang, "tray.createProject"),
        true,
        None::<&str>,
    )
    .map_err(|_| tray_failed())?;
    let quit_item = MenuItem::with_id(app, "quit", locale_key_string(lang, "tray.quit"), true, None::<&str>)
        .map_err(|_| tray_failed())?;
    // Native separator before the destructive "quit" entry so it does not sit
    // directly against the other actions.
    let separator = PredefinedMenuItem::separator(app).map_err(|_| tray_failed())?;
    let menu = Menu::with_items(app, &[&show_item, &create_item, &separator, &quit_item])
        .map_err(|_| tray_failed())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(app.package_info().name.clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            // Creating a project happens in the UI, so bring the window up and
            // let the frontend switch to the projects page and open its dialog.
            "create_project" => {
                show_main_window(app);
                let _ = app.emit("tray-create-project", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // A left click shows the window; the menu is available via the right button.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|_| tray_failed())?;
    Ok(())
}

pub(crate) fn set_tray(app: &tauri::AppHandle, enabled: bool, lang: &str) -> Result<(), CommandError> {
    app.remove_tray_by_id(TRAY_ID);
    if enabled {
        ensure_tray(app, lang)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(
    app: tauri::AppHandle,
    enabled: bool,
    lang: Option<String>,
) -> Result<(), CommandError> {
    let lang = lang.filter(|code| is_valid_lang(code)).unwrap_or_else(|| "ru".into());
    let previous = app.state::<TrayState>().close_to_tray.load(Ordering::SeqCst);
    set_tray(&app, enabled, &lang)?;
    if let Err(error) = app.state::<SettingsStore>().save(
        [
            ("ospanel.closeToTray".into(), if enabled { "1" } else { "0" }.into()),
            ("ospanel.lang".into(), lang.clone()),
        ]
        .into(),
        false,
    ) {
        let _ = set_tray(&app, previous, &lang);
        return Err(error);
    }
    app.state::<TrayState>().close_to_tray.store(enabled, Ordering::SeqCst);

    Ok(())
}

#[tauri::command]
pub fn close_to_tray_enabled(app: tauri::AppHandle) -> bool {
    app.try_state::<TrayState>().map(|state| state.close_to_tray.load(Ordering::SeqCst)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_work_does_not_run_on_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker =
            tauri::async_runtime::block_on(autostart_task(|| Ok(std::thread::current().id()))).unwrap();
        assert_ne!(caller, worker);
    }

    #[test]
    fn autostart_work_preserves_results_and_errors() {
        assert!(tauri::async_runtime::block_on(autostart_task(|| Ok(true))).unwrap());
        assert!(!tauri::async_runtime::block_on(autostart_task(|| Ok(false))).unwrap());
        let error = tauri::async_runtime::block_on(autostart_task(|| {
            Err::<bool, _>(CommandError::new("err.spawnFailed"))
        }))
        .unwrap_err();
        assert_eq!(error.code, "err.spawnFailed");
    }
}
