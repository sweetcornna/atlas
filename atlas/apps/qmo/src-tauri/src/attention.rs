// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Local sessions that need the person (qmo-app.md §6, qmo-local.md §4.5.2):
//! the shell reads the runner's events itself (`code::Runner::tap`), because
//! the page that would otherwise say so is not always there — the main
//! window may show Work, or be hidden.
//!
//! - A notification when a turn ends (`running` or `waiting` to `idle` or
//!   `failed`) or an agent asks (to `waiting`), unless the main window is in
//!   front with the Code page watching. A stop the person made
//!   (`interrupted`) says nothing. The title is the session's, the body
//!   `<agent> · <what happened>`; a click opens the session.
//! - The badge is the page's count (`qmo_badge`, unread conversations) plus
//!   the local sessions waiting for an answer, at most 999.
//! - Quitting with sessions running or waiting asks first.
//!
//! What is known is what the events since the runner came up said; it is
//! forgotten when the runner goes down, as the sessions' turns are.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use crate::{
    code::{Code, Seen},
    ipc::{valid_local_session, BADGE_MAX, TITLE_MAX},
    shell::{Opened, Shell, MAIN},
    text::text,
};

/// How long quitting waits for the runner's `list`.
const QUIT_ASK: Duration = Duration::from_secs(2);

/// An agent's name in a notification: at most this many characters.
const AGENT_MAX: usize = 60;

/// What a notification says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Happened {
    Done,
    Failed,
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub session: String,
    pub title: String,
    pub agent: String,
    pub happened: Happened,
}

/// What one event changes for the person.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Change {
    pub notice: Option<Notice>,
    /// The number of sessions waiting changed: the badge is drawn again.
    pub badge: bool,
}

#[derive(Default)]
struct Known {
    /// Session id → its last state.
    states: HashMap<String, String>,
    /// What the page last reported.
    page: u32,
}

impl Known {
    fn waiting(&self) -> usize {
        self.states.values().filter(|s| *s == "waiting").count()
    }
}

#[derive(Default)]
pub struct Attention {
    known: Mutex<Known>,
    /// The question on quitting is up.
    asking: AtomicBool,
}

/// At most `max` characters of one line.
fn one_line(text: &str, max: usize) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn text_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |at, key| at.get(key))
        .and_then(Value::as_str)
}

impl Attention {
    fn known(&self) -> std::sync::MutexGuard<'_, Known> {
        self.known.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One event from the runner.
    pub fn observe(&self, event: &Value) -> Change {
        match event.get("type").and_then(Value::as_str) {
            Some("session") => self.session(event.get("session").unwrap_or(&Value::Null)),
            Some("removed") => {
                let Some(id) = event.get("session").and_then(Value::as_str) else {
                    return Change::default();
                };
                let was = self.known().states.remove(id);
                Change {
                    notice: None,
                    badge: was.as_deref() == Some("waiting"),
                }
            }
            _ => Change::default(),
        }
    }

    fn session(&self, summary: &Value) -> Change {
        let (Some(id), Some(state)) = (text_at(summary, &["id"]), text_at(summary, &["state"]))
        else {
            return Change::default();
        };
        if !valid_local_session(id) {
            return Change::default();
        }
        let was = self
            .known()
            .states
            .insert(id.to_string(), state.to_string());
        let was = was.as_deref();
        let happened = match (was, state) {
            (Some("running" | "waiting"), "idle") => Some(Happened::Done),
            (Some("running" | "waiting"), "failed") => Some(Happened::Failed),
            (was, "waiting") if was != Some("waiting") => Some(Happened::Waiting),
            _ => None,
        };
        Change {
            notice: happened.map(|happened| Notice {
                session: id.to_string(),
                title: one_line(text_at(summary, &["title"]).unwrap_or(""), TITLE_MAX),
                agent: one_line(
                    text_at(summary, &["agent", "name"]).unwrap_or(""),
                    AGENT_MAX,
                ),
                happened,
            }),
            badge: (was == Some("waiting")) != (state == "waiting"),
        }
    }

    /// The runner went down; whether the badge changes.
    pub fn down(&self) -> bool {
        let mut known = self.known();
        let had = known.waiting() > 0;
        known.states.clear();
        had
    }

    pub fn set_page(&self, count: u32) {
        self.known().page = count;
    }

    /// The page's count and the sessions waiting, at most 999.
    pub fn badge(&self) -> u32 {
        let known = self.known();
        (u64::from(known.page) + known.waiting() as u64).min(BADGE_MAX) as u32
    }

    /// The sessions running or waiting, as the events said.
    pub fn busy(&self) -> usize {
        self.known()
            .states
            .values()
            .filter(|s| *s == "running" || *s == "waiting")
            .count()
    }

    /// Start asking on quit; `false` when the question is up already.
    fn begin_asking(&self) -> bool {
        !self.asking.swap(true, Ordering::SeqCst)
    }

    fn done_asking(&self) {
        self.asking.store(false, Ordering::SeqCst);
    }
}

/// Nothing is said while the person is looking at the Code page.
pub fn quiet(main_in_front: bool, page_watching: bool) -> bool {
    main_in_front && page_watching
}

/// The sessions running or waiting in an answer to `list`.
pub fn busy_in(list: &Value) -> Option<usize> {
    let sessions = list.get("sessions")?.as_array()?;
    Some(
        sessions
            .iter()
            .filter(|s| matches!(text_at(s, &["state"]), Some("running" | "waiting")))
            .count(),
    )
}

/// An event's `type`, without reading the rest of it.
#[derive(Deserialize)]
struct Kind<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a str>,
}

/// Wire the runner's stream to notifications and the badge. The tap runs on
/// the runner's reader thread; what it does to windows goes to the main one.
pub fn watch(app: &AppHandle) {
    let handle = app.clone();
    app.state::<Code>().runner.tap(move |seen| {
        let attention = handle.state::<Attention>();
        let change = match seen {
            Seen::Event(raw) => {
                let wanted = serde_json::from_str::<Kind<'_>>(raw.get())
                    .is_ok_and(|k| matches!(k.kind, Some("session" | "removed")));
                if !wanted {
                    return;
                }
                serde_json::from_str::<Value>(raw.get())
                    .map(|event| attention.observe(&event))
                    .unwrap_or_default()
            }
            Seen::Down => Change {
                notice: None,
                badge: attention.down(),
            },
        };
        if change.notice.is_none() && !change.badge {
            return;
        }
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if change.badge {
                draw_badge(&app);
            }
            if let Some(notice) = change.notice {
                notify(&app, notice);
            }
        });
    });
}

pub fn draw_badge(app: &AppHandle) {
    crate::commands::set_badge(app, app.state::<Attention>().badge());
}

fn notify(app: &AppHandle, notice: Notice) {
    let in_front = app
        .get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if quiet(in_front, app.state::<Code>().runner.watcher().watching()) {
        return;
    }
    let shell = app.state::<Shell>();
    let t = text(shell.lang);
    let word = match notice.happened {
        Happened::Done => t.code_done,
        Happened::Failed => t.code_failed,
        Happened::Waiting => t.code_waiting,
    };
    let body = if notice.agent.is_empty() {
        word.to_string()
    } else {
        format!("{} · {word}", notice.agent)
    };
    let title = if notice.title.is_empty() {
        t.app.to_string()
    } else {
        notice.title
    };
    let id = shell.remember_notification(Some(Opened::Code(notice.session)));
    if let Err(e) = app
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("qmo: notification: {e}");
    }
}

/// ⌘Q, the tray's Quit, and closing the last window where that quits:
/// with local sessions running or waiting, the system asks first
/// (「有 N 个会话在运行，退出会中止它们」). One question at a time.
pub fn quit(app: &AppHandle) {
    if !app.state::<Attention>().begin_asking() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let busy = running_now(&app);
        if busy == 0 {
            app.exit(0);
            return;
        }
        ask(app, busy);
    });
}

/// Asked of the runner when it is up (never started for this), else what
/// its events said. Blocking, at most two seconds.
fn running_now(app: &AppHandle) -> usize {
    let attention = app.state::<Attention>();
    let asked =
        app.state::<Code>()
            .runner
            .ask_if_up("list", Value::Object(Default::default()), QUIT_ASK);
    match asked {
        Some(Ok(raw)) => serde_json::from_str::<Value>(raw.get())
            .ok()
            .and_then(|list| busy_in(&list))
            .unwrap_or_else(|| attention.busy()),
        _ => attention.busy(),
    }
}

fn ask(app: AppHandle, busy: usize) {
    let t = text(app.state::<Shell>().lang);
    let mut dialog = app
        .dialog()
        .message(t.quit_busy.replace("{n}", &busy.to_string()))
        .title(t.quit_title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t.quit_anyway.to_string(),
            t.cancel.to_string(),
        ));
    // On the main window when it is on screen; a sheet on a hidden window
    // would never be seen.
    if let Some(main) = app
        .get_webview_window(MAIN)
        .filter(|w| w.is_visible().unwrap_or(false))
    {
        dialog = dialog.parent(&main);
    }
    let after = app.clone();
    dialog.show(move |quit| {
        after.state::<Attention>().done_asking();
        if quit {
            after.exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "cs_AbCdEfGhIjKlMnOpQrSt_-";
    const B: &str = "cs_BbCdEfGhIjKlMnOpQrSt_-";

    fn session(id: &str, state: &str) -> Value {
        json!({
            "v": 1,
            "type": "session",
            "session": {
                "id": id,
                "title": "改 README",
                "agent": {"id": "claude-code", "name": "Claude Code"},
                "state": state,
            },
        })
    }

    fn happened(attention: &Attention, id: &str, state: &str) -> Option<Happened> {
        attention
            .observe(&session(id, state))
            .notice
            .map(|n| n.happened)
    }

    #[test]
    fn a_turn_that_ends_or_asks_is_said_and_a_stop_is_not() {
        let attention = Attention::default();
        assert_eq!(happened(&attention, A, "running"), None);
        assert_eq!(happened(&attention, A, "waiting"), Some(Happened::Waiting));
        assert_eq!(happened(&attention, A, "waiting"), None, "said once");
        assert_eq!(happened(&attention, A, "running"), None);
        assert_eq!(happened(&attention, A, "idle"), Some(Happened::Done));
        assert_eq!(happened(&attention, A, "idle"), None);
        assert_eq!(happened(&attention, A, "running"), None);
        assert_eq!(happened(&attention, A, "failed"), Some(Happened::Failed));
        assert_eq!(happened(&attention, A, "running"), None);
        assert_eq!(
            happened(&attention, A, "interrupted"),
            None,
            "the person stopped it"
        );
        // From an answer still open to the end of the turn.
        assert_eq!(happened(&attention, B, "waiting"), Some(Happened::Waiting));
        assert_eq!(happened(&attention, B, "failed"), Some(Happened::Failed));
        // A session first heard of as idle (a rename) says nothing.
        let fresh = Attention::default();
        assert_eq!(happened(&fresh, A, "idle"), None);
        let notice = attention.observe(&session(A, "running"));
        assert_eq!(notice.notice, None);
        let notice = attention.observe(&session(A, "idle")).notice.unwrap();
        assert_eq!(
            notice,
            Notice {
                session: A.into(),
                title: "改 README".into(),
                agent: "Claude Code".into(),
                happened: Happened::Done,
            }
        );
    }

    #[test]
    fn what_is_not_a_local_session_event_changes_nothing() {
        let attention = Attention::default();
        for event in [
            json!({"type": "delta", "session": A, "text": "x"}),
            json!({"type": "session"}),
            json!({"type": "session", "session": {"id": A}}),
            json!({"type": "session", "session": {"id": "s-1", "state": "waiting"}}),
            json!({"type": "session", "session": {"id": 7, "state": "waiting"}}),
            json!({"type": "removed"}),
            json!({"type": "runner", "state": "down"}),
            json!([1]),
        ] {
            assert_eq!(attention.observe(&event), Change::default(), "{event}");
        }
        assert_eq!(attention.badge(), 0);
        assert_eq!(attention.busy(), 0);
    }

    #[test]
    fn the_badge_is_the_pages_count_and_the_sessions_waiting() {
        let attention = Attention::default();
        attention.set_page(3);
        assert_eq!(attention.badge(), 3);
        assert!(attention.observe(&session(A, "waiting")).badge);
        assert!(!attention.observe(&session(A, "waiting")).badge);
        assert!(attention.observe(&session(B, "waiting")).badge);
        assert_eq!(attention.badge(), 5);
        assert!(attention.observe(&session(A, "running")).badge);
        assert_eq!(attention.badge(), 4);
        assert!(!attention.observe(&session(A, "idle")).badge);
        // A deleted session takes its question with it.
        assert!(
            attention
                .observe(&json!({"type": "removed", "session": B}))
                .badge
        );
        assert!(
            !attention
                .observe(&json!({"type": "removed", "session": A}))
                .badge
        );
        assert_eq!(attention.badge(), 3);
        attention.set_page(999);
        attention.observe(&session(A, "waiting"));
        assert_eq!(attention.badge(), 999, "at most 999");
        attention.set_page(0);
        assert_eq!(attention.badge(), 1);
    }

    #[test]
    fn a_runner_that_goes_down_takes_its_sessions_with_it() {
        let attention = Attention::default();
        attention.observe(&session(A, "running"));
        assert!(!attention.down(), "nothing was waiting");
        attention.observe(&session(A, "waiting"));
        attention.observe(&session(B, "running"));
        assert_eq!(attention.busy(), 2);
        assert!(attention.down());
        assert_eq!((attention.busy(), attention.badge()), (0, 0));
        // Back up, the first word about a session is heard afresh.
        assert_eq!(happened(&attention, A, "idle"), None);
    }

    #[test]
    fn busy_counts_running_and_waiting() {
        let attention = Attention::default();
        for (id, state) in [(A, "running"), (B, "idle")] {
            attention.observe(&session(id, state));
        }
        assert_eq!(attention.busy(), 1);
        attention.observe(&session(B, "waiting"));
        assert_eq!(attention.busy(), 2);
        let list = json!({"sessions": [
            {"id": A, "state": "running"},
            {"id": B, "state": "waiting"},
            {"id": "cs_CbCdEfGhIjKlMnOpQrSt_-", "state": "idle"},
            {"id": "cs_DbCdEfGhIjKlMnOpQrSt_-", "state": "interrupted"},
            {"id": "cs_EbCdEfGhIjKlMnOpQrSt_-", "state": "failed"},
        ]});
        assert_eq!(busy_in(&list), Some(2));
        assert_eq!(busy_in(&json!({"sessions": []})), Some(0));
        assert_eq!(busy_in(&json!({"folders": []})), None);
        assert_eq!(busy_in(&json!({"sessions": "x"})), None);
    }

    #[test]
    fn quiet_only_with_the_code_page_in_front() {
        assert!(quiet(true, true));
        assert!(!quiet(true, false), "the main window shows Work");
        assert!(!quiet(false, true), "the window is behind or hidden");
        assert!(!quiet(false, false));
    }

    #[test]
    fn one_question_on_quit_at_a_time() {
        let attention = Attention::default();
        assert!(attention.begin_asking());
        assert!(!attention.begin_asking());
        attention.done_asking();
        assert!(attention.begin_asking());
    }

    #[test]
    fn titles_and_names_are_one_short_line() {
        let attention = Attention::default();
        attention.observe(&session(A, "running"));
        let mut event = session(A, "idle");
        event["session"]["title"] = json!(format!("一\n二{}", "字".repeat(200)));
        event["session"]["agent"]["name"] = json!("x".repeat(100));
        let notice = attention.observe(&event).notice.unwrap();
        assert!(notice.title.starts_with("一 二"));
        assert_eq!(notice.title.chars().count(), TITLE_MAX);
        assert_eq!(notice.agent.chars().count(), AGENT_MAX);
    }
}
