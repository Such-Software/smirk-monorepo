import { HDKey } from '@scure/bip32';
import { deriveNostrSessionRoots } from '../nostr/session-roots';
import { mnemonicToSeed, deriveAllKeys, generateMnemonicPhrase } from '../hd';
import { deriveAddresses, type SessionCachePayload, type SessionSecrets } from '../keystore';

// Runtime-only wallet material. Grin placeholders test cache shape, not crypto.
export const SESSION_TEST_MNEMONIC = generateMnemonicPhrase();

export function sessionSecretsFixture(fingerprint: string, mnemonic = SESSION_TEST_MNEMONIC): SessionSecrets {
  const master = HDKey.fromMasterSeed(mnemonicToSeed(mnemonic));
  const account = (coin: number) => {
    const node = master.derive(`m/84'/${coin}'/0'`);
    return { privateKey: node.privateKey!, chainCode: node.chainCode! };
  };
  return {
    btc: account(0), ltc: account(2),
    grin: {
      extendedPrivateKey: new Uint8Array(64).fill(1),
      legacyExtendedPrivateKey: new Uint8Array(64).fill(2),
      slatepackSecret: new Uint8Array(32).fill(3),
      slatepackAddress: 'grin1fixture', rewindHash: 'ab'.repeat(32),
    },
    nostr: deriveNostrSessionRoots(mnemonic, fingerprint),
  };
}

export function sessionCacheFixture(fingerprint = 'fp'): SessionCachePayload {
  const keys = deriveAllKeys(SESSION_TEST_MNEMONIC, '', 3);
  return {
    version: 3, _noMnemonic: true, fingerprint, keys, addresses: deriveAddresses(keys),
    sessionSecrets: sessionSecretsFixture(fingerprint), lockId: null,
    expiresAtMs: Date.now() + 60_000,
  };
}
