/**
 * Tip-handler — orchestrates the per-asset funding tx + backend POST
 * for social tipping.
 *
 * Flow (per asset):
 *   1. Generate a fresh tip keypair locally (never derived from the
 *      sender's wallet — single-use, throwaway).
 *   2. Compute the tip address from the fresh keypair.
 *   3. Build + sign + broadcast a tx funding that address with the
 *      tip amount. Sender's wallet pays the network fee.
 *   4. Encrypt the tip's private key:
 *        - Targeted: ECDH(ephemeral_priv, recipient.btc.pubkey) +
 *          XChaCha20-Poly1305. v0.2.4 wire format: ephemeralPubkey
 *          (33 bytes hex) || ciphertext (hex).
 *        - Public: random 32-byte URL fragment key + XChaCha20-Poly1305.
 *          claim_key_hash = sha256(fragment_key) so backend can
 *          authenticate claimers without seeing the key.
 *   5. POST /api/v1/social/tip with funding_txid + encrypted_key +
 *      tip_address + metadata. Backend bot DMs the recipient via
 *      Telegram / Discord once funding confirms (per asset's
 *      confirmation requirement).
 *
 * All five assets are wired. BTC/LTC and XMR/WOW fund a freshly
 * generated single-use keypair and derive the tip address from it;
 * Grin funds a single-party voucher output instead, since it has no
 * address to pay.
 */

import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import type { UnlockedWallet, GrinPendingOverlay } from '@smirk/core';
import {
  api,
  chainProviders,
  btcAddress,
  ltcAddress,
  xmrAddress,
  wowAddress,
  bytesToHex,
  hexToBytes,
  createEncryptedTipPayload,
  createPublicTipPayload,
  generatePrivateKey,
  generateUrlFragmentKey,
  getPublicKey,
  randomBytes,
  resolveFeeRateOrFallback,
} from '@smirk/core';
import type { TipPlatform, TipSubmitFields, TipSubmitOutcome } from '@smirk/ui';
import { grin as wasmGrin } from '@smirk/wasm';
import { send } from './send-handler';
import { resolveGrinSpendable } from './grin-flows';
import { recordGrinTx } from './grin-tx-journal';
import { storeTipKeyBackup } from './tip-key-backup';

/**
 * Retry `api.attachSocialTipFunding` with exponential backoff.
 * Critical: the on-chain broadcast has already happened by the time
 * we call this, so a transient network glitch on the attach
 * round-trip would otherwise orphan the funding from the backend's
 * view (tip stays as draft with no `funding_txid`, doesn't appear
 * in Sent Tips). Server-side dedupes on `(tip_id, funding_txid)` so
 * retries are safe to issue.
 *
 * Three attempts at 1s, 3s, 9s — total worst-case ~13s before surfacing
 * to the user. If all attempts fail the on-chain funds are still
 * recoverable: the local backup carries the tip key so the user can
 * clawback via the on-chain sweep path, but the tip won't appear in
 * Sent Tips until the attach eventually succeeds.
 */
async function attachFundingWithRetry(
  tipId: string,
  txid: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]!));
    }
    try {
      const r = await api.attachSocialTipFunding(tipId, txid);
      if (!r.error && r.data) return { ok: true };
      lastErr = r.error ?? 'unknown';
      console.warn(
        `[tip] attach_funding attempt ${attempt + 1}/${delays.length} failed: ${lastErr}`,
      );
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(
        `[tip] attach_funding attempt ${attempt + 1}/${delays.length} threw: ${lastErr}`,
      );
    }
  }
  return {
    ok: false,
    error: lastErr ?? 'attach_funding failed after retries',
  };
}

/** Broadcast metadata the shell needs to record a `pendingOutgoing`
 *  entry for instant balance feedback. Shape matches
 *  `PendingOutgoingTx` in @smirk/core. Fired immediately after a
 *  successful on-chain broadcast, BEFORE the backend attach-funding
 *  call — so even if attach fails the sender sees the deduction. */
export interface TipBroadcastEvent {
  assetId: string;
  txid: string;
  amountAtomic: bigint;
  feeAtomic: bigint;
  recipient: string;
  inputs?: string[];
  inputsTotalAtomic?: bigint;
  /** Backend tip id — included so the resulting `pendingOutgoing`
   *  entry can carry `context: {kind:'tip-fund', tipId}` and the
   *  per-asset Activity row can tap-route to the tip detail. */
  tipId: string;
}

/**
 * Top-level dispatcher. Branches by asset, delegates to per-asset
 * orchestrator. Catches per-asset errors and surfaces them in the
 * TipSubmitOutcome shape the TipMaker expects.
 */
export async function dispatchSocialTip(args: {
  wallet: UnlockedWallet;
  /** Backend user UUID for the sender — required for any /social
   *  endpoint that ties tips to the authenticated user. */
  senderUserId: string;
  fields: TipSubmitFields;
  /** Shell-provided sink for broadcast metadata. Called once per
   *  successful on-chain broadcast so the popup can write a
   *  `pendingOutgoing` entry — sender's balance reflects the
   *  deduction immediately instead of waiting for LWS / Electrum to
   *  reflect. Matches v0.2.4 `addPendingTx` behavior for XMR/WOW
   *  (which the v0.3 port silently dropped). */
  onBroadcast?: (e: TipBroadcastEvent) => void | Promise<void>;
  /** Grin pending overlay (client output state) — required for a Grin tip:
   *  scan-based input selection + child-index reservation. */
  grinPending?: GrinPendingOverlay;
  /** Grin view-only rewind hash — required for a Grin tip's scan. */
  grinRewindHash?: string;
}): Promise<TipSubmitOutcome> {
  const { wallet, fields, onBroadcast } = args;

  // MAX_SAFE_INTEGER guard (2026-06-13 tip audit should-fix #2).
  // `api.createSocialTip` serializes `amount` as a JS Number — i.e.
  // a u53. WOW (11 decimals) hits 2^53-1 at ~90,071 WOW per tip,
  // realistic for whale/channel-raid tips. On-chain broadcast uses
  // the original bigint (correct), but the backend stores the
  // ROUNDED number as `tip.amount`, so the verifier then compares
  // observed-vs-declared against the wrong target and mis-branches
  // Verified vs Short. Recipient inbox + share URL display the
  // rounded value too — silent precision loss with no user signal.
  //
  // Hard early-return BEFORE any broadcast so the user can split
  // into smaller tips. v0.3.1 structural fix: switch
  // CreateSocialTipRequest.amount to a decimal-string + i64 parse
  // on the Rust side.
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  if (fields.amountAtomic > MAX_SAFE) {
    return {
      ok: false,
      error: 'Amount too large — split into smaller tips. (Tip atomic-amounts are currently capped at 2^53-1; the limit will be lifted in v0.3.1.)',
    };
  }

  try {
    if (fields.assetId === 'btc' || fields.assetId === 'ltc') {
      return await createBtcLtcTip(wallet, fields, onBroadcast);
    }
    if (fields.assetId === 'xmr' || fields.assetId === 'wow') {
      return await createXmrWowTip(wallet, args.senderUserId, fields, onBroadcast);
    }
    if (fields.assetId === 'grin') {
      // Grin tracks in-flight balance via the client pending overlay (recorded
      // inside createGrinTip after broadcast), not via pendingOutgoing. No
      // onBroadcast wiring needed.
      if (!args.grinPending || !args.grinRewindHash) {
        return { ok: false, error: 'Grin tipping unavailable — wallet not ready (no scan credential)' };
      }
      return await createGrinTip(wallet, args.senderUserId, fields, {
        overlay: args.grinPending,
        rewindHash: args.grinRewindHash,
      });
    }
    return {
      ok: false,
      error: `Tipping not supported for ${fields.assetId}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// BTC / LTC
// ============================================================================

async function createBtcLtcTip(
  wallet: UnlockedWallet,
  fields: TipSubmitFields,
  onBroadcast?: (e: TipBroadcastEvent) => void | Promise<void>,
): Promise<TipSubmitOutcome> {
  const asset = fields.assetId as 'btc' | 'ltc';

  // 1. Resolve recipient's BTC pubkey if this is a targeted tip.
  // We always encrypt to BTC pubkey regardless of asset, since the
  // claimer's BTC private key is the universal decryption key (the
  // recipient might not have a wallet for this asset yet, but every
  // Smirk wallet has a BTC key). Mirrors v0.2.4.
  let recipientBtcPubkeyHex: string | undefined;
  if (!fields.isPublic) {
    const lookup = await lookupRecipientBtcPubkey(fields.platform, fields.username);
    if (!lookup.ok) return { ok: false, error: lookup.error };
    recipientBtcPubkeyHex = lookup.btcPubkeyHex;
  }

  // 2. Generate fresh tip keypair.
  const tipPrivateKey = generatePrivateKey();
  const tipPubkey = getPublicKey(tipPrivateKey, true);
  const tipAddress = asset === 'btc' ? btcAddress(tipPubkey) : ltcAddress(tipPubkey);

  // 3. Encrypt the tip private key.
  const { encryptedKey, claimKeyHash, urlFragmentEncoded } = encryptTipKey({
    keyMaterial: tipPrivateKey,
    isPublic: fields.isPublic,
    recipientBtcPubkeyHex,
  });

  // 4. Two-phase create — phase 1: persist the encrypted key + address
  //    on the backend BEFORE any on-chain action. If the user closes
  //    the popup or hits a network failure between here and broadcast
  //    (step 6), nothing happened on-chain so there's nothing to
  //    recover. The draft sits server-side and can be cancelled
  //    explicitly via `api.cancelSocialTip(tip_id)` (we do that on
  //    broadcast failure below).
  const draft = await api.createSocialTip({
    ...(fields.isPublic ? {} : { platform: fields.platform, username: fields.username }),
    asset,
    amount: Number(fields.amountAtomic),
    is_public: fields.isPublic,
    encrypted_key: encryptedKey,
    ...(claimKeyHash ? { claim_key_hash: claimKeyHash } : {}),
    tip_address: tipAddress,
    // NO funding_txid — backend creates status='draft'.
    sender_anonymous: fields.senderAnonymous,
  });
  if (draft.error || !draft.data) {
    return {
      ok: false,
      error: `Failed to register tip with backend: ${draft.error ?? 'unknown'}. No on-chain action was taken.`,
    };
  }
  const tipId = draft.data.tip_id;

  // 4a. Third-layer backup: encrypt the tip private key with the
  //     wallet's BTC key and stash in chrome.storage.local. The
  //     backend is already backed up off-host (daily full + 6-hourly
  //     db-only); this covers the failure modes those snapshots can't
  //     (corruption between snapshots, user offline during incident,
  //     cross-device migration via seed re-import). See tip-key-backup.ts.
  await storeTipKeyBackup({
    tipId,
    asset,
    tipAddress,
    amount: Number(fields.amountAtomic),
    isPublic: fields.isPublic,
    keyMaterial: tipPrivateKey,
    btcPrivateKey: wallet.keys.btc.privateKey,
    ...(urlFragmentEncoded ? { urlFragmentEncoded } : {}),
  });

  // 5. Estimate fee. We use the `normal` tier; users wanting custom
  //    fee control should use Send (not Tip).
  // A fee-estimate outage must not strand the tip: fall back to a safe floored
  // rate instead of aborting (and orphaning the draft). Fund safety is intact
  // either way, since the tx is built + broadcast below only after this resolves.
  const feeRates = await chainProviders.utxo(asset).estimateFee();
  const estimatedNormal =
    !feeRates.error && feeRates.data?.model === 'rate-estimate' ? feeRates.data.normal : null;
  const feeRateSatPerVb = resolveFeeRateOrFallback(estimatedNormal);

  // 6. Build + sign + broadcast funding tx. If broadcast fails, the
  //    draft is wasted DB state — cancel it server-side to keep things
  //    clean. Fund safety is intact because no funds left the sender.
  const sendResult = await send(wallet, {
    fromAssetId: asset,
    amountAtomic: fields.amountAtomic,
    toAddress: tipAddress,
    feeRateSatPerVb,
    sweep: false,
  });
  if (!sendResult.ok) {
    await api.cancelSocialTip(tipId).catch(() => undefined);
    return { ok: false, error: sendResult.error };
  }

  // 6a. Fire onBroadcast so the shell records a pendingOutgoing entry
  //     BEFORE we try to attach-funding. Even if attach-funding fails,
  //     the sender's balance reflects the deduction immediately.
  if (onBroadcast) {
    await onBroadcast({
      assetId: asset,
      txid: sendResult.txid,
      amountAtomic: fields.amountAtomic,
      feeAtomic: sendResult.feeAtomic ?? 0n,
      recipient: tipAddress,
      tipId,
      ...(sendResult.inputs ? { inputs: sendResult.inputs } : {}),
      ...(sendResult.inputsTotalAtomic !== undefined
        ? { inputsTotalAtomic: sendResult.inputsTotalAtomic }
        : {}),
    });
  }

  // 7. Phase 2: attach the broadcast txid to the draft. Retryable
  //    server-side (dedupe on tip_id+funding_txid), so transient
  //    network errors here recover automatically via the retry
  //    helper. If all retries fail the funds are on-chain and the
  //    key is in the local backup — user clawback path is available.
  const attach = await attachFundingWithRetry(tipId, sendResult.txid);
  if (!attach.ok) {
    return {
      ok: false,
      error: `Funded ${asset} at ${tipAddress} (tx ${sendResult.txid}) but couldn't attach funding to backend tip ${tipId} after 3 retries: ${attach.error}. Open this asset on Home → tap the tip to Clawback.`,
    };
  }

  return {
    ok: true,
    tipId,
    // BTC/LTC have 0-conf so share URL is available immediately for
    // public tips. Targeted tips don't surface a share URL (the bot
    // DMs the recipient instead).
    shareUrl: fields.isPublic
      ? buildShareUrl(tipId, urlFragmentEncoded, draft.data?.share_url)
      : null,
    shareUrlPending: false,
  };
}

/**
 * Resolve a recipient's BTC pubkey (lowercase hex, 33 bytes/66 chars).
 * BTC pubkey is the universal encryption target for tip keys — every
 * Smirk wallet has one, regardless of which asset the tip funds.
 */
async function lookupRecipientBtcPubkey(
  platform: TipPlatform,
  username: string,
): Promise<{ ok: true; btcPubkeyHex: string } | { ok: false; error: string }> {
  const r =
    platform === 'smirk'
      ? await api.lookupSmirkName(username)
      : await api.lookupSocial(platform, username);
  if (r.error || !r.data) {
    return {
      ok: false,
      error: r.error ?? `Failed to look up recipient @${username} on ${platform}`,
    };
  }
  if (!r.data.registered) {
    return {
      ok: false,
      error: `@${username} isn't a Smirk user yet — they'd have nothing to claim with. Switch to a public tip and share the link?`,
    };
  }
  const btc = r.data.public_keys?.btc;
  if (!btc) {
    return {
      ok: false,
      error: `Recipient @${username} doesn't have a BTC key registered.`,
    };
  }
  return { ok: true, btcPubkeyHex: btc };
}

/**
 * Encrypt arbitrary tip-key material (bytes) for either targeted
 * (ECIES to recipient's BTC pubkey) or public (URL-fragment-key) tips.
 *
 * Wire format mirrors v0.2.4 so existing claim paths stay compatible:
 * targeted → `ephemeralPubkey(66 hex chars) || ciphertext(hex)`,
 * public → `ciphertext(hex)` (fragment key lives in URL).
 *
 * `keyMaterial` is whatever the asset's claim flow needs to decrypt:
 *   - BTC/LTC: 32-byte secp256k1 private key
 *   - XMR/WOW: 32-byte ed25519 spend key (view key re-derived from it)
 *   - Grin: JSON-encoded voucher data (blind + commit + proof + nChild
 *     + amount + features) — recipient sweeps the voucher commitment.
 */
function encryptTipKey(args: {
  keyMaterial: Uint8Array;
  isPublic: boolean;
  recipientBtcPubkeyHex: string | undefined;
}): {
  encryptedKey: string;
  claimKeyHash: string | undefined;
  urlFragmentEncoded: string | undefined;
} {
  if (args.isPublic) {
    const urlFragmentKey = generateUrlFragmentKey();
    const encryptedKey = createPublicTipPayload(args.keyMaterial, urlFragmentKey.bytes);
    return {
      encryptedKey,
      claimKeyHash: bytesToHex(sha256(urlFragmentKey.bytes)),
      urlFragmentEncoded: urlFragmentKey.encoded,
    };
  }

  if (!args.recipientBtcPubkeyHex) {
    throw new Error('Targeted tip is missing recipientBtcPubkeyHex');
  }
  const recipientPubkeyBytes = hexToBytes(args.recipientBtcPubkeyHex);
  const { encryptedKey, ephemeralPubkey } = createEncryptedTipPayload(
    args.keyMaterial,
    recipientPubkeyBytes,
  );
  // v0.2.4 wire format: concatenate ephemeralPubkey || ciphertext so
  // the backend stores a single `encrypted_key` string. Claimer
  // splits at 66 chars to recover both halves.
  return {
    encryptedKey: ephemeralPubkey + encryptedKey,
    claimKeyHash: undefined,
    urlFragmentEncoded: undefined,
  };
}

// ============================================================================
// XMR / WOW
// ============================================================================
//
// Sender generates a fresh primary keypair (random 32-byte spend seed
// reduced to an ed25519 scalar; view key = sha256(spend) reduced).
// Recipient claims by importing the spend key — gives them full
// authority over that single-tip wallet. View key is also shared with
// the backend so its LWS can monitor for funding confirmations.

async function createXmrWowTip(
  wallet: UnlockedWallet,
  senderUserId: string,
  fields: TipSubmitFields,
  onBroadcast?: (e: TipBroadcastEvent) => void | Promise<void>,
): Promise<TipSubmitOutcome> {
  const asset = fields.assetId as 'xmr' | 'wow';

  // 1. Resolve recipient BTC pubkey for targeted-tip ECIES.
  let recipientBtcPubkeyHex: string | undefined;
  if (!fields.isPublic) {
    const lookup = await lookupRecipientBtcPubkey(fields.platform, fields.username);
    if (!lookup.ok) return { ok: false, error: lookup.error };
    recipientBtcPubkeyHex = lookup.btcPubkeyHex;
  }

  // 2. Generate fresh tip keypair (spend + view + addresses).
  const tipKeys = generateXmrWowTipKeys(asset);

  // 3. Encrypt the spend key.
  const { encryptedKey, claimKeyHash, urlFragmentEncoded } = encryptTipKey({
    keyMaterial: tipKeys.spendKey,
    isPublic: fields.isPublic,
    recipientBtcPubkeyHex,
  });

  // 4. Phase 1 — persist the encrypted key + tip_address + view_key on
  //    the backend BEFORE we broadcast. If the popup closes or the
  //    network fails between here and broadcast (step 6), no on-chain
  //    action has happened — funds are intact. Backend registers LWS
  //    only when we call attach-funding in step 7, so we don't waste
  //    LWS quota on never-funded drafts.
  const draft = await api.createSocialTip({
    ...(fields.isPublic ? {} : { platform: fields.platform, username: fields.username }),
    asset,
    amount: Number(fields.amountAtomic),
    is_public: fields.isPublic,
    encrypted_key: encryptedKey,
    ...(claimKeyHash ? { claim_key_hash: claimKeyHash } : {}),
    tip_address: tipKeys.address,
    tip_view_key: bytesToHex(tipKeys.viewKey),
    // NO funding_txid — backend creates status='draft'.
    sender_anonymous: fields.senderAnonymous,
  });
  if (draft.error || !draft.data) {
    return {
      ok: false,
      error: `Failed to register tip with backend: ${draft.error ?? 'unknown'}. No on-chain action was taken.`,
    };
  }
  const tipId = draft.data.tip_id;

  // 4a. Third-layer backup of the spend key (encrypted with
  //     wallet.keys.btc.privateKey). See tip-key-backup.ts header.
  await storeTipKeyBackup({
    tipId,
    asset,
    tipAddress: tipKeys.address,
    amount: Number(fields.amountAtomic),
    isPublic: fields.isPublic,
    keyMaterial: tipKeys.spendKey,
    btcPrivateKey: wallet.keys.btc.privateKey,
    ...(urlFragmentEncoded ? { urlFragmentEncoded } : {}),
  });

  // 5. (Skipped — `senderUserId` previously used for `api.registerLws`
  //    here; backend now registers LWS as part of the attach-funding
  //    side-effects so we don't double-register. Discard unused arg.)
  void senderUserId;

  // 6. Broadcast funding tx. XMR/WOW path ignores feeRateSatPerVb
  //    (the wasm tx-builder pulls per_byte_fee + fee_mask from LWS
  //    at sign time).
  const sendResult = await send(wallet, {
    fromAssetId: asset,
    amountAtomic: fields.amountAtomic,
    toAddress: tipKeys.address,
    feeRateSatPerVb: 0, // ignored for xmr/wow
    sweep: false,
  });
  if (!sendResult.ok) {
    await api.cancelSocialTip(tipId).catch(() => undefined);
    return { ok: false, error: sendResult.error };
  }

  // 6a. Fire onBroadcast for instant balance feedback. Mirrors v0.2.4's
  //     `addPendingTx` for XMR/WOW — the v0.3 port dropped this and
  //     senders saw zero deduction until LWS reflected the spend
  //     (~1-2 minutes). Fires BEFORE attach-funding so even an
  //     attach-funding failure surfaces the correct sender balance.
  if (onBroadcast) {
    await onBroadcast({
      assetId: asset,
      txid: sendResult.txid,
      amountAtomic: fields.amountAtomic,
      feeAtomic: sendResult.feeAtomic ?? 0n,
      recipient: tipKeys.address,
      tipId,
      ...(sendResult.inputs ? { inputs: sendResult.inputs } : {}),
      ...(sendResult.inputsTotalAtomic !== undefined
        ? { inputsTotalAtomic: sendResult.inputsTotalAtomic }
        : {}),
    });
  }

  // 7. Phase 2 — attach the broadcast txid. Client retries 3x with
  //    exponential backoff; if all retries fail the
  //    funds are on chain and the spend key is in the local backup,
  //    so the asset-detail tip row → Clawback fully recovers.
  const attach = await attachFundingWithRetry(tipId, sendResult.txid);
  if (!attach.ok) {
    return {
      ok: false,
      error: `Funded ${asset} at ${tipKeys.address} (tx ${sendResult.txid}) but couldn't attach funding to backend tip ${tipId} after 3 retries: ${attach.error}. Open this asset on Home → tap the tip to Clawback.`,
    };
  }

  // XMR/WOW need confirmations before the share URL is live; v0.2.4
  // sets requirements per-asset (XMR ≥10, WOW ≥4). Recipient gets the
  // share URL once funding_confirmations ≥ confirmations_required.
  return {
    ok: true,
    tipId,
    shareUrl: fields.isPublic
      ? buildShareUrl(tipId, urlFragmentEncoded, draft.data?.share_url)
      : null,
    // Public tips need to wait for confirmations before the URL is
    // usable from the recipient side (claim flow reads on-chain
    // commitment). Surface as pending so the success screen reads
    // correctly.
    shareUrlPending: fields.isPublic,
  };
}

/**
 * Generate a fresh XMR/WOW primary keypair for a tip. Mirrors v0.2.4's
 * generateXmrWowTipKeys in smirk-extension/src/background/social/crypto.ts.
 *
 * View key is deterministically derived from the spend key
 * (Hs(spend) reduced mod ℓ — Monero standard) so the recipient only
 * needs the spend key to recover both halves.
 */
function generateXmrWowTipKeys(asset: 'xmr' | 'wow'): {
  spendKey: Uint8Array;
  viewKey: Uint8Array;
  publicSpendKey: Uint8Array;
  publicViewKey: Uint8Array;
  address: string;
} {
  const spendSeed = randomBytes(32);
  const spendScalar = bytesToScalar(spendSeed);
  const spendKey = scalarToBytes(spendScalar);

  const viewSeed = sha256(spendKey);
  const viewScalar = bytesToScalar(viewSeed);
  const viewKey = scalarToBytes(viewScalar);

  const publicSpendKey = ed25519.ExtendedPoint.BASE.multiply(spendScalar).toRawBytes();
  const publicViewKey = ed25519.ExtendedPoint.BASE.multiply(viewScalar).toRawBytes();
  const address =
    asset === 'xmr'
      ? xmrAddress(publicSpendKey, publicViewKey)
      : wowAddress(publicSpendKey, publicViewKey);
  return { spendKey, viewKey, publicSpendKey, publicViewKey, address };
}

/** Reduce 32 little-endian bytes to a valid ed25519 scalar (mod ℓ). */
function bytesToScalar(bytes: Uint8Array): bigint {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar += BigInt(bytes[i]!) << BigInt(8 * i);
  }
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  return scalar % L;
}

/** Pack a scalar back to 32 little-endian bytes. */
function scalarToBytes(scalar: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let remaining = scalar;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

// ============================================================================
// Grin (voucher pattern)
// ============================================================================
//
// Sender builds a single-party voucher tx (createGrinVoucher in
// crates/grin-ext/src/voucher.rs, committed 588ee2c). The voucher
// output's secret blinding factor + commitment + range proof + n_child
// + amount + features are JSON-encoded and encrypted to the recipient.
// Claimer decrypts → sweep_grin_voucher → spends the commitment into
// their own keychain non-interactively.

interface GrinVoucherEncryptionData {
  blindingFactor: string;
  commitment: string;
  proof: string;
  nChild: number;
  amount: number;
  features: number;
}

async function createGrinTip(
  wallet: UnlockedWallet,
  senderUserId: string,
  fields: TipSubmitFields,
  deps: { overlay: GrinPendingOverlay; rewindHash: string },
): Promise<TipSubmitOutcome> {
  if (!wallet.mnemonic) {
    return { ok: false, error: 'Wallet not unlocked' };
  }
  void senderUserId; // v3 is non-custodial: scan (rewindHash) identifies outputs.

  // 1. Resolve recipient BTC pubkey for targeted tips.
  let recipientBtcPubkeyHex: string | undefined;
  if (!fields.isPublic) {
    const lookup = await lookupRecipientBtcPubkey(fields.platform, fields.username);
    if (!lookup.ok) return { ok: false, error: lookup.error };
    recipientBtcPubkeyHex = lookup.btcPubkeyHex;
  }

  // 2. Scan for spendable Grin inputs (each already carries its identified BIP32
  //    path) and pick inputs to cover voucher_amount + fee. Same greedy-with-fee
  //    scheme as startGrinSend in grin-flows.ts.
  let spendableSet;
  try {
    spendableSet = await resolveGrinSpendable({
      mnemonic: wallet.mnemonic,
      rewindHash: deps.rewindHash,
      overlay: deps.overlay,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to scan Grin outputs' };
  }
  if (spendableSet.outputs.length === 0) {
    return { ok: false, error: 'No spendable Grin outputs' };
  }
  const sortedDesc = [...spendableSet.outputs].sort((a, b) => b.amount - a.amount);

  const voucherAmount = Number(fields.amountAtomic);
  // Mirrors grin-flows.ts calcGrinFee — `weight × DEFAULT_ACCEPT_FEE_BASE`
  // per `grin_core::core::transaction::TransactionBody::weight`. The
  // previous `BASE × max(1, 4·out − in + kern)` formula produced ~8M
  // nanogrin which the node rejects as "Low fee transaction".
  const calcFee = (numIn: number, numOut: number, numKern: number) =>
    (numIn * 1 + numOut * 21 + Math.max(1, numKern) * 3) * 500_000;

  let selected: typeof sortedDesc = [];
  let totalSelected = 0;
  let fee = 0;
  for (let iter = 0; iter < 10; iter++) {
    // Worst case: 2 outputs (voucher + change), 1 kernel.
    fee = calcFee(selected.length || 1, 2, 1);
    const target = voucherAmount + fee;
    selected = [];
    totalSelected = 0;
    for (const o of sortedDesc) {
      selected.push(o);
      totalSelected += o.amount;
      if (totalSelected >= target) break;
    }
    if (totalSelected < target) {
      // Try a no-change tx if exact-input case fits.
      const noChangeFee = calcFee(selected.length, 1, 1);
      if (totalSelected >= voucherAmount + noChangeFee) {
        fee = noChangeFee;
        break;
      }
      return {
        ok: false,
        error: `Insufficient Grin: have ${totalSelected / 1e9}, need ${
          target / 1e9
        }`,
      };
    }
    break;
  }
  const hasChange = totalSelected - voucherAmount - fee > 0;
  if (hasChange) {
    fee = calcFee(selected.length, 2, 1);
  } else {
    fee = calcFee(selected.length, 1, 1);
  }

  // 3. ATOMICALLY reserve BIP32 child indices for the voucher (+ change) outputs.
  //    Each reserveNextChildIndex() reads-and-increments the persisted counter in
  //    one serialized step, so two concurrent mint flows can never be handed the
  //    same index (reuse = duplicate Pedersen commitment = fund loss). The old
  //    read-now (nextChild) / bump-later pattern raced across the awaits below.
  const voucherChild = await deps.overlay.reserveNextChildIndex();
  const voucherPath: [number, number, number, number] = [0, 0, voucherChild, 0];
  const changeChild = hasChange ? await deps.overlay.reserveNextChildIndex() : undefined;
  const changePath: [number, number, number, number] | undefined =
    changeChild !== undefined ? [0, 0, changeChild, 0] : undefined;
  const changeAmount = hasChange ? totalSelected - voucherAmount - fee : 0;

  // 4. Derive extended private key from mnemonic (v3 + legacy fallback so a
  //    recovered legacy/Grim depth-3 input can be tipped).
  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(wallet.mnemonic)) as {
    extended_private_key_hex: string;
  };
  const legacyExtKeyHex = wasmGrin.deriveExtendedKeyLegacyBip39(wallet.mnemonic);

  // 5. Build the single-party voucher transaction.
  const voucherResult = wasmGrin.createGrinVoucher({
    extended_private_key_hex: extKey.extended_private_key_hex,
    legacy_extended_private_key_hex: legacyExtKeyHex,
    // Inputs already carry their identified BIP32 path from the scan resolver.
    inputs: selected,
    voucher_amount: voucherAmount,
    fee,
    voucher_path: voucherPath,
    ...(changePath && changeAmount > 0
      ? { change: { path: changePath, amount: changeAmount } }
      : {}),
    kernel_offset_hex: wasmGrin.randomSecretNonce(),
    kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
    change_bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    change_bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // 6. Encrypt voucher data (JSON) BEFORE broadcast so the encrypted
  //    payload is durable on the backend before any on-chain action.
  //    The recipient needs ALL of: blinding_factor, commitment, proof,
  //    n_child, amount, features. Without this blob the funds are
  //    unsweepable even by the sender (the blinding factor is the
  //    "spend key" for a Pedersen commitment).
  const voucherData: GrinVoucherEncryptionData = {
    blindingFactor: voucherResult.voucher.blinding_factor_hex,
    commitment: voucherResult.voucher.commitment_hex,
    proof: voucherResult.voucher.proof_hex,
    // path[2] = real BIP32 child; path[3] = padding 0 (see
    // grin-flows.ts companion comment about the bricking bug).
    nChild: voucherResult.voucher.path[2],
    amount: voucherResult.voucher.amount,
    features: 0,
  };
  const voucherDataBytes = new TextEncoder().encode(JSON.stringify(voucherData));
  const { encryptedKey, claimKeyHash, urlFragmentEncoded } = encryptTipKey({
    keyMaterial: voucherDataBytes,
    isPublic: fields.isPublic,
    recipientBtcPubkeyHex,
  });

  // 7. Phase 1 — persist the encrypted voucher data on the backend
  //    BEFORE broadcasting. If any subsequent step fails (broadcast,
  //    attach-funding), the voucher data is safe server-side and the
  //    sender can recover via the asset-detail tip row → Clawback once the funding
  //    is either attached or the draft is cancelled.
  const slateId = randomBytesHexUuidLike(); // voucher txs aren't slate-shaped; backend keys by funding_txid which will be slate_id-compatible
  const draft = await api.createSocialTip({
    ...(fields.isPublic ? {} : { platform: fields.platform, username: fields.username }),
    asset: 'grin',
    amount: voucherAmount,
    is_public: fields.isPublic,
    encrypted_key: encryptedKey,
    ...(claimKeyHash ? { claim_key_hash: claimKeyHash } : {}),
    tip_address: voucherResult.voucher.commitment_hex,
    // NO funding_txid — backend creates status='draft'.
    grin_commitment: voucherResult.voucher.commitment_hex,
    sender_anonymous: fields.senderAnonymous,
  });
  if (draft.error || !draft.data) {
    return {
      ok: false,
      error: `Failed to register voucher with backend: ${draft.error ?? 'unknown'}. No on-chain action was taken.`,
    };
  }
  const tipId = draft.data.tip_id;

  // 7a. Third-layer backup: encrypt the full voucher JSON bundle
  //     (blind + commitment + proof + n_child + amount + features)
  //     with the wallet's BTC key and stash locally. For Grin the
  //     "spend key" is the blinding factor; without all of these
  //     fields the recipient can't sweep, so we store the whole bundle.
  await storeTipKeyBackup({
    tipId,
    asset: 'grin',
    tipAddress: voucherResult.voucher.commitment_hex,
    amount: voucherAmount,
    isPublic: fields.isPublic,
    keyMaterial: voucherDataBytes,
    btcPrivateKey: wallet.keys.btc.privateKey,
    ...(urlFragmentEncoded ? { urlFragmentEncoded } : {}),
  });

  // 8. Broadcast the voucher tx via the backend's broadcast endpoint (reads only
  //    `{ tx }` on v3 — no server output store to record into).
  // Grin node's `/v2/foreign push_transaction` accepts the JSON Transaction body
  // (offset + body{inputs, outputs, kernels}) — NOT a hex-encoded wire blob.
  // `voucherResult.tx_json` is the canonical shape, emitted by
  // `crates/grin-ext/src/voucher.rs::serialize_voucher_tx_json`.
  const broadcast = await chainProviders.grin().broadcast({
    tx: voucherResult.tx_json as object,
  });
  if (broadcast.error) {
    // No overlay entry recorded yet (we add it only after broadcast succeeds),
    // so the inputs are still selectable — just cancel the draft tip.
    await api.cancelSocialTip(tipId).catch(() => undefined);
    return { ok: false, error: `Grin broadcast failed: ${broadcast.error}` };
  }

  // 9. Record the client pending overlay now that the tx is on the wire:
  //    exclude the spent inputs from selection until they're mined, and show the
  //    sender's change as pending until scan confirms it. The voucher output is
  //    outgoing (to the tip recipient) — not our change/incoming — so it isn't
  //    surfaced as pending, but its index was already consumed. The voucher +
  //    change child indices were reserved atomically at step 3 — do NOT bump the
  //    counter again here or it would double-advance and skip indices.
  await deps.overlay.addPending(slateId, {
    spentCommits: selected.map((i) => i.commitment_hex),
    ...(voucherResult.change
      ? { change: { commit: voucherResult.change.commitment_hex, value: voucherResult.change.amount } }
      : {}),
  });

  // Best-effort tx-journal: a tip is an outgoing send. Record it finalized with
  // its on-chain kernel excess (display-only; NEVER gates money).
  void recordGrinTx({
    slateId,
    direction: 'send',
    amountNanogrin: voucherAmount,
    fee,
    counterparty: fields.isPublic ? 'public link' : `@${fields.username}`,
    status: 'finalized',
    kernelExcess: voucherResult.kernel_excess_hex,
    createdAt: Date.now(),
  }).catch(() => undefined);

  // 10. Phase 2 — attach the slate_id (acts as the funding identifier
  //     for Grin since the kernel commit IS the on-chain identity).
  //     Client retries 3x with exponential backoff.
  const attach = await attachFundingWithRetry(tipId, slateId);
  if (!attach.ok) {
    return {
      ok: false,
      error: `Voucher broadcast (slate ${slateId}) but couldn't attach funding to backend tip ${tipId} after 3 retries: ${attach.error}. Open this asset on Home → tap the tip to Clawback.`,
    };
  }

  // Grin needs ~10 confirmations before share URL is live.
  return {
    ok: true,
    tipId,
    shareUrl: fields.isPublic
      ? buildShareUrl(tipId, urlFragmentEncoded, draft.data?.share_url)
      : null,
    shareUrlPending: fields.isPublic,
  };
}

/** Generate a UUID-shaped hex string. Voucher txs need a slate_id for
 *  backend bookkeeping (the tx isn't slate-shaped; the kernel excess
 *  is the on-chain identifier). */
function randomBytesHexUuidLike(): string {
  const bytes = randomBytes(16);
  // Set version (4) and variant bits per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Compose the claim URL for a public tip. The URL fragment carries
 * the symmetric key, which never reaches the server — only the
 * claimer (who has the URL) can decrypt.
 *
 * Format matches the existing claim.smirk.cash landing page that
 * v0.2.4 users have been clicking — keeps cross-version compat.
 */
function buildShareUrl(
  tipId: string,
  urlFragmentEncoded: string | undefined,
  backendShareUrl?: string | null,
): string | null {
  if (!urlFragmentEncoded) return null;
  // The backend already builds this from its own `TIP_SHARE_BASE`
  // (`api/tips.rs` `share_url`) and returns it on the create response. Prefer it:
  // hardcoding smirk.cash meant a self-hosted instance produced links pointing
  // at OUR landing page for a tip only THEIR backend can settle, so the claim
  // simply failed. Fall back to the constant only when the operator has not set
  // a share base, which keeps existing smirk.cash links working.
  if (backendShareUrl) {
    return `${backendShareUrl.replace(/\/$/, '')}#${urlFragmentEncoded}`;
  }
  return `https://smirk.cash/tip/${tipId}#${urlFragmentEncoded}`;
}
