//! Network parameters for BTC and LTC, mainnet and testnet.
//!
//! Litecoin shares Bitcoin's consensus rules and transaction format. The
//! only encoding-layer differences that matter to a wallet are:
//!
//! | Param            | BTC mainnet | BTC testnet | LTC mainnet | LTC testnet |
//! |------------------|-------------|-------------|-------------|-------------|
//! | bech32 HRP       | `bc`        | `tb`        | `ltc`       | `tltc`      |
//! | P2PKH version    | `0x00`      | `0x6F`      | `0x30`      | `0x6F`      |
//! | P2SH version     | `0x05`      | `0xC4`      | `0x32`      | `0x3A`      |
//! | xpub version     | `0x0488B21E`| `0x043587CF`| `0x019DA462`| `0x0436F6E1`|
//! | xprv version     | `0x0488ADE4`| `0x04358394`| `0x019D9CFE`| `0x0436EF7D`|
//! | BIP44 coin type  | `0`         | `1`         | `2`         | `1`         |

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    BtcMainnet,
    BtcTestnet,
    LtcMainnet,
    LtcTestnet,
}

// Per-network values are declared one arm per network rather than merged
// (e.g. `BtcTestnet | LtcTestnet => 1`) so each row is documented at its
// own line. Keeping the table form makes per-network changes a 1-line
// edit and keeps the table readable as a chain reference card.
#[allow(clippy::match_same_arms)]
impl Network {
    /// Bech32 / bech32m human-readable prefix used for P2WPKH and P2TR.
    pub fn bech32_hrp(self) -> &'static str {
        match self {
            Network::BtcMainnet => "bc",
            Network::BtcTestnet => "tb",
            Network::LtcMainnet => "ltc",
            Network::LtcTestnet => "tltc",
        }
    }

    /// P2PKH base58check version byte.
    pub fn p2pkh_version(self) -> u8 {
        match self {
            Network::BtcMainnet => 0x00,
            Network::BtcTestnet => 0x6F,
            Network::LtcMainnet => 0x30,
            Network::LtcTestnet => 0x6F,
        }
    }

    /// P2SH base58check version byte.
    pub fn p2sh_version(self) -> u8 {
        match self {
            Network::BtcMainnet => 0x05,
            Network::BtcTestnet => 0xC4,
            Network::LtcMainnet => 0x32,
            Network::LtcTestnet => 0x3A,
        }
    }

    /// BIP32 extended-public-key version bytes.
    pub fn xpub_version(self) -> [u8; 4] {
        match self {
            Network::BtcMainnet => [0x04, 0x88, 0xB2, 0x1E],
            Network::BtcTestnet => [0x04, 0x35, 0x87, 0xCF],
            Network::LtcMainnet => [0x01, 0x9D, 0xA4, 0x62],
            Network::LtcTestnet => [0x04, 0x36, 0xF6, 0xE1],
        }
    }

    /// BIP32 extended-private-key version bytes.
    pub fn xprv_version(self) -> [u8; 4] {
        match self {
            Network::BtcMainnet => [0x04, 0x88, 0xAD, 0xE4],
            Network::BtcTestnet => [0x04, 0x35, 0x83, 0x94],
            Network::LtcMainnet => [0x01, 0x9D, 0x9C, 0xFE],
            Network::LtcTestnet => [0x04, 0x36, 0xEF, 0x7D],
        }
    }

    /// BIP44 coin type. Used as the second derivation index in
    /// `m/purpose'/coin_type'/account'/...`.
    pub fn bip44_coin_type(self) -> u32 {
        match self {
            Network::BtcMainnet => 0,
            Network::BtcTestnet => 1,
            Network::LtcMainnet => 2,
            Network::LtcTestnet => 1,
        }
    }

    /// True if this is a Litecoin network. Used by the address layer to
    /// decide which version-byte / HRP set to use when rust-bitcoin's own
    /// network enum doesn't model LTC.
    pub fn is_litecoin(self) -> bool {
        matches!(self, Network::LtcMainnet | Network::LtcTestnet)
    }

    /// Map to rust-bitcoin's [`bitcoin::Network`] for primitives that don't
    /// care about the encoding layer (BIP32 derivation, sighash). For LTC
    /// we return the equivalent Bitcoin network — only the address-encoding
    /// layer needs LTC-specific handling.
    pub fn as_bitcoin_network(self) -> bitcoin::Network {
        match self {
            Network::BtcMainnet | Network::LtcMainnet => bitcoin::Network::Bitcoin,
            Network::BtcTestnet | Network::LtcTestnet => bitcoin::Network::Testnet,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coin_types_match_slip44() {
        assert_eq!(Network::BtcMainnet.bip44_coin_type(), 0);
        assert_eq!(Network::LtcMainnet.bip44_coin_type(), 2);
    }

    #[test]
    fn hrps_are_distinct_per_network() {
        let hrps = [
            Network::BtcMainnet.bech32_hrp(),
            Network::BtcTestnet.bech32_hrp(),
            Network::LtcMainnet.bech32_hrp(),
            Network::LtcTestnet.bech32_hrp(),
        ];
        let unique: std::collections::HashSet<_> = hrps.iter().collect();
        assert_eq!(unique.len(), 4);
    }
}
