// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell's state and its windows (qmo-app.md §2, §3, §6).
//!
//! | Window | Shows | Size |
//! | --- | --- | --- |
//! | `signin` | the local sign-in page | 600 × 600, fixed |
//! | `main` | the local skeleton (drawn in the hub page's last layout and colours, qmo-local.md §3.5), then the hub's `/app`; the offline page when the hub is out of reach | 1200 × 800, at least 600 × 400, remembered |
//! | `quick` | the hub's `/app/quick` on a transparent, frameless window | 606 × 470, hidden until the shortcut |
//! | `settings`, `about` | local pages | fixed |
//!
//! Getting in is `qmo session --json` (§3): the cookies it prints go into the
//! WebView's store, the hub's origin gets the commands of §5.2 as a remote
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
    ipc::Reported,
    layout::{self, PageColours, Plan},
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

/// What the hub's pages may call: the twenty-four commands of qmo-app.md
/// §5.2, and the two the window's own drag regions need (§5.1: the page marks
/// its header `data-tauri-drag-region`; a drag or a double-click there moves
/// or zooms this window and nothing else). The local-session commands check
/// the window themselves: the main one only.
pub const HUB_PERMISSIONS: [&str; 26] = [
    "allow-qmo-shell-info",
    "allow-qmo-notify",
    "allow-qmo-badge",
    "allow-qmo-open-session",
    "allow-qmo-quick-hide",
    "allow-qmo-sign-out",
    "allow-qmo-local-agents",
    "allow-qmo-boot-layout",
    "allow-qmo-open-local-settings",
    "allow-qmo-local-list",
    "allow-qmo-local-watch",
    "allow-qmo-local-pick-folder",
    "allow-qmo-local-forget-folder",
    "allow-qmo-local-start",
    "allow-qmo-local-send",
    "allow-qmo-local-stop",
    "allow-qmo-local-answer",
    "allow-qmo-local-set-mode",
    "allow-qmo-local-read",
    "allow-qmo-local-changes",
    "allow-qmo-local-diff",
    "allow-qmo-local-set-remote",
    "allow-qmo-local-rename",
    "allow-qmo-local-delete",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
];

/// The twenty-four commands the hub's pages may call (qmo-app.md §5.2): nine,
/// and the fifteen of local sessions (qmo-local.md §4.5.1).
#[cfg(test)]
pub(crate) const HUB_COMMANDS: [&str; 24] = [
    "qmo_shell_info",
    "qmo_notify",
    "qmo_badge",
    "qmo_open_session",
    "qmo_quick_hide",
    "qmo_sign_out",
    "qmo_local_agents",
    "qmo_boot_layout",
    "qmo_open_local_settings",
    "qmo_local_list",
    "qmo_local_watch",
    "qmo_local_pick_folder",
    "qmo_local_forget_folder",
    "qmo_local_start",
    "qmo_local_send",
    "qmo_local_stop",
    "qmo_local_answer",
    "qmo_local_set_mode",
    "qmo_local_read",
    "qmo_local_changes",
    "qmo_local_diff",
    "qmo_local_set_remote",
    "qmo_local_rename",
    "qmo_local_delete",
];

/// The commands of a session that exists, which the shell's own Code page
/// may call too (P37.16, `capabilities/local.json`): read the sessions and
/// carry one on. Starting one, folders, changes, renaming, deleting and
/// Remote stay the hub's page's.
#[cfg(test)]
pub(crate) const OFFLINE_COMMANDS: [&str; 7] = [
    "qmo_local_list",
    "qmo_local_watch",
    "qmo_local_read",
    "qmo_local_send",
    "qmo_local_stop",
    "qmo_local_answer",
    "qmo_local_set_mode",
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
    /// `pending` is where a followed `qmo://` link goes: an entry from the
    /// Code page keeps it rather than putting its own in.
    linked: bool,
    reentries: Vec<Instant>,
    /// Origins that have the remote capability already.
    granted: HashSet<String>,
    /// Notification id → what a click on it opens.
    notifications: HashMap<i32, Opened>,
    next_notification: i32,
    /// Started at login: no window until the person asks for one.
    hidden: bool,
    /// The next entry that ends may bring the main window up: the one at
    /// start and the one after sign-in. A retry or a reconnect in the
    /// background never does, whatever the window is doing (closed to the
    /// tray, the app hidden with ⌘H, another app in front).
    reveal_next: bool,
    /// Told when the main window has finished loading `about:blank`.
    blank: Option<mpsc::Sender<()>>,
}

/// What a click on a notification opens: a conversation (`qmo_notify`) or
/// a local session (`attention.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    Chat(String),
    Code(String),
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
                linked: false,
                reentries: Vec::new(),
                granted: HashSet::new(),
                notifications: HashMap::new(),
                next_notification: 1,
                hidden,
                reveal_next: false,
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

    /// Change the settings and write them when they changed; a write that
    /// fails is logged, not fatal.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let (settings, changed) = self.with(|s| {
            let before = s.settings.clone();
            f(&mut s.settings);
            (s.settings.clone(), s.settings != before)
        });
        if changed {
            if let Err(e) = settings.save(&self.settings_path) {
                eprintln!("qmo: settings not saved: {e}");
            }
        }
        settings
    }

    /// What the skeleton draws now: the hub page's last layout and colours.
    pub fn skeleton_plan(&self) -> Plan {
        self.with(|s| layout::plan(s.settings.layout.as_ref(), &s.settings.colors))
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

    /// Remember what a notification opens, for a click on it.
    pub fn remember_notification(&self, session: Option<Opened>) -> i32 {
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

    pub fn notification_session(&self, id: i32) -> Option<Opened> {
        self.with(|s| s.notifications.remove(&id))
    }

    fn reveal(&self) -> bool {
        self.with(|s| !s.hidden)
    }

    /// The person asked for a window: from here on windows show.
    fn unhide(&self) {
        self.with(|s| s.hidden = false)
    }

    /// An entry the person is waiting to see the end of starts: at start
    /// and on sign-in.
    fn reveal_next(&self) {
        self.with(|s| s.reveal_next = true)
    }

    /// The person closed the main window to the tray while an entry was
    /// under way: its end leaves the window closed.
    pub fn cancel_reveal(&self) {
        self.with(|s| s.reveal_next = false)
    }

    /// Whether the entry that just ended may bring the main window up; asked
    /// once per entry. Never when started at login.
    fn take_reveal(&self) -> bool {
        self.with(|s| std::mem::replace(&mut s.reveal_next, false) && !s.hidden)
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

/// The page colour of `theme`, so a window never flashes white: the one the
/// hub's page last reported for that appearance (`reported`), else the
/// console's `--color-bg`, `#f9f9f7` light and `#0b0b0b` dark
/// (qmo-local.md §3.4).
pub fn page_background(theme: Theme, reported: &PageColours) -> tauri::window::Color {
    let palette = layout::palette(reported, theme == Theme::Dark);
    let (r, g, b) = layout::rgb(&palette.page);
    tauri::window::Color(r, g, b, 0xff)
}

/// The colour for `label`'s window: the main window shows the hub's page, in
/// the colours it reported; the small local windows draw the defaults.
pub fn background(app: &AppHandle, label: &str, theme: Theme) -> tauri::window::Color {
    if label == MAIN {
        page_background(theme, &shell(app).settings().colors)
    } else {
        page_background(theme, &PageColours::default())
    }
}

fn init_script(platform: &str, window: &str, version: &str) -> String {
    let info = serde_json::json!({ "platform": platform, "window": window, "version": version });
    format!(
        "Object.defineProperty(window, '__QMO_SHELL__', {{ value: Object.freeze({info}), \
         writable: false, configurable: false, enumerable: false }});"
    )
}

/// The skeleton's plan for the shell's own pages in the main window
/// (`ui/skeleton.js` reads it as it loads), as JSON in a script, never in the
/// markup. The hub's pages do not get it.
fn boot_script(plan: &Plan) -> String {
    let plan = serde_json::to_string(plan).expect("a plan is JSON");
    format!(
        "if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') \
         Object.defineProperty(window, '__QMO_BOOT__', {{ value: Object.freeze({plan}), \
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
                // The page going away had the local sessions' event channel;
                // the next one registers its own (qmo-local.md §4.5.2).
                if label == MAIN {
                    crate::code::forget_watcher(&load_app);
                }
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
    let colour = background(window.app_handle(), window.label(), theme);
    let _ = window.set_background_color(Some(colour));
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

/// The main window, made on first use with the skeleton showing: in the
/// page colour before anything paints, and drawn in the hub page's last
/// layout from its first frame.
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
        .initialization_script(init_script(s.platform, "main", &s.version))
        .initialization_script(boot_script(&s.skeleton_plan()));
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

/// After an entry, in or turned away: the main window comes up for the
/// entry at start and the one after sign-in, when it is not up yet. Any
/// other entry leaves the window as the person has it — on screen, minimised,
/// closed to the tray, the app hidden: the offline page retries every half
/// minute and the Code page reconnects as often, and neither may pull the
/// window over another app or out of the tray.
fn surface(app: &AppHandle, window: &WebviewWindow) {
    hide(app, SIGNIN);
    if !shell(app).take_reveal() || !needs_showing(window) {
        return;
    }
    show(window);
}

fn needs_showing(window: &WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
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
    window.url().is_ok_and(|from| blank_step_between(&from, to))
}

fn blank_step_between(from: &Url, to: &Url) -> bool {
    from.as_str() != BLANK && from.origin() != to.origin()
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
            let _ = window.eval(skeleton_script(&shell(app).skeleton_plan()));
        }
        shell(app).with(|s| s.blank = None);
    }
    if let Err(e) = window.navigate(url) {
        eprintln!("qmo: navigate: {e}");
    }
}

/// The skeleton page's own script (`ui/skeleton.js`).
const SKELETON_JS: &str = include_str!("../../ui/skeleton.js");

/// The skeleton page as `about:blank` gets it: its style sheet inline, its
/// script tag taken out (the script runs after, from here).
fn skeleton_page() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| {
        let page = include_str!("../../ui/skeleton.html")
            .replace(
                r#"<link rel="stylesheet" href="app.css">"#,
                &format!("<style>{}</style>", include_str!("../../ui/app.css")),
            )
            .replace(r#"<script src="skeleton.js"></script>"#, "");
        serde_json::to_string(&page).expect("a string")
    })
}

/// The skeleton written into `about:blank`, then drawn to `plan`: the plan
/// goes in as JSON, the page's markup is the shell's own.
fn skeleton_script(plan: &Plan) -> String {
    let plan = serde_json::to_string(plan).expect("a plan is JSON");
    format!(
        "document.open();document.write({page});document.close();\
         window.__QMO_BOOT__={plan};\n{SKELETON_JS}",
        page = skeleton_page(),
    )
}

/// `qmo_boot_layout`: keep what the page reported, and paint the main window
/// in its colours from now on.
pub fn remember_layout(app: &AppHandle, reported: Reported) {
    let s = shell(app);
    let before = s.settings().colors;
    let settings = s.update_settings(|settings| {
        settings.layout = Some(reported.layout);
        if let Some((dark, palette)) = reported.colours {
            settings.colors.set(dark, palette);
        }
    });
    if settings.colors != before {
        if let Some(window) = app.get_webview_window(MAIN) {
            paint(&window);
        }
    }
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

/// ⌘N, the tray and `qmo://new`: a new task in the main window, the new
/// work page (P37.17 B, `docs/dev/work-tasks.md` §9.1). A conversation with
/// an agent is its row in the side list, never a new one.
pub fn new_work(app: &AppHandle) {
    shell(app).unhide();
    match shell(app).hub() {
        Some(hub) if shell(app).phase() == Phase::Hub => {
            show_app(app);
            navigate_main(app, hub.new_work_url());
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

/// Whether the main window shows the signed-in hub's Code page, which
/// opens a session it is told of (`open` event).
pub fn on_code_page(main: Option<&Url>, hub: Option<&Hub>) -> bool {
    match (main, hub) {
        (Some(url), Some(hub)) => hub.same_origin(url) && url.path() == "/code",
        _ => false,
    }
}

/// A local session's notification clicked: the main window comes forward
/// on that session. The Code page on screen with its channel is told to
/// open it; otherwise the main window opens `/code?session=<id>`.
pub fn open_code_session(app: &AppHandle, id: &str) {
    shell(app).unhide();
    hide_quick(app);
    // Offline, the shell's own Code page carries the sessions (P37.16).
    let page = app
        .get_webview_window(MAIN)
        .and_then(|window| window.url().ok());
    if crate::ipc::valid_local_session(id)
        && page.as_ref().is_some_and(crate::ipc::is_offline_code)
        && app
            .state::<crate::code::Code>()
            .runner
            .watcher()
            .tell(&crate::code::open_event(id))
    {
        return show_app(app);
    }
    let hub = shell(app).hub();
    let hub = match hub {
        Some(hub) if crate::ipc::valid_local_session(id) && shell(app).phase() == Phase::Hub => hub,
        _ => return show_app(app),
    };
    show_app(app);
    let page = app
        .get_webview_window(MAIN)
        .and_then(|window| window.url().ok());
    if on_code_page(page.as_ref(), Some(&hub))
        && app
            .state::<crate::code::Code>()
            .runner
            .watcher()
            .tell(&crate::code::open_event(id))
    {
        return;
    }
    navigate_main(app, hub.join(&format!("/code?session={id}")));
}

/// A `qmo://` link: now when the hub is open, else once it is.
pub fn follow(app: &AppHandle, link: DeepLink) {
    let s = shell(app);
    s.unhide();
    if s.phase() == Phase::Hub {
        match link {
            DeepLink::New => new_work(app),
            DeepLink::Session(id) => open_session(app, &id),
        }
        return;
    }
    let path = match link {
        DeepLink::New => "/app?work=new".to_string(),
        DeepLink::Session(id) => format!("/app?session={id}"),
    };
    s.with(|st| {
        st.pending = Some(path);
        st.linked = true;
    });
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
    s.reveal_next();
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
            st.linked = false;
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
        st.linked = false;
        st.pending.take()
    });
    let target = back
        .map(|path| hub.join(&path))
        .unwrap_or_else(|| hub.app_url());
    load_in_main(app, &window, target);
    surface(app, &window);
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
            st.linked = false;
            st.problem = (failure.kind != ErrorKind::SignedOut).then(|| Problem::from(&failure));
        });
        // What the hidden main window showed (the offline page, the Code
        // page) stops retrying: the way on is sign-in.
        if let Some(window) = app.get_webview_window(MAIN) {
            let _ = window.navigate(
                Url::parse(&format!("{}skeleton.html", local_base())).expect("local url"),
            );
        }
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
            if let Ok(window) = ensure_main(app) {
                surface(app, &window);
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
    // The shell's own Code page stays: its sessions go on without the hub,
    // and it says why it is still out of reach (P37.16).
    if !main_shows_offline_code(app) {
        show_local_in_main(app, "offline.html");
    }
    if let Ok(window) = ensure_main(app) {
        surface(app, &window);
    }
}

fn main_shows_offline_code(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .and_then(|window| window.url().ok())
        .is_some_and(|url| crate::ipc::is_offline_code(&url))
}

/// The offline page's 打开本机会话 (P37.16): the shell's own Code page in
/// the main window, while the hub is out of reach. Signed in to a hub that
/// is open, it is the hub's `/code`; signed out, sign-in.
pub fn open_offline_code(app: &AppHandle) {
    let s = shell(app);
    s.unhide();
    match s.phase() {
        Phase::Offline => show_local_in_main(app, "code.html"),
        Phase::Hub => match s.hub() {
            Some(hub) => {
                show_app(app);
                navigate_main(app, hub.join("/code"));
            }
            None => show_app(app),
        },
        _ => show_app(app),
    }
}

/// What `reconnect` found on taking the shell's state.
enum Claim {
    Go,
    In(Option<Hub>),
    Refused(Problem),
}

/// From the shell's own Code page: try the hub again without leaving it
/// (P37.16). In, the main window goes to the hub's `/code` (on `session`,
/// already checked); turned away for good — the pairing gone, a hub without
/// tickets — as any entry is; still out of reach, the page stays and is
/// told why. Only while offline; an entry already under way answers `busy`.
/// Blocking.
pub fn reconnect(app: &AppHandle, session: Option<String>) -> Result<(), Problem> {
    let s = shell(app);
    let path = match &session {
        Some(id) => format!("/code?session={id}"),
        None => "/code".to_string(),
    };
    // The phase looked at and the entry taken under one lock.
    let claim = s.with(|st| match st.phase {
        Phase::Offline if !st.entering => {
            st.entering = true;
            // A deep link followed meanwhile keeps its place; anything else
            // (an earlier reconnect's, a /login re-entry's) is this one's now.
            if !st.linked {
                st.pending = Some(path.clone());
            }
            st.phase = Phase::Entering;
            Claim::Go
        }
        // In already (a retry elsewhere got there): to the hub's Code.
        Phase::Hub => Claim::In(st.hub.clone()),
        Phase::SignedOut => Claim::Refused(Problem {
            kind: ErrorKind::SignedOut,
            message: "signed out".into(),
        }),
        _ => Claim::Refused(Problem {
            kind: ErrorKind::Busy,
            message: "an entry is under way".into(),
        }),
    });
    match claim {
        Claim::Go => {}
        Claim::In(hub) => {
            if let Some(hub) = hub {
                navigate_main(app, hub.join(&path));
            }
            return Ok(());
        }
        Claim::Refused(problem) => return Err(problem),
    }
    let outcome = run_qmo::<Session>(&["session", "--json"], None);
    let result = match outcome {
        // `arrive` may still turn it away (a hub address or cookie it
        // cannot use); the phase says how it went.
        Ok(session) => {
            arrive(app, session);
            match s.phase() {
                Phase::Hub => Ok(()),
                _ => Err(s.problem().unwrap_or(Problem {
                    kind: ErrorKind::Broken,
                    message: "not in".into(),
                })),
            }
        }
        Err(failure) => {
            let problem = Problem::from(&failure);
            turned_away(app, failure);
            Err(problem)
        }
    };
    // Not in, however it went (qmo, or arrive turning it away): its place is
    // not where the next entry goes. The page may be on another session by
    // then, and asks again with its own.
    if result.is_err() {
        s.with(|st| {
            if !st.linked && st.pending.as_deref() == Some(path.as_str()) {
                st.pending = None;
            }
        });
    }
    s.with(|st| st.entering = false);
    result
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
    s.reveal_next();
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
        st.linked = false;
        st.reentries.clear();
        st.notice = (!revoked).then(|| result.clone());
    });
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_badge_count(None);
    }
    show_signin(app);
    SignOutReport { revoked, result }
}

/// What the page runs to open its settings card, as Claude Desktop's ⌘,
/// does; a hub too old to define `window.__qmoOpenSettings` gets the shell's
/// settings window instead, through the command its page may call. A fixed
/// string: nothing is ever put into it.
pub const OPEN_PAGE_SETTINGS: &str = "(window.__qmoOpenSettings||function(){window.__TAURI__.core.invoke('qmo_open_local_settings')})()";

/// The View menu's side list and pane items (qmo-app.md §11.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageMenu {
    Side,
    Right,
    Below,
    Next,
    Prev,
    Close,
}

/// The fixed script each one runs in the hub's page: its `window.__qmoMenu`
/// (`assets/frontSplit.ts`), one word from six, nothing put together.
pub fn page_menu_script(action: PageMenu) -> &'static str {
    match action {
        PageMenu::Side => "window.__qmoMenu&&window.__qmoMenu('side')",
        PageMenu::Right => "window.__qmoMenu&&window.__qmoMenu('right')",
        PageMenu::Below => "window.__qmoMenu&&window.__qmoMenu('below')",
        PageMenu::Next => "window.__qmoMenu&&window.__qmoMenu('next')",
        PageMenu::Prev => "window.__qmoMenu&&window.__qmoMenu('prev')",
        PageMenu::Close => "window.__qmoMenu&&window.__qmoMenu('close')",
    }
}

/// A View menu item clicked: to the main window's page when it is the hub's
/// (as Settings… is), nothing otherwise. No command of the shell's is added.
pub fn page_menu(app: &AppHandle, action: PageMenu) {
    let s = shell(app);
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let page = window.url().ok();
    if !settings_in_page(page.as_ref(), s.hub().as_ref(), s.phase()) {
        return;
    }
    if let Err(e) = window.eval(page_menu_script(action)) {
        eprintln!("qmo: page menu: {e}");
    }
}

/// Whether the menu's Settings goes to the page: the main window shows a page
/// of the hub the shell is signed in to. On a local page (sign-in, offline,
/// the skeleton), `about:blank` or with no main window, it is the shell's own
/// settings window.
pub fn settings_in_page(main: Option<&Url>, hub: Option<&Hub>, phase: Phase) -> bool {
    phase == Phase::Hub && crate::ipc::from_hub(main, hub).is_ok()
}

/// The menu bar's Settings… (⌘,) and the tray's Settings: the page's settings
/// card in the main window, brought to the front, when it shows the hub's
/// page; the shell's settings window otherwise.
pub fn open_settings_from_menu(app: &AppHandle) {
    let s = shell(app);
    let main = app.get_webview_window(MAIN);
    let page = main.as_ref().and_then(|window| window.url().ok());
    match main {
        Some(window) if settings_in_page(page.as_ref(), s.hub().as_ref(), s.phase()) => {
            s.unhide();
            show(&window);
            if let Err(e) = window.eval(OPEN_PAGE_SETTINGS) {
                eprintln!("qmo: page settings: {e}");
                open_settings(app);
            }
        }
        _ => open_settings(app),
    }
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
    fn the_hub_gets_its_commands_and_the_drag_regions_only() {
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
        assert!(HUB_PERMISSIONS.iter().all(|p| !p.contains("allow-local-")));
    }

    #[test]
    fn the_local_pages_get_only_the_commands_of_a_session_that_exists() {
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/local.json")).unwrap();
        assert_eq!(local["local"], true);
        assert!(local.get("remote").is_none());
        let permissions: Vec<&str> = local["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        for command in HUB_COMMANDS {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(
                permissions.contains(&permission.as_str()),
                OFFLINE_COMMANDS.contains(&command),
                "{command}"
            );
        }
        // Nothing that starts a session, picks a folder, reads the files,
        // renames, deletes, turns Remote on or asks for the agents.
        for command in [
            "qmo_local_start",
            "qmo_local_pick_folder",
            "qmo_local_forget_folder",
            "qmo_local_changes",
            "qmo_local_diff",
            "qmo_local_rename",
            "qmo_local_delete",
            "qmo_local_set_remote",
            "qmo_local_agents",
            "qmo_sign_out",
        ] {
            assert!(!OFFLINE_COMMANDS.contains(&command), "{command}");
        }
        assert!(OFFLINE_COMMANDS.iter().all(|c| HUB_COMMANDS.contains(c)));
        assert!(permissions.contains(&"allow-local-boot"));
        assert!(permissions.contains(&"allow-local-reconnect"));
        assert!(include_str!("../build.rs").contains("\"local_reconnect\""));
        assert!(include_str!("lib.rs").contains("commands::local_reconnect,"));
        // Every command the shell declares is the hub's or a local page's.
        let build = include_str!("../build.rs");
        for command in HUB_COMMANDS {
            assert!(build.contains(&format!("\"{command}\"")), "{command}");
        }
    }

    #[test]
    fn local_sessions_are_the_hubs_and_registered_everywhere_they_must_be() {
        let local: Vec<&str> = HUB_COMMANDS
            .iter()
            .copied()
            .filter(|c| c.starts_with("qmo_local_") && *c != "qmo_local_agents")
            .collect();
        assert_eq!(
            local,
            [
                "qmo_local_list",
                "qmo_local_watch",
                "qmo_local_pick_folder",
                "qmo_local_forget_folder",
                "qmo_local_start",
                "qmo_local_send",
                "qmo_local_stop",
                "qmo_local_answer",
                "qmo_local_set_mode",
                "qmo_local_read",
                "qmo_local_changes",
                "qmo_local_diff",
                "qmo_local_set_remote",
                "qmo_local_rename",
                "qmo_local_delete",
            ]
        );
        let lib = include_str!("lib.rs");
        let commands = include_str!("commands.rs");
        for command in HUB_COMMANDS {
            assert!(
                HUB_PERMISSIONS.contains(&format!("allow-{}", command.replace('_', "-")).as_str()),
                "{command}"
            );
            assert!(lib.contains(&format!("commands::{command},")), "{command}");
            assert!(
                commands.contains(&format!("pub async fn {command}("))
                    || commands.contains(&format!("pub fn {command}(")),
                "{command}"
            );
        }
        // The main window's page loads drop its channel.
        let shell = include_str!("shell.rs");
        let started = shell
            .find("if payload.event() == PageLoadEvent::Started {")
            .unwrap();
        let branch = &shell[started..];
        let branch = &branch[..branch.find("let url = payload.url().clone();").unwrap()];
        assert!(branch.contains(
            "if label == MAIN {\n                    crate::code::forget_watcher(&load_app);"
        ));
        // Every local-session command checks its caller and its arguments:
        // the seven of a session that exists let the shell's own Code page
        // in too, the others only the hub's page.
        for command in &local {
            let start = commands.find(&format!("pub async fn {command}(")).unwrap();
            let body = &commands[start..];
            let end = body[1..]
                .find("\n#[tauri::command]")
                .map_or(body.len(), |e| e + 1);
            let flat: String = body[..end].split_whitespace().collect();
            let check = if OFFLINE_COMMANDS.contains(command) {
                "session_body(&app,&webview,&request"
            } else {
                "local_body(&app,&webview,&request"
            };
            assert!(flat.contains(check), "{command}");
        }
        assert!(commands.contains("ipc::session_caller(page.as_ref()"));
        assert!(commands.contains("ipc::local_caller(page.as_ref()"));
    }

    #[test]
    fn every_hub_permission_is_one_the_build_made() {
        // `tauri-build` writes the manifest from `build.rs`'s command list
        // before this compiles; a name missing there would only show when the
        // capability is added at run time.
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("gen")
            .join("schemas")
            .join("acl-manifests.json");
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        let app = &manifest["__app-acl__"]["permissions"];
        for permission in HUB_PERMISSIONS.iter().filter(|p| !p.starts_with("core:")) {
            assert!(app.get(*permission).is_some(), "{permission}");
        }
        assert!(
            manifest.get("fs").is_none(),
            "the file system plugin is not registered"
        );
    }

    #[test]
    fn no_page_gets_the_dialog_or_any_other_plugin() {
        let plugin = |p: &str| {
            p.contains(':')
                && !matches!(
                    p,
                    "core:window:allow-start-dragging"
                        | "core:window:allow-internal-toggle-maximize"
                )
        };
        assert!(
            !HUB_PERMISSIONS.iter().any(|p| plugin(p)),
            "{HUB_PERMISSIONS:?}"
        );
        assert!(!HUB_PERMISSIONS
            .iter()
            .any(|p| p.contains("dialog") || p.contains("fs")));
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut files = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let permission = permission.as_str().unwrap();
                assert!(!plugin(permission), "{path:?}: {permission}");
                if let Some(command) = permission.strip_prefix("allow-qmo-") {
                    let command = format!("qmo_{}", command.replace('-', "_"));
                    assert!(
                        OFFLINE_COMMANDS.contains(&command.as_str()),
                        "{path:?}: {permission}"
                    );
                }
            }
            assert!(!text.contains("dialog:"), "{path:?}");
            assert!(!text.contains("fs:"), "{path:?}");
            files += 1;
        }
        assert_eq!(files, 1, "local.json is the only static capability");
        // The plugin is there for its Rust picker, without its page script.
        let lib = include_str!("lib.rs");
        assert!(lib.contains(".plugin(code::Quiet(tauri_plugin_dialog::init()))"));
        assert_eq!(lib.matches("tauri_plugin_dialog::init()").count(), 1);
    }

    #[test]
    fn only_the_entry_at_start_or_after_sign_in_brings_the_window_up() {
        let dir = std::env::temp_dir().join(format!("qmo-surface-{}", std::process::id()));
        let shell = Shell::new(Lang::En, "0".into(), dir.join("settings.json"), false);
        // A retry or a reconnect in the background: never.
        assert!(!shell.take_reveal());
        // The entry at start: once.
        shell.reveal_next();
        assert!(shell.take_reveal());
        assert!(!shell.take_reveal());
        // Settings, About, the tray: the person asked for a window, not for
        // the next retry to raise the main one.
        shell.unhide();
        assert!(!shell.take_reveal());
        // Started at login: nothing comes up by itself.
        let login = Shell::new(Lang::En, "0".into(), dir.join("settings.json"), true);
        login.reveal_next();
        assert!(!login.take_reveal());
        // Closed to the tray while the entry at start was under way: it
        // stays closed when the entry ends.
        shell.reveal_next();
        shell.cancel_reveal();
        assert!(!shell.take_reveal());
        assert!(include_str!("lib.rs").contains("app.state::<Shell>().cancel_reveal();"));
        // Every entry's end goes through `surface`, which also leaves a
        // window on screen or minimised alone; start and sign-in ask for it.
        let source = include_str!("shell.rs");
        let body = |name: &str| {
            let start = source.find(&format!("fn {name}(")).unwrap();
            let rest = &source[start..];
            rest[..rest.find("\n}\n").unwrap()].to_string()
        };
        assert!(!body("arrive").contains("show(&window)"));
        assert!(!body("turned_away").contains("show_app("));
        assert_eq!(
            body("turned_away").matches("surface(app, &window)").count(),
            2
        );
        assert!(body("arrive").contains("surface(app, &window)"));
        assert!(body("needs_showing").contains("is_minimized"));
        assert!(body("start").contains("s.reveal_next();"));
        assert!(body("sign_in").contains("s.reveal_next();"));
        // A retry and a reconnect do not.
        assert!(!body("retry").contains("reveal_next"));
        assert!(!body("reconnect").contains("reveal_next"));
        // A reconnect puts its own place in unless a followed link is waiting,
        // and takes it back out when it fails; a link marks itself.
        let reconnect = body("reconnect");
        assert!(
            reconnect.contains("if !st.linked {\n                st.pending = Some(path.clone());")
        );
        assert!(
            reconnect.contains("if !st.linked && st.pending.as_deref() == Some(path.as_str()) {")
        );
        assert!(body("follow").contains("st.linked = true;"));
        assert!(body("arrive").contains("st.linked = false;"));
    }

    #[test]
    fn the_offline_code_page_is_one_of_the_shells_pages() {
        // What 打开本机会话 shows, and the one local page the session
        // commands answer (`ipc::session_caller`).
        let page = include_str!("../../ui/code.html");
        assert_eq!(crate::ipc::OFFLINE_CODE, "/code.html");
        assert!(page.contains(r#"<script src="code-render.js"></script>"#));
        assert!(page.contains(r#"<script type="module" src="code.js"></script>"#));
        let shell = include_str!("shell.rs");
        assert!(shell.contains("Phase::Offline => show_local_in_main(app, \"code.html\"),"));
        let offline = include_str!("../../ui/offline.js");
        assert!(offline.contains("invoke('local_open', { target: 'code' })"));
        let commands = include_str!("commands.rs");
        assert!(commands.contains("\"code\" => shell::open_offline_code(&app),"));
        // Still out of reach, an entry leaves the page where it is.
        assert!(shell.contains(
            "if !main_shows_offline_code(app) {\n        show_local_in_main(app, \"offline.html\");"
        ));
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
        let plan = layout::plan(None, &PageColours::default());
        let script = skeleton_script(&plan);
        assert!(script.starts_with("document.open();document.write(\""));
        assert!(script.contains(");document.close();window.__QMO_BOOT__={\"mode\":\"work\""));
        assert!(script.ends_with(SKELETON_JS));
        assert!(script.contains("skeleton-side"));
        assert!(script.contains("skeleton-modes"));
        assert!(script.contains("<style>"));
        assert!(!script.contains("href=\\\"app.css\\\""));
        assert!(!script.contains("src=\\\"skeleton.js\\\""));
    }

    #[test]
    fn the_plan_goes_to_the_skeleton_as_json_only() {
        let mut colours = PageColours::default();
        colours.set(true, layout::Palette::new("#101112", "#0d0e0f").unwrap());
        let reported = layout::BootLayout {
            page: layout::Page::Code,
            side: layout::Side::Closed,
            side_width: 300,
            rows: 2,
            labels: 1,
            theme: layout::ThemeChoice::Dark,
        };
        let plan = layout::plan(Some(&reported), &colours);
        let json = serde_json::to_string(&plan).unwrap();
        let script = boot_script(&plan);
        assert!(script.starts_with(
            "if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') "
        ));
        assert!(script.contains(&format!("value: Object.freeze({json})")));
        assert!(json.contains(r#""mode":"code""#));
        assert!(json.contains(r#""side":"closed""#));
        assert!(json.contains(r#""sideWidth":300"#));
        assert!(json.contains(r#""items":["label","row","row"]"#));
        assert!(json.contains(r##""dark":{"page":"#101112","sidebar":"#0d0e0f"}"##));
        assert!(skeleton_script(&plan).contains(&format!("window.__QMO_BOOT__={json};")));
    }

    #[test]
    fn the_skeleton_page_has_what_its_script_draws_into() {
        let page = include_str!("../../ui/skeleton.html");
        for hook in [
            r#"class="skeleton-side""#,
            r#"class="skeleton-modes""#,
            r#"data-mode="work""#,
            r#"data-mode="code""#,
            r#"class="skeleton-list""#,
            r#"<script src="skeleton.js"></script>"#,
        ] {
            assert!(page.contains(hook), "{hook}");
        }
        // The script comes after what it draws into, so it draws before the
        // first paint instead of after it.
        let list = page.find(r#"class="skeleton-list""#).unwrap();
        let script = page.find(r#"<script src="skeleton.js">"#).unwrap();
        assert!(list < script);
        for name in [
            "__QMO_BOOT__",
            "sideWidth",
            "items",
            "local_boot",
            "prefers-color-scheme",
            "--color-bg",
            "--color-side",
            "--skeleton-side-w",
        ] {
            assert!(SKELETON_JS.contains(name), "{name}");
        }
    }

    #[test]
    fn only_a_step_from_another_origin_goes_through_blank() {
        let url = |s: &str| Url::parse(s).unwrap();
        let app = url("https://hub.example.com/app");
        for from in [
            "tauri://localhost/skeleton.html",
            "http://tauri.localhost/offline.html",
            "https://other.example.com/app",
            "https://hub.example.com:8443/app",
        ] {
            assert!(blank_step_between(&url(from), &app), "{from}");
        }
        for from in [
            "https://hub.example.com/app?session=a",
            "https://hub.example.com/",
            BLANK,
        ] {
            assert!(!blank_step_between(&url(from), &app), "{from}");
        }
    }

    #[test]
    fn the_menus_settings_go_to_the_page_only_on_the_signed_in_hubs_page() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let url = |s: &str| Url::parse(s).unwrap();
        for page in [
            "https://hub.example.com/app",
            "https://hub.example.com/",
            "https://hub.example.com/code",
            "https://hub.example.com/admin/models",
        ] {
            assert!(
                settings_in_page(Some(&url(page)), Some(&hub), Phase::Hub),
                "{page}"
            );
        }
        for page in [
            "tauri://localhost/skeleton.html",
            "tauri://localhost/offline.html",
            "tauri://localhost/index.html",
            "http://tauri.localhost/skeleton.html",
            "about:blank",
            "https://other.example.com/app",
            "https://hub.example.com:8443/app",
        ] {
            assert!(
                !settings_in_page(Some(&url(page)), Some(&hub), Phase::Hub),
                "{page}"
            );
        }
        // No main window, or no hub.
        assert!(!settings_in_page(None, Some(&hub), Phase::Hub));
        assert!(!settings_in_page(
            Some(&url("https://hub.example.com/app")),
            None,
            Phase::Hub
        ));
        // Not signed in: the hub's address may still be on the window.
        for phase in [
            Phase::Starting,
            Phase::SignedOut,
            Phase::Entering,
            Phase::Offline,
        ] {
            assert!(
                !settings_in_page(Some(&url("https://hub.example.com/app")), Some(&hub), phase),
                "{phase:?}"
            );
        }
    }

    #[test]
    fn a_notification_opens_its_session_in_the_code_page_on_screen_only() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let url = |s: &str| Url::parse(s).unwrap();
        for page in [
            "https://hub.example.com/code",
            "https://hub.example.com/code?session=cs_AbCdEfGhIjKlMnOpQrSt_-",
        ] {
            assert!(on_code_page(Some(&url(page)), Some(&hub)), "{page}");
        }
        for page in [
            "https://hub.example.com/app",
            "https://hub.example.com/codes",
            "https://hub.example.com/code/x",
            "https://other.example.com/code",
            "tauri://localhost/skeleton.html",
        ] {
            assert!(!on_code_page(Some(&url(page)), Some(&hub)), "{page}");
        }
        assert!(!on_code_page(None, Some(&hub)));
        assert!(!on_code_page(
            Some(&url("https://hub.example.com/code")),
            None
        ));
        // What a click opens is remembered by kind and given back once.
        let dir = std::env::temp_dir().join(format!("qmo-opened-{}", std::process::id()));
        let shell = Shell::new(Lang::En, "0".into(), dir.join("settings.json"), false);
        let chat = shell.remember_notification(Some(Opened::Chat("s-1".into())));
        let code =
            shell.remember_notification(Some(Opened::Code("cs_AbCdEfGhIjKlMnOpQrSt_-".into())));
        let none = shell.remember_notification(None);
        assert_eq!(
            shell.notification_session(code),
            Some(Opened::Code("cs_AbCdEfGhIjKlMnOpQrSt_-".into()))
        );
        assert_eq!(
            shell.notification_session(chat),
            Some(Opened::Chat("s-1".into()))
        );
        assert_eq!(shell.notification_session(none), None);
        assert_eq!(shell.notification_session(code), None);
    }

    #[test]
    fn the_page_settings_script_is_the_fixed_one() {
        assert_eq!(
            OPEN_PAGE_SETTINGS,
            "(window.__qmoOpenSettings||function(){window.__TAURI__.core.invoke('qmo_open_local_settings')})()"
        );
        // Its fallback is a command the hub's page may call.
        assert!(HUB_COMMANDS.contains(&"qmo_open_local_settings"));
    }

    #[test]
    fn the_page_menu_scripts_are_six_fixed_ones_and_call_no_command() {
        let all = [
            (PageMenu::Side, "side"),
            (PageMenu::Right, "right"),
            (PageMenu::Below, "below"),
            (PageMenu::Next, "next"),
            (PageMenu::Prev, "prev"),
            (PageMenu::Close, "close"),
        ];
        for (action, word) in all {
            assert_eq!(
                page_menu_script(action),
                format!("window.__qmoMenu&&window.__qmoMenu('{word}')"),
                "{action:?}"
            );
            assert!(!page_menu_script(action).contains("__TAURI__"));
        }
    }

    #[test]
    fn page_colours() {
        let none = PageColours::default();
        assert_eq!(
            page_background(Theme::Light, &none),
            tauri::window::Color(0xf9, 0xf9, 0xf7, 0xff)
        );
        assert_eq!(
            page_background(Theme::Dark, &none),
            tauri::window::Color(0x0b, 0x0b, 0x0b, 0xff)
        );
        let mut reported = PageColours::default();
        reported.set(true, layout::Palette::new("#121314", "#0e0f10").unwrap());
        assert_eq!(
            page_background(Theme::Dark, &reported),
            tauri::window::Color(0x12, 0x13, 0x14, 0xff)
        );
        // Only the appearance it was reported for.
        assert_eq!(
            page_background(Theme::Light, &reported),
            tauri::window::Color(0xf9, 0xf9, 0xf7, 0xff)
        );
    }
}
