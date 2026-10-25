// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The arguments the hub's page may pass to the shell (qmo-app.md §5.2),
//! checked one by one before anything happens.
//!
//! The page is the hub's, and the hub is trusted to show what it shows, but
//! not to reach past its nine commands: every argument is read from the raw
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
}
