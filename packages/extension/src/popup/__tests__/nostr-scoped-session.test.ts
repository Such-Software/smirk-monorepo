import './_chrome-stub';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {
  generateMnemonicPhrase, computeSeedFingerprint, deriveNostrSessionRoots,
  deriveNostrIdentity, deriveNostrKeyFromSeed, mnemonicToSeed,
  deriveNostrIdentityForOrigin, addDerivedIdentity, addBurnerIdentity,
  setActiveIdentity, verifyNostrEventId, type UnlockedWallet,
} from '@smirk/core';
import {
  loadVault, saveVault, vaultCrypto, getActiveNostrIdentityFromWallet,
  resolveNostrIdentityForOrigin, exportVaultBackup, restoreVaultBackup,
} from '../nostr-vault';
import { deriveAppEncKeyWithUnlocked, openAppSealWithUnlocked, signNostrEventWith } from '../../dapp-popup/signers';

before(async () => { await sodium.ready; });

function session() {
  const mnemonic = generateMnemonicPhrase();
  const fingerprint = computeSeedFingerprint(mnemonic);
  const nostr = deriveNostrSessionRoots(mnemonic, fingerprint);
  const seed = mnemonicToSeed(mnemonic);
  const key = deriveNostrKeyFromSeed(seed, 0);
  seed.fill(0);
  // Exercise consumers with only their scoped authority, as after cache revival.
  const wallet = {
    fingerprint, keys: { nostr: key }, addresses: {}, sessionSecrets: { nostr },
  } as UnlockedWallet;
  return { mnemonic, nostr, wallet };
}

test('restored sessions select and sign with derived and encrypted burner identities', async () => {
  const { mnemonic, nostr, wallet } = session();
  const initial = await loadVault(mnemonic);
  const derived = addDerivedIdentity(initial, mnemonic);
  const burner = addBurnerIdentity(derived.vault, vaultCrypto(mnemonic).encrypt);
  for (const chosen of [derived.identity, burner.identity]) {
    await saveVault(nostr, setActiveIdentity(burner.vault, chosen.pubkeyHex));
    const resolved = await getActiveNostrIdentityFromWallet(wallet);
    assert.equal(resolved.needsUnlock, false);
    assert.equal(resolved.identity?.pubkeyHex, chosen.pubkeyHex);
    const event = signNostrEventWith(resolved.identity, { kind: 1, content: 'session regression', tags: [] });
    assert.ok(verifyNostrEventId(event.sig, event.id, chosen.pubkeyHex));
    assert.notEqual(event.pubkey, deriveNostrIdentity(mnemonic, 0).pubkeyHex);
  }
  const backup = await exportVaultBackup(nostr);
  const restored = await restoreVaultBackup(mnemonic, backup);
  assert.equal(restored.active, burner.identity.pubkeyHex);
  assert.equal(wallet.mnemonic, undefined);
  assert.equal(wallet.seed, undefined);
});

test('site grants restore their exact chosen identity and refuse an unrelated identity', async () => {
  const { mnemonic, wallet } = session();
  const origin = 'https://app.example';
  const selected = deriveNostrIdentityForOrigin(mnemonic, origin);
  assert.equal((await resolveNostrIdentityForOrigin(wallet, origin, selected.pubkeyHex))?.pubkeyHex, selected.pubkeyHex);
  assert.equal(await resolveNostrIdentityForOrigin(wallet, 'https://different.example', selected.pubkeyHex), null);
  const unrelated = deriveNostrIdentity(generateMnemonicPhrase(), 0).pubkeyHex;
  assert.equal(await resolveNostrIdentityForOrigin(wallet, origin, unrelated), null);
});

test('a missing active identity never silently signs as account zero', async () => {
  const { nostr, wallet } = session();
  const vault = await loadVault(nostr);
  await saveVault(nostr, { ...vault, active: 'missing-identity' });
  const result = await getActiveNostrIdentityFromWallet(wallet);
  assert.equal(result.identity, null);
  assert.equal(result.needsUnlock, true);
});

test('restored app keys open reference sealed boxes without the recovery phrase', () => {
  const { wallet } = session();
  const origin = 'https://app.example';
  const context = 'notes';
  const pub = deriveAppEncKeyWithUnlocked(wallet, origin, context);
  const plaintext = 'session-scoped decryption regression';
  const sealed = sodium.crypto_box_seal(new TextEncoder().encode(plaintext), Buffer.from(pub, 'hex'));
  const envelope = Buffer.from(sealed).toString('base64');
  const opened = openAppSealWithUnlocked(wallet, origin, envelope, context);
  assert.equal(Buffer.from(opened, 'base64').toString(), plaintext);
  assert.throws(() => openAppSealWithUnlocked(wallet, origin, envelope, 'other-context'));
});
