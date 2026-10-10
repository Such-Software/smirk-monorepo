//! Offline connection messages. Preparation never publishes or authorizes funds.
use super::{
    envelope::{encryption_keys, event_digest, hash160, sha256d, Event},
    Advertisement, Connect, Error, Result, MAX_EVENT_BYTES, MAX_OFFER_SECONDS,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use k256::{
    ecdsa,
    elliptic_curve::{rand_core::CryptoRngCore, sec1::ToEncodedPoint},
    schnorr, PublicKey, SecretKey,
};
use ripemd::Ripemd160;
use serde_json::json;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Caller-owned, distinct messaging and route keys. Neither is a spending key.
pub struct MessageContext<'a> {
    pub sender: &'a SecretKey,
    pub recipient: &'a PublicKey,
    pub event_signer: &'a SecretKey,
    pub address_prefix: u8,
    pub sent: u64,
    pub ttl_seconds: u32,
}

/// An encrypted draft with no retained private key. Work is advanced in bounded
/// increments so a worker can yield or discard an unfunded request.
pub struct ConnectionDraft {
    raw: Vec<u8>,
    signer: [u8; 32],
    sent: u64,
    expires: u64,
    next_nonce: u32,
    ready: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum WorkProgress {
    Pending,
    Ready,
}

/// Immutable signed bytes for an outbox. This type proves preparation only.
/// A storage adapter must commit the encrypted session and exact bytes before
/// publication. A relay receipt does not prove peer acceptance.
pub struct PreparedEnvelope {
    json: Vec<u8>,
    id: [u8; 28],
    event_id: [u8; 32],
    expires: u64,
}
impl PreparedEnvelope {
    pub fn as_bytes(&self) -> &[u8] {
        &self.json
    }
    pub fn id(&self) -> &[u8; 28] {
        &self.id
    }
    pub fn event_id(&self) -> &[u8; 32] {
        &self.event_id
    }
    pub fn expires(&self) -> u64 {
        self.expires
    }
}
fn public(secret: &SecretKey) -> [u8; 33] {
    secret
        .public_key()
        .to_encoded_point(true)
        .as_bytes()
        .try_into()
        .expect("compressed key")
}
fn xonly(secret: &SecretKey) -> [u8; 32] {
    public(secret)[1..].try_into().expect("x coordinate")
}
fn address(context: &MessageContext<'_>) -> String {
    let mut bytes = vec![context.address_prefix];
    bytes.extend_from_slice(&hash160(&public(context.sender)));
    bs58::encode(bytes).with_check().into_string()
}
fn put_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 128 {
        out.push(u8::try_from(value & 127).expect("seven bits") | 128);
        value >>= 7;
    }
    out.push(u8::try_from(value).expect("seven bits"));
}
fn payload(data: &serde_json::Value, ack: bool) -> Result<Vec<u8>> {
    let data = serde_json::to_vec(data).map_err(|_| Error("connection serialization failed"))?;
    // CONNECT_REQ: network_type=3, network_data="bsx", request_type, request_data.
    let mut bytes = vec![
        14,
        8,
        3,
        18,
        3,
        b'b',
        b's',
        b'x',
        24,
        if ack { 2 } else { 1 },
        34,
    ];
    put_varint(
        u64::try_from(data.len()).map_err(|_| Error("connection length overflow"))?,
        &mut bytes,
    );
    bytes.extend_from_slice(&data);
    Ok(bytes)
}
/// Request the full advertised amount. Partial fills and price negotiation are
/// outside this constructor. Establishing a route does not accept a trade.
pub fn prepare_request(
    offer: &Advertisement,
    context: &MessageContext<'_>,
    rng: &mut impl CryptoRngCore,
) -> Result<ConnectionDraft> {
    if context.recipient.to_encoded_point(true).as_bytes() != offer.sender
        || context.sent >= offer.expires
    {
        return Err(Error("request recipient or lifetime differs from offer"));
    }
    let data = json!({"offer_id": hex::encode(offer.id), "amount_from": offer.terms.amount_from,
        "amount_to": offer.terms.amount_to, "bsx_address": address(context),
        "nostr_pubkey": hex::encode(xonly(context.event_signer))});
    encrypt(&payload(&data, false)?, context, rng)
}
/// Acknowledge an authenticated peer route. The amount is not accepted here.
pub fn prepare_ack(
    request: &Connect,
    context: &MessageContext<'_>,
    rng: &mut impl CryptoRngCore,
) -> Result<ConnectionDraft> {
    if request.requested_key.is_some()
        || public(context.sender) != request.recipient
        || context.recipient.to_encoded_point(true).as_bytes() != request.sender
        || context.sent >= request.expires
    {
        return Err(Error("ACK parties or lifetime differ from request"));
    }
    let data = json!({"offer_id": hex::encode(request.offer_id), "bsx_address": address(context),
        "nostr_pubkey": hex::encode(xonly(context.event_signer)), "req_pubkey": hex::encode(request.route_key)});
    encrypt(&payload(&data, true)?, context, rng)
}
fn random_secret(rng: &mut impl CryptoRngCore) -> Result<SecretKey> {
    let mut bytes = Zeroizing::new([0; 32]);
    for _ in 0..128 {
        rng.try_fill_bytes(bytes.as_mut())
            .map_err(|_| Error("messaging entropy unavailable"))?;
        if let Ok(secret) = SecretKey::from_slice(bytes.as_ref()) {
            return Ok(secret);
        }
    }
    Err(Error("messaging entropy did not produce a valid scalar"))
}
fn encrypt(
    payload: &[u8],
    context: &MessageContext<'_>,
    rng: &mut impl CryptoRngCore,
) -> Result<ConnectionDraft> {
    let ttl = u64::from(context.ttl_seconds);
    let expires = context
        .sent
        .checked_add(ttl)
        .ok_or(Error("message expiration overflow"))?;
    if !(3600..=MAX_OFFER_SECONDS).contains(&ttl) || payload.len() > 2048 {
        return Err(Error("unsupported outgoing connection size or lifetime"));
    }
    if xonly(context.sender) == xonly(context.event_signer) {
        return Err(Error("messaging and route keys must be distinct"));
    }
    let ephemeral = random_secret(rng)?;
    let mut iv = [0; 16];
    rng.try_fill_bytes(&mut iv)
        .map_err(|_| Error("messaging entropy unavailable"))?;
    let keys = encryption_keys(context.recipient, &ephemeral);
    let secret_bytes = Zeroizing::new(context.sender.to_bytes());
    let signing = ecdsa::SigningKey::from_bytes(&secret_bytes)
        .map_err(|_| Error("invalid messaging signing key"))?;
    let (signature, recovery) = signing
        .sign_prehash_recoverable(&sha256d(payload))
        .map_err(|_| Error("message signing failed"))?;
    let mut plaintext = Zeroizing::new(vec![249, 0]);
    plaintext.extend_from_slice(&hash160(&public(context.sender)));
    plaintext.push(31 + recovery.to_byte());
    plaintext.extend_from_slice(&signature.to_bytes());
    plaintext.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| Error("payload length overflow"))?
            .to_le_bytes(),
    );
    plaintext.extend_from_slice(payload);
    let ciphertext = cbc::Encryptor::<aes::Aes256>::new_from_slices(&keys[..32], &iv)
        .map_err(|_| Error("invalid encryption parameters"))?
        .encrypt_padded_vec_mut::<Pkcs7>(&plaintext);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&keys[32..]).map_err(|_| Error("invalid MAC key"))?;
    mac.update(&context.sent.to_le_bytes());
    mac.update(&iv);
    mac.update(&ciphertext);
    let mut raw = vec![0; 8];
    raw.extend_from_slice(&[2, 1, 0]);
    raw.extend_from_slice(&context.sent.to_le_bytes());
    raw.extend_from_slice(&context.ttl_seconds.to_le_bytes());
    raw.extend_from_slice(&iv);
    raw.extend_from_slice(&public(&ephemeral));
    raw.extend_from_slice(&mac.finalize().into_bytes());
    raw.extend_from_slice(
        &u32::try_from(ciphertext.len())
            .map_err(|_| Error("ciphertext length overflow"))?
            .to_le_bytes(),
    );
    raw.extend_from_slice(&ciphertext);
    Ok(ConnectionDraft {
        raw,
        signer: xonly(context.event_signer),
        sent: context.sent,
        expires,
        next_nonce: 0,
        ready: false,
    })
}
impl ConnectionDraft {
    /// Match the reference SMSG target 0x1effffff. Nostr NIP-13 work is separate
    /// and is not added. A call performs at most 4096 attempts; total work is capped.
    pub fn advance_work(&mut self, attempts: u32) -> Result<WorkProgress> {
        if attempts == 0 || attempts > 4096 {
            return Err(Error("invalid work batch size"));
        }
        if self.ready {
            return Ok(WorkProgress::Ready);
        }
        let end = self.next_nonce.saturating_add(attempts).min(1_000_000);
        let mut target = [0u8; 32];
        target[27..30].fill(255);
        while self.next_nonce < end {
            let nonce = self.next_nonce.to_le_bytes();
            self.raw[4..8].copy_from_slice(&nonce);
            let mut nonce_key = [0; 32];
            for chunk in nonce_key.chunks_exact_mut(4) {
                chunk.copy_from_slice(&nonce);
            }
            let mut mac = Hmac::<Sha256>::new_from_slice(&nonce_key)
                .map_err(|_| Error("invalid work key"))?;
            mac.update(&self.raw[4..]);
            let hash = mac.finalize().into_bytes();
            self.next_nonce += 1;
            if hash.iter().rev().cmp(target.iter().rev()).is_le() {
                self.raw[..4].copy_from_slice(&hash[..4]);
                self.ready = true;
                return Ok(WorkProgress::Ready);
            }
        }
        if self.next_nonce == 1_000_000 {
            return Err(Error("SMSG work budget exhausted"));
        }
        Ok(WorkProgress::Pending)
    }
    /// Finish once, with fresh BIP340 auxiliary randomness. Persist these exact
    /// bytes before publication and reuse them for retries without extending TTL.
    pub fn finish(
        self,
        signer: &SecretKey,
        now: u64,
        rng: &mut impl CryptoRngCore,
    ) -> Result<PreparedEnvelope> {
        if !self.ready {
            return Err(Error("SMSG work is incomplete"));
        }
        if now >= self.expires || self.sent > now.saturating_add(600) {
            return Err(Error("outgoing message expired or future-dated"));
        }
        if xonly(signer) != self.signer {
            return Err(Error("route signing key changed during preparation"));
        }
        let mut event = Event {
            id: String::new(),
            pubkey: hex::encode(self.signer),
            created_at: now,
            kind: 4859,
            tags: vec![
                vec!["t".into(), "bsx".into()],
                vec!["expiration".into(), self.expires.to_string()],
            ],
            content: STANDARD.encode(&self.raw),
            sig: String::new(),
        };
        let event_id = event_digest(&event)?;
        let key_bytes = Zeroizing::new(signer.to_bytes());
        let key = schnorr::SigningKey::from_bytes(&key_bytes)
            .map_err(|_| Error("invalid route signing key"))?;
        let mut auxiliary = Zeroizing::new([0; 32]);
        rng.try_fill_bytes(auxiliary.as_mut())
            .map_err(|_| Error("messaging entropy unavailable"))?;
        let sig = key
            .sign_prehash_with_aux_rand(&event_id, &auxiliary)
            .map_err(|_| Error("event signing failed"))?;
        event.id = hex::encode(event_id);
        event.sig = hex::encode(sig.to_bytes());
        let json = serde_json::to_vec(&event).map_err(|_| Error("event serialization failed"))?;
        if json.len() > MAX_EVENT_BYTES {
            return Err(Error("outgoing event exceeds size limit"));
        }
        let mut id = [0; 28];
        id[..8].copy_from_slice(&self.sent.to_be_bytes());
        id[8..].copy_from_slice(&Ripemd160::digest(&self.raw[8..]));
        Ok(PreparedEnvelope {
            json,
            id,
            event_id,
            expires: self.expires,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::rand_core::{CryptoRng, Error as RngError, RngCore, SeedableRng};
    use rand_chacha::ChaCha20Rng;

    fn rng() -> ChaCha20Rng {
        ChaCha20Rng::from_seed(Sha256::digest(b"fundless outbound unit tests").into())
    }
    struct FailingEntropy;
    impl CryptoRng for FailingEntropy {}
    impl RngCore for FailingEntropy {
        fn next_u32(&mut self) -> u32 {
            panic!("fallible entropy path required")
        }
        fn next_u64(&mut self) -> u64 {
            panic!("fallible entropy path required")
        }
        fn fill_bytes(&mut self, _: &mut [u8]) {
            panic!("fallible entropy path required")
        }
        fn try_fill_bytes(&mut self, _: &mut [u8]) -> std::result::Result<(), RngError> {
            Err(RngError::from(
                std::num::NonZeroU32::new(RngError::CUSTOM_START).unwrap(),
            ))
        }
    }
    #[test]
    fn entropy_and_identity_failures_leave_no_prepared_envelope() {
        let mut rng = rng();
        let sender = random_secret(&mut rng).unwrap();
        let signer = random_secret(&mut rng).unwrap();
        let recipient = random_secret(&mut rng).unwrap().public_key();
        let mut context = MessageContext {
            sender: &sender,
            recipient: &recipient,
            event_signer: &signer,
            address_prefix: 118,
            sent: 1000,
            ttl_seconds: 3600,
        };
        assert!(encrypt(b"fixture", &context, &mut FailingEntropy).is_err());
        context.event_signer = &sender;
        assert!(encrypt(b"fixture", &context, &mut rng).is_err());
        context.event_signer = &signer;
        context.ttl_seconds = 1;
        assert!(encrypt(b"fixture", &context, &mut rng).is_err());
        context.sent = u64::MAX;
        context.ttl_seconds = 3600;
        assert!(encrypt(b"fixture", &context, &mut rng).is_err());
    }
    #[test]
    fn work_is_bounded_and_cannot_be_skipped() {
        let mut rng = rng();
        let sender = random_secret(&mut rng).unwrap();
        let signer = random_secret(&mut rng).unwrap();
        let recipient = random_secret(&mut rng).unwrap().public_key();
        let context = MessageContext {
            sender: &sender,
            recipient: &recipient,
            event_signer: &signer,
            address_prefix: 118,
            sent: 1000,
            ttl_seconds: 3600,
        };
        let mut draft = encrypt(b"fixture", &context, &mut rng).unwrap();
        assert!(draft.advance_work(0).is_err());
        assert!(draft.advance_work(4097).is_err());
        assert_eq!(draft.next_nonce, 0);
        assert!(draft.finish(&signer, 1000, &mut rng).is_err());
        let mut draft = encrypt(b"fixture", &context, &mut rng).unwrap();
        draft.advance_work(1).unwrap();
        assert_eq!(draft.next_nonce, 1);
        draft.next_nonce = 1_000_000;
        assert!(draft.advance_work(1).is_err());
    }
    #[test]
    fn completed_work_binds_expiry_key_and_stable_retry_bytes() {
        let mut rng = rng();
        let sender = random_secret(&mut rng).unwrap();
        let signer = random_secret(&mut rng).unwrap();
        let other = random_secret(&mut rng).unwrap();
        let recipient = random_secret(&mut rng).unwrap().public_key();
        let context = MessageContext {
            sender: &sender,
            recipient: &recipient,
            event_signer: &signer,
            address_prefix: 118,
            sent: 1000,
            ttl_seconds: 3600,
        };
        let mut draft = encrypt(b"fixture", &context, &mut rng).unwrap();
        while draft.advance_work(4096).unwrap() != WorkProgress::Ready {}
        let copy = || ConnectionDraft {
            raw: draft.raw.clone(),
            signer: draft.signer,
            sent: draft.sent,
            expires: draft.expires,
            next_nonce: draft.next_nonce,
            ready: draft.ready,
        };
        assert!(copy().finish(&signer, 4600, &mut rng).is_err());
        assert!(copy().finish(&other, 1000, &mut rng).is_err());
        assert!(copy().finish(&signer, 1000, &mut FailingEntropy).is_err());
        let prepared = copy().finish(&signer, 1000, &mut rng).unwrap();
        let stored = prepared.as_bytes().to_vec();
        assert_eq!(prepared.as_bytes(), stored);
        let event: Event = serde_json::from_slice(&stored).unwrap();
        assert_eq!(event_digest(&event).unwrap(), *prepared.event_id());
        assert_eq!(prepared.expires(), 4600);
        assert_eq!(draft.advance_work(1).unwrap(), WorkProgress::Ready);
    }
}
