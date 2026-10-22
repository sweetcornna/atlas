// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell's state and its windows (qmo-app.md §2, §3, §6).
//!
//! | Window | Shows | Size |
//! | --- | --- | --- |
//! | `signin` | the local sign-in page | 600 × 600, fixed |
//! | `main` | the local skeleton, then the hub's `/app`; the offline page when the hub is out of reach | 1200 × 800, at least 600 × 400, remembered |
//! | `quick` | the hub's `/app/quick` on a transparent, frameless window | 606 × 470, hidden until the shortcut |
//! | `settings`, `about` | local pages | fixed |
//!
//! Getting in is `qmo session --json` (§3): the cookies it prints go into the
//! WebView's store, the hub's origin gets the six commands of §5.2 as a remote
//! capability, and the main window opens `/app`. A page that lands on the
//! hub's `/login` lost its session; the shell gets a new one and goes back.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{
    ipc::CapabilityBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, PhysicalPosition, Theme, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};
use tauri_plugin_opener::OpenerExt;

use crate::{
    deeplink::DeepLink,
    hub::{self, parse_hub, Hub, Navigation},
    qmo::{self, CookieAction, ErrorKind, Failure, Paired, Session, SignedOut},
    settings::Settings,
    sidecar,
    text::{text, Lang},
};

pub const MAIN: &str = "main";
pub const SIGNIN: &str = "signin";
pub const QUICK: &str = "quick";
pub const SETTINGS: &str = "settings";
pub const ABOUT: &str = "about";

/// What the hub's pages may call: the six commands of qmo-app.md §5.2, and
/// the two the window's own drag regions need (§5.1: the page marks its header
/// `data-tauri-drag-region`; a drag or a double-click there moves or zooms
/// this window and nothing else).
pub const HUB_PERMISSIONS: [&str; 8] = [
    "allow-qmo-shell-info",
    "allow-qmo-notify",
    "allow-qmo-badge",
    "allow-qmo-open-session",
    "allow-qmo-quick-hide",
    "allow-qmo-sign-out",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
];

/// The six commands the hub's pages may call (qmo-app.md §5.2).
#[cfg(test)]
const HUB_COMMANDS: [&str; 6] = [
    "qmo_shell_info",
    "qmo_notify",
    "qmo_badge",
    "qmo_open_session",
    "qmo_quick_hide",
    "qmo_sign_out",
];

/// Where the traffic lights sit on macOS: the close button's left edge 17 px
/// in, centred on the 48 px header row the pages draw. AppKit reads `y` as the
/// inset to the buttons' row, not their middle; 26 measured as centred on 24.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (17.0, 26.0);

/// The quick entry window: the card is drawn by the page, at the top of a
/// transparent window tall enough for four lines and the agent picker.
const QUICK_SIZE: (f64, f64) = (606.0, 470.0);

/// How long `qmo` may take: a session is three requests; a pairing one.
const QMO_TIMEOUT: Duration = Duration::from_secs(45);

/// Three trips to `/login` within this long and the shell stops trying.
const REENTRY_WINDOW: Duration = Duration::from_secs(60);
const REENTRY_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    SignedOut,
    Entering,
    Hub,
    Offline,
}

/// A failure as the local pages show it.
#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    pub kind: ErrorKind,
    pub message: String,
}

impl From<&Failure> for Problem {
    fn from(failure: &Failure) -> Problem {
        Problem {
            kind: failure.kind,
            message: failure.message.clone(),
        }
    }
}

struct State {
    settings: Settings,
    hub: Option<Hub>,
    /// The hub has no client tickets: its own `/login` is the way in.
    login_page: bool,
    phase: Phase,
    problem: Option<Problem>,
    /// One line the sign-in page shows once, such as how the last sign-out went.
    notice: Option<String>,
    entering: bool,
    /// Where to go once the current entry is done.
    pending: Option<String>,
    reentries: Vec<Instant>,
    /// Origins that have the remote capability already.
    granted: HashSet<String>,
    /// Notification id → conversation, for a click on the notification.
    notifications: HashMap<i32, String>,
    next_notification: i32,
    /// Started at login: no window until the person asks for one.
    hidden: bool,
    /// Told when the main window has finished loading `about:blank`.
    blank: Option<mpsc::Sender<()>>,
}

pub struct Shell {
    pub lang: Lang,
    pub platform: &'static str,
    pub version: String,
    settings_path: PathBuf,
    state: Mutex<State>,
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

impl Shell {
    pub fn new(lang: Lang, version: String, settings_path: PathBuf, hidden: bool) -> Shell {
        let settings = Settings::load(&settings_path);
        Shell {
            lang,
            platform: platform(),
            version,
            settings_path,
            state: Mutex::new(State {
                settings,
                hub: None,
                login_page: false,
                phase: Phase::Starting,
                problem: None,
                notice: None,
                entering: false,
                pending: None,
                reentries: Vec::new(),
                granted: HashSet::new(),
                notifications: HashMap::new(),
                next_notification: 1,
                hidden,
                blank: None,
            }),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut state)
    }

    pub fn settings(&self) -> Settings {
        self.with(|s| s.settings.clone())
    }

    /// Change the settings and write them; a write that fails is logged, not fatal.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let settings = self.with(|s| {
            f(&mut s.settings);
            s.settings.clone()
        });
        if let Err(e) = settings.save(&self.settings_path) {
            eprintln!("qmo: settings not saved: {e}");
        }
        settings
    }

    pub fn hub(&self) -> Option<Hub> {
        self.with(|s| s.hub.clone())
    }

    pub fn phase(&self) -> Phase {
        self.with(|s| s.phase)
    }

    pub fn problem(&self) -> Option<Problem> {
        self.with(|s| s.problem.clone())
    }

    pub fn take_notice(&self) -> Option<String> {
        self.with(|s| s.notice.take())
    }

    pub fn is_signed_in(&self) -> bool {
        self.with(|s| {
            matches!(s.phase, Phase::Hub | Phase::Entering | Phase::Offline) && s.hub.is_some()
        })
    }

    /// Remember a notification's conversation, for a click on it.
    pub fn remember_notification(&self, session: Option<String>) -> i32 {
        self.with(|s| {
            let id = s.next_notification;
            s.next_notification = s.next_notification.wrapping_add(1).max(1);
            if let Some(session) = session {
                if s.notifications.len() >= 200 {
                    s.notifications.clear();
                }
                s.notifications.insert(id, session);
            }
            id
        })
    }

    pub fn notification_session(&self, id: i32) -> Option<String> {
        self.with(|s| s.notifications.remove(&id))
    }

    fn reveal(&self) -> bool {
        self.with(|s| !s.hidden)
    }

    /// The person asked for a window: from here on windows show.
    fn unhide(&self) {
        self.with(|s| s.hidden = false)
    }
}

fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

/// Closing the main or sign-in window keeps the app in the tray: always on
/// macOS, where that is how apps behave, and by the setting elsewhere.
pub fn keeps_running(app: &AppHandle) -> bool {
    cfg!(target_os = "macos") || shell(app).settings().keep_in_background
}

/// The page colour, light or dark, so a window never flashes white.
pub fn page_background(theme: Theme) -> tauri::window::Color {
    match theme {
        Theme::Dark => tauri::window::Color(0x1a, 0x1a, 0x19, 0xff),
        _ => tauri::window::Color(0xf9, 0xf9, 0xf7, 0xff),
    }
}

fn init_script(platform: &str, window: &str, version: &str) -> String {
    let info = serde_json::json!({ "platform": platform, "window": window, "version": version });
    format!(
        "Object.defineProperty(window, '__QMO_SHELL__', {{ value: Object.freeze({info}), \
         writable: false, configurable: false, enumerable: false }});"
    )
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("qmo: could not open {url}: {e}");
        }
    }
}

/// The navigation rule of qmo-app.md §5.3, for `label`'s window.
fn on_navigation(app: &AppHandle, label: &str, url: &Url) -> bool {
    let (hub, login_page) = shell(app).with(|s| (s.hub.clone(), s.login_page));
    match hub::decide(url, hub.as_ref(), login_page) {
        Navigation::Allow => true,
        Navigation::External => {
            open_external(app, url);
            false
        }
        Navigation::Reenter { back } => {
            if label == QUICK {
                hide_quick(app);
            }
            enter(app, Some(back), true);
            false
        }
        Navigation::Deny => false,
    }
}

/// A page asking for a new window: the hub's own pages open in the main
/// window, anything else in the system browser.
fn on_new_window(app: &AppHandle, url: &Url) {
    let hub = shell(app).hub();
    match hub::decide(url, hub.as_ref(), false) {
        Navigation::Allow if hub.as_ref().is_some_and(|h| h.same_origin(url)) => {
            navigate_main(app, url.clone());
        }
        Navigation::External => open_external(app, url),
        Navigation::Reenter { back } => enter(app, Some(back), true),
        _ => {}
    }
}

fn guarded<'a>(
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
    app: &AppHandle,
    label: &'static str,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let nav_app = app.clone();
    let new_app = app.clone();
    let load_app = app.clone();
    builder
        .on_navigation(move |url| on_navigation(&nav_app, label, url))
        .on_new_window(move |url, _features| {
            on_new_window(&new_app, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished
                && label == MAIN
                && payload.url().as_str() == BLANK
            {
                if let Some(done) = shell(&load_app).with(|s| s.blank.take()) {
                    let _ = done.send(());
                }
                return;
            }
            // A server redirect the navigation hook did not see still lands
            // here; the hub's `/login` is the only page that matters.
            if payload.event() == PageLoadEvent::Started {
                let url = payload.url().clone();
                let (hub, login_page) = shell(&load_app).with(|s| (s.hub.clone(), s.login_page));
                if let Navigation::Reenter { back } = hub::decide(&url, hub.as_ref(), login_page) {
                    enter(&load_app, Some(back), true);
                }
            }
        })
}

/// A window with the platform's chrome: on macOS the title bar is drawn by
/// the page and the traffic lights sit in its 48 px header row.
fn chrome(
    builder: WebviewWindowBuilder<'_, Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHTS.0,
                TRAFFIC_LIGHTS.1,
            ))
            // The WebView draws no background of its own, so the window's
            // colour shows until the page paints.
            .transparent(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

/// Paint the window in the page colour of its current theme.
pub fn paint(window: &WebviewWindow) {
    let theme = window.theme().unwrap_or(Theme::Light);
    let _ = window.set_background_color(Some(page_background(theme)));
}

fn local_window(
    app: &AppHandle,
    label: &'static str,
    page: &str,
    title: &str,
    size: (f64, f64),
) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }
    let s = shell(app);
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(label != ABOUT)
        .center()
        .visible(false)
        .initialization_script(init_script(s.platform, "main", &s.version));
    let window = guarded(chrome(builder), app, label).build()?;
    paint(&window);
    Ok(window)
}

/// The main window, made on first use with the skeleton showing.
pub fn ensure_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(MAIN) {
        return Ok(window);
    }
    let s = shell(app);
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("skeleton.html".into()))
        .title(text(s.lang).app)
        .inner_size(1200.0, 800.0)
        .min_inner_size(600.0, 400.0)
        .center()
        .visible(false)
        .initialization_script(init_script(s.platform, "main", &s.version));
    let window = guarded(chrome(builder), app, MAIN).build()?;
    paint(&window);
    let zoom = s.settings().zoom;
    if (zoom - 1.0).abs() > 0.001 {
        let _ = window.set_zoom(zoom);
    }
    Ok(window)
}

fn show(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn hide(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}

/// Show the sign-in window, and nothing of the hub.
pub fn show_signin(app: &AppHandle) {
    hide(app, MAIN);
    hide(app, QUICK);
    let t = text(shell(app).lang);
    match local_window(app, SIGNIN, "index.html", t.sign_in_title, (600.0, 600.0)) {
        Ok(window) => {
            if shell(app).reveal() {
                show(&window);
            }
        }
        Err(e) => eprintln!("qmo: sign-in window: {e}"),
    }
}

/// Bring the app forward: the main window when signed in, else sign-in.
pub fn show_app(app: &AppHandle) {
    shell(app).unhide();
    if shell(app).is_signed_in() {
        match ensure_main(app) {
            Ok(window) => {
                hide(app, SIGNIN);
                show(&window);
            }
            Err(e) => eprintln!("qmo: main window: {e}"),
        }
    } else {
        show_signin(app);
    }
}

pub fn navigate_main(app: &AppHandle, url: Url) {
    match ensure_main(app) {
        Ok(window) => {
            if needs_blank_step(&window, &url) {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || load_in_main(&app, &window, url));
            } else if let Err(e) = window.navigate(url) {
                eprintln!("qmo: navigate: {e}");
            }
        }
        Err(e) => eprintln!("qmo: main window: {e}"),
    }
}

const BLANK: &str = "about:blank";

/// How long a step through `about:blank` may take before the shell goes on.
const BLANK_WAIT: Duration = Duration::from_secs(1);

/// WebKit leaves a `SameSite=Strict` cookie off a navigation that starts from
/// a page of another site, even one the shell starts itself: from one of the
/// shell's own pages (`tauri://localhost`) or another hub's, the hub would see
/// no session and send the window to `/login` for good. From a blank page the
/// cookie goes. WebView2 does not need the step; it costs nothing there.
fn needs_blank_step(window: &WebviewWindow, to: &Url) -> bool {
    window
        .url()
        .is_ok_and(|from| from.as_str() != BLANK && from.origin() != to.origin())
}

/// Load the hub's `url` in the main window, through `about:blank` when coming
/// from another origin; the blank page gets the skeleton written in, so the window
/// keeps its shape until the hub's page paints. Blocking: call from a worker.
fn load_in_main(app: &AppHandle, window: &WebviewWindow, url: Url) {
    if needs_blank_step(window, &url) {
        let (done, loaded) = mpsc::channel();
        shell(app).with(|s| s.blank = Some(done));
        if window
            .navigate(Url::parse(BLANK).expect("about:blank"))
            .is_ok()
            && loaded.recv_timeout(BLANK_WAIT).is_ok()
        {
            let _ = window.eval(skeleton_script());
        }
        shell(app).with(|s| s.blank = None);
    }
    if let Err(e) = window.navigate(url) {
        eprintln!("qmo: navigate: {e}");
    }
}

/// The skeleton page, with its style sheet inline, written into `about:blank`.
fn skeleton_script() -> &'static str {
    static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SCRIPT.get_or_init(|| {
        let page = include_str!("../../ui/skeleton.html").replace(
            r#"<link rel="stylesheet" href="app.css">"#,
            &format!("<style>{}</style>", include_str!("../../ui/app.css")),
        );
        let page = serde_json::to_string(&page).expect("a string");
        format!("document.open();document.write({page});document.close();")
    })
}

/// Show a local page in the main window: `offline.html` and the like.
fn show_local_in_main(app: &AppHandle, page: &str) {
    if let Ok(window) = ensure_main(app) {
        let url = window
            .url()
            .ok()
            .and_then(|current| current.join(&format!("/{page}")).ok())
            .filter(hub::is_local);
        let url = url.or_else(|| Url::parse(&format!("{}{page}", local_base())).ok());
        if let Some(url) = url {
            let _ = window.navigate(url);
        }
    }
}

/// Where Tauri serves the local pages on this platform.
fn local_base() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}

/// ⌘N, the tray and `qmo://new`: a new conversation in the main window.
pub fn new_chat(app: &AppHandle) {
    shell(app).unhide();
    match shell(app).hub() {
        Some(hub) if shell(app).phase() == Phase::Hub => {
            show_app(app);
            navigate_main(app, hub.app_url());
        }
        _ => show_app(app),
    }
}

/// `qmo_open_session`, a notification and `qmo://session/<id>`.
pub fn open_session(app: &AppHandle, id: &str) {
    shell(app).unhide();
    hide_quick(app);
    match shell(app).hub() {
        Some(hub) if hub::valid_session_id(id) && shell(app).phase() == Phase::Hub => {
            show_app(app);
            navigate_main(app, hub.session_url(id));
        }
        _ => show_app(app),
    }
}

/// A `qmo://` link: now when the hub is open, else once it is.
pub fn follow(app: &AppHandle, link: DeepLink) {
    let s = shell(app);
    s.unhide();
    if s.phase() == Phase::Hub {
        match link {
            DeepLink::New => new_chat(app),
            DeepLink::Session(id) => open_session(app, &id),
        }
        return;
    }
    let path = match link {
        DeepLink::New => "/app".to_string(),
        DeepLink::Session(id) => format!("/app?session={id}"),
    };
    s.with(|st| st.pending = Some(path));
    show_app(app);
}

pub fn hide_quick(app: &AppHandle) {
    hide(app, QUICK);
}

/// The quick entry window for `hub`, made once per hub and kept hidden. One
/// left over from another hub is made again rather than sent across: its first
/// load is the only one that carries the new hub's `SameSite=Strict` session.
fn ensure_quick(app: &AppHandle, hub: &Hub) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(QUICK) {
        if window.url().is_ok_and(|url| hub.same_origin(&url)) {
            return Ok(window);
        }
        window.destroy()?;
    }
    let s = shell(app);
    let builder = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::External(hub.quick_url()))
        .title(text(s.lang).quick_entry)
        .inner_size(QUICK_SIZE.0, QUICK_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible_on_all_workspaces(true)
        .visible(false)
        .initialization_script(init_script(s.platform, "quick", &s.version));
    guarded(builder, app, QUICK).build()
}

/// The global shortcut and the tray: show the quick entry window centred near
/// the top of the screen under the pointer, or hide it.
pub fn toggle_quick(app: &AppHandle) {
    let s = shell(app);
    let hub = s.hub();
    let Some(hub) = hub.filter(|_| s.phase() == Phase::Hub) else {
        show_app(app);
        return;
    };
    let window = match ensure_quick(app, &hub) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("qmo: quick entry: {e}");
            return;
        }
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    place_quick(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
}

fn place_quick(app: &AppHandle, window: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (QUICK_SIZE.0 * scale) as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    // The card sits in the upper third, as Spotlight's does.
    let y = area.position.y + (area.size.height as f64 * 0.22) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn grant(app: &AppHandle, hub: &Hub) {
    let origin = hub.origin();
    let fresh = shell(app).with(|s| s.granted.insert(origin.clone()));
    if !fresh {
        return;
    }
    let mut capability =
        CapabilityBuilder::new(format!("hub-{}", shell(app).with(|s| s.granted.len())))
            .remote(hub.remote_pattern())
            .local(false)
            .windows([MAIN, QUICK]);
    for permission in HUB_PERMISSIONS {
        capability = capability.permission(permission);
    }
    if let Err(e) = app.add_capability(capability) {
        eprintln!("qmo: hub capability: {e}");
        shell(app).with(|s| s.granted.remove(&origin));
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Put a session's cookies, and the shell's own, into the WebView's store.
fn set_cookies(
    window: &WebviewWindow,
    hub: &Hub,
    session: &Session,
    platform: &str,
) -> Result<(), Failure> {
    let now = now_seconds();
    for cookie in &session.cookies {
        let action = qmo::webview_cookie(cookie, hub, now)
            .map_err(|e| Failure::new(ErrorKind::Broken, e))?;
        let result = match action {
            CookieAction::Set(c) => window.set_cookie(c),
            CookieAction::Remove(c) => window.delete_cookie(c),
        };
        if let Err(e) = result {
            // The session cookie is the one that counts; the rest may fail
            // where a store refuses, say, a prefixed name.
            if cookie.name == qmo::SESSION_COOKIE {
                return Err(Failure::new(
                    ErrorKind::Broken,
                    format!("cookie store: {e}"),
                ));
            }
            eprintln!("qmo: cookie {} not set: {e}", cookie.name);
        }
    }
    let _ = window.set_cookie(qmo::shell_cookie(hub, platform));
    Ok(())
}

fn run_qmo<T: for<'de> serde::Deserialize<'de>>(
    args: &[&str],
    input: Option<&str>,
) -> Result<T, Failure> {
    match sidecar::run(args, input, QMO_TIMEOUT) {
        Ok(run) => qmo::parse_output(run.code, &run.stdout, &run.stderr),
        Err(e) => Err(Failure::new(
            ErrorKind::Broken,
            format!("qmo did not start: {e}"),
        )),
    }
}

/// How long a start without a remembered hub waits for `qmo` before it shows
/// the skeleton anyway.
const FIRST_PAINT: Duration = Duration::from_millis(800);

/// Startup: paint the window the last run ended in, then get in. With a hub
/// remembered the skeleton shows at once; without one, `qmo` answers first
/// (in milliseconds when it is not signed in), so a computer paired earlier
/// with the `qmo` command line goes straight in instead of to sign-in. A `qmo`
/// still busy after a moment (a hub slow to answer) gets the skeleton too.
pub fn start(app: &AppHandle) {
    let s = shell(app);
    let remembered = s.settings().hub.and_then(|h| parse_hub(&h).ok());
    if let Some(hub) = remembered {
        s.with(|st| st.hub = Some(hub));
        show_skeleton(app);
    } else {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_PAINT);
            let waiting = shell(&app).with(|st| st.entering && st.phase == Phase::Entering);
            if waiting && app.get_webview_window(MAIN).is_none() {
                show_skeleton(&app);
            }
        });
    }
    enter(app, None, false);
}

fn show_skeleton(app: &AppHandle) {
    if let Ok(window) = ensure_main(app) {
        if shell(app).reveal() {
            show(&window);
        }
    }
}

/// Open a session through `qmo` and show `/app` (or `back`), on a worker
/// thread. `reentry` marks a trip back from `/login`, which counts towards
/// the loop guard.
pub fn enter(app: &AppHandle, back: Option<String>, reentry: bool) {
    let s = shell(app);
    let go = s.with(|st| {
        if reentry {
            let now = Instant::now();
            st.reentries
                .retain(|at| now.duration_since(*at) < REENTRY_WINDOW);
            st.reentries.push(now);
        }
        if back.is_some() {
            st.pending = back.clone();
        }
        if st.entering {
            return false;
        }
        st.entering = true;
        if st.phase != Phase::Hub {
            st.phase = Phase::Entering;
        }
        true
    });
    if !go {
        return;
    }
    let looping = s.with(|st| st.reentries.len() > REENTRY_LIMIT);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = if looping {
            Err(Failure::new(
                ErrorKind::Loop,
                "the hub keeps asking to sign in",
            ))
        } else {
            run_qmo::<Session>(&["session", "--json"], None)
        };
        match outcome {
            Ok(session) => arrive(&app, session),
            Err(failure) => turned_away(&app, failure),
        }
        shell(&app).with(|st| st.entering = false);
    });
}

fn arrive(app: &AppHandle, session: Session) {
    let s = shell(app);
    let hub = match parse_hub(&session.hub) {
        Ok(hub) => hub,
        Err(e) => {
            return turned_away(
                app,
                Failure::new(ErrorKind::Broken, format!("hub address: {e}")),
            )
        }
    };
    let window = match ensure_main(app) {
        Ok(window) => window,
        Err(e) => return turned_away(app, Failure::new(ErrorKind::Broken, e.to_string())),
    };
    if let Err(failure) = set_cookies(&window, &hub, &session, s.platform) {
        return turned_away(app, failure);
    }
    grant(app, &hub);
    s.update_settings(|settings| {
        settings.hub = Some(hub.base().to_string());
        settings.device_name = Some(session.name.clone());
    });
    let back = s.with(|st| {
        st.hub = Some(hub.clone());
        st.login_page = false;
        st.phase = Phase::Hub;
        st.problem = None;
        st.pending.take()
    });
    let target = back
        .map(|path| hub.join(&path))
        .unwrap_or_else(|| hub.app_url());
    load_in_main(app, &window, target);
    hide(app, SIGNIN);
    if s.reveal() {
        show(&window);
    }
    if let Err(e) = ensure_quick(app, &hub) {
        eprintln!("qmo: quick entry: {e}");
    }
}

fn turned_away(app: &AppHandle, failure: Failure) {
    let s = shell(app);
    if let Some(name) = &failure.name {
        s.update_settings(|settings| settings.device_name = Some(name.clone()));
    }
    let known = failure.hub.as_deref().and_then(|h| parse_hub(h).ok());
    if failure.kind.needs_pairing() {
        s.with(|st| {
            st.phase = Phase::SignedOut;
            st.pending = None;
            st.problem = (failure.kind != ErrorKind::SignedOut).then(|| Problem::from(&failure));
        });
        show_signin(app);
        return;
    }
    if failure.kind == ErrorKind::Unsupported {
        if let Some(hub) = known {
            grant(app, &hub);
            s.with(|st| {
                st.hub = Some(hub.clone());
                st.login_page = true;
                st.phase = Phase::Hub;
                st.problem = None;
            });
            navigate_main(app, hub.login_url());
            if s.reveal() {
                show_app(app);
            }
            return;
        }
    }
    s.with(|st| {
        if let Some(hub) = known {
            st.hub = Some(hub);
        }
        st.phase = Phase::Offline;
        st.problem = Some(Problem::from(&failure));
    });
    show_local_in_main(app, "offline.html");
    if s.reveal() {
        show_app(app);
    }
}

/// The local sign-in page: pair through `qmo sign-in`, the code on standard
/// input, then get in. Blocking.
pub fn sign_in(app: &AppHandle, raw_hub: &str, code: &str) -> Result<(), Problem> {
    let hub = parse_hub(raw_hub).map_err(|e| Problem {
        kind: ErrorKind::Usage,
        message: e.to_string(),
    })?;
    let code = code.trim();
    if code.is_empty() || code.len() > 64 || code.chars().any(|c| c.is_control()) {
        return Err(Problem {
            kind: ErrorKind::BadCode,
            message: "pairing code".into(),
        });
    }
    // `--force`: the shell only signs in when the pairing on record is gone
    // or revoked, and then the old one has to make way.
    let paired: Paired = run_qmo(
        &["sign-in", hub.base(), "--force", "--json"],
        Some(&format!("{code}\n")),
    )
    .map_err(|failure| Problem::from(&failure))?;
    let s = shell(app);
    s.update_settings(|settings| {
        settings.hub = Some(paired.hub.clone());
        settings.device_name = Some(paired.name.clone());
    });
    s.with(|st| {
        st.hub = parse_hub(&paired.hub).ok();
        st.problem = None;
        st.reentries.clear();
    });
    s.unhide();
    if let Ok(window) = ensure_main(app) {
        let _ = window
            .navigate(Url::parse(&format!("{}skeleton.html", local_base())).expect("local url"));
    }
    enter(app, None, false);
    Ok(())
}

/// How a sign-out went, for the page that asked.
#[derive(Debug, Clone, Serialize)]
pub struct SignOutReport {
    /// The hub revoked the device (or there was none to revoke).
    pub revoked: bool,
    pub result: String,
}

/// `qmo_sign_out` and the settings page: revoke this device through `qmo`,
/// clear the WebView's data, and go back to sign-in (qmo-app.md §3 step 5).
/// Blocking.
pub fn sign_out(app: &AppHandle) -> SignOutReport {
    let s = shell(app);
    let result = match run_qmo::<SignedOut>(&["sign-out", "--json"], None) {
        Ok(out) => out.result,
        Err(failure) => {
            eprintln!("qmo: sign-out: {}", failure.message);
            "failed".to_string()
        }
    };
    let revoked = result == "revoked" || result == "signed_out";
    for label in [QUICK, SETTINGS] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.clear_all_browsing_data();
        let _ = window.hide();
        let _ = window
            .navigate(Url::parse(&format!("{}skeleton.html", local_base())).expect("local url"));
    }
    s.with(|st| {
        st.phase = Phase::SignedOut;
        st.login_page = false;
        st.problem = None;
        st.pending = None;
        st.reentries.clear();
        st.notice = (!revoked).then(|| result.clone());
    });
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_badge_count(None);
    }
    show_signin(app);
    SignOutReport { revoked, result }
}

/// Settings and About open as their own small windows.
pub fn open_settings(app: &AppHandle) {
    shell(app).unhide();
    let t = text(shell(app).lang);
    match local_window(
        app,
        SETTINGS,
        "settings.html",
        t.settings_title,
        (560.0, 560.0),
    ) {
        Ok(window) => show(&window),
        Err(e) => eprintln!("qmo: settings window: {e}"),
    }
}

pub fn open_about(app: &AppHandle) {
    shell(app).unhide();
    let t = text(shell(app).lang);
    match local_window(app, ABOUT, "about.html", t.about_title, (320.0, 388.0)) {
        Ok(window) => show(&window),
        Err(e) => eprintln!("qmo: about window: {e}"),
    }
}

/// Retry from the offline page.
pub fn retry(app: &AppHandle) {
    shell(app).with(|st| st.reentries.clear());
    if let Ok(window) = ensure_main(app) {
        let _ = window
            .navigate(Url::parse(&format!("{}skeleton.html", local_base())).expect("local url"));
    }
    enter(app, None, false);
}

pub fn open_hub_in_browser(app: &AppHandle) {
    if let Some(hub) = shell(app).hub() {
        open_external(app, &hub.join("/"));
    }
}

/// ⌘0, ⌘+ and ⌘− on the main window.
pub fn zoom(app: &AppHandle, step: Option<bool>) {
    let s = shell(app);
    let settings = s.update_settings(|settings| {
        settings.zoom = match step {
            None => 1.0,
            Some(up) => crate::settings::zoom_step(settings.zoom, up),
        }
    });
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_zoom(settings.zoom);
    }
}

pub fn reload(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.reload();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hub_gets_its_six_commands_and_the_drag_regions_only() {
        let commands: Vec<String> = HUB_COMMANDS
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-")))
            .collect();
        let (own, core): (Vec<&str>, Vec<&str>) = HUB_PERMISSIONS
            .iter()
            .partition(|p| !p.starts_with("core:"));
        assert_eq!(own, commands.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(
            core,
            [
                "core:window:allow-start-dragging",
                "core:window:allow-internal-toggle-maximize"
            ]
        );
        assert!(HUB_PERMISSIONS.iter().all(|p| !p.contains("local")));
    }

    #[test]
    fn the_shell_script_cannot_be_broken_out_of() {
        let script = init_script("macos", "main", "0.1.0\"'</script>");
        assert!(script.starts_with("Object.defineProperty(window, '__QMO_SHELL__'"));
        assert!(script.contains(r#""version":"0.1.0\"'</script>""#));
        assert!(script.contains(r#""window":"main""#));
    }

    #[test]
    fn the_blank_page_gets_the_skeleton_with_its_styles_inline() {
        let script = skeleton_script();
        assert!(script.starts_with("document.open();document.write(\""));
        assert!(script.ends_with(");document.close();"));
        assert!(script.contains("skeleton-side"));
        assert!(script.contains("<style>"));
        assert!(!script.contains("href=\\\"app.css\\\""));
    }

    #[test]
    fn page_colours() {
        assert_eq!(
            page_background(Theme::Light),
            tauri::window::Color(0xf9, 0xf9, 0xf7, 0xff)
        );
        assert_eq!(
            page_background(Theme::Dark),
            tauri::window::Color(0x1a, 0x1a, 0x19, 0xff)
        );
    }
}
