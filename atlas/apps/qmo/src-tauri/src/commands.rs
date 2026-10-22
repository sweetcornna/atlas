// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The commands web content can invoke.
//!
//! The six `qmo_*` commands are the hub's (qmo-app.md §5.2): they reach the
//! hub's origin through the remote capability `shell::grant` adds, and read
//! their arguments from the raw body through `ipc.rs`. The `local_*` commands
//! are the shell's own pages' (`capabilities/local.json`), never the hub's.
//! Nothing else — no file system, shell or HTTP plugin — is exposed.

use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::InvokeBody, AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;

use crate::{
    ipc,
    settings::normalize_shortcut,
    shell::{self, Phase, Problem, Shell, SignOutReport, MAIN},
    text::Lang,
};

/// The body of a call, as JSON; a raw body is not something these take.
fn body(request: &tauri::ipc::Request<'_>) -> Result<Value, String> {
    match request.body() {
        InvokeBody::Json(value) => Ok(value.clone()),
        InvokeBody::Raw(_) => Err("arguments must be JSON".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    platform: &'static str,
    version: String,
    quick_shortcut: String,
}

#[tauri::command]
pub fn qmo_shell_info(
    request: tauri::ipc::Request<'_>,
    shell: tauri::State<'_, Shell>,
) -> Result<ShellInfo, String> {
    ipc::no_arguments(&body(&request)?).map_err(|e| e.to_string())?;
    Ok(ShellInfo {
        platform: shell.platform,
        version: shell.version.clone(),
        quick_shortcut: shell.settings().quick_shortcut,
    })
}

/// A system notification, only while the main window is not in front.
/// Returns whether one was shown.
#[tauri::command]
pub fn qmo_notify(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let notify = ipc::notify(&body(&request)?).map_err(|e| e.to_string())?;
    let in_front = app
        .get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if in_front {
        return Ok(false);
    }
    let id = app.state::<Shell>().remember_notification(notify.session);
    let mut builder = app.notification().builder().id(id).title(notify.title);
    if let Some(text) = notify.body {
        builder = builder.body(text);
    }
    builder.show().map_err(|e| e.to_string())?;
    Ok(true)
}

/// The dock or taskbar badge; 0 clears it.
#[tauri::command]
pub fn qmo_badge(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let count = ipc::badge(&body(&request)?).map_err(|e| e.to_string())?;
    set_badge(&app, count);
    Ok(())
}

#[cfg(not(windows))]
fn set_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_badge_count((count > 0).then_some(count as i64));
    }
}

/// Windows has no badge count; the taskbar button gets a dot instead.
#[cfg(windows)]
fn set_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_overlay_icon((count > 0).then(crate::icons::badge_dot));
    }
}

#[tauri::command]
pub fn qmo_open_session(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let session = ipc::open_session(&body(&request)?).map_err(|e| e.to_string())?;
    shell::open_session(&app, &session);
    Ok(())
}

#[tauri::command]
pub fn qmo_quick_hide(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    ipc::no_arguments(&body(&request)?).map_err(|e| e.to_string())?;
    shell::hide_quick(&app);
    Ok(())
}

#[tauri::command]
pub async fn qmo_sign_out(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<SignOutReport, String> {
    ipc::no_arguments(&body(&request)?).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || shell::sign_out(&app))
        .await
        .map_err(|e| e.to_string())
}

// ---- the local pages ----------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    lang: Lang,
    platform: &'static str,
    version: String,
    phase: Phase,
    hub: Option<String>,
    device_name: Option<String>,
    problem: Option<Problem>,
    notice: Option<String>,
}

#[tauri::command]
pub fn local_state(shell: tauri::State<'_, Shell>) -> LocalState {
    let settings = shell.settings();
    LocalState {
        lang: shell.lang,
        platform: shell.platform,
        version: shell.version.clone(),
        phase: shell.phase(),
        hub: shell.hub().map(|h| h.base().to_string()).or(settings.hub),
        device_name: settings.device_name,
        problem: shell.problem(),
        notice: shell.take_notice(),
    }
}

#[tauri::command]
pub async fn local_sign_in(app: AppHandle, hub: String, code: String) -> Result<(), Problem> {
    if hub.len() > 2048 || code.len() > 256 {
        return Err(Problem {
            kind: crate::qmo::ErrorKind::Usage,
            message: "too long".into(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || shell::sign_in(&app, &hub, &code))
        .await
        .map_err(|e| Problem {
            kind: crate::qmo::ErrorKind::Broken,
            message: e.to_string(),
        })?
}

#[tauri::command]
pub fn local_retry(app: AppHandle) {
    shell::retry(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    lang: Lang,
    platform: &'static str,
    version: String,
    hub: Option<String>,
    device_name: Option<String>,
    quick_shortcut: String,
    default_shortcut: &'static str,
    keep_in_background: bool,
    autostart: bool,
    signed_in: bool,
}

#[tauri::command]
pub fn local_settings(app: AppHandle, shell: tauri::State<'_, Shell>) -> SettingsView {
    let settings = shell.settings();
    SettingsView {
        lang: shell.lang,
        platform: shell.platform,
        version: shell.version.clone(),
        hub: settings.hub,
        device_name: settings.device_name,
        quick_shortcut: settings.quick_shortcut,
        default_shortcut: crate::settings::default_shortcut(),
        keep_in_background: settings.keep_in_background,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        signed_in: shell.is_signed_in(),
    }
}

/// Swap the quick entry shortcut; the old one stays when the new one cannot
/// be registered (another app holds it). Fails with `invalid` or `taken`.
#[tauri::command]
pub fn local_set_shortcut(
    app: AppHandle,
    shell: tauri::State<'_, Shell>,
    shortcut: String,
) -> Result<String, String> {
    let next = normalize_shortcut(&shortcut).map_err(|_| "invalid".to_string())?;
    let current = shell.settings().quick_shortcut;
    if next == current {
        return Ok(next);
    }
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister(current.as_str());
    if let Err(e) = shortcuts.register(next.as_str()) {
        eprintln!("qmo: shortcut {next} not registered: {e}");
        let _ = shortcuts.register(current.as_str());
        return Err("taken".to_string());
    }
    shell.update_settings(|s| s.quick_shortcut = next.clone());
    Ok(next)
}

#[tauri::command]
pub fn local_set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_set_keep_in_background(shell: tauri::State<'_, Shell>, enabled: bool) -> bool {
    shell
        .update_settings(|s| s.keep_in_background = enabled)
        .keep_in_background
}

#[tauri::command]
pub async fn local_sign_out(app: AppHandle) -> Result<SignOutReport, String> {
    tauri::async_runtime::spawn_blocking(move || shell::sign_out(&app))
        .await
        .map_err(|e| e.to_string())
}

/// The few places a local page links to.
#[tauri::command]
pub fn local_open(app: AppHandle, target: String) -> Result<(), String> {
    match target.as_str() {
        "about" => shell::open_about(&app),
        "settings" => shell::open_settings(&app),
        "hub" => shell::open_hub_in_browser(&app),
        "app" => shell::show_app(&app),
        _ => return Err("unknown target".into()),
    }
    Ok(())
}

/// The settings and about windows close themselves from their page.
#[tauri::command]
pub fn local_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}
