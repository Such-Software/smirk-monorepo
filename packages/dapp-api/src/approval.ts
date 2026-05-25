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
  SmirkPaymentResult,
  SmirkSignResult,
} from './protocol';

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
