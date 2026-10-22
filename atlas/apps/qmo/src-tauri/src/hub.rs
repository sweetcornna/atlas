// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The hub's address, and where the shell lets its windows go
//! (qmo-app.md §5.3, §7).
//!
//! A window loads the hub's own pages and the shell's local pages, nothing
//! else: every other address goes to the system browser, and anything that is
//! not an ordinary web address goes nowhere. The hub's `/login` is the one hub
//! page the shell does not show while it can open sessions itself: a page that
//! lands there lost its session, and the shell gets a new one through `qmo`
//! and goes back where the page was.

use url::Url;

/// What a hub address must be: the same rule as `qmo` (`parseHubUrl`), so the
/// shell never trusts an address `qmo` would refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubError {
    NotUrl,
    Scheme,
    Credentials,
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            HubError::NotUrl => "not a URL",
            HubError::Scheme => "https, or http on loopback only",
            HubError::Credentials => "no user name, password, query or fragment",
        })
    }
}

/// A hub: its origin, and its base address without a trailing slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hub {
    url: Url,
    base: String,
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// `https://…`, or `http://` on loopback (an SSH tunnel); no credentials,
/// query or fragment.
pub fn parse_hub(raw: &str) -> Result<Hub, HubError> {
    let url = Url::parse(raw.trim()).map_err(|_| HubError::NotUrl)?;
    if url.host().is_none() {
        return Err(HubError::NotUrl);
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        _ => return Err(HubError::Scheme),
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(HubError::Credentials);
    }
    let base = url.as_str().trim_end_matches('/').to_string();
    Ok(Hub { url, base })
}

/// Characters with a meaning in a URL pattern (Tauri's remote capability).
const PATTERN_SPECIAL: &[char] = &['\\', '*', ':', '(', ')', '{', '}', '?', '+'];

impl Hub {
    /// `scheme://host[:port]`.
    pub fn origin(&self) -> String {
        self.url.origin().ascii_serialization()
    }

    /// The address as `qmo` keeps it.
    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn host(&self) -> String {
        match self.url.host() {
            Some(url::Host::Domain(name)) => name.to_ascii_lowercase(),
            Some(url::Host::Ipv4(ip)) => ip.to_string(),
            Some(url::Host::Ipv6(ip)) => format!("[{ip}]"),
            None => String::new(),
        }
    }

    pub fn is_https(&self) -> bool {
        self.url.scheme() == "https"
    }

    /// The path the hub is served under, `""` at the root.
    fn prefix(&self) -> &str {
        self.url.path().trim_end_matches('/')
    }

    /// `path` (which starts with `/`) on this hub.
    pub fn join(&self, path: &str) -> Url {
        Url::parse(&format!("{}{}", self.base, path)).unwrap_or_else(|_| self.url.clone())
    }

    pub fn app_url(&self) -> Url {
        self.join("/app")
    }

    pub fn quick_url(&self) -> Url {
        self.join("/app/quick")
    }

    /// The conversation `id`, which [`valid_session_id`] has checked.
    pub fn session_url(&self, id: &str) -> Url {
        self.join(&format!("/app?session={id}"))
    }

    /// The hub's own sign-in page, coming back to `/app`.
    pub fn login_url(&self) -> Url {
        self.join("/login?redirect=%2Fapp")
    }

    pub fn same_origin(&self, url: &Url) -> bool {
        url.origin() == self.url.origin()
    }

    /// The remote capability's URL pattern: every page of this origin. A
    /// character the pattern syntax would read (an IPv6 address is full of
    /// `:`) is escaped.
    pub fn remote_pattern(&self) -> String {
        let mut host = String::new();
        for c in self.host().chars() {
            if PATTERN_SPECIAL.contains(&c) {
                host.push('\\');
            }
            host.push(c);
        }
        match self.url.port() {
            Some(port) => format!("{}://{}:{}/*", self.url.scheme(), host, port),
            None => format!("{}://{}/*", self.url.scheme(), host),
        }
    }
}

/// `[A-Za-z0-9_-]{1,128}`: a conversation id as a page may pass one
/// (qmo-app.md §5.2).
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The shell's own pages: Tauri serves them as `tauri://localhost` on macOS and
/// Linux, and `http(s)://tauri.localhost` on Windows.
pub fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// What a window may do with a navigation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    /// Not the hub: hand it to the system browser.
    External,
    /// The hub's sign-in page: open a session through `qmo` instead and go
    /// back to `back` (a path on the hub).
    Reenter {
        back: String,
    },
    /// Nowhere: a scheme that is not the web.
    Deny,
}

/// Decide a navigation. `login_page` is true when the hub has no client
/// tickets and its own sign-in page is how the person gets in.
pub fn decide(url: &Url, hub: Option<&Hub>, login_page: bool) -> Navigation {
    if is_local(url) {
        return Navigation::Allow;
    }
    match url.scheme() {
        "about" => {
            return if url.path() == "blank" || url.path() == "srcdoc" {
                Navigation::Allow
            } else {
                Navigation::Deny
            }
        }
        // A file the page made itself, shown in place: only the hub's.
        "blob" => {
            let inner = Url::parse(url.path()).ok();
            let ours = match (hub, inner) {
                (Some(hub), Some(inner)) => hub.same_origin(&inner),
                _ => false,
            };
            return if ours {
                Navigation::Allow
            } else {
                Navigation::Deny
            };
        }
        "http" | "https" => {}
        "mailto" => return Navigation::External,
        _ => return Navigation::Deny,
    }
    let Some(hub) = hub else {
        return Navigation::External;
    };
    if !hub.same_origin(url) {
        return Navigation::External;
    }
    if !login_page && url.path() == format!("{}/login", hub.prefix()) {
        return Navigation::Reenter {
            back: login_return(url, hub),
        };
    }
    Navigation::Allow
}

fn has_control(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

/// Where a page bounced to `/login?redirect=…` goes back to after the shell
/// opened a new session: the `redirect` when it is a plain path on this hub
/// (the console's `safeRedirect` rule), else `/app`.
pub fn login_return(url: &Url, hub: &Hub) -> String {
    let fallback = "/app".to_string();
    let Some(raw) = url
        .query_pairs()
        .find(|(key, _)| key == "redirect")
        .map(|(_, value)| value.into_owned())
    else {
        return fallback;
    };
    let value = raw.trim();
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || has_control(value)
        || value.len() > 2048
    {
        return fallback;
    }
    let Ok(probe) = hub.join("/").join(value.trim_start_matches('/')) else {
        return fallback;
    };
    if !hub.same_origin(&probe) {
        return fallback;
    }
    let path = probe
        .path()
        .strip_prefix(hub.prefix())
        .unwrap_or(probe.path());
    if path == "/login" {
        return fallback;
    }
    match probe.query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn hub_addresses_follow_the_qmo_rule() {
        let hub = parse_hub(" https://hub.example.com/ ").unwrap();
        assert_eq!(hub.base(), "https://hub.example.com");
        assert_eq!(hub.origin(), "https://hub.example.com");
        assert!(hub.is_https());
        assert_eq!(
            parse_hub("http://127.0.0.1:8787").unwrap().base(),
            "http://127.0.0.1:8787"
        );
        assert!(parse_hub("http://localhost:1").is_ok());
        assert!(parse_hub("http://[::1]:9").is_ok());
        assert_eq!(parse_hub("http://hub.example.com"), Err(HubError::Scheme));
        assert_eq!(parse_hub("http://10.0.0.2"), Err(HubError::Scheme));
        assert_eq!(parse_hub("ftp://hub.example.com"), Err(HubError::Scheme));
        assert_eq!(parse_hub("hub.example.com"), Err(HubError::NotUrl));
        assert_eq!(
            parse_hub("https://u:p@hub.example.com"),
            Err(HubError::Credentials)
        );
        assert_eq!(
            parse_hub("https://hub.example.com/?a=1"),
            Err(HubError::Credentials)
        );
        assert_eq!(
            parse_hub("https://hub.example.com/#x"),
            Err(HubError::Credentials)
        );
    }

    #[test]
    fn hub_pages() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        assert_eq!(hub.app_url().as_str(), "https://hub.example.com/app");
        assert_eq!(
            hub.quick_url().as_str(),
            "https://hub.example.com/app/quick"
        );
        assert_eq!(
            hub.session_url("s_1-A").as_str(),
            "https://hub.example.com/app?session=s_1-A"
        );
        assert_eq!(
            hub.login_url().as_str(),
            "https://hub.example.com/login?redirect=%2Fapp"
        );
        let under = parse_hub("https://example.com/hub/").unwrap();
        assert_eq!(under.app_url().as_str(), "https://example.com/hub/app");
    }

    #[test]
    fn the_remote_pattern_escapes_what_the_pattern_syntax_reads() {
        let cases = [
            ("https://hub.example.com", "https://hub.example.com/*"),
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787/*"),
            (
                "https://hub.example.com:8443/x",
                "https://hub.example.com:8443/*",
            ),
            ("http://[::1]:9", "http://[\\:\\:1]:9/*"),
        ];
        for (raw, pattern) in cases {
            assert_eq!(parse_hub(raw).unwrap().remote_pattern(), pattern);
        }
    }

    #[test]
    fn the_remote_pattern_matches_the_hub_and_nothing_else() {
        use std::str::FromStr;
        use tauri::utils::acl::RemoteUrlPattern;
        let cases = [
            (
                "http://127.0.0.1:8787",
                vec![
                    "http://127.0.0.1:8787/app",
                    "http://127.0.0.1:8787/app?session=x#y",
                ],
                vec![
                    "http://127.0.0.1:8788/app",
                    "https://127.0.0.1:8787/app",
                    "http://127.0.0.2:8787/app",
                ],
            ),
            (
                "https://hub.example.com",
                vec![
                    "https://hub.example.com/",
                    "https://hub.example.com/app/quick",
                ],
                vec![
                    "https://hub.example.com.evil.com/",
                    "https://evil.com/hub.example.com",
                    "https://x.hub.example.com/",
                    "http://hub.example.com/",
                ],
            ),
            (
                "http://[::1]:9",
                vec!["http://[::1]:9/app"],
                vec!["http://[::2]:9/app", "http://[::1]:10/app"],
            ),
        ];
        for (raw, yes, no) in cases {
            let pattern = RemoteUrlPattern::from_str(&parse_hub(raw).unwrap().remote_pattern())
                .unwrap_or_else(|e| panic!("{raw}: {e:?}"));
            for good in yes {
                assert!(pattern.test(&url(good)), "{raw} should match {good}");
            }
            for bad in no {
                assert!(!pattern.test(&url(bad)), "{raw} should not match {bad}");
            }
        }
    }

    #[test]
    fn session_ids() {
        assert!(valid_session_id("a"));
        assert!(valid_session_id("Ab_0-9"));
        assert!(valid_session_id(&"x".repeat(128)));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id(&"x".repeat(129)));
        for bad in ["a b", "a/b", "a?b", "a&b", "é", "a.b", "a\n"] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn local_pages() {
        assert!(is_local(&url("tauri://localhost/index.html")));
        assert!(is_local(&url("http://tauri.localhost/settings.html")));
        assert!(is_local(&url("https://tauri.localhost/")));
        assert!(!is_local(&url("tauri://evil/index.html")));
        assert!(!is_local(&url("http://tauri.localhost.evil.com/")));
        assert!(!is_local(&url("https://localhost/")));
    }

    #[test]
    fn navigation() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let h = Some(&hub);
        assert_eq!(
            decide(&url("tauri://localhost/index.html"), h, false),
            Navigation::Allow
        );
        assert_eq!(
            decide(&url("tauri://localhost/index.html"), None, false),
            Navigation::Allow
        );
        assert_eq!(
            decide(&url("https://hub.example.com/app"), h, false),
            Navigation::Allow
        );
        assert_eq!(
            decide(&url("https://hub.example.com/"), h, false),
            Navigation::Allow
        );
        assert_eq!(decide(&url("about:blank"), h, false), Navigation::Allow);
        assert_eq!(decide(&url("about:config"), h, false), Navigation::Deny);
        assert_eq!(
            decide(&url("blob:https://hub.example.com/1f0e"), h, false),
            Navigation::Allow
        );
        assert_eq!(
            decide(&url("blob:https://evil.com/1f0e"), h, false),
            Navigation::Deny
        );
        assert_eq!(
            decide(&url("https://evil.com/app"), h, false),
            Navigation::External
        );
        assert_eq!(
            decide(&url("http://hub.example.com/app"), h, false),
            Navigation::External
        );
        assert_eq!(
            decide(&url("https://hub.example.com:444/"), h, false),
            Navigation::External
        );
        assert_eq!(
            decide(&url("https://hub.example.com/app"), None, false),
            Navigation::External
        );
        assert_eq!(decide(&url("mailto:a@b.c"), h, false), Navigation::External);
        for denied in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "qmo://new",
            "tauri://evil/x",
        ] {
            assert_eq!(decide(&url(denied), h, false), Navigation::Deny, "{denied}");
        }
    }

    #[test]
    fn the_login_page_is_reentered_unless_it_is_the_way_in() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let h = Some(&hub);
        assert_eq!(
            decide(
                &url("https://hub.example.com/login?redirect=%2Fapp%3Fsession%3Dx"),
                h,
                false
            ),
            Navigation::Reenter {
                back: "/app?session=x".into()
            }
        );
        assert_eq!(
            decide(&url("https://hub.example.com/login"), h, false),
            Navigation::Reenter {
                back: "/app".into()
            }
        );
        assert_eq!(
            decide(&url("https://hub.example.com/login"), h, true),
            Navigation::Allow
        );
        assert_eq!(
            decide(&url("https://hub.example.com/login/x"), h, false),
            Navigation::Allow
        );
        let under = parse_hub("https://example.com/hub").unwrap();
        assert_eq!(
            decide(
                &url("https://example.com/hub/login?redirect=%2F"),
                Some(&under),
                false
            ),
            Navigation::Reenter { back: "/".into() }
        );
    }

    #[test]
    fn the_way_back_is_a_plain_path_on_the_hub() {
        let hub = parse_hub("https://hub.example.com").unwrap();
        let back = |redirect: &str| {
            let mut u = url("https://hub.example.com/login");
            u.query_pairs_mut().append_pair("redirect", redirect);
            login_return(&u, &hub)
        };
        assert_eq!(back("/"), "/");
        assert_eq!(back("/app?session=abc"), "/app?session=abc");
        assert_eq!(back("/admin/agents"), "/admin/agents");
        for bad in [
            "",
            "app",
            "//evil.com/x",
            "/\\evil.com",
            "https://evil.com/",
            "/login",
            "/login?redirect=%2Fapp",
            "/a\nb",
        ] {
            assert_eq!(back(bad), "/app", "{bad:?}");
        }
        assert_eq!(back(&format!("/{}", "a".repeat(3000))), "/app");
    }
}
