//! Native menu wiring for the Smirk Wallet desktop app.
//!
//! Skeleton menus only — Files / Edit / View / Window / Help with
//! the standard platform items (copy, paste, fullscreen, close
//! window, etc.). Wallet-specific items (Lock Wallet, Switch Theme,
//! Settings) are intentionally NOT added here; those are reached
//! through the wallet UI itself so the native menu doesn't drift
//! out of sync with what the popup considers its "current state."
//!
//! Open-source-contributor note: if you're adding a wallet-action
//! menu item, prefer wiring it as a `webview.emit("smirk:menu:X")`
//! signal and letting the popup react, rather than a Rust-side
//! reach into wallet state.

use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Runtime, Wry,
};

/// Build the application menu. Called once at startup from
/// `tauri::Builder::menu(|app| build_menu(app))`.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // File submenu — minimal. Wallet doesn't have a "document" model;
    // the only meaningful item here today is Close Window. Quit is
    // handled by the App menu on macOS and the system close button
    // elsewhere.
    let file = SubmenuBuilder::new(app, "File")
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    // Edit submenu — standard clipboard items. Webview handles these
    // natively; we declare them so they appear in the menu bar and
    // get the platform-correct keyboard shortcuts.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // View submenu — fullscreen toggle is the most-asked feature
    // when shipping a webview-based desktop app; the wallet popup
    // is designed at 380x600 but lots of users will want to expand.
    let view = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // Window submenu — minimize is universal; others fall under
    // platform defaults.
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .build()?;

    // Help submenu — emits a webview event that the popup catches
    // and routes to the in-app About / Open docs flow. Concrete
    // wiring lands when the wallet UI grows an About screen; for
    // now this surfaces the menu item with a no-op event.
    let about = MenuItem::with_id(app, "help_about", "About Smirk", true, None::<&str>)?;
    let help = SubmenuBuilder::new(app, "Help").item(&about).build()?;

    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &window, &help])
        .build()
}

/// Dispatch menu events. We intentionally pass through to the
/// webview via emit() instead of reaching into wallet state from
/// Rust — keeps the wallet logic single-sourced.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "help_about" => {
            // Emit a custom event the popup can listen for. Wallet UI
            // hasn't subscribed yet — surfaces as a noop until the
            // About screen exists.
            let _ = tauri::Emitter::emit(app, "smirk:menu:about", ());
        }
        // Predefined items (copy, paste, fullscreen, etc.) handle
        // themselves natively; we never see them here.
        _ => {}
    }
}

// Silence the unused-Wry import lint on platforms that don't pull
// in the type via generics — `Runtime` is the real surface.
#[allow(dead_code)]
fn _marker(_: &AppHandle<Wry>) {}
