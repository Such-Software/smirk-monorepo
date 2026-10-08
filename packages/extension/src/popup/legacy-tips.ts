/**
 * Claiming tips held by the old Smirk server (v0.2.x).
 *
 * Tips sent from v0.2.x wallets live only in the old backend
 * (`backend.smirk.cash`, database `smirk_db`). v0.3 never asks it, so those tips
 * could not be claimed from v0.3 at all, and a claim that a v0.2.x wallet
 * started but never finished stayed "claiming" forever.
 *
 * The old server's contract (smirk-backend `src/api/social.rs`):
 *  - `POST /auth/extension` signs in with the BTC key it knew (`m/44'`),
 *    by a BIP-137 signature over `smirk-auth-{timestamp}`;
 *  - `GET  /tips/social/received` lists tips sent to that account;
 *  - `GET  /tips/social/{id}/public` describes a public (link) tip, no sign-in;
 *  - `POST /tips/social/{id}/claim` marks it claiming (repeatable for the same
 *    claimer) and returns the sealed key and tip address;
 *  - `POST /tips/social/{id}/confirm-sweep {sweep_txid}` records the sweep; the
 *    server's reconciler settles it to "claimed" once the sweep confirms.
 *
 * SIGN-IN SAFETY: the old server rotates an account's key when a request
 * carries a known seed fingerprint with a different key. We never send the
 * fingerprint, and we sign in with exactly the old `m/44'` key, so the request
 * can only match the account that key already owns. A seed with no old account
 * would create an empty one there, so for targeted tips (which need the
 * recipient's own account) a brand-new account is treated as "no old account".
 *
 * Sealed keys: a link tip is opened with the key in the link's `#fragment`; a
 * targeted tip was sealed to the recipient's BTC key at the time, the `m/44'`
 * key (pre-envelope ECIES).
 */

import {
  bytesToHex,
  decodeUrlFragmentKey,
  decryptPublicTipPayload,
  decryptTipPayload,
  hexToBytes,
  isTipEnvelope,
  legacyBtcLtcKey,
  signBitcoinMessage,
  type UnlockedWallet,
} from '@smirk/core';
import { nativeFetch } from './native-fetch';
import { assertOperationSession, authorizeOperation } from './operation-auth';
import {
  deriveTipViewKey,
  sweepCryptonoteKeys,
  sweepUtxoKey,
  type ClaimAsset,
  type ClaimOutcome,
  type SweepOutcome,
} from './tip-claim-handler';
import { journalKeyFor, recordSend } from './send-journal';

/** The old Smirk server. v0.2.x existed only on smirk.cash. */
export const LEGACY_API_BASE = 'https://backend.smirk.cash/api/v1';

export interface LegacyTip {
  id: string;
  asset: ClaimAsset;
  amountAtomic: bigint;
  status: string;
  createdAt: string;
  isPublic: boolean;
  senderLabel: string;
  fundingConfirmations: number;
  confirmationsRequired: number;
  isClaimable: boolean;
}

type Resp<T> = { data?: T; error?: string; status?: number };

/** A fetch for the old server: the desktop shell's CORS-free fetch when present. */
export function legacyFetcher(): typeof fetch {
  return nativeFetch() ?? fetch.bind(globalThis);
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
  fetchImpl: typeof fetch = legacyFetcher(),
): Promise<Resp<T>> {
  try {
    const res = await fetchImpl(`${LEGACY_API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const msg =
        (json as { error?: string; message?: string } | undefined)?.error ??
        (json as { message?: string } | undefined)?.message ??
        `HTTP ${res.status}`;
      return { error: msg, status: res.status };
    }
    return { data: json as T, status: res.status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The old Smirk server could not be reached.' };
  }
}

export interface LegacySession {
  token: string;
  userId: string;
  isNew: boolean;
}

/**
 * Sign in to the old server with the seed's `m/44'` BTC key. Needs the phrase.
 * Never sends the seed fingerprint (see the header), so it cannot re-key an
 * account.
 */
export async function legacySignIn(
  wallet: UnlockedWallet,
  fetchImpl?: typeof fetch,
  nowMs: number = Date.now(),
): Promise<Resp<LegacySession>> {
  if (!wallet.mnemonic) {
    return { error: 'Unlock Smirk with your password first: the old server needs your older key, which comes from your recovery phrase.' };
  }
  const key = legacyBtcLtcKey(wallet.mnemonic, 'btc');
  try {
    const ts = Math.floor(nowMs / 1000);
    const r = await request<{
      access_token: string;
      user: { id: string; is_new: boolean };
    }>(
      '/auth/extension',
      {
        method: 'POST',
        body: {
          keys: [{ asset: 'btc', public_key: bytesToHex(key.publicKey) }],
          signed_timestamp: ts,
          signature: signBitcoinMessage(`smirk-auth-${ts}`, key.privateKey),
        },
      },
      fetchImpl,
    );
    if (r.error || !r.data?.access_token) return { error: r.error ?? 'The old server did not sign you in.' };
    return { data: { token: r.data.access_token, userId: r.data.user.id, isNew: r.data.user.is_new } };
  } finally {
    key.privateKey.fill(0);
  }
}

const CLAIMABLE_ASSETS = new Set(['btc', 'ltc', 'xmr', 'wow']);

/**
 * Tips sent to this seed's old account that are still waiting: pending, or a
 * claim that was started and never finished. Grin tips are listed but cannot be
 * claimed here (see `claimLegacyTip`).
 */
export async function listLegacyTips(
  wallet: UnlockedWallet,
  fetchImpl?: typeof fetch,
): Promise<Resp<LegacyTip[]>> {
  const session = await legacySignIn(wallet, fetchImpl);
  if (session.error || !session.data) return { error: session.error ?? 'Sign-in failed' };
  if (session.data.isNew) return { data: [] };
  const r = await request<{ tips: Array<Record<string, unknown>> }>(
    '/tips/social/received',
    { token: session.data.token },
    fetchImpl,
  );
  if (r.error || !r.data) return { error: r.error ?? 'Could not list tips' };
  const tips = r.data.tips
    .filter((t) => t.status === 'pending' || t.status === 'claiming')
    .map(
      (t): LegacyTip => ({
        id: String(t.id),
        asset: String(t.asset) as ClaimAsset,
        amountAtomic: BigInt(String(t.amount ?? 0)),
        status: String(t.status),
        createdAt: String(t.created_at ?? ''),
        isPublic: t.is_public === true,
        senderLabel: t.sender_anonymous
          ? 'anonymous'
          : typeof t.sender_username === 'string' && t.sender_username
            ? `@${t.sender_username}`
            : 'a Smirk user',
        fundingConfirmations: Number(t.funding_confirmations ?? 0),
        confirmationsRequired: Number(t.confirmations_required ?? 0),
        isClaimable: t.is_claimable === true,
      }),
    );
  return { data: tips };
}

/** Open a sealed tip key: link tips with the fragment, targeted tips with the old BTC key. */
export function openLegacyTipKey(
  encryptedKeyHex: string,
  wallet: UnlockedWallet,
  fragmentKey?: string,
): Uint8Array {
  if (fragmentKey) return decryptPublicTipPayload(encryptedKeyHex, decodeUrlFragmentKey(fragmentKey));
  if (isTipEnvelope(hexToBytes(encryptedKeyHex))) {
    throw new Error('This tip was sealed by a newer wallet; claim it from the Inbox instead.');
  }
  if (!wallet.mnemonic) throw new Error('Unlock Smirk with your password first.');
  const key = legacyBtcLtcKey(wallet.mnemonic, 'btc');
  try {
    return decryptTipPayload(encryptedKeyHex.slice(66), encryptedKeyHex.slice(0, 66), key.privateKey);
  } finally {
    key.privateKey.fill(0);
  }
}

async function sweepTip(
  asset: ClaimAsset,
  tipKey: Uint8Array,
  tipAddress: string,
  wallet: UnlockedWallet,
): Promise<SweepOutcome> {
  switch (asset) {
    case 'btc':
    case 'ltc':
      return sweepUtxoKey(asset, tipKey, tipAddress, wallet);
    case 'xmr':
    case 'wow':
      return sweepCryptonoteKeys(asset, tipKey, deriveTipViewKey(tipKey), tipAddress, wallet);
    default:
      return { ok: false, error: 'Grin tips from the old server cannot be claimed in this version of Smirk.' };
  }
}

async function confirmLegacySweep(
  tipId: string,
  txid: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  for (const delay of [0, 1_000, 3_000, 9_000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const r = await request(`/tips/social/${encodeURIComponent(tipId)}/confirm-sweep`, {
      method: 'POST',
      body: { sweep_txid: txid },
      token,
    }, fetchImpl);
    if (!r.error) return true;
  }
  console.error(`[legacy-tip] confirm-sweep failed for ${tipId}; the sweep is on chain, the old server's record is stale.`);
  return false;
}

/**
 * Claim one tip held by the old server into this wallet.
 *
 * For a link tip pass `fragmentKey` (from the share link). The claim is
 * recorded on the old server when it signs us in; if it cannot, the sweep
 * still goes through (the money is the point) and the old record stays stale.
 * A stuck "claiming" tip is finished by calling this again.
 */
export async function claimLegacyTip(
  wallet: UnlockedWallet,
  tipId: string,
  opts: { fragmentKey?: string; fetchImpl?: typeof fetch; alreadyAuthorized?: boolean } = {},
): Promise<ClaimOutcome> {
  if (!opts.alreadyAuthorized) {
    try {
      await authorizeOperation('send', wallet, 'Claim this tip into your wallet');
    } catch (failure) {
      return { ok: false, error: failure instanceof Error ? failure.message : 'Password confirmation failed.' };
    }
  }
  const isLink = !!opts.fragmentKey;

  const session = await legacySignIn(wallet, opts.fetchImpl);
  const token = session.data && (isLink || !session.data.isNew) ? session.data.token : undefined;
  if (!isLink && !token) {
    return { ok: false, error: session.error ?? 'This wallet has no account on the old Smirk server.' };
  }

  // Sealed key + tip address: from the claim when signed in, else (link tips
  // only) from the public description.
  let encryptedKey: string | undefined;
  let tipAddress: string | undefined;
  let asset: string | undefined;
  let amount: bigint | undefined;
  if (isLink) {
    const pub = await request<{
      asset: string;
      amount: number;
      encrypted_key?: string | null;
      tip_address?: string | null;
      is_claimable: boolean;
      funding_confirmations: number;
      confirmations_required: number;
    }>(`/tips/social/${encodeURIComponent(tipId)}/public`, {}, opts.fetchImpl);
    if (pub.error || !pub.data) return { ok: false, error: pub.error ?? 'Tip not found on the old server.' };
    if (!pub.data.is_claimable) {
      return {
        ok: false,
        error: `This tip is not claimable yet (${pub.data.funding_confirmations}/${pub.data.confirmations_required} confirmations), or it was already claimed.`,
      };
    }
    encryptedKey = pub.data.encrypted_key ?? undefined;
    tipAddress = pub.data.tip_address ?? undefined;
    asset = pub.data.asset;
    amount = BigInt(pub.data.amount);
  }
  if (token) {
    const claim = await request<{ encrypted_key?: string | null; tip_address?: string | null }>(
      `/tips/social/${encodeURIComponent(tipId)}/claim`,
      { method: 'POST', token },
      opts.fetchImpl,
    );
    if (claim.data) {
      encryptedKey = claim.data.encrypted_key ?? encryptedKey;
      tipAddress = claim.data.tip_address ?? tipAddress;
    } else if (!isLink) {
      return { ok: false, error: claim.error ?? 'The old server refused the claim.' };
    }
  }
  if (!asset) {
    const detail = await request<{ asset: string; amount: number }>(
      `/tips/social/${encodeURIComponent(tipId)}`,
      { token: token! },
      opts.fetchImpl,
    );
    asset = detail.data?.asset;
    amount = detail.data ? BigInt(detail.data.amount) : undefined;
  }
  if (!encryptedKey || !tipAddress || !asset) {
    return { ok: false, error: 'The old server did not return this tip\'s key and address.' };
  }
  if (!CLAIMABLE_ASSETS.has(asset)) {
    return { ok: false, error: 'Grin tips from the old server cannot be claimed in this version of Smirk.' };
  }

  let tipKey: Uint8Array;
  try {
    assertOperationSession(wallet);
    tipKey = openLegacyTipKey(encryptedKey, wallet, opts.fragmentKey);
  } catch (e) {
    return { ok: false, error: `Could not open this tip: ${e instanceof Error ? e.message : String(e)}` };
  }
  let sweep: SweepOutcome;
  try {
    sweep = await sweepTip(asset as ClaimAsset, tipKey, tipAddress, wallet);
  } finally {
    tipKey.fill(0);
  }
  if (!sweep.ok) return sweep;

  if (token) void confirmLegacySweep(tipId, sweep.txid, token, opts.fetchImpl);
  const key = journalKeyFor(wallet);
  if (key) {
    void recordSend(
      {
        txid: sweep.txid,
        asset,
        destination: wallet.addresses[asset as 'btc' | 'ltc' | 'xmr' | 'wow'] ?? '',
        amountAtomic: sweep.summary.amountAtomic.toString(),
        feeAtomic: sweep.summary.feeAtomic.toString(),
        createdAt: Date.now(),
        legacyTipId: tipId,
      },
      key,
    );
  }
  return {
    ok: true,
    txid: sweep.txid,
    assetId: asset as ClaimAsset,
    amountAtomic: amount ?? sweep.summary.amountAtomic,
  };
}
