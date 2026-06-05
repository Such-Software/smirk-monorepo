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

// ----------------------------------------------------------------------
// Pure mutation API — drives the in-memory state machine without any
// Tauri / webview side effects. Commands delegate to these methods and
// then perform the webview-side work; tests exercise them directly.
// ----------------------------------------------------------------------

impl BrowserPluginInner {
    fn open(&mut self) {
        self.opened = true;
    }

    fn close(&mut self) {
        self.opened = false;
        self.tabs.clear();
        self.active_tab = None;
    }

    fn set_init_scripts(&mut self, scripts: Vec<String>) {
        self.init_scripts = scripts;
    }

    fn new_tab(&mut self, url: Option<String>) -> String {
        self.next_tab_serial += 1;
        let id = format!("tab-{}", self.next_tab_serial);
        let target_url = url.unwrap_or_else(|| "about:blank".to_string());
        let tab = BrowserTab {
            id: id.clone(),
            state: stubbed_state(&target_url),
            created_at: now_ms(),
        };
        self.tabs.insert(id.clone(), tab);
        self.active_tab = Some(id.clone());
        id
    }

    fn close_tab(&mut self, id: &str) {
        self.tabs.remove(id);
        if self.active_tab.as_deref() == Some(id) {
            self.active_tab = self.tabs.keys().last().cloned();
        }
    }

    fn switch_tab(&mut self, id: &str) -> Result<(), String> {
        if !self.tabs.contains_key(id) {
            return Err(format!("Unknown tab: {}", id));
        }
        self.active_tab = Some(id.to_string());
        Ok(())
    }

    fn navigate(&mut self, url: String, tab: Option<String>) -> Result<(), String> {
        let tab_id = tab
            .or_else(|| self.active_tab.clone())
            .ok_or_else(|| "No active tab".to_string())?;
        if let Some(t) = self.tabs.get_mut(&tab_id) {
            t.state.url = url;
            t.state.is_loading = true;
        }
        Ok(())
    }

    fn set_frame_rect(&mut self, rect: BrowserFrameRect) {
        self.frame_rect = Some(rect);
    }

    fn hide_frame(&mut self) {
        self.frame_rect = Some(BrowserFrameRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
    }
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
    inner.open();
    // TODO(@desktop): allocate the initial WebviewWindow for tab 1
    // and emit the first snapshot. STUBBED for now.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_close(state: State<'_, BrowserPluginState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.close();
    // TODO(@desktop): destroy all WebviewWindow instances. STUBBED.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_set_init_scripts(
    state: State<'_, BrowserPluginState>,
    scripts: Vec<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.set_init_scripts(scripts);
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_new_tab(
    state: State<'_, BrowserPluginState>,
    url: Option<String>,
) -> Result<String, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let id = inner.new_tab(url);
    // TODO(@desktop): create real WebviewWindow with init_scripts.
    Ok(id)
}

#[tauri::command]
pub async fn smirk_browser_close_tab(
    state: State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.close_tab(&id);
    // TODO(@desktop): destroy the WebviewWindow for this tab.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_switch_tab(
    state: State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.switch_tab(&id)?;
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
    inner.navigate(url, tab)?;
    // TODO(@desktop): WebviewWindow::eval(`window.location.href = "..."`)
    // or the dedicated loader API once it lands in Tauri 2.x.
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
    inner.set_frame_rect(rect);
    // TODO(@desktop): WebviewWindow::set_position + set_size from rect.
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_hide_frame(state: State<'_, BrowserPluginState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.hide_frame();
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

// ======================================================================
// Tests — pure state-machine behaviour. Webview integration is
// out-of-scope here (requires a running Tauri app) and is exercised by
// the manual smoke test on packaged builds.
// ======================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> BrowserPluginInner {
        BrowserPluginInner::default()
    }

    // -------- stubbed_state() --------

    #[test]
    fn stubbed_state_https_is_secure() {
        let s = stubbed_state("https://example.com/path");
        assert!(matches!(s.security_state, SecurityState::Secure));
        assert_eq!(s.origin, "https://example.com");
        assert_eq!(s.url, "https://example.com/path");
        assert!(s.is_loading);
        assert!(!s.can_go_back);
        assert!(!s.can_go_forward);
        assert!(s.favicon_url.is_none());
        assert_eq!(s.title, "");
    }

    #[test]
    fn stubbed_state_http_is_insecure() {
        let s = stubbed_state("http://example.com");
        assert!(matches!(s.security_state, SecurityState::Insecure));
        assert_eq!(s.origin, "http://example.com");
    }

    #[test]
    fn stubbed_state_about_blank_is_unknown_with_no_origin() {
        let s = stubbed_state("about:blank");
        assert!(matches!(s.security_state, SecurityState::Unknown));
        assert_eq!(s.origin, "");
    }

    #[test]
    fn stubbed_state_extracts_host_only_for_origin() {
        // origin must be scheme + host, NOT include the path.
        let s = stubbed_state("https://example.com/deep/path?query=1");
        assert_eq!(s.origin, "https://example.com");
    }

    // -------- now_ms --------

    #[test]
    fn now_ms_returns_non_zero() {
        let t = now_ms();
        assert!(t > 0, "now_ms should return a non-zero unix-ms value");
    }

    // -------- lifecycle --------

    #[test]
    fn open_then_close_clears_state() {
        let mut inner = fresh();
        inner.open();
        inner.new_tab(Some("https://a.example.com".into()));
        inner.new_tab(Some("https://b.example.com".into()));
        assert!(inner.opened);
        assert_eq!(inner.tabs.len(), 2);

        inner.close();
        assert!(!inner.opened);
        assert!(inner.tabs.is_empty());
        assert!(inner.active_tab.is_none());
    }

    #[test]
    fn open_is_idempotent() {
        let mut inner = fresh();
        inner.open();
        inner.open();
        assert!(inner.opened);
        assert_eq!(inner.tabs.len(), 0, "open should not allocate tabs by itself");
    }

    #[test]
    fn close_before_open_is_a_no_op() {
        let mut inner = fresh();
        inner.close();
        assert!(!inner.opened);
        assert!(inner.tabs.is_empty());
    }

    // -------- new_tab --------

    #[test]
    fn new_tab_assigns_monotonic_ids() {
        let mut inner = fresh();
        let a = inner.new_tab(None);
        let b = inner.new_tab(None);
        let c = inner.new_tab(None);
        assert_eq!(a, "tab-1");
        assert_eq!(b, "tab-2");
        assert_eq!(c, "tab-3");
    }

    #[test]
    fn new_tab_with_no_url_defaults_to_about_blank() {
        let mut inner = fresh();
        let id = inner.new_tab(None);
        let tab = inner.tabs.get(&id).expect("tab must exist");
        assert_eq!(tab.state.url, "about:blank");
        assert!(matches!(tab.state.security_state, SecurityState::Unknown));
    }

    #[test]
    fn new_tab_sets_the_active_tab() {
        let mut inner = fresh();
        let id = inner.new_tab(Some("https://example.com".into()));
        assert_eq!(inner.active_tab.as_deref(), Some(id.as_str()));
    }

    // -------- close_tab --------

    #[test]
    fn close_tab_removes_the_tab() {
        let mut inner = fresh();
        let a = inner.new_tab(None);
        inner.close_tab(&a);
        assert!(!inner.tabs.contains_key(&a));
    }

    #[test]
    fn close_tab_on_active_promotes_a_surviving_tab() {
        let mut inner = fresh();
        let a = inner.new_tab(None);
        let b = inner.new_tab(None);
        // active is now `b`.
        inner.close_tab(&b);
        // `a` is the only surviving tab.
        assert_eq!(inner.active_tab.as_deref(), Some(a.as_str()));
    }

    #[test]
    fn close_tab_on_active_leaves_no_active_when_last_tab_closed() {
        let mut inner = fresh();
        let a = inner.new_tab(None);
        inner.close_tab(&a);
        // The plugin (intentionally) does NOT auto-reopen — that's
        // handled by the TS-side controller. Just confirm we cleared
        // the active pointer.
        assert!(inner.active_tab.is_none());
    }

    #[test]
    fn close_tab_with_unknown_id_is_a_no_op() {
        let mut inner = fresh();
        let _ = inner.new_tab(None);
        let before = inner.tabs.len();
        inner.close_tab("does-not-exist");
        assert_eq!(inner.tabs.len(), before);
    }

    // -------- switch_tab --------

    #[test]
    fn switch_tab_updates_active() {
        let mut inner = fresh();
        let a = inner.new_tab(None);
        let _b = inner.new_tab(None);
        inner.switch_tab(&a).expect("switch should succeed");
        assert_eq!(inner.active_tab.as_deref(), Some(a.as_str()));
    }

    #[test]
    fn switch_tab_rejects_unknown_ids() {
        let mut inner = fresh();
        let err = inner.switch_tab("does-not-exist").unwrap_err();
        assert!(err.contains("does-not-exist"), "error should name the id: {}", err);
    }

    // -------- navigate --------

    #[test]
    fn navigate_updates_the_active_tab_url_and_loading() {
        let mut inner = fresh();
        let id = inner.new_tab(None);
        inner
            .navigate("https://other.example.com".into(), None)
            .expect("navigate should succeed");
        let t = inner.tabs.get(&id).expect("tab should still exist");
        assert_eq!(t.state.url, "https://other.example.com");
        assert!(t.state.is_loading);
    }

    #[test]
    fn navigate_targets_a_specific_tab_when_passed() {
        let mut inner = fresh();
        let a = inner.new_tab(Some("https://a.example.com".into()));
        let b = inner.new_tab(Some("https://b.example.com".into()));
        inner
            .navigate("https://b-redirect.example.com".into(), Some(b.clone()))
            .expect("navigate should succeed");
        assert_eq!(
            inner.tabs.get(&a).unwrap().state.url,
            "https://a.example.com",
            "non-target tab should be untouched",
        );
        assert_eq!(
            inner.tabs.get(&b).unwrap().state.url,
            "https://b-redirect.example.com",
        );
    }

    #[test]
    fn navigate_with_no_active_tab_errors() {
        let mut inner = fresh();
        let err = inner
            .navigate("https://example.com".into(), None)
            .unwrap_err();
        assert!(err.contains("No active tab"), "got: {}", err);
    }

    // -------- frame rect --------

    #[test]
    fn set_frame_rect_records_the_rect() {
        let mut inner = fresh();
        inner.set_frame_rect(BrowserFrameRect {
            x: 10.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
        });
        let r = inner.frame_rect.as_ref().expect("rect should be set");
        assert_eq!(r.x, 10.0);
        assert_eq!(r.width, 800.0);
    }

    #[test]
    fn hide_frame_records_zeroes() {
        let mut inner = fresh();
        inner.set_frame_rect(BrowserFrameRect {
            x: 10.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
        });
        inner.hide_frame();
        let r = inner.frame_rect.as_ref().expect("rect should be set");
        assert_eq!(r.x, 0.0);
        assert_eq!(r.y, 0.0);
        assert_eq!(r.width, 0.0);
        assert_eq!(r.height, 0.0);
    }

    // -------- init scripts --------

    #[test]
    fn set_init_scripts_replaces_the_list() {
        let mut inner = fresh();
        inner.set_init_scripts(vec!["a".into(), "b".into()]);
        assert_eq!(inner.init_scripts, vec!["a", "b"]);
        inner.set_init_scripts(vec!["c".into()]);
        assert_eq!(inner.init_scripts, vec!["c"]);
    }

    #[test]
    fn set_init_scripts_can_be_empty() {
        let mut inner = fresh();
        inner.set_init_scripts(vec![]);
        assert!(inner.init_scripts.is_empty());
    }
}
