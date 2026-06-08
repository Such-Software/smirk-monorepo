/**
 * In-popup ApprovalHandler — surfaces the dapp approval prompt as a
 * modal inside the wallet's current React tree, instead of opening
 * a separate native popup window.
 *
 * Used by:
 *  - Tauri desktop (no `chrome.windows.create`, no SW; the
 *    embedded-browser tab dispatches requests to the wallet's main
 *    window where this handler renders the modal in the Browse tab).
 *  - Future Capacitor mobile (same constraint — no separate window,
 *    the approval is an in-app sheet over the active screen).
 *
 * The extension's Chrome MV3 flow uses `chromePopupApprovalHandler`
 * instead, because the SW context can't host a modal — it has to
 * open a foreground popup window where the wallet UI can run.
 *
 * The handler is a single-pending-at-a-time queue: if a second
 * request arrives while one is open, it's denied with a clear error
 * so the dapp can retry. We don't try to stack modals — concurrent
 * approval dialogs are confusing and historically a source of
 * sign-the-wrong-thing UX bugs.
 */

import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResult,
} from '@such-software/smirk-dapp-api';

export interface InPopupApprovalQueue {
  /** ApprovalHandler implementation — pass to `createWalletHandler`. */
  readonly handler: ApprovalHandler;

  /**
   * Subscribe to pending-request changes. The listener is invoked
   * immediately with the current pending (or null), and again on
   * every queue transition. Returns an unsubscribe fn.
   */
  subscribe(listener: (pending: ApprovalRequest | null) => void): () => void;

  /**
   * Resolve the currently-open request with the user's decision.
   * No-op if there is no pending request (e.g., user clicked
   * approve twice — first click already resolved it).
   */
  resolveCurrent(result: ApprovalResult): void;
}

interface QueueEntry {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
}

export function createInPopupApprovalQueue(): InPopupApprovalQueue {
  let current: QueueEntry | null = null;
  const listeners = new Set<(pending: ApprovalRequest | null) => void>();

  const notify = (): void => {
    const snap = current?.request ?? null;
    for (const l of listeners) {
      try {
        l(snap);
      } catch (e) {
        console.error('[in-popup-approval] listener threw:', e);
      }
    }
  };

  const handler: ApprovalHandler = (req) => {
    if (current) {
      // Concurrent approvals would force the user to context-switch
      // and risk approving the wrong request. Reject the newcomer.
      return Promise.resolve({ approved: false } as ApprovalResult);
    }
    return new Promise<ApprovalResult>((resolve) => {
      current = { request: req, resolve };
      notify();
    });
  };

  return {
    handler,
    subscribe(listener) {
      listeners.add(listener);
      listener(current?.request ?? null);
      return () => {
        listeners.delete(listener);
      };
    },
    resolveCurrent(result) {
      const c = current;
      if (!c) return;
      current = null;
      c.resolve(result);
      notify();
    },
  };
}
