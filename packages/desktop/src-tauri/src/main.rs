// Smirk Wallet desktop — Tauri entry point.
//
// Hides the console window on Windows release builds; debug builds
// keep the console so `eprintln!` output is visible during dev.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod menu;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .menu(|app| menu::build_menu(app))
        .on_menu_event(menu::on_menu_event)
        .run(tauri::generate_context!())
        .expect("error while running smirk-desktop");
}
