/**
 * User-approval flow contract. The wallet-handler asks the platform
 * "is the user OK with this?", the platform opens whatever UI is
 * native (popup window for an extension, modal for Capacitor, named
 * window for Tauri) and resolves with the decision.
 *
 * **Why approval-handler returns the computed result, not just yes/no.**
 * The unlocked wallet (seed, derived keys) lives in the trusted UI
 * context — popup window on extension, in-app screen on Capacitor,
 * named window on Tauri. The wallet *handler* itself runs in a
 * stateless routing context (MV3 service worker, mobile background
 * thread, Tauri main process) that intentionally does NOT hold
 * plaintext key material at rest. So when the user approves a sign /
 * payment / claim, the same context that prompted them also performs
 * the operation; we return the computed signature / txid back through
 * the approval channel instead of round-tripping unlocked-wallet state
 * back into the handler. This keeps the secret-bearing context tiny
 * and audit-friendly.
 *
 * The handler is approval-method-agnostic — it just gets a yes/no
 * (with the user's optional asset-scope refinement for `connect`, or
 * the operation result for everything else).
 */

import {
  SmirkAsset,
  SmirkClaimResult,
  SmirkNostrSignedEvent,
  SmirkNostrUnsignedEvent,
  SmirkPaymentResult,
  SmirkSignResult,
} from './protocol';
import type { NostrKindTier } from './nostr-tiers';

/** Origin metadata the wallet shows the user. The page-context API
 *  reads `document.title` and `window.location.origin` and forwards
 *  them via the transport so the wallet-side prompt can render them
 *  without trusting the page further than necessary. */
export interface OriginContext {
  origin: string;
  siteName?: string;
  favicon?: string;
}

/** Discriminated union of what we'd ever prompt for. Lets the
 *  platform implementation render a single ApprovalScreen with a
 *  switch on kind, instead of N separate UIs. */
export type ApprovalRequest =
  | {
      kind: 'connect';
      origin: OriginContext;
      /** Assets the dapp asked for (empty = "all"). User can
       *  approve, deny, OR approve a narrower subset. */
      requestedAssets: SmirkAsset[];
    }
  | {
      kind: 'signMessage';
      origin: OriginContext;
      /** Message bytes the dapp wants signed. Wallet shows the
       *  decoded UTF-8 string when printable, hex otherwise. */
      message: string;
      /** Assets the origin is authorized for. The approval UI signs
       *  with each, since dapps that ask for a multi-asset wallet
       *  typically want a signature per asset they care about. */
      assets: SmirkAsset[];
    }
  | {
      kind: 'requestPayment';
      origin: OriginContext;
      asset: 'btc' | 'ltc' | 'xmr' | 'wow';
      /** Atomic-units string. Wallet formats for display. */
      amount: string;
      address: string;
      memo?: string;
    }
  | {
      kind: 'claimPublicTip';
      origin: OriginContext;
      tipId: string;
      fragmentKey: string;
    }
  | {
      kind: 'nostrGrant';
      origin: OriginContext;
    }
  | {
      kind: 'signNostrEvent';
      origin: OriginContext;
      /** x-only pubkey (hex) of the identity this origin signs as — from its
       *  OriginPermission.nostrPubkey. Absent = the user's active identity. The
       *  executor resolves it (account-0 / per-origin / vault) via the wallet. */
      identityPubkey?: string;
      /** The unsigned event the page wants signed. The wallet renders a human
       *  summary (NIP-98 login to <url>, a note, …) from kind + tags. */
      event: SmirkNostrUnsignedEvent;
      /** Risk tier of this event's kind (see nostr-tiers.ts). `money` events must
       *  get a strong warning and NO "allow for session" option; `session-grantable`
       *  may offer one; `default` prompts per-event. */
      tier: NostrKindTier;
      /** True when an active session already covers this kind — the wallet may
       *  auto-approve + sign silently. The handler sets this to false for any
       *  money-tier kind, so money events always prompt. */
      sessionCovered: boolean;
    }
  | {
      kind: 'appEncKey';
      origin: OriginContext;
      /** Wallet-verified derivation scope (the origin), NEVER page-supplied.
       *  The handler sets this; the executor derives on it verbatim. */
      domainScope: string;
      /** Sub-scope within the origin (e.g. `sso`). Empty = the default key. */
      context: string;
      /** True on the origin's FIRST e2ee use — the screen shows the disclosure
       *  and approving grants the scope. False = re-derive under an already-
       *  granted scope; the screen auto-approves (deriving a public key, no
       *  fresh decision). */
      firstGrant: boolean;
    }
  | {
      kind: 'appSealOpen';
      origin: OriginContext;
      /** Wallet-verified derivation scope (the origin), NEVER page-supplied. */
      domainScope: string;
      context: string;
      /** base64 libsodium `crypto_box_seal` envelope to open with the app key. */
      sealed: string;
    }
  | {
      kind: 'nostrCrypt';
      origin: OriginContext;
      /** x-only pubkey (hex) of the identity this origin encrypts/decrypts as —
       *  from its OriginPermission.nostrPubkey. Absent = the user's active identity. */
      identityPubkey?: string;
      /** encrypt plaintext → ciphertext, or decrypt ciphertext → plaintext. */
      op: 'encrypt' | 'decrypt';
      scheme: 'nip44' | 'nip04';
      /** Counterparty x-only pubkey (hex). */
      peer: string;
      /** The input: plaintext (encrypt) or ciphertext (decrypt). */
      data: string;
    };

/** Approval result. Each non-rejected branch carries the computed
 *  operation result, since the unlocked-wallet context is the same
 *  place that runs the approval UI (see file header). */
export type ApprovalResult =
  | {
      kind: 'connect';
      approved: true;
      /** Assets the user actually granted (may be a subset of
       *  `requestedAssets`). Persisted into OriginPermission. */
      approvedAssets: SmirkAsset[];
    }
  | {
      kind: 'signMessage';
      approved: true;
      result: SmirkSignResult;
    }
  | {
      kind: 'requestPayment';
      approved: true;
      result: SmirkPaymentResult;
    }
  | {
      kind: 'claimPublicTip';
      approved: true;
      result: SmirkClaimResult;
    }
  | {
      kind: 'nostrGrant';
      approved: true;
    }
  | {
      kind: 'signNostrEvent';
      approved: true;
      result: SmirkNostrSignedEvent;
      /** Set when the user chose "allow for this session" — the handler persists a
       *  time-boxed grant (money-tier kinds are filtered out before persisting). */
      grantSession?: { kinds: number[]; expiresAt: number };
    }
  | {
      kind: 'appEncKey';
      approved: true;
      /** The derived x25519 public key (hex) for (domainScope, context). */
      publicKey: string;
    }
  | {
      kind: 'appSealOpen';
      approved: true;
      /** base64 of the opened plaintext bytes. */
      plaintext: string;
    }
  | {
      kind: 'nostrCrypt';
      approved: true;
      /** The output: ciphertext (encrypt) or plaintext (decrypt). */
      data: string;
    }
  | { approved: false };

/** Platform-side approval entry point. Implementation owns:
 *    - opening the approval UI (popup window / modal / Tauri window)
 *    - waiting for the user's decision (resolve / reject the Promise)
 *    - cleaning up the UI when done
 *  Handler does NOT race a timeout — the user is allowed to take as
 *  long as they want. If the platform wants a timeout it can layer
 *  one on internally and reject. */
export type ApprovalHandler = (
  req: ApprovalRequest,
) => Promise<ApprovalResult>;
