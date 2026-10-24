// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The arguments the hub's page may pass to the shell (qmo-app.md §5.2),
//! checked one by one before anything happens.
//!
//! The page is the hub's, and the hub is trusted to show what it shows, but
//! not to reach past its commands: every argument is read from the raw
//! invoke body, an unknown key, a wrong type, an over-long string or a number
//! out of range is refused, and nothing is coerced.

use serde_json::{Map, Value};
use url::Url;

use crate::{
    hub::{valid_session_id, Hub},
    layout::{BootLayout, Page, Palette, Side, ThemeChoice, LABELS_MAX, ROWS_MAX, SIDE_WIDTH_MAX},
};

pub const TITLE_MAX: usize = 120;
pub const BODY_MAX: usize = 300;
pub const BADGE_MAX: u64 = 999;

/// Why the shell turned a call down; the page gets it as the rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn invalid(message: impl Into<String>) -> Invalid {
    Invalid(message.into())
}

/// The body as an object with only `allowed` keys. Tauri sends `{}` for a call
/// without arguments.
fn object<'a>(body: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, Invalid> {
    let Value::Object(map) = body else {
        return Err(invalid("arguments must be an object"));
    };
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("unknown argument {key:?}")));
    }
    Ok(map)
}

/// An argument that is itself an object, with only `allowed` keys.
fn nested<'a>(
    value: &'a Value,
    name: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, Invalid> {
    let Value::Object(map) = value else {
        return Err(invalid(format!("{name} must be an object")));
    };
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("unknown key {key:?} in {name}")));
    }
    Ok(map)
}

/// A command that takes nothing.
pub fn no_arguments(body: &Value) -> Result<(), Invalid> {
    object(body, &[]).map(|_| ())
}

/// Text for a notification: at most `max` characters, no control characters
/// other than a line break in the body.
fn text(
    map: &Map<String, Value>,
    key: &str,
    max: usize,
    required: bool,
) -> Result<Option<String>, Invalid> {
    match map.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(Value::String(value)) => {
            if value.chars().count() > max {
                return Err(invalid(format!("{key} is longer than {max} characters")));
            }
            if value
                .chars()
                .any(|c| c.is_control() && !(c == '\n' && key == "body"))
            {
                return Err(invalid(format!("{key} has a control character")));
            }
            if required && value.trim().is_empty() {
                return Err(invalid(format!("{key} is empty")));
            }
            Ok(Some(value.clone()))
        }
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

fn session(map: &Map<String, Value>, required: bool) -> Result<Option<String>, Invalid> {
    match map.get("session") {
        None | Some(Value::Null) if !required => Ok(None),
        None | Some(Value::Null) => Err(invalid("session is required")),
        Some(Value::String(id)) if valid_session_id(id) => Ok(Some(id.clone())),
        Some(Value::String(_)) => Err(invalid("session must match [A-Za-z0-9_-]{1,128}")),
        Some(_) => Err(invalid("session must be a string")),
    }
}

/// `qmo_notify`: `title` ≤ 120, `body` ≤ 300, `session?`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notify {
    pub title: String,
    pub body: Option<String>,
    pub session: Option<String>,
}

pub fn notify(body: &Value) -> Result<Notify, Invalid> {
    let map = object(body, &["title", "body", "session"])?;
    Ok(Notify {
        title: text(map, "title", TITLE_MAX, true)?.unwrap_or_default(),
        body: text(map, "body", BODY_MAX, false)?.filter(|b| !b.is_empty()),
        session: session(map, false)?,
    })
}

/// `qmo_badge`: `count`, an integer from 0 to 999.
pub fn badge(body: &Value) -> Result<u32, Invalid> {
    let map = object(body, &["count"])?;
    match map.get("count") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(count) if count <= BADGE_MAX => Ok(count as u32),
            _ => Err(invalid("count must be an integer from 0 to 999")),
        },
        Some(_) => Err(invalid("count must be a number")),
        None => Err(invalid("count is required")),
    }
}

/// `qmo_open_session`: `session`.
pub fn open_session(body: &Value) -> Result<String, Invalid> {
    let map = object(body, &["session"])?;
    Ok(session(map, true)?.unwrap_or_default())
}

/// The calls only the hub's own page may make — `qmo_local_agents`,
/// `qmo_boot_layout` and `qmo_open_local_settings` — check the page that
/// made the call as well as the remote capability that let it through: it
/// has to be on the signed-in hub's origin.
pub fn from_hub(page: Option<&Url>, hub: Option<&Hub>) -> Result<(), Invalid> {
    match (page, hub) {
        (Some(page), Some(hub)) if hub.same_origin(page) => Ok(()),
        _ => Err(invalid("only the hub's pages may call this")),
    }
}

/// `qmo_local_agents`: `rescan?`, a boolean; absent or `null` is `false`.
pub fn local_agents(body: &Value) -> Result<bool, Invalid> {
    let map = object(body, &["rescan"])?;
    match map.get("rescan") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(rescan)) => Ok(*rescan),
        Some(_) => Err(invalid("rescan must be a boolean")),
    }
}

// ---- local sessions (qmo-local.md §4.5.1) --------------------------------

/// Local sessions are the main window's: the hub's page there, never quick
/// entry (same origin, other window) and never a local page.
pub fn local_caller(page: Option<&Url>, hub: Option<&Hub>, window: &str) -> Result<(), Invalid> {
    match from_hub(page, hub) {
        Ok(()) if window == crate::shell::MAIN => Ok(()),
        _ => Err(invalid(
            "only the hub's page in the main window may call this",
        )),
    }
}

/// What a checked call asks the runner: one of its methods (qmo-local.md §4.3.2)
/// and the parameters, built afresh from the checked values.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub params: Value,
}

fn call(method: &'static str, params: Value) -> Call {
    Call { method, params }
}

/// The ids the runtime catalog knows (`harness-backends.md` §1): the six a
/// session may name. Which of them this runner can drive is its answer to
/// `list` (`features.protocols`).
pub const AGENTS: [&str; 6] = ["claude-code", "codex", "gemini", "qwen", "opencode", "dsh"];

/// The four permission modes (qmo-local.md §4.4).
pub const MODES: [&str; 4] = ["off", "accept-edits", "auto", "full-access"];

pub const PROMPT_MAX: usize = 65_536;
pub const MESSAGE_MAX: usize = 500;
pub const PATH_MAX: usize = 1024;
pub const READ_LIMIT_MAX: u64 = 200;
/// The largest integer a JavaScript number holds exactly: `before` goes on
/// to the runner, which reads it as one.
const SAFE_INTEGER_MAX: u64 = (1 << 53) - 1;

/// Length as the page and the runner count it: UTF-16 code units, what a
/// JavaScript string's `length` is.
fn units(value: &str) -> usize {
    value.encode_utf16().count()
}

/// A string under `key` that `valid` accepts, required.
fn token(
    map: &Map<String, Value>,
    key: &str,
    valid: fn(&str) -> bool,
    shape: &str,
) -> Result<String, Invalid> {
    match map.get(key) {
        Some(Value::String(value)) if valid(value) => Ok(value.clone()),
        Some(Value::String(_)) => Err(invalid(format!("{key} must match {shape}"))),
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

fn id_chars(value: &str, extra: &[u8]) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || extra.contains(&b))
}

/// `cs_` and 22 base64url characters (qmo-local.md §4.3.6).
pub fn valid_local_session(id: &str) -> bool {
    id.len() == 25 && id.starts_with("cs_") && id_chars(&id[3..], &[])
}

/// 16 lower-case hexadecimal digits.
pub fn valid_folder(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `[A-Za-z0-9_.:-]{1,128}`.
pub fn valid_ask(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id_chars(id, b".:")
}

/// `[A-Za-z0-9_-]{1,64}`.
pub fn valid_client_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id_chars(id, &[])
}

fn local_session(map: &Map<String, Value>) -> Result<String, Invalid> {
    token(map, "session", valid_local_session, "cs_[A-Za-z0-9_-]{22}")
}

fn boolean(map: &Map<String, Value>, key: &str) -> Result<Option<bool>, Invalid> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid(format!("{key} must be a boolean"))),
    }
}

/// What a person says to an agent: 1–65,536 characters, no NUL.
fn prompt(map: &Map<String, Value>) -> Result<String, Invalid> {
    match map.get("text") {
        Some(Value::String(text)) => {
            if text.is_empty() {
                return Err(invalid("text is empty"));
            }
            if units(text) > PROMPT_MAX {
                return Err(invalid(format!(
                    "text is longer than {PROMPT_MAX} characters"
                )));
            }
            if text.contains('\0') {
                return Err(invalid("text has a NUL character"));
            }
            Ok(text.clone())
        }
        None | Some(Value::Null) => Err(invalid("text is required")),
        Some(_) => Err(invalid("text must be a string")),
    }
}

/// One line of words: at most `max` characters, no control characters.
fn line(map: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, Invalid> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            if units(value) > max {
                return Err(invalid(format!("{key} is longer than {max} characters")));
            }
            if value.chars().any(char::is_control) {
                return Err(invalid(format!("{key} has a control character")));
            }
            Ok(Some(value.clone()))
        }
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

/// An integer from `min` to `max` under `key`, if there is one.
fn ranged(map: &Map<String, Value>, key: &str, min: u64, max: u64) -> Result<Option<u64>, Invalid> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(value) if (min..=max).contains(&value) => Ok(Some(value)),
            _ => Err(invalid(format!(
                "{key} must be an integer from {min} to {max}"
            ))),
        },
        Some(_) => Err(invalid(format!("{key} must be a number"))),
    }
}

/// A file under a session's root as the page names one (qmo-local.md §4.5.3):
/// relative, at most 1024 characters, no NUL or control characters, not
/// starting with `/` or `-`, no empty, `.` or `..` segment. A backslash
/// counts as a separator too, so the rule is the same on Windows. The runner
/// still resolves it and keeps it inside the session's root.
pub fn valid_relative_path(path: &str) -> bool {
    !path.is_empty()
        && units(path) <= PATH_MAX
        && !path.chars().any(char::is_control)
        && !path.starts_with(['/', '\\', '-'])
        && path
            .split(['/', '\\'])
            .all(|segment| !matches!(segment, "" | "." | ".."))
        && !(cfg!(windows) && path.contains(':'))
}

/// `qmo_local_list`, `qmo_local_pick_folder`: nothing.
pub fn local_list(body: &Value) -> Result<Call, Invalid> {
    no_arguments(body)?;
    Ok(call("list", Value::Object(Map::new())))
}

/// `qmo_local_watch`: `channel`, the string a `window.__TAURI__.core.Channel`
/// turns into, `__CHANNEL__:<id>`. Returns it as given.
pub fn local_watch(body: &Value) -> Result<String, Invalid> {
    let map = object(body, &["channel"])?;
    token(map, "channel", valid_channel, "__CHANNEL__:<number>")
}

/// `__CHANNEL__:` and a callback id that fits 32 bits.
pub fn valid_channel(value: &str) -> bool {
    value
        .strip_prefix("__CHANNEL__:")
        .filter(|id| (1..=10).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()))
        .is_some_and(|id| id.parse::<u32>().is_ok())
}

/// `qmo_local_forget_folder`: `folder`.
pub fn local_forget_folder(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["folder"])?;
    let folder = token(map, "folder", valid_folder, "[0-9a-f]{16}")?;
    Ok(call(
        "folders.forget",
        serde_json::json!({ "folder": folder }),
    ))
}

/// Why `qmo_local_start` with `remote: true` is turned down: Remote comes
/// with P37.15 (qmo-local.md §4.5.6).
pub const REMOTE_CLOSED: &str = "未开放";

/// `qmo_local_start`: `folder`, `agent`, `mode`, `worktree`, `text`,
/// `clientId`, `remote?`. The runner answers a `worktree: true` it cannot
/// make yet; `remote` is `false` until P37.15, so the shell sends `false`.
/// `Ok(Err(..))` is a well-formed call asking for Remote.
pub fn local_start(body: &Value) -> Result<Result<Call, &'static str>, Invalid> {
    let map = object(
        body,
        &[
            "folder", "agent", "mode", "worktree", "text", "clientId", "remote",
        ],
    )?;
    let folder = token(map, "folder", valid_folder, "[0-9a-f]{16}")?;
    let agent = one_of(map, "agent", &AGENTS, true)?.unwrap_or_default();
    let mode = one_of(map, "mode", &MODES, true)?.unwrap_or_default();
    let worktree = boolean(map, "worktree")?.ok_or_else(|| invalid("worktree is required"))?;
    let text = prompt(map)?;
    let client_id = token(map, "clientId", valid_client_id, "[A-Za-z0-9_-]{1,64}")?;
    if boolean(map, "remote")? == Some(true) {
        return Ok(Err(REMOTE_CLOSED));
    }
    Ok(Ok(call(
        "session.start",
        serde_json::json!({
            "folder": folder,
            "agent": agent,
            "mode": mode,
            "worktree": worktree,
            "text": text,
            "clientId": client_id,
            "remote": false,
        }),
    )))
}

/// `qmo_local_send`: `session`, `text`, `clientId`; the shell adds
/// `origin: 'local'` (`'remote'` is the device link's, P37.15).
pub fn local_send(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["session", "text", "clientId"])?;
    let session = local_session(map)?;
    let text = prompt(map)?;
    let client_id = token(map, "clientId", valid_client_id, "[A-Za-z0-9_-]{1,64}")?;
    Ok(call(
        "session.send",
        serde_json::json!({
            "session": session,
            "text": text,
            "clientId": client_id,
            "origin": "local",
        }),
    ))
}

/// A call that takes a session and nothing else: `qmo_local_stop` and
/// `qmo_local_changes`.
fn session_only(body: &Value, method: &'static str) -> Result<Call, Invalid> {
    let map = object(body, &["session"])?;
    let session = local_session(map)?;
    Ok(call(method, serde_json::json!({ "session": session })))
}

pub fn local_stop(body: &Value) -> Result<Call, Invalid> {
    session_only(body, "session.stop")
}

pub fn local_changes(body: &Value) -> Result<Call, Invalid> {
    session_only(body, "session.changes")
}

/// `qmo_local_answer`: `session`, `ask`, `decision` (`once` / `session` /
/// `deny`), `message?` (at most 500 characters, one line).
pub fn local_answer(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["session", "ask", "decision", "message"])?;
    let session = local_session(map)?;
    let ask = token(map, "ask", valid_ask, "[A-Za-z0-9_.:-]{1,128}")?;
    let decision = one_of(map, "decision", &["once", "session", "deny"], true)?.unwrap_or_default();
    let mut params = Map::new();
    params.insert("session".into(), Value::String(session));
    params.insert("ask".into(), Value::String(ask));
    params.insert("decision".into(), Value::String(decision.into()));
    if let Some(message) = line(map, "message", MESSAGE_MAX)? {
        params.insert("message".into(), Value::String(message));
    }
    Ok(call("session.answer", Value::Object(params)))
}

/// `qmo_local_set_mode`: `session`, `mode`.
pub fn local_set_mode(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["session", "mode"])?;
    let session = local_session(map)?;
    let mode = one_of(map, "mode", &MODES, true)?.unwrap_or_default();
    Ok(call(
        "session.mode",
        serde_json::json!({ "session": session, "mode": mode }),
    ))
}

/// `qmo_local_read`: `session`, `before?` (a record's `seq`, a positive
/// integer), `limit?` (1–200; the runner's default is 100).
pub fn local_read(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["session", "before", "limit"])?;
    let session = local_session(map)?;
    let mut params = Map::new();
    params.insert("session".into(), Value::String(session));
    if let Some(before) = ranged(map, "before", 1, SAFE_INTEGER_MAX)? {
        params.insert("before".into(), before.into());
    }
    if let Some(limit) = ranged(map, "limit", 1, READ_LIMIT_MAX)? {
        params.insert("limit".into(), limit.into());
    }
    Ok(call("session.read", Value::Object(params)))
}

/// `qmo_local_diff`: `session`, `path` (`valid_relative_path`).
pub fn local_diff(body: &Value) -> Result<Call, Invalid> {
    let map = object(body, &["session", "path"])?;
    let session = local_session(map)?;
    let path = token(
        map,
        "path",
        valid_relative_path,
        "a relative path inside the session's folder",
    )?;
    Ok(call(
        "session.diff",
        serde_json::json!({ "session": session, "path": path }),
    ))
}

/// `qmo_local_set_remote`: `session`, `on`. Checked, then turned down until
/// P37.15.
pub fn local_set_remote(body: &Value) -> Result<(), Invalid> {
    let map = object(body, &["session", "on"])?;
    local_session(map)?;
    boolean(map, "on")?.ok_or_else(|| invalid("on is required"))?;
    Ok(())
}

/// The colours a layout report carries: the page and side panel colours of
/// the appearance the page is showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reported {
    pub layout: BootLayout,
    /// `(dark, palette)`; `None` leaves the kept palettes as they are.
    pub colours: Option<(bool, Palette)>,
}

/// One of `values` under `key`; `None` when absent and not `required`.
fn one_of<'a>(
    map: &Map<String, Value>,
    key: &str,
    values: &[&'a str],
    required: bool,
) -> Result<Option<&'a str>, Invalid> {
    match map.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(Value::String(value)) => match values.iter().find(|v| **v == value) {
            Some(found) => Ok(Some(*found)),
            None => Err(invalid(format!(
                "{key} must be one of {}",
                values.join(", ")
            ))),
        },
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

/// A whole number from 0 to `max` under `key`, required.
fn whole(map: &Map<String, Value>, key: &str, max: u32) -> Result<u32, Invalid> {
    match map.get(key) {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(value) if value <= u64::from(max) => Ok(value as u32),
            _ => Err(invalid(format!("{key} must be an integer from 0 to {max}"))),
        },
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(_) => Err(invalid(format!("{key} must be a number"))),
    }
}

/// A `#rrggbb` under `key` in `colors`, required.
fn colour<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, Invalid> {
    match map.get(key) {
        Some(Value::String(value)) if crate::layout::is_hex_colour(value) => Ok(value),
        Some(Value::String(_)) => Err(invalid(format!("colors.{key} must be #rrggbb"))),
        None | Some(Value::Null) => Err(invalid(format!("colors.{key} is required"))),
        Some(_) => Err(invalid(format!("colors.{key} must be a string"))),
    }
}

/// `qmo_boot_layout`: `layout`, the side panel as the page laid it out
/// (qmo-local.md §3.5) — `page` (`chat` / `agents` / `code`), `side`
/// (`open` / `closed`), `sideWidth` 0–1000, `rows` 0–60, `labels` 0–20,
/// `theme?` (`system` / `light` / `dark`, default `system`) — and `colors?`,
/// `{dark, page, sidebar}` with both colours `#rrggbb`.
pub fn boot_layout(body: &Value) -> Result<Reported, Invalid> {
    let map = object(body, &["layout"])?;
    let Some(layout) = map.get("layout") else {
        return Err(invalid("layout is required"));
    };
    let fields = nested(
        layout,
        "layout",
        &[
            "page",
            "side",
            "sideWidth",
            "rows",
            "labels",
            "theme",
            "colors",
        ],
    )?;
    let page = one_of(fields, "page", &["chat", "agents", "code"], true)?
        .and_then(Page::parse)
        .ok_or_else(|| invalid("page is required"))?;
    let side = one_of(fields, "side", &["open", "closed"], true)?
        .and_then(Side::parse)
        .ok_or_else(|| invalid("side is required"))?;
    let theme = one_of(fields, "theme", &["system", "light", "dark"], false)?
        .and_then(ThemeChoice::parse)
        .unwrap_or(ThemeChoice::System);
    let layout = BootLayout {
        page,
        side,
        side_width: whole(fields, "sideWidth", SIDE_WIDTH_MAX)?,
        rows: whole(fields, "rows", ROWS_MAX)?,
        labels: whole(fields, "labels", LABELS_MAX)?,
        theme,
    };
    let colours = match fields.get("colors") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let colors = nested(value, "colors", &["dark", "page", "sidebar"])?;
            let dark = match colors.get("dark") {
                Some(Value::Bool(dark)) => *dark,
                None | Some(Value::Null) => return Err(invalid("colors.dark is required")),
                Some(_) => return Err(invalid("colors.dark must be a boolean")),
            };
            let palette = Palette::new(colour(colors, "page")?, colour(colors, "sidebar")?)
                .ok_or_else(|| invalid("colors must be #rrggbb"))?;
            Some((dark, palette))
        }
    };
    Ok(Reported { layout, colours })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_without_arguments_take_an_empty_object_only() {
        assert!(no_arguments(&json!({})).is_ok());
        assert!(no_arguments(&json!({"x": 1})).is_err());
        assert!(no_arguments(&json!([])).is_err());
        assert!(no_arguments(&json!(null)).is_err());
        assert!(no_arguments(&json!("x")).is_err());
    }

    #[test]
    fn notify_checks_each_field() {
        assert_eq!(
            notify(&json!({"title": "回复", "body": "第一行\n第二行", "session": "s-1"})).unwrap(),
            Notify {
                title: "回复".into(),
                body: Some("第一行\n第二行".into()),
                session: Some("s-1".into()),
            }
        );
        assert_eq!(
            notify(&json!({"title": "t"})).unwrap(),
            Notify {
                title: "t".into(),
                body: None,
                session: None
            }
        );
        assert_eq!(
            notify(&json!({"title": "t", "body": ""})).unwrap().body,
            None
        );
        assert_eq!(
            notify(&json!({"title": "t", "session": null}))
                .unwrap()
                .session,
            None
        );
        // Characters, not bytes: 120 Chinese characters are fine.
        assert!(notify(&json!({"title": "字".repeat(120)})).is_ok());
        assert!(notify(&json!({"title": "字".repeat(121)})).is_err());
        assert!(notify(&json!({"title": "t", "body": "x".repeat(300)})).is_ok());
        assert!(notify(&json!({"title": "t", "body": "x".repeat(301)})).is_err());
        for bad in [
            json!({}),
            json!({"title": ""}),
            json!({"title": "   "}),
            json!({"title": 1}),
            json!({"title": "a\nb"}),
            json!({"title": "a\u{0007}"}),
            json!({"title": "t", "body": 5}),
            json!({"title": "t", "body": "a\u{001b}[31m"}),
            json!({"title": "t", "session": "a/b"}),
            json!({"title": "t", "session": 7}),
            json!({"title": "t", "icon": "/etc/passwd"}),
            json!(["t"]),
        ] {
            assert!(notify(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn badge_is_an_integer_from_0_to_999() {
        assert_eq!(badge(&json!({"count": 0})).unwrap(), 0);
        assert_eq!(badge(&json!({"count": 999})).unwrap(), 999);
        for bad in [
            json!({"count": 1000}),
            json!({"count": -1}),
            json!({"count": 2.5}),
            json!({"count": "3"}),
            json!({"count": null}),
            json!({}),
            json!({"count": 1, "label": "x"}),
        ] {
            assert!(badge(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn open_session_needs_a_valid_id() {
        assert_eq!(
            open_session(&json!({"session": "abc_DEF-1"})).unwrap(),
            "abc_DEF-1"
        );
        for bad in [
            json!({}),
            json!({"session": ""}),
            json!({"session": "x".repeat(129)}),
            json!({"session": "../admin"}),
            json!({"session": "a?b=c"}),
            json!({"session": 1}),
            json!({"session": "a", "url": "https://evil.com"}),
        ] {
            assert!(open_session(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_hubs_own_pages_pass() {
        let hub = crate::hub::parse_hub("https://hub.example.com").unwrap();
        let page = |s: &str| Url::parse(s).unwrap();
        for good in [
            "https://hub.example.com/app",
            "https://hub.example.com/code",
            "https://hub.example.com/app/quick",
            "https://hub.example.com/admin/models?x=1#y",
        ] {
            assert!(from_hub(Some(&page(good)), Some(&hub)).is_ok(), "{good}");
        }
        for bad in [
            "tauri://localhost/skeleton.html",
            "http://tauri.localhost/offline.html",
            "about:blank",
            "https://evil.example.com/app",
            "http://hub.example.com/app",
            "https://hub.example.com:8443/app",
            "https://x.hub.example.com/app",
        ] {
            assert!(from_hub(Some(&page(bad)), Some(&hub)).is_err(), "{bad}");
        }
        assert!(from_hub(Some(&page("https://hub.example.com/app")), None).is_err());
        assert!(from_hub(None, Some(&hub)).is_err());
    }

    #[test]
    fn local_agents_takes_rescan_only() {
        assert!(!local_agents(&json!({})).unwrap());
        assert!(!local_agents(&json!({"rescan": null})).unwrap());
        assert!(!local_agents(&json!({"rescan": false})).unwrap());
        assert!(local_agents(&json!({"rescan": true})).unwrap());
        for bad in [
            json!({"rescan": "true"}),
            json!({"rescan": 1}),
            json!({"rescan": []}),
            json!({"rescan": true, "path": "/usr/bin"}),
            json!({"args": ["--acp"]}),
            json!([true]),
            json!(null),
            json!(true),
        ] {
            assert!(local_agents(&bad).is_err(), "{bad}");
        }
    }

    fn layout_with(change: impl FnOnce(&mut Map<String, Value>)) -> Value {
        let mut layout = json!({
            "page": "chat",
            "side": "open",
            "sideWidth": 288,
            "rows": 12,
            "labels": 3,
            "theme": "system",
            "colors": {"dark": false, "page": "#F9F9F7", "sidebar": "#fcfcfb"}
        });
        change(layout.as_object_mut().unwrap());
        json!({ "layout": layout })
    }

    #[test]
    fn a_layout_reads_field_by_field() {
        let read = boot_layout(&layout_with(|_| {})).unwrap();
        assert_eq!(
            read,
            Reported {
                layout: BootLayout {
                    page: Page::Chat,
                    side: Side::Open,
                    side_width: 288,
                    rows: 12,
                    labels: 3,
                    theme: ThemeChoice::System,
                },
                colours: Some((false, Palette::new("#f9f9f7", "#fcfcfb").unwrap())),
            }
        );
        // Colours are kept in lower case.
        assert_eq!(read.colours.unwrap().1.page, "#f9f9f7");
        for (page, parsed) in [
            ("chat", Page::Chat),
            ("agents", Page::Agents),
            ("code", Page::Code),
        ] {
            let read = boot_layout(&layout_with(|m| {
                m.insert("page".into(), json!(page));
            }))
            .unwrap();
            assert_eq!(read.layout.page, parsed);
        }
        let dark = boot_layout(&layout_with(|m| {
            m.insert("side".into(), json!("closed"));
            m.insert("theme".into(), json!("dark"));
            m.insert(
                "colors".into(),
                json!({"dark": true, "page": "#0b0b0b", "sidebar": "#090909"}),
            );
        }))
        .unwrap();
        assert_eq!(dark.layout.side, Side::Closed);
        assert_eq!(dark.layout.theme, ThemeChoice::Dark);
        assert_eq!(
            dark.colours,
            Some((true, Palette::new("#0b0b0b", "#090909").unwrap()))
        );
        // `theme` and `colors` may be left out (or null).
        let bare = boot_layout(&layout_with(|m| {
            m.remove("theme");
            m.remove("colors");
        }))
        .unwrap();
        assert_eq!(bare.layout.theme, ThemeChoice::System);
        assert_eq!(bare.colours, None);
        let nulls = boot_layout(&layout_with(|m| {
            m.insert("theme".into(), Value::Null);
            m.insert("colors".into(), Value::Null);
        }))
        .unwrap();
        assert_eq!(nulls, bare);
        // The ends of each range.
        let ends = boot_layout(&layout_with(|m| {
            m.insert("sideWidth".into(), json!(1000));
            m.insert("rows".into(), json!(60));
            m.insert("labels".into(), json!(20));
        }))
        .unwrap();
        assert_eq!(
            (ends.layout.side_width, ends.layout.rows, ends.layout.labels),
            (1000, 60, 20)
        );
        let zeros = boot_layout(&layout_with(|m| {
            m.insert("sideWidth".into(), json!(0));
            m.insert("rows".into(), json!(0));
            m.insert("labels".into(), json!(0));
        }))
        .unwrap();
        assert_eq!(
            (
                zeros.layout.side_width,
                zeros.layout.rows,
                zeros.layout.labels
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn a_layout_out_of_shape_is_refused() {
        type Change = fn(&mut Map<String, Value>);
        let cases: Vec<(&str, Change)> = vec![
            ("admin is no longer a face", |m| {
                m.insert("page".into(), json!("admin"));
            }),
            ("page unknown", |m| {
                m.insert("page".into(), json!("settings"));
            }),
            ("page missing", |m| {
                m.remove("page");
            }),
            ("page a number", |m| {
                m.insert("page".into(), json!(1));
            }),
            ("side unknown", |m| {
                m.insert("side".into(), json!("half"));
            }),
            ("side missing", |m| {
                m.remove("side");
            }),
            ("theme unknown", |m| {
                m.insert("theme".into(), json!("sepia"));
            }),
            ("sideWidth too wide", |m| {
                m.insert("sideWidth".into(), json!(1001));
            }),
            ("sideWidth negative", |m| {
                m.insert("sideWidth".into(), json!(-1));
            }),
            ("sideWidth fractional", |m| {
                m.insert("sideWidth".into(), json!(288.5));
            }),
            ("sideWidth a float", |m| {
                m.insert("sideWidth".into(), json!(288.0));
            }),
            ("sideWidth a string", |m| {
                m.insert("sideWidth".into(), json!("288"));
            }),
            ("sideWidth missing", |m| {
                m.remove("sideWidth");
            }),
            ("rows over 60", |m| {
                m.insert("rows".into(), json!(61));
            }),
            ("rows null", |m| {
                m.insert("rows".into(), Value::Null);
            }),
            ("labels over 20", |m| {
                m.insert("labels".into(), json!(21));
            }),
            ("labels huge", |m| {
                m.insert("labels".into(), json!(u64::MAX));
            }),
            ("an unknown key", |m| {
                m.insert("mode".into(), json!("work"));
            }),
            ("colors not an object", |m| {
                m.insert("colors".into(), json!("#ffffff"));
            }),
            ("colors without dark", |m| {
                m.insert(
                    "colors".into(),
                    json!({"page": "#ffffff", "sidebar": "#ffffff"}),
                );
            }),
            ("colors.dark a string", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": "true", "page": "#ffffff", "sidebar": "#ffffff"}),
                );
            }),
            ("short hex", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "#fff", "sidebar": "#ffffff"}),
                );
            }),
            ("hex with alpha", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "#ffffff", "sidebar": "#ffffff80"}),
                );
            }),
            ("a colour name", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "white", "sidebar": "#ffffff"}),
                );
            }),
            ("css in a colour", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "#fff;}body{x", "sidebar": "#ffffff"}),
                );
            }),
            ("not hex digits", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "#gggggg", "sidebar": "#ffffff"}),
                );
            }),
            ("sidebar missing", |m| {
                m.insert("colors".into(), json!({"dark": false, "page": "#ffffff"}));
            }),
            ("a colour a number", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": 16777215, "sidebar": "#ffffff"}),
                );
            }),
            ("an unknown colour key", |m| {
                m.insert(
                    "colors".into(),
                    json!({"dark": false, "page": "#ffffff", "sidebar": "#ffffff", "accent": "#ff0000"}),
                );
            }),
        ];
        for (what, change) in cases {
            assert!(boot_layout(&layout_with(change)).is_err(), "{what}");
        }
        for bad in [
            json!({}),
            json!({"layout": null}),
            json!({"layout": []}),
            json!({"layout": "chat"}),
            json!({"page": "chat", "side": "open", "sideWidth": 288, "rows": 1, "labels": 0}),
            json!([]),
        ] {
            assert!(boot_layout(&bad).is_err(), "{bad}");
        }
        let mut extra = layout_with(|_| {});
        extra
            .as_object_mut()
            .unwrap()
            .insert("save".into(), json!(true));
        assert!(boot_layout(&extra).is_err(), "an unknown argument");
    }

    // ---- local sessions ---------------------------------------------------

    const SESSION: &str = "cs_AbCdEfGhIjKlMnOpQrSt_-";
    const FOLDER: &str = "0123456789abcdef";

    /// Values every id-like argument must refuse: wrong shapes, traversal,
    /// option-like, control characters, wrong types.
    fn bad_ids() -> Vec<Value> {
        vec![
            json!(""),
            json!("../etc"),
            json!("-rf"),
            json!("a\u{0000}b"),
            json!("a\nb"),
            json!("a b"),
            json!(1),
            json!(true),
            json!(["x"]),
            json!({"id": "x"}),
            Value::Null,
        ]
    }

    fn with(base: &Value, key: &str, value: Value) -> Value {
        let mut body = base.clone();
        body.as_object_mut().unwrap().insert(key.into(), value);
        body
    }

    fn without(base: &Value, key: &str) -> Value {
        let mut body = base.clone();
        body.as_object_mut().unwrap().remove(key);
        body
    }

    #[test]
    fn local_ids_have_their_shapes() {
        assert!(valid_local_session(SESSION));
        assert_eq!(SESSION.len(), 25);
        for bad in [
            "",
            "cs_",
            "cs_AbCdEfGhIjKlMnOpQrSt_",
            "cs_AbCdEfGhIjKlMnOpQrSt_-x",
            "CS_AbCdEfGhIjKlMnOpQrSt_-",
            "xs_AbCdEfGhIjKlMnOpQrSt_-",
            "cs_AbCdEfGhIjKlMnOpQrSt/-",
            "cs_AbCdEfGhIjKlMnOpQrSt.-",
            "cs_AbCdEfGhIjKlMnOpQrSt\u{e9}",
            "../../../../../../../etc",
        ] {
            assert!(!valid_local_session(bad), "{bad:?}");
        }
        assert!(valid_folder(FOLDER));
        for bad in [
            "",
            "0123456789abcde",
            "0123456789abcdef0",
            "0123456789ABCDEF",
            "0123456789abcdeg",
            "../3456789abcdef",
        ] {
            assert!(!valid_folder(bad), "{bad:?}");
        }
        for good in ["a", "toolu_01:ask.2-x", &"a".repeat(128)] {
            assert!(valid_ask(good), "{good:?}");
        }
        for bad in ["", &"a".repeat(129), "a/b", "a b", "a\u{7}"] {
            assert!(!valid_ask(bad), "{bad:?}");
        }
        for good in ["c", "c-1_X", &"c".repeat(64)] {
            assert!(valid_client_id(good), "{good:?}");
        }
        for bad in ["", &"c".repeat(65), "c.1", "c:1", "c/1"] {
            assert!(!valid_client_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn local_paths_stay_relative_and_plain() {
        for good in [
            "src/app.ts",
            "README.md",
            "a/b/c/d.txt",
            "dir with space/文件.md",
            ".github/workflows/ci.yml",
            "a/.hidden",
            "a/b-",
            &"x".repeat(1024),
        ] {
            assert!(valid_relative_path(good), "{good:?}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "\\etc\\passwd",
            "-rf",
            "--output=x",
            "../secret",
            "a/../../b",
            "a/..",
            "./a",
            "a/./b",
            "a//b",
            "a/",
            "a\\..\\b",
            "a\u{0000}b",
            "a\nb",
            "a\tb",
            "a\u{1b}[31m",
            "a\u{85}b",
            &"x".repeat(1025),
        ] {
            assert!(!valid_relative_path(bad), "{bad:?}");
        }
        // 1024 counted as the page counts: UTF-16 code units.
        assert!(valid_relative_path(&"字".repeat(1024)));
        assert!(!valid_relative_path(&"😀".repeat(513)));
    }

    #[test]
    fn the_local_caller_is_the_hubs_main_window() {
        let hub = crate::hub::parse_hub("https://hub.example.com").unwrap();
        let page = |s: &str| Url::parse(s).unwrap();
        let code = page("https://hub.example.com/code?session=x");
        assert!(local_caller(Some(&code), Some(&hub), "main").is_ok());
        // Quick entry is on the hub's origin but is not the main window.
        assert!(local_caller(Some(&code), Some(&hub), "quick").is_err());
        assert!(local_caller(Some(&code), Some(&hub), "settings").is_err());
        assert!(local_caller(Some(&code), Some(&hub), "").is_err());
        for other in [
            "tauri://localhost/skeleton.html",
            "http://tauri.localhost/offline.html",
            "tauri://localhost/settings.html",
            "about:blank",
            "https://evil.example.com/code",
            "http://hub.example.com/code",
            "https://hub.example.com.evil.com/code",
        ] {
            assert!(
                local_caller(Some(&page(other)), Some(&hub), "main").is_err(),
                "{other}"
            );
        }
        assert!(local_caller(None, Some(&hub), "main").is_err());
        assert!(local_caller(Some(&code), None, "main").is_err());
    }

    #[test]
    fn list_and_pick_folder_take_nothing() {
        assert_eq!(
            local_list(&json!({})).unwrap(),
            Call {
                method: "list",
                params: json!({})
            }
        );
        for bad in [
            json!({"x": 1}),
            json!({"path": "/"}),
            json!([]),
            json!(null),
            json!("x"),
        ] {
            assert!(local_list(&bad).is_err(), "{bad}");
            assert!(no_arguments(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn watch_takes_a_channel_string_only() {
        assert_eq!(
            local_watch(&json!({"channel": "__CHANNEL__:7"})).unwrap(),
            "__CHANNEL__:7"
        );
        assert_eq!(
            local_watch(&json!({"channel": "__CHANNEL__:4294967295"})).unwrap(),
            "__CHANNEL__:4294967295"
        );
        // What Tauri itself reads it as.
        use std::str::FromStr;
        assert!(tauri::ipc::JavaScriptChannelId::from_str("__CHANNEL__:4294967295").is_ok());
        for bad in [
            json!({}),
            json!({"channel": null}),
            json!({"channel": 7}),
            json!({"channel": "7"}),
            json!({"channel": "__CHANNEL__:"}),
            json!({"channel": "__CHANNEL__:-1"}),
            json!({"channel": "__CHANNEL__:+1"}),
            json!({"channel": "__CHANNEL__: 1"}),
            json!({"channel": "__CHANNEL__:1 "}),
            json!({"channel": "__CHANNEL__:1.5"}),
            json!({"channel": "__CHANNEL__:0x10"}),
            json!({"channel": "__CHANNEL__:4294967296"}),
            json!({"channel": "__CHANNEL__:99999999999"}),
            json!({"channel": "__channel__:1"}),
            json!({"channel": "x__CHANNEL__:1"}),
            json!({"channel": "__CHANNEL__:1\n"}),
            json!({"channel": {"id": 1}}),
            json!({"channel": "__CHANNEL__:1", "session": SESSION}),
            json!(["__CHANNEL__:1"]),
        ] {
            assert!(local_watch(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn forget_folder_takes_a_folder_id() {
        assert_eq!(
            local_forget_folder(&json!({ "folder": FOLDER })).unwrap(),
            Call {
                method: "folders.forget",
                params: json!({ "folder": FOLDER })
            }
        );
        for value in bad_ids() {
            assert!(
                local_forget_folder(&json!({ "folder": value })).is_err(),
                "{value}"
            );
        }
        assert!(local_forget_folder(&json!({})).is_err());
        assert!(local_forget_folder(&json!({"folder": FOLDER, "path": "/"})).is_err());
        assert!(local_forget_folder(&json!({ "folder": "/Users/x/project" })).is_err());
    }

    fn start_body() -> Value {
        json!({
            "folder": FOLDER,
            "agent": "claude-code",
            "mode": "auto",
            "worktree": false,
            "text": "改一下 README",
            "clientId": "c-1",
        })
    }

    #[test]
    fn start_reads_field_by_field() {
        assert_eq!(
            local_start(&start_body()).unwrap().unwrap(),
            Call {
                method: "session.start",
                params: json!({
                    "folder": FOLDER,
                    "agent": "claude-code",
                    "mode": "auto",
                    "worktree": false,
                    "text": "改一下 README",
                    "clientId": "c-1",
                    "remote": false,
                })
            }
        );
        // Every agent of the catalog and every mode; worktree passes on
        // (the runner says when it cannot make one); remote false or absent.
        for agent in AGENTS {
            for mode in MODES {
                let body = with(
                    &with(&start_body(), "agent", json!(agent)),
                    "mode",
                    json!(mode),
                );
                let call = local_start(&body).unwrap().unwrap();
                assert_eq!(call.params["agent"], agent);
                assert_eq!(call.params["mode"], mode);
            }
        }
        let worktree = local_start(&with(&start_body(), "worktree", json!(true)))
            .unwrap()
            .unwrap();
        assert_eq!(worktree.params["worktree"], true);
        for remote in [json!(false), Value::Null] {
            let call = local_start(&with(&start_body(), "remote", remote))
                .unwrap()
                .unwrap();
            assert_eq!(call.params["remote"], false);
        }
        assert_eq!(
            local_start(&with(&start_body(), "remote", json!(true))).unwrap(),
            Err(REMOTE_CLOSED)
        );
        // Text: 1 to 65,536 UTF-16 code units, line breaks and tabs fine.
        for text in [
            "x".to_string(),
            "第一行\n第二行\t缩进".to_string(),
            "x".repeat(PROMPT_MAX),
            "字".repeat(PROMPT_MAX),
            "😀".repeat(PROMPT_MAX / 2),
        ] {
            assert!(
                local_start(&with(&start_body(), "text", json!(text))).is_ok(),
                "{} units",
                text.encode_utf16().count()
            );
        }
    }

    #[test]
    fn start_out_of_shape_is_refused() {
        let base = start_body();
        let mut bad: Vec<(String, Value)> = Vec::new();
        for key in ["folder", "agent", "mode", "worktree", "text", "clientId"] {
            bad.push((format!("{key} missing"), without(&base, key)));
            bad.push((format!("{key} null"), with(&base, key, Value::Null)));
        }
        for value in bad_ids() {
            bad.push((
                format!("folder {value}"),
                with(&base, "folder", value.clone()),
            ));
            // `[A-Za-z0-9_-]` lets a client id start with `-`; it is only ever
            // a value in the record, never an argument.
            if value != json!("-rf") {
                bad.push((format!("clientId {value}"), with(&base, "clientId", value)));
            }
        }
        for agent in [
            "omp",
            "qianmopi",
            "cursor",
            "Claude Code",
            "claude",
            "/usr/bin/claude",
            "",
        ] {
            bad.push((format!("agent {agent}"), with(&base, "agent", json!(agent))));
        }
        for mode in [
            "default",
            "bypassPermissions",
            "acceptEdits",
            "AUTO",
            "yolo",
            "",
        ] {
            bad.push((format!("mode {mode}"), with(&base, "mode", json!(mode))));
        }
        for worktree in [json!("true"), json!(1), json!([])] {
            bad.push((
                format!("worktree {worktree}"),
                with(&base, "worktree", worktree),
            ));
        }
        for remote in [json!("false"), json!(0)] {
            bad.push((format!("remote {remote}"), with(&base, "remote", remote)));
        }
        for text in [
            json!(""),
            json!("x".repeat(PROMPT_MAX + 1)),
            json!("😀".repeat(PROMPT_MAX / 2 + 1)),
            json!("a\u{0000}b"),
            json!(5),
            json!(["x"]),
        ] {
            bad.push(("text".into(), with(&base, "text", text)));
        }
        bad.push((
            "clientId 65".into(),
            with(&base, "clientId", json!("c".repeat(65))),
        ));
        bad.push((
            "an unknown key".into(),
            with(&base, "path", json!("/Users/x")),
        ));
        bad.push(("cwd".into(), with(&base, "cwd", json!("/"))));
        bad.push((
            "args".into(),
            with(&base, "args", json!(["--dangerously-skip-permissions"])),
        ));
        bad.push(("not an object".into(), json!([base.clone()])));
        for (what, body) in bad {
            assert!(local_start(&body).is_err(), "{what}");
        }
    }

    #[test]
    fn send_adds_the_origin() {
        let base = json!({"session": SESSION, "text": "继续", "clientId": "c2"});
        assert_eq!(
            local_send(&base).unwrap(),
            Call {
                method: "session.send",
                params: json!({"session": SESSION, "text": "继续", "clientId": "c2", "origin": "local"})
            }
        );
        let mut bad = vec![
            without(&base, "session"),
            without(&base, "text"),
            without(&base, "clientId"),
            with(&base, "text", json!("")),
            with(&base, "text", json!("x".repeat(PROMPT_MAX + 1))),
            with(&base, "text", json!("\u{0000}")),
            with(&base, "origin", json!("remote")),
            with(&base, "origin", json!("local")),
            with(&base, "folder", json!(FOLDER)),
        ];
        for value in bad_ids() {
            bad.push(with(&base, "session", value.clone()));
            if value != json!("-rf") {
                bad.push(with(&base, "clientId", value));
            }
        }
        for body in bad {
            assert!(local_send(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn stop_and_changes_take_a_session_only() {
        for (check, method) in [
            (
                local_stop as fn(&Value) -> Result<Call, Invalid>,
                "session.stop",
            ),
            (local_changes, "session.changes"),
        ] {
            assert_eq!(
                check(&json!({ "session": SESSION })).unwrap(),
                Call {
                    method,
                    params: json!({ "session": SESSION })
                }
            );
            for value in bad_ids() {
                assert!(
                    check(&json!({ "session": value })).is_err(),
                    "{method} {value}"
                );
            }
            assert!(check(&json!({})).is_err());
            assert!(check(&json!({"session": SESSION, "path": "a"})).is_err());
            assert!(
                check(&json!({"session": "s-1"})).is_err(),
                "a conversation id is not a local session"
            );
        }
    }

    #[test]
    fn answer_reads_field_by_field() {
        let base = json!({"session": SESSION, "ask": "toolu_01:1", "decision": "once"});
        assert_eq!(
            local_answer(&base).unwrap(),
            Call {
                method: "session.answer",
                params: base.clone()
            }
        );
        for decision in ["once", "session", "deny"] {
            assert!(local_answer(&with(&base, "decision", json!(decision))).is_ok());
        }
        let denied = with(
            &with(&base, "decision", json!("deny")),
            "message",
            json!("别动这个文件"),
        );
        assert_eq!(
            local_answer(&denied).unwrap().params["message"],
            "别动这个文件"
        );
        assert!(local_answer(&with(&base, "message", json!("字".repeat(500)))).is_ok());
        // A null message is no message.
        let none = local_answer(&with(&base, "message", Value::Null)).unwrap();
        assert!(none.params.get("message").is_none());
        let mut bad = vec![
            without(&base, "ask"),
            without(&base, "decision"),
            with(&base, "decision", json!("always")),
            with(&base, "decision", json!("allow")),
            with(&base, "decision", json!("acceptWithExecpolicyAmendment")),
            with(&base, "decision", json!(true)),
            with(&base, "ask", json!("a".repeat(129))),
            with(&base, "ask", json!("a b")),
            with(&base, "message", json!("字".repeat(501))),
            with(&base, "message", json!("两行\n附言")),
            with(&base, "message", json!("a\u{7}")),
            with(&base, "message", json!(1)),
            with(&base, "updatedPermissions", json!([])),
        ];
        for value in bad_ids() {
            bad.push(with(&base, "session", value));
        }
        for body in bad {
            assert!(local_answer(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn set_mode_takes_one_of_four() {
        for mode in MODES {
            assert_eq!(
                local_set_mode(&json!({"session": SESSION, "mode": mode})).unwrap(),
                Call {
                    method: "session.mode",
                    params: json!({"session": SESSION, "mode": mode})
                }
            );
        }
        for bad in [
            json!({"session": SESSION}),
            json!({"session": SESSION, "mode": "bypassPermissions"}),
            json!({"session": SESSION, "mode": "plan"}),
            json!({"session": SESSION, "mode": 1}),
            json!({"session": SESSION, "mode": "auto", "now": true}),
            json!({"mode": "auto"}),
        ] {
            assert!(local_set_mode(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn read_takes_before_and_limit_in_range() {
        assert_eq!(
            local_read(&json!({ "session": SESSION })).unwrap(),
            Call {
                method: "session.read",
                params: json!({ "session": SESSION })
            }
        );
        assert_eq!(
            local_read(&json!({"session": SESSION, "before": 1, "limit": 200}))
                .unwrap()
                .params,
            json!({"session": SESSION, "before": 1, "limit": 200})
        );
        assert_eq!(
            local_read(&json!({"session": SESSION, "before": null, "limit": null}))
                .unwrap()
                .params,
            json!({ "session": SESSION })
        );
        assert!(local_read(&json!({"session": SESSION, "before": SAFE_INTEGER_MAX})).is_ok());
        for bad in [
            json!({"session": SESSION, "before": 0}),
            json!({"session": SESSION, "before": -1}),
            json!({"session": SESSION, "before": 1.5}),
            json!({"session": SESSION, "before": 2.0}),
            json!({"session": SESSION, "before": "7"}),
            json!({"session": SESSION, "before": SAFE_INTEGER_MAX + 1}),
            json!({"session": SESSION, "limit": 0}),
            json!({"session": SESSION, "limit": 201}),
            json!({"session": SESSION, "limit": "100"}),
            json!({"session": SESSION, "after": 3}),
            json!({"before": 3}),
        ] {
            assert!(local_read(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn diff_takes_a_plain_relative_path() {
        assert_eq!(
            local_diff(&json!({"session": SESSION, "path": "src/app.ts"})).unwrap(),
            Call {
                method: "session.diff",
                params: json!({"session": SESSION, "path": "src/app.ts"})
            }
        );
        for path in [
            json!("/etc/passwd"),
            json!("../x"),
            json!("-p"),
            json!("a/../b"),
            json!("a\u{0}"),
            json!("x".repeat(1025)),
            json!(""),
            json!(1),
            Value::Null,
        ] {
            assert!(
                local_diff(&json!({"session": SESSION, "path": path})).is_err(),
                "{path}"
            );
        }
        assert!(local_diff(&json!({ "session": SESSION })).is_err());
        assert!(local_diff(&json!({"session": SESSION, "path": "a", "base": "HEAD"})).is_err());
    }

    #[test]
    fn set_remote_checks_then_is_closed() {
        assert!(local_set_remote(&json!({"session": SESSION, "on": true})).is_ok());
        assert!(local_set_remote(&json!({"session": SESSION, "on": false})).is_ok());
        for bad in [
            json!({ "session": SESSION }),
            json!({"session": SESSION, "on": "true"}),
            json!({"session": SESSION, "on": 1}),
            json!({"session": "x", "on": true}),
            json!({"session": SESSION, "on": true, "hub": "https://x"}),
        ] {
            assert!(local_set_remote(&bad).is_err(), "{bad}");
        }
    }
}
