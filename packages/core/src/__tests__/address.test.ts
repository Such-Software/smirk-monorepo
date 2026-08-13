/**
 * Address-validator regression tests.
 *
 * Covers the validators added in 2026-05-10 audit fix M3 (XMR, WOW,
 * Grin slatepack) plus the existing BTC/LTC ones for completeness.
 *
 * Test vectors:
 *  - The XMR / WOW vectors are obtained by encoding random 32-byte
 *    keys via this codebase's own `xmrAddress` / `wowAddress`
 *    helpers (round-trip), giving us a `valid` set without depending
 *    on external services.
 *  - Negative vectors target each likely failure mode: typo (single
 *    char swap → checksum fails), wrong network (XMR address checked
 *    against WOW validator, etc.), wrong length, alphabet violations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32, bech32m } from '@scure/base';

import {
  isValidBtcAddress,
  isValidGrinSlatepackAddress,
  isValidLtcAddress,
  isValidWowAddress,
  isValidXmrAddress,
  xmrAddress,
  wowAddress,
  xmrSubaddress,
  wowSubaddress,
  grinSlatpackAddress,
} from '../address';

function fixedBytes(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i) & 0xff;
  return out;
}

const SPEND = fixedBytes(7);
const VIEW = fixedBytes(13);

// ============================================================================
// XMR
// ============================================================================

test('isValidXmrAddress: round-trips a self-encoded address', () => {
  const addr = xmrAddress(SPEND, VIEW);
  assert.equal(isValidXmrAddress(addr), true, addr);
});

test('isValidXmrAddress: rejects a single-char-swapped address (checksum)', () => {
  const addr = xmrAddress(SPEND, VIEW);
  // Swap the 50th character to something different in the alphabet.
  const ch = addr[50] === 'A' ? 'B' : 'A';
  const tampered = addr.slice(0, 50) + ch + addr.slice(51);
  assert.equal(isValidXmrAddress(tampered), false);
});

test('isValidXmrAddress: rejects a WOW address (wrong prefix)', () => {
  const wow = wowAddress(SPEND, VIEW);
  assert.equal(isValidXmrAddress(wow), false);
});

test('isValidXmrAddress: rejects empty / short / alphabet-violating strings', () => {
  assert.equal(isValidXmrAddress(''), false);
  assert.equal(isValidXmrAddress('not-an-address'), false);
  // 'l' (lowercase L), '0', 'O', 'I' are not in the Monero base58 alphabet
  assert.equal(isValidXmrAddress('lOIl0'.repeat(20)), false);
});

// ============================================================================
// WOW
// ============================================================================

test('isValidWowAddress: round-trips a self-encoded address', () => {
  const addr = wowAddress(SPEND, VIEW);
  assert.equal(isValidWowAddress(addr), true, addr);
});

test('isValidWowAddress: rejects an XMR address (wrong prefix)', () => {
  const xmr = xmrAddress(SPEND, VIEW);
  assert.equal(isValidWowAddress(xmr), false);
});

test('isValidWowAddress: rejects malformed input', () => {
  assert.equal(isValidWowAddress(''), false);
  assert.equal(isValidWowAddress('Wo' + '?'.repeat(95)), false);
});

// ============================================================================
// Grin slatepack
// ============================================================================

test('isValidGrinSlatepackAddress: round-trips a self-encoded address', () => {
  const addr = grinSlatpackAddress(fixedBytes(3));
  assert.equal(isValidGrinSlatepackAddress(addr), true, addr);
});

test('isValidGrinSlatepackAddress: rejects bech32 with non-grin hrp', () => {
  // A valid bech32 with a different hrp must not pass, even if the
  // payload length matches.
  assert.equal(
    isValidGrinSlatepackAddress(
      'bc1qzxy3rst5dh4uw0eq37j2j8j6lggw9j6dz4mrt8',
    ),
    false,
  );
});

test('isValidGrinSlatepackAddress: rejects malformed strings', () => {
  assert.equal(isValidGrinSlatepackAddress(''), false);
  assert.equal(isValidGrinSlatepackAddress('grin1'), false); // no payload
  assert.equal(isValidGrinSlatepackAddress('grin1!!!'), false);
  assert.equal(isValidGrinSlatepackAddress('grinX1aaaaaa'), false); // wrong hrp
});

// ============================================================================
// Cross-asset: every validator rejects every other asset's valid address
// ============================================================================

test('cross-asset rejection — each validator only accepts its own family', () => {
  const xmr = xmrAddress(SPEND, VIEW);
  const wow = wowAddress(SPEND, VIEW);
  const grin = grinSlatpackAddress(fixedBytes(5));

  // BTC bech32 (synthesized: must round-trip via @scure/base if needed
  // to test BTC, but for this matrix it's enough to confirm the
  // Cryptonote / Grin validators reject obvious BTC strings).
  const btcLike = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

  assert.equal(isValidXmrAddress(wow), false);
  assert.equal(isValidXmrAddress(grin), false);
  assert.equal(isValidXmrAddress(btcLike), false);

  assert.equal(isValidWowAddress(xmr), false);
  assert.equal(isValidWowAddress(grin), false);
  assert.equal(isValidWowAddress(btcLike), false);

  assert.equal(isValidGrinSlatepackAddress(xmr), false);
  assert.equal(isValidGrinSlatepackAddress(wow), false);
  assert.equal(isValidGrinSlatepackAddress(btcLike), false);

  assert.equal(isValidBtcAddress(xmr), false);
  assert.equal(isValidBtcAddress(wow), false);
  assert.equal(isValidBtcAddress(grin), false);

  assert.equal(isValidLtcAddress(xmr), false);
  assert.equal(isValidLtcAddress(wow), false);
  assert.equal(isValidLtcAddress(grin), false);
});

// ============================================================================
// XMR / WOW subaddress derivation (per-payment receive privacy)
// ============================================================================
//
// Reference vectors generated from the vendored monero-oxide `ViewPair`
// (crates/monero-oxide/.../wallet/src/view_pair.rs `subaddress`), the same
// library the wallet trusts for signing. Emitter (run once, then reverted):
//   let spend = curve25519_dalek::Scalar::from_bytes_mod_order([9u8; 32]);
//   let view  = curve25519_dalek::Scalar::from_bytes_mod_order([7u8; 32]);
//   let vp = ViewPair::new(Point::from(&spend * G), Zeroizing::new(Scalar::from(view)));
//   vp.subaddress(Network::Mainnet, SubaddressIndex::new(0, n));
// publicSpendKey = spend·G (compressed); privateViewKey = view bytes ([7; 32]).

const hexToBytes = (h: string): Uint8Array =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

const REF_SPEND_PUB = hexToBytes(
  '4faa93763d0702316ddef05a7921b30b30e81530b44cf9f35773ffee16f68638',
);
const REF_VIEW_PRIV = new Uint8Array(32).fill(7);
const REF_XMR_SUB_0_1 =
  '82sVjEz8Hh95213ep3PT2iHCdW3v5mzg9NZVMQGTUccQaBQ44rgmzqANG2qvjLhYTnA3aDgpiSBMJ5xB2jQwK67R7sw3fUs';
const REF_XMR_SUB_0_2 =
  '8B1BTbfkZUWKePoXVc3VDB6Quxw2Mni883MVGV2P7umPN4zQNVp7ZKoHCJQ7mRc2eKd2s44sxEXhEDEaR8MKxnyPBJ64Tnm';

test('xmrSubaddress matches monero-oxide reference vectors', () => {
  assert.equal(xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1), REF_XMR_SUB_0_1);
  assert.equal(xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 2), REF_XMR_SUB_0_2);
});

test('xmr subaddresses validate and use the subaddress prefix', () => {
  const s1 = xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1);
  assert.ok(isValidXmrAddress(s1));
  assert.ok(s1.startsWith('8')); // Monero subaddress prefix 42 (standard is '4', prefix 18)
  assert.notEqual(s1, xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 2));
});

test('wowSubaddress produces a valid, distinct WOW subaddress', () => {
  const w1 = wowSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1);
  assert.ok(isValidWowAddress(w1));
  // Same D,C derivation as XMR (cross-checked above); only the WOW subaddress
  // prefix (12208, verified against a Stack Wallet address) differs.
  assert.notEqual(w1, wowSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 2));
});

test('subaddress derivation is deterministic', () => {
  assert.equal(
    xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 5),
    xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 5),
  );
});

test('subaddress (0,0) throws — it is the primary address, not a subaddress', () => {
  assert.throws(() => xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 0));
  assert.throws(() => wowSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 0));
});

// ============================================================================
// BTC / LTC segwit recipients
// ============================================================================
//
// The validators must accept exactly the (witness version, program length)
// pairs `decode_recipient_script` (crates/btc-ext/src/address.rs) can pay:
// (0, 20) P2WPKH and (1, 32) P2TR. Vectors below are the BIP84 / BIP86
// reference addresses (same ones the Rust unit tests assert on) plus BIP173's
// P2WSH example; the malformed ones are synthesized here so the checksum and
// length failure modes are exercised without hand-typed strings.

// BIP84 m/84'/0'/0'/0/0 for the "abandon … about" mnemonic: v0, 20 bytes.
const BTC_P2WPKH = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
// BIP173 example: v0, 32 bytes (P2WSH).
const BTC_P2WSH =
  'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
// BIP86 m/86'/0'/0'/0/0 for the same mnemonic: v1, 32 bytes (taproot).
const BTC_P2TR =
  'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

/** Witness program bytes of a bech32m (v1+) address. */
function witnessProgram(address: string): Uint8Array {
  return bech32m.fromWords(bech32m.decode(address as `${string}1${string}`).words.slice(1));
}

test('isValidBtcAddress: accepts v0 P2WPKH (bech32)', () => {
  assert.equal(isValidBtcAddress(BTC_P2WPKH), true);
});

test('isValidBtcAddress: accepts v1 P2TR (bech32m)', () => {
  assert.equal(isValidBtcAddress(BTC_P2TR), true);
});

test('isValidLtcAddress: accepts ltc1q P2WPKH and ltc1p P2TR', () => {
  const p2wpkhProgram = bech32.fromWords(
    bech32.decode(BTC_P2WPKH as `${string}1${string}`).words.slice(1),
  );
  const ltcP2wpkh = bech32.encode('ltc', [0, ...bech32.toWords(p2wpkhProgram)]);
  const ltcP2tr = bech32m.encode('ltc', [1, ...bech32m.toWords(witnessProgram(BTC_P2TR))]);
  assert.equal(isValidLtcAddress(ltcP2wpkh), true, ltcP2wpkh);
  assert.equal(isValidLtcAddress(ltcP2tr), true, ltcP2tr);
});

test('isValidBtcAddress: rejects v0 P2WSH — the builder cannot pay it', () => {
  // (0, 32) is a well-formed bech32 address, but `decode_recipient_script`
  // only builds P2WPKH and P2TR outputs. Accepting it here would green-light
  // a send the signer refuses.
  assert.equal(isValidBtcAddress(BTC_P2WSH), false);
});

test('isValidBtcAddress / isValidLtcAddress: reject the other chain\'s HRP', () => {
  const ltcP2tr = bech32m.encode('ltc', [1, ...bech32m.toWords(witnessProgram(BTC_P2TR))]);
  assert.equal(isValidBtcAddress(ltcP2tr), false);
  assert.equal(isValidLtcAddress(BTC_P2TR), false);
  assert.equal(isValidLtcAddress(BTC_P2WPKH), false);
});

test('isValidBtcAddress: rejects a v1 address with a bech32 (v0) checksum', () => {
  // BIP350: v0 is bech32, v1+ is bech32m. Re-encoding the taproot payload
  // with the v0 checksum yields a string that decodes cleanly as bech32 but
  // is NOT a valid taproot address, and the network would not pay it.
  const taprootWords = bech32m.decode(BTC_P2TR as `${string}1${string}`).words;
  const wrongChecksum = bech32.encode('bc', taprootWords);
  assert.notEqual(wrongChecksum, BTC_P2TR);
  assert.equal(isValidBtcAddress(wrongChecksum), false);
});

test('isValidBtcAddress: rejects a v0 address with a bech32m checksum', () => {
  const p2wpkhWords = bech32.decode(BTC_P2WPKH as `${string}1${string}`).words;
  const wrongChecksum = bech32m.encode('bc', p2wpkhWords);
  assert.notEqual(wrongChecksum, BTC_P2WPKH);
  assert.equal(isValidBtcAddress(wrongChecksum), false);
});

test('isValidBtcAddress: rejects unsupported program lengths', () => {
  // v0 with a 21-byte program, and v1 with a 20-byte program: both are
  // syntactically fine bech32/bech32m, neither is a script the builder emits.
  const v0BadLength = bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(21))]);
  const v1BadLength = bech32m.encode('bc', [1, ...bech32m.toWords(new Uint8Array(20))]);
  assert.equal(isValidBtcAddress(v0BadLength), false);
  assert.equal(isValidBtcAddress(v1BadLength), false);
});

test('isValidBtcAddress: rejects an empty / version-only / non-bech32 string', () => {
  assert.equal(isValidBtcAddress(''), false);
  assert.equal(isValidBtcAddress('bc1'), false);
  assert.equal(isValidBtcAddress('not-an-address'), false);
});
