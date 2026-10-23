// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The app's commands go into the ACL manifest, so each needs a capability
//! that names it: the local pages' are in `capabilities/local.json`, the hub's
//! six are granted at run time to the signed-in hub's origin only.

fn main() {
    let commands = &[
        // The hub's (qmo-app.md §5.2).
        "qmo_shell_info",
        "qmo_notify",
        "qmo_badge",
        "qmo_open_session",
        "qmo_quick_hide",
        "qmo_sign_out",
        // The local pages'.
        "local_state",
        "local_sign_in",
        "local_retry",
        "local_settings",
        "local_set_shortcut",
        "local_set_autostart",
        "local_set_keep_in_background",
        "local_sign_out",
        "local_open",
        "local_close",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri build script");
}
