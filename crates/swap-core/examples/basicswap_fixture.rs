//! Fundless differential-test adapter. Input stays on stdin; output contains no secrets.
use k256::{elliptic_curve::rand_core::SeedableRng, PublicKey, SecretKey};
use rand_chacha::ChaCha20Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read};
use swap_core::basicswap::{
    self, Admission, Advertisement, Connect, OfferBook, PendingRoute, Revoke, Route,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
struct Envelope {
    recipient: String,
    event: Value,
}
#[derive(Deserialize)]
struct Input {
    now: u64,
    prefix: u8,
    envelopes: Vec<Envelope>,
    #[serde(default)]
    flow: bool,
    #[serde(default)]
    outbound: Option<Outbound>,
}
#[derive(Deserialize)]
struct Outbound {
    sender: String,
    signer: String,
    recipient_public: String,
    entropy: String,
    kind: String,
    #[serde(default)]
    ttl: Option<u32>,
}
fn run(input: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let request: Input = serde_json::from_str(input).map_err(|_| "invalid fixture input")?;
    let mut messages = Vec::new();
    let mut outputs = Vec::new();
    for envelope in request.envelopes {
        let secret_text = Zeroizing::new(envelope.recipient);
        let bytes = Zeroizing::new(
            hex::decode(secret_text.as_str()).map_err(|_| "invalid fixture key encoding")?,
        );
        let secret = SecretKey::from_slice(&bytes).map_err(|_| "invalid fixture key")?;
        let msg = basicswap::receive(&serde_json::to_vec(&envelope.event)?, &secret, request.now)?;
        match msg.message().kind() {
            1 => {
                Advertisement::from_received(&msg, request.now)?;
            }
            11 => {
                Revoke::from_received(&msg, request.now)?;
            }
            14 => {
                Connect::from_received(&msg, request.prefix, request.now)?;
            }
            _ => return Err("unexpected fixture kind".into()),
        }
        outputs.push(json!({"id": hex::encode(msg.id()), "sender": hex::encode(msg.sender()),
            "route_signer": hex::encode(msg.route_signer()), "payload": hex::encode(msg.message().encode())}));
        messages.push(msg);
    }
    if request.flow {
        if messages.len() != 4 {
            return Err("flow requires offer, request, ACK and revocation".into());
        }
        let offer = Advertisement::from_received(&messages[0], request.now)?;
        let req = Connect::from_received(&messages[1], request.prefix, request.now)?;
        let ack = Connect::from_received(&messages[2], request.prefix, request.now)?;
        let revoke = Revoke::from_received(&messages[3], request.now)?;
        let pending = PendingRoute::from_request(&req, &offer, request.now)?;
        let taker = pending.accept(&ack, request.now)?;
        let mut maker =
            Route::accept_request(&req, &offer, *messages[2].route_signer(), request.now)?;
        maker.update_request(&req, request.now)?;
        if taker.local_key() != maker.remote_key() || taker.remote_key() != maker.local_key() {
            return Err("route endpoints disagree".into());
        }
        let mut book = OfferBook::new(2)?;
        if book.admit(offer.clone(), request.now)? != Admission::Added
            || book.admit(offer.clone(), request.now)? != Admission::Duplicate
        {
            return Err("offer deduplication failed".into());
        }
        book.revoke(&revoke, request.now)?;
        if book.admit(offer.clone(), request.now)? != Admission::Revoked {
            return Err("revocation did not suppress offer".into());
        }
        let mut reordered = OfferBook::new(2)?;
        reordered.revoke(&revoke, request.now)?;
        if reordered.admit(offer, request.now)? != Admission::Revoked {
            return Err("early revocation did not suppress offer".into());
        }
    }
    let outgoing = if let Some(input) = request.outbound {
        fn secret(value: String) -> Result<SecretKey, Box<dyn std::error::Error>> {
            let text = Zeroizing::new(value);
            let bytes = Zeroizing::new(
                hex::decode(text.as_str()).map_err(|_| "invalid fixture secret encoding")?,
            );
            Ok(SecretKey::from_slice(&bytes).map_err(|_| "invalid fixture secret")?)
        }
        let sender = secret(input.sender)?;
        let signer = secret(input.signer)?;
        let recipient = PublicKey::from_sec1_bytes(
            &hex::decode(input.recipient_public).map_err(|_| "invalid fixture public encoding")?,
        )
        .map_err(|_| "invalid fixture recipient")?;
        let seed_text = Zeroizing::new(input.entropy);
        let mut seed = Zeroizing::new([0; 32]);
        hex::decode_to_slice(seed_text.as_str(), seed.as_mut())
            .map_err(|_| "invalid fixture entropy")?;
        let mut rng = ChaCha20Rng::from_seed(*seed);
        let context = basicswap::MessageContext {
            sender: &sender,
            event_signer: &signer,
            recipient: &recipient,
            address_prefix: request.prefix,
            sent: request.now,
            ttl_seconds: input.ttl.unwrap_or(3600),
        };
        let incoming = messages
            .first()
            .ok_or("outbound fixture requires an incoming message")?;
        let mut draft = match input.kind.as_str() {
            "request" => basicswap::prepare_request(
                &Advertisement::from_received(incoming, request.now)?,
                &context,
                &mut rng,
            )?,
            "ack" => basicswap::prepare_ack(
                &Connect::from_received(incoming, request.prefix, request.now)?,
                &context,
                &mut rng,
            )?,
            _ => return Err("unsupported outbound fixture kind".into()),
        };
        while draft.advance_work(4096)? != basicswap::WorkProgress::Ready {}
        let prepared = draft.finish(&signer, request.now, &mut rng)?;
        Some(
            json!({"id": hex::encode(prepared.id()), "event": serde_json::from_slice::<Value>(prepared.as_bytes())?}),
        )
    } else {
        None
    };
    Ok(json!({"messages": outputs, "flow": request.flow, "outbound": outgoing}))
}
fn main() {
    let mut input = Zeroizing::new(String::new());
    let output = match io::stdin().take(1024 * 1024 + 1).read_to_string(&mut input) {
        Ok(_) if input.len() <= 1024 * 1024 => match run(&input) {
            Ok(output) => output,
            Err(error) => json!({"error": error.to_string()}),
        },
        _ => json!({"error": "fixture input unreadable or too large"}),
    };
    println!("{output}");
}
