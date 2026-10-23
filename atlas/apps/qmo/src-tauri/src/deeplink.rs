// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `qmo://` links (qmo-app.md §5.3): `qmo://session/<id>` opens a
//! conversation, `qmo://new` a new one. Anything else is ignored: a link can
//! come from any program on the computer, so it only ever picks one of these
//! two pages, never an address.

use url::Url;

use crate::hub::valid_session_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    New,
    Session(String),
}

pub fn parse(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "qmo"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    match url.host_str()? {
        "new" if path.is_empty() => Some(DeepLink::New),
        "session" => {
            let id = path.strip_prefix('/')?;
            valid_session_id(id).then(|| DeepLink::Session(id.to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_links() {
        assert_eq!(parse("qmo://new"), Some(DeepLink::New));
        assert_eq!(parse("qmo://new/"), Some(DeepLink::New));
        assert_eq!(
            parse("qmo://session/abc_1-Z"),
            Some(DeepLink::Session("abc_1-Z".into()))
        );
        assert_eq!(
            parse("qmo://session/abc/"),
            Some(DeepLink::Session("abc".into()))
        );
        // A query is not read, and does not stop the link.
        assert_eq!(parse("qmo://new?q=hi"), Some(DeepLink::New));
    }

    #[test]
    fn everything_else_is_ignored() {
        for bad in [
            "",
            "qmo:",
            "qmo://",
            "qmo://session",
            "qmo://session/",
            "qmo://session/a/b",
            "qmo://session/..%2Fadmin",
            "qmo://session/a%20b",
            "qmo://new/x",
            "qmo://open?url=https://evil.com",
            "qmo://user@new",
            "qmo://new:80",
            "https://new",
            "qmox://new",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        assert_eq!(parse(&format!("qmo://session/{}", "x".repeat(129))), None);
    }
}
