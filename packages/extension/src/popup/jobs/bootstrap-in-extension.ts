/**
 * Drop-in replacement for the popup's two `bootstrapAuth` call
 * sites. Identical observable behaviour from the popup's
 * perspective (sets the api access token, returns a
 * `BootstrapAuthResult`), but the heavy lifting runs in the SW so
 * the popup is free to close + reopen at will.
 *
 * Migration boundary: `@smirk/core.bootstrapAuth` stays for desktop
 * / future Capacitor hosts that don't have the popup-unmount
 * problem; this wrapper exists specifically for the extension.
 *
 * Side effects:
 *   - `api.setAccessToken(token)` on success.
 *   - No cache writes here — the caller decides what cache layer to
 *     populate (the popup already calls `writeBootstrapCache` and
 *     we don't want to step on that flow).
 *
 * Failures: the SW handler hard-throws when /auth/extension fails
 * (rate limit, invalid signature, wrong fingerprint match). The
 * popup surfaces the error to the user just like it would for an
 * inline bootstrap failure.
 */

import type { SmirkApi } from '@smirk/core';
import {
  bytesToHex,
  signBitcoinMessage,
  deriveNostrIdentity,
  solvePowChallenge,
  bootstrapAuth,
} from '@smirk/core';
import type { UnlockedWallet } from '@smirk/core';

import { runBootstrapInBackground } from './bootstrap-auth';
import type { BootstrapJobResult } from './bootstrap-auth';
import { PAYMENT_PENDING_SENTINEL } from '../../background/jobs/types';
import {
  getPendingRegistrationInvoice,
  clearPendingRegistrationInvoice,
} from '../pending-registration-invoice';

/** Internal signal: the npub bootstrap determined this wallet is already
 *  registered on the backend and must authenticate via the BTC path instead. */
const NOSTR_FALLBACK_TO_BTC = 'SMIRK_NOSTR_FALLBACK_TO_BTC';

function buildKeysList(
  wallet: UnlockedWallet,
): ReadonlyArray<{ asset: string; publicKey: string }> {
  // Mirrors `@smirk/core.buildKeysList` (which isn't exported). Same
  // shape, same XMR/WOW spend-key convention — see the comment in
  // wallet-flow.ts on why this exact ordering matters for restore.
  return [
    { asset: 'btc', publicKey: bytesToHex(wallet.keys.btc.publicKey) },
    { asset: 'ltc', publicKey: bytesToHex(wallet.keys.ltc.publicKey) },
    { asset: 'xmr', publicKey: bytesToHex(wallet.keys.xmr.publicSpendKey) },
    { asset: 'wow', publicKey: bytesToHex(wallet.keys.wow.publicSpendKey) },
    { asset: 'grin', publicKey: bytesToHex(wallet.keys.grin.publicKey) },
  ];
}

/**
 * Runs the bootstrap via the background-jobs system. Always
 * compute the signature in-popup (private-key-bearing call); the SW
 * does the rest.
 */
export async function bootstrapAuthInExtension(
  api: SmirkApi,
  wallet: UnlockedWallet,
  /**
   * Registration-gate credentials for a gated backend. Sent to `/auth/extension`
   * only when present. Under `registration_mode: "any"` pass AT MOST ONE. The
   * `pollAttempt` counter makes each pay-to-register retry a fresh job (fresh
   * signature) — the payment poll increments it each iteration.
   */
  gate?: {
    inviteCode?: string;
    paymentInvoiceId?: string;
    pollAttempt?: number;
  },
): Promise<BootstrapJobResult['bootstrap']> {
  const keys = buildKeysList(wallet);

  // Resume a pay-to-register that was interrupted mid-payment: if no invoice was
  // passed explicitly but one is persisted for this wallet, include it so a plain
  // unlock completes registration once the operator's processor settles it. A
  // returning (already-registered) wallet bypasses the gate server-side, so a
  // stale record is harmless and gets cleared on the success below.
  let paymentInvoiceId = gate?.paymentInvoiceId;
  if (!paymentInvoiceId) {
    paymentInvoiceId = (await getPendingRegistrationInvoice(wallet.fingerprint)) ?? undefined;
  }
  const effectiveGate = paymentInvoiceId ? { ...gate, paymentInvoiceId } : gate;

  // Capabilities-gated: a backend advertising npub-native auth gets the NIP-98
  // bootstrap (no BTC signature); a legacy backend keeps the BTC offscreen-job
  // path. A failed/absent capabilities read falls back to the legacy path.
  let nostrNative = false;
  try {
    const caps = await api.getCapabilities();
    nostrNative = !!caps.data?.features?.nostr_native_auth;
  } catch {
    /* treat as a legacy (BTC) backend */
  }
  if (nostrNative && wallet.mnemonic) {
    try {
      const bootstrap = await bootstrapViaNostr(api, wallet, keys, effectiveGate);
      await clearPendingRegistrationInvoice(wallet.fingerprint);
      return bootstrap;
    } catch (e) {
      // A wallet already registered on THIS backend (its seed is known — e.g. it
      // onboarded via the BTC path before npub-native existed) can't npub-register:
      // by design its npub links via the authenticated /auth/nostr/link flow, not
      // bootstrap. Fall back to BTC auth, which signs the existing account in.
      // Anything else (a genuinely new wallet's failure, the payment-pending
      // sentinel) propagates.
      if (!(e instanceof Error && e.message === NOSTR_FALLBACK_TO_BTC)) throw e;
      // Re-auth INLINE (popup-resident) rather than via the offscreen job: this is
      // a fast returning-user sign-in (no PoW, nothing to strand), and the offscreen
      // path hits an MV3 "receiving end does not exist" race right after a reload.
      // bootstrapAuth sets the access token itself.
      const bootstrap = await bootstrapAuth(api, wallet);
      await clearPendingRegistrationInvoice(wallet.fingerprint);
      return bootstrap;
    }
  }

  // ── BTC path (offscreen job) — legacy backends AND the npub→BTC fallback ──
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `smirk-auth-${timestamp}`;
  const signature = signBitcoinMessage(message, wallet.keys.btc.privateKey);

  const result = await runBootstrapInBackground(
    {
      fingerprint: wallet.fingerprint,
      keys,
      signedTimestamp: timestamp,
      signature,
      ...(effectiveGate?.inviteCode ? { inviteCode: effectiveGate.inviteCode } : {}),
      ...(paymentInvoiceId ? { paymentInvoiceId } : {}),
    },
    gate?.pollAttempt !== undefined ? `pay:${gate.pollAttempt}` : undefined,
  );

  api.setAccessToken(result.accessToken);
  // Registration succeeded: any pending pay-to-register record is now spent.
  await clearPendingRegistrationInvoice(wallet.fingerprint);
  return result.bootstrap;
}

/**
 * npub-native bootstrap (NIP-98). Popup-resident: signing the register event and
 * solving PoW both need the seed, which never leaves the popup (unlike the BTC
 * path, this does not use the offscreen job. A heavy-PoW nostr backend requires
 * the popup to stay open, matching the pay-to-register UX). `checkRestore`
 * resumes heights + detects a returning wallet (so PoW is skipped, exactly like
 * the BTC handler). A not-yet-settled pay-to-register invoice throws the shared
 * PAYMENT_PENDING_SENTINEL so the onboarding router's poll keeps waiting.
 */
async function bootstrapViaNostr(
  api: SmirkApi,
  wallet: UnlockedWallet,
  keys: ReadonlyArray<{ asset: string; publicKey: string }>,
  gate?: { inviteCode?: string; paymentInvoiceId?: string },
): Promise<BootstrapJobResult['bootstrap']> {
  const identity = deriveNostrIdentity(wallet.mnemonic!, 0);

  // Resume heights + returning detection (fingerprint is derivation-independent).
  let xmrStartHeight: number | undefined;
  let wowStartHeight: number | undefined;
  let isKnown = false;
  try {
    const rc = await api.checkRestore({
      fingerprint: wallet.fingerprint,
      keys: keys.map((k) => ({ asset: k.asset, publicKey: k.publicKey })),
    });
    if (rc.data?.exists) {
      isKnown = true;
      if (typeof rc.data.xmrStartHeight === 'number') xmrStartHeight = rc.data.xmrStartHeight;
      if (typeof rc.data.wowStartHeight === 'number') wowStartHeight = rc.data.wowStartHeight;
    }
  } catch (e) {
    console.warn('[bootstrap-nostr] checkRestore failed, treating as new:', e);
  }

  const walletBirthday = isKnown ? undefined : Math.floor(Date.now() / 1000);

  // Solve PoW for genuinely-new wallets (the backend bypasses it for a returning
  // npub, so a known wallet skips the solve, mirroring the BTC handler).
  let altchaSolution: Awaited<ReturnType<typeof solvePowChallenge>> = null;
  if (!isKnown) {
    try {
      altchaSolution = await solvePowChallenge(api);
    } catch (e) {
      console.warn('[bootstrap-nostr] PoW solve failed; registering without it:', e);
    }
  }

  const res = await api.nostrRegister({
    identity,
    keys: keys.map((k) => ({ asset: k.asset, publicKey: k.publicKey })),
    seedFingerprint: wallet.fingerprint,
    ...(walletBirthday !== undefined ? { walletBirthday } : {}),
    ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
    ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
    ...(altchaSolution ? { altchaSolution } : {}),
    ...(gate?.inviteCode ? { inviteCode: gate.inviteCode } : {}),
    ...(gate?.paymentInvoiceId ? { paymentInvoiceId: gate.paymentInvoiceId } : {}),
  });

  if (res.error || !res.data) {
    // A not-yet-settled pay-to-register invoice is EXPECTED while paying, so signal
    // the shared sentinel so the router's poll keeps waiting (money-safe: the
    // backend consumes the invoice only on settlement). Prefer the stable
    // `PAYMENT_PENDING` code; fall back to the legacy 400 + string for older
    // backends.
    if (
      gate?.paymentInvoiceId &&
      (res.code === 'PAYMENT_PENDING' ||
        (res.status === 400 && /payment not yet confirmed/i.test(res.error ?? '')))
    ) {
      throw new Error(PAYMENT_PENDING_SENTINEL);
    }
    // The wallet's seed is already registered on this backend but its npub isn't
    // linked, so npub-register is refused. A 409 is the DEFINITIVE "already has an
    // account" signal (independent of checkRestore, which may have been rate-limited
    // to a false `isKnown=false`); `isKnown` covers the 400-PoW-required variant.
    // Either way, fall back to BTC auth, which signs the existing account in.
    if (res.status === 409 || isKnown) {
      throw new Error(NOSTR_FALLBACK_TO_BTC);
    }
    throw new Error(res.error ?? 'Registration failed');
  }

  api.setAccessToken(res.data.accessToken);
  return {
    userId: res.data.user.id,
    ...(res.data.user.username !== undefined ? { username: res.data.user.username } : {}),
    isNew: res.data.user.isNew ?? false,
    ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
    ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
  };
}
