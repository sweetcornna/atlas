// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The commands web content can invoke.
//!
//! The twenty-four `qmo_*` commands are the hub's (qmo-app.md §5.2): they
//! reach the hub's origin through the remote capability `shell::grant` adds,
//! and read their arguments from the raw body through `ipc.rs`; the three
//! added for P37.13 also check that the calling page is on the hub's origin,
//! and the fifteen `qmo_local_*` of local sessions (P37.14a, P37.14d) that it
//! is the main window's. The `local_*` commands are the shell's own pages'
//! (`capabilities/local.json`), never the hub's; so are seven `qmo_local_*`
//! of a session that exists, for the shell's own Code page when the hub is
//! out of reach (P37.16, `shell::OFFLINE_COMMANDS`). Nothing else — no file
//! system, shell, dialog or HTTP plugin — is exposed.

use std::str::FromStr;

use serde::Serialize;
use serde_json::{value::RawValue, Value};
use tauri::{
    ipc::{InvokeBody, JavaScriptChannelId},
    AppHandle, Manager, Runtime,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;

use crate::{
    agents::Agents,
    attention::Attention,
    code::{self, Code, Refusal},
    ipc,
    layout::Plan,
    settings::normalize_shortcut,
    shell::{self, Opened, Phase, Problem, Shell, SignOutReport, MAIN},
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
    let id = app
        .state::<Shell>()
        .remember_notification(notify.session.map(Opened::Chat));
    let mut builder = app.notification().builder().id(id).title(notify.title);
    if let Some(text) = notify.body {
        builder = builder.body(text);
    }
    builder.show().map_err(|e| e.to_string())?;
    Ok(true)
}

/// The dock or taskbar badge: the page's count, and the local sessions
/// waiting for an answer (`attention.rs`); 0 clears it.
#[tauri::command]
pub fn qmo_badge(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let count = ipc::badge(&body(&request)?).map_err(|e| e.to_string())?;
    app.state::<Attention>().set_page(count);
    crate::attention::draw_badge(&app);
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn set_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_badge_count((count > 0).then_some(count as i64));
    }
}

/// Windows has no badge count; the taskbar button gets a dot instead.
#[cfg(windows)]
pub(crate) fn set_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
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

/// The calling page is on the signed-in hub's origin (`ipc::from_hub`).
fn from_hub(shell: &Shell, webview: &tauri::Webview) -> Result<(), String> {
    let page = webview.url().ok();
    ipc::from_hub(page.as_ref(), shell.hub().as_ref()).map_err(|e| e.to_string())
}

/// The coding agents on this computer, as `qmo agents --json [--rescan]`
/// lists them (qmo-local.md §4.2): `{agents: [...]}`. One run at a time; a
/// call during a run gets that run's answer (`agents.rs`). At most 30 s.
#[tauri::command]
pub async fn qmo_local_agents(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    from_hub(&app.state::<Shell>(), &webview)?;
    let rescan = ipc::local_agents(&body(&request)?).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || app.state::<Agents>().scan(rescan))
        .await
        .map_err(|e| e.to_string())?
}

/// The page's side panel and colours, for the skeleton next time
/// (qmo-local.md §3.5).
#[tauri::command]
pub fn qmo_boot_layout(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    from_hub(&app.state::<Shell>(), &webview)?;
    let reported = ipc::boot_layout(&body(&request)?).map_err(|e| e.to_string())?;
    shell::remember_layout(&app, reported);
    Ok(())
}

/// The shell's own settings window, from the page's settings card. Async: a
/// window made from a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn qmo_open_local_settings(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    from_hub(&app.state::<Shell>(), &webview)?;
    ipc::no_arguments(&body(&request)?).map_err(|e| e.to_string())?;
    shell::open_settings(&app);
    Ok(())
}

// ---- local sessions (qmo-local.md §4.5) -----------------------------------

/// A `qmo_local_*` call that only the hub's page makes — a new session, a
/// folder, the changes, renaming, deleting, Remote: from the hub's page in
/// the main window, with a JSON body. Failures read
/// `qmo local <code>: <message>`.
fn local_body(
    app: &AppHandle,
    webview: &tauri::Webview,
    request: &tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let shell = app.state::<Shell>();
    let page = webview.url().ok();
    ipc::local_caller(page.as_ref(), shell.hub().as_ref(), webview.label())
        .and_then(|()| match request.body() {
            InvokeBody::Json(value) => Ok(value.clone()),
            InvokeBody::Raw(_) => Err(ipc::Invalid("arguments must be JSON".into())),
        })
        .map_err(|e| Refusal::from(e).to_string())
}

/// The calls of a session that exists (`shell::OFFLINE_COMMANDS`): from the
/// hub's page or the shell's own Code page (P37.16), in the main window.
fn session_body(
    app: &AppHandle,
    webview: &tauri::Webview,
    request: &tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let shell = app.state::<Shell>();
    let page = webview.url().ok();
    ipc::session_caller(page.as_ref(), shell.hub().as_ref(), webview.label())
        .and_then(|()| match request.body() {
            InvokeBody::Json(value) => Ok(value.clone()),
            InvokeBody::Raw(_) => Err(ipc::Invalid("arguments must be JSON".into())),
        })
        .map_err(|e| Refusal::from(e).to_string())
}

fn checked<T>(checked: Result<T, ipc::Invalid>) -> Result<T, String> {
    checked.map_err(|e| Refusal::from(e).to_string())
}

/// Pass a checked call to the runner, on a worker: it may have to be
/// started first, and the answer may take a while.
async fn forward(app: AppHandle, call: ipc::Call) -> Result<Box<RawValue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Code>().runner.call(call.method, call.params)
    })
    .await
    .map_err(|e| Refusal::new("E_RUNNER", e.to_string()).to_string())?
    .map_err(|refusal| refusal.to_string())
}

/// `{v, features, folders, sessions, defaults}`: what the runner can drive
/// and what it has, and what new sessions start with (the shell's settings,
/// `defaults: {mode, remote}`). The first call starts it.
#[tauri::command]
pub async fn qmo_local_list(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_list(&session_body(&app, &webview, &request)?))?;
    let defaults = app.state::<Shell>().settings().code;
    let answer = forward(app, call).await?;
    Ok(code::with_defaults(answer, &defaults.mode, defaults.remote))
}

/// Register the page's event channel, replacing the one before. The channel
/// sends to the page that made this call, in order.
#[tauri::command]
pub async fn qmo_local_watch(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let channel = checked(ipc::local_watch(&session_body(&app, &webview, &request)?))?;
    let id = JavaScriptChannelId::from_str(&channel)
        .map_err(|e| Refusal::new("E_ARGS", e).to_string())?;
    app.state::<Code>()
        .runner
        .watcher()
        .watch(id.channel_on(webview));
    Ok(Value::Object(Default::default()))
}

/// The system's folder picker, then the runner's `folders.add` with the
/// folder's real path: the only way a path gets in (§4.5.3). `null` when the
/// picker was cancelled.
#[tauri::command]
pub async fn qmo_local_pick_folder(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<Box<RawValue>>, String> {
    checked(ipc::no_arguments(&local_body(&app, &webview, &request)?))?;
    tauri::async_runtime::spawn_blocking(move || pick_folder(&app))
        .await
        .map_err(|e| Refusal::new("E_RUNNER", e.to_string()).to_string())?
        .map_err(|refusal| refusal.to_string())
}

/// Blocking: the picker waits for the person.
fn pick_folder(app: &AppHandle) -> Result<Option<Box<RawValue>>, Refusal> {
    let code = app.state::<Code>();
    let _open = code.picker.open()?;
    let mut dialog = app.dialog().file().set_can_create_directories(true);
    if let Some(main) = app.get_webview_window(MAIN) {
        dialog = dialog.set_parent(&main);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| Refusal::new("E_FOLDER", "选中的不是这台电脑上的文件夹"))?;
    let path = code::picked_folder(&path)?;
    code.runner
        .call("folders.add", serde_json::json!({ "path": path }))
        .map(Some)
}

#[tauri::command]
pub async fn qmo_local_forget_folder(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_forget_folder(&local_body(
        &app, &webview, &request,
    )?))?;
    forward(app, call).await
}

/// A new session is its first message: `{session, turn}`.
#[tauri::command]
pub async fn qmo_local_start(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_start(&local_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

/// `{turn, queued}`.
#[tauri::command]
pub async fn qmo_local_send(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_send(&session_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

#[tauri::command]
pub async fn qmo_local_stop(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_stop(&session_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

#[tauri::command]
pub async fn qmo_local_answer(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_answer(&session_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

/// `{mode, applies: 'now' | 'next-turn'}`.
#[tauri::command]
pub async fn qmo_local_set_mode(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_set_mode(&session_body(
        &app, &webview, &request,
    )?))?;
    forward(app, call).await
}

/// `{session, records, more, lastSeq, live?}`, newest first.
#[tauri::command]
pub async fn qmo_local_read(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_read(&session_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

#[tauri::command]
pub async fn qmo_local_changes(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_changes(&local_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

#[tauri::command]
pub async fn qmo_local_diff(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_diff(&local_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

/// `{}`: a new title; the runner says it to the page as a `session` event.
#[tauri::command]
pub async fn qmo_local_rename(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_rename(&local_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

/// `{}`, `{worktree: 'removed'}` or `{worktree: 'kept', path}`: the session
/// stopped and gone, its worktree removed when clean (qmo-local.md §4.3.7).
#[tauri::command]
pub async fn qmo_local_delete(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_delete(&local_body(&app, &webview, &request)?))?;
    forward(app, call).await
}

/// Remote on or off for a session (P37.15): `{session}`, the runner's
/// summary after it; the runner turns `on` down when this computer is not
/// signed in.
#[tauri::command]
pub async fn qmo_local_set_remote(
    app: AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
) -> Result<Box<RawValue>, String> {
    let call = checked(ipc::local_set_remote(&local_body(
        &app, &webview, &request,
    )?))?;
    forward(app, call).await
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
    /// New local sessions' permission mode and Remote.
    code_mode: String,
    code_remote: bool,
    /// Whether the runner can do Remote: `null` before it first came up.
    code_remote_open: Option<bool>,
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
        code_mode: settings.code.mode,
        code_remote: settings.code.remote,
        code_remote_open: app.state::<Code>().runner.remote_supported(),
    }
}

/// New local sessions' permission mode: one of the four; fails with
/// `invalid`.
#[tauri::command]
pub fn local_set_code_mode(shell: tauri::State<'_, Shell>, mode: String) -> Result<String, String> {
    if !ipc::MODES.contains(&mode.as_str()) {
        return Err("invalid".into());
    }
    Ok(shell.update_settings(|s| s.code.mode = mode).code.mode)
}

/// Whether new local sessions start with Remote on.
#[tauri::command]
pub fn local_set_code_remote(shell: tauri::State<'_, Shell>, enabled: bool) -> bool {
    shell
        .update_settings(|s| s.code.remote = enabled)
        .code
        .remote
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
        "code" => shell::open_offline_code(&app),
        _ => return Err("unknown target".into()),
    }
    Ok(())
}

/// From the shell's own Code page: try the hub again without leaving it
/// (P37.16). In, the main window goes to the hub's `/code`, on `session`
/// when given; still out of reach, the page stays and gets the reason.
#[tauri::command]
pub async fn local_reconnect(
    app: AppHandle,
    webview: tauri::Webview,
    session: Option<String>,
) -> Result<(), Problem> {
    let page = webview.url().ok();
    if webview.label() != MAIN || !page.as_ref().is_some_and(ipc::is_offline_code) {
        return Err(Problem {
            kind: crate::qmo::ErrorKind::Usage,
            message: "only the shell's Code page reconnects".into(),
        });
    }
    if session
        .as_deref()
        .is_some_and(|id| !ipc::valid_local_session(id))
    {
        return Err(Problem {
            kind: crate::qmo::ErrorKind::Usage,
            message: "session must be cs_ and 22 more".into(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || shell::reconnect(&app, session))
        .await
        .map_err(|e| Problem {
            kind: crate::qmo::ErrorKind::Broken,
            message: e.to_string(),
        })?
}

/// The settings and about windows close themselves from their page.
#[tauri::command]
pub fn local_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/// What the skeleton page draws: the hub page's last layout and colours, as
/// they are now (the copy the window was made with may be older).
#[tauri::command]
pub fn local_boot(shell: tauri::State<'_, Shell>) -> Plan {
    shell.skeleton_plan()
}
