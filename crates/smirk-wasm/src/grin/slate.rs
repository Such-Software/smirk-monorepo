//! Slate v4 wire-format helpers: round-trip + summary.
//!
//! The full slate construction ceremony lives in
//! [`crate::grin::slate_builder`]; this module is just for read-only
//! parse + re-serialize and summary extraction.

use wasm_bindgen::prelude::*;

/// Parse a Grin slate v4 JSON string and re-serialize it.
///
/// Useful as a slate validator: any slate that round-trips successfully is
/// a structurally valid v4 slate. Returns the canonicalized JSON
/// (whitespace-stripped, default-fields-omitted).
///
/// Throws on malformed input.
#[wasm_bindgen]
pub fn grin_slate_round_trip(slate_json: &str) -> Result<String, JsValue> {
    let slate = grin_ext::parse_slate_v4(slate_json).map_err(|e| JsValue::from_str(&e))?;
    grin_ext::serialize_slate_v4(&slate).map_err(|e| JsValue::from_str(&e))
}

/// Extract a small summary from a slate v4 JSON for UI display.
///
/// Returns JSON: `{ "id": "...", "state": "S1", "amount": "0", "fee": "0",
/// "num_participants": 2, "num_signed": 0 }`.
#[wasm_bindgen]
pub fn grin_slate_summary(slate_json: &str) -> Result<String, JsValue> {
    let slate = grin_ext::parse_slate_v4(slate_json).map_err(|e| JsValue::from_str(&e))?;

    let state_str = match slate.sta {
        grin_ext::SlateStateV4::Unknown => "NA",
        grin_ext::SlateStateV4::Standard1 => "S1",
        grin_ext::SlateStateV4::Standard2 => "S2",
        grin_ext::SlateStateV4::Standard3 => "S3",
        grin_ext::SlateStateV4::Invoice1 => "I1",
        grin_ext::SlateStateV4::Invoice2 => "I2",
        grin_ext::SlateStateV4::Invoice3 => "I3",
    };
    let num_signed = slate.sigs.iter().filter(|s| s.part.is_some()).count();

    let json = format!(
        r#"{{"id":"{}","state":"{}","amount":"{}","fee":"{}","num_participants":{},"num_signed":{}}}"#,
        slate.id, state_str, slate.amt, slate.fee, slate.num_parts, num_signed,
    );
    Ok(json)
}
