import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { generateMnemonicPhrase, computeSeedFingerprint, mnemonicToSeed } from '../../hd';
import { deriveNostrSessionRoots, deriveScopedNostrNode } from '../session-roots';
import { deriveNostrIdentity, deriveNostrIdentityForOrigin, signNostrEvent, verifyNostrEventId } from '../identity';
import { deriveAppEncryptionKey, sealOpen } from '../app-enc';
import { initIdentityVault, addDerivedIdentity, resolveActiveIdentity, setActiveIdentity } from '../identity-store';

const mnemonic = generateMnemonicPhrase();
const fingerprint = computeSeedFingerprint(mnemonic);
const roots = deriveNostrSessionRoots(mnemonic, fingerprint);

test('scoped session roots preserve NIP-06 accounts and signing after phrase removal', () => {
  for (const account of [0, 1, 7, 2147483647]) {
    const full = deriveNostrIdentity(mnemonic, account);
    const restored = deriveNostrIdentity(roots, account);
    assert.equal(restored.pubkeyHex, full.pubkeyHex);
    const event = signNostrEvent({ kind: 1, content: 'session regression', tags: [], created_at: 1 }, restored);
    assert.ok(verifyNostrEventId(event.sig, event.id, full.pubkeyHex));
  }
  for (const account of [-1, 1.5, 2147483648, NaN]) assert.throws(() => deriveNostrIdentity(roots, account));
});

test('per-site identities and app keys retain origin and context separation', () => {
  const origins = ['https://first.example', 'https://second.example'];
  const pubs = origins.map((origin) => {
    assert.equal(deriveNostrIdentityForOrigin(roots, origin).pubkeyHex, deriveNostrIdentityForOrigin(mnemonic, origin).pubkeyHex);
    for (const context of ['', 'notes', 'calendar']) {
      const full = deriveAppEncryptionKey(mnemonic, origin, context);
      const resumed = deriveAppEncryptionKey(roots, origin, context);
      assert.equal(resumed.publicKeyHex, full.publicKeyHex);
      assert.ok(resumed.privateKey.every((value, index) => value === full.privateKey[index]), 'scoped app key must match the established derivation');
      assert.throws(() => sealOpen(resumed.privateKey, new Uint8Array(48)), 'invalid ciphertext must still refuse');
    }
    return deriveNostrIdentityForOrigin(roots, origin).pubkeyHex;
  });
  assert.notEqual(pubs[0], pubs[1]);
  assert.notEqual(deriveAppEncryptionKey(roots, origins[0]!, 'notes').publicKeyHex, deriveAppEncryptionKey(roots, origins[0]!, 'calendar').publicKeyHex);
});

test('vault encryption formula remains compatible and identities rotate on warm restore', () => {
  const expected = sha256(new TextEncoder().encode(`smirk-nostr-vault-v1\x00${mnemonic}`));
  assert.ok(expected.every((value, index) => value === roots.vaultKey[index]), 'existing encrypted identity vaults must remain readable');
  const initial = initIdentityVault(roots);
  const added = addDerivedIdentity(initial, roots);
  const active = setActiveIdentity(added.vault, added.identity.pubkeyHex);
  const identity = resolveActiveIdentity(active, roots, () => { throw new Error('derived identity must not need a persisted secret'); });
  assert.equal(identity.pubkeyHex, deriveNostrIdentity(mnemonic, 1).pubkeyHex);
});

test('only namespace subtrees are retained; a master root is refused', () => {
  for (const [root, segment] of [[roots.identityRoot, 1237], [roots.originRoot, 4], [roots.appEncryptionRoot, 3]] as const) {
    const parsed = HDKey.fromExtendedKey(root);
    assert.equal(parsed.depth, 2);
    assert.equal(parsed.index, 0x80000000 + segment);
    parsed.wipePrivateData();
  }
  const seed = mnemonicToSeed(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  try {
    assert.throws(() => deriveScopedNostrNode(master.privateExtendedKey, 1237, "m/0'/0/0"));
    assert.throws(() => deriveScopedNostrNode(roots.appEncryptionRoot, 1237, "m/0'/0/0"));
    assert.equal(roots.fingerprint, fingerprint);
    assert.ok(!Object.values(roots).includes(mnemonic));
  } finally { seed.fill(0); master.wipePrivateData(); }
});
