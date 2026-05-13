//! Grin Slate v4 wire format — JSON parsing + serialization.
//!
//! Reference: `grin-wallet/libwallet/src/slate_versions/v4.rs`. Field names
//! and types match the upstream JSON format exactly so a slate produced by
//! `grin-wallet` round-trips through these types unchanged.
//!
//! v4 is the current production slate version (`CURRENT_SLATE_VERSION = 4`
//! in upstream `slate_versions/mod.rs`). v3 still exists in upstream for
//! backward compatibility on receive; we'll add v3 read-only support in
//! a future commit if real-world data shows we need it.
//!
//! Conventions matching upstream:
//! - Fields use short JSON names (`ver`, `id`, `sta`, `off`, ...)
//! - Many fields are `skip_serializing_if = is_default` so a "blank" slate
//!   omits zero/empty fields entirely
//! - Version is a `MAJOR:MINOR` string (e.g. `"4:2"`)
//! - Slate state is a 2-char enum (`"S1"`, `"S2"`, `"S3"`, `"I1"`, `"I2"`, `"I3"`, `"NA"`)
//! - All cryptographic byte arrays are hex-encoded
//!
//! This module covers parse+serialize. Slate construction logic (input/output
//! selection, blinding factor management, kernel offset computation) is
//! separate and lands when the surrounding pieces (Pedersen commitments,
//! Bulletproofs+) are in place.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Top-level Slate v4. JSON wire format matches `SlateV4` upstream exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlateV4 {
    /// Versioning info — encoded as `"MAJOR:MINOR"` in JSON.
    #[serde(with = "version_compat_serde")]
    pub ver: VersionCompatInfoV4,

    /// Unique transaction ID (UUID), selected by sender. Stored as the
    /// canonical 36-char UUID string in JSON.
    pub id: String,

    /// Slate state — `"S1"`/`"S2"`/`"S3"`/`"I1"`/`"I2"`/`"I3"`/`"NA"`.
    pub sta: SlateStateV4,

    /// Offset (blinding factor), modified by each participant inserting
    /// inputs as the transaction progresses. 32 hex bytes.
    #[serde(with = "hex_serde", default = "default_offset_zero")]
    #[serde(skip_serializing_if = "offset_is_zero")]
    pub off: [u8; 32],

    /// Number of participants. Defaults to 2.
    #[serde(default = "default_num_parts")]
    #[serde(skip_serializing_if = "num_parts_is_2")]
    pub num_parts: u8,

    /// Base amount in nanogrin (excluding fee). Encoded as a JSON string
    /// (matching `string_or_u64` upstream).
    #[serde(with = "string_or_u64", default)]
    #[serde(skip_serializing_if = "u64_is_zero")]
    pub amt: u64,

    /// Fee in nanogrin. Encoded as a JSON string.
    #[serde(with = "string_or_u64", default)]
    #[serde(skip_serializing_if = "u64_is_zero")]
    pub fee: u64,

    /// Kernel features (0 = plain, 1 = coinbase, 2 = height-locked, 3 = NRD).
    #[serde(default)]
    #[serde(skip_serializing_if = "u8_is_zero")]
    pub feat: u8,

    /// TTL — block height at which wallets should refuse to process.
    #[serde(with = "string_or_u64", default)]
    #[serde(skip_serializing_if = "u64_is_zero")]
    pub ttl: u64,

    /// Participant data — public blinding factor + nonce + optional partial
    /// signature for each participant in the transaction.
    pub sigs: Vec<ParticipantDataV4>,

    /// Inputs/Outputs added to the slate. Optional during early states.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coms: Option<Vec<CommitsV4>>,

    /// Payment proof, optional.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof: Option<PaymentInfoV4>,

    /// Kernel features arguments (e.g. NRD relative-lock height).
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feat_args: Option<KernelFeaturesArgsV4>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct VersionCompatInfoV4 {
    pub version: u16,
    pub block_header_version: u16,
}

/// Slate state codes used in the `sta` field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SlateStateV4 {
    /// Unknown (from earlier slate versions).
    #[serde(rename = "NA")]
    Unknown,
    /// Standard flow, freshly initialized (sender → receiver).
    #[serde(rename = "S1")]
    Standard1,
    /// Standard flow, return journey (receiver → sender).
    #[serde(rename = "S2")]
    Standard2,
    /// Standard flow, ready for posting.
    #[serde(rename = "S3")]
    Standard3,
    /// Invoice flow, freshly initialized (receiver → sender).
    #[serde(rename = "I1")]
    Invoice1,
    /// Invoice flow, return journey (sender → receiver).
    #[serde(rename = "I2")]
    Invoice2,
    /// Invoice flow, ready for posting.
    #[serde(rename = "I3")]
    Invoice3,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParticipantDataV4 {
    /// Public key corresponding to private blinding factor (33-byte compressed).
    #[serde(with = "hex_serde_33")]
    pub xs: [u8; 33],

    /// Public key corresponding to private nonce (33-byte compressed).
    #[serde(with = "hex_serde_33")]
    pub nonce: [u8; 33],

    /// Public partial signature, 64-byte compact form. None until the
    /// participant has signed.
    #[serde(with = "option_hex_serde_64", default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<[u8; 64]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitsV4 {
    /// Output features (0 = plain, 1 = coinbase).
    #[serde(default)]
    #[serde(skip_serializing_if = "u8_is_zero")]
    pub f: u8,

    /// Pedersen commitment, 33-byte form (1-byte parity + 32-byte X).
    #[serde(with = "hex_serde_33")]
    pub c: [u8; 33],

    /// Optional rangeproof — opaque ~676 bytes for BP+. Omitted on inputs;
    /// present on outputs once the proof is computed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(with = "option_hex_serde_vec")]
    pub p: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentInfoV4 {
    /// Sender slatepack address ed25519 pubkey (32 bytes hex).
    #[serde(with = "hex_serde_32")]
    pub saddr: [u8; 32],
    /// Receiver slatepack address ed25519 pubkey (32 bytes hex).
    #[serde(with = "hex_serde_32")]
    pub raddr: [u8; 32],
    /// Receiver's signature attesting to the payment, 64-byte ed25519 sig.
    #[serde(default)]
    #[serde(with = "option_hex_serde_64")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsig: Option<[u8; 64]>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct KernelFeaturesArgsV4 {
    /// For HeightLocked or NRD kernels: lock height (block height for absolute,
    /// relative offset for NRD).
    pub lock_hgt: u64,
}

// =============================================================================
// Default helpers (must match upstream's skip_serializing_if predicates)
// =============================================================================

fn default_offset_zero() -> [u8; 32] {
    [0u8; 32]
}
fn offset_is_zero(o: &[u8; 32]) -> bool {
    o.iter().all(|b| *b == 0)
}
fn default_num_parts() -> u8 {
    2
}
fn num_parts_is_2(n: &u8) -> bool {
    *n == 2
}
fn u64_is_zero(n: &u64) -> bool {
    *n == 0
}
fn u8_is_zero(n: &u8) -> bool {
    *n == 0
}

// =============================================================================
// Custom serde adapters
// =============================================================================

/// Encode `VersionCompatInfoV4` as a `"MAJOR:MINOR"` string.
mod version_compat_serde {
    use super::VersionCompatInfoV4;
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &VersionCompatInfoV4, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{}:{}", v.version, v.block_header_version))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<VersionCompatInfoV4, D::Error> {
        let raw = String::deserialize(d)?;
        let mut parts = raw.split(':');
        let major: u16 = parts
            .next()
            .ok_or_else(|| de::Error::custom("missing major"))?
            .parse()
            .map_err(|_| de::Error::custom("invalid major"))?;
        let minor: u16 = parts
            .next()
            .ok_or_else(|| de::Error::custom("missing minor"))?
            .parse()
            .map_err(|_| de::Error::custom("invalid minor"))?;
        if parts.next().is_some() {
            return Err(de::Error::custom("extra components in version string"));
        }
        Ok(VersionCompatInfoV4 {
            version: major,
            block_header_version: minor,
        })
    }
}

/// Encode/decode u64 as a JSON string (upstream calls this `string_or_u64`).
mod string_or_u64 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let raw = String::deserialize(d)?;
        raw.parse().map_err(|_| de::Error::custom("invalid u64 string"))
    }
}

/// hex-encode/decode a `[u8; 32]`.
pub(crate) mod hex_serde {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let raw = String::deserialize(d)?;
        let bytes = hex::decode(&raw).map_err(|e| de::Error::custom(format!("hex: {e}")))?;
        if bytes.len() != 32 {
            return Err(de::Error::custom(format!("expected 32 bytes, got {}", bytes.len())));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(out)
    }
}

mod hex_serde_32 {
    pub use super::hex_serde::*;
}

pub(crate) mod hex_serde_33 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 33], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 33], D::Error> {
        let raw = String::deserialize(d)?;
        let bytes = hex::decode(&raw).map_err(|e| de::Error::custom(format!("hex: {e}")))?;
        if bytes.len() != 33 {
            return Err(de::Error::custom(format!("expected 33 bytes, got {}", bytes.len())));
        }
        let mut out = [0u8; 33];
        out.copy_from_slice(&bytes);
        Ok(out)
    }
}

mod option_hex_serde_64 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<[u8; 64]>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(bytes) => s.serialize_str(&hex::encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<[u8; 64]>, D::Error> {
        let raw: Option<String> = Option::deserialize(d)?;
        match raw {
            None => Ok(None),
            Some(s) => {
                let bytes = hex::decode(&s).map_err(|e| de::Error::custom(format!("hex: {e}")))?;
                if bytes.len() != 64 {
                    return Err(de::Error::custom(format!("expected 64 bytes, got {}", bytes.len())));
                }
                let mut out = [0u8; 64];
                out.copy_from_slice(&bytes);
                Ok(Some(out))
            }
        }
    }
}

mod option_hex_serde_vec {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(bytes) => s.serialize_str(&hex::encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let raw: Option<String> = Option::deserialize(d)?;
        match raw {
            None => Ok(None),
            Some(s) => Ok(Some(hex::decode(&s).map_err(|e| de::Error::custom(format!("hex: {e}")))?)),
        }
    }
}

// Re-export for top-level use.
pub use string_or_u64::*;

#[allow(unused_imports)]
use {Deserialize as _, Deserializer as _, Serialize as _, Serializer as _};

// =============================================================================
// Public parse/serialize helpers
// =============================================================================

/// Parse a SlateV4 from a JSON string.
pub fn parse_slate_v4(json: &str) -> Result<SlateV4, String> {
    serde_json::from_str(json).map_err(|e| format!("slate v4 parse: {e}"))
}

/// Serialize a SlateV4 to a JSON string.
pub fn serialize_slate_v4(slate: &SlateV4) -> Result<String, String> {
    serde_json::to_string(slate).map_err(|e| format!("slate v4 serialize: {e}"))
}

// =============================================================================
// Slate construction helpers
// =============================================================================

/// Append an input commitment (no proof) to `slate.coms`. Used by the
/// sender after `sender_init_s1` to attach the inputs they're spending.
///
/// Inputs reference previously-created on-chain outputs by their
/// Pedersen commitment; the original output's rangeproof is already on
/// chain, so the slate only carries the commitment + the input's
/// feature byte (0 = plain, 1 = coinbase).
pub fn add_input_commitment(slate: &mut SlateV4, commitment: [u8; 33], is_coinbase: bool) {
    let f = if is_coinbase { 1 } else { 0 };
    let entry = CommitsV4 {
        f,
        c: commitment,
        p: None,
    };
    match &mut slate.coms {
        Some(coms) => coms.push(entry),
        None => slate.coms = Some(vec![entry]),
    }
}

/// Append an output commitment + bulletproof to `slate.coms`. Used by
/// the sender for the change output, and by the receiver for the output
/// they're receiving.
///
/// The proof must be the full bulletproof byte vector (~676 bytes for
/// BP+). Without it, the network cannot verify the value is in range
/// and the kernel signature will not validate.
pub fn add_output_commitment(
    slate: &mut SlateV4,
    commitment: [u8; 33],
    proof: Vec<u8>,
    is_coinbase: bool,
) {
    let f = if is_coinbase { 1 } else { 0 };
    let entry = CommitsV4 {
        f,
        c: commitment,
        p: Some(proof),
    };
    match &mut slate.coms {
        Some(coms) => coms.push(entry),
        None => slate.coms = Some(vec![entry]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real slate v4 fixture from `grin-wallet/api/src/foreign_rpc.rs`,
    /// invoice flow stage I2.
    const FIXTURE_I2: &str = r#"{
        "ver": "4:2",
        "id": "0436430c-2b02-624c-2032-570501212b00",
        "sta": "I2",
        "off": "383bc9df0dd332629520a0a72f8dd7f0e97d579dccb4dbdc8592aa3d424c846c",
        "fee": "23500000",
        "sigs": [
            {
                "xs": "02e3c128e436510500616fef3f9a22b15ca015f407c8c5cf96c9059163c873828f",
                "nonce": "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
                "part": "8f07ddd5e9f5179cff19486034181ed76505baaad53e5d994064127b56c5841be7bf31d80494f5e4a3d656649b1610c61a268f9cafcfc604b5d9f25efb2aa3c5"
            }
        ]
    }"#;

    #[test]
    fn parses_real_grin_wallet_slate_fixture() {
        let slate = parse_slate_v4(FIXTURE_I2).expect("real fixture parses");
        assert_eq!(slate.ver.version, 4);
        assert_eq!(slate.ver.block_header_version, 2);
        assert_eq!(slate.id, "0436430c-2b02-624c-2032-570501212b00");
        assert_eq!(slate.sta, SlateStateV4::Invoice2);
        assert_eq!(slate.fee, 23_500_000);
        assert_eq!(slate.sigs.len(), 1);
        assert!(slate.sigs[0].part.is_some());
    }

    #[test]
    fn round_trip_preserves_data() {
        let parsed_a = parse_slate_v4(FIXTURE_I2).unwrap();
        let serialized = serialize_slate_v4(&parsed_a).unwrap();
        let parsed_b = parse_slate_v4(&serialized).unwrap();
        assert_eq!(parsed_a, parsed_b);
    }

    #[test]
    fn version_string_round_trips() {
        let v = VersionCompatInfoV4 {
            version: 4,
            block_header_version: 2,
        };
        let json = serde_json::to_string(&SlateV4 {
            ver: v,
            id: "test".into(),
            sta: SlateStateV4::Standard1,
            off: [0u8; 32],
            num_parts: 2,
            amt: 0,
            fee: 0,
            feat: 0,
            ttl: 0,
            sigs: vec![],
            coms: None,
            proof: None,
            feat_args: None,
        })
        .unwrap();
        assert!(json.contains(r#""ver":"4:2""#), "expected '4:2' format, got: {json}");
        assert!(json.contains(r#""sta":"S1""#), "expected sta:S1, got: {json}");
    }

    #[test]
    fn slate_state_codes_match_upstream() {
        for (code, expected) in [
            ("\"NA\"", SlateStateV4::Unknown),
            ("\"S1\"", SlateStateV4::Standard1),
            ("\"S2\"", SlateStateV4::Standard2),
            ("\"S3\"", SlateStateV4::Standard3),
            ("\"I1\"", SlateStateV4::Invoice1),
            ("\"I2\"", SlateStateV4::Invoice2),
            ("\"I3\"", SlateStateV4::Invoice3),
        ] {
            let parsed: SlateStateV4 = serde_json::from_str(code).unwrap();
            assert_eq!(parsed, expected);
            assert_eq!(serde_json::to_string(&expected).unwrap(), code);
        }
    }

    #[test]
    fn fee_is_serialized_as_string() {
        let mut slate = parse_slate_v4(FIXTURE_I2).unwrap();
        slate.fee = 12345;
        let json = serialize_slate_v4(&slate).unwrap();
        assert!(json.contains(r#""fee":"12345""#), "expected fee as string, got: {json}");
    }

    #[test]
    fn zero_fields_are_skipped() {
        let mut slate = parse_slate_v4(FIXTURE_I2).unwrap();
        slate.amt = 0;
        slate.feat = 0;
        slate.ttl = 0;
        let json = serialize_slate_v4(&slate).unwrap();
        assert!(!json.contains("\"amt\""), "amt should be omitted when 0: {json}");
        assert!(!json.contains("\"feat\""), "feat should be omitted when 0: {json}");
        assert!(!json.contains("\"ttl\""), "ttl should be omitted when 0: {json}");
    }
}
