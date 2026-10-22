// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell's own preferences (qmo-app.md §6, the local settings page): the
//! quick entry shortcut, whether closing the window keeps the app running,
//! the page zoom, and the last hub and device name so the next start can paint
//! the right window before `qmo` answers. No credential is kept here; those
//! stay with `qmo`. Launching at login is the operating system's own record,
//! kept by the autostart plugin.

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub quick_shortcut: String,
    pub keep_in_background: bool,
    pub zoom: f64,
    pub hub: Option<String>,
    pub device_name: Option<String>,
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
        };
        mine.save(&path).unwrap();
        assert_eq!(Settings::load(&path), mine);
        assert!(!dir.join("settings.json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
