// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What `qmo` prints for the shell (qmo-app.md §3): the JSON of
//! `qmo session --json`, `qmo sign-in --json` and `qmo sign-out --json`, and
//! the cookies of a session as the WebView takes them.
//!
//! The device token never comes this way. `qmo` keeps it; what crosses the
//! pipe is one session's cookies, which go straight into the WebView's cookie
//! store and are not kept anywhere else.

use cookie::{time::Duration, Cookie, SameSite};
use serde::{Deserialize, Serialize};

use crate::hub::Hub;

/// Why `qmo` failed, as it says in `{"error":{"kind":…}}` (the client's
/// `ClientErrorKind`). A kind this shell does not know reads as `Refused`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Usage,
    SignedOut,
    SignedIn,
    Revoked,
    Invalid,
    DeviceKind,
    OwnerInactive,
    Unsupported,
    Network,
    BadCode,
    Throttled,
    Refused,
    /// The shell's own: `qmo` is missing, crashed, timed out or printed
    /// something that is not its JSON.
    Broken,
    /// The shell's own: the hub keeps sending a fresh session to `/login`.
    Loop,
}

impl ErrorKind {
    pub fn parse(kind: &str) -> ErrorKind {
        match kind {
            "usage" => ErrorKind::Usage,
            "signed_out" => ErrorKind::SignedOut,
            "signed_in" => ErrorKind::SignedIn,
            "revoked" => ErrorKind::Revoked,
            "invalid" => ErrorKind::Invalid,
            "device_kind" => ErrorKind::DeviceKind,
            "owner_inactive" => ErrorKind::OwnerInactive,
            "unsupported" => ErrorKind::Unsupported,
            "network" => ErrorKind::Network,
            "bad_code" => ErrorKind::BadCode,
            "throttled" => ErrorKind::Throttled,
            _ => ErrorKind::Refused,
        }
    }

    /// The pairing is gone or never was: the way on is the sign-in page.
    pub fn needs_pairing(self) -> bool {
        matches!(
            self,
            ErrorKind::SignedOut | ErrorKind::Revoked | ErrorKind::Invalid | ErrorKind::DeviceKind
        )
    }
}

/// A failure, with the device it was about when `qmo` was signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub kind: ErrorKind,
    pub message: String,
    pub hub: Option<String>,
    pub name: Option<String>,
}

impl Failure {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Failure {
        Failure {
            kind,
            message: message.into(),
            hub: None,
            name: None,
        }
    }
}

/// One cookie as `qmo session --json` prints it (`SessionCookie`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QmoCookie {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(default)]
    pub same_site: Option<String>,
    #[serde(default)]
    pub max_age: Option<i64>,
    #[serde(default)]
    pub expires: Option<String>,
}

/// `qmo session --json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub hub: String,
    pub device_id: String,
    pub name: String,
    pub cookies: Vec<QmoCookie>,
}

/// `qmo sign-in --json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub hub: String,
    pub device_id: String,
    pub name: String,
}

/// `qmo sign-out --json`: whether the hub revoked the device.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SignedOut {
    pub result: String,
}

#[derive(Deserialize)]
struct ErrorBody {
    kind: String,
    message: String,
}

#[derive(Deserialize)]
struct ErrorOutput {
    error: ErrorBody,
    #[serde(default)]
    hub: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// The cookie a session lives in (the console's `ACCOUNT_SESSION_COOKIE`).
pub const SESSION_COOKIE: &str = "qianmo_session";

/// Longest stdout the shell reads from `qmo`.
pub const MAX_OUTPUT: usize = 256 * 1024;

/// Read what one `qmo … --json` run left: its JSON on success, its error
/// otherwise. Exit 0 with anything but the expected shape is broken, and so is
/// a failure without the error JSON (a crash), told with its standard error.
pub fn parse_output<T: for<'de> Deserialize<'de>>(
    exit: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Result<T, Failure> {
    let line = stdout.trim();
    if line.len() > MAX_OUTPUT {
        return Err(Failure::new(ErrorKind::Broken, "qmo printed too much"));
    }
    if exit == Some(0) {
        return serde_json::from_str::<T>(line).map_err(|e| {
            Failure::new(
                ErrorKind::Broken,
                format!("qmo printed no usable JSON: {e}"),
            )
        });
    }
    match serde_json::from_str::<ErrorOutput>(line) {
        Ok(out) => Err(Failure {
            kind: ErrorKind::parse(&out.error.kind),
            message: out.error.message,
            hub: out.hub,
            name: out.name,
        }),
        Err(_) => {
            let detail = stderr.trim();
            let detail = if detail.is_empty() {
                match exit {
                    Some(code) => format!("qmo exited with {code}"),
                    None => "qmo was stopped".to_string(),
                }
            } else {
                detail.chars().take(500).collect()
            };
            Err(Failure::new(ErrorKind::Broken, detail))
        }
    }
}

/// What to do with one cookie in the WebView's store.
#[derive(Debug, Clone, PartialEq)]
pub enum CookieAction {
    Set(Cookie<'static>),
    /// `Max-Age=0` or an expiry in the past: the hub takes it away.
    Remove(Cookie<'static>),
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn is_cookie_value(value: &str) -> bool {
    value.len() <= 4096
        && value.bytes().all(|b| {
            (0x21..=0x7e).contains(&b) && b != b';' && b != b',' && b != b'\\' && b != b'"'
        })
}

/// Seconds since the epoch of an ISO time `qmo` printed (`Date.toISOString`:
/// `YYYY-MM-DDTHH:MM:SS(.sss)Z`, always UTC).
pub fn parse_iso_utc(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || !text.ends_with('Z') {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hh, mm, ss) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// One cookie of the session for the WebView, host-only on the hub. A cookie
/// with a `Domain` other than the hub's host, an odd name or value, or a path
/// that is not absolute is refused outright: `qmo` passes the hub's cookies
/// through as they came, and the shell sets only what the hub could have set
/// for itself.
pub fn webview_cookie(c: &QmoCookie, hub: &Hub, now: i64) -> Result<CookieAction, String> {
    if !is_token(&c.name) {
        return Err(format!("cookie name {:?}", c.name));
    }
    if !is_cookie_value(&c.value) {
        return Err(format!("cookie value of {}", c.name));
    }
    if let Some(domain) = &c.domain {
        if !domain.eq_ignore_ascii_case(&hub.host()) {
            return Err(format!("cookie {} for another domain", c.name));
        }
    }
    if !c.path.starts_with('/')
        || c.path.len() > 1024
        || c.path.chars().any(|ch| ch.is_control() || ch == ';')
    {
        return Err(format!("cookie path of {}", c.name));
    }
    let lifetime = match (c.max_age, c.expires.as_deref()) {
        (Some(age), _) => Some(age),
        (None, Some(expires)) => Some(
            parse_iso_utc(expires).ok_or_else(|| format!("cookie expiry of {}", c.name))? - now,
        ),
        (None, None) => None,
    };
    let mut cookie = Cookie::new(c.name.clone(), c.value.clone());
    cookie.set_domain(hub.host());
    cookie.set_path(c.path.clone());
    set_flags(&mut cookie, c.secure, c.http_only);
    match c.same_site.as_deref() {
        Some("Strict") => cookie.set_same_site(SameSite::Strict),
        Some("Lax") => cookie.set_same_site(SameSite::Lax),
        Some("None") => cookie.set_same_site(SameSite::None),
        _ => {}
    }
    match lifetime {
        Some(seconds) if seconds <= 0 => Ok(CookieAction::Remove(cookie)),
        Some(seconds) => {
            cookie.set_max_age(Duration::seconds(seconds));
            Ok(CookieAction::Set(cookie))
        }
        None => Ok(CookieAction::Set(cookie)),
    }
}

/// `Secure` and `HttpOnly` only when on. WKWebView reads the presence of
/// either key as on, whatever its value, so an explicit "off" (which `wry`
/// passes as `FALSE`) would hide `qianmo_shell` from the page.
fn set_flags(cookie: &mut Cookie<'static>, secure: bool, http_only: bool) {
    if secure {
        cookie.set_secure(true);
    }
    if http_only {
        cookie.set_http_only(true);
    }
}

/// The cookie that tells the hub its page is in the shell (qmo-app.md §5.1):
/// `macos`, `windows` or `linux`, readable by the page, for 400 days.
pub fn shell_cookie(hub: &Hub, platform: &str) -> Cookie<'static> {
    let mut cookie = Cookie::new("qianmo_shell", platform.to_string());
    cookie.set_domain(hub.host());
    cookie.set_path("/");
    set_flags(&mut cookie, hub.is_https(), false);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_max_age(Duration::days(400));
    cookie
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::parse_hub;

    const SESSION: &str = r#"{"hub":"http://127.0.0.1:8787","deviceId":"d-abcdefghijkl","name":"pc","cookies":[
      {"name":"qianmo_session","value":"s3cr3t-Value_1","domain":null,"path":"/","secure":false,"httpOnly":true,"sameSite":"Strict","maxAge":2592000,"expires":null},
      {"name":"qianmo_console","value":"","domain":null,"path":"/","secure":false,"httpOnly":true,"sameSite":"Strict","maxAge":0,"expires":null},
      {"name":"qianmo_client","value":"d-abcdefghijkl.mac","domain":null,"path":"/","secure":false,"httpOnly":true,"sameSite":"Strict","maxAge":34560000,"expires":null}
    ]}"#;

    #[test]
    fn a_session_reads_with_its_cookies() {
        let session: Session = parse_output(Some(0), SESSION, "").unwrap();
        assert_eq!(session.hub, "http://127.0.0.1:8787");
        assert_eq!(session.device_id, "d-abcdefghijkl");
        assert_eq!(session.cookies.len(), 3);
        assert!(session.cookies[0].http_only);
        assert_eq!(session.cookies[0].same_site.as_deref(), Some("Strict"));
        assert_eq!(session.cookies[1].max_age, Some(0));
    }

    #[test]
    fn errors_carry_their_kind_and_device() {
        let out = r#"{"error":{"kind":"revoked","message":"这台设备已被吊销"},"hub":"https://h.example","deviceId":"d-abcdefghijkl","name":"pc"}"#;
        let failure = parse_output::<Session>(Some(4), out, "").unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Revoked);
        assert!(failure.kind.needs_pairing());
        assert_eq!(failure.message, "这台设备已被吊销");
        assert_eq!(failure.hub.as_deref(), Some("https://h.example"));
        assert_eq!(failure.name.as_deref(), Some("pc"));
        for (kind, parsed) in [
            ("unsupported", ErrorKind::Unsupported),
            ("network", ErrorKind::Network),
            ("signed_out", ErrorKind::SignedOut),
            ("owner_inactive", ErrorKind::OwnerInactive),
            ("something_new", ErrorKind::Refused),
        ] {
            let out = format!(r#"{{"error":{{"kind":"{kind}","message":"m"}}}}"#);
            assert_eq!(
                parse_output::<Session>(Some(1), &out, "").unwrap_err().kind,
                parsed
            );
        }
        assert!(!ErrorKind::Network.needs_pairing());
    }

    #[test]
    fn anything_else_is_broken() {
        let crash = parse_output::<Session>(Some(1), "", "TypeError: boom\n").unwrap_err();
        assert_eq!(crash.kind, ErrorKind::Broken);
        assert_eq!(crash.message, "TypeError: boom");
        assert_eq!(
            parse_output::<Session>(Some(0), "not json", "")
                .unwrap_err()
                .kind,
            ErrorKind::Broken
        );
        assert_eq!(
            parse_output::<Session>(Some(0), "{}", "").unwrap_err().kind,
            ErrorKind::Broken
        );
        assert_eq!(
            parse_output::<Session>(None, "", "").unwrap_err().message,
            "qmo was stopped"
        );
        let huge = format!("\"{}\"", "x".repeat(MAX_OUTPUT + 1));
        assert_eq!(
            parse_output::<Session>(Some(0), &huge, "")
                .unwrap_err()
                .kind,
            ErrorKind::Broken
        );
    }

    fn cookie(json: &str) -> QmoCookie {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn session_cookies_go_in_host_only_with_their_attributes() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let c = cookie(
            r#"{"name":"qianmo_session","value":"abc","domain":null,"path":"/","secure":true,"httpOnly":true,"sameSite":"Strict","maxAge":60,"expires":null}"#,
        );
        let CookieAction::Set(set) = webview_cookie(&c, &hub, 0).unwrap() else {
            panic!("expected a cookie to set")
        };
        assert_eq!(set.name(), "qianmo_session");
        assert_eq!(set.value(), "abc");
        assert_eq!(set.domain(), Some("hub.example.com"));
        assert_eq!(set.path(), Some("/"));
        assert_eq!(set.secure(), Some(true));
        assert_eq!(set.http_only(), Some(true));
        assert_eq!(set.same_site(), Some(SameSite::Strict));
        assert_eq!(set.max_age(), Some(Duration::seconds(60)));
    }

    #[test]
    fn a_cleared_cookie_is_removed() {
        let hub = parse_hub("http://127.0.0.1:8787").unwrap();
        let cleared = cookie(
            r#"{"name":"qianmo_console","value":"","path":"/","secure":false,"httpOnly":true,"maxAge":0}"#,
        );
        assert!(matches!(
            webview_cookie(&cleared, &hub, 0).unwrap(),
            CookieAction::Remove(_)
        ));
        let expired = cookie(
            r#"{"name":"a","value":"b","path":"/","secure":false,"httpOnly":false,"expires":"2020-01-01T00:00:00.000Z"}"#,
        );
        assert!(matches!(
            webview_cookie(
                &expired,
                &hub,
                parse_iso_utc("2026-10-22T00:00:00.000Z").unwrap()
            )
            .unwrap(),
            CookieAction::Remove(_)
        ));
        let later = cookie(
            r#"{"name":"a","value":"b","path":"/","secure":false,"httpOnly":false,"expires":"2026-10-22T00:01:00.000Z"}"#,
        );
        let CookieAction::Set(set) = webview_cookie(
            &later,
            &hub,
            parse_iso_utc("2026-10-22T00:00:00.000Z").unwrap(),
        )
        .unwrap() else {
            panic!("expected a cookie to set")
        };
        assert_eq!(set.max_age(), Some(Duration::seconds(60)));
    }

    #[test]
    fn a_cookie_the_hub_could_not_set_for_itself_is_refused() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let base = r#""path":"/","secure":true,"httpOnly":true,"maxAge":60"#;
        for bad in [
            format!(r#"{{"name":"a","value":"b","domain":"evil.com",{base}}}"#),
            format!(r#"{{"name":"a","value":"b","domain":"example.com",{base}}}"#),
            format!(r#"{{"name":"a b","value":"b",{base}}}"#),
            format!(r#"{{"name":"","value":"b",{base}}}"#),
            format!(r#"{{"name":"a","value":"b;c",{base}}}"#),
            format!(r#"{{"name":"a","value":"b\nc",{base}}}"#),
            r#"{"name":"a","value":"b","path":"x","secure":true,"httpOnly":true}"#.to_string(),
            r#"{"name":"a","value":"b","path":"/","secure":true,"httpOnly":true,"expires":"tomorrow"}"#.to_string(),
        ] {
            assert!(webview_cookie(&cookie(&bad), &hub, 0).is_err(), "{bad}");
        }
        let same_host = cookie(&format!(
            r#"{{"name":"a","value":"b","domain":"HUB.example.com",{base}}}"#
        ));
        assert!(webview_cookie(&same_host, &hub, 0).is_ok());
    }

    #[test]
    fn the_shell_cookie() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let c = shell_cookie(&hub, "macos");
        assert_eq!((c.name(), c.value()), ("qianmo_shell", "macos"));
        // Absent, not off: WKWebView would read an explicit off as on.
        assert_eq!(c.http_only(), None);
        assert_eq!(c.secure(), Some(true));
        assert_eq!(c.path(), Some("/"));
        assert_eq!(c.domain(), Some("hub.example.com"));
        let local = shell_cookie(&parse_hub("http://127.0.0.1:1").unwrap(), "linux");
        assert_eq!(local.secure(), None);
    }

    #[test]
    fn iso_times() {
        assert_eq!(parse_iso_utc("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_utc("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(
            parse_iso_utc("2026-10-22T12:34:56.789Z"),
            Some(1_792_672_496)
        );
        for bad in [
            "",
            "2026-10-22",
            "2026-13-01T00:00:00Z",
            "2026-10-22T00:00:00+08:00",
            "x026-10-22T00:00:00Z",
        ] {
            assert_eq!(parse_iso_utc(bad), None, "{bad}");
        }
    }

    #[test]
    fn sign_in_and_sign_out_outputs() {
        let paired: Paired = parse_output(
            Some(0),
            r#"{"hub":"https://h.example","deviceId":"d-abcdefghijkl","name":"pc"}"#,
            "",
        )
        .unwrap();
        assert_eq!(paired.name, "pc");
        let out: SignedOut = parse_output(Some(0), r#"{"result":"revoked"}"#, "").unwrap();
        assert_eq!(out.result, "revoked");
        let bad = parse_output::<Paired>(
            Some(8),
            r#"{"error":{"kind":"bad_code","message":"配对失败"}}"#,
            "",
        )
        .unwrap_err();
        assert_eq!(bad.kind, ErrorKind::BadCode);
    }
}
