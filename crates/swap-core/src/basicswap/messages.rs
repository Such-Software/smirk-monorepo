use super::{
    envelope::{hash160, recover, sha256d},
    hex_array, Error, ReceivedMessage, Result, WireMessage, MAX_OFFER_SECONDS,
};
use serde::Deserialize;
use std::collections::BTreeMap;

/// Decoded advertisement terms. Chain-specific amounts, fees and refund safety
/// are not qualified by this type. Integer amounts retain their native units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub protocol_version: u64,
    pub coin_from: u64,
    pub coin_to: u64,
    pub amount_from: u64,
    pub amount_to: u64,
    pub min_bid_amount: u64,
    pub time_valid: u64,
    pub lock_type: u64,
    pub lock_value: u64,
    pub swap_type: u64,
    pub message_nets: String,
}
impl Offer {
    pub fn decode(wire: &WireMessage) -> Result<Self> {
        if wire.kind() != 1 {
            return Err(Error("expected offer"));
        }
        let offer = Self {
            protocol_version: wire.integer(1)?,
            coin_from: wire.integer(2)?,
            coin_to: wire.integer(3)?,
            amount_from: wire.integer(4)?,
            amount_to: wire.integer(5)?,
            min_bid_amount: wire.integer(6)?,
            time_valid: wire.integer(7)?,
            lock_type: wire.integer(8)?,
            lock_value: wire.integer(9)?,
            swap_type: wire.integer(10)?,
            message_nets: wire.string(21)?.into(),
        };
        if !matches!(offer.coin_from, 2 | 3 | 6 | 9)
            || !matches!(offer.coin_to, 2 | 3 | 6 | 9)
            || offer.coin_from == offer.coin_to
        {
            return Err(Error("unsupported offer pair"));
        }
        let privacy_from = matches!(offer.coin_from, 6 | 9);
        let privacy_to = matches!(offer.coin_to, 6 | 9);
        if privacy_from && privacy_to {
            return Err(Error("two scriptless assets are unsupported"));
        }
        let valid_protocol = match offer.swap_type {
            1 => !privacy_from && !privacy_to && (4..=5).contains(&offer.protocol_version),
            5 => (6..=7).contains(&offer.protocol_version),
            _ => false,
        };
        if !valid_protocol {
            return Err(Error("unsupported offer protocol"));
        }
        if offer.amount_from == 0
            || offer.amount_to == 0
            || offer.min_bid_amount == 0
            || offer.min_bid_amount > offer.amount_from
        {
            return Err(Error("invalid offer amounts"));
        }
        if !(600..=MAX_OFFER_SECONDS).contains(&offer.time_valid)
            || !(1..=4).contains(&offer.lock_type)
            || offer.lock_value == 0
        {
            return Err(Error("invalid offer lifetime or lock declaration"));
        }
        for field in 11..=14 {
            if !wire.bytes(field)?.is_empty() {
                return Err(Error("unexpected offer proof data"));
            }
        }
        // Retained as an advertisement string, not interpreted as connection authority.
        if offer.message_nets.len() > 256 {
            return Err(Error("message network declaration too long"));
        }
        Ok(offer)
    }
}

#[derive(Debug, Clone)]
pub struct Advertisement {
    pub(crate) id: [u8; 28],
    pub(crate) sender: [u8; 33],
    pub(crate) expires: u64,
    pub(crate) terms: Offer,
}
impl Advertisement {
    pub fn from_received(msg: &ReceivedMessage, now: u64) -> Result<Self> {
        let terms = Offer::decode(&msg.message)?;
        let expires = msg
            .sent
            .checked_add(terms.time_valid)
            .ok_or(Error("offer expiration overflow"))?
            .min(msg.expires);
        if expires <= now {
            return Err(Error("offer expired"));
        }
        Ok(Self {
            id: msg.id,
            sender: msg.sender,
            expires,
            terms,
        })
    }
    pub fn id(&self) -> &[u8; 28] {
        &self.id
    }
    pub fn sender(&self) -> &[u8; 33] {
        &self.sender
    }
    pub fn expires(&self) -> u64 {
        self.expires
    }
    pub fn terms(&self) -> &Offer {
        &self.terms
    }
}

/// A revocation signed with the offer sender's Bitcoin-message-compatible key.
#[derive(Debug)]
pub struct Revoke {
    pub(crate) offer_id: [u8; 28],
    pub(crate) sender: [u8; 33],
    pub(crate) retain_until: u64,
}
impl Revoke {
    pub fn from_received(msg: &ReceivedMessage, now: u64) -> Result<Self> {
        if msg.message.kind() != 11 {
            return Err(Error("expected offer revocation"));
        }
        let offer_id: [u8; 28] = msg
            .message
            .bytes(1)?
            .try_into()
            .map_err(|_| Error("invalid revoked offer identifier"))?;
        let text = format!("{}_revoke", hex::encode(offer_id));
        let magic = b"Bitcoin Signed Message:\n";
        let mut signed = vec![u8::try_from(magic.len()).expect("fixed magic length")];
        signed.extend_from_slice(magic);
        signed.push(u8::try_from(text.len()).expect("fixed revocation text length"));
        signed.extend_from_slice(text.as_bytes());
        let sender = recover(&sha256d(&signed), msg.message.bytes(2)?)?;
        if sender != msg.sender {
            return Err(Error("revocation signer differs from sender"));
        }
        let sent = u64::from_be_bytes(offer_id[..8].try_into().expect("fixed identifier"));
        let retain_until = sent
            .checked_add(MAX_OFFER_SECONDS + 600)
            .ok_or(Error("revocation expiration overflow"))?;
        if retain_until <= now || sent > now.saturating_add(600) || msg.expires <= now {
            return Err(Error("invalid revocation lifetime"));
        }
        Ok(Self {
            offer_id,
            sender,
            retain_until,
        })
    }
}

/// Parsed connection request. Authentication is checked against both envelopes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectData {
    offer_id: String,
    bsx_address: String,
    nostr_pubkey: String,
    #[serde(default)]
    req_pubkey: Option<String>,
}
#[derive(Debug)]
pub struct Connect {
    pub(crate) offer_id: [u8; 28],
    pub(crate) sender: [u8; 33],
    pub(crate) recipient: [u8; 33],
    pub(crate) route_key: [u8; 32],
    pub(crate) requested_key: Option<[u8; 32]>,
    pub(crate) sent: u64,
    pub(crate) expires: u64,
}
impl Connect {
    /// `address_prefix` selects Particl's SMSG address namespace, not a daemon.
    pub fn from_received(msg: &ReceivedMessage, address_prefix: u8, now: u64) -> Result<Self> {
        if msg.message.kind() != 14
            || msg.message.integer(1)? != 3
            || msg.message.bytes(2)? != b"bsx"
        {
            return Err(Error("unsupported connection network"));
        }
        if msg.expires <= now {
            return Err(Error("connection message expired"));
        }
        let data: ConnectData = serde_json::from_slice(msg.message.bytes(4)?)
            .map_err(|_| Error("invalid connection data"))?;
        let route_key = hex_array(&data.nostr_pubkey)?;
        if route_key != msg.route_signer {
            return Err(Error("announced route key did not sign the event"));
        }
        let address = bs58::decode(data.bsx_address)
            .with_check(Some(address_prefix))
            .into_vec()
            .map_err(|_| Error("invalid messaging address"))?;
        if address.len() != 21 || address[1..] != hash160(&msg.sender) {
            return Err(Error(
                "connection address differs from authenticated sender",
            ));
        }
        let requested_key = data.req_pubkey.as_deref().map(hex_array).transpose()?;
        match (msg.message.integer(3)?, requested_key.is_some()) {
            (1, false) | (2, true) => {}
            _ => return Err(Error("invalid connection request type or key echo")),
        }
        Ok(Self {
            offer_id: hex_array(&data.offer_id)?,
            sender: msg.sender,
            recipient: msg.recipient,
            route_key,
            requested_key,
            sent: msg.sent,
            expires: msg.expires,
        })
    }
}

/// Bounded in-memory observation cache. It is not a persistent order book or
/// a funding authorization source. Callers must persist tombstones before use
/// across restarts; the current wallet has no caller for this experimental API.
pub struct OfferBook {
    offers: BTreeMap<[u8; 28], Advertisement>,
    revoked: BTreeMap<([u8; 28], [u8; 33]), u64>,
    capacity: usize,
    last_now: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Added,
    Duplicate,
    Revoked,
}
impl OfferBook {
    pub fn new(capacity: usize) -> Result<Self> {
        if capacity == 0 || capacity > 4096 {
            return Err(Error("invalid cache capacity"));
        }
        Ok(Self {
            offers: BTreeMap::new(),
            revoked: BTreeMap::new(),
            capacity,
            last_now: 0,
        })
    }
    fn expire(&mut self, now: u64) -> Result<()> {
        if now < self.last_now {
            return Err(Error("observation clock moved backwards"));
        }
        self.last_now = now;
        self.offers.retain(|_, offer| offer.expires > now);
        self.revoked.retain(|_, until| *until > now);
        Ok(())
    }
    pub fn admit(&mut self, offer: Advertisement, now: u64) -> Result<Admission> {
        self.expire(now)?;
        if offer.expires <= now {
            return Err(Error("offer expired"));
        }
        if self.revoked.contains_key(&(offer.id, offer.sender)) {
            return Ok(Admission::Revoked);
        }
        if self.offers.contains_key(&offer.id) {
            return Ok(Admission::Duplicate);
        }
        if self.offers.len() >= self.capacity {
            return Err(Error("offer cache is full"));
        }
        self.offers.insert(offer.id, offer);
        Ok(Admission::Added)
    }
    pub fn revoke(&mut self, revoke: &Revoke, now: u64) -> Result<()> {
        self.expire(now)?;
        if revoke.retain_until <= now {
            return Err(Error("revocation expired"));
        }
        let key = (revoke.offer_id, revoke.sender);
        if !self.revoked.contains_key(&key) && self.revoked.len() >= self.capacity {
            return Err(Error("revocation cache is full"));
        }
        self.revoked.insert(key, revoke.retain_until);
        if self
            .offers
            .get(&revoke.offer_id)
            .is_some_and(|o| o.sender == revoke.sender)
        {
            self.offers.remove(&revoke.offer_id);
        }
        Ok(())
    }
}
