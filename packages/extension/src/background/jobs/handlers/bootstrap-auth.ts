/**
 * `bootstrap-auth` handler: runs the full `bootstrapAuth` pipeline
 * (checkRestore + PoW + extensionRegister) inside the offscreen
 * document so popup close can't abort it mid-flight.
 *
 * Why the whole bootstrap runs here rather than only the PoW solve:
 * with the register step popup-resident, a popup that died mid-solve
 * never made the register call, and the popup that came back redid
 * everything from scratch (new challenge, new solve, new tokens).
 * Running the full bootstrap here means the tokens land in
 * `chrome.storage.session` regardless of which popup (if any) is
 * open when the solve completes; `jobs.list({ dedupKey })` on
 * remount returns the completed job's result and the popup is
 * authenticated without redoing any work.
 *
 * The popup pre-computes the BIP-137 signature over
 * `smirk-auth-${timestamp}` because that's the one step that needs
 * the unlocked-wallet private key, and we never want private keys
 * crossing into the SW / offscreen context. The backend gives a
 * 5-minute drift window on `signedTimestamp` (see
 * `smirk-backend/src/api/auth.rs`) so even slow solves stay within
 * the signature validity window.
 *
 * Single-source-of-truth design: the PoW solve delegates to
 * `@smirk/core::solvePowChallenge` (with our abort signal threaded
 * in) rather than duplicating the altcha-lib invocation here. That
 * keeps the `{ challenge, solution }` envelope shape locked in
 * exactly one place. A bare `Solution` is rejected by the backend
 * with HTTP 422 'altcha_solution: missing field `challenge`'.
 */

import { api, solvePowChallenge } from '@smirk/core';

import type { JobHandler } from '../types';
import { PAYMENT_PENDING_SENTINEL } from '../types';

/** The backend signals a minted+bound-but-not-yet-Settled pay-to-register invoice
 *  with the stable `PAYMENT_PENDING` code (auth.rs `verify_payment_settled`).
 *  Expected during polling, not a failure. Match the machine-readable code
 *  first; fall back to the legacy 400 + string for backends predating the code
 *  so the rollout is not order-dependent. */
function isPaymentPending(result: {
  error?: string;
  status?: number;
  code?: string;
}): boolean {
  return (
    result.code === 'PAYMENT_PENDING' ||
    (result.status === 400 && /payment not yet confirmed/i.test(result.error ?? ''))
  );
}

/**
 * Map a non-2xx `/auth/extension` response to a human-friendly
 * single-line error the OnboardingWizard / popup can show under the
 * password field. The generic surface used to be "Unknown error",
 * which was actively unhelpful: rate-limit replies have no JSON
 * body so `result.error` lands as 'Unknown error' even though the
 * status (429) tells us exactly what happened.
 *
 * Backend pushes a structured `code` on most errors (AUTH_ERROR,
 * VALIDATION_ERROR, RATE_LIMITED, …): use that first; fall back to
 * HTTP status; finally fall back to the raw error string.
 */
function friendlyRegisterError(result: {
  error?: string;
  status?: number;
  code?: string;
}): string {
  const status = result.status;
  if (status === 429 || result.code === 'RATE_LIMITED') {
    return 'Too many wallet registrations from this network. Please try again in a few minutes.';
  }
  if (status === 400) {
    const raw = result.error ?? '';
    if (/proof[- ]of[- ]work|altcha/i.test(raw)) {
      return 'Proof-of-work check failed. Please update Smirk to the latest version and try again.';
    }
    if (/timestamp|signature/i.test(raw)) {
      return 'Network round-trip took too long — the signature timed out. Please try again.';
    }
    return raw || 'Wallet registration was rejected by the server.';
  }
  if (status === 422) {
    // axum's Json-extractor rejection. The body text usually says
    // exactly what's wrong ("missing field `signed_timestamp`",
    // etc.). client.ts now surfaces that text in `error`.
    const raw = result.error ?? '';
    return raw
      ? `Smirk server couldn't read the registration request: ${raw}`
      : "Smirk server couldn't read the registration request (HTTP 422). This is a Smirk bug — please report it.";
  }
  if (status === 401 || status === 403) {
    return result.error || 'Authentication failed — could not register wallet.';
  }
  if (status && status >= 500) {
    return 'The Smirk server is having trouble. Please try again in a moment.';
  }
  if (!status) {
    // No status field = network-level failure (fetch threw / offline /
    // CORS blocked). client.ts returns just `{ error: '<message>' }`.
    return result.error
      ? `Couldn't reach Smirk servers: ${result.error}`
      : "Couldn't reach Smirk servers. Check your internet connection and try again.";
  }
  return result.error || `Registration failed (HTTP ${status}).`;
}

export const bootstrapAuthHandler: JobHandler<'bootstrap-auth'> = {
  kind: 'bootstrap-auth',
  async run(input, ctx) {
    // ---- 1. checkRestore: best-effort lookup for resume heights ----
    let xmrStartHeight: number | undefined;
    let wowStartHeight: number | undefined;
    let isKnownWallet = false;
    try {
      const restoreCheck = await api.checkRestore({
        fingerprint: input.fingerprint,
        keys: input.keys as Parameters<typeof api.checkRestore>[0]['keys'],
      });
      if (restoreCheck.data?.exists) {
        isKnownWallet = true;
        if (typeof restoreCheck.data.xmrStartHeight === 'number') {
          xmrStartHeight = restoreCheck.data.xmrStartHeight;
        }
        if (typeof restoreCheck.data.wowStartHeight === 'number') {
          wowStartHeight = restoreCheck.data.wowStartHeight;
        }
      }
    } catch (e) {
      console.warn('[bootstrap-auth] checkRestore failed, treating as new:', e);
    }

    const walletBirthday = isKnownWallet
      ? undefined
      : Math.floor(Date.now() / 1000);

    // ---- 2. PoW solve: only for genuinely new wallets ----
    // The backend's returning-user bypass (see smirk-backend's
    // src/api/auth.rs `is_returning_user`) accepts re-registrations
    // for an already-known pubkey_hash WITHOUT a PoW solution, even
    // when POW_REQUIRED=true. The whole bypass exists so v0.2.x
    // stragglers and lock+unlock flows don't spin PBKDF2 for nothing.
    //
    // We mirror that bypass client-side using the same signal:
    // `checkRestore` already told us if the wallet is known (it's
    // step 1 above), and that's exactly the predicate the backend
    // uses. Skip the solve when it would be discarded anyway:
    // saves ~3-5s of CPU on every lock+unlock and on every import
    // of an already-registered wallet.
    //
    // New wallets still solve normally; that's the Sybil gate
    // doing its job.
    //
    // solvePowChallenge returns the `AltchaPayload` envelope ({
    // challenge, solution }); typed alias means a regression to a
    // bare `Solution` is a TS compile error, not a runtime 422.
    let altchaSolution: Awaited<ReturnType<typeof solvePowChallenge>> = null;
    if (isKnownWallet) {
      console.debug(
        '[bootstrap-auth] returning wallet (fingerprint matches existing user) — skipping PoW solve',
      );
    } else {
      altchaSolution = await solvePowChallenge(api, { signal: ctx.signal });
    }

    // ---- 3. extensionRegister (+ optional registration-gate credentials) ----
    const result = await api.extensionRegister({
      keys: input.keys as Parameters<
        typeof api.extensionRegister
      >[0]['keys'],
      seedFingerprint: input.fingerprint,
      signedTimestamp: input.signedTimestamp,
      signature: input.signature,
      ...(walletBirthday !== undefined ? { walletBirthday } : {}),
      ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
      ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
      ...(altchaSolution !== null ? { altchaSolution } : {}),
      ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}),
      ...(input.paymentInvoiceId
        ? { paymentInvoiceId: input.paymentInvoiceId }
        : {}),
    });

    // Pay-to-register: a not-yet-Settled invoice is EXPECTED while the user is
    // paying. Surface it as the stable pending sentinel so the popup's poll
    // keeps waiting (money-safe: the backend consumes only on Settled), rather
    // than a hard failure. Any other error falls through to the friendly throw.
    if (
      input.paymentInvoiceId &&
      (result.error || !result.data) &&
      isPaymentPending(result)
    ) {
      throw new Error(PAYMENT_PENDING_SENTINEL);
    }

    if (result.error || !result.data) {
      // Log the full failure context to the offscreen-document
      // DevTools (chrome://extensions → Inspect views → jobs-
      // offscreen.html). Real-money software shouldn't hide what
      // went wrong even if the throw → popup string is friendly.
      console.error('[bootstrap-auth] extensionRegister failed', {
        status: result.status,
        code: result.code,
        error: result.error,
        request: {
          keysSample: input.keys.map((k) => ({
            asset: k.asset,
            publicKeyLen: k.publicKey?.length ?? 0,
          })),
          seedFingerprint: input.fingerprint,
          signedTimestamp: input.signedTimestamp,
          signatureLen: input.signature?.length ?? 0,
          walletBirthday,
          xmrStartHeight,
          wowStartHeight,
          hadAltcha: altchaSolution !== null,
        },
      });
      throw new Error(friendlyRegisterError(result));
    }

    return {
      bootstrap: {
        userId: result.data.user.id,
        ...(result.data.user.username !== undefined
          ? { username: result.data.user.username }
          : {}),
        // Namespaced backend puts is_new at the top level (data.isNew); a flat
        // backend may nest it under user. Read both so onboarding branches right.
        isNew: result.data.isNew ?? result.data.user.isNew ?? false,
        ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
        ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
      },
      accessToken: result.data.accessToken,
    };
  },
};
