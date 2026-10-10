use super::*;
use k256::{elliptic_curve::sec1::ToEncodedPoint, ProjectivePoint, Scalar};

fn public(n: u32) -> [u8; 33] {
    (ProjectivePoint::GENERATOR * Scalar::from(n))
        .to_affine()
        .to_encoded_point(true)
        .as_bytes()
        .try_into()
        .unwrap()
}
fn route_key(n: u32) -> [u8; 32] {
    public(n)[1..].try_into().unwrap()
}
fn offer() -> Advertisement {
    Advertisement {
        id: [1; 28],
        sender: public(2),
        expires: 2000,
        terms: Offer {
            protocol_version: 7,
            coin_from: 9,
            coin_to: 3,
            amount_from: 1000,
            amount_to: 2000,
            min_bid_amount: 1000,
            time_valid: 1000,
            lock_type: 2,
            lock_value: 1000,
            swap_type: 5,
            message_nets: "nostr".into(),
        },
    }
}
fn request() -> Connect {
    Connect {
        offer_id: offer().id,
        sender: public(3),
        recipient: offer().sender,
        route_key: route_key(4),
        requested_key: None,
        sent: 1000,
        expires: 2000,
    }
}
fn ack() -> Connect {
    Connect {
        sender: offer().sender,
        recipient: request().sender,
        route_key: route_key(5),
        requested_key: Some(request().route_key),
        ..request()
    }
}
#[test]
fn ack_binds_offer_parties_and_pending_key() {
    let pending = PendingRoute::from_request(&request(), &offer(), 1001).unwrap();
    assert!(pending.accept(&ack(), 1001).is_ok());
    let mut wrong = ack();
    wrong.offer_id[0] ^= 1;
    assert!(pending.accept(&wrong, 1001).is_err());
    let mut wrong = ack();
    wrong.sender = public(7);
    assert!(pending.accept(&wrong, 1001).is_err());
    let mut wrong = ack();
    wrong.recipient = public(7);
    assert!(pending.accept(&wrong, 1001).is_err());
    let mut old = ack();
    old.requested_key = Some(route_key(6));
    assert!(pending.accept(&old, 1001).is_err());
    assert!(pending.accept(&ack(), offer().expires).is_err());
    // Invalid input leaves the pending exchange usable.
    assert!(pending.accept(&ack(), 1001).is_ok());
}
#[test]
fn replacement_requires_newer_request_and_same_identity() {
    let mut route = Route::accept_request(&request(), &offer(), route_key(5), 1001).unwrap();
    route.update_request(&request(), 1001).unwrap();
    let mut replacement = request();
    replacement.route_key = route_key(6);
    assert!(route.update_request(&replacement, 1001).is_err());
    replacement.sent += 1;
    route.update_request(&replacement, 1001).unwrap();
    assert_eq!(route.remote_key(), &replacement.route_key);
    assert!(route.update_request(&request(), 1001).is_err());
    replacement.sender = public(7);
    assert!(route.update_request(&replacement, 1001).is_err());
    assert!(route.update_request(&request(), 2000).is_err());
}
#[test]
fn cache_deduplicates_and_retains_early_revocations() {
    let mut book = OfferBook::new(2).unwrap();
    assert_eq!(book.admit(offer(), 1001).unwrap(), Admission::Added);
    assert_eq!(book.admit(offer(), 1001).unwrap(), Admission::Duplicate);
    let foreign = Revoke {
        offer_id: offer().id,
        sender: public(8),
        retain_until: 3000,
    };
    book.revoke(&foreign, 1001).unwrap();
    assert_eq!(book.admit(offer(), 1001).unwrap(), Admission::Duplicate);
    let revocation = Revoke {
        sender: offer().sender,
        ..foreign
    };
    book.revoke(&revocation, 1001).unwrap();
    assert_eq!(book.admit(offer(), 1001).unwrap(), Admission::Revoked);
    let mut reordered = OfferBook::new(1).unwrap();
    reordered.revoke(&revocation, 1001).unwrap();
    assert_eq!(reordered.admit(offer(), 1001).unwrap(), Admission::Revoked);
}
#[test]
fn full_cache_refuses_without_evicting_live_observations() {
    let mut book = OfferBook::new(1).unwrap();
    book.admit(offer(), 1001).unwrap();
    let mut other = offer();
    other.id[0] ^= 1;
    assert!(book.admit(other, 1001).is_err());
    assert_eq!(book.admit(offer(), 1001).unwrap(), Admission::Duplicate);
    assert!(book.admit(offer(), 1000).is_err());
    let mut next = offer();
    next.expires = 4000;
    assert_eq!(book.admit(next, 2001).unwrap(), Admission::Added);
    assert!(book.admit(offer(), 2001).is_err());
}
#[test]
fn unknown_pairs_and_protocols_remain_closed() {
    // Valid WOW/LTC advertisement, encoded using the wire fields.
    let valid = vec![
        1, 8, 7, 16, 9, 24, 3, 32, 100, 40, 10, 48, 100, 56, 216, 4, 64, 2, 72, 10, 80, 5,
    ];
    let offer = Offer::decode(&WireMessage::decode(&valid).unwrap()).unwrap();
    assert_eq!(offer.amount_from, 100);
    for (index, value) in [(2, 8), (6, 6), (4, 99), (20, 2), (14, 0)] {
        let mut bad = valid.clone();
        bad[index] = value;
        assert!(WireMessage::decode(&bad)
            .and_then(|w| Offer::decode(&w))
            .is_err());
    }
}
