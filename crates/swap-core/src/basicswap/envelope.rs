use super::{hex_array, Error, Result, WireMessage, MAX_EVENT_BYTES, MAX_OFFER_SECONDS};
use base64::{engine::general_purpose::STANDARD, Engine};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use k256::{ecdsa, elliptic_curve::sec1::ToEncodedPoint, schnorr, PublicKey, SecretKey};
use ripemd::Ripemd160;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use zeroize::Zeroizing;

#[derive(Deserialize, Serialize)]
pub(super) struct Event {
    pub(super) id: String,
    pub(super) pubkey: String,
    pub(super) created_at: u64,
    pub(super) kind: u64,
    pub(super) tags: Vec<Vec<String>>,
    pub(super) content: String,
    pub(super) sig: String,
}

/// An authenticated payload, not evidence of funds or a safe swap protocol.
/// The Nostr author and SMSG sender are independent identities.
#[derive(Debug)]
pub struct ReceivedMessage {
    pub(crate) id: [u8; 28],
    pub(crate) sent: u64,
    pub(crate) expires: u64,
    pub(crate) sender: [u8; 33],
    pub(crate) recipient: [u8; 33],
    pub(crate) route_signer: [u8; 32],
    pub(crate) message: WireMessage,
}
impl ReceivedMessage {
    pub fn id(&self) -> &[u8; 28] {
        &self.id
    }
    pub fn sender(&self) -> &[u8; 33] {
        &self.sender
    }
    pub fn route_signer(&self) -> &[u8; 32] {
        &self.route_signer
    }
    pub fn sent(&self) -> u64 {
        self.sent
    }
    pub fn expires(&self) -> u64 {
        self.expires
    }
    pub fn message(&self) -> &WireMessage {
        &self.message
    }
}

pub(crate) fn hash160(data: &[u8]) -> [u8; 20] {
    Ripemd160::digest(Sha256::digest(data)).into()
}
pub(crate) fn sha256d(data: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(data)).into()
}
pub(crate) fn recover(hash: &[u8; 32], signature: &[u8]) -> Result<[u8; 33]> {
    if signature.len() != 65 || !(31..=34).contains(&signature[0]) {
        return Err(Error("invalid compressed recoverable signature"));
    }
    let id = ecdsa::RecoveryId::from_byte(signature[0] - 31)
        .ok_or(Error("invalid recovery identifier"))?;
    let sig = ecdsa::Signature::from_slice(&signature[1..])
        .map_err(|_| Error("invalid ECDSA signature"))?;
    let key = ecdsa::VerifyingKey::recover_from_prehash(hash, &sig, id)
        .map_err(|_| Error("sender signature recovery failed"))?;
    key.to_encoded_point(true)
        .as_bytes()
        .try_into()
        .map_err(|_| Error("invalid sender key"))
}

pub(super) fn encryption_keys(public: &PublicKey, secret: &SecretKey) -> Zeroizing<[u8; 64]> {
    // libsecp256k1's ECDH default hashes the compressed shared point, including parity.
    let shared = (public.to_projective() * secret.to_nonzero_scalar().as_ref()).to_affine();
    let encoded = Zeroizing::new(shared.to_encoded_point(true).as_bytes().to_vec());
    let shared_hash = Zeroizing::new(<[u8; 32]>::from(Sha256::digest(encoded.as_slice())));
    Zeroizing::new(<[u8; 64]>::from(Sha512::digest(shared_hash.as_slice())))
}

pub(super) fn event_digest(event: &Event) -> Result<[u8; 32]> {
    let canonical = serde_json::to_vec(&(
        0u8,
        &event.pubkey,
        event.created_at,
        event.kind,
        &event.tags,
        &event.content,
    ))
    .map_err(|_| Error("event serialization failed"))?;
    Ok(Sha256::digest(&canonical).into())
}

/// Validate a single event and decrypt an uncompressed format-2 SMSG payload.
/// `recipient` is a dedicated messaging key. No wallet or social key is derived.
/// No network, clock, persistent state or replay cache is accessed here.
pub fn receive(json: &[u8], recipient: &SecretKey, now: u64) -> Result<ReceivedMessage> {
    if json.len() > MAX_EVENT_BYTES {
        return Err(Error("event exceeds size limit"));
    }
    let event: Event = serde_json::from_slice(json).map_err(|_| Error("invalid event JSON"))?;
    if event.kind != 4859 {
        return Err(Error("unsupported event kind"));
    }
    if !event
        .tags
        .iter()
        .any(|t| t.len() >= 2 && t[0] == "t" && t[1] == "bsx")
    {
        return Err(Error("missing BasicSwap broadcast tag"));
    }
    let mut expirations = event
        .tags
        .iter()
        .filter(|t| t.first().is_some_and(|s| s == "expiration"));
    let expiration = expirations
        .next()
        .and_then(|t| t.get(1))
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or(Error("missing or invalid expiration"))?;
    if expirations.next().is_some() {
        return Err(Error("duplicate expiration tag"));
    }
    if expiration <= now {
        return Err(Error("event expired"));
    }
    let latest = now.checked_add(600).ok_or(Error("clock overflow"))?;
    if event.created_at > latest {
        return Err(Error("event timestamp is in the future"));
    }
    let digest = event_digest(&event)?;
    if digest != hex_array::<32>(&event.id)? {
        return Err(Error("event identifier mismatch"));
    }
    let route_signer = hex_array(&event.pubkey)?;
    let key =
        schnorr::VerifyingKey::from_bytes(&route_signer).map_err(|_| Error("invalid event key"))?;
    let signature_bytes = hex_array::<64>(&event.sig)?;
    let signature = schnorr::Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| Error("invalid event signature"))?;
    key.verify_raw(&digest, &signature)
        .map_err(|_| Error("event signature verification failed"))?;
    let data = STANDARD
        .decode(event.content)
        .map_err(|_| Error("invalid event base64"))?;
    if data.len() <= 108 {
        return Err(Error("truncated SMSG header"));
    }
    if data[8..11] != [2, 1, 0] {
        return Err(Error("unsupported SMSG version or flags"));
    }
    let sent = u64::from_le_bytes(data[11..19].try_into().expect("fixed header"));
    let ttl = u64::from(u32::from_le_bytes(
        data[19..23].try_into().expect("fixed header"),
    ));
    let expires = sent
        .checked_add(ttl)
        .ok_or(Error("SMSG expiration overflow"))?;
    if ttl == 0
        || ttl > MAX_OFFER_SECONDS
        || expires != expiration
        || sent > latest
        || expires <= now
    {
        return Err(Error("invalid SMSG lifetime"));
    }
    let declared_len = u32::from_le_bytes(data[104..108].try_into().expect("fixed header"));
    let ciphertext = &data[108..];
    if usize::try_from(declared_len).ok() != Some(ciphertext.len()) || ciphertext.len() % 16 != 0 {
        return Err(Error("invalid ciphertext length"));
    }
    let ephemeral =
        PublicKey::from_sec1_bytes(&data[39..72]).map_err(|_| Error("invalid ephemeral key"))?;
    let keys = encryption_keys(&ephemeral, recipient);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&keys[32..]).map_err(|_| Error("invalid MAC key"))?;
    mac.update(&data[11..19]);
    mac.update(&data[23..39]);
    mac.update(ciphertext);
    mac.verify_slice(&data[72..104])
        .map_err(|_| Error("SMSG authentication failed"))?;
    let mut buffer = Zeroizing::new(ciphertext.to_vec());
    let plaintext = cbc::Decryptor::<aes::Aes256>::new_from_slices(&keys[..32], &data[23..39])
        .map_err(|_| Error("invalid encryption parameters"))?
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| Error("invalid ciphertext padding"))?;
    if plaintext.len() < 91 || plaintext[..2] != [249, 0] {
        return Err(Error("unsupported or truncated SMSG payload format"));
    }
    let payload = &plaintext[91..];
    let declared = u32::from_le_bytes(plaintext[87..91].try_into().expect("fixed payload header"));
    if usize::try_from(declared).ok() != Some(payload.len()) {
        return Err(Error("payload length mismatch"));
    }
    let sender = recover(&sha256d(payload), &plaintext[22..87])?;
    if hash160(&sender).as_slice() != &plaintext[2..22] {
        return Err(Error("sender key hash mismatch"));
    }
    let mut id = [0; 28];
    id[..8].copy_from_slice(&sent.to_be_bytes());
    id[8..].copy_from_slice(&Ripemd160::digest(&data[8..]));
    Ok(ReceivedMessage {
        id,
        sent,
        expires,
        sender,
        route_signer,
        recipient: recipient
            .public_key()
            .to_encoded_point(true)
            .as_bytes()
            .try_into()
            .expect("compressed key"),
        message: WireMessage::decode(payload)?,
    })
}
