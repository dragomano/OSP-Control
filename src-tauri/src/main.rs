#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod app_update_handoff;
mod app_updates;
mod backups;
mod db;
mod error;
mod hosts;
mod locales;
mod menu;
mod module_health;
mod module_releases;
mod module_updates;
mod panel_api;
mod paths;
mod php_releases;
mod project_activity;
mod projects;
mod services;
mod settings;
mod shell;
mod update_files;
mod update_sources;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size, WindowEvent};

use app::{TrayState, set_tray};
use settings::SettingsStore;

// Fraction of the primary monitor working area the window occupies on its first
// launch. The working area already excludes the taskbar and other reserved space.
const INITIAL_WINDOW_AREA_RATIO: f64 = 0.86;

// Natural layout width in logical pixels: 248px sidebar + 1190px content maximum
// (.content-wrap) + ~120px of breathing room so the centered content does not
// touch the window edges. Wider windows only add empty side space, so this caps
// the initial width even on ultrawide monitors.
const MAX_WINDOW_WIDTH_LOGICAL: f64 = 1560.0;

// On first launch the window is sized relative to the primary monitor's working
// area (which excludes the taskbar) and centered on it. Sizes and positions are
// physical pixels, so the result is correct regardless of the display scaling
// factor. The window config only provides fallback defaults for when no monitor
// can be queried.
fn size_window_to_work_area(window: &tauri::WebviewWindow) {
    let Some(monitor) = window.primary_monitor().ok().flatten() else {
        return;
    };
    let work = monitor.work_area();

    // Decorated-frame thickness. Measured from the default window so the outer
    // size can be kept inside the working area.
    let decoration = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => PhysicalSize::new(
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        _ => PhysicalSize::default(),
    };
    let scale = monitor.scale_factor();
    let mut target = PhysicalSize::new(
        (work.size.width as f64 * INITIAL_WINDOW_AREA_RATIO).round() as u32,
        (work.size.height as f64 * INITIAL_WINDOW_AREA_RATIO).round() as u32,
    );
    // Cap the width at the UI's natural layout width (scaled for this display).
    // Past this point the content is centered and further width only adds empty
    // space on the sides, which is pointless on wide monitors.
    let width_cap = (MAX_WINDOW_WIDTH_LOGICAL * scale).round() as u32;
    target.width = target.width.min(width_cap);
    // Never exceed the working area, so the taskbar and other reserved space stay
    // visible even on small screens.
    target.width = target.width.min(work.size.width.saturating_sub(decoration.width));
    target.height = target.height.min(work.size.height.saturating_sub(decoration.height));

    if let Err(error) = window.set_size(Size::Physical(target)) {
        eprintln!("initial window resize failed: {error}");
        return;
    }
    center_window(window);
}

// Centers the window on the primary monitor's working area using its real outer
// size, so the decorated frame is accounted for.
fn center_window(window: &tauri::WebviewWindow) {
    let Some(monitor) = window.primary_monitor().ok().flatten() else {
        return;
    };
    let work = monitor.work_area();
    if let Ok(outer) = window.outer_size() {
        let center = PhysicalPosition::new(
            work.position.x + work.size.width as i32 / 2,
            work.position.y + work.size.height as i32 / 2,
        );
        let origin =
            PhysicalPosition::new(center.x - outer.width as i32 / 2, center.y - outer.height as i32 / 2);
        if let Err(error) = window.set_position(Position::Physical(origin)) {
            eprintln!("initial window centering failed: {error}");
        }
    }
}

#[derive(Clone, Copy)]
struct LogicalWindowSize {
    width: f64,
    height: f64,
}

// Window-geometry bookkeeping. The window is initially sized by the app; until the
// user resizes it nothing is persisted. Manual resizes are recorded here and written
// to settings.toml by a short debounced worker so dragging does not hammer the disk.
struct WindowGeometry {
    suppress_resize: AtomicBool,
    saver_waiting: AtomicBool,
    pending: Mutex<Option<LogicalWindowSize>>,
}

fn record_window_size(app: &tauri::AppHandle, window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    let geometry = app.state::<WindowGeometry>();
    if geometry.suppress_resize.load(Ordering::SeqCst) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    *geometry.pending.lock().unwrap() =
        Some(LogicalWindowSize { width: size.width as f64 / scale, height: size.height as f64 / scale });
    if !geometry.saver_waiting.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let geometry = app.state::<WindowGeometry>();
            geometry.saver_waiting.store(false, Ordering::SeqCst);
            let snapshot = *geometry.pending.lock().unwrap();
            if let Some(LogicalWindowSize { width, height }) = snapshot {
                let store = app.state::<SettingsStore>();
                let _ = store.save_window_size(width, height);
            }
        });
    }
}

fn flush_window_size(app: &tauri::AppHandle) {
    let geometry = app.state::<WindowGeometry>();
    if let Some(LogicalWindowSize { width, height }) = *geometry.pending.lock().unwrap() {
        let store = app.state::<SettingsStore>();
        let _ = store.save_window_size(width, height);
    }
}

fn main() {
    if hosts::early_mode() {
        return;
    }
    if app_updates::early_mode() {
        return;
    }
    tauri::Builder::default()
        // Register first so duplicate launches exit before other plugins and setup run.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The tray icon is needed right at startup if the setting was enabled.
            let store = SettingsStore::for_app(app.handle()).map_err(|e| std::io::Error::other(e.code))?;
            // Invalid settings are reported by the frontend; startup itself remains usable.
            let settings = store.load().ok().map(|s| s.values).unwrap_or_default();
            let close_to_tray = settings.get("ospanel.closeToTray").is_some_and(|v| v == "1");
            app.manage(store);
            app.manage(TrayState { close_to_tray: AtomicBool::new(close_to_tray) });
            // State for geometry bookkeeping must exist before the window fires its
            // initial resize events. It starts with resize recording suppressed.
            app.manage(WindowGeometry {
                suppress_resize: AtomicBool::new(true),
                saver_waiting: AtomicBool::new(false),
                pending: Mutex::new(None),
            });

            // The window title comes from productName in tauri.conf.json (via
            // package_info), so the product name does not have to be duplicated in
            // the window config: the title field is deliberately omitted there.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&app.package_info().name);
                // The window starts hidden; restore the saved size or choose a
                // sensible one for this display before showing so there is no
                // flash of the default-size window. Programmatic resizes are
                // still suppressed here, so they are never persisted.
                let saved_width = settings.get("ospanel.windowWidth").and_then(|s| s.parse::<f64>().ok());
                let saved_height = settings.get("ospanel.windowHeight").and_then(|s| s.parse::<f64>().ok());
                match (saved_width, saved_height) {
                    (Some(width), Some(height)) => {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let physical = PhysicalSize::new(
                            (width * scale).round() as u32,
                            (height * scale).round() as u32,
                        );
                        let _ = window.set_size(Size::Physical(physical));
                        center_window(&window);
                    }
                    _ => {
                        size_window_to_work_area(&window);
                    }
                }
                let _ = window.show();
                let _ = window.set_focus();
                app.state::<WindowGeometry>().suppress_resize.store(false, Ordering::SeqCst);
            }

            if close_to_tray {
                let lang = settings.get("ospanel.lang").map(String::as_str).unwrap_or("ru");
                if let Err(error) = set_tray(app.handle(), true, lang) {
                    app.state::<TrayState>().close_to_tray.store(false, Ordering::SeqCst);
                    eprintln!("tray init failed: {}", error.code);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                // With the setting enabled, the close button hides the window to the
                // tray instead of exiting. Either way the latest size is flushed
                // first so a quick close does not lose a recent manual resize.
                WindowEvent::CloseRequested { api, .. } => {
                    flush_window_size(&app);
                    if app.state::<TrayState>().close_to_tray.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // Remember manual resizes; the debounced background saver persists them.
                WindowEvent::Resized(size) => {
                    record_window_size(&app, window, *size);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            settings::migrate_settings,
            app_updates::check_app_update,
            app_updates::install_app_update,
            app_update_handoff::app_update_startup,
            module_updates::check_module_updates,
            module_updates::install_module_update,
            module_updates::recover_module_update,
            services::discover_ospanel,
            services::panel_online,
            services::overview_metrics,
            services::service_action,
            projects::project_module_options,
            projects::read_project_settings,
            projects::write_project_settings,
            projects::global_project_engines,
            projects::create_project,
            projects::delete_project,
            projects::rename_project,
            project_activity::project_activity,
            shell::list_editors,
            shell::open_in_editor,
            services::restart_ospanel,
            shell::read_config,
            shell::list_configs,
            menu::read_menu,
            hosts::read_hosts,
            hosts::write_hosts,
            hosts::flush_hosts_dns,
            menu::write_menu,
            menu::create_menu_backup,
            menu::restore_menu_backup,
            shell::open_in_browser,
            shell::open_folder,
            shell::open_panel_folder,
            backups::open_backups_folder,
            shell::open_file,
            locales::read_locale,
            locales::list_locales,
            shell::list_log_sources,
            shell::read_log_tail,
            shell::clear_logs,
            backups::list_backups,
            backups::create_backup,
            backups::restore_backup,
            backups::delete_backup,
            db::create_db_backup,
            db::restore_db_backup,
            backups::create_project_backup,
            backups::restore_project_backup,
            app::set_autostart,
            app::autostart_enabled,
            projects::autostart_from_projects,
            app::get_user_info,
            app::set_ui_zoom,
            app::set_close_to_tray,
            app::close_to_tray_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
