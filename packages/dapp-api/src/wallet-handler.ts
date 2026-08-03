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
import { nostrKindTier, isNostrSessionActive, mergeNostrSession } from './nostr-tiers';
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
      const params = req.params as { assets?: SmirkAsset[] };
      const requestedAssets = normalizeAssets(params.assets);

      // Fast path: an already-covered permission on an UNLOCKED wallet
      // serves public keys straight from the cache, no prompt. When the
      // wallet is LOCKED we deliberately fall through to the approval
      // popup instead of returning LOCKED here — the popup renders the
      // unlock screen (ApprovalApp) and only resolves the connect once
      // the user has unlocked. `isUnlocked()` is passive (it just picks
      // fast-path vs. prompt; it never opens a popup).
      const existing = await deps.permissions.get(origin.origin);
      if (
        (await deps.provider.isUnlocked()) &&
        hasAssetsAuthorized(existing, requestedAssets)
      ) {
        await touch(deps.permissions, existing!);
        return await deps.provider.getPublicKeys(existing!.assets);
      }

      // Otherwise prompt (a locked wallet lands here too — the approval
      // popup unlocks first, then shows the connect prompt). User may
      // grant a narrower set than asked.
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
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      const params = req.params as { message: string };
      // Always prompt per-signature. Signatures are auth credentials
      // for the receiving service; auto-signing every request would
      // let a connected origin impersonate the user without a refresh
      // prompt. No pre-check for LOCKED here: the approval popup renders
      // the unlock screen when the wallet is locked, so a locked wallet
      // opens the prompt instead of getting a LOCKED error. The popup
      // computes the signature in its unlocked-wallet context (the seed
      // never reaches this routing layer) and returns the result.
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
      // No LOCKED pre-check — the approval popup unlocks first, then
      // shows the payment confirmation and sends from the unlocked
      // wallet. Asset-scope is still enforced from the stored grant.
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      // Widen the asset to include 'grin' at the type boundary so a grin
      // payment request is REPRESENTABLE and thus explicitly rejectable
      // here (rather than being silently absent from the union). The send
      // path itself narrows back to the four supported chains below.
      const params = req.params as {
        asset: 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
        amount: string;
        address: string;
        memo?: string;
      };
      // Capability boundary: in-page grin sends are not supported yet. The
      // interactive Grin path (deferred to v0.4) would write finalize
      // context into a SendWizard slot it never populates, so the returned
      // S2 could never finalize and would lock the user's inputs for ~7
      // days — a real fund-availability hazard. Reject BEFORE the asset-
      // scope check so this reads as a capability limit, not an auth leak
      // (the rejection must not depend on whether the origin holds a grin
      // grant).
      if (params.asset === 'grin') {
        throw new HandlerError(
          'UNSUPPORTED_ASSET',
          'Grin payments are not supported for in-page requests yet',
        );
      }
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
      // user hasn't seen. No LOCKED pre-check — the approval popup
      // unlocks first, then the claim deposits into the unlocked wallet.
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
      // A standard NIP-07 dapp (Magick Market, any Nostr app) calls
      // window.nostr.getPublicKey() directly and NEVER calls our proprietary
      // connect(). So the Nostr grant IS the connection for a pure-Nostr origin —
      // do NOT require a pre-existing permission. The npub is still a dedicated,
      // cross-site-correlatable disclosure, so it always prompts on first ask.
      //
      // We route through the approval popup when the origin isn't yet
      // granted OR when the wallet is LOCKED. In the locked case the npub
      // can't be read from the (empty) SW public cache, so returning
      // LOCKED here would stop the popup from opening — instead the popup
      // renders the unlock screen (ApprovalApp) first, then the grant
      // disclosure, and only reads the npub once unlocked. `isUnlocked()`
      // stays passive (it just decides fast-path vs. prompt).
      const existing = await deps.permissions.get(origin.origin);
      const alreadyGranted = !!existing && hasNostrAuthorized(existing);
      let perm: OriginPermission | null = existing;
      if (!alreadyGranted || !(await deps.provider.isUnlocked())) {
        const decision = await deps.approval({ kind: 'nostrGrant', origin });
        if (!decision.approved) {
          throw new HandlerError('USER_REJECTED', 'User declined to share their Nostr identity');
        }
        if (decision.kind !== 'nostrGrant') {
          throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
        }
        // Upgrade an existing permission, or CREATE one (no chain assets needed for a
        // pure-Nostr connection). Persist the identity the user chose (their main or a
        // per-origin one) so getNostrPublicKey + signing stay consistent.
        perm = existing
          ? {
              ...existing,
              nostr: true,
              ...(decision.nostrPubkey ? { nostrPubkey: decision.nostrPubkey } : {}),
              lastUsedAt: Date.now(),
            }
          : {
              origin: origin.origin,
              assets: [],
              nostr: true,
              ...(decision.nostrPubkey ? { nostrPubkey: decision.nostrPubkey } : {}),
              ...(origin.siteName ? { siteName: origin.siteName } : {}),
              ...(origin.favicon ? { favicon: origin.favicon } : {}),
              grantedAt: Date.now(),
              lastUsedAt: Date.now(),
            };
        await deps.permissions.set(perm);
      } else {
        // else ⇒ alreadyGranted && unlocked, so `existing` is non-null.
        await touch(deps.permissions, existing!);
      }
      // Prefer the identity the user chose for THIS origin; fall back to the SW
      // public cache (account-0) for a legacy grant that predates the picker.
      return perm?.nostrPubkey ?? (await deps.provider.getNostrPublicKey());
    }

    case 'signNostrEvent': {
      // No LOCKED pre-check — the approval popup renders the unlock
      // screen when locked, then signs with the unlocked wallet. Scope +
      // money-tier session enforcement below all run on the stored grant.
      const perm = await requireOriginPermission(deps.permissions, origin.origin);
      if (!hasNostrAuthorized(perm)) {
        throw new HandlerError(
          'NOT_AUTHORIZED',
          'Origin lacks the Nostr scope — call getNostrPublicKey() first',
        );
      }
      const params = req.params as { event: SmirkNostrUnsignedEvent };
      // Money-tier session model (P4): a Nostr signature is a credential. Money
      // events (17/30402/22242) ALWAYS get an explicit per-event prompt and can
      // never be session-covered; low-tier events (notes/reactions/gift-wraps)
      // may be covered by an active session grant so the wallet auto-signs. The
      // tier + coverage are computed HERE (the enforcement point) — a money kind
      // is reported as never-covered regardless of any stored session.
      const tier = nostrKindTier(params.event.kind);
      const nowMs = Date.now();
      const sessionCovered = isNostrSessionActive(perm.nostrSession, params.event.kind, nowMs);
      const decision = await deps.approval({
        kind: 'signNostrEvent',
        origin,
        ...(perm.nostrPubkey ? { identityPubkey: perm.nostrPubkey } : {}),
        event: params.event,
        tier,
        sessionCovered,
      });
      if (!decision.approved) {
        throw new HandlerError('USER_REJECTED', 'User rejected the Nostr signature request');
      }
      if (decision.kind !== 'signNostrEvent') {
        throw new HandlerError('INTERNAL', `Approval handler returned wrong kind: ${decision.kind}`);
      }
      // Persist a session grant if the user asked for one — mergeNostrSession
      // drops money-tier + non-grantable kinds, so a money event can never be
      // written into a session even if the approval UI tried.
      if (decision.grantSession) {
        const nextSession = mergeNostrSession(perm.nostrSession, decision.grantSession, nowMs);
        await deps.permissions.set({ ...perm, ...(nextSession ? { nostrSession: nextSession } : {}), lastUsedAt: nowMs });
      } else {
        await touch(deps.permissions, perm);
      }
      return decision.result;
    }

    case 'getAppEncryptionKey': {
      // No LOCKED pre-check — the approval popup unlocks first, then
      // derives the key in its unlocked context (the seed never reaches
      // this routing layer). The one-time disclosure still gates below.
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
      // No LOCKED pre-check — the approval popup unlocks first, then
      // opens the sealed box in its unlocked context. Scope gated below.
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
      // No LOCKED pre-check — the approval popup unlocks first, then runs
      // the crypto in its unlocked context. Scope gated below.
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
      // Prompt on this origin's FIRST crypto call. The nostr scope is granted
      // under copy about disclosing an npub, but it also authorizes decrypting
      // anything this identity can open, and that ran with no prompt at all.
      // One prompt on first use makes the real scope visible; later calls stay
      // silent so DM decryption is usable.
      const firstCrypt = !perm.nostrCryptSeen;
      const decision = await deps.approval({
        kind: 'nostrCrypt',
        origin,
        ...(perm.nostrPubkey ? { identityPubkey: perm.nostrPubkey } : {}),
        op,
        scheme: params.scheme ?? 'nip44',
        peer: params.peer,
        data,
        firstGrant: firstCrypt,
      });
      if (decision.approved && firstCrypt) {
        // Remember that the user has now seen what the scope covers. `set` is an
        // upsert that preserves grantedAt, so this does not look like a re-grant.
        await deps.permissions.set({ ...perm, nostrCryptSeen: true });
      }
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
