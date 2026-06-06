//! Embedded-browser plugin for Smirk Wallet desktop.
//!
//! Bridges the TypeScript `TauriBrowserController`
//! (`packages/desktop/src/dapp/tauri-browser-controller.ts`) to
//! native `WebviewWindow` instances. Each browser tab corresponds to
//! one borderless `WebviewWindow` positioned over the wallet's
//! frame slot (the `<div class="smirk-browser-shell__frame">` inside
//! `BrowserShell`). The plugin maintains tab state, emits navigation
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
//!                                              │  WebviewWindow A  │ ← tab "tab-1"
//!                                              │  borderless,      │   positioned over
//!                                              │  follows main     │   the wallet
//!                                              ├───────────────────┤   frame slot
//!                                              │  WebviewWindow B  │ ← tab "tab-2"
//!                                              │  (hidden when     │   (hidden until
//!                                              │  not active)      │   user switches)
//!                                              └─────────┬─────────┘
//!                                                        │ emits
//!                                                        ▼
//!   wallet webview (main) ◄── emit smirk:browser:snapshot
//!                          ◄── emit smirk:browser:page-request
//! ```
//!
//! ## Why `WebviewWindow` per tab, not multi-webview-per-window
//!
//! Tauri 2.x has an `unstable`-gated multi-webview-per-window API
//! (`Window::add_child` + `WebviewBuilder`). We tried it first; on
//! Linux/WebKitGTK wry packs `add_child`'d webviews into the
//! window's `GtkBox` container, so `pack_start` layout-manages them
//! and `set_position` is silently ignored. Switching to one
//! `WebviewWindow` per tab uses stable Tauri APIs only and gives us
//! pixel-perfect positioning by computing
//! `main_window.inner_position() + frame_rect` and pushing through
//! `set_position`. `install_window_follow()` keeps active tabs
//! glued to the main wallet's frame slot through Move/Resize/Focus.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{WebviewWindow, WebviewWindowBuilder},
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, Wry,
};
use url::Url;

/// Width of a "0×0" tab — Tauri/wry on some platforms rejects truly
/// zero-sized windows, so we floor at 1px. Visually still invisible.
const MIN_SIZE: f64 = 1.0;

/// Label for the main wallet window. Has to match the `label` field
/// in `tauri.conf.json::app.windows[0]`. Centralised so every
/// embedded webview attaches to the same parent.
const MAIN_WINDOW_LABEL: &str = "main";

/// Map an internal tab id (e.g. `tab-7`) to the webview label that
/// hosts it. The prefix scopes the label namespace so we never
/// collide with the main wallet window.
fn webview_label_for(tab_id: &str) -> String {
    format!("smirk-browser-{}", tab_id)
}

/// Snapshot event name — matches `EVT_SNAPSHOT` in
/// `packages/desktop/src/dapp/tauri-browser-controller.ts`.
const EVT_SNAPSHOT: &str = "smirk:browser:snapshot";

/// Page-request event name — page-side `window.smirk.X()` calls
/// surface here and the wallet UI handler answers via the
/// `smirk_browser_respond_page_request` command. Matches
/// `EVT_PAGE_REQUEST` on the TS side.
const EVT_PAGE_REQUEST: &str = "smirk:browser:page-request";

/// The `kind: 'tauri'` event the injected `window.smirk` IIFE emits
/// from inside the embedded webview. Matches `TAURI_DAPP_RPC_EVENT`
/// in `tauri-browser-controller.ts`.
const PAGE_RPC_EVENT: &str = "smirk:dapp:rpc";

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

#[derive(Clone, Copy, Debug, Deserialize)]
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
    /// Routing table for in-flight page requests. Key is the
    /// `requestId` we mint when forwarding the page's RPC to the
    /// wallet; value is the webview label that the response should
    /// route back into.
    pending_page_requests: HashMap<u64, String>,
    next_request_id: u64,
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

    /// Snapshot the current state for emission to the wallet UI.
    /// `None` if no active tab — the wallet UI drops snapshots
    /// without an active tab.
    fn snapshot(&self) -> Option<BrowserSnapshot> {
        let active_tab = self.active_tab.as_ref()?.clone();
        let active = self.tabs.get(&active_tab)?;
        Some(BrowserSnapshot {
            active_tab,
            tabs: self.tabs.values().cloned().collect(),
            active_state: active.state.clone(),
        })
    }

    /// Mint a request id for a new in-flight page-RPC and record
    /// the source webview label so the response can be routed back.
    fn allocate_request_id(&mut self, source_webview_label: String) -> u64 {
        self.next_request_id += 1;
        let id = self.next_request_id;
        self.pending_page_requests.insert(id, source_webview_label);
        id
    }

    fn take_request_target(&mut self, id: u64) -> Option<String> {
        self.pending_page_requests.remove(&id)
    }
}

// ----------------------------------------------------------------------
// Webview-side helpers — pure functions that interact with the live
// Tauri webview graph. Kept separate from `BrowserPluginInner` so the
// state-machine tests stay testable without a Tauri app.
// ----------------------------------------------------------------------

/// Emit the current snapshot to the main wallet webview. Best-effort
/// — a failed emit (window closed mid-update) logs but doesn't
/// propagate so the command path stays simple.
fn push_snapshot<R: Runtime>(app: &AppHandle<R>, state: &BrowserPluginInner) {
    if let Some(snap) = state.snapshot() {
        if let Err(e) = app.emit_to(MAIN_WINDOW_LABEL, EVT_SNAPSHOT, snap) {
            eprintln!("[browser_plugin] snapshot emit failed: {}", e);
        }
    }
}

/// Apply a frame rect (in wallet-content-area logical CSS px) to the
/// given browser-tab `WebviewWindow`. Resolves the wallet's
/// `inner_position()` (screen coords of the content area top-left),
/// adds the rect offsets, and `set_position` the embedded window.
///
/// Hides the window if the rect collapses to zero (which is what
/// the wallet UI signals when the user switches off the Browse tab).
fn apply_rect<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    rect: &BrowserFrameRect,
) -> Result<(), String> {
    let embedded = app
        .get_webview_window(label)
        .ok_or_else(|| format!("webview window not found: {}", label))?;

    if rect.width <= 0.0 || rect.height <= 0.0 {
        let _ = embedded.hide();
        return Ok(());
    }

    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window '{}' not found", MAIN_WINDOW_LABEL))?;
    let main_inner = main
        .inner_position()
        .map_err(|e| format!("inner_position: {}", e))?;
    let scale = main
        .scale_factor()
        .map_err(|e| format!("scale_factor: {}", e))?;

    // `inner_position()` is in PHYSICAL pixels (already scaled by the
    // OS); `rect` is in LOGICAL CSS px. Convert physical → logical
    // for the math, then hand the LogicalPosition to Tauri which
    // scales back when calling the OS.
    let main_inner_logical_x = main_inner.x as f64 / scale;
    let main_inner_logical_y = main_inner.y as f64 / scale;

    let target_x = main_inner_logical_x + rect.x;
    let target_y = main_inner_logical_y + rect.y;

    embedded
        .set_position(LogicalPosition::new(target_x, target_y))
        .map_err(|e| e.to_string())?;
    embedded
        .set_size(LogicalSize::new(
            rect.width.max(MIN_SIZE),
            rect.height.max(MIN_SIZE),
        ))
        .map_err(|e| e.to_string())?;
    let _ = embedded.show();
    Ok(())
}

/// Parse a `String` into a `Url`. Treats scheme-less inputs as
/// `https://` per the browser-URL-bar convention documented on
/// `DappBrowserController::navigate`. `about:blank` is preserved.
fn parse_url(input: &str) -> Result<Url, String> {
    if input == "about:blank" {
        return Url::parse("about:blank").map_err(|e| e.to_string());
    }
    if input.contains("://") {
        return Url::parse(input).map_err(|e| e.to_string());
    }
    Url::parse(&format!("https://{}", input)).map_err(|e| e.to_string())
}

/// Default placeholder rect when a tab is created before the wallet
/// UI has measured the frame slot. Anchored slightly inside the
/// window so any rendering issues are visible rather than hidden
/// at (0,0,0,0).
const DEFAULT_RECT: BrowserFrameRect = BrowserFrameRect {
    x: 0.0,
    y: 0.0,
    width: 0.0,
    height: 0.0,
};

// ======================================================================
// Commands
// ======================================================================

#[tauri::command]
pub async fn smirk_browser_open<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.open();
    push_snapshot(&app, &inner);
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_close<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
) -> Result<(), String> {
    let labels: Vec<String> = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.tabs.keys().map(|t| webview_label_for(t)).collect()
    };
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.close();
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_set_init_scripts(
    state: tauri::State<'_, BrowserPluginState>,
    scripts: Vec<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.set_init_scripts(scripts);
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_new_tab<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    url: Option<String>,
) -> Result<String, String> {
    let (tab_id, target_url, init_scripts) = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        let tab_id = inner.new_tab(url.clone());
        let target_url = url.unwrap_or_else(|| "about:blank".to_string());
        let scripts = inner.init_scripts.clone();
        (tab_id, target_url, scripts)
    };

    let label = webview_label_for(&tab_id);
    let parsed = parse_url(&target_url)?;
    let mut builder = WebviewWindowBuilder::<R, _>::new(
        &app,
        &label,
        WebviewUrl::External(parsed),
    )
    // Borderless + non-resizable + not on taskbar — the embedded
    // browser tab is a child window we composite over the wallet,
    // not an independently movable OS window.
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    // Don't render visible until apply_rect positions us correctly.
    .visible(false)
    // Don't steal focus from the wallet on creation.
    .focused(false)
    // Initial size — apply_rect will override on the wallet's
    // first setFrameRect call.
    .inner_size(MIN_SIZE, MIN_SIZE);

    for script in &init_scripts {
        builder = builder.initialization_script(script.clone());
    }

    let app_for_load = app.clone();
    let tab_id_for_load = tab_id.clone();
    builder = builder.on_page_load(move |_webview, payload| {
        let is_finished = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
        let url_string = payload.url().to_string();
        let state: tauri::State<BrowserPluginState> = app_for_load.state();
        let mut inner = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(tab) = inner.tabs.get_mut(&tab_id_for_load) {
            tab.state.url = url_string.clone();
            tab.state.origin = parse_url(&url_string)
                .ok()
                .map(|u| u.origin().ascii_serialization())
                .unwrap_or_default();
            tab.state.security_state = classify_security_state(&url_string);
            tab.state.is_loading = !is_finished;
        }
        push_snapshot(&app_for_load, &inner);
    });

    let webview = builder.build().map_err(|e| format!("build: {}", e))?;

    // Apply the cached frame rect if the wallet has already
    // measured. If not, the wallet's first `setFrameRect` call
    // will reposition + show.
    let cached_rect = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.frame_rect
    };
    if let Some(rect) = cached_rect {
        let _ = apply_rect(&app, &label, &rect);
    }

    // Per-webview RPC listener — page-side `window.smirk.X()` calls
    // emit `smirk:dapp:rpc` from inside this webview; we forward
    // them to the wallet UI as `smirk:browser:page-request` and
    // track the requestId so the response routes back.
    attach_per_webview_rpc(&app, &webview, tab_id.clone());

    {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        push_snapshot(&app, &inner);
    }

    Ok(tab_id)
}

#[tauri::command]
pub async fn smirk_browser_close_tab<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let label = webview_label_for(&id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.close_tab(&id);
    push_snapshot(&app, &inner);
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_switch_tab<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    id: String,
) -> Result<(), String> {
    let (prev_active, rect) = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        let prev = inner.active_tab.clone();
        inner.switch_tab(&id)?;
        let rect = inner.frame_rect.unwrap_or(DEFAULT_RECT);
        (prev, rect)
    };

    if let Some(prev_id) = prev_active {
        if prev_id != id {
            if let Some(w) = app.get_webview_window(&webview_label_for(&prev_id)) {
                let _ = w.hide();
            }
        }
    }
    if let Some(w) = app.get_webview_window(&webview_label_for(&id)) {
        let _ = w.show();
        let _ = w.set_position(LogicalPosition::new(rect.x, rect.y));
        let _ = w.set_size(LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)));
    }

    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    push_snapshot(&app, &inner);
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_navigate<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    url: String,
    tab: Option<String>,
) -> Result<(), String> {
    let resolved = parse_url(&url)?;
    let target_tab = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.navigate(url.clone(), tab.clone())?;
        tab.clone().or_else(|| inner.active_tab.clone())
    }
    .ok_or_else(|| "no active tab".to_string())?;

    let label = webview_label_for(&target_tab);
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("webview {} not found", label))?;
    w.navigate(resolved).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_go_back<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let webview = resolve_webview(&app, &state, tab)?;
    // Tauri 2.x's stable surface doesn't expose history navigation
    // directly. `history.back()` evaluated inside the page is the
    // portable equivalent.
    webview.eval("history.back()").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_go_forward<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let webview = resolve_webview(&app, &state, tab)?;
    webview
        .eval("history.forward()")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_reload<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<(), String> {
    let webview = resolve_webview(&app, &state, tab)?;
    webview.reload().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_set_frame_rect<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    rect: BrowserFrameRect,
) -> Result<(), String> {
    let label = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.set_frame_rect(rect);
        inner.active_tab.as_ref().map(|t| webview_label_for(t))
    };
    if let Some(label) = label {
        apply_rect(&app, &label, &rect)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_hide_frame<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
) -> Result<(), String> {
    let label = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.hide_frame();
        inner.active_tab.as_ref().map(|t| webview_label_for(t))
    };
    if let Some(label) = label {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn smirk_browser_respond_page_request<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserPluginState>,
    request_id: u64,
    response: serde_json::Value,
) -> Result<(), String> {
    let target_label = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.take_request_target(request_id)
    };
    let label = target_label.ok_or_else(|| format!("unknown requestId: {}", request_id))?;
    let event_name = format!("{}:response", PAGE_RPC_EVENT);
    app.emit_to(&label, &event_name, response)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------------------------------------------------------------
// Command-side helpers (Tauri-aware — separate from the pure inner
// methods on `BrowserPluginInner` so the state-machine tests stay
// runtime-free).
// ----------------------------------------------------------------------

/// Look up the webview a navigation command should drive — the
/// passed tab if any, otherwise the active tab. Returns an error
/// if neither resolves to a live webview.
fn resolve_webview<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, BrowserPluginState>,
    tab: Option<String>,
) -> Result<WebviewWindow<R>, String> {
    let label = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        let target = tab
            .or_else(|| inner.active_tab.clone())
            .ok_or_else(|| "no active tab".to_string())?;
        webview_label_for(&target)
    };
    app.get_webview_window(&label)
        .ok_or_else(|| format!("webview {} not found", label))
}

/// Classify the URL's security state. Mirrors the TS-side logic in
/// `MockController::makeInitialState`. WHATWG opaque-origin schemes
/// (`about:`, `data:`, `chrome:`) fall through to `Unknown`.
fn classify_security_state(url: &str) -> SecurityState {
    if url.starts_with("https://") {
        SecurityState::Secure
    } else if url.starts_with("http://") {
        SecurityState::Insecure
    } else {
        SecurityState::Unknown
    }
}

// ----------------------------------------------------------------------
// Page-RPC bridge — receive the page's `window.smirk.X()` call and
// forward to the wallet UI; route the response back.
// ----------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardedPageRequest {
    request_id: u64,
    origin: String,
    tab: String,
    payload: serde_json::Value,
}

/// Attach a webview-scoped `smirk:dapp:rpc` listener to a newly-
/// created embedded webview. Each page-RPC the listener sees gets
/// a monotonically-increasing `requestId`; the wallet UI handles
/// the request and calls `smirk_browser_respond_page_request(id,
/// response)` which routes the response back to this webview's
/// `smirk:dapp:rpc:response` channel.
fn attach_per_webview_rpc<R: Runtime>(
    app: &AppHandle<R>,
    webview: &WebviewWindow<R>,
    tab_id: String,
) {
    let label = webview.label().to_string();
    let app = app.clone();
    webview.listen(PAGE_RPC_EVENT, move |event| {
        let payload: serde_json::Value = match serde_json::from_str(event.payload()) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[browser_plugin] page-RPC payload not JSON: {}", e);
                return;
            }
        };

        let origin = app
            .get_webview_window(&label)
            .and_then(|w| w.url().ok())
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_default();

        let request_id = {
            let bound_state: tauri::State<BrowserPluginState> = app.state();
            let mut inner = match bound_state.inner.lock() {
                Ok(g) => g,
                Err(e) => {
                    eprintln!("[browser_plugin] state lock poisoned: {}", e);
                    return;
                }
            };
            inner.allocate_request_id(label.clone())
        };

        let forward = ForwardedPageRequest {
            request_id,
            origin,
            tab: tab_id.clone(),
            payload,
        };
        if let Err(e) = app.emit_to(MAIN_WINDOW_LABEL, EVT_PAGE_REQUEST, forward) {
            eprintln!("[browser_plugin] forward page-RPC failed: {}", e);
        }
    });
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

/// Wire main-window Move + Resize + visibility events to reposition
/// (or hide) all embedded browser-tab `WebviewWindow`s. Called once
/// from `main.rs::setup` after the main window is built.
///
/// Without this, the embedded webview windows stay parked at their
/// last screen position even when the user drags the main wallet
/// elsewhere, since `WebviewWindow`s are independent OS windows on
/// every platform (that's the whole reason we abandoned multi-
/// webview-per-window after the Linux/WebKitGTK issue).
pub fn install_window_follow<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!(
            "[browser_plugin] install_window_follow: main window '{}' not found",
            MAIN_WINDOW_LABEL,
        );
        return;
    };
    let app = app.clone();
    main.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            reposition_active_tab(&app);
        }
        tauri::WindowEvent::Focused(focused) => {
            // When the wallet regains focus, raise the active embedded
            // tab so a previously-stacked-behind state doesn't leave
            // it under another OS window.
            if *focused {
                reposition_active_tab(&app);
            }
        }
        _ => {}
    });
}

fn reposition_active_tab<R: Runtime>(app: &AppHandle<R>) {
    let (active_label, rect) = {
        let state: tauri::State<BrowserPluginState> = app.state();
        let inner = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(active) = inner.active_tab.as_ref() else {
            return;
        };
        let Some(rect) = inner.frame_rect else {
            return;
        };
        (webview_label_for(active), rect)
    };
    let _ = apply_rect(app, &active_label, &rect);
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
