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
 *   - `api.setAccessToken(token)` on success, and only while `api` still
 *     points at the backend the sign-in started on (see `pinBackend`): a
 *     token goes to no backend but the one that minted it.
 *   - No cache writes here: the caller decides what cache layer to
 *     populate (the popup already calls `writeBootstrapCache` and
 *     we don't want to step on that flow).
 *
 * Failures: the SW handler hard-throws when /auth/extension fails
 * (rate limit, invalid signature, wrong fingerprint match). The
 * popup surfaces the error to the user just like it would for an
 * inline bootstrap failure.
 */

import type { PinnedBackend, SmirkApi } from '@smirk/core';
import {
  pinBackend,
  bytesToHex,
  signBitcoinMessage,
  deriveNostrIdentity,
  requireNostrKeySource,
  solvePowChallenge,
  isPowRequiredRejection,
  POW_CHECK_INCOMPLETE,
  bootstrapAuth,
  requireRestoreState,
  registeredRestoreState,
  mergeLegacyIdentityAfterSignIn,
  legacyBtcRotationProof,
  capHasLegacyMergeV2,
} from '@smirk/core';
import type { UnlockedWallet } from '@smirk/core';

import { runBootstrapInBackground } from './bootstrap-auth';
import type { BootstrapJobResult } from './bootstrap-auth';
import { PAYMENT_PENDING_SENTINEL } from '../../background/jobs/types';
import {
  getPendingRegistrationInvoice,
  clearPendingRegistrationInvoice,
} from '../pending-registration-invoice';
import { rememberBackendAccount } from '../../backend-accounts';

/** Internal signal: the npub bootstrap determined this wallet is already
 *  registered on the backend and must authenticate via the BTC path instead. */
const NOSTR_FALLBACK_TO_BTC = 'SMIRK_NOSTR_FALLBACK_TO_BTC';

/** The capabilities read decides which auth path this wallet takes, so a read we
 *  could not complete has to stop the bootstrap (see the call site). Retryable:
 *  the popup shows `message` and the next unlock tries again. */
function capabilitiesUnreadable(detail: string): Error {
  return new Error(
    `Could not read the backend's capabilities (${detail}). Check your connection and try again.`,
  );
}

function buildKeysList(
  wallet: UnlockedWallet,
): ReadonlyArray<{ asset: string; publicKey: string }> {
  // Mirrors `@smirk/core.buildKeysList` (which isn't exported). Same
  // shape, same XMR/WOW spend-key convention; see the comment in
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
   * signature); the payment poll increments it each iteration.
   */
  gate?: {
    inviteCode?: string;
    paymentInvoiceId?: string;
    pollAttempt?: number;
  },
): Promise<BootstrapJobResult['bootstrap']> {
  // Everything below, and the token it ends with, belongs to the backend `api`
  // points at now. The window can switch backend (or another window can reset
  // it) while any await below is pending; a token installed after that went to
  // the new operator as a bearer for the old one. Checked after every await.
  const pinned = pinBackend(api);
  const keys = buildKeysList(wallet);

  // Resume a pay-to-register that was interrupted mid-payment: if no invoice was
  // passed explicitly but one is persisted for this wallet AT THIS BACKEND,
  // include it so a plain unlock completes registration once the operator's
  // processor settles it. A returning (already-registered) wallet bypasses the
  // gate server-side, so a stale record is harmless and gets cleared on the
  // success below. Another backend's invoice is never sent here.
  let paymentInvoiceId = gate?.paymentInvoiceId;
  if (!paymentInvoiceId) {
    paymentInvoiceId =
      (await getPendingRegistrationInvoice(wallet.fingerprint, pinned.url)) ?? undefined;
    pinned.assertCurrent();
  }
  const effectiveGate = paymentInvoiceId ? { ...gate, paymentInvoiceId } : gate;

  // Capabilities-gated: a backend advertising npub-native auth gets the NIP-98
  // bootstrap (no BTC signature); a legacy backend, which answers 200 with the
  // flag simply absent, keeps the BTC offscreen-job path.
  //
  // An ERRORED read is "unknown", never "legacy". Guessing legacy forks the
  // user's identity: a wallet that registered npub-natively has a NULL
  // `pubkey_hash` on the backend, so the BTC path does not recognise it and
  // mints a SECOND account for the same seed. Fail closed with a retryable
  // error instead, mirroring the onboarding wizard, which also refuses to treat
  // an unresolved capabilities read as permissive. Note `getCapabilities`
  // reports network/HTTP failures as `{ error }` rather than throwing, so both
  // shapes have to be handled.
  const caps = await api.getCapabilities().catch((e: unknown) => {
    throw capabilitiesUnreadable(e instanceof Error ? e.message : String(e));
  });
  pinned.assertCurrent();
  if (caps.error || !caps.data) {
    throw capabilitiesUnreadable(caps.error ?? 'empty /capabilities response');
  }
  const nostrNative = caps.data.features?.nostr_native_auth === true;

  if (nostrNative) {
    // Restore signs with the same scoped Nostr root as a fresh unlock.
    // Missing material must never switch this wallet to another auth identity.
    requireNostrKeySource(wallet);
    try {
      const bootstrap = await bootstrapViaNostr(api, pinned, wallet, keys, effectiveGate);
      await signedIn(wallet, pinned);
      return bootstrap;
    } catch (e) {
      // A wallet already registered on THIS backend (its seed is known, e.g. it
      // onboarded via the BTC path before npub-native existed, or it is a pre-v0.3
      // wallet) can't npub-register: by design its npub links via the
      // authenticated /auth/nostr/link flow, not bootstrap. Fall back to BTC auth,
      // which signs the existing account in. Anything else (a genuinely new
      // wallet's failure, a rate limit, the payment-pending sentinel) propagates.
      if (!(e instanceof Error && e.message === NOSTR_FALLBACK_TO_BTC)) throw e;
      // Re-auth INLINE (popup-resident) rather than via the offscreen job: this is
      // usually a fast returning-user sign-in, and the offscreen path hits an MV3
      // "receiving end does not exist" race right after a reload. A pre-v0.3
      // wallet is the exception: the backend knows it by fingerprint but not by
      // its v0.3 key, so bootstrapAuth solves PoW when asked and sends the
      // rotation proof. bootstrapAuth sets the access token itself. When the
      // seed's account carries an npub other than this wallet's, the backend
      // refuses the BTC sign-in too (409); bootstrapAuth reports that as
      // NOSTR_IDENTITY_CONFLICT and solves nothing.
      pinned.assertCurrent();
      const bootstrap = await bootstrapAuth(api, wallet);
      await signedIn(wallet, pinned);
      return bootstrap;
    }
  }

  // ── BTC path (offscreen job): legacy backends AND the npub→BTC fallback ──
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `smirk-auth-${timestamp}`;
  const signature = signBitcoinMessage(message, wallet.keys.btc.privateKey);
  // The job cannot sign, so the pre-v0.3 rotation proof is made here too, over
  // the same timestamp; the job sends it only for a known fingerprint. Only a
  // server that advertises the hardened merge gets one (`legacy_merge_v2`): an
  // older server lets a planted key row fold into this account.
  const rotation = wallet.seed && capHasLegacyMergeV2(caps.data)
    ? legacyBtcRotationProof(wallet.seed, bytesToHex(wallet.keys.btc.publicKey), timestamp, pinned.url)
    : null;

  const result = await runBootstrapInBackground(
    {
      // The token comes back for THIS client's backend, and only that backend
      // may mint it (see runBootstrapInBackground).
      backend: { url: pinned.url, apiStyle: api.getWalletApiStyle() },
      fingerprint: wallet.fingerprint,
      keys,
      signedTimestamp: timestamp,
      signature,
      ...(rotation ?? {}),
      ...(effectiveGate?.inviteCode ? { inviteCode: effectiveGate.inviteCode } : {}),
      ...(paymentInvoiceId ? { paymentInvoiceId } : {}),
    },
    gate?.pollAttempt !== undefined ? `pay:${gate.pollAttempt}` : undefined,
  );

  // The job's token was minted at `pinned.url` (runBootstrapInBackground
  // refuses any other); install it only if this window is still there.
  pinned.installToken(result.accessToken);
  await signedIn(wallet, pinned);
  return result.bootstrap;
}

/**
 * Bookkeeping after a sign-in at `pinned.url` succeeded: the pending
 * pay-to-register record there is spent, and the wallet now holds an account
 * there, which the dapp signer must protect (see `backend-accounts.ts`).
 */
async function signedIn(wallet: UnlockedWallet, pinned: PinnedBackend): Promise<void> {
  await clearPendingRegistrationInvoice(wallet.fingerprint, pinned.url);
  try {
    await rememberBackendAccount(pinned.url);
  } catch (e) {
    console.warn('[bootstrap] could not record the signed-in backend for the dapp signing guard', e);
  }
}

/**
 * npub-native bootstrap (NIP-98). Signing uses the primary Nostr key source.
 * This path stays in the popup, including proof-of-work, so a backend requiring
 * expensive proof-of-work needs the popup to remain open. `checkRestore`
 * resumes heights and tells us whether the seed fingerprint is known, which
 * only selects the fast path that skips the PoW solve: the backend waives PoW
 * for a known npub, not a known fingerprint. A not-yet-settled pay-to-register
 * invoice throws the shared PAYMENT_PENDING_SENTINEL so the onboarding router's
 * poll keeps waiting.
 */
async function bootstrapViaNostr(
  api: SmirkApi,
  pinned: PinnedBackend,
  wallet: UnlockedWallet,
  keys: ReadonlyArray<{ asset: string; publicKey: string }>,
  gate?: { inviteCode?: string; paymentInvoiceId?: string },
): Promise<BootstrapJobResult['bootstrap']> {
  const identity = deriveNostrIdentity(requireNostrKeySource(wallet), 0);

  const restore = await requireRestoreState(api, {
    fingerprint: wallet.fingerprint,
    keys: keys.map((key) => ({ asset: key.asset, publicKey: key.publicKey })),
  });
  pinned.assertCurrent();
  const isKnown = restore.exists;
  const xmrStartHeight = isKnown ? restore.xmrStartHeight ?? undefined : undefined;
  const wowStartHeight = isKnown ? restore.wowStartHeight ?? undefined : undefined;

  const walletBirthday = isKnown ? undefined : Math.floor(Date.now() / 1000);

  // Solve PoW for a wallet whose fingerprint is unknown. A known fingerprint
  // skips the solve as a fast path: the backend waives PoW for an npub already
  // on file, which is the usual case for a known wallet.
  const solve = async (): Promise<Awaited<ReturnType<typeof solvePowChallenge>>> => {
    try {
      return await solvePowChallenge(api);
    } catch (e) {
      console.warn('[bootstrap-nostr] PoW solve failed; registering without it:', e);
      return null;
    }
  };
  // Each call fetches a fresh single-use nonce and signs a fresh NIP-98 action.
  const register = (altchaSolution: Awaited<ReturnType<typeof solvePowChallenge>>) => {
    pinned.assertCurrent();
    return api.nostrRegister({
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
  };

  let altchaSolution = isKnown ? null : await solve();
  let res = await register(altchaSolution);
  // An answer that arrives after the window moved is not this backend's to act
  // on, whatever it says.
  pinned.assertCurrent();

  // A new wallet whose own solve failed above went out without a solution. If
  // the backend insists, solve once more and resend. A KNOWN fingerprint with
  // no npub on file is not retried here: past the PoW gate the backend refuses
  // npub-register for an existing seed (409), so a solve would be wasted. It
  // falls back to BTC sign-in below, which solves when the backend asks.
  if ((res.error || !res.data) && !isKnown && altchaSolution === null && isPowRequiredRejection(res)) {
    altchaSolution = await solve();
    if (altchaSolution) res = await register(altchaSolution);
    pinned.assertCurrent();
  }

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
    // account" signal. A known fingerprint refused for want of PoW is the same
    // case, caught one gate earlier (the backend checks PoW before the 409).
    // Either way, fall back to BTC auth, which signs the existing account in.
    // Nothing else falls back: a rate limit, a rejected NIP-98 proof or an outage
    // would fail the same way on the BTC path and only double the load.
    if (res.status === 409 || (isKnown && isPowRequiredRejection(res))) {
      throw new Error(NOSTR_FALLBACK_TO_BTC);
    }
    // Still refused for want of a solution: the resend above could not solve.
    if (isPowRequiredRejection(res)) throw new Error(POW_CHECK_INCOMPLETE);
    throw new Error(res.error ?? 'Registration failed');
  }

  // Minted at `pinned.url`; installed only while this window is still there.
  pinned.installToken(res.data.accessToken);
  const scanState = await registeredRestoreState(api, {
    fingerprint: wallet.fingerprint,
    keys: keys.map((key) => ({ asset: key.asset, publicKey: key.publicKey })),
  }, restore);
  pinned.assertCurrent();
  // A known wallet may have been split from its pre-v0.3 identity by an earlier
  // import; with the seed in hand, ask the backend to merge it back. Best-effort,
  // and skipped unless the server advertises the hardened merge.
  if (isKnown) await mergeLegacyIdentityAfterSignIn(api, wallet);
  return {
    userId: res.data.user.id,
    ...(res.data.user.username !== undefined ? { username: res.data.user.username } : {}),
    // Namespaced backend puts is_new at the top level (data.isNew); a flat
    // backend may nest it under user. Read both so onboarding branches correctly.
    isNew: res.data.isNew ?? res.data.user.isNew ?? false,
    restoreState: isKnown ? 'existing' : 'new',
    ...(scanState.xmrStartHeight != null ? { xmrStartHeight: scanState.xmrStartHeight } : {}),
    ...(scanState.wowStartHeight != null ? { wowStartHeight: scanState.wowStartHeight } : {}),
  };
}
