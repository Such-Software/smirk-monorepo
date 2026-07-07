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
  hasNostrAuthorized,
  hasE2eeAuthorized,
  OriginPermission,
  OriginPermissionStore,
} from './permissions';
import { WalletProvider } from './provider';
import {
  ALL_ASSETS,
  APP_ENC_SCHEME,
  PROTOCOL_VERSION,
  SmirkAsset,
  SmirkErrorCode,
  SmirkMethod,
  SmirkNostrUnsignedEvent,
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

    case 'getBackend': {
      // Non-secret config (which backend the wallet targets). Requires a
      // connection so random pages can't probe it, but no per-call prompt.
      await assertUnlocked(deps.provider);
      await requireOriginPermission(deps.permissions, origin.origin);
      return { url: await deps.provider.getBackendUrl() };
    }

    case 'getNostrPublicKey': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      if (!hasNostrAuthorized(perm)) {
        // First npub read prompts a DEDICATED grant — the npub is a distinct,
        // cross-site-correlatable disclosure, never bundled into connect().
        const decision = await deps.approval({ kind: 'nostrGrant', origin });
        if (!decision.approved) {
          throw new HandlerError('USER_REJECTED', 'User declined to share their Nostr identity');
        }
        if (decision.kind !== 'nostrGrant') {
          throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
        }
        await deps.permissions.set({ ...perm, nostr: true, lastUsedAt: Date.now() });
      } else {
        await touch(deps.permissions, perm);
      }
      return await deps.provider.getNostrPublicKey();
    }

    case 'signNostrEvent': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      if (!hasNostrAuthorized(perm)) {
        throw new HandlerError(
          'NOT_AUTHORIZED',
          'Origin lacks the Nostr scope — call getNostrPublicKey() first',
        );
      }
      const params = req.params as { event: SmirkNostrUnsignedEvent };
      // Prompt per-signature (like signMessage) — a Nostr signature is an
      // auth/publish credential; auto-signing would let a connected origin act
      // as the user without a fresh prompt.
      const decision = await deps.approval({
        kind: 'signNostrEvent',
        origin,
        event: params.event,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the Nostr signature request');
      }
      if (decision.kind !== 'signNostrEvent') {
        throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
      }
      await touch(deps.permissions, perm);
      return decision.result;
    }

    case 'getAppEncryptionKey': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      const params = req.params as { context?: string };
      const context = params.context ?? '';
      // domainScope is the VERIFIED origin, set here — never a page string.
      const firstGrant = !hasE2eeAuthorized(perm);
      // The executor derives in its unlocked context (the pubkey is public but
      // needs the seed). `firstGrant` drives the one-time disclosure; a
      // re-derive under an existing grant auto-approves (deriving a public key
      // is not a fresh decision, and it's the origin's OWN key).
      const decision = await deps.approval({
        kind: 'appEncKey',
        origin,
        domainScope: origin.origin,
        context,
        firstGrant,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User declined the encryption-key request');
      }
      if (decision.kind !== 'appEncKey') {
        throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
      }
      if (firstGrant) {
        // Persist the scope so subsequent derive/open skip the disclosure.
        await deps.permissions.set({ ...perm, e2ee: true, lastUsedAt: Date.now() });
      } else {
        await touch(deps.permissions, perm);
      }
      return { publicKey: decision.publicKey, scheme: APP_ENC_SCHEME };
    }

    case 'appSealOpen': {
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      if (!hasE2eeAuthorized(perm)) {
        throw new HandlerError(
          'NOT_AUTHORIZED',
          'Origin lacks the e2ee scope — call getAppEncryptionKey() first',
        );
      }
      const params = req.params as { sealed: string; context?: string };
      const decision = await deps.approval({
        kind: 'appSealOpen',
        origin,
        domainScope: origin.origin,
        context: params.context ?? '',
        sealed: params.sealed,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User declined the decryption request');
      }
      if (decision.kind !== 'appSealOpen') {
        throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
      }
      await touch(deps.permissions, perm);
      return { plaintext: decision.plaintext };
    }

    case 'nostrEncrypt':
    case 'nostrDecrypt': {
      // NIP-07 DM crypto: low-tier, requires the Nostr scope (same one-time grant
      // as getNostrPublicKey). Runs silently once granted — a per-call prompt on
      // every DM decrypt would be unusable (matches Goblin's session model, where
      // 1/7/1059 are session-grantable and only 17/30402/22242 are money-tier).
      await assertUnlocked(deps.provider);
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      if (!hasNostrAuthorized(perm)) {
        throw new HandlerError(
          'NOT_AUTHORIZED',
          'Origin lacks the Nostr scope — call getNostrPublicKey() first',
        );
      }
      const op = req.method === 'nostrEncrypt' ? 'encrypt' : 'decrypt';
      const params = req.params as {
        peer: string;
        scheme?: 'nip44' | 'nip04';
        plaintext?: string;
        ciphertext?: string;
      };
      const data = (op === 'encrypt' ? params.plaintext : params.ciphertext) ?? '';
      const decision = await deps.approval({
        kind: 'nostrCrypt',
        origin,
        op,
        scheme: params.scheme ?? 'nip44',
        peer: params.peer,
        data,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User declined the encryption request');
      }
      if (decision.kind !== 'nostrCrypt') {
        throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
      }
      await touch(deps.permissions, perm);
      return decision.data;
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
