//! Grin transaction kernel features + signature-message construction.
//!
//! Reference: `grin/core/src/core/transaction.rs::KernelFeatures` and
//! `KernelFeatures::kernel_sig_msg`.
//!
//! Every Grin transaction has at least one kernel; the kernel carries the
//! Schnorr signature that proves the transaction sums to zero. The "message"
//! that gets Schnorr-signed varies by kernel type:
//!
//! ```text
//!   Plain         msg = blake2b32(0x00 || fee_be_8)
//!   Coinbase      msg = blake2b32(0x01)
//!   HeightLocked  msg = blake2b32(0x02 || fee_be_8 || lock_height_be_8)
//!   NRD           msg = blake2b32(0x03 || fee_be_8 || rel_height_be_2)
//! ```
//!
//! The `fee` is a 64-bit big-endian value (Grin's `FeeFields` packs
//! `fee_shift` into the high 4 bits, but we treat it opaquely; the caller
//! provides the already-packed u64).
//!
//! NRD ("No Recent Duplicate") kernels enforce a relative lock height
//! between successive instances of the same kernel commit. Used for e.g.
//! Smirk's planned Dead-Man's-Switch outputs and v0.4 atomic-swap refund
//! paths. Valid `relative_height` ∈ `[1, WEEK_HEIGHT]` per Grin consensus
//! (WEEK_HEIGHT = 10080 = 60 × 24 × 7 at 1-minute blocks).

use blake2::{
    digest::{Update, VariableOutput},
    Blake2bVar,
};

/// Maximum relative height for NRD kernels (one week = 10080 blocks).
pub const NRD_MAX_RELATIVE_HEIGHT: u16 = 10080;

/// Kernel feature variants. Mirrors upstream `KernelFeatures` but carries
/// only the data needed to compute the signing message + serialize for
/// the slate-v4 wire format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum KernelFeatures {
    /// Standard kernel: has a fee.
    Plain { fee: u64 },
    /// Coinbase kernel: no fee, no locktime.
    Coinbase,
    /// Height-locked: fee + absolute block-height before which the
    /// transaction cannot be included.
    HeightLocked { fee: u64, lock_height: u64 },
    /// No-Recent-Duplicate: fee + relative lock height (in blocks)
    /// between successive instances of the same kernel commitment.
    /// `relative_height` must be in `[1, NRD_MAX_RELATIVE_HEIGHT]`.
    Nrd { fee: u64, relative_height: u16 },
}

impl KernelFeatures {
    /// Wire byte for this kernel feature variant.
    pub fn feature_byte(&self) -> u8 {
        match self {
            KernelFeatures::Plain { .. } => 0,
            KernelFeatures::Coinbase => 1,
            KernelFeatures::HeightLocked { .. } => 2,
            KernelFeatures::Nrd { .. } => 3,
        }
    }

    /// Reconstruct kernel features from the fields a SlateV4 carries:
    /// `feat` byte, `fee` value, and the optional `feat_args` (which holds
    /// `lock_hgt`, interpreted as either an absolute lock height for
    /// `HeightLocked` kernels, or a relative height for NRD kernels).
    ///
    /// Used by `receiver_round_s2` and `sender_finalize_s3` to compute the
    /// kernel signing message from the slate fields.
    pub fn from_slate_fields(feat: u8, fee: u64, lock_hgt: Option<u64>) -> Result<Self, String> {
        match feat {
            0 => Ok(KernelFeatures::Plain { fee }),
            1 => Ok(KernelFeatures::Coinbase),
            2 => {
                let lh = lock_hgt
                    .ok_or_else(|| "HeightLocked kernel requires feat_args.lock_hgt".to_string())?;
                Ok(KernelFeatures::HeightLocked {
                    fee,
                    lock_height: lh,
                })
            }
            3 => {
                let lh = lock_hgt
                    .ok_or_else(|| "NRD kernel requires feat_args.lock_hgt".to_string())?;
                if lh == 0 || lh > u64::from(NRD_MAX_RELATIVE_HEIGHT) {
                    return Err(format!(
                        "NRD relative_height {lh} out of range [1, {NRD_MAX_RELATIVE_HEIGHT}]"
                    ));
                }
                // Bounds-checked above (lh <= NRD_MAX_RELATIVE_HEIGHT, which fits u16).
                #[allow(clippy::cast_possible_truncation)]
                let relative_height = lh as u16;
                Ok(KernelFeatures::Nrd { fee, relative_height })
            }
            other => Err(format!("unknown kernel feature byte: {other}")),
        }
    }

    /// Compute the 32-byte BLAKE2b-256 message that gets Schnorr-signed
    /// for this kernel. Pass to [`crate::schnorr::sign_with_nonce`] (or
    /// the multi-party flow) to produce the kernel signature.
    pub fn sig_msg(&self) -> Result<[u8; 32], String> {
        let mut hasher = Blake2bVar::new(32).map_err(|e| format!("blake2b init: {e}"))?;
        hasher.update(&[self.feature_byte()]);
        match self {
            KernelFeatures::Plain { fee } => {
                hasher.update(&fee.to_be_bytes());
            }
            KernelFeatures::Coinbase => {}
            KernelFeatures::HeightLocked { fee, lock_height } => {
                hasher.update(&fee.to_be_bytes());
                hasher.update(&lock_height.to_be_bytes());
            }
            KernelFeatures::Nrd {
                fee,
                relative_height,
            } => {
                if *relative_height == 0 || *relative_height > NRD_MAX_RELATIVE_HEIGHT {
                    return Err(format!(
                        "NRD relative_height {relative_height} out of range [1, {NRD_MAX_RELATIVE_HEIGHT}]"
                    ));
                }
                hasher.update(&fee.to_be_bytes());
                hasher.update(&relative_height.to_be_bytes());
            }
        }
        let mut out = [0u8; 32];
        hasher
            .finalize_variable(&mut out)
            .map_err(|e| format!("blake2b finalize: {e}"))?;
        Ok(out)
    }

    /// Serialize the kernel features in Grin's v2 protocol wire format.
    ///
    /// Layout:
    /// ```text
    ///   Plain        : u8 0x00 || u64 BE fee
    ///   Coinbase     : u8 0x01
    ///   HeightLocked : u8 0x02 || u64 BE fee || u64 BE lock_height
    ///   NRD          : u8 0x03 || u64 BE fee || u16 BE relative_height
    /// ```
    pub fn to_v2_bytes(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(17);
        out.push(self.feature_byte());
        match self {
            KernelFeatures::Plain { fee } => {
                out.extend_from_slice(&fee.to_be_bytes());
            }
            KernelFeatures::Coinbase => {}
            KernelFeatures::HeightLocked { fee, lock_height } => {
                out.extend_from_slice(&fee.to_be_bytes());
                out.extend_from_slice(&lock_height.to_be_bytes());
            }
            KernelFeatures::Nrd {
                fee,
                relative_height,
            } => {
                if *relative_height == 0 || *relative_height > NRD_MAX_RELATIVE_HEIGHT {
                    return Err(format!(
                        "NRD relative_height {relative_height} out of range [1, {NRD_MAX_RELATIVE_HEIGHT}]"
                    ));
                }
                out.extend_from_slice(&fee.to_be_bytes());
                out.extend_from_slice(&relative_height.to_be_bytes());
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schnorr;
    use crate::secp256k1::public_key_from_secret_key;

    #[test]
    fn feature_bytes_match_upstream() {
        assert_eq!(KernelFeatures::Plain { fee: 0 }.feature_byte(), 0);
        assert_eq!(KernelFeatures::Coinbase.feature_byte(), 1);
        assert_eq!(
            KernelFeatures::HeightLocked {
                fee: 0,
                lock_height: 0
            }
            .feature_byte(),
            2
        );
        assert_eq!(
            KernelFeatures::Nrd {
                fee: 0,
                relative_height: 1
            }
            .feature_byte(),
            3
        );
    }

    #[test]
    fn plain_v2_bytes_layout() {
        let k = KernelFeatures::Plain { fee: 0x12_3456_7890 };
        let bytes = k.to_v2_bytes().unwrap();
        assert_eq!(bytes.len(), 9);
        assert_eq!(bytes[0], 0); // feature byte
        assert_eq!(&bytes[1..], &0x12_3456_7890u64.to_be_bytes());
    }

    #[test]
    fn coinbase_v2_bytes_is_just_feature_byte() {
        let bytes = KernelFeatures::Coinbase.to_v2_bytes().unwrap();
        assert_eq!(bytes, vec![1u8]);
    }

    #[test]
    fn height_locked_v2_bytes_layout() {
        let k = KernelFeatures::HeightLocked {
            fee: 100,
            lock_height: 500_000,
        };
        let bytes = k.to_v2_bytes().unwrap();
        assert_eq!(bytes.len(), 17);
        assert_eq!(bytes[0], 2);
        assert_eq!(&bytes[1..9], &100u64.to_be_bytes());
        assert_eq!(&bytes[9..17], &500_000u64.to_be_bytes());
    }

    #[test]
    fn nrd_v2_bytes_layout() {
        let k = KernelFeatures::Nrd {
            fee: 23_500_000,
            relative_height: 1440, // ~1 day
        };
        let bytes = k.to_v2_bytes().unwrap();
        assert_eq!(bytes.len(), 11);
        assert_eq!(bytes[0], 3);
        assert_eq!(&bytes[1..9], &23_500_000u64.to_be_bytes());
        assert_eq!(&bytes[9..11], &1440u16.to_be_bytes());
    }

    #[test]
    fn nrd_rejects_zero_relative_height() {
        let k = KernelFeatures::Nrd {
            fee: 1,
            relative_height: 0,
        };
        assert!(k.to_v2_bytes().is_err());
        assert!(k.sig_msg().is_err());
    }

    #[test]
    fn nrd_rejects_relative_height_above_week() {
        let k = KernelFeatures::Nrd {
            fee: 1,
            relative_height: NRD_MAX_RELATIVE_HEIGHT + 1,
        };
        assert!(k.to_v2_bytes().is_err());
        assert!(k.sig_msg().is_err());
    }

    #[test]
    fn nrd_accepts_max_relative_height() {
        let k = KernelFeatures::Nrd {
            fee: 1,
            relative_height: NRD_MAX_RELATIVE_HEIGHT,
        };
        assert!(k.to_v2_bytes().is_ok());
        assert!(k.sig_msg().is_ok());
    }

    #[test]
    fn sig_msg_is_deterministic_per_features() {
        // Same features → same message; different features → different.
        let k1 = KernelFeatures::Plain { fee: 100 };
        let k2 = KernelFeatures::Plain { fee: 100 };
        let k3 = KernelFeatures::Plain { fee: 101 };
        assert_eq!(k1.sig_msg().unwrap(), k2.sig_msg().unwrap());
        assert_ne!(k1.sig_msg().unwrap(), k3.sig_msg().unwrap());
    }

    #[test]
    fn nrd_msg_round_trip_through_schnorr() {
        // End-to-end: build NRD kernel msg → sign with Schnorr →
        // verify against the corresponding pubkey. Proves the kernel
        // module composes cleanly with schnorr.
        let k = KernelFeatures::Nrd {
            fee: 8_000_000,
            relative_height: 1440,
        };
        let msg = k.sig_msg().unwrap();

        let sk = [3u8; 32];
        let nonce = [5u8; 32];
        let pk = public_key_from_secret_key(&sk).unwrap();

        let sig = schnorr::sign_with_nonce(&sk, &nonce, &msg).expect("sign kernel msg");
        let ok = schnorr::verify(&sig, &msg, &pk).expect("verify");
        assert!(ok);
    }
}
