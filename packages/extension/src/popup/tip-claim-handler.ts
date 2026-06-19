/**
 * Receiver-side tip claim handler.
 *
 * Mirror of `tip-handler.ts` (sender side). The flow:
 *
 *   1. Call `api.claimSocialTip(tipId)` — backend marks the tip as
 *      'claiming' and returns the sender's `encrypted_key` + the
 *      `tip_address` to sweep.
 *   2. Decrypt `encrypted_key` with the recipient's BTC private key.
 *      Same ECIES scheme `tip-handler.ts` uses to encrypt — BTC
 *      pubkey is the universal encryption target across all five
 *      assets, because every Smirk wallet has one. (The recipient
 *      might not even have a balance for the tip's asset yet; the
 *      sweep CREATES the first receive.)
 *   3. Per-asset sweep into the recipient's own wallet address:
 *        BTC/LTC — raw-key P2WPKH sweep via @scure/btc-signer
 *        XMR/WOW — RingCT sweep via WASM, using tip's view+spend
 *                  keys to scan + spend the tip-address outputs
 *        Grin    — voucher sweep via WASM (the encrypted payload is
 *                  JSON metadata, not a key)
 *   4. `api.confirmTipSweep(tipId, txid)` — transitions the tip from
 *      'claiming' to 'claimed'. Best-effort — if it fails the funds
 *      are already swept; user just sees the tip stuck in 'claiming'.
 *
 * **Why decryption always uses BTC.** See encryption side in
 * `tip-handler.ts`. Important corollary: a recipient who has never
 * derived their BTC address still has a BTC key in their HD wallet,
 * so claims of any asset work as long as the wallet is unlocked.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { Transaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { hex } from '@scure/base';

import {
  api,
  applyRelayFloor,
  decryptTipPayload,
  decryptPublicTipPayload,
  decodeUrlFragmentKey,
  bytesToHex,
  hexToBytes,
  randomBytes,
  type UnlockedWallet,
} from '@smirk/core';
import {
  grin as wasmGrin,
  monero as wasmMonero,
  type GrinSweepVoucherParams,
} from '@smirk/wasm';
import { decryptTipKeyBackup, getTipKeyBackup } from './tip-key-backup';

/**
 * Unwrap the `{success, data?, error?}` envelope every monero-namespaced
 * wasm function returns. Mirrors `parseWasmResult` in send-handler.ts —
 * the call boundary type is `string` (JSON), the actual payload lives
 * inside `.data`. Direct `JSON.parse(...).toLowerCase()`-style usage
 * blows up because the parsed value is the envelope object, not the
 * inner payload.
 *
 * Throws with the wasm side's error string on `success === false`,
 * which the catch sites surface as the user-visible claim error.
 */
function parseWasmResult<T>(json: string): T {
  const parsed = JSON.parse(json) as { success: boolean; data?: T; error?: string };
  if (!parsed.success) {
    throw new Error(parsed.error ?? 'wasm call returned success=false with no error');
  }
  if (parsed.data === undefined) {
    throw new Error('wasm call returned success=true with no data');
  }
  return parsed.data;
}

export type ClaimAsset = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';

export interface ClaimResult {
  ok: true;
  txid: string;
  /** Which asset was swept. Set by `claimPublicTip` (so the public
   *  paste-link flow can auto-unhide the asset on success) and the
   *  per-asset sweeper helpers. Targeted claims via `claimSocialTip`
   *  already know the asset id from the inbox item; this field is a
   *  best-effort echo for parity. */
  assetId?: ClaimAsset;
  /** Atomic amount swept, in the asset's smallest unit. Optional —
   *  set by `claimPublicTip` so the post-claim toast can show what
   *  the user received without a second fetch. */
  amountAtomic?: bigint;
}
export interface ClaimError {
  ok: false;
  error: string;
}
export type ClaimOutcome = ClaimResult | ClaimError;

/**
 * Top-level orchestrator. Wired to InboxTab's onClaimTip callback —
 * one call per "Claim" tap. The popup adapter is responsible for
 * surfacing the error (or refreshing the balance + inbox on success);
 * this function just runs the steps and reports the outcome.
 */
export async function claimSocialTip(
  wallet: UnlockedWallet,
  userId: string,
  tipId: string,
  asset: ClaimAsset,
): Promise<ClaimOutcome> {
  // Step 1: backend claim — returns encrypted_key + tip_address.
  const claim = await api.claimSocialTip(tipId);
  if (claim.error || !claim.data) {
    return { ok: false, error: claim.error ?? 'Backend rejected claim' };
  }
  const { encrypted_key, tip_address } = claim.data;
  if (!encrypted_key) {
    return { ok: false, error: 'Tip has no encrypted key — cannot decrypt' };
  }
  if (!tip_address) {
    return { ok: false, error: 'Tip has no on-chain address' };
  }

  // Step 2: decrypt the sender's encrypted payload.
  // Wire format: ephemeralPubkey (33-byte compressed secp256k1, 66
  // hex chars) || ciphertext. Mirrors the sender-side packing in
  // tip-handler.ts::encryptTipKey.
  const ephemeralPubkeyHex = encrypted_key.slice(0, 66);
  const ciphertextHex = encrypted_key.slice(66);
  let decrypted: Uint8Array;
  try {
    decrypted = decryptTipPayload(
      ciphertextHex,
      ephemeralPubkeyHex,
      wallet.keys.btc.privateKey,
    );
  } catch (e) {
    return {
      ok: false,
      error: `Decryption failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Step 3: per-asset sweep.
  let sweep: ClaimOutcome;
  try {
    switch (asset) {
      case 'btc':
      case 'ltc':
        sweep = await sweepUtxo(asset, decrypted, tip_address, wallet);
        break;
      case 'xmr':
      case 'wow':
        sweep = await sweepXmrWow(asset, decrypted, tip_address, wallet);
        break;
      case 'grin':
        sweep = await sweepGrin(decrypted, wallet, userId);
        break;
    }
  } catch (e) {
    return {
      ok: false,
      error: `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!sweep.ok) return sweep;

  // Step 4: confirm sweep server-side. Per Finding 3 in the v0.3.0
  // pre-ship audit: 3x exponential backoff so a transient failure
  // doesn't leave the backend stuck at `claiming` while the funds
  // are already moved on-chain. Still don't surface an error on
  // total failure — the on-chain sweep is the source of truth and
  // backend reconciliation can happen later — but log so support
  // can detect the desync if it ever lands in prod. Targeted tips
  // don't race (one recipient), so we ignore the response data.
  void (await confirmSweepWithRetry(tipId, sweep.txid));

  return sweep;
}

/**
 * Backend `confirm_tip_sweep` retry helper. Mirrors
 * `attachFundingWithRetry` in tip-handler.ts. Backend is idempotent
 * (same `(tip_id, sweep_txid)` settles to the same outcome via
 * first-wins race) so repeated attempts are safe.
 *
 * Returns the response data on success so callers (specifically the
 * public-tip race detection) can inspect `sweep_txid` for race
 * resolution. Returns `null` on total failure — funds are already
 * on-chain at that point; caller should not block on this.
 */
async function confirmSweepWithRetry(
  tipId: string,
  sweepTxid: string,
): Promise<{ sweep_txid: string | null; status: string } | null> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]!));
    }
    try {
      const conf = await api.confirmTipSweep(tipId, sweepTxid);
      if (!conf.error && conf.data) return conf.data;
      lastErr = conf.error ?? 'unknown';
      console.warn(
        `[tip-claim] confirmTipSweep attempt ${attempt + 1}/${delays.length} failed: ${lastErr}`,
      );
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(
        `[tip-claim] confirmTipSweep attempt ${attempt + 1}/${delays.length} threw: ${lastErr}`,
      );
    }
  }
  // All retries exhausted. The on-chain sweep already moved funds —
  // backend will reconcile via its own poller or manual cleanup.
  // Surface a console error so support can find it in logs.
  console.error(
    `[tip-claim] confirmTipSweep exhausted retries for tip ${tipId} sweep ${sweepTxid}: ${lastErr}. Funds are on-chain; backend mark is stale.`,
  );
  return null;
}

/**
 * Sender-side clawback. Recovers an unclaimed tip's funds back into
 * the sender's wallet. Mirrors v0.2.4's handleClawbackSocialTip
 * (smirk-extension/src/background/social/clawback.ts).
 *
 * Critical bug context: v0.3 originally implemented clawback as a
 * pure backend status flip (`status='clawed_back'`) with NO on-chain
 * sweep. That left the on-chain funds orphaned at the tip address —
 * marked recovered server-side, actually unrecoverable. Mirrors the
 * v0.2.4 logic: decrypt the locally-stored key material with the
 * wallet's BTC key, sweep the tip's on-chain UTXOs / commitments
 * back into the sender's wallet, THEN mark the backend.
 *
 * Reuses the same per-asset sweepers as the recipient claim flow —
 * for BTC/LTC/XMR/WOW the on-chain action is identical (sweep tip
 * address → wallet), only the destination differs (here = sender,
 * for claim = recipient, but both come from `wallet`).
 *
 * For Grin the local backup contains the full voucher metadata
 * (`commitment + proof + blindingFactor + amount + nChild`); the
 * sweep mints a fresh sender-owned output via the same WASM
 * primitive the recipient uses for a normal claim.
 *
 * Requires the local backup. Tips created on a different device or
 * a wiped install have no local backup → clawback returns an error
 * directing the user to re-import the original seed, since the tip
 * private key is what the backend's `clawback_social_tip` lacks.
 *
 * Note: caller must `removeTipKeyBackup(tipId)` on success — left
 * to the caller so the UI layer controls the local-state lifecycle.
 */
export async function clawbackSocialTip(
  wallet: UnlockedWallet,
  userId: string,
  tipId: string,
): Promise<ClaimOutcome> {
  // 1. Look up the local backup. Without it we can't sweep — the
  //    backend never stored the per-tip private key.
  const backup = await getTipKeyBackup(tipId);
  if (!backup) {
    return {
      ok: false,
      error:
        'No local backup for this tip — can only clawback from the device where it was sent. Re-import the original seed on this device to enable.',
    };
  }

  // 2. Decrypt the stored key material with the wallet's BTC key
  //    (symmetric — see `tip-key-backup.ts::deriveStorageKey`).
  let keyMaterial: Uint8Array;
  try {
    keyMaterial = decryptTipKeyBackup(backup, wallet.keys.btc.privateKey);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to decrypt local backup: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 3. Per-asset sweep. The recipient-claim sweepers already do
  //    exactly the right thing: sweep `backup.tipAddress` into the
  //    `wallet`'s address. The caller IS the sender, so this puts
  //    the funds back where they came from.
  let sweep: ClaimOutcome;
  try {
    switch (backup.asset) {
      case 'btc':
      case 'ltc':
        sweep = await sweepUtxo(
          backup.asset,
          keyMaterial,
          backup.tipAddress,
          wallet,
        );
        break;
      case 'xmr':
      case 'wow':
        sweep = await sweepXmrWow(
          backup.asset,
          keyMaterial,
          backup.tipAddress,
          wallet,
        );
        break;
      case 'grin':
        sweep = await sweepGrin(keyMaterial, wallet, userId);
        break;
    }
  } catch (e) {
    return {
      ok: false,
      error: `Clawback sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!sweep.ok) return sweep;

  // 4. Best-effort: mark the backend as clawed_back. If this fails
  //    the funds are already on-chain back in the wallet — the
  //    failure mode is the row staying as 'pending' server-side;
  //    a subsequent retry of the same clawback would attempt a
  //    re-sweep, see "No UTXOs at tip address", and the user can
  //    confirm via on-chain proof.
  try {
    const r = await api.clawbackSocialTip(tipId);
    if (r.error) {
      console.warn('[clawback] backend mark failed:', r.error);
    }
  } catch (e) {
    console.warn('[clawback] backend mark threw:', e);
  }

  return sweep;
}

/**
 * Claim a public (URL-shared) tip — companion to `claimSocialTip`
 * for the targeted case. The big differences:
 *
 *   - **Tip discovery** is via `getPublicSocialTip(tipId)` (no auth
 *     needed, the URL is the access token) instead of the
 *     authenticated inbox lookup.
 *   - **Decryption** uses the URL fragment key (symmetric AES via
 *     `decryptPublicTipPayload`) instead of recipient-BTC-key ECIES.
 *     The server never sees the fragment key; it lives only in the
 *     URL after `#`.
 *   - **Recipient is the caller**. We sweep to whichever asset the
 *     tip is denominated in on the calling wallet — same `wallet`
 *     argument as the targeted flow.
 *
 * Per-asset sweep + post-confirm steps are identical to the
 * targeted flow (same helpers). Backend `claim_social_tip`
 * idempotency holds for the same claimer too, so retry after a
 * partial-failure works the same way.
 */
export async function claimPublicTip(
  wallet: UnlockedWallet,
  userId: string,
  tipId: string,
  fragmentKeyEncoded: string,
): Promise<ClaimOutcome> {
  // Step 1: fetch tip info (unauthenticated). Confirms the tip
  // exists, exposes asset + tip_address + ciphertext + claimability.
  const info = await api.getPublicSocialTip(tipId);
  if (info.error || !info.data) {
    return { ok: false, error: info.error ?? 'Public tip not found' };
  }
  const t = info.data;
  if (
    t.funding_confirmations < t.confirmations_required ||
    !t.is_claimable
  ) {
    return {
      ok: false,
      error: `Tip not yet claimable — ${t.funding_confirmations}/${t.confirmations_required} confirmations`,
    };
  }
  // The encrypted_key + tip_address on PublicTipInfo are the values
  // a claimer needs; once claimed by the same user the backend
  // returns them again on retries (idempotent UPDATE).
  if (!t.encrypted_key) {
    return { ok: false, error: 'Tip has no encrypted key — already claimed?' };
  }
  if (!t.tip_address) {
    return { ok: false, error: 'Tip has no on-chain address' };
  }

  // Step 2: decrypt with the URL fragment key. Symmetric — no
  // BTC private-key derivation, just the bytes from after the `#`.
  let decrypted: Uint8Array;
  try {
    const fragmentKey = decodeUrlFragmentKey(fragmentKeyEncoded);
    decrypted = decryptPublicTipPayload(t.encrypted_key, fragmentKey);
  } catch (e) {
    return {
      ok: false,
      error: `Decryption failed (wrong fragment key?): ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // Step 3: claim server-side to flip status pending → claiming.
  // Returns the same encrypted_key (we already decrypted it) — we
  // only care that the call succeeds. Same idempotency contract as
  // the targeted flow.
  const claim = await api.claimSocialTip(tipId);
  if (claim.error || !claim.data) {
    return { ok: false, error: claim.error ?? 'Backend rejected claim' };
  }

  // Step 4: per-asset sweep — identical to the targeted flow.
  const asset = t.asset as ClaimAsset;
  let sweep: ClaimOutcome;
  try {
    switch (asset) {
      case 'btc':
      case 'ltc':
        sweep = await sweepUtxo(asset, decrypted, t.tip_address, wallet);
        break;
      case 'xmr':
      case 'wow':
        sweep = await sweepXmrWow(asset, decrypted, t.tip_address, wallet);
        break;
      case 'grin':
        sweep = await sweepGrin(decrypted, wallet, userId);
        break;
    }
  } catch (e) {
    return {
      ok: false,
      error: `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!sweep.ok) return sweep;

  // Step 5: confirm sweep on backend. Best-effort with race detection.
  // Public tips can have multiple URL-holders racing — the backend
  // records the FIRST sweep_txid to confirm and ignores subsequent
  // calls (first-wins idempotency). If the returned sweep_txid
  // doesn't match ours, we lost the race: our tx is in the mempool
  // but another claimer's sweep landed in the row first. Surface
  // that to the caller as a distinct outcome so the UI can render
  // "swept by someone else" instead of generic success.
  // Retry via the shared helper per Finding 3.
  const conf = await confirmSweepWithRetry(tipId, sweep.txid);
  if (conf?.sweep_txid && conf.sweep_txid !== sweep.txid) {
    // Race loser: backend already had a different winning sweep_txid.
    // Our own broadcast may still confirm on-chain (mempool race
    // could flip either way), but the backend's view is decided.
    // Per Finding 10 in the v0.3.0 pre-ship audit: the loser's
    // broadcast is already in the mempool — if it wins the
    // network-level race (RBF, miner preference, our tx happens to
    // be in a more profitable block), the funds STILL arrive in
    // their wallet via the normal balance scan. The backend
    // accounting just shows the tip as claimed by someone else.
    // No fund loss either way, so the messaging should reflect
    // that nuance instead of implying a hard failure.
    console.warn(
      '[tip-claim public] race lost — backend winning sweep_txid =',
      conf.sweep_txid,
      'ours =',
      sweep.txid,
      'mempool race may still resolve in our favour',
    );
    return {
      ok: false,
      error:
        'Someone else claimed this tip first on the backend. Your sweep tx is still in the mempool — if it wins the on-chain race the funds will arrive in your wallet on the next refresh. No action needed.',
    };
  }

  // Echo asset id + amount on the success result so the calling
  // screen can render "Claimed N BTC" without a second tip lookup.
  return {
    ok: true,
    txid: sweep.txid,
    assetId: asset,
    amountAtomic: BigInt(t.amount),
  } satisfies ClaimResult;
}

/**
 * Parse a Smirk public-tip URL (`https://smirk.cash/tip/<id>#<fragment>`)
 * into its tipId + fragmentKey components. Tolerates trailing slashes
 * and a leading `@`/spaces from clipboard paste. Returns `null` if
 * the input doesn't look like a Smirk tip URL.
 *
 * The fragment is returned as the raw base64url-encoded string; the
 * caller passes it straight to `claimPublicTip` which decodes via
 * `decodeUrlFragmentKey`.
 */
export function parseShareUrl(
  raw: string,
): { tipId: string; fragmentKey: string } | null {
  const trimmed = raw.trim().replace(/^@+/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Match `/tip/<uuid>` or `/tip/<uuid>/` — keep the host check
  // restrictive. Production accepts smirk.cash + such.software
  // staging only. `localhost` is allowed in dev builds so the local
  // claim page works during testing; gating prevents a malicious
  // localhost page from posing as a Smirk claim URL on a release
  // build.
  const host = url.hostname.toLowerCase();
  const allowLocalhost = import.meta.env.DEV === true;
  const okHost =
    host === 'smirk.cash' ||
    host.endsWith('.smirk.cash') ||
    host.endsWith('.such.software') ||
    (allowLocalhost && host === 'localhost');
  if (!okHost) return null;
  const match = url.pathname.match(/^\/tip\/([A-Za-z0-9-]+)\/?$/);
  if (!match || !match[1]) return null;
  const fragment = url.hash.replace(/^#/, '');
  if (!fragment) return null;
  return { tipId: match[1], fragmentKey: fragment };
}

// ============================================================================
// BTC / LTC sweep
// ============================================================================

/**
 * Raw-key P2WPKH sweep. `tipPrivateKey` controls a single P2WPKH
 * address (the tip address); we fetch every UTXO at that address
 * and pack them into one 1-output tx to the recipient's own
 * receive address. Fee comes out of the swept amount.
 *
 * **Why @scure/btc-signer instead of the WASM signer.** The WASM
 * builder/signer is HD-aware and takes a mnemonic + BIP32 path; the
 * tip key isn't HD-derived (it's a fresh ephemeral keypair created
 * per-tip by the sender). Pure-JS signing here keeps the call site
 * honest about what the input is.
 */
async function sweepUtxo(
  asset: 'btc' | 'ltc',
  tipPrivateKey: Uint8Array,
  tipAddress: string,
  wallet: UnlockedWallet,
): Promise<ClaimOutcome> {
  const recipientAddress = wallet.addresses[asset];
  if (!recipientAddress) {
    return { ok: false, error: `No ${asset.toUpperCase()} address in wallet` };
  }

  const utxosResp = await api.getUtxos(asset, tipAddress);
  if (utxosResp.error || !utxosResp.data) {
    return {
      ok: false,
      error: utxosResp.error ?? 'Failed to fetch UTXOs at tip address',
    };
  }
  const utxos = utxosResp.data.utxos;
  if (utxos.length === 0) {
    return {
      ok: false,
      error: 'No UTXOs at tip address — may already be claimed',
    };
  }

  // Fee estimate. Use the same `normal` tier the send-handler uses.
  // For a sweep we can size the tx exactly: 1 P2WPKH input vsize ≈
  // 68 vB, 1 output ≈ 31 vB, base overhead ≈ 11 vB → ~110 vB per
  // input + 31 vB header + output for any input count.
  const feeRates = await api.estimateFee(asset);
  // Clamp to the relay floor — an at-floor estimate (1.0 sat/vB) would
  // make the sweep tx "rejected by network rules" (same bug that broke
  // tip funding). See applyRelayFloor.
  const feeRate = applyRelayFloor(feeRates.data?.normal ?? 10);
  const estimatedVsize = 11 + 68 * utxos.length + 31;
  const feeSat = Math.max(
    Math.ceil(estimatedVsize * feeRate) + 1, // +1 to clear minrelaytxfee rounding
    estimatedVsize, // floor of 1 sat/vB
  );

  const totalSat = utxos.reduce((s, u) => s + u.value, 0);
  const sweepSat = totalSat - feeSat;
  if (sweepSat <= 0) {
    return {
      ok: false,
      error: `Sweep impossible: total ${totalSat} sat ≤ fee ${feeSat} sat at ${feeRate} sat/vB`,
    };
  }
  // 546 sat P2WPKH dust threshold (per bitcoin core). Below this the
  // tx is policy-invalid and broadcast will reject.
  if (sweepSat < 546) {
    return { ok: false, error: `Sweep amount ${sweepSat} below dust threshold (546)` };
  }

  const pubKey = secp256k1.getPublicKey(tipPrivateKey, true);
  const network = asset === 'btc' ? NETWORK : LTC_NETWORK;
  const payment = p2wpkh(pubKey, network);

  const tx = new Transaction();
  for (const utxo of utxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) },
    });
  }
  tx.addOutputAddress(recipientAddress, BigInt(sweepSat), network);
  tx.sign(tipPrivateKey);
  tx.finalize();

  const txHex = hex.encode(tx.extract());
  const broadcast = await api.broadcastTx(asset, txHex);
  if (broadcast.error || !broadcast.data) {
    return {
      ok: false,
      error: `Broadcast failed: ${broadcast.error ?? 'unknown'}`,
    };
  }
  return { ok: true, txid: broadcast.data.txid };
}

// @scure/btc-signer ships NETWORK = bitcoin mainnet. Litecoin needs
// its own network struct — values from grsbit / litecoin-core.
const LTC_NETWORK = {
  bech32: 'ltc',
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

// ============================================================================
// XMR / WOW sweep
// ============================================================================

/**
 * Sweep a CryptoNote tip. The decrypted payload is the tip's 32-byte
 * private spend key. We derive the matching view key (Smirk
 * convention: view = sha256(spend) — see sender side in
 * `tip-handler.ts::generateXmrWowTipKeys`), scan the tip address
 * for unspent outputs via LWS, then build + sign a RingCT sweep with
 * the WASM signer.
 *
 * Recipient address is the user's own wallet receive address for
 * the asset. The protocol-required 2nd output (RingCT minimum) goes
 * back to the tip address as zero-value padding — fine, the tip
 * address has no further use after this sweep.
 */
async function sweepXmrWow(
  asset: 'xmr' | 'wow',
  tipSpendKey: Uint8Array,
  tipAddress: string,
  wallet: UnlockedWallet,
): Promise<ClaimOutcome> {
  const recipientAddress = wallet.addresses[asset];
  if (!recipientAddress) {
    return { ok: false, error: `No ${asset.toUpperCase()} address in wallet` };
  }

  // Smirk's tip view key derivation. Matches sender side exactly so
  // the LWS-registered tip address is the same one we now scan.
  const tipViewKey = deriveViewKeyFromSpendKey(tipSpendKey);
  const viewKeyHex = bytesToHex(tipViewKey);
  const spendKeyHex = bytesToHex(tipSpendKey);

  // Fetch unspent outputs from LWS at the tip address.
  const unspentResp = await api.getUnspentOuts(asset, tipAddress, viewKeyHex);
  if (unspentResp.error || !unspentResp.data) {
    return {
      ok: false,
      error: unspentResp.error ?? 'Failed to fetch tip-address outputs',
    };
  }
  const { outputs, per_byte_fee, fee_mask } = unspentResp.data;
  if (outputs.length === 0) {
    return {
      ok: false,
      error: 'No unspent outputs at tip address — may already be claimed',
    };
  }

  // Filter out outputs LWS already flags as spent against the tip's
  // spend key (defensive — a retry of a partial claim could see
  // outputs the server has already noticed got spent).
  type Out = (typeof outputs)[number];
  const spendable: Out[] = [];
  let skippedDueToComputeError = 0;
  for (const out of outputs) {
    let ki: string;
    try {
      const kiJson = wasmMonero.computeKeyImage(
        viewKeyHex,
        spendKeyHex,
        out.tx_pub_key,
        out.index,
      );
      ki = parseWasmResult<string>(kiJson).toLowerCase();
    } catch (e) {
      console.warn('[tip-claim xmr/wow] key-image compute failed; skipping output', e);
      skippedDueToComputeError += 1;
      continue;
    }
    const alreadySpent = out.spend_key_images.some(
      (s) => s.toLowerCase() === ki,
    );
    if (!alreadySpent) spendable.push(out);
  }
  if (spendable.length === 0) {
    // Distinguish "every output threw on key-image compute" (real
    // bug) from "every output was actually spent" (benign retry).
    // Earlier these collapsed into the same misleading "already
    // spent" message even when the actual cause was a wasm-shape
    // mismatch — wasted debug cycles on a non-existent on-chain
    // issue.
    if (skippedDueToComputeError > 0 && skippedDueToComputeError === outputs.length) {
      return {
        ok: false,
        error: `Key-image compute failed for all ${outputs.length} tip outputs — see console for details`,
      };
    }
    return {
      ok: false,
      error: 'All tip outputs already spent on-chain — nothing to sweep',
    };
  }

  // Sweep: all inputs → recipient. RingCT minimum 2 outputs, so a
  // zero-value padding output to the tip address comes for free
  // from the signer.
  const total = spendable.reduce((s, o) => s + BigInt(o.amount), 0n);
  const feePerByteBig = BigInt(per_byte_fee);
  const feeMaskBig = BigInt(fee_mask);
  const feeJson = wasmMonero.estimateFee(spendable.length, 2, feePerByteBig, feeMaskBig);
  const feeAtomic = BigInt(parseWasmResult<number>(feeJson));
  if (total <= feeAtomic) {
    return {
      ok: false,
      error: `Sweep impossible: total ${total} ≤ fee ${feeAtomic}`,
    };
  }
  const sweepAmount = total - feeAtomic;

  // Decoy fetch — ring-size − 1 per input. WOW ringSize=22, XMR=16.
  const ringSize = asset === 'wow' ? 22 : 16;
  const decoysNeeded = (ringSize - 1) * spendable.length;
  const decoysResp = await api.getRandomOuts(asset, decoysNeeded);
  if (decoysResp.error || !decoysResp.data) {
    return {
      ok: false,
      error: decoysResp.error ?? 'Failed to fetch decoys',
    };
  }
  const decoyPool = decoysResp.data.outputs;
  if (decoyPool.length < decoysNeeded) {
    return {
      ok: false,
      error: `LWS returned ${decoyPool.length} decoys, expected ${decoysNeeded}`,
    };
  }

  const inputs = spendable.map((out, i) => ({
    output: {
      amount: out.amount,
      public_key: out.public_key,
      tx_pub_key: out.tx_pub_key,
      index: out.index,
      global_index: out.global_index,
      height: out.height,
      rct: out.rct,
    },
    decoys: decoyPool.slice(i * (ringSize - 1), (i + 1) * (ringSize - 1)),
  }));
  const sweepAmountNum = Number(sweepAmount);

  const params = {
    inputs,
    destinations: [{ address: recipientAddress, amount: sweepAmountNum }],
    change_address: tipAddress, // padding output goes back to tip addr
    fee_per_byte: per_byte_fee,
    fee_mask,
    view_key: viewKeyHex,
    spend_key: spendKeyHex,
    network: 'mainnet',
    coin: asset,
  };

  let signed: { tx_hex: string; tx_hash: string; fee: number };
  try {
    const signedJson = wasmMonero.signTransaction(JSON.stringify(params));
    signed = parseWasmResult<{ tx_hex: string; tx_hash: string; fee: number }>(signedJson);
  } catch (e) {
    return {
      ok: false,
      error: `Sign failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const submit = await api.submitLwsTx(
    asset,
    signed.tx_hex,
    recipientAddress,
    sweepAmountNum,
    signed.tx_hash,
  );
  if (submit.error || !submit.data) {
    return {
      ok: false,
      error: `Broadcast failed: ${submit.error ?? 'unknown'}`,
    };
  }

  // Best-effort LWS cleanup — deactivate the tip address now that
  // it'll never receive again. Server resource hygiene, not safety.
  api.deactivateLws(asset, tipAddress).catch((e) => {
    console.warn('[tip-claim xmr/wow] deactivateLws failed', e);
  });

  return { ok: true, txid: signed.tx_hash };
}

/**
 * Derive the tip's private VIEW key from its private SPEND key.
 *
 * Smirk uses `view = scalar_reduce(sha256(spend))` — the SHA-256
 * output is interpreted as a little-endian 256-bit integer and
 * reduced mod the ed25519 group order `ℓ`. The reduced scalar is
 * re-serialized as 32 LE bytes; that's what the sender registers
 * with the LWS daemon at tip-create time (see
 * `tip-handler.ts::generateXmrWowTipKeys`).
 *
 * **Bug repro before this:** earlier this fn just returned
 * `sha256(spend)` unreduced. For sha256 outputs that happen to
 * exceed `ℓ` (~12% of random keys) the unreduced bytes don't match
 * what the daemon has stored, and `get_unspent_outs` 500s instead
 * of returning the tip's UTXO set — leaving recipients unable to
 * claim. Empirically reproduced on two consecutive WOW tips that
 * both had `sha256(spend) > ℓ`.
 */
function deriveViewKeyFromSpendKey(spendKey: Uint8Array): Uint8Array {
  return scalarToBytes(bytesToScalar(sha256(spendKey)));
}

// ed25519 group order ℓ = 2^252 + 27742317777372353535851937790883648493.
// Same constant as @smirk/core/hd.ts (kept private there); inlined
// here so this file stays self-contained for the claim primitive.
const ED25519_GROUP_ORDER =
  2n ** 252n + 27742317777372353535851937790883648493n;

/** 32 little-endian bytes → bigint, reduced mod ℓ. */
function bytesToScalar(bytes: Uint8Array): bigint {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar += BigInt(bytes[i]!) << BigInt(8 * i);
  }
  return scalar % ED25519_GROUP_ORDER;
}

/** bigint → 32 little-endian bytes. */
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
// Grin sweep
// ============================================================================

/**
 * Wire format the sender writes when encrypting a Grin tip — see
 * `tip-handler.ts::GrinVoucherEncryptionData`. Field names MUST
 * match the sender exactly: the JSON is read straight out of the
 * encrypted payload, no normalization. A name mismatch surfaces as
 * "Grin voucher payload is missing required fields" and looks like
 * a corrupted-tip error.
 *
 * `nChild` is the sender's path index for the voucher output and
 * is unused by the receiver (we mint into our OWN next-free child
 * index). Kept in the type for completeness so future code can
 * cross-reference if needed.
 */
interface GrinVoucherPayload {
  blindingFactor: string;
  commitment: string;
  proof: string;
  nChild: number;
  amount: number;
  features: number;
}

/**
 * Sweep a Grin voucher into the recipient's own keychain. Unlike
 * BTC/LTC/XMR/WOW, the decrypted payload is NOT a private key —
 * it's a JSON blob describing a voucher output the sender created
 * (commitment, blinding factor, range-proof, amount). We import that
 * output via `grin.sweepGrinVoucher`, which builds a 1-input /
 * 1-output kernel where the new output is at the recipient's next
 * free Grin path. The wasm result carries both `tx_bytes_hex` (binary
 * wire format) AND `tx_json` (the JSON shape the broadcast endpoint
 * accepts) — we forward the latter to the backend unchanged.
 */
async function sweepGrin(
  decryptedJson: Uint8Array,
  wallet: UnlockedWallet,
  userId: string,
): Promise<ClaimOutcome> {
  let voucher: GrinVoucherPayload;
  try {
    voucher = JSON.parse(new TextDecoder().decode(decryptedJson)) as GrinVoucherPayload;
  } catch (e) {
    return {
      ok: false,
      error: `Failed to parse Grin voucher payload: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!voucher.commitment || !voucher.blindingFactor || !voucher.amount) {
    return { ok: false, error: 'Grin voucher payload is missing required fields' };
  }

  if (!wallet.mnemonic) {
    return { ok: false, error: 'Mnemonic unavailable — cannot derive Grin key' };
  }
  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(wallet.mnemonic)) as {
    extended_private_key_hex: string;
  };

  // Next free child index lives in grin_outputs; the new output we
  // mint via the sweep occupies that slot. Backend's atomic
  // broadcast records the change row in the same call so a partial
  // failure doesn't leak an unspendable output.
  const grinOutputs = await api.getGrinOutputs(userId);
  if (grinOutputs.error || !grinOutputs.data) {
    return {
      ok: false,
      error: grinOutputs.error ?? 'Failed to fetch Grin output index',
    };
  }
  const nextChild = grinOutputs.data.next_child_index;
  const claimerPath: [number, number, number, number] = [0, 0, nextChild, 0];

  // Grin v5.x fee policy: `(numIn + 21·numOut + 3·numKern) × 500_000`
  // per `grin_core::core::transaction::TransactionBody::weight`. A
  // voucher sweep is always 1 input, 1 output, 1 kernel:
  //   (1 + 21·1 + 3·1) × 500_000 = 12_500_000 nanogrin
  // Earlier this was hard-coded to 4_000_000 (the deprecated
  // legacy formula) — node rejects with "Low fee transaction".
  // Mirrors `tip-handler.ts::createGrinTip::calcFee` and
  // `grin-flows.ts::calcGrinFee`.
  const fee = (1 + 21 * 1 + 3 * 1) * 500_000;
  if (voucher.amount <= fee) {
    return {
      ok: false,
      error: `Voucher amount ${voucher.amount} ≤ fee ${fee} — nothing to sweep`,
    };
  }

  const sweepParams: GrinSweepVoucherParams = {
    extended_private_key_hex: extKey.extended_private_key_hex,
    voucher_commitment_hex: voucher.commitment,
    voucher_blind_hex: voucher.blindingFactor,
    voucher_amount: voucher.amount,
    ...(voucher.features !== undefined ? { voucher_features: voucher.features } : {}),
    claimer_path: claimerPath,
    fee,
    kernel_offset_hex: wasmGrin.randomSecretNonce(),
    kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  };

  let result;
  try {
    result = wasmGrin.sweepGrinVoucher(sweepParams);
  } catch (e) {
    return {
      ok: false,
      error: `Grin sweep build failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // `slate_id` MUST be a valid UUID — the backend's broadcast
  // handler parses it as `uuid::Uuid::parse()` and rejects anything
  // else with VALIDATION_ERROR. Voucher sweeps don't have a real
  // slate ceremony, so we mint a fresh v4 UUID for backend
  // bookkeeping. The matching `grin_transactions` row doesn't exist
  // (recipient never called recordGrinTransaction) so the backend's
  // status UPDATE is a no-op — the broadcast itself + the
  // changeOutput INSERT still run, which is all we need.
  //
  // (Earlier this passed `kernel_excess_hex` which is a 66-char hex
  // string — never parses as UUID — and every Grin claim 500'd at
  // the validation gate.)
  const broadcast = await api.broadcastGrinTransaction({
    userId,
    slateId: uuidV4(),
    // wasm tx_json is typed `unknown` because the JSON.parse boundary
    // doesn't carry a schema. The wasm side always emits a JSON object
    // (Transaction body) — see GrinSweepVoucherResult.tx_json docstring
    // and serialize_voucher_tx_json in crates/grin-ext/src/voucher.rs.
    tx: result.tx_json as object,
    changeOutput: {
      keyId: pathToKeyId(claimerPath),
      nChild: nextChild,
      amount: voucher.amount - fee,
      commitment: result.output.commitment_hex,
    },
  });
  if (broadcast.error || !broadcast.data) {
    return {
      ok: false,
      error: `Grin broadcast failed: ${broadcast.error ?? 'unknown'}`,
    };
  }

  // Use the kernel excess as the txid for UI display — Grin txs
  // don't have stable txids the way UTXO chains do, but the kernel
  // excess is unique per kernel and is what the explorer indexes on
  // (e.g., https://grincoin.org/kernel/<excess>).
  return { ok: true, txid: result.kernel_excess_hex };
}

/** Mint an RFC 4122 v4 UUID. Mirrors `randomBytesHexUuidLike` in
 *  tip-handler.ts — the backend's `broadcast_grin_transaction`
 *  parses `slate_id` as `uuid::Uuid` and rejects anything else. */
function uuidV4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pack a Grin 4-level path into the 17-byte key_id wire format the
 *  backend stores. Matches `pathToKeyId` in grin-flows.ts. */
function pathToKeyId(path: [number, number, number, number]): string {
  const out = new Uint8Array(17);
  out[0] = 4;
  const view = new DataView(out.buffer);
  view.setUint32(1, path[0], false);
  view.setUint32(5, path[1], false);
  view.setUint32(9, path[2], false);
  view.setUint32(13, path[3], false);
  return bytesToHex(out);
}

// silence unused-import warning for hexToBytes — kept for parity with
// the sender's tip-handler, future-proofing for additional decryption
// paths (e.g. a hex-encoded view key in some future asset).
void hexToBytes;
