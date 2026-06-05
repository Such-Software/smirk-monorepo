// Smirk Wallet desktop — Tauri entry point.
//
// Hides the console window on Windows release builds; debug builds
// keep the console so `eprintln!` output is visible during dev.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod browser_plugin;

// No native menu bar. The wallet is a small focused tool; the menu
// items we had (Close Window, clipboard, Fullscreen, Minimize, About)
// duplicated either the system window controls or the in-wallet UI.
// On Linux/GTK several Tauri 2.x `PredefinedMenuItem`s also render
// without labels, so the bar showed empty submenus. Keyboard
// shortcuts for clipboard / fullscreen work via the webview anyway.
// Re-introduce only if wallet-specific actions warrant their own
// surface — wire as `webview.emit("smirk:menu:X")` per the original
// menu.rs contributor note.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        // Embedded-browser plugin state. Commands registered in the
        // invoke_handler below. See browser_plugin.rs file header for
        // architecture + implementation checklist.
        .manage(browser_plugin::BrowserPluginState::default())
        .invoke_handler(tauri::generate_handler![
            browser_plugin::smirk_browser_open,
            browser_plugin::smirk_browser_close,
            browser_plugin::smirk_browser_set_init_scripts,
            browser_plugin::smirk_browser_new_tab,
            browser_plugin::smirk_browser_close_tab,
            browser_plugin::smirk_browser_switch_tab,
            browser_plugin::smirk_browser_navigate,
            browser_plugin::smirk_browser_go_back,
            browser_plugin::smirk_browser_go_forward,
            browser_plugin::smirk_browser_reload,
            browser_plugin::smirk_browser_set_frame_rect,
            browser_plugin::smirk_browser_hide_frame,
            browser_plugin::smirk_browser_respond_page_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running smirk-desktop");
}
