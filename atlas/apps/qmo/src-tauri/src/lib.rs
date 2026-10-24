// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! 阡陌 Qmo, the desktop app (docs/dev/qmo-app.md): a Tauri shell around the
//! hub's pages. The shell owns the windows, menus, tray, quick entry,
//! notifications and the way in; the pages are the hub's; the device token is
//! `qmo`'s alone.

mod agents;
mod commands;
mod deeplink;
mod hub;
mod icons;
mod ipc;
mod layout;
mod menu;
mod qmo;
mod settings;
mod shell;
mod sidecar;
mod text;

#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

use shell::{Shell, ABOUT, MAIN, QUICK, SETTINGS, SIGNIN};

/// The argument the login item starts the app with: no window until asked.
const HIDDEN_ARG: &str = "--hidden";

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => match window.label() {
            MAIN | SIGNIN => {
                if shell::keeps_running(app) {
                    api.prevent_close();
                    if window.is_fullscreen().unwrap_or(false) {
                        let _ = window.set_fullscreen(false);
                    }
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
            QUICK => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        },
        // Quick entry goes away as soon as the person looks elsewhere.
        WindowEvent::Focused(false) if window.label() == QUICK => {
            let _ = window.hide();
        }
        WindowEvent::ThemeChanged(theme)
            if [MAIN, SIGNIN, SETTINGS, ABOUT].contains(&window.label()) =>
        {
            let colour = shell::background(app, window.label(), *theme);
            let _ = window.set_background_color(Some(colour));
        }
        _ => {}
    }
}

fn follow_links(app: &tauri::AppHandle, urls: impl IntoIterator<Item = String>) {
    for url in urls {
        if let Some(link) = deeplink::parse(&url) {
            shell::follow(app, link);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hidden = std::env::args().any(|arg| arg == HIDDEN_ARG);
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell::show_app(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .with_denylist(&[QUICK, SIGNIN, SETTINGS, ABOUT])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        shell::toggle_quick(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::qmo_shell_info,
            commands::qmo_notify,
            commands::qmo_badge,
            commands::qmo_open_session,
            commands::qmo_quick_hide,
            commands::qmo_sign_out,
            commands::qmo_local_agents,
            commands::qmo_boot_layout,
            commands::qmo_open_local_settings,
            commands::local_state,
            commands::local_sign_in,
            commands::local_retry,
            commands::local_settings,
            commands::local_set_shortcut,
            commands::local_set_autostart,
            commands::local_set_keep_in_background,
            commands::local_sign_out,
            commands::local_open,
            commands::local_close,
            commands::local_boot,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            app.manage(Shell::new(
                text::system_lang(),
                app.package_info().version.to_string(),
                settings_path,
                hidden,
            ));
            app.manage(agents::Agents::default());

            #[cfg(target_os = "macos")]
            app.set_menu(menu::app_menu(&handle)?)?;
            // One listener for the menu bar and the tray menu alike: a tray's
            // own `on_menu_event` is global too, and two would run each item
            // twice (quick entry would open and close at once).
            app.on_menu_event(menu::on_menu);
            menu::tray(&handle)?;

            let shortcut = app.state::<Shell>().settings().quick_shortcut;
            if let Err(e) = app.global_shortcut().register(shortcut.as_str()) {
                eprintln!("qmo: shortcut {shortcut} not registered: {e}");
            }

            let tapped = handle.clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() != "tap" {
                    return;
                }
                let session = performed
                    .notification()
                    .and_then(|n| tapped.state::<Shell>().notification_session(n.id()));
                match session {
                    Some(id) => shell::open_session(&tapped, &id),
                    None => shell::show_app(&tapped),
                }
            })?;

            // macOS registers the scheme from the bundle; the others at run time.
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(e) = app.deep_link().register_all() {
                eprintln!("qmo: qmo:// not registered: {e}");
            }
            let linked = handle.clone();
            app.deep_link().on_open_url(move |event| {
                follow_links(&linked, event.urls().into_iter().map(|u| u.to_string()));
            });

            shell::start(&handle);
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                follow_links(&handle, urls.into_iter().map(|u| u.to_string()));
            }
            Ok(())
        })
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("the Qmo shell could not start");

    app.run(|_app, _event| {
        // The Dock icon clicked with no window open.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = _event {
            shell::show_app(_app);
        }
    });
}
