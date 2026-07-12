import { api, clampAutoLockMinutes, deriveNostrIdentity, type UnlockedWallet } from '@smirk/core';
import type { SmirkPublicKeys, SmirkAddresses } from '@such-software/smirk-dapp-api';
import type { DappPublicCache } from '../background/dapp/provider';
import { bytesToHex } from './format';

/**
 * Project an `UnlockedWallet` into the public-material shape the
 * background SW reads when servicing dapp `getPublicKeys` /
 * `getAddresses` calls. Public material only — no private bytes
 * leave this function. Written into `chrome.storage.local` on every
 * unlock transition; cleared on lock / destroy.
 */
export function dappPublicCacheFor(
  wallet: UnlockedWallet,
  autoLockMinutes: number,
): DappPublicCache {
  const publicKeys: SmirkPublicKeys = {
    btc: bytesToHex(wallet.keys.btc.publicKey),
    ltc: bytesToHex(wallet.keys.ltc.publicKey),
    // CryptoNote: dapps that need to verify "this address corresponds
    // to that pubkey" use the public *spend* key, the same field
    // bootstrapAuth sends to the backend's key-list (see
    // `wallet-flow.ts buildKeysList`).
    xmr: bytesToHex(wallet.keys.xmr.publicSpendKey),
    wow: bytesToHex(wallet.keys.wow.publicSpendKey),
    grin: bytesToHex(wallet.keys.grin.publicKey),
  };
  const addresses: SmirkAddresses = {
    btc: wallet.addresses.btc,
    ltc: wallet.addresses.ltc,
    xmr: wallet.addresses.xmr,
    wow: wallet.addresses.wow,
    grin: wallet.addresses.grin,
  };
  // Mirror the popup's own session-cache TTL into the dapp public
  // cache so the SW provider can detect "wallet auto-locked while
  // the popup was closed and never cleared the cache" without an
  // IPC round-trip. Per Finding 13 in the v0.3.0 pre-ship audit.
  //
  // autoLockMinutes is clamped to [0, AUTO_LOCK_MAX_MINUTES]. The
  // pre-2026-06-13 "Never" sentinel (negative / MAX_SAFE_INTEGER)
  // was dropped — legacy stored values self-heal to the 24h cap.
  const clampedAutoLock = clampAutoLockMinutes(autoLockMinutes);
  const sessionExpiresAtMs =
    clampedAutoLock === 0
      ? Date.now() // immediate lock: cache is stale the moment we write it
      : Date.now() + clampedAutoLock * 60_000;
  // Public material for the dapp bridge's getNostrPublicKey() / getBackend()
  // (SW provider reads these from the cache; no seed in the SW). Prefer the
  // cached account-0 nostr pubkey so the npub survives a session-cache restore
  // (which drops the mnemonic); fall back to mnemonic derivation on a fresh
  // unlock. Mirrors live-wallet-provider.ts getNostrPublicKey().
  const nostrPublicKey = wallet.keys.nostr
    ? bytesToHex(wallet.keys.nostr.publicKey)
    : wallet.mnemonic
      ? deriveNostrIdentity(wallet.mnemonic, 0).pubkeyHex
      : undefined;
  return {
    fingerprint: wallet.fingerprint,
    addresses,
    publicKeys,
    ...(nostrPublicKey ? { nostrPublicKey } : {}),
    backendUrl: api.getBaseUrl(),
    unlockedAt: Date.now(),
    sessionExpiresAtMs,
  };
}
