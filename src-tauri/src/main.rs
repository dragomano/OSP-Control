#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod app_update_handoff;
mod app_updates;
mod backups;
mod db;
mod error;
mod locales;
mod menu;
mod module_health;
mod module_releases;
mod module_updates;
mod panel_api;
mod paths;
mod php_releases;
mod projects;
mod services;
mod shell;
mod update_files;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WindowEvent};

use app::{TrayState, read_app_settings, set_tray};

fn main() {
    if app_updates::early_mode() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The window title comes from productName in tauri.conf.json (via
            // package_info), so the product name does not have to be duplicated in
            // the window config: the title field is deliberately omitted there.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&app.package_info().name);
            }

            // The tray icon is needed right at startup if the setting was enabled.
            let settings = read_app_settings(app.handle());
            app.manage(TrayState { close_to_tray: AtomicBool::new(settings.close_to_tray) });
            if settings.close_to_tray {
                let lang = if settings.lang.is_empty() { "ru".to_string() } else { settings.lang };
                if let Err(error) = set_tray(app.handle(), true, &lang) {
                    eprintln!("tray init failed: {}", error.code);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // With the setting enabled, the close button hides the window to the tray instead of exiting.
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            if app.state::<TrayState>().close_to_tray.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            shell::list_editors,
            shell::open_in_editor,
            services::restart_ospanel,
            shell::read_config,
            shell::list_configs,
            menu::read_menu,
            menu::write_menu,
            shell::open_in_browser,
            shell::open_folder,
            shell::open_panel_folder,
            backups::open_backups_folder,
            shell::open_file,
            locales::read_locale,
            locales::list_locales,
            shell::list_log_sources,
            shell::read_log_tail,
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
