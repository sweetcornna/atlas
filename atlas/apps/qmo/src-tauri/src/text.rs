// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell's own words — menus, tray, window titles, local sessions'
//! notifications and the question on quitting — in Chinese, English and
//! Japanese, picked from the system's language. Labels only, as on the
//! front (atlas-ui-copy-tone): no sentences where a label will do.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Zh,
    En,
    Ja,
}

/// `zh-Hans-CN`, `zh_TW`, `ja-JP`, `en-US`…: Chinese and Japanese by their
/// primary tag, English for everything else.
pub fn lang_of(locale: &str) -> Lang {
    let primary = locale
        .split(['-', '_', '.'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match primary.as_str() {
        "zh" => Lang::Zh,
        "ja" => Lang::Ja,
        _ => Lang::En,
    }
}

pub fn system_lang() -> Lang {
    sys_locale::get_locale()
        .map(|locale| lang_of(&locale))
        .unwrap_or(Lang::En)
}

// Most of these name the macOS menu bar's items (`menu::app_menu`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Text {
    pub app: &'static str,
    pub about: &'static str,
    pub settings: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: &'static str,
    pub file: &'static str,
    pub new_work: &'static str,
    pub quick_entry: &'static str,
    pub close_window: &'static str,
    pub edit: &'static str,
    pub view: &'static str,
    pub reload: &'static str,
    /// The View menu's side list and panes (qmo-app.md §11.5).
    pub toggle_side: &'static str,
    pub pane_right: &'static str,
    pub pane_below: &'static str,
    pub pane_next: &'static str,
    pub pane_prev: &'static str,
    pub pane_close: &'static str,
    pub actual_size: &'static str,
    pub zoom_in: &'static str,
    pub zoom_out: &'static str,
    pub full_screen: &'static str,
    pub window: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub show_main: &'static str,
    pub help: &'static str,
    pub open_in_browser: &'static str,
    pub show_app: &'static str,
    pub sign_in_title: &'static str,
    pub settings_title: &'static str,
    pub about_title: &'static str,
    /// A local session's notification body: `<agent> · <word>`.
    pub code_done: &'static str,
    pub code_failed: &'static str,
    pub code_waiting: &'static str,
    /// Quitting with local sessions running; `{n}` is how many.
    pub quit_title: &'static str,
    pub quit_busy: &'static str,
    pub quit_anyway: &'static str,
    pub cancel: &'static str,
}

pub fn text(lang: Lang) -> &'static Text {
    match lang {
        Lang::Zh => &ZH,
        Lang::En => &EN,
        Lang::Ja => &JA,
    }
}

const ZH: Text = Text {
    app: "阡陌",
    about: "关于阡陌",
    settings: "设置…",
    hide: "隐藏阡陌",
    hide_others: "隐藏其他",
    show_all: "全部显示",
    quit: "退出阡陌",
    file: "文件",
    new_work: "开始一项工作",
    quick_entry: "快速输入",
    close_window: "关闭窗口",
    edit: "编辑",
    view: "视图",
    reload: "重新载入",
    toggle_side: "收起或展开侧栏",
    pane_right: "在右侧新开分栏",
    pane_below: "在下方新开分栏",
    pane_next: "下一个分栏",
    pane_prev: "上一个分栏",
    pane_close: "关闭分栏",
    actual_size: "实际大小",
    zoom_in: "放大",
    zoom_out: "缩小",
    full_screen: "进入全屏",
    window: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    show_main: "显示主窗口",
    help: "帮助",
    open_in_browser: "在浏览器中打开中枢",
    show_app: "显示阡陌",
    sign_in_title: "登录",
    settings_title: "设置",
    about_title: "关于",
    code_done: "完成",
    code_failed: "出错",
    code_waiting: "等你确认",
    quit_title: "退出阡陌？",
    quit_busy: "有 {n} 个会话在运行，退出会中止它们",
    quit_anyway: "退出",
    cancel: "取消",
};

const EN: Text = Text {
    app: "Qmo",
    about: "About Qmo",
    settings: "Settings…",
    hide: "Hide Qmo",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit Qmo",
    file: "File",
    new_work: "New Task",
    quick_entry: "Quick Entry",
    close_window: "Close Window",
    edit: "Edit",
    view: "View",
    reload: "Reload",
    toggle_side: "Toggle Sidebar",
    pane_right: "New Pane to the Right",
    pane_below: "New Pane Below",
    pane_next: "Next Pane",
    pane_prev: "Previous Pane",
    pane_close: "Close Pane",
    actual_size: "Actual Size",
    zoom_in: "Zoom In",
    zoom_out: "Zoom Out",
    full_screen: "Enter Full Screen",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    show_main: "Show Main Window",
    help: "Help",
    open_in_browser: "Open Hub in Browser",
    show_app: "Show Qmo",
    sign_in_title: "Sign In",
    settings_title: "Settings",
    about_title: "About",
    code_done: "Done",
    code_failed: "Failed",
    code_waiting: "Needs your approval",
    quit_title: "Quit Qmo?",
    quit_busy: "Sessions running: {n}. Quitting stops them.",
    quit_anyway: "Quit",
    cancel: "Cancel",
};

const JA: Text = Text {
    app: "Qmo",
    about: "Qmo について",
    settings: "設定…",
    hide: "Qmo を隠す",
    hide_others: "ほかを隠す",
    show_all: "すべてを表示",
    quit: "Qmo を終了",
    file: "ファイル",
    new_work: "新しいタスク",
    quick_entry: "クイック入力",
    close_window: "ウインドウを閉じる",
    edit: "編集",
    view: "表示",
    reload: "再読み込み",
    toggle_side: "サイドバーの開閉",
    pane_right: "右側に新しいペイン",
    pane_below: "下に新しいペイン",
    pane_next: "次のペイン",
    pane_prev: "前のペイン",
    pane_close: "ペインを閉じる",
    actual_size: "実際のサイズ",
    zoom_in: "拡大",
    zoom_out: "縮小",
    full_screen: "フルスクリーンにする",
    window: "ウインドウ",
    minimize: "しまう",
    zoom: "拡大/縮小",
    show_main: "メインウインドウを表示",
    help: "ヘルプ",
    open_in_browser: "ハブをブラウザで開く",
    show_app: "Qmo を表示",
    sign_in_title: "サインイン",
    settings_title: "設定",
    about_title: "情報",
    code_done: "完了",
    code_failed: "エラー",
    code_waiting: "確認待ち",
    quit_title: "Qmo を終了しますか？",
    quit_busy: "{n} 件のセッションが実行中です。終了すると中止されます",
    quit_anyway: "終了",
    cancel: "キャンセル",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_by_primary_tag() {
        for (locale, lang) in [
            ("zh-Hans-CN", Lang::Zh),
            ("zh_TW", Lang::Zh),
            ("ZH", Lang::Zh),
            ("ja-JP", Lang::Ja),
            ("ja_JP.UTF-8", Lang::Ja),
            ("en-US", Lang::En),
            ("fr-FR", Lang::En),
            ("", Lang::En),
            ("C", Lang::En),
        ] {
            assert_eq!(lang_of(locale), lang, "{locale}");
        }
    }

    #[test]
    fn the_quit_question_has_its_count() {
        for lang in [Lang::Zh, Lang::En, Lang::Ja] {
            assert!(text(lang).quit_busy.contains("{n}"), "{lang:?}");
        }
    }
}
