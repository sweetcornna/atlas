// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell's own preferences (qmo-app.md §6, the local settings page): the
//! quick entry shortcut, whether closing the window keeps the app running,
//! the page zoom, and the last hub and device name so the next start can paint
//! the right window before `qmo` answers; and the hub page's last layout and
//! colours, so that window is drawn in the page's shapes (qmo-local.md §3.5);
//! and what the Code page's new sessions start with (the settings window's
//! Code group). No credential is kept here; those stay with `qmo`. Launching at login is
//! the operating system's own record, kept by the autostart plugin.

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

use crate::layout::{lenient, lenient_or_default, BootLayout, PageColours};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub quick_shortcut: String,
    pub keep_in_background: bool,
    pub zoom: f64,
    pub hub: Option<String>,
    pub device_name: Option<String>,
    /// The side panel as the hub's page last reported it (`qmo_boot_layout`).
    /// Read on its own: a layout that does not parse is no layout, and takes
    /// nothing else in the file with it.
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub layout: Option<BootLayout>,
    /// The page and side panel colours it last reported, light and dark kept
    /// apart; each read on its own as well.
    #[serde(deserialize_with = "lenient_or_default")]
    pub colors: PageColours,
    /// New local sessions' permission mode and Remote, read on their own.
    #[serde(deserialize_with = "lenient_or_default")]
    pub code: CodeDefaults,
}

/// What a new session on the Code page starts with (qmo-local.md §4.4,
/// §4.5.1 `defaults`): one of the four permission modes, `auto` unless
/// changed, and whether Remote is on, which the page uses only where the
/// runner can do Remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeDefaults {
    pub mode: String,
    pub remote: bool,
}

impl Default for CodeDefaults {
    fn default() -> CodeDefaults {
        CodeDefaults {
            mode: "auto".to_string(),
            remote: false,
        }
    }
}

/// ⌥⇧Space on macOS, Ctrl+Alt+Space elsewhere (qmo-app.md §6). Plain ⌥Space
/// is what ChatGPT and Gemini launchers already hold, and ⌃⌥Space is the
/// system's next-input-source key, which anyone typing Chinese uses.
pub fn default_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "Alt+Shift+Space"
    } else {
        "Control+Alt+Space"
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            quick_shortcut: default_shortcut().to_string(),
            keep_in_background: true,
            zoom: 1.0,
            hub: None,
            device_name: None,
            layout: None,
            colors: PageColours::default(),
            code: CodeDefaults::default(),
        }
    }
}

/// A shortcut the shell will register, written the one way it keeps them
/// (`Control+Alt+Shift+Super+<key>`). It needs a modifier other than Shift
/// alone, so a global shortcut never swallows plain typing.
pub fn normalize_shortcut(raw: &str) -> Result<String, String> {
    if raw.len() > 64 {
        return Err("too long".into());
    }
    let shortcut: Shortcut = raw.trim().parse().map_err(|e| format!("{e}"))?;
    let mods = shortcut.mods;
    if (mods - Modifiers::SHIFT).is_empty() {
        return Err("needs Control, Alt or Command".into());
    }
    let mut out = String::new();
    for (flag, name) in [
        (Modifiers::CONTROL, "Control"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Super"),
    ] {
        if mods.contains(flag) {
            out.push_str(name);
            out.push('+');
        }
    }
    out.push_str(&shortcut.key.to_string());
    Ok(out)
}

/// The steps ⌘+ and ⌘− walk through, as browsers do.
const ZOOM_STEPS: &[f64] = &[
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

/// The next zoom step up (`up`) or down from `current`.
pub fn zoom_step(current: f64, up: bool) -> f64 {
    if up {
        ZOOM_STEPS
            .iter()
            .copied()
            .find(|step| *step > current + 0.001)
            .unwrap_or(ZOOM_STEPS[ZOOM_STEPS.len() - 1])
    } else {
        ZOOM_STEPS
            .iter()
            .rev()
            .copied()
            .find(|step| *step < current - 0.001)
            .unwrap_or(ZOOM_STEPS[0])
    }
}

impl Settings {
    /// What was saved, with anything unreadable or out of range back at its
    /// default: a broken file is never a reason not to start.
    pub fn load(path: &Path) -> Settings {
        let mut settings: Settings = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        match normalize_shortcut(&settings.quick_shortcut) {
            Ok(shortcut) => settings.quick_shortcut = shortcut,
            Err(_) => settings.quick_shortcut = default_shortcut().to_string(),
        }
        if !(ZOOM_STEPS[0]..=ZOOM_STEPS[ZOOM_STEPS.len() - 1]).contains(&settings.zoom) {
            settings.zoom = 1.0;
        }
        if settings
            .hub
            .as_deref()
            .is_some_and(|hub| crate::hub::parse_hub(hub).is_err())
        {
            settings.hub = None;
        }
        settings.layout = settings.layout.filter(BootLayout::in_range);
        settings.colors = settings.colors.sanitized();
        if !crate::ipc::MODES.contains(&settings.code.mode.as_str()) {
            settings.code.mode = CodeDefaults::default().mode;
        }
        settings
    }

    /// Write beside and rename, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let temp = path.with_extension("json.tmp");
        fs::write(
            &temp,
            serde_json::to_vec_pretty(self).map_err(io::Error::other)?,
        )?;
        fs::rename(&temp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{Page, Palette, Side, ThemeChoice};

    #[test]
    fn shortcuts_are_kept_in_one_spelling() {
        assert_eq!(normalize_shortcut("Alt+Space").unwrap(), "Alt+Space");
        assert_eq!(normalize_shortcut("option+space").unwrap(), "Alt+Space");
        assert_eq!(
            normalize_shortcut("Ctrl+Alt+Space").unwrap(),
            "Control+Alt+Space"
        );
        assert_eq!(
            normalize_shortcut("Shift+Cmd+K").unwrap(),
            "Shift+Super+KeyK"
        );
        assert_eq!(
            normalize_shortcut("Super+Shift+KeyK").unwrap(),
            "Shift+Super+KeyK"
        );
        assert_eq!(
            normalize_shortcut("Control+Digit1").unwrap(),
            "Control+Digit1"
        );
        // What it writes, it reads back the same.
        for raw in ["Alt+Space", "Control+Alt+Space", "Shift+Super+KeyK"] {
            let once = normalize_shortcut(raw).unwrap();
            assert_eq!(normalize_shortcut(&once).unwrap(), once);
        }
    }

    #[test]
    fn a_shortcut_without_a_real_modifier_is_refused() {
        for bad in [
            "Space",
            "K",
            "Shift+K",
            "",
            "Alt+",
            "Alt+Nope",
            "Alt+K+J",
            &"Alt+".repeat(20),
        ] {
            assert!(normalize_shortcut(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn zoom_walks_the_steps_and_stops_at_the_ends() {
        assert_eq!(zoom_step(1.0, true), 1.1);
        assert_eq!(zoom_step(1.0, false), 0.9);
        assert_eq!(zoom_step(1.05, true), 1.1);
        assert_eq!(zoom_step(3.0, true), 3.0);
        assert_eq!(zoom_step(0.5, false), 0.5);
    }

    #[test]
    fn load_falls_back_and_save_round_trips() {
        let dir = std::env::temp_dir().join(format!("qmo-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(Settings::load(&path), Settings::default());
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
        fs::write(
            &path,
            br#"{"quickShortcut":"K","zoom":40,"hub":"http://evil.example","keepInBackground":false}"#,
        )
        .unwrap();
        let fixed = Settings::load(&path);
        assert_eq!(fixed.quick_shortcut, default_shortcut());
        assert_eq!(fixed.zoom, 1.0);
        assert_eq!(fixed.hub, None);
        assert!(!fixed.keep_in_background);
        let mine = Settings {
            quick_shortcut: "Control+Shift+Space".into(),
            keep_in_background: false,
            zoom: 1.25,
            hub: Some("https://hub.example.com".into()),
            device_name: Some("pc".into()),
            layout: Some(BootLayout {
                page: Page::Code,
                side: Side::Closed,
                side_width: 300,
                rows: 9,
                labels: 2,
                theme: ThemeChoice::Dark,
            }),
            colors: PageColours {
                light: Palette::new("#f9f9f7", "#fcfcfb"),
                dark: Palette::new("#0b0b0b", "#090909"),
            },
            code: CodeDefaults {
                mode: "full-access".into(),
                remote: true,
            },
        };
        mine.save(&path).unwrap();
        assert_eq!(Settings::load(&path), mine);
        assert!(!dir.join("settings.json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn load_text(name: &str, text: &str) -> Settings {
        let dir = std::env::temp_dir().join(format!("qmo-settings-{name}-{}", std::process::id()));
        let path = dir.join("settings.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, text).unwrap();
        let settings = Settings::load(&path);
        fs::remove_dir_all(&dir).unwrap();
        settings
    }

    #[test]
    fn a_layout_saved_before_reads_admin_as_chat() {
        let settings = load_text(
            "admin",
            r#"{"hub":"https://hub.example.com","layout":{"page":"admin","side":"open","sideWidth":272,"rows":14,"labels":3,"theme":"system"}}"#,
        );
        let layout = settings.layout.unwrap();
        assert_eq!(layout.page, Page::Chat);
        assert_eq!(
            (layout.side_width, layout.rows, layout.labels),
            (272, 14, 3)
        );
        assert_eq!(settings.hub.as_deref(), Some("https://hub.example.com"));
    }

    #[test]
    fn a_broken_layout_or_colour_is_dropped_alone() {
        let text = r##"{
            "quickShortcut": "Control+Shift+Space",
            "hub": "https://hub.example.com",
            "deviceName": "pc",
            "layout": {"page": "chat", "side": "open", "sideWidth": 288, "rows": 61, "labels": 3, "theme": "system"},
            "colors": {"light": {"page": "#fff", "sidebar": "#fcfcfb"}, "dark": {"page": "#0B0B0B", "sidebar": "#090909"}}
        }"##;
        let settings = load_text("range", text);
        // Rows over 60: no layout; a three-digit colour: no light palette.
        assert_eq!(settings.layout, None);
        assert_eq!(settings.colors.light, None);
        // An upper-case colour written by hand reads in lower case.
        assert_eq!(settings.colors.dark, Palette::new("#0b0b0b", "#090909"));
        // And the rest of the file is as it was.
        assert_eq!(settings.quick_shortcut, "Control+Shift+Space");
        assert_eq!(settings.hub.as_deref(), Some("https://hub.example.com"));
        assert_eq!(settings.device_name.as_deref(), Some("pc"));

        for broken in [
            r#"{"hub":"https://hub.example.com","layout":{"page":"settings","side":"open","sideWidth":288,"rows":1,"labels":0,"theme":"system"}}"#,
            r#"{"hub":"https://hub.example.com","layout":{"page":"chat","side":"open","sideWidth":-5,"rows":1,"labels":0,"theme":"system"}}"#,
            r#"{"hub":"https://hub.example.com","layout":"chat"}"#,
            r#"{"hub":"https://hub.example.com","layout":null}"#,
            r#"{"hub":"https://hub.example.com","layout":{"page":"chat"}}"#,
        ] {
            let settings = load_text("broken", broken);
            assert_eq!(settings.layout, None, "{broken}");
            assert_eq!(
                settings.hub.as_deref(),
                Some("https://hub.example.com"),
                "{broken}"
            );
        }
        for broken in [
            r#"{"hub":"https://hub.example.com","colors":"dark"}"#,
            r##"{"hub":"https://hub.example.com","colors":{"light":{"page":"red","sidebar":"#ffffff"}}}"##,
            r##"{"hub":"https://hub.example.com","colors":{"dark":{"page":"#000000"}}}"##,
            r#"{"hub":"https://hub.example.com","colors":{"light":7,"dark":[]}}"#,
        ] {
            let settings = load_text("colours", broken);
            assert_eq!(settings.colors, PageColours::default(), "{broken}");
            assert_eq!(
                settings.hub.as_deref(),
                Some("https://hub.example.com"),
                "{broken}"
            );
        }
    }

    #[test]
    fn code_defaults_read_on_their_own() {
        assert_eq!(
            Settings::default().code,
            CodeDefaults {
                mode: "auto".into(),
                remote: false
            }
        );
        let kept = load_text(
            "code",
            r#"{"hub":"https://hub.example.com","code":{"mode":"off","remote":true}}"#,
        );
        assert_eq!(kept.code.mode, "off");
        assert!(kept.code.remote);
        for (name, broken, remote) in [
            (
                "mode",
                r#"{"hub":"https://hub.example.com","code":{"mode":"yolo","remote":true}}"#,
                true,
            ),
            (
                "type",
                r#"{"hub":"https://hub.example.com","code":{"mode":3}}"#,
                false,
            ),
            (
                "shape",
                r#"{"hub":"https://hub.example.com","code":"auto"}"#,
                false,
            ),
            (
                "half",
                r#"{"hub":"https://hub.example.com","code":{"remote":true}}"#,
                true,
            ),
        ] {
            let settings = load_text(name, broken);
            assert_eq!(settings.code.mode, "auto", "{broken}");
            assert_eq!(settings.code.remote, remote, "{broken}");
            assert_eq!(
                settings.hub.as_deref(),
                Some("https://hub.example.com"),
                "{broken}"
            );
        }
    }

    #[test]
    fn nothing_reported_writes_nothing_extra() {
        let text = serde_json::to_value(Settings::default()).unwrap();
        assert!(text.get("layout").is_none());
        assert_eq!(text["colors"], serde_json::json!({}));
    }
}
