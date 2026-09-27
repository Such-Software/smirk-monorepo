import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { mnemonicToSeed } from '../hd';

/** Scoped derivation authority retained only for the user's unlocked session. */
export interface NostrSessionRoots {
  fingerprint: string;
  identityRoot: string;
  originRoot: string;
  appEncryptionRoot: string;
  vaultKey: Uint8Array;
}

export type NostrKeySource = string | NostrSessionRoots;

export function deriveNostrSessionRoots(mnemonic: string, fingerprint: string, passphrase = ''): NostrSessionRoots {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const master = HDKey.fromMasterSeed(seed);
  const exportRoot = (path: string): string => {
    const child = master.derive(path);
    try { return child.privateExtendedKey; } finally { child.wipePrivateData(); }
  };
  try {
    return {
      fingerprint,
      identityRoot: exportRoot("m/44'/1237'"),
      originRoot: exportRoot("m/83696'/4'"),
      appEncryptionRoot: exportRoot("m/83696'/3'"),
      // Preserve the established vault encryption formula byte for byte.
      vaultKey: sha256(new TextEncoder().encode(`smirk-nostr-vault-v1\x00${mnemonic}`)),
    };
  } finally {
    seed.fill(0);
    master.wipePrivateData();
  }
}

/** Derive only below the admitted root; reject accidentally cached master keys. */
export function deriveScopedNostrNode(root: string, segment: number, relativePath: string): HDKey {
  const node = HDKey.fromExtendedKey(root);
  try {
    if (node.depth !== 2 || node.index !== 0x80000000 + segment || !node.privateKey) {
      throw new Error('The unlocked session has an invalid scoped derivation root.');
    }
    return node.derive(relativePath);
  } finally {
    node.wipePrivateData();
  }
}

export function nostrKeySource(wallet: {
  mnemonic?: string;
  sessionSecrets?: { nostr: NostrSessionRoots };
}): NostrKeySource | undefined {
  return wallet.sessionSecrets?.nostr ?? wallet.mnemonic;
}

export function requireNostrKeySource(wallet: Parameters<typeof nostrKeySource>[0]): NostrKeySource {
  const source = nostrKeySource(wallet);
  if (!source) throw new Error('The wallet session has no Nostr signing keys. Unlock the wallet to continue.');
  return source;
}
