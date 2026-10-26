// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The app menu (macOS) and the tray (all three systems), qmo-app.md §6.
//!
//! The tray on macOS is a template icon in the menu bar: a click opens quick
//! entry, the menu is on a right click. On Windows a click shows the main
//! window. Linux shows the menu on any click, where an AppIndicator exists.

use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::{
    shell::{self, Shell},
    text::{text, Text},
};

const NEW_WORK: &str = "new-work";
const QUICK: &str = "quick-entry";
const SETTINGS: &str = "settings";
const ABOUT: &str = "about";
const SHOW: &str = "show";
const QUIT: &str = "quit";
const RELOAD: &str = "reload";
const ZOOM_RESET: &str = "zoom-reset";
const ZOOM_IN: &str = "zoom-in";
const ZOOM_OUT: &str = "zoom-out";
const OPEN_HUB: &str = "open-hub";
/// The page's side list and panes (qmo-app.md §11.5), each its fixed script.
const PAGE: [(&str, shell::PageMenu); 6] = [
    ("page-side", shell::PageMenu::Side),
    ("pane-right", shell::PageMenu::Right),
    ("pane-below", shell::PageMenu::Below),
    ("pane-next", shell::PageMenu::Next),
    ("pane-prev", shell::PageMenu::Prev),
    ("pane-close", shell::PageMenu::Close),
];

/// What each of the shell's menu items does, from the menu bar or the tray.
pub fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        NEW_WORK => shell::new_work(app),
        QUICK => shell::toggle_quick(app),
        // The page's settings card when the main window shows the hub's
        // page, the shell's own window otherwise (menu bar ⌘, and tray alike).
        SETTINGS => shell::open_settings_from_menu(app),
        ABOUT => shell::open_about(app),
        SHOW => shell::show_app(app),
        // Asked first when local sessions are running (`attention.rs`).
        QUIT => crate::attention::quit(app),
        RELOAD => shell::reload(app),
        ZOOM_RESET => shell::zoom(app, None),
        ZOOM_IN => shell::zoom(app, Some(true)),
        ZOOM_OUT => shell::zoom(app, Some(false)),
        OPEN_HUB => shell::open_hub_in_browser(app),
        id => {
            if let Some((_, action)) = PAGE.iter().find(|(one, _)| *one == id) {
                shell::page_menu(app, *action);
            }
        }
    }
}

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, label, true, accelerator)
}

/// The macOS menu bar: app, File, Edit, View, Window, Help. The Edit menu is
/// what makes ⌘C and ⌘V work in the pages.
pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let t: &Text = text(app.state::<Shell>().lang);
    let app_menu = SubmenuBuilder::new(app, t.app)
        .item(&item(app, ABOUT, t.about, None)?)
        .separator()
        .item(&item(app, SETTINGS, t.settings, Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(t.hide))?)
        .item(&PredefinedMenuItem::hide_others(app, Some(t.hide_others))?)
        .item(&PredefinedMenuItem::show_all(app, Some(t.show_all))?)
        .separator()
        .item(&item(app, QUIT, t.quit, Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, t.file)
        .item(&item(app, NEW_WORK, t.new_work, Some("CmdOrCtrl+N"))?)
        .item(&item(app, QUICK, t.quick_entry, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(
            app,
            Some(t.close_window),
        )?)
        .build()?;
    let edit = SubmenuBuilder::new(app, t.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    // The page takes these keys first and keeps them (WebKit's key
    // equivalents go to the page before the menu); a click here is the same
    // call (qmo-app.md §11.5).
    let [side, right, below, next, prev, close] = PAGE.map(|(id, _)| id);
    let view = SubmenuBuilder::new(app, t.view)
        .item(&item(app, RELOAD, t.reload, Some("CmdOrCtrl+R"))?)
        .separator()
        .item(&item(app, side, t.toggle_side, Some("CmdOrCtrl+B"))?)
        .separator()
        .item(&item(app, right, t.pane_right, Some("Ctrl+Cmd+Backslash"))?)
        .item(&item(app, below, t.pane_below, Some("Ctrl+Cmd+Minus"))?)
        .item(&item(app, next, t.pane_next, Some("Ctrl+BracketRight"))?)
        .item(&item(app, prev, t.pane_prev, Some("Ctrl+BracketLeft"))?)
        .item(&item(app, close, t.pane_close, Some("Ctrl+Cmd+W"))?)
        .separator()
        .item(&item(app, ZOOM_RESET, t.actual_size, Some("CmdOrCtrl+0"))?)
        .item(&item(app, ZOOM_IN, t.zoom_in, Some("CmdOrCtrl+="))?)
        .item(&item(app, ZOOM_OUT, t.zoom_out, Some("CmdOrCtrl+-"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some(t.full_screen))?)
        .build()?;
    let window = SubmenuBuilder::new(app, t.window)
        .item(&PredefinedMenuItem::minimize(app, Some(t.minimize))?)
        .item(&PredefinedMenuItem::maximize(app, Some(t.zoom))?)
        .separator()
        .item(&item(app, SHOW, t.show_main, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, t.help)
        .item(&item(app, OPEN_HUB, t.open_in_browser, None)?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help])
        .build()
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let t = text(app.state::<Shell>().lang);
    let mut menu = MenuBuilder::new(app)
        .item(&item(app, SHOW, t.show_app, None)?)
        .item(&item(app, NEW_WORK, t.new_work, None)?);
    // On macOS a click on the icon is quick entry already.
    if !cfg!(target_os = "macos") {
        menu = menu.item(&item(app, QUICK, t.quick_entry, None)?);
    }
    menu.item(&item(app, SETTINGS, t.settings_title, None)?)
        .separator()
        .item(&item(app, QUIT, t.quit, None)?)
        .build()
}

/// The menu bar template on macOS (black and clear, tinted by the system);
/// the app icon elsewhere.
fn tray_image(app: &AppHandle) -> tauri::Result<Image<'static>> {
    if cfg!(target_os = "macos") {
        Image::from_bytes(include_bytes!("../icons/tray-template.png"))
    } else {
        Ok(app
            .default_window_icon()
            .cloned()
            .map(|icon| icon.to_owned())
            .unwrap_or_else(|| {
                Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("bundled icon")
            }))
    }
}

pub fn tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    TrayIconBuilder::with_id("qmo")
        .icon(tray_image(app)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(text(app.state::<Shell>().lang).app)
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if cfg!(target_os = "macos") {
                    shell::toggle_quick(app);
                } else {
                    shell::show_app(app);
                }
            }
        })
        .build(app)
}
