/**
 * Wallet-side request dispatcher. Same logic across every platform —
 * the platform supplies a WalletProvider, OriginPermissionStore, and
 * ApprovalHandler; this function turns wire requests into wire
 * responses, applying permission checks + approval prompts in
 * between.
 *
 * Stateless: everything per-request comes through the call, nothing
 * is cached in module scope. That matters for MV3 service workers
 * (which get evicted between requests) and for tests (clean per-call
 * setup).
 *
 * **Why sign/payment/claim go through the approval handler, not the
 * provider.** The approval-handling context (popup window on
 * extension, in-app modal on Capacitor, named window on Tauri) is
 * also the only context that holds the unlocked seed. We don't
 * round-trip key material back into the dispatcher — the approval
 * handler returns the already-computed result. The provider is
 * restricted to public, cache-friendly metadata.
 */

import { ApprovalHandler, OriginContext } from './approval';
import {
  hasAssetsAuthorized,
  OriginPermission,
  OriginPermissionStore,
} from './permissions';
import { WalletProvider } from './provider';
import {
  ALL_ASSETS,
  PROTOCOL_VERSION,
  SmirkAsset,
  SmirkErrorCode,
  SmirkMethod,
  SmirkPublicKeys,
  SmirkWireRequest,
  SmirkWireResponse,
} from './protocol';

export interface WalletHandlerDeps {
  provider: WalletProvider;
  permissions: OriginPermissionStore;
  approval: ApprovalHandler;
}

/** Entry point. Platform adapter wires the transport to call this. */
export type WalletHandlerDispatch = <M extends SmirkMethod>(
  req: SmirkWireRequest<M>,
  origin: OriginContext,
) => Promise<SmirkWireResponse<M>>;

export function createWalletHandler(
  deps: WalletHandlerDeps,
): WalletHandlerDispatch {
  return async function dispatch<M extends SmirkMethod>(
    req: SmirkWireRequest<M>,
    origin: OriginContext,
  ): Promise<SmirkWireResponse<M>> {
    if (req.v !== PROTOCOL_VERSION) {
      return errResp(req, 'PROTOCOL_MISMATCH', `Wallet speaks protocol v${PROTOCOL_VERSION}, page sent v${req.v}`);
    }
    try {
      const result = await dispatchInner(req, origin, deps);
      return okResp(req, result as SmirkWireResponse<M>['result']);
    } catch (e) {
      if (e instanceof HandlerError) {
        return errResp(req, e.code, e.message);
      }
      console.error('[smirk-dapp-api] handler exception:', e);
      return errResp(
        req,
        'INTERNAL',
        e instanceof Error ? e.message : 'unknown error',
      );
    }
  };
}

// ============================================================================
// Per-method dispatch
// ============================================================================

async function dispatchInner<M extends SmirkMethod>(
  req: SmirkWireRequest<M>,
  origin: OriginContext,
  deps: WalletHandlerDeps,
): Promise<unknown> {
  switch (req.method) {
    case 'isConnected': {
      // No unlock required — this is the page asking whether it
      // already has any permission. Safe to answer when locked
      // (otherwise pages couldn't render their "Connect" button
      // without prompting the user to unlock first).
      const perm = await deps.permissions.get(origin.origin);
      return perm !== null;
    }

    case 'disconnect': {
      await deps.permissions.remove(origin.origin);
      return { ok: true as const };
    }

    case 'connect': {
      await assertUnlocked(deps.provider);
      const params = req.params as { assets?: SmirkAsset[] };
      const requestedAssets = normalizeAssets(params.assets);

      // If we already have a permission that covers the request,
      // skip the prompt — returns immediately.
      const existing = await deps.permissions.get(origin.origin);
      if (hasAssetsAuthorized(existing, requestedAssets)) {
        await touch(deps.permissions, existing!);
        return await deps.provider.getPublicKeys(existing!.assets);
      }

      // Otherwise prompt. User may grant a narrower set than asked.
      const decision = await deps.approval({
        kind: 'connect',
        origin,
        requestedAssets,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the connection');
      }
      if (decision.kind !== 'connect') {
        throw new HandlerError(
          'INTERNAL',
          `Approval handler returned wrong kind: ${decision.kind}`,
        );
      }
      const approvedAssets = decision.approvedAssets;
      // Persist (merge with existing if the user is upgrading scope).
      const next: OriginPermission = {
        origin: origin.origin,
        assets: existing
          ? Array.from(new Set([...existing.assets, ...approvedAssets]))
          : approvedAssets,
        ...(origin.siteName ? { siteName: origin.siteName } : {}),
        ...(origin.favicon ? { favicon: origin.favicon } : {}),
        grantedAt: existing?.grantedAt ?? Date.now(),
        lastUsedAt: Date.now(),
      };
      await deps.permissions.set(next);
      return await deps.provider.getPublicKeys(approvedAssets);
    }

    case 'getPublicKeys': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      await touch(deps.permissions, perm);
      return await deps.provider.getPublicKeys(perm.assets);
    }

    case 'getAddresses': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      await touch(deps.permissions, perm);
      return await deps.provider.getAddresses(perm.assets);
    }

    case 'signMessage': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      const params = req.params as { message: string };
      // Always prompt per-signature. Signatures are auth credentials
      // for the receiving service; auto-signing every request would
      // let a connected origin impersonate the user without a refresh
      // prompt. Approval popup computes the signature in its
      // unlocked-wallet context and returns the result.
      const decision = await deps.approval({
        kind: 'signMessage',
        origin,
        message: params.message,
        assets: perm.assets,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the signature request');
      }
      if (decision.kind !== 'signMessage') {
        throw new HandlerError(
          'INTERNAL',
          `Approval handler returned wrong kind: ${decision.kind}`,
        );
      }
      await touch(deps.permissions, perm);
      return decision.result;
    }

    case 'requestPayment': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      const params = req.params as {
        asset: 'btc' | 'ltc' | 'xmr' | 'wow';
        amount: string;
        address: string;
        memo?: string;
      };
      if (!perm.assets.includes(params.asset)) {
        throw new HandlerError(
          'NOT_AUTHORIZED',
          `Origin not authorized for ${params.asset}`,
        );
      }
      const decision = await deps.approval({
        kind: 'requestPayment',
        origin,
        asset: params.asset,
        amount: params.amount,
        address: params.address,
        ...(params.memo !== undefined ? { memo: params.memo } : {}),
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the payment request');
      }
      if (decision.kind !== 'requestPayment') {
        throw new HandlerError(
          'INTERNAL',
          `Approval handler returned wrong kind: ${decision.kind}`,
        );
      }
      await touch(deps.permissions, perm);
      return decision.result;
    }

    case 'claimPublicTip': {
      // Public tips are receiving funds — no asset-scope permission
      // required (anyone with the URL fragment can claim). We still
      // require unlock so the popup has somewhere to deposit them,
      // and we still prompt the user to confirm so a hostile page
      // can't silently fire a claim that pre-confirms a tip the
      // user hasn't seen.
      await assertUnlocked(deps.provider);
      const params = req.params as { tipId: string; fragmentKey: string };
      const decision = await deps.approval({
        kind: 'claimPublicTip',
        origin,
        tipId: params.tipId,
        fragmentKey: params.fragmentKey,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the tip claim');
      }
      if (decision.kind !== 'claimPublicTip') {
        throw new HandlerError(
          'INTERNAL',
          `Approval handler returned wrong kind: ${decision.kind}`,
        );
      }
      return decision.result;
    }

    default: {
      // Exhaustiveness check — the switch above covers every
      // SmirkMethod. If a new method gets added to the map without
      // a case here, TS catches it at compile time AND we fall
      // through to a runtime UNSUPPORTED.
      const _exhaustive: never = req.method as never;
      void _exhaustive;
      throw new HandlerError('UNSUPPORTED', `Method not implemented: ${req.method}`);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

class HandlerError extends Error {
  constructor(
    public readonly code: SmirkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

async function assertUnlocked(provider: WalletProvider): Promise<void> {
  if (!(await provider.isUnlocked())) {
    throw new HandlerError(
      'LOCKED',
      'Wallet is locked — user must unlock before this operation',
    );
  }
}

async function requireOriginPermission(
  store: OriginPermissionStore,
  origin: string,
): Promise<OriginPermission> {
  const perm = await store.get(origin);
  if (!perm) {
    throw new HandlerError(
      'NOT_CONNECTED',
      'Origin is not connected — call connect() first',
    );
  }
  return perm;
}

async function touch(
  store: OriginPermissionStore,
  perm: OriginPermission,
): Promise<void> {
  // Bump lastUsedAt so Settings shows the most-recent activity and
  // a future auto-revoke-idle policy has a real timestamp to work
  // against. Fire-and-forget — we don't want a slow storage write
  // to slow down the request.
  void store.set({ ...perm, lastUsedAt: Date.now() }).catch((e) => {
    console.warn('[smirk-dapp-api] failed to touch permission:', e);
  });
}

function normalizeAssets(assets?: SmirkAsset[]): SmirkAsset[] {
  if (!assets || assets.length === 0) return [...ALL_ASSETS];
  // De-duplicate + drop unknown asset names. Preserves caller order
  // for the asset that survives so deterministic tests are easy.
  const seen = new Set<SmirkAsset>();
  const out: SmirkAsset[] = [];
  for (const a of assets) {
    if (ALL_ASSETS.includes(a) && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

// ============================================================================
// Envelope helpers
// ============================================================================

function okResp<M extends SmirkMethod>(
  req: SmirkWireRequest<M>,
  result: SmirkWireResponse<M>['result'],
): SmirkWireResponse<M> {
  return {
    type: 'SMIRK_RESPONSE',
    v: PROTOCOL_VERSION,
    id: req.id,
    ...(result !== undefined ? { result } : {}),
  };
}

function errResp<M extends SmirkMethod>(
  req: SmirkWireRequest<M>,
  code: SmirkErrorCode,
  message: string,
): SmirkWireResponse<M> {
  return {
    type: 'SMIRK_RESPONSE',
    v: PROTOCOL_VERSION,
    id: req.id,
    error: { code, message },
  };
}

/** Convenience: an empty per-asset-null public-keys object. Useful
 *  for provider impls that need to start from a zeroed base. */
export function emptyPublicKeys(): SmirkPublicKeys {
  return {
    btc: null,
    ltc: null,
    xmr: null,
    wow: null,
    grin: null,
  };
}
