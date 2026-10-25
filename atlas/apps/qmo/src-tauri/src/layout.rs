// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The first frame (qmo-local.md §3.5): what the hub's page last said about
//! its layout and colours (`qmo_boot_layout`), and the skeleton the shell
//! draws from it before the next page arrives.
//!
//! The page reports its side panel — which face, open or closed, how wide,
//! how many rows and group headings — and the page and side panel colours of
//! the appearance it is showing. The shell keeps one layout and two palettes,
//! light and dark, and turns them into a [`Plan`]: everything the skeleton
//! page needs, already decided, so the page only paints it.

use serde::{Deserialize, Serialize};

/// Widest side panel the shell takes, in CSS pixels.
pub const SIDE_WIDTH_MAX: u32 = 1000;
/// Most side panel rows a report may carry (qmo-local.md §3.5).
pub const ROWS_MAX: u32 = 60;
/// Most group headings a report may carry (qmo-local.md §3.5).
pub const LABELS_MAX: u32 = 20;

/// Which face the page is: the Work faces (`/app`, `/`) or Code (`/code`).
/// The management pages were a face of their own before they became a card
/// over Work; a layout saved then reads as Work's conversation face.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Page {
    #[serde(alias = "admin")]
    Chat,
    Agents,
    Code,
}

impl Page {
    pub fn parse(value: &str) -> Option<Page> {
        match value {
            "chat" => Some(Page::Chat),
            "agents" => Some(Page::Agents),
            "code" => Some(Page::Code),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Open,
    Closed,
}

impl Side {
    pub fn parse(value: &str) -> Option<Side> {
        match value {
            "open" => Some(Side::Open),
            "closed" => Some(Side::Closed),
            _ => None,
        }
    }
}

/// `<html data-theme>` on the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    System,
    Light,
    Dark,
}

impl ThemeChoice {
    pub fn parse(value: &str) -> Option<ThemeChoice> {
        match value {
            "system" => Some(ThemeChoice::System),
            "light" => Some(ThemeChoice::Light),
            "dark" => Some(ThemeChoice::Dark),
            _ => None,
        }
    }
}

/// The side panel as the page last laid it out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootLayout {
    pub page: Page,
    pub side: Side,
    pub side_width: u32,
    pub rows: u32,
    pub labels: u32,
    pub theme: ThemeChoice,
}

impl BootLayout {
    /// Within the ranges a report may carry; a saved file is held to them too.
    pub fn in_range(&self) -> bool {
        self.side_width <= SIDE_WIDTH_MAX && self.rows <= ROWS_MAX && self.labels <= LABELS_MAX
    }
}

/// `#rrggbb`, exactly: no shorthand, no alpha, no names.
pub fn is_hex_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The page and side panel colours of one appearance, kept in lower case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Palette {
    pub page: String,
    pub sidebar: String,
}

impl Palette {
    /// Both colours `#rrggbb`, or nothing.
    pub fn new(page: &str, sidebar: &str) -> Option<Palette> {
        (is_hex_colour(page) && is_hex_colour(sidebar)).then(|| Palette {
            page: page.to_ascii_lowercase(),
            sidebar: sidebar.to_ascii_lowercase(),
        })
    }
}

/// The palettes the page reported, one per appearance.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PageColours {
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub light: Option<Palette>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub dark: Option<Palette>,
}

impl PageColours {
    pub fn get(&self, dark: bool) -> Option<&Palette> {
        if dark {
            self.dark.as_ref()
        } else {
            self.light.as_ref()
        }
    }

    pub fn set(&mut self, dark: bool, palette: Palette) {
        if dark {
            self.dark = Some(palette);
        } else {
            self.light = Some(palette);
        }
    }

    /// What was read, in lower case, without a palette that is not
    /// `#rrggbb`.
    pub fn sanitized(self) -> PageColours {
        let again = |p: Option<Palette>| p.and_then(|p| Palette::new(&p.page, &p.sidebar));
        PageColours {
            light: again(self.light),
            dark: again(self.dark),
        }
    }
}

/// A value that may not parse: `None` then, instead of failing the whole
/// settings file (a broken file is never a reason not to start).
pub fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// [`lenient`], with the default for a value that does not parse.
pub fn lenient_or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    Ok(lenient(deserializer)?.unwrap_or_default())
}

/// `colour` mixed with `share` of black, as CSS `color-mix(in srgb, colour,
/// #000 share)` rounds it.
fn mix_black(colour: &str, share: f64) -> String {
    let (r, g, b) = rgb(colour);
    let keep = |c: u8| (f64::from(c) * (1.0 - share)).round() as u8;
    format!("#{:02x}{:02x}{:02x}", keep(r), keep(g), keep(b))
}

/// The three channels of a `#rrggbb` the shell has checked; black otherwise.
pub fn rgb(colour: &str) -> (u8, u8, u8) {
    if !is_hex_colour(colour) {
        return (0, 0, 0);
    }
    let channel = |at: usize| u8::from_str_radix(&colour[at..at + 2], 16).unwrap_or(0);
    (channel(1), channel(3), channel(5))
}

/// The console's colours when the page has not said (qmo-local.md §3.4):
/// page `#f9f9f7` and side panel `#fcfcfb` light; page `#0b0b0b` and the side
/// panel that page colour with 20% black dark.
pub fn default_palette(dark: bool) -> Palette {
    if dark {
        let page = "#0b0b0b";
        Palette {
            page: page.to_string(),
            sidebar: mix_black(page, 0.2),
        }
    } else {
        Palette {
            page: "#f9f9f7".to_string(),
            sidebar: "#fcfcfb".to_string(),
        }
    }
}

/// The palette for one appearance: what the page reported for it, else the
/// default.
pub fn palette(colours: &PageColours, dark: bool) -> Palette {
    colours
        .get(dark)
        .cloned()
        .unwrap_or_else(|| default_palette(dark))
}

/// One line of the skeleton's side list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Item {
    /// A group heading.
    Label,
    /// A row.
    Row,
    /// A row drawn shorter, so the list does not read as a grid.
    Short,
}

/// The side list: `rows` rows shared out over `labels` groups as evenly as
/// they go (the first groups take the remainder), each group under its
/// heading; within a group every third row is a short one.
pub fn items(rows: u32, labels: u32) -> Vec<Item> {
    let rows = rows.min(ROWS_MAX);
    let labels = labels.min(LABELS_MAX);
    let mut out = Vec::with_capacity((rows + labels) as usize);
    let group = |out: &mut Vec<Item>, count: u32| {
        for i in 0..count {
            out.push(if i % 3 == 2 { Item::Short } else { Item::Row });
        }
    };
    if labels == 0 {
        group(&mut out, rows);
        return out;
    }
    let (each, extra) = (rows / labels, rows % labels);
    for g in 0..labels {
        out.push(Item::Label);
        group(&mut out, each + u32::from(g < extra));
    }
    out
}

/// The skeleton's two faces (the segmented control at the top of the side
/// panel).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Work,
    Code,
}

/// What the skeleton draws, decided: the page applies it as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub mode: Mode,
    pub side: Side,
    pub side_width: u32,
    pub items: Vec<Item>,
    pub light: Palette,
    pub dark: Palette,
}

/// The layout before any page has reported one: Work, the side panel open at
/// the console's 288 px, two groups of rows.
pub const FIRST_LAYOUT: BootLayout = BootLayout {
    page: Page::Chat,
    side: Side::Open,
    side_width: 288,
    rows: 7,
    labels: 2,
    theme: ThemeChoice::System,
};

/// The skeleton for the last layout and palettes the page reported. Code is
/// highlighted when the page was Code, Work otherwise.
pub fn plan(layout: Option<&BootLayout>, colours: &PageColours) -> Plan {
    let layout = layout.filter(|l| l.in_range()).unwrap_or(&FIRST_LAYOUT);
    Plan {
        mode: match layout.page {
            Page::Code => Mode::Code,
            Page::Chat | Page::Agents => Mode::Work,
        },
        side: layout.side,
        side_width: layout.side_width,
        items: items(layout.rows, layout.labels),
        light: palette(colours, false),
        dark: palette(colours, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout(page: Page, side: Side, side_width: u32, rows: u32, labels: u32) -> BootLayout {
        BootLayout {
            page,
            side,
            side_width,
            rows,
            labels,
            theme: ThemeChoice::System,
        }
    }

    #[test]
    fn hex_colours_are_seven_characters_exactly() {
        for good in ["#f9f9f7", "#0B0B0B", "#000000", "#AbCdEf"] {
            assert!(is_hex_colour(good), "{good}");
        }
        for bad in [
            "",
            "#fff",
            "#ffff",
            "#fffffff",
            "f9f9f7",
            "#f9f9fg",
            "#f9f9f7 ",
            " #f9f9f7",
            "red",
            "#f9f9f7;x",
            "#ｆ9f9f7",
            "rgb(1,2,3)",
            "var(--x)",
        ] {
            assert!(!is_hex_colour(bad), "{bad:?}");
        }
        assert_eq!(
            Palette::new("#ABCDEF", "#0b0B0b"),
            Some(Palette {
                page: "#abcdef".into(),
                sidebar: "#0b0b0b".into()
            })
        );
        assert_eq!(Palette::new("#abcdef", "#fff"), None);
        let read = PageColours {
            light: Some(Palette {
                page: "#ABCDEF".into(),
                sidebar: "#000000".into(),
            }),
            dark: Some(Palette {
                page: "#000".into(),
                sidebar: "#000000".into(),
            }),
        }
        .sanitized();
        assert_eq!(read.light, Palette::new("#abcdef", "#000000"));
        assert_eq!(read.dark, None);
    }

    #[test]
    fn the_defaults_are_the_consoles_colours() {
        assert_eq!(
            default_palette(false),
            Palette {
                page: "#f9f9f7".into(),
                sidebar: "#fcfcfb".into()
            }
        );
        // 0x0b × 0.8 = 8.8, which CSS rounds to 9.
        assert_eq!(
            default_palette(true),
            Palette {
                page: "#0b0b0b".into(),
                sidebar: "#090909".into()
            }
        );
        assert_eq!(mix_black("#ffffff", 0.2), "#cccccc");
        assert_eq!(mix_black("#808080", 0.5), "#404040");
        assert_eq!(rgb("#f9f9f7"), (0xf9, 0xf9, 0xf7));
        assert_eq!(rgb("bad"), (0, 0, 0));
    }

    #[test]
    fn each_appearance_takes_its_own_reported_palette_or_the_default() {
        let mut colours = PageColours::default();
        assert_eq!(palette(&colours, false), default_palette(false));
        assert_eq!(palette(&colours, true), default_palette(true));
        let dark = Palette::new("#101010", "#0c0c0c").unwrap();
        colours.set(true, dark.clone());
        assert_eq!(palette(&colours, true), dark);
        assert_eq!(palette(&colours, false), default_palette(false));
        let light = Palette::new("#fafafa", "#ffffff").unwrap();
        colours.set(false, light.clone());
        assert_eq!(palette(&colours, false), light);
        assert_eq!(palette(&colours, true), dark);
    }

    #[test]
    fn rows_are_shared_out_under_their_headings() {
        use Item::{Label as L, Row as R, Short as S};
        assert_eq!(items(0, 0), vec![]);
        assert_eq!(items(4, 0), vec![R, R, S, R]);
        assert_eq!(items(7, 2), vec![L, R, R, S, R, L, R, R, S]);
        assert_eq!(items(5, 3), vec![L, R, R, L, R, R, L, R]);
        assert_eq!(items(0, 2), vec![L, L]);
        // The counts come out exactly.
        for (rows, labels) in [(60, 20), (13, 4), (1, 5), (59, 7)] {
            let list = items(rows, labels);
            assert_eq!(
                list.iter().filter(|i| **i == L).count() as u32,
                labels,
                "{rows}/{labels}"
            );
            assert_eq!(
                list.iter().filter(|i| **i != L).count() as u32,
                rows,
                "{rows}/{labels}"
            );
        }
        // Never more than the most a report may carry.
        assert_eq!(items(1000, 1000).len(), (ROWS_MAX + LABELS_MAX) as usize);
    }

    #[test]
    fn the_plan_follows_the_last_layout() {
        let colours = PageColours::default();
        let first = plan(None, &colours);
        assert_eq!(first.mode, Mode::Work);
        assert_eq!(first.side, Side::Open);
        assert_eq!(first.side_width, 288);
        assert_eq!(first.items, items(7, 2));
        assert_eq!(first.light, default_palette(false));
        assert_eq!(first.dark, default_palette(true));

        let code = plan(Some(&layout(Page::Code, Side::Closed, 300, 3, 0)), &colours);
        assert_eq!(code.mode, Mode::Code);
        assert_eq!(code.side, Side::Closed);
        assert_eq!(code.side_width, 300);
        assert_eq!(code.items, items(3, 0));
        for page in [Page::Chat, Page::Agents] {
            assert_eq!(
                plan(Some(&layout(page, Side::Open, 288, 1, 1)), &colours).mode,
                Mode::Work
            );
        }
        // A layout out of range is no layout.
        assert_eq!(
            plan(Some(&layout(Page::Code, Side::Open, 288, 61, 0)), &colours),
            first
        );
    }

    #[test]
    fn the_plan_reads_as_the_skeleton_page_expects() {
        let mut colours = PageColours::default();
        colours.set(false, Palette::new("#fafaf8", "#fdfdfc").unwrap());
        let plan = plan(Some(&layout(Page::Code, Side::Open, 260, 4, 1)), &colours);
        assert_eq!(
            serde_json::to_value(&plan).unwrap(),
            json!({
                "mode": "code",
                "side": "open",
                "sideWidth": 260,
                "items": ["label", "row", "row", "short", "row"],
                "light": {"page": "#fafaf8", "sidebar": "#fdfdfc"},
                "dark": {"page": "#0b0b0b", "sidebar": "#090909"},
            })
        );
    }

    #[test]
    fn a_saved_layout_reads_back_and_admin_reads_as_chat() {
        let saved = layout(Page::Agents, Side::Closed, 288, 12, 3);
        let text = serde_json::to_string(&saved).unwrap();
        assert_eq!(
            text,
            r#"{"page":"agents","side":"closed","sideWidth":288,"rows":12,"labels":3,"theme":"system"}"#
        );
        assert_eq!(serde_json::from_str::<BootLayout>(&text).unwrap(), saved);
        let old: BootLayout = serde_json::from_value(json!({
            "page": "admin", "side": "open", "sideWidth": 288, "rows": 9, "labels": 2, "theme": "dark"
        }))
        .unwrap();
        assert_eq!(old.page, Page::Chat);
        assert_eq!(old.theme, ThemeChoice::Dark);
        // What the page sends is held to the three faces (ipc.rs); "admin"
        // is only for a file saved before.
        assert_eq!(Page::parse("admin"), None);
    }
}
