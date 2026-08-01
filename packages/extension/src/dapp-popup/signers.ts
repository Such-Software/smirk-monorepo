/**
 * Asset-agnostic signMessage executor used in any wallet-foreground
 * context that holds an `UnlockedWallet`. Runs in the approval popup
 * window on the browser extension, and in the BrowseTab dapp bridge
 * on Tauri desktop / Capacitor mobile — same code, no fork.
 *
 * Compute one signature per requested asset. BTC/LTC use the
 * canonical Bitcoin-message format (`signBitcoinMessage`); XMR/WOW
 * sign the raw UTF-8 message bytes with their ed25519 private
 * spend-key scalar; Grin signs with its slatepack ed25519 scalar.
 * All ed25519 signatures go through `signEd25519WithScalar` because
 * our keys are stored as raw scalars, not RFC-8032 seeds — passing
 * them to `ed25519.sign` would re-clamp into a different scalar and
 * yield signatures that don't verify against the public keys we
 * actually publish.
 *
 * Per-asset failures are captured per-asset (empty signature string)
 * rather than aborting the whole result — smirk.cash and similar
 * dapps pick the signature for the asset the user chose, so one
 * failing asset shouldn't kill the others.
 */

import { bytesToHex } from '@noble/hashes/utils';
import {
  api,
  deriveAppEncryptionKey,
  sealOpen,
  signBitcoinMessage,
  signEd25519WithScalar,
  signNostrEvent,
  nip44Encrypt,
  nip44Decrypt,
  nip04Encrypt,
  nip04Decrypt,
  type NostrIdentity,
  type SignedNostrEvent,
  type UnlockedWallet,
  type UnsignedNostrEvent,
} from '@smirk/core';
import type { SmirkAsset, SmirkSignResult } from '@such-software/smirk-dapp-api';

/**
 * Messages the wallet's OWN backend treats as an authentication challenge:
 * `POST /auth/extension` verifies a BIP-137 signature over `smirk-auth-<ts>`.
 * The general dapp `signMessage` surface MUST NEVER produce one — otherwise a
 * connected site (which already holds the btc pubkey from `connect()`) could
 * have the user approve a `signMessage("smirk-auth-<now>")` and replay it to the
 * backend to forge a full authenticated session for the user's own account.
 * The wallet's real registration signs these directly in core
 * (`wallet-flow.ts` / `bootstrap-in-extension.ts`), never through this executor,
 * so refusing the prefix here breaks no legitimate flow.
 */
const RESERVED_AUTH_MESSAGE = /^\s*smirk-auth-/i;

export function signMessageWithUnlocked(
  wallet: UnlockedWallet,
  message: string,
  assets: SmirkAsset[],
): SmirkSignResult {
  if (RESERVED_AUTH_MESSAGE.test(message)) {
    throw new Error(
      'Refusing to sign a reserved Smirk backend-auth challenge through the dapp interface.',
    );
  }
  const msgBytes = new TextEncoder().encode(message);
  const signatures: SmirkSignResult['signatures'] = [];
  for (const asset of assets) {
    try {
      switch (asset) {
        case 'btc':
          signatures.push({
            asset: 'btc',
            signature: signBitcoinMessage(message, wallet.keys.btc.privateKey),
            publicKey: bytesToHex(wallet.keys.btc.publicKey),
          });
          break;
        case 'ltc':
          signatures.push({
            asset: 'ltc',
            signature: signBitcoinMessage(message, wallet.keys.ltc.privateKey),
            publicKey: bytesToHex(wallet.keys.ltc.publicKey),
          });
          break;
        case 'xmr': {
          const pub = wallet.keys.xmr.publicSpendKey;
          signatures.push({
            asset: 'xmr',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.xmr.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'wow': {
          const pub = wallet.keys.wow.publicSpendKey;
          signatures.push({
            asset: 'wow',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.wow.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'grin': {
          const pub = wallet.keys.grin.publicKey;
          signatures.push({
            asset: 'grin',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.grin.privateKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
      }
    } catch (e) {
      console.error(`[signMessage] ${asset} signing failed:`, e);
      // Emit nothing for this asset — see file header. The dapp
      // surfaces it as "No signature found for <asset>".
    }
  }
  return { message, signatures };
}

/**
 * Resolve the wallet's default (account 0) Nostr identity for signing.
 *
 * Prefers the cached derived keypair (`wallet.keys.nostr`), which survives a
 * "stay unlocked for N hours" session-cache restore, so nostr/chat signing
 * keeps working after the mnemonic + seed were dropped from the cache
 * (2026-06-13 hardening). Falls back to deriving from the mnemonic on a fresh
 * unlock, and returns `null` only when neither is available. The identity's
 * `account` field is cosmetic for signing (`nostrIdentityFromPrivkey` recomputes
 * npub/pubkey from the private key), so account-0 caching matches the
 * hardcoded account-0 behaviour of the old mnemonic path.
 */
/**
 * Schnorr-sign an arbitrary Nostr event AS an already-resolved identity (NIP-98
 * login, kind-1 notes, …). The caller (execute-approval) resolves WHICH identity
 * the origin acts as — account-0, a per-origin compartmentalized identity, or a
 * vault burner/imported — via `resolveNostrIdentityForOrigin`, keeping this a pure,
 * storage-free signer. `null` means the identity couldn't be produced (e.g. a
 * per-origin/vault key on a warm resume) → re-unlock.
 */
/** NIP-98 HTTP-auth event kind. Signing one is handing over a bearer credential. */
const NIP98_HTTP_AUTH_KIND = 27235;

/**
 * Refuse to sign a NIP-98 token aimed at the user's OWN backend.
 *
 * This is the Nostr twin of {@link RESERVED_AUTH_MESSAGE}. `POST /auth/nostr`
 * mints a full session from a kind-27235 event whose `u` tag matches the
 * server's canonical URL, with no nonce and a 30s window. Nothing inspected the
 * kind or tags before signing, so a connected site could ask for "a Nostr event",
 * get a valid login token for the user's wallet backend, and replay it. The BTC
 * path has refused the equivalent since the auth-replay hardening; this closes
 * the same hole on the Nostr side.
 *
 * Only events targeting OUR configured backend are refused: signing NIP-98 for
 * some other service is a legitimate thing for a dapp to ask.
 */
function assertNotSelfAuthToken(event: UnsignedNostrEvent): void {
  if (event.kind !== NIP98_HTTP_AUTH_KIND) return;
  const uTag = event.tags?.find((t) => t[0] === 'u')?.[1];
  if (!uTag) {
    throw new Error(
      'Refusing to sign a NIP-98 HTTP-auth event with no `u` tag through the dapp interface.',
    );
  }
  let target: string;
  try {
    target = new URL(uTag).host.toLowerCase();
  } catch {
    throw new Error('Refusing to sign a NIP-98 event with an unparseable `u` tag.');
  }
  let ours: string;
  try {
    ours = new URL(api.getBaseUrl()).host.toLowerCase();
  } catch {
    return; // No configured backend to protect.
  }
  if (target === ours) {
    throw new Error(
      'Refusing to sign a Smirk backend sign-in token through the dapp interface.',
    );
  }
}

export function signNostrEventWith(
  identity: NostrIdentity | null,
  event: UnsignedNostrEvent,
): SignedNostrEvent {
  if (!identity) {
    throw new Error('Nostr signing needs the unlocked identity — re-unlock the wallet');
  }
  assertNotSelfAuthToken(event);
  return signNostrEvent(event, identity);
}

/** Uint8Array → base64 (the dapp-api wire form for sealed/plaintext bytes). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** base64 → Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derive the origin's app-scoped e2ee PUBLIC key (x25519 hex). `domainScope` is
 * the wallet-verified origin, supplied by the handler — never a page string.
 * Requires the unlocked mnemonic (absent on a session-cache restore).
 */
export function deriveAppEncKeyWithUnlocked(
  wallet: UnlockedWallet,
  domainScope: string,
  context: string,
): string {
  // NOTE: still mnemonic-gated on a session-cache restore. Unlike the nostr
  // identity, the domain-scoped app-encryption key is not cached in
  // DerivedKeys, so e2ee-on-restore needs its own fix (out of scope for the
  // chat-signing bug).
  if (!wallet.mnemonic) {
    throw new Error(
      'App encryption needs the unlocked mnemonic — re-unlock the wallet',
    );
  }
  return deriveAppEncryptionKey(wallet.mnemonic, domainScope, context).publicKeyHex;
}

/**
 * Open a base64 libsodium `crypto_box_seal` envelope addressed to the origin's
 * app key, returning base64 plaintext. The private key is derived transiently
 * and never leaves this context. Throws on a bad tag (wrong key / tampered box).
 */
export function openAppSealWithUnlocked(
  wallet: UnlockedWallet,
  domainScope: string,
  sealedBase64: string,
  context: string,
): string {
  // NOTE: still mnemonic-gated on a session-cache restore (see
  // deriveAppEncKeyWithUnlocked): the app-encryption key is not cached, so
  // e2ee-on-restore needs a separate fix beyond the nostr-key caching here.
  if (!wallet.mnemonic) {
    throw new Error(
      'App decryption needs the unlocked mnemonic — re-unlock the wallet',
    );
  }
  const key = deriveAppEncryptionKey(wallet.mnemonic, domainScope, context);
  const plaintext = sealOpen(key.privateKey, base64ToBytes(sealedBase64));
  return bytesToBase64(plaintext);
}

/**
 * NIP-07 DM crypto (NIP-44 v2 / legacy NIP-04) AS an already-resolved identity.
 * `op` selects encrypt/decrypt; `peer` is the counterparty x-only hex pubkey. The
 * caller resolves which identity the origin acts as (see {@link signNostrEventWith}).
 */
export function nostrCryptWith(
  identity: NostrIdentity | null,
  op: 'encrypt' | 'decrypt',
  scheme: 'nip44' | 'nip04',
  peer: string,
  data: string,
): string {
  if (!identity) {
    throw new Error('Nostr encryption needs the unlocked identity — re-unlock the wallet');
  }
  if (scheme === 'nip04') {
    return op === 'encrypt'
      ? nip04Encrypt(identity, peer, data)
      : nip04Decrypt(identity, peer, data);
  }
  return op === 'encrypt'
    ? nip44Encrypt(identity, peer, data)
    : nip44Decrypt(identity, peer, data);
}
