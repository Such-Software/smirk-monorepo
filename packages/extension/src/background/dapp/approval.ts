/**
 * Chrome-side `ApprovalHandler`. Opens the popup as a standalone
 * window scoped to a single pending request, waits for the popup to
 * write back the user's decision, returns it.
 *
 * **Why a standalone window, not the action popup?** The action
 * popup closes on focus loss: a long approval flow (read message
 * → think → click) often loses focus to the page being dappified,
 * making the prompt disappear mid-decision. A `chrome.windows.create`
 * popup stays open until the popup code closes it explicitly.
 *
 * **MV3 SW eviction safety.** Pending requests and the user's
 * decision both live in `chrome.storage.session`, which survives SW
 * eviction between request kick-off and resolution. The handler
 * subscribes to `chrome.storage.onChanged` for the result key,
 * which fires even if the SW was just respawned to deliver the
 * event.
 */

import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResult,
} from '@such-software/smirk-dapp-api';

const PENDING_PREFIX = 'smirk:dapp:approval-pending:';
const RESULT_PREFIX = 'smirk:dapp:approval-result:';

/** Approval requests can hang while the user thinks. We do NOT
 *  expire them: a user may legitimately leave the prompt open for
 *  minutes. The page-side transport has its own 5-minute timeout
 *  which converts to a USER_REJECTED error on the dapp side, but
 *  the wallet side leaves the storage record for forensics. */

function pendingKey(id: string): string {
  return `${PENDING_PREFIX}${id}`;
}
function resultKey(id: string): string {
  return `${RESULT_PREFIX}${id}`;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Public format the popup reads. Same shape the popup writes back
 *  to `smirk:dapp:approval-result:<id>` when the user decides. */
export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  /** Unix ms when the SW posted the prompt. Popup may show "open
   *  for Ns" to remind the user the request is theirs. */
  createdAt: number;
}

export function chromePopupApprovalHandler(): ApprovalHandler {
  return async function requestApproval(
    req: ApprovalRequest,
  ): Promise<ApprovalResult> {
    const id = nextId();
    const pending: PendingApproval = {
      id,
      request: req,
      createdAt: Date.now(),
    };
    await chrome.storage.session.set({ [pendingKey(id)]: pending });

    // Open the popup as its own window scoped to this approval. The
    // popup's route parser sees `#approval/<id>` and renders the
    // ApprovalScreen reading from chrome.storage.session.
    const popupUrl = chrome.runtime.getURL(`popup.html#approval/${id}`);
    const win = await chrome.windows.create({
      url: popupUrl,
      type: 'popup',
      // Reasonable wallet popup dimensions. Specific to Chromium;
      // Firefox honors the same fields.
      width: 420,
      height: 640,
      focused: true,
    });

    // Wait for the popup to write back a result. Listener fires
    // even after SW eviction because chrome.storage.onChanged is a
    // SW-friendly event.
    try {
      return await waitForResult(id);
    } finally {
      // Best-effort cleanup of both keys + the window. Errors here
      // don't matter: eventually the storage shape garbage-collects
      // itself if a popup gets killed mid-flow.
      try {
        await chrome.storage.session.remove([pendingKey(id), resultKey(id)]);
      } catch {
        /* ignore */
      }
      if (win?.id !== undefined) {
        try {
          await chrome.windows.remove(win.id);
        } catch {
          /* user may have closed it already */
        }
      }
    }
  };
}

function waitForResult(id: string): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    const key = resultKey(id);

    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'session') return;
      const change = changes[key];
      if (!change || change.newValue === undefined) return;
      chrome.storage.onChanged.removeListener(listener);
      resolve(change.newValue as ApprovalResult);
    };
    chrome.storage.onChanged.addListener(listener);

    // Race condition guard: the popup may write the result BEFORE
    // our listener registers (cold SW + fast clicker). Check
    // immediately after subscribing.
    void chrome.storage.session.get(key).then((existing) => {
      const v = existing[key];
      if (v !== undefined) {
        chrome.storage.onChanged.removeListener(listener);
        resolve(v as ApprovalResult);
      }
    });
  });
}

/** Popup-side helper. Used by the ApprovalScreen route to read the
 *  pending request and write the decision back. */
export const approvalPopupBridge = {
  async readPending(id: string): Promise<PendingApproval | null> {
    const res = await chrome.storage.session.get(pendingKey(id));
    return (res[pendingKey(id)] as PendingApproval | undefined) ?? null;
  },
  async writeResult(id: string, result: ApprovalResult): Promise<void> {
    await chrome.storage.session.set({ [resultKey(id)]: result });
  },
};
