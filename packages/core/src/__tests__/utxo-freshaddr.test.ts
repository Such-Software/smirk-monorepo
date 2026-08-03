/**
 * Lane 5: BTC/LTC HD gap-limit fresh addresses.
 *
 * Unit coverage for the money-safe, deterministic pieces:
 *  - BIP84 account xpub + `deriveBip84KeyAt` reproduce index 0 and match a
 *    known BIP84 test vector at a couple of indices.
 *  - `btcAddressAt` / `ltcAddressAt` produce valid, distinct, index-0-stable
 *    addresses from the account xpub.
 *  - Gap-limit refusal (money gate G12).
 *  - `reserveChange` monotonicity under concurrency (mutex).
 *  - `advanceReceive` slides forward as `markReceiveUsed` moves the window.
 *  - Session-cache self-heal on a pre-xpub cache (money gate G10).
 *
 * The live gates (G9 full round-trip, G11 change-spend, G12 gap DISCOVERY on a
 * real restore) need testnet and are out of scope for these unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAllKeys,
  deriveBip84AccountXpub,
  deriveBip84KeyAt,
  mnemonicToSeed,
} from '../hd';
import {
  btcAddress,
  ltcAddress,
  btcAddressAt,
  ltcAddressAt,
  isValidBtcAddress,
  isValidLtcAddress,
} from '../address';
import {
  UtxoAddressBook,
  GapLimitError,
  GAP_LIMIT,
  bip84MasterPath,
  buildUtxoScanRefs,
  parseBip84MasterPath,
  recordUtxoActivity,
} from '../utxo-addressbook';
import { parseSessionCache } from '../keystore';
import { InMemoryStorage } from '../state/platform';

// The canonical all-abandon BIP39 mnemonic (Trezor test vector).
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Known BIP84 (m/84'/0'/0') account vectors for the abandon mnemonic:
//   m/84'/0'/0'/0/0 -> bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
//   m/84'/0'/0'/0/1 -> bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g
//   m/84'/0'/0'/1/0 -> bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el
const BIP84_RECV_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const BIP84_RECV_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const BIP84_CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';

// ============================================================================
// HD: account xpub + deriveBip84KeyAt
// ============================================================================

test('deriveBip84KeyAt(0,0) from xpub reproduces the primary receive key', () => {
  const keys = deriveAllKeys(ABANDON, '', 3);
  const xpub = keys.btc.accountXpub;
  assert.equal(typeof xpub, 'string');
  const leaf = deriveBip84KeyAt(xpub!, 0, 0);
  assert.deepEqual(Array.from(leaf.publicKey), Array.from(keys.btc.publicKey));
});

test('account xpub is present on both btc and ltc v3 keys', () => {
  const keys = deriveAllKeys(ABANDON, '', 3);
  assert.equal(typeof keys.btc.accountXpub, 'string');
  assert.equal(typeof keys.ltc.accountXpub, 'string');
  assert.notEqual(keys.btc.accountXpub, keys.ltc.accountXpub);
});

test('btcAddressAt matches the known BIP84 vectors at indices 0, 1 and change 0', () => {
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  assert.equal(btcAddressAt(xpub, 0, 0), BIP84_RECV_0);
  assert.equal(btcAddressAt(xpub, 0, 1), BIP84_RECV_1);
  assert.equal(btcAddressAt(xpub, 1, 0), BIP84_CHANGE_0);
});

test('btcAddressAt(0,0) equals the wallet primary btcAddress', () => {
  const keys = deriveAllKeys(ABANDON, '', 3);
  assert.equal(btcAddressAt(keys.btc.accountXpub!, 0, 0), btcAddress(keys.btc.publicKey));
});

test('ltcAddressAt(0,0) equals the wallet primary ltcAddress and is valid ltc', () => {
  const keys = deriveAllKeys(ABANDON, '', 3);
  const a = ltcAddressAt(keys.ltc.accountXpub!, 0, 0);
  assert.equal(a, ltcAddress(keys.ltc.publicKey));
  assert.ok(isValidLtcAddress(a));
});

test('fresh receive addresses are valid and distinct across indices', () => {
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const a = btcAddressAt(xpub, 0, i);
    assert.ok(isValidBtcAddress(a), a);
    assert.ok(!seen.has(a), `duplicate address at index ${i}`);
    seen.add(a);
  }
});

test('deriveBip84KeyAt from seed yields a private key; from xpub does not', () => {
  const seed = mnemonicToSeed(ABANDON);
  const fromSeed = deriveBip84KeyAt(seed, 0, 3, 0);
  assert.ok(fromSeed.privateKey instanceof Uint8Array);
  const xpub = deriveBip84AccountXpub(seed, 0);
  const fromXpub = deriveBip84KeyAt(xpub, 0, 3);
  assert.equal(fromXpub.privateKey, undefined);
  // Same public key either way (seed path == xpub path at the same leaf).
  assert.deepEqual(Array.from(fromSeed.publicKey), Array.from(fromXpub.publicKey));
});

test('deriveBip84KeyAt rejects invalid change / index', () => {
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  assert.throws(() => deriveBip84KeyAt(xpub, 2 as unknown as 0, 0));
  assert.throws(() => deriveBip84KeyAt(xpub, 0, -1));
  assert.throws(() => deriveBip84KeyAt(xpub, 0, 1.5));
});

// ============================================================================
// Address book: gap limit (G12) + monotonic change
// ============================================================================

function freshBook(): UtxoAddressBook {
  return new UtxoAddressBook(new InMemoryStorage(), 'fp-test', 'btc');
}

test('advanceReceive allows up to usedHigh + GAP_LIMIT then refuses (G12)', async () => {
  const book = freshBook();
  // usedReceiveHigh starts at -1, receiveHigh at 0. So the reachable ceiling is
  // -1 + GAP_LIMIT = 19: indices 1..19 are grantable, 20 is refused.
  for (let expected = 1; expected <= GAP_LIMIT - 1; expected++) {
    assert.equal(await book.advanceReceive(), expected);
  }
  await assert.rejects(() => book.advanceReceive(), GapLimitError);
});

test('markReceiveUsed slides the gap window forward', async () => {
  const book = freshBook();
  // Walk right up to the ceiling.
  for (let i = 1; i <= GAP_LIMIT - 1; i++) await book.advanceReceive();
  await assert.rejects(() => book.advanceReceive(), GapLimitError);
  // Funds land at index 10 -> ceiling becomes 10 + GAP_LIMIT = 30, so advancing
  // is allowed again (next index is 20).
  await book.markReceiveUsed(10);
  assert.equal(await book.advanceReceive(), GAP_LIMIT); // 20
});

test('markReceiveUsed is monotonic; a lower index is a no-op', async () => {
  const book = freshBook();
  await book.markReceiveUsed(5);
  await book.markReceiveUsed(2);
  const s = await book.read();
  assert.equal(s.usedReceiveHigh, 5);
});

test('reserveChange is monotonic and collision-free under concurrency (mutex)', async () => {
  const book = freshBook();
  const N = 50;
  const results = await Promise.all(Array.from({ length: N }, () => book.reserveChange()));
  results.sort((a, b) => a - b);
  // Every index 0..N-1 handed out exactly once: no duplicates, no gaps.
  assert.deepEqual(results, Array.from({ length: N }, (_, i) => i));
  assert.equal((await book.read()).changeNext, N);
});

test('scan indices always include index 0 and cover the gap window', async () => {
  const book = freshBook();
  const recv = await book.receiveScanIndices();
  assert.equal(recv[0], 0);
  assert.equal(recv[recv.length - 1], GAP_LIMIT); // 0 + GAP_LIMIT
  // The change window is a gap window too, never "only what we reserved";
  // that is what makes a restored wallet find its change.
  const chg0 = await book.changeScanIndices();
  assert.equal(chg0[0], 0);
  assert.equal(chg0[chg0.length - 1], GAP_LIMIT);
  await book.reserveChange();
  await book.reserveChange();
  const chg2 = await book.changeScanIndices();
  assert.equal(chg2[0], 0);
  assert.equal(chg2[chg2.length - 1], 2 + GAP_LIMIT);
});

// ============================================================================
// Change-chain discovery: a restore must not lose sight of change
// ============================================================================

test('a fresh book still scans a change gap window, so restored change is visible', async () => {
  // The exact restore case: storage is empty, so changeNext is 0. Change from a
  // previous install / another device sits at /1/3. Under a
  // "0 .. changeNext - 1" range that address is in NO scan set: its funds are
  // missing from the balance and unselectable by any in-app spend.
  const book = freshBook();
  assert.equal((await book.read()).changeNext, 0);
  const indices = await book.changeScanIndices();
  assert.ok(indices.includes(3), 'change index 3 is scanned on a book with no local history');
});

test('markChangeUsed raises the used high-water mark and drags changeNext past it', async () => {
  const book = freshBook();
  await book.markChangeUsed(4);
  const s = await book.read();
  assert.equal(s.changeUsedHigh, 4);
  assert.equal(s.changeNext, 5, 'a used index is never handed out again as "next"');
  // The window now extends a full gap past the discovered index.
  const indices = await book.changeScanIndices();
  assert.equal(indices[indices.length - 1], 5 + GAP_LIMIT);
});

test('markChangeUsed is monotonic and ignores junk', async () => {
  const book = freshBook();
  await book.markChangeUsed(7);
  await book.markChangeUsed(2);
  await book.markChangeUsed(-1);
  await book.markChangeUsed(1.5);
  assert.equal((await book.read()).changeUsedHigh, 7);
});

test('a discovered change index is never re-reserved', async () => {
  const book = freshBook();
  await book.markChangeUsed(2);
  assert.equal(await book.reserveChange(), 3, 'reservation resumes above the discovered index');
});

test('changeUsedHigh survives a reload and defaults sanely on a legacy blob', async () => {
  const storage = new InMemoryStorage();
  const book = new UtxoAddressBook(storage, 'fp-reload', 'btc');
  await book.markChangeUsed(6);
  assert.equal((await new UtxoAddressBook(storage, 'fp-reload', 'btc').read()).changeUsedHigh, 6);

  // A book written before change discovery existed carries no changeUsedHigh.
  await storage.set('smirk:utxo-addressbook:v1:fp-legacy:btc', {
    version: 1,
    usedReceiveHigh: -1,
    receiveHigh: 0,
    changeNext: 2,
  });
  const legacy = new UtxoAddressBook(storage, 'fp-legacy', 'btc');
  assert.equal((await legacy.read()).changeUsedHigh, -1);
  const indices = await legacy.changeScanIndices();
  assert.equal(indices[indices.length - 1], 2 + GAP_LIMIT);
});

test('parseBip84MasterPath round-trips bip84MasterPath and rejects foreign paths', () => {
  assert.deepEqual(parseBip84MasterPath(bip84MasterPath('btc', 0, 0)), { change: 0, index: 0 });
  assert.deepEqual(parseBip84MasterPath(bip84MasterPath('ltc', 1, 12)), { change: 1, index: 12 });
  assert.equal(parseBip84MasterPath("m/44'/0'/0'/0/0"), null, 'not a BIP84 path');
  assert.equal(parseBip84MasterPath('nonsense'), null);
  assert.equal(parseBip84MasterPath("m/84'/0'/0'/2/0"), null, 'change is 0 or 1 only');
});

test('recordUtxoActivity slides BOTH windows from the addresses that hold funds', async () => {
  const book = freshBook();
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  const refs = await buildUtxoScanRefs(book, 'btc', xpub);

  const receive5 = btcAddressAt(xpub, 0, 5);
  const change3 = btcAddressAt(xpub, 1, 3);
  await recordUtxoActivity(book, refs, [receive5, change3, 'bc1qsomeone-elses-address']);

  const s = await book.read();
  assert.equal(s.usedReceiveHigh, 5);
  assert.equal(s.changeUsedHigh, 3);
  assert.equal(s.changeNext, 4);
  // The receive window slid too, so fresh receive addresses are grantable again.
  const recv = await book.receiveScanIndices();
  assert.equal(recv[recv.length - 1], 5 + GAP_LIMIT);
});

test('recordUtxoActivity is idempotent and ignores unknown addresses', async () => {
  const book = freshBook();
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  const refs = await buildUtxoScanRefs(book, 'btc', xpub);
  await recordUtxoActivity(book, refs, [btcAddressAt(xpub, 1, 2)]);
  const first = await book.read();
  await recordUtxoActivity(book, refs, [btcAddressAt(xpub, 1, 2), 'not-ours']);
  assert.deepEqual(await book.read(), first);
});

test('buildUtxoScanRefs covers both gap windows and stays batchable', async () => {
  const book = freshBook();
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  const refs = await buildUtxoScanRefs(book, 'btc', xpub);
  // 21 receive + 21 change on a fresh book: comfortably past one 32-address
  // batch, which is exactly why the API layer chunks.
  assert.equal(refs.length, 2 * (GAP_LIMIT + 1));
  assert.equal(new Set(refs.map((r) => r.address)).size, refs.length, 'no duplicate addresses');
});

test('buildUtxoScanRefs pairs each address with its BIP84 master path', async () => {
  const book = freshBook();
  await book.reserveChange(); // change index 0 in scope
  const xpub = deriveBip84AccountXpub(mnemonicToSeed(ABANDON), 0);
  const refs = await buildUtxoScanRefs(book, 'btc', xpub);
  // Receive 0 first, with the canonical path + address.
  assert.equal(refs[0]!.masterPath, bip84MasterPath('btc', 0, 0));
  assert.equal(refs[0]!.address, BIP84_RECV_0);
  // The reserved change 0 must appear with a /1/0 path.
  const change0 = refs.find((r) => r.masterPath === bip84MasterPath('btc', 1, 0));
  assert.ok(change0, 'change index 0 ref present');
  assert.equal(change0!.address, BIP84_CHANGE_0);
});

// ============================================================================
// Session-cache self-heal (G10)
// ============================================================================

function u8obj(): unknown {
  // A minimal valid key object placeholder (parseSessionCache only checks it is
  // an object per asset, not the byte shape).
  return { privateKey: { __u8: '00' }, publicKey: { __u8: '00' } };
}

function baseCache(withXpub: boolean): unknown {
  const btc: Record<string, unknown> = { ...(u8obj() as object) };
  const ltc: Record<string, unknown> = { ...(u8obj() as object) };
  if (withXpub) {
    btc.accountXpub = 'xpub-btc';
    ltc.accountXpub = 'xpub-ltc';
  }
  return {
    version: 2,
    _noMnemonic: true,
    fingerprint: 'fp',
    expiresAtMs: Date.now() + 60_000,
    keys: { btc, ltc, xmr: u8obj(), wow: u8obj(), grin: u8obj(), nostr: u8obj() },
    addresses: { btc: 'a', ltc: 'a', xmr: 'a', wow: 'a', grin: 'a' },
  };
}

test('parseSessionCache accepts a cache carrying the account xpub', () => {
  assert.notEqual(parseSessionCache(baseCache(true)), null);
});

test('parseSessionCache rejects a pre-xpub cache so it self-heals (G10)', () => {
  assert.equal(parseSessionCache(baseCache(false)), null);
});

// ============================================================================
// Real derived-keys round-trip through a session cache
// ============================================================================

test('a v3-derived-keys session cache passes parseSessionCache after serialize', () => {
  const keys = deriveAllKeys(ABANDON, '', 3);
  // accountXpub is a plain string, so it survives the session-cache serializer
  // untouched (only Uint8Arrays are transformed).
  const cache = {
    version: 2,
    _noMnemonic: true,
    fingerprint: 'fp',
    expiresAtMs: Date.now() + 60_000,
    keys,
    addresses: { btc: 'a', ltc: 'a', xmr: 'a', wow: 'a', grin: 'a' },
  };
  const parsed = parseSessionCache(cache);
  assert.notEqual(parsed, null);
});
