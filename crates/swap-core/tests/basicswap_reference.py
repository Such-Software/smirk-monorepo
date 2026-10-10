#!/usr/bin/env python3
"""Offline differential fixtures against a clean pinned BasicSwap checkout.

Keys are random, unfunded and process-local. Only public results reach stdout.
No relay, wallet daemon or BasicSwap service is started.
"""
import argparse
import ast
from types import SimpleNamespace
import base64
import copy
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
import sys

REFERENCE_COMMIT = "277b46b0278f1cc76199f7e847988647a1b36e38"
NOW = 1_800_000_000
PREFIX = 118  # Particl testnet/regtest messaging address namespace.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    args = parser.parse_args()
    ref = args.reference.resolve()
    head = subprocess.check_output(["git", "-C", str(ref), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(ref), "status", "--porcelain"], text=True)
    if head != REFERENCE_COMMIT or dirty:
        raise RuntimeError("reference checkout must be clean at the pinned commit")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ref))
    from coincurve import PrivateKey
    from Crypto.Cipher import AES
    from basicswap.messages_npb import OfferMessage, ConnectReqMessage, OfferRevokeMessage
    from basicswap.network.nostr.client import signEvent, verifyEvent
    from basicswap.util.address import pubkeyToAddress
    from basicswap.util.smsg import smsgEncrypt, smsgDecrypt, smsgGetID

    maker, taker, broadcast = PrivateKey(), PrivateKey(), PrivateKey()
    maker_route, taker_route, relay_signer = PrivateKey(), PrivateKey(), PrivateKey()
    checks = 0

    def run(envelopes, flow=False, now=NOW, accept=True):
        nonlocal checks
        request = {"now": now, "prefix": PREFIX, "envelopes": envelopes, "flow": flow}
        result = subprocess.run([str(args.binary.resolve())], input=json.dumps(request),
                                text=True, capture_output=True, timeout=20, check=False)
        if result.returncode != 0:
            raise RuntimeError("fixture adapter exited unsuccessfully")
        try:
            output = json.loads(result.stdout)
        except Exception:
            raise RuntimeError("fixture adapter did not return JSON") from None
        if accept and "error" in output:
            raise RuntimeError("valid fixture refused: " + output["error"])
        if not accept and "error" not in output:
            raise RuntimeError("invalid fixture accepted")
        checks += 1
        return output

    def event_for(raw, signer, expires=NOW+3600):
        return signEvent(signer.secret, {"created_at": NOW, "kind": 4859,
            "tags": [["t", "bsx"], ["expiration", str(expires)]],
            "content": base64.b64encode(raw).decode()})

    def envelope(payload, sender, recipient, signer, sent=NOW, ttl=3600):
        raw = smsgEncrypt(sender.secret, recipient.public_key.format(), payload,
                          smsg_timestamp=sent, smsg_ttl=ttl, difficulty_target=0x207FFFFF)
        # Reference decryption and signature recovery must agree before Rust is tested.
        decoded = smsgDecrypt(recipient.secret, raw, output_dict=True)
        assert decoded["hex"] == payload.hex(), "reference payload mismatch"
        assert decoded["pubkey_from"] == sender.public_key.format().hex(), "reference signer mismatch"
        event = event_for(raw, signer, sent+ttl)
        assert verifyEvent(event), "reference event verification failed"
        return {"recipient": recipient.secret.hex(), "event": event}

    def compare(item, payload, sender):
        result = run([item])["messages"][0]
        raw = base64.b64decode(item["event"]["content"])
        assert result["id"] == smsgGetID(raw).hex(), "SMSG identifier differs"
        assert result["sender"] == sender.public_key.format().hex(), "sender differs"
        assert result["payload"] == payload.hex(), "wire encoding differs"
        # Feed Rust's re-encoding into the unmodified reference decoder.
        classes = {1: OfferMessage, 11: OfferRevokeMessage, 14: ConnectReqMessage}
        decoded = classes[payload[0]]()
        decoded.from_bytes(bytes.fromhex(result["payload"])[1:])
        assert decoded.to_bytes() == payload[1:], "reference rejected canonical re-encoding"

    offer = OfferMessage(protocol_version=7, coin_from=9, coin_to=3,
        amount_from=10_000_000_000, amount_to=100_000_000, min_bid_amount=10_000_000_000,
        time_valid=3600, lock_type=2, lock_value=3600, swap_type=5,
        fee_rate_from=1000, fee_rate_to=1000, amount_negotiable=True, message_nets="nostr")
    offer_payload = b"\x01" + offer.to_bytes()
    offer_item = envelope(offer_payload, maker, broadcast, relay_signer)
    offer_id = smsgGetID(base64.b64decode(offer_item["event"]["content"]))
    compare(offer_item, offer_payload, maker)

    def connect_payload(sender, route, ack=False, **changes):
        data = {"offer_id": offer_id.hex(), "bsx_address": pubkeyToAddress(PREFIX, sender.public_key.format()),
                "nostr_pubkey": route.public_key_xonly.format().hex()}
        if ack:
            data["req_pubkey"] = taker_route.public_key_xonly.format().hex()
        data.update(changes)
        msg = ConnectReqMessage(network_type=3, network_data=b"bsx", request_type=2 if ack else 1,
                                request_data=json.dumps(data).encode())
        return b"\x0e" + msg.to_bytes()

    req_payload = connect_payload(taker, taker_route)
    ack_payload = connect_payload(maker, maker_route, ack=True)
    req_item = envelope(req_payload, taker, maker, taker_route)
    ack_item = envelope(ack_payload, maker, taker, maker_route)
    compare(req_item, req_payload, taker)
    compare(ack_item, ack_payload, maker)
    magic = b"Bitcoin Signed Message:\n"
    revoke_text = (offer_id.hex() + "_revoke").encode()
    digest = hashlib.sha256(hashlib.sha256(bytes([len(magic)]) + magic + bytes([len(revoke_text)]) + revoke_text).digest()).digest()
    signature = maker.sign_recoverable(digest, hasher=None)
    revoke = OfferRevokeMessage(offer_msg_id=offer_id, signature=bytes([31+signature[64]])+signature[:64])
    revoke_payload = b"\x0b" + revoke.to_bytes()
    revoke_item = envelope(revoke_payload, maker, broadcast, relay_signer)
    compare(revoke_item, revoke_payload, maker)
    flow = [offer_item, req_item, ack_item, revoke_item]
    run(flow, flow=True)

    # Execute the reference ACK handler unchanged with an in-memory DB adapter.
    # This checks its route-binding behavior without importing wallet/service code.
    tree = ast.parse((ref / "basicswap/network/nostr/routes.py").read_text())
    handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                   and node.name == "processConnectRequestAck")
    from basicswap.util import ensure
    namespace = {"json": json, "ensure": ensure,
                 "MessageNetworks": SimpleNamespace(NOSTR=3)}
    exec(compile(ast.Module(body=[handler], type_ignores=[]), "reference ACK handler", "exec"), namespace)

    def reference_ack(item, accept=True):
        nonlocal checks
        raw = base64.b64decode(item["event"]["content"])
        payload = bytes.fromhex(smsgDecrypt(taker.secret, raw, output_dict=True)["hex"])
        parsed = ConnectReqMessage(); parsed.from_bytes(payload[1:])
        data = json.loads(parsed.request_data)
        initial = {"local_pubkey": taker_route.public_key_xonly.format().hex()}
        route = SimpleNamespace(active_ind=2, record_id=1, route_data=json.dumps(initial).encode())
        state = {"dispatched": False, "updated": False}
        def execute(query, params):
            updated = json.loads(params["route_data"])
            assert updated["remote_pubkey"] == maker_route.public_key_xonly.format().hex(), "reference route key differs"
            state["updated"] = True
        def dispatch(route_id, cursor):
            state["dispatched"] = True
        no_log = SimpleNamespace(debug=lambda *args: None, id=lambda value: "fixture")
        peer = SimpleNamespace(log=no_log, openDB=lambda: SimpleNamespace(execute=execute),
            closeDB=lambda cursor: None, getMessageRoute=lambda *args, **kwargs: route,
            dispatchPendingRouteBids=dispatch)
        msg = {"to": pubkeyToAddress(PREFIX, taker.public_key.format()),
               "from": pubkeyToAddress(PREFIX, maker.public_key.format()),
               "nostr_pubkey_from": item["event"]["pubkey"], "msgid": smsgGetID(raw).hex()}
        try:
            namespace["processConnectRequestAck"](peer, msg, parsed, data)
        except ValueError:
            if accept: raise RuntimeError("reference ACK handler refused valid exchange") from None
        else:
            if not accept: raise RuntimeError("reference ACK handler accepted invalid binding")
            assert state["dispatched"] and state["updated"], "reference ACK did not activate route"
        checks += 1

    reference_ack(ack_item)
    for changes, signer in [({"req_pubkey": PrivateKey().public_key_xonly.format().hex()}, maker_route),
                            ({"bsx_address": pubkeyToAddress(PREFIX, taker.public_key.format())}, maker_route),
                            ({}, PrivateKey())]:
        item = envelope(connect_payload(maker, maker_route, ack=True, **changes), maker, taker, signer)
        reference_ack(item, accept=False)

    # Commercial direction and both currently recognized swap protocol families.
    for coin_from, coin_to, protocol, swap_type in [(3,9,7,5), (2,6,6,5), (6,2,7,5), (2,3,5,1), (3,2,4,1)]:
        alt = copy.deepcopy(offer)
        alt.coin_from, alt.coin_to, alt.protocol_version, alt.swap_type = coin_from, coin_to, protocol, swap_type
        payload = b"\x01" + alt.to_bytes()
        compare(envelope(payload, maker, broadcast, relay_signer), payload, maker)

    # Rewrapping on another relay key leaves the SMSG identity unchanged.
    bridged = copy.deepcopy(offer_item)
    bridged["event"] = signEvent(PrivateKey().secret, bridged["event"])
    assert run([bridged])["messages"][0]["id"] == offer_id.hex(), "bridge identity changed"
    # Expiry is checked at the message and advertisement levels.
    run([offer_item], now=NOW+3600, accept=False)
    short = copy.deepcopy(offer); short.time_valid = 600
    run([envelope(b"\x01"+short.to_bytes(), maker, broadcast, relay_signer)], now=NOW+601, accept=False)
    run([envelope(offer_payload, maker, broadcast, relay_signer, sent=NOW+601)], accept=False)
    wrong_recipient = copy.deepcopy(offer_item); wrong_recipient["recipient"] = PrivateKey().secret.hex()
    run([wrong_recipient], accept=False)

    # Outer authentication, explicit network tag, lifetime consistency and bounds.
    for field, value, resign in [("id", "00"*32, False), ("sig", "00"*64, False),
        ("kind", 1, True), ("tags", [["t","other"],["expiration",str(NOW+3600)]], True),
        ("tags", [["t","bsx"],["expiration",str(NOW+3599)]], True),
        ("tags", [["t","bsx"],["expiration",str(NOW+3600)],["expiration",str(NOW+3600)]], True),
        ("created_at", NOW+601, True), ("content", "!", True), ("content", "a"*80000, False)]:
        bad = copy.deepcopy(offer_item); bad["event"][field] = value
        if resign: bad["event"] = signEvent(relay_signer.secret, bad["event"])
        run([bad], accept=False)

    raw = base64.b64decode(offer_item["event"]["content"])
    for cut in [0, 1, 8, 23, 39, 72, 104, 108, len(raw)-1]:
        bad = copy.deepcopy(offer_item); bad["event"] = event_for(raw[:cut], relay_signer)
        run([bad], accept=False)
    for offset in [8, 10, 39, 72, 104, len(raw)-1]:
        mutated = bytearray(raw); mutated[offset] ^= 1
        bad = copy.deepcopy(offer_item); bad["event"] = event_for(bytes(mutated), relay_signer)
        run([bad], accept=False)

    # Recompute the recipient MAC so deeper padding/signature/length checks execute.
    shared = broadcast.ecdh(raw[39:72]); keys = hashlib.sha512(shared).digest()
    plain = AES.new(keys[:32], AES.MODE_CBC, raw[23:39]).decrypt(raw[108:])
    for offset in [0, 1, 2, 22, 87, len(plain)-1]:
        modified = bytearray(plain); modified[offset] ^= 1
        ciphertext = AES.new(keys[:32], AES.MODE_CBC, raw[23:39]).encrypt(bytes(modified))
        mac = hmac.new(keys[32:], raw[11:19]+raw[23:39]+ciphertext, hashlib.sha256).digest()
        changed = raw[:72]+mac+raw[104:108]+ciphertext
        bad = copy.deepcopy(offer_item); bad["event"] = event_for(changed, relay_signer)
        run([bad], accept=False)

    # Route keys, identities and offer binding remain mandatory after valid decryption.
    for data_changes, outer in [({"req_pubkey": PrivateKey().public_key_xonly.format().hex()}, maker_route),
        ({"offer_id": bytes(reversed(offer_id)).hex()}, maker_route),
        ({"bsx_address": pubkeyToAddress(PREFIX, taker.public_key.format())}, maker_route),
        ({}, PrivateKey())]:
        bad_ack = envelope(connect_payload(maker, maker_route, ack=True, **data_changes), maker, taker, outer)
        run([offer_item, req_item, bad_ack, revoke_item], flow=True, accept=False)
    bad_request = envelope(req_payload, maker, maker, taker_route)
    run([offer_item, bad_request, ack_item, revoke_item], flow=True, accept=False)
    bad_revoke = envelope(revoke_payload, taker, broadcast, relay_signer)
    run([bad_revoke], accept=False)

    # Strict parsing deviations deliberately reject ambiguous encodings accepted by Python.
    for payload in [offer_payload+b"\x08\x07", offer_payload+b"\xa8\x01\xff", b"\x01\x08\x87\x00",
                    b"\x01\xaa\x01\x04x", b"\x01\x08"+b"\xff"*10]:
        run([envelope(payload, maker, broadcast, relay_signer)], accept=False)
    print(f"BasicSwap {REFERENCE_COMMIT}: {checks} offline differential checks passed; no network or funds used.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Exceptions above contain static reasons or the adapter's sanitized errors only.
        print(f"BasicSwap fixture failure: {error}", file=sys.stderr)
        sys.exit(1)
