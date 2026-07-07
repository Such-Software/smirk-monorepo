/**
 * Multi-identity vault (P2): derived + burner + imported identities, switch/rename/
 * remove, and correct active-identity resolution. Secret crypto is injected — the
 * test uses a trivial reversible "cipher" (hex) to prove the store only ever holds
 * ciphertext for burner/imported keys and never for derived ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { deriveNostrIdentity, encodeNsec, generateBurnerIdentity } from '../identity';
import {
  initIdentityVault,
  addDerivedIdentity,
  addBurnerIdentity,
  importIdentity,
  setActiveIdentity,
  renameIdentity,
  removeIdentity,
  resolveActiveIdentity,
  resolveIdentity,
} from '../identity-store';

const M = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
// Stand-in host crypto (real host binds these to the unlocked keystore).
const encrypt = (b: Uint8Array) => bytesToHex(b);
const decrypt = (s: string) => hexToBytes(s);

test('init seeds the account-0 derived identity, active, no stored secret', () => {
  const v = initIdentityVault(M);
  assert.equal(v.identities.length, 1);
  assert.equal(v.identities[0]!.source, 'derived');
  assert.equal(v.identities[0]!.account, 0);
  assert.equal(v.active, v.identities[0]!.pubkeyHex);
  assert.deepEqual(v.secrets, {}); // derived keys are re-derived, never stored
  // Active resolves to the real account-0 identity.
  const active = resolveActiveIdentity(v, M, decrypt);
  assert.equal(active.pubkeyHex, deriveNostrIdentity(M, 0).pubkeyHex);
});

test('adds a second derived account (next free index), still no secret stored', () => {
  const { vault } = addDerivedIdentity(initIdentityVault(M), M);
  assert.equal(vault.identities.length, 2);
  assert.equal(vault.identities[1]!.account, 1);
  assert.deepEqual(vault.secrets, {});
  assert.equal(
    resolveIdentity(vault, vault.identities[1]!.pubkeyHex, M, decrypt).pubkeyHex,
    deriveNostrIdentity(M, 1).pubkeyHex,
  );
});

test('burner identity: random, seed-independent, secret stored ENCRYPTED', () => {
  const { vault, identity } = addBurnerIdentity(initIdentityVault(M), encrypt, 'seller');
  assert.equal(identity.source, 'burner');
  assert.equal(identity.label, 'seller');
  // Not any derived account of this seed.
  for (let a = 0; a < 3; a++) assert.notEqual(identity.pubkeyHex, deriveNostrIdentity(M, a).pubkeyHex);
  // The secret is present but as ciphertext (our stand-in = hex, != a live key ref).
  assert.ok(vault.secrets[identity.pubkeyHex]);
  // Resolves back to a usable identity via decrypt.
  const resolved = resolveIdentity(vault, identity.pubkeyHex, M, decrypt);
  assert.equal(resolved.pubkeyHex, identity.pubkeyHex);
});

test('import from nsec round-trips to the same pubkey', () => {
  const burner = generateBurnerIdentity();
  const nsec = encodeNsec(burner.privateKey);
  const { vault, identity } = importIdentity(initIdentityVault(M), nsec, encrypt);
  assert.equal(identity.source, 'imported');
  assert.equal(identity.pubkeyHex, burner.pubkeyHex);
  assert.deepEqual(
    Array.from(resolveIdentity(vault, identity.pubkeyHex, M, decrypt).privateKey),
    Array.from(burner.privateKey),
  );
});

test('switch active, rename, and remove (refuses last, reassigns active)', () => {
  let v = initIdentityVault(M);
  const main = v.active;
  ({ vault: v } = addBurnerIdentity(v, encrypt, 'burner'));
  const burner = v.identities[1]!.pubkeyHex;

  v = setActiveIdentity(v, burner);
  assert.equal(v.active, burner);

  v = renameIdentity(v, burner, 'market seller');
  assert.equal(v.identities.find((i) => i.pubkeyHex === burner)!.label, 'market seller');

  // Removing the active burner reassigns active to the survivor + drops its secret.
  v = removeIdentity(v, burner);
  assert.equal(v.identities.length, 1);
  assert.equal(v.active, main);
  assert.equal(v.secrets[burner], undefined);

  // Cannot remove the last one.
  assert.throws(() => removeIdentity(v, main), /last identity/);
});

test('duplicate import is rejected', () => {
  const nsec = encodeNsec(generateBurnerIdentity().privateKey);
  const { vault } = importIdentity(initIdentityVault(M), nsec, encrypt);
  assert.throws(() => importIdentity(vault, nsec, encrypt), /already exists/);
});
