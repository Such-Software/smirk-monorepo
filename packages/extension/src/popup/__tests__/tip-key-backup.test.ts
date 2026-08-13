/**
 * PRIVACY regression: the public-tip URL fragment must never sit in
 * `chrome.storage.local` in cleartext.
 *
 * That fragment decrypts the copy of the tip key the backend serves
 * UNAUTHENTICATED to anyone holding the tip UUID, so a plaintext copy next to
 * the (encrypted) key material handed every unclaimed public tip to whoever
 * could read the Chrome profile WITHOUT the wallet password: stolen laptop,
 * unencrypted backup, forensic image. Pre-2026-08 records are still readable
 * and get upgraded in place the next time they are read.
 */

import './_chrome-stub'; // MUST be first: installs chrome.storage before singletons.ts loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  storeTipKeyBackup,
  listTipKeyBackups,
  getTipKeyBackup,
  decryptTipKeyBackup,
  decryptTipKeyBackupFragment,
  type TipKeyBackup,
} from '../tip-key-backup';

const BTC_PRIV = new Uint8Array(32).fill(7);
const OTHER_PRIV = new Uint8Array(32).fill(9);
const KEY_MATERIAL = new Uint8Array(32).fill(3);
const FRAGMENT = 'Zm9vYmFyLXVybC1mcmFnbWVudA';

function storageKeyFor(tipId: string): string {
  return `smirk:tip-key-backup:${tipId}`;
}

async function rawRecord(tipId: string): Promise<TipKeyBackup> {
  const res = await chrome.storage.local.get(storageKeyFor(tipId));
  const v = res[storageKeyFor(tipId)] as TipKeyBackup | undefined;
  assert.ok(v, `record ${tipId} present`);
  return v;
}

async function storeFixture(tipId: string): Promise<void> {
  await storeTipKeyBackup({
    tipId,
    asset: 'btc',
    tipAddress: 'bc1qexampleexampleexample',
    amount: 1000,
    isPublic: true,
    keyMaterial: KEY_MATERIAL,
    btcPrivateKey: BTC_PRIV,
    urlFragmentEncoded: FRAGMENT,
  });
}

test('the URL fragment is sealed at rest, not stored next to the ciphertext', async () => {
  await storeFixture('tip-sealed');
  const raw = await rawRecord('tip-sealed');

  assert.equal(raw.urlFragmentEncoded, undefined, 'no cleartext fragment at rest');
  assert.ok(raw.urlFragmentCiphertextHex, 'fragment persisted as ciphertext');
  assert.ok(
    !JSON.stringify(raw).includes(FRAGMENT),
    'the fragment does not appear anywhere in the stored record',
  );
  // The wallet that wrote it still gets both secrets back.
  assert.equal(decryptTipKeyBackupFragment(raw, BTC_PRIV), FRAGMENT);
  assert.deepEqual(decryptTipKeyBackup(raw, BTC_PRIV), KEY_MATERIAL);
});

test('read helpers hydrate the fragment for the right wallet only', async () => {
  await storeFixture('tip-hydrate');

  const listed = (await listTipKeyBackups(BTC_PRIV)).find((b) => b.tipId === 'tip-hydrate');
  assert.equal(listed?.urlFragmentEncoded, FRAGMENT, 'share URL still reconstructable');

  const single = await getTipKeyBackup('tip-hydrate', BTC_PRIV);
  assert.equal(single?.urlFragmentEncoded, FRAGMENT);

  // A different seed decrypts neither half, and must not throw on the way past.
  const wrongSeed = (await listTipKeyBackups(OTHER_PRIV)).find((b) => b.tipId === 'tip-hydrate');
  assert.equal(wrongSeed?.urlFragmentEncoded, undefined, 'no fragment under a foreign key');
  assert.equal(decryptTipKeyBackupFragment(wrongSeed as TipKeyBackup, OTHER_PRIV), null);
});

test('a pre-2026-08 plaintext record still reads, and is re-written encrypted', async () => {
  await storeFixture('tip-legacy');
  // Rewind to the old at-rest shape: fragment in the clear, no ciphertext.
  const legacy: TipKeyBackup = { ...(await rawRecord('tip-legacy')) };
  delete legacy.urlFragmentCiphertextHex;
  legacy.urlFragmentEncoded = FRAGMENT;
  await chrome.storage.local.set({ [storageKeyFor('tip-legacy')]: legacy });

  const read = await getTipKeyBackup('tip-legacy', BTC_PRIV);
  assert.equal(read?.urlFragmentEncoded, FRAGMENT, 'legacy record stays readable');

  const migrated = await rawRecord('tip-legacy');
  assert.equal(migrated.urlFragmentEncoded, undefined, 'plaintext dropped on touch');
  assert.ok(migrated.urlFragmentCiphertextHex, 're-written sealed');
  assert.equal(decryptTipKeyBackupFragment(migrated, BTC_PRIV), FRAGMENT);
});

test('a directed (non-public) tip stores no fragment at all', async () => {
  await storeTipKeyBackup({
    tipId: 'tip-directed',
    asset: 'ltc',
    tipAddress: 'ltc1qexampleexampleexample',
    amount: 42,
    isPublic: false,
    keyMaterial: KEY_MATERIAL,
    btcPrivateKey: BTC_PRIV,
  });
  const raw = await rawRecord('tip-directed');
  assert.equal(raw.urlFragmentCiphertextHex, undefined);
  assert.equal(raw.urlFragmentEncoded, undefined);
  assert.equal(decryptTipKeyBackupFragment(raw, BTC_PRIV), null);
});
