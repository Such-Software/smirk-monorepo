/**
 * Pure executor for an `ApprovalApproval` decision. Runs in any
 * wallet-foreground context that holds an `UnlockedWallet` —
 * the extension's standalone approval popup window, the Tauri
 * desktop's in-popup approval modal, and (future) the Capacitor
 * mobile in-app sheet.
 *
 * The executor produces the `DappApprovalResult` that gets handed
 * back to the WalletHandler / dapp-api dispatcher. It performs the
 * privileged operations (signing, sending, claiming) using the
 * unlocked wallet directly — there is no SW round-trip and no key
 * material crosses the function boundary.
 *
 * Inputs come through `ExecuteApprovalDeps` so the executor stays
 * decoupled from the popup's module-level singletons. That keeps it
 * unit-testable and means the desktop bridge composes the same deps
 * without forking the persistence layer.
 */

import {
  chainProviders,
  recentlySpentInputs,
  resolveFeeRateOrFallback,
  deriveNostrIdentityForOrigin,
  type SessionState,
  type UnlockedWallet,
} from '@smirk/core';
import type {
  ApprovalRequest,
  ApprovalResult as DappApprovalResult,
  SmirkAsset,
} from '@such-software/smirk-dapp-api';
import type { ApprovalApproval } from '@smirk/ui';
import {
  signMessageWithUnlocked,
  signNostrEventWith,
  deriveAppEncKeyWithUnlocked,
  openAppSealWithUnlocked,
  nostrCryptWith,
} from './signers';
import { resolveNostrIdentityForOrigin } from '../popup/nostr-vault';

/**
 * The popup-side dependencies the executor needs. We pass these in
 * rather than importing the popup's module singletons so the
 * executor can run from any callsite — extension approval window,
 * Tauri BrowseTab modal, future Capacitor approval sheet.
 */
export interface ExecuteApprovalDeps {
  wallet: UnlockedWallet;
  /** Idempotent WASM init. The approval window doesn't always go
   * through the unlock path (which does it eagerly), so we call
   * this on every approval to be sure. */
  ensureWasmInit: () => Promise<void>;
  /**
   * Unified send. We don't type the params strictly here so this
   * module stays decoupled from the popup-internal send-handler
   * shape; the caller passes their `send` function verbatim and the
   * approval-flow code reaches its argument shape locally.
   */
  send: (
    wallet: UnlockedWallet,
    params: {
      fromAssetId: SmirkAsset;
      amountAtomic: bigint;
      toAddress: string;
      feeRateSatPerVb: number;
      sweep: boolean;
    },
    excludeInputs?: Set<string>,
  ) => Promise<
    | {
        ok: true;
        txid: string;
        amountAtomic?: bigint;
        feeAtomic?: bigint;
        inputs?: string[];
        inputsTotalAtomic?: bigint;
      }
    | { ok: false; error: string }
  >;
  claimPublicTip: (
    wallet: UnlockedWallet,
    userId: string,
    tipId: string,
    fragmentKey: string,
  ) => Promise<{ ok: boolean; txid?: string; error?: string }>;
  readBootstrapCache: (
    fingerprint: string,
  ) => Promise<{ accessToken: string; bootstrap: { userId: string } } | null>;
  api: {
    setAccessToken(token: string): void;
  };
  loadState: () => Promise<SessionState>;
  /** Return type is `unknown` because callers vary — popup's
   * `store.update` returns the new SessionState; the executor
   * doesn't read the return value. */
  updateState: (mutator: (s: SessionState) => void) => Promise<unknown>;
}

/**
 * Run the approval. Returns the result to pass back to the dapp-api
 * `ApprovalHandler`. Throws only on programmer errors (e.g., the
 * `approval.kind` and `request.kind` disagree) — operational failures
 * are surfaced as `{success: false, error}` in the result.
 */
export async function executeApproval(
  request: ApprovalRequest,
  approval: ApprovalApproval,
  deps: ExecuteApprovalDeps,
): Promise<DappApprovalResult> {
  await deps.ensureWasmInit();

  switch (approval.kind) {
    case 'connect': {
      return {
        kind: 'connect',
        approved: true,
        // The UI's `ApprovalAsset` and dapp-api's `SmirkAsset` are
        // structurally identical ('btc' | 'ltc' | 'xmr' | 'wow' |
        // 'grin') but distinct nominal types. Cast at the boundary
        // — this is the standalone seam between the UI's approval
        // affordance and the dapp wire protocol.
        approvedAssets: approval.approvedAssets as unknown as SmirkAsset[],
      };
    }

    case 'signMessage': {
      if (request.kind !== 'signMessage') {
        throw new Error('Pending request kind mismatch (expected signMessage)');
      }
      const result = signMessageWithUnlocked(
        deps.wallet,
        request.message,
        request.assets,
      );
      return { kind: 'signMessage', approved: true, result };
    }

    case 'requestPayment': {
      if (request.kind !== 'requestPayment') {
        throw new Error(
          'Pending request kind mismatch (expected requestPayment)',
        );
      }
      const req = request;
      // Defense in depth: the wallet-handler boundary already rejects grin
      // in-page payments (UNSUPPORTED_ASSET), but never let a grin send
      // reach deps.send. A dapp-initiated grin send would write finalize
      // context into a SendWizard slot it never populates, so the returned
      // S2 could never finalize and would lock the user's inputs for ~7
      // days. Refuse here too rather than trust the upstream guard.
      if ((req.asset as SmirkAsset) === 'grin') {
        return {
          kind: 'requestPayment',
          approved: true,
          result: {
            success: false,
            error: 'Grin payments are not supported for in-page requests yet',
          },
        };
      }
      const sessionState = await deps.loadState();
      const excludeInputs = recentlySpentInputs(
        sessionState.pendingOutgoing ?? [],
        req.asset,
      );

      // Pull a real fee rate. send-handler doesn't fall back to a
      // "normal" tier on its own — passing 0 makes selectUtxos
      // compute fee = ceil(vsize * 0) = 0, then trip the
      // `feeSat <= 0` guard and fail every dapp UTXO payment. Use
      // the same Electrum source as the SendWizard; if that
      // roundtrip fails, resolveFeeRateOrFallback drops to the shared
      // floored fallback (same as send/tip) so the tx still lands.
      let feeRateSatPerVb = 1;
      if (req.asset === 'btc' || req.asset === 'ltc') {
        const tiers = await chainProviders.utxo(req.asset).estimateFee().catch(() => null);
        const fee = tiers?.data?.model === 'rate-estimate' ? tiers.data : null;
        feeRateSatPerVb = resolveFeeRateOrFallback(fee?.normal);
      }

      const result = await deps.send(
        deps.wallet,
        {
          fromAssetId: req.asset,
          amountAtomic: BigInt(req.amount),
          toAddress: req.address,
          feeRateSatPerVb,
          sweep: false,
        },
        excludeInputs,
      );

      if (
        result.ok &&
        result.amountAtomic !== undefined &&
        result.feeAtomic !== undefined
      ) {
        const entry = {
          asset: req.asset,
          txHash: result.txid,
          amount: result.amountAtomic.toString(),
          fee: result.feeAtomic.toString(),
          recipient: req.address,
          submittedAt: Date.now(),
          ...(result.inputs && result.inputs.length > 0
            ? { inputs: result.inputs }
            : {}),
          ...(result.inputsTotalAtomic !== undefined
            ? { inputsTotal: result.inputsTotalAtomic.toString() }
            : {}),
        };
        await deps.updateState((s) => {
          // SessionState's pendingOutgoing is typed loosely at this
          // boundary — the executor doesn't reach into the schema.
          (s.pendingOutgoing as unknown as Array<unknown>).push(entry);
        });
      }

      return {
        kind: 'requestPayment',
        approved: true,
        result: result.ok
          ? { success: true, txid: result.txid }
          : { success: false, error: result.error ?? 'send failed' },
      };
    }

    case 'claimPublicTip': {
      if (request.kind !== 'claimPublicTip') {
        throw new Error(
          'Pending request kind mismatch (expected claimPublicTip)',
        );
      }
      const req = request;
      // claimPublicTip orchestrates: getPublicSocialTip
      // (unauthenticated) → claimSocialTip (authenticated) → sweep.
      // The middle step needs the same access token the main popup
      // bootstrapped, otherwise the backend returns 401 and the user
      // sees a "Backend rejected claim" generic message.
      const cached = await deps.readBootstrapCache(deps.wallet.fingerprint);
      if (!cached) {
        return {
          kind: 'claimPublicTip',
          approved: true,
          result: {
            success: false,
            error: 'Open Smirk once to sign in, then retry the claim.',
          },
        };
      }
      deps.api.setAccessToken(cached.accessToken);
      const outcome = await deps.claimPublicTip(
        deps.wallet,
        cached.bootstrap.userId,
        req.tipId,
        req.fragmentKey,
      );
      return {
        kind: 'claimPublicTip',
        approved: true,
        result: outcome.ok
          ? { success: true, txid: outcome.txid ?? '' }
          : { success: false, error: outcome.error ?? 'claim failed' },
      };
    }

    case 'nostrGrant': {
      if (approval.kind !== 'nostrGrant') {
        throw new Error('Pending approval kind mismatch (expected nostrGrant)');
      }
      // Resolve the identity the user chose to share with this origin: a per-origin
      // compartmentalized one, or their main (account-0) identity. Returned so the
      // handler persists it on OriginPermission.nostrPubkey — getNostrPublicKey +
      // signing then all act as this same identity.
      let nostrPubkey: string | undefined;
      if (approval.perOrigin) {
        // A per-origin (compartmentalized) identity is HD-derived from the seed, so
        // it needs a full unlock. On a warm resume the mnemonic is intentionally
        // absent — falling back to the active identity here would silently persist
        // the user's MAIN npub onto the very site they asked to compartmentalize away
        // from (an irreversible deanonymization). Refuse instead of leaking.
        if (!deps.wallet.mnemonic) {
          throw new Error(
            'Connecting with a separate per-site identity needs a full unlock. Lock the wallet, reopen and enter your password, then connect again.',
          );
        }
        nostrPubkey = deriveNostrIdentityForOrigin(
          deps.wallet.mnemonic,
          request.origin.origin,
        ).pubkeyHex;
      } else {
        const id = await resolveNostrIdentityForOrigin(deps.wallet, request.origin.origin, undefined);
        nostrPubkey = id?.pubkeyHex;
      }
      return { kind: 'nostrGrant', approved: true, ...(nostrPubkey ? { nostrPubkey } : {}) };
    }

    case 'signNostrEvent': {
      if (request.kind !== 'signNostrEvent') {
        throw new Error('Pending request kind mismatch (expected signNostrEvent)');
      }
      // Resolve WHICH identity this origin signs as (its granted nostrPubkey, or
      // the user's active identity when unset) — account-0 / per-origin / vault.
      const identity = await resolveNostrIdentityForOrigin(
        deps.wallet,
        request.origin.origin,
        request.identityPubkey,
      );
      const result = signNostrEventWith(identity, request.event);
      // Forward a "remember for this session" grant (money-tier kinds are filtered
      // out downstream by the wallet-handler's mergeNostrSession).
      return {
        kind: 'signNostrEvent',
        approved: true,
        result,
        ...(approval.grantSession ? { grantSession: approval.grantSession } : {}),
      };
    }

    case 'appEncKey': {
      if (request.kind !== 'appEncKey') {
        throw new Error('Pending request kind mismatch (expected appEncKey)');
      }
      const publicKey = deriveAppEncKeyWithUnlocked(
        deps.wallet,
        request.domainScope,
        request.context,
      );
      return { kind: 'appEncKey', approved: true, publicKey };
    }

    case 'appSealOpen': {
      if (request.kind !== 'appSealOpen') {
        throw new Error('Pending request kind mismatch (expected appSealOpen)');
      }
      const plaintext = openAppSealWithUnlocked(
        deps.wallet,
        request.domainScope,
        request.sealed,
        request.context,
      );
      return { kind: 'appSealOpen', approved: true, plaintext };
    }

    case 'nostrCrypt': {
      if (request.kind !== 'nostrCrypt') {
        throw new Error('Pending request kind mismatch (expected nostrCrypt)');
      }
      const cryptIdentity = await resolveNostrIdentityForOrigin(
        deps.wallet,
        request.origin.origin,
        request.identityPubkey,
      );
      const data = nostrCryptWith(
        cryptIdentity,
        request.op,
        request.scheme,
        request.peer,
        request.data,
      );
      return { kind: 'nostrCrypt', approved: true, data };
    }

    default: {
      // Exhaustiveness — if a new ApprovalApproval kind is added
      // upstream, TS will fail to narrow `_unreachable` to `never`.
      const _unreachable: never = approval;
      throw new Error(
        `executeApproval: unhandled approval kind: ${JSON.stringify(_unreachable)}`,
      );
    }
  }
}
