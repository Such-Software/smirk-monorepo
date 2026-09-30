import { HDKey } from '@scure/bip32';
import {
  deriveNostrSessionRoots, hexToBytes, sessionSecretsUsable,
  type GrinSessionKeys, type SessionSecrets, type UnlockedWallet,
} from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';
import { ensureWasmInit } from './wasm-init';

export type GrinKeySource = string | GrinSessionKeys;

/** Existing Grin APIs accept a phrase on fresh unlock or scoped session keys. */
export function grinKeySource(wallet: UnlockedWallet): GrinKeySource {
  if (wallet.sessionSecrets?.grin) return wallet.sessionSecrets.grin;
  if (wallet.mnemonic) return wallet.mnemonic;
  throw new Error('Grin signing keys are unavailable. Unlock the wallet again.');
}

export function grinExtendedKey(source: GrinKeySource): string {
  return typeof source === 'string'
    ? wasmGrin.deriveExtendedKey(source)
    : JSON.stringify({ extended_private_key_hex: toHex(source.extendedPrivateKey) });
}

export function grinLegacyExtendedKey(source: GrinKeySource): string {
  return typeof source === 'string' ? wasmGrin.deriveExtendedKeyLegacyBip39(source) : toHex(source.legacyExtendedPrivateKey);
}

export function grinSlatepackSecret(source: GrinKeySource): string {
  return typeof source === 'string' ? wasmGrin.slatepackAddressSecret(source, 0) : toHex(source.slatepackSecret);
}

export function grinSlatepackAddress(source: GrinKeySource): string {
  return typeof source === 'string' ? wasmGrin.slatepackAddress(source, 0, 'mainnet') : source.slatepackAddress;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Derive only the operation subtrees admitted by the grace-period cache. */
export async function ensureSessionSecrets(wallet: UnlockedWallet): Promise<SessionSecrets> {
  if (sessionSecretsUsable(wallet.sessionSecrets, wallet.fingerprint)) return wallet.sessionSecrets;
  if (!wallet.mnemonic || !wallet.seed) throw new Error('Unlock the wallet to refresh its session keys.');
  await ensureWasmInit();
  // A lock may have happened while WASM initialized.
  if (!wallet.mnemonic || !wallet.seed) throw new Error('Wallet was locked before its session keys were ready.');
  const master = HDKey.fromMasterSeed(wallet.seed);
  const account = (coin: number) => {
    const node = master.derive(`m/84'/${coin}'/0'`);
    if (!node.privateKey || !node.chainCode) throw new Error('Could not derive account signing keys.');
    const out = { privateKey: node.privateKey.slice(), chainCode: node.chainCode.slice() };
    node.wipePrivateData();
    return out;
  };
  try {
    const extended = JSON.parse(wasmGrin.deriveExtendedKey(wallet.mnemonic)) as { extended_private_key_hex: string };
    const secrets: SessionSecrets = {
      btc: account(0), ltc: account(2),
      grin: {
        extendedPrivateKey: hexToBytes(extended.extended_private_key_hex),
        legacyExtendedPrivateKey: hexToBytes(wasmGrin.deriveExtendedKeyLegacyBip39(wallet.mnemonic)),
        slatepackSecret: hexToBytes(wasmGrin.slatepackAddressSecret(wallet.mnemonic, 0)),
        slatepackAddress: wasmGrin.slatepackAddress(wallet.mnemonic, 0, 'mainnet'),
        rewindHash: wasmGrin.rewindHash(extended.extended_private_key_hex),
      },
      nostr: deriveNostrSessionRoots(wallet.mnemonic, wallet.fingerprint),
    };
    if (!sessionSecretsUsable(secrets, wallet.fingerprint)) throw new Error('Session signing keys are incomplete.');
    wallet.sessionSecrets = secrets;
    return secrets;
  } finally {
    master.wipePrivateData();
  }
}
