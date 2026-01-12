//! WASM result types for JSON serialization.

use serde::{Deserialize, Serialize};

/// Result type for WASM functions - all functions return JSON strings.
#[derive(Serialize, Deserialize)]
pub struct WasmResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T: Serialize> WasmResult<T> {
    pub fn ok(data: T) -> String {
        serde_json::to_string(&WasmResult {
            success: true,
            data: Some(data),
            error: None,
        })
        .unwrap_or_else(|e| format!(r#"{{"success":false,"error":"Serialization error: {}"}}"#, e))
    }
}

impl WasmResult<()> {
    pub fn err(msg: &str) -> String {
        serde_json::to_string(&WasmResult::<()> {
            success: false,
            data: None,
            error: Some(msg.to_string()),
        })
        .unwrap_or_else(|_| format!(r#"{{"success":false,"error":"{}"}}"#, msg))
    }
}
