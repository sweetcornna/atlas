// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The arguments the hub's page may pass to the shell (qmo-app.md §5.2),
//! checked one by one before anything happens.
//!
//! The page is the hub's, and the hub is trusted to show what it shows, but
//! not to reach past the six commands: every argument is read from the raw
//! invoke body, an unknown key, a wrong type or an over-long string is
//! refused, and nothing is coerced.

use serde_json::{Map, Value};

use crate::hub::valid_session_id;

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
}
