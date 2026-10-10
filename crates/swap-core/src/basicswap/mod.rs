//! Offline BasicSwap v0.19.0 Nostr/SMSG compatibility.
//!
//! See `docs/swap-core.md` for the supported subset and authentication limits.

mod envelope;
mod messages;
mod routes;
mod wire;

pub use envelope::{receive, ReceivedMessage};
pub use messages::{Admission, Advertisement, Connect, Offer, OfferBook, Revoke};
pub use routes::{PendingRoute, Route};
pub use wire::WireMessage;

/// The reference implementation used by the differential fixture runner.
pub const REFERENCE_COMMIT: &str = "277b46b0278f1cc76199f7e847988647a1b36e38";
pub const MAX_EVENT_BYTES: usize = 72 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 48 * 1024;
pub const MAX_OFFER_SECONDS: u64 = 48 * 60 * 60;

/// Errors contain static reasons only; they never include keys or message bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error(pub(crate) &'static str);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn hex_array<const N: usize>(s: &str) -> Result<[u8; N]> {
    let mut value = [0; N];
    hex::decode_to_slice(s, &mut value).map_err(|_| Error("invalid hex length or encoding"))?;
    Ok(value)
}

#[cfg(test)]
mod tests;
