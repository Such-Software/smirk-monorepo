//! Embedded-browser plugin for Smirk Wallet desktop.
//!
//! Bridges the TypeScript `TauriBrowserController`
//! (`packages/desktop/src/dapp/tauri-browser-controller.ts`) to
//! native `WebviewWindow` instances. Each tab corresponds to one
//! webview window; the plugin maintains tab state, emits navigation
//! snapshots on change, and forwards `window.smirk` wire messages
//! from embedded pages into the wallet webview.
//!
//! ## Architecture
//!
//! ```text
//!   wallet webview (main) ──► invoke smirk_browser_*    ──┐
//!                            (commands defined below)     │
//!                                                         ▼
//!                                              ┌───────────────────┐
//!                                              │ BrowserPluginState│
//!                                              │  - tabs map       │
//!                                              │  - init scripts   │
//!                                              │  - frame rect     │
//!                                              └─────────┬─────────┘
//!                                                        │ owns
//!                                                        ▼
//!                                              ┌───────────────────┐
//!                                              │  WebviewWindow A  │
//!                                              │  (tab id "a-1")   │
//!                                              ├───────────────────┤
//!                                              │  WebviewWindow B  │
//!                                              │  (tab id "a-2")   │
//!                                              └─────────┬─────────┘
//!                                                        │ emits
//!                                                        ▼
//!   wallet webview (main) ◄── emit smirk:browser:snapshot
//!                          ◄── emit smirk:browser:page-request
//! ```
//!
//! ## Implementation status
//!
//! This file currently STUBS every command. Calling
//! `controller.navigate("https://example.com")` from TS will return
//! Ok(()) but no webview is created and no navigation happens. The
//! TypeScript scaffold is shipped first so the UI components and the
//! wiring layer can be tested against `MockController`.
//!
//! ### Implementation checklist (next milestone)
//!
//! 1. Replace `STUBBED` with `WebviewWindowBuilder` calls inside each
//!    command. Use `parent` to anchor the embedded webview to the
//!    main window. Position via `set_position` from `set_frame_rect`.
//! 2. Inject `init_scripts` via `WebviewWindowBuilder::initialization_script`
//!    before the navigation starts. Tauri runs them at document-start.
//! 3. Wire `on_navigation` / `on_page_load` from the webview to update
//!    `BrowserPluginState::tabs[id].state` and emit the snapshot.
//! 4. Implement the `smirk:dapp:rpc` listener inside the embedded
//!    webview (via injection script) and a Rust-side handler that
//!    forwards into `smirk:browser:page-request`. Round-trip the
//!    response via `smirk_browser_respond_page_request`.
//! 5. Handle webview destruction on `close_tab` and active-tab
//!    bookkeeping per the controller interface spec.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, Wry};

// ======================================================================
// Wire types (mirror the TS shapes in tauri-browser-controller.ts and
// the BrowserNavigationState in @smirk/dapp-browser).
// ======================================================================

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationState {
    pub url: String,
    pub title: String,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon_url: Option<String>,
    pub origin: String,
    pub security_state: SecurityState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityState {
    Secure,
    Insecure,
    Mixed,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    pub state: BrowserNavigationState,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub active_tab: String,
    pub tabs: Vec<BrowserTab>,
    pub active_state: BrowserNavigationState,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrameRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ======================================================================
// Plugin state — managed by Tauri as State<BrowserPluginState>.
// ======================================================================

/// Lives for the duration of the app. Single mutex guards the entire
/// state map because operations are rare (user-initiated tab actions)
/// and lock contention is a non-issue at human time scales.
#[derive(Default)]
pub struct BrowserPluginState {
    inner: Mutex<BrowserPluginInner>,
}

#[derive(Default)]
struct BrowserPluginInner {
    opened: bool,
    init_scripts: Vec<String>,
    tabs: HashMap<String, BrowserTab>,
    active_tab: Option<String>,
    next_tab_serial: u64,
    /// Most-recently-requested frame rect. Applied to the active
    /// webview on switch_tab so a backgrounded tab returns to the
    /// previously-visible region.
    frame_rect: Option<BrowserFrameRect>,
}

// ======================================================================
// Commands
// ======================================================================

#[tauri::command]
pub async fn smirk_browser_open<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, BrowserPluginState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if inner.opened {
        return Ok(());
    }
    inner.opened = true;
    // TODO(@desktop): allocate the initial WebviewWindow for tab 1
    // and emit the first snapshot. STUBBED for now.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_close(state: State<'_, BrowserPluginState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.opened = false;
    inner.tabs.clear();
    inner.active_tab = None;
    // TODO(@desktop): destroy all WebviewWindow instances. STUBBED.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_set_init_scripts(
    state: State<'_, BrowserPluginState>,
    scripts: Vec<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.init_scripts = scripts;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_new_tab(
    state: State<'_, BrowserPluginState>,
    url: Option<String>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.next_tab_serial += 1;
    let id = format!("tab-{}", inner.next_tab_serial);
    let target_url = url.unwrap_or_else(|| "about:blank".to_string());
    let tab = BrowserTab {
        id: id.clone(),
        state: stubbed_state(&target_url),
        created_at: now_ms(),
    };
    inner.tabs.insert(id.clone(), tab);
    inner.active_tab = Some(id.clone());
    // TODO(@desktop): create real WebviewWindow with init_scripts.
    Ok(id)
}

#[tauri::command]
pub async fn smirk_browser_close_tab(
    state: State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.tabs.remove(&id);
    if inner.active_tab.as_deref() == Some(&id) {
        inner.active_tab = inner.tabs.keys().last().cloned();
    }
    // TODO(@desktop): destroy the WebviewWindow for this tab.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_switch_tab(
    state: State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if !inner.tabs.contains_key(&id) {
        return Err(format!("Unknown tab: {}", id));
    }
    inner.active_tab = Some(id);
    // TODO(@desktop): raise the corresponding WebviewWindow + apply
    // the cached frame_rect.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_navigate(
    state: State<'_, BrowserPluginState>,
    url: String,
    tab: Option<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let tab_id = tab
        .or_else(|| inner.active_tab.clone())
        .ok_or_else(|| "No active tab".to_string())?;
    if let Some(t) = inner.tabs.get_mut(&tab_id) {
        t.state.url = url.clone();
        t.state.is_loading = true;
    }
    // TODO(@desktop): WebviewWindow::eval(`window.location.href = "..."`)
    // or the dedicated loader API once it lands in Tauri 2.x.
    let _ = url;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_go_back(
    state: State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let _ = (state, tab); // STUBBED
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_go_forward(
    state: State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let _ = (state, tab); // STUBBED
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_reload(
    state: State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let _ = (state, tab); // STUBBED
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_set_frame_rect(
    state: State<'_, BrowserPluginState>,
    rect: BrowserFrameRect,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.frame_rect = Some(rect);
    // TODO(@desktop): WebviewWindow::set_position + set_size from rect.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_hide_frame(state: State<'_, BrowserPluginState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.frame_rect = Some(BrowserFrameRect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    });
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_respond_page_request(
    _request_id: u64,
    _response: serde_json::Value,
) -> Result<(), String> {
    // TODO(@desktop): forward the response payload back to the
    // originating embedded webview via Tauri events.
    Ok(())
}

// ======================================================================
// Helpers
// ======================================================================

fn stubbed_state(url: &str) -> BrowserNavigationState {
    let origin = url
        .splitn(2, "://")
        .nth(1)
        .and_then(|rest| rest.splitn(2, '/').next())
        .map(|host| format!("{}://{}", url.split("://").next().unwrap_or(""), host))
        .unwrap_or_default();
    let security_state = if url.starts_with("https://") {
        SecurityState::Secure
    } else if url.starts_with("http://") {
        SecurityState::Insecure
    } else {
        SecurityState::Unknown
    };
    BrowserNavigationState {
        url: url.to_string(),
        title: String::new(),
        is_loading: true,
        can_go_back: false,
        can_go_forward: false,
        favicon_url: None,
        origin,
        security_state,
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ======================================================================
// Plugin entry — call from main.rs `Builder::default().setup(...)` to
// register state + commands. Marker for the unused Wry import.
// ======================================================================

/// Register the embedded-browser plugin with the Tauri app. Pass to
/// `Builder::manage(...)` for state and append the command set to
/// `Builder::invoke_handler(...)`. See `main.rs` for wiring.
pub fn manage_state<R: Runtime>(_app: &AppHandle<R>) -> BrowserPluginState {
    BrowserPluginState::default()
}

#[allow(dead_code)]
fn _wry_marker(_: &AppHandle<Wry>) {}
