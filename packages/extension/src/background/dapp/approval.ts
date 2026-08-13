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
 *
 * **Abuse control.** Every consent-gated method lands here, and
 * `chrome.windows.create({ focused: true })` steals focus, so an
 * unthrottled handler lets any page open approval windows in a loop
 * until the browser is unusable (and spam the user into clicking
 * through). Three bounds, all enforced below:
 *   1. one approval window at a time (requests serialise on a queue),
 *   2. a bounded queue, and an origin that isn't connected yet never
 *      queues at all (it is rejected while a prompt is open, since
 *      it can generate those requests at will),
 *   3. a per-origin sliding-window cap on how many prompts an origin
 *      may open.
 * The counters are module state, so an SW eviction resets them. That
 * is fine: a page spamming requests keeps the SW alive, and the
 * one-window invariant is what the counters exist to protect.
 */

import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResult,
} from '@such-software/smirk-dapp-api';

import { chromeStoragePermissionStore } from './permissions';

const PENDING_PREFIX = 'smirk:dapp:approval-pending:';
const RESULT_PREFIX = 'smirk:dapp:approval-result:';

/** Approval requests can hang while the user thinks. We do NOT
 *  expire them: a user may legitimately leave the prompt open for
 *  minutes. The page-side transport has its own 5-minute timeout
 *  which converts to a USER_REJECTED error on the dapp side, but
 *  the wallet side leaves the storage record for forensics. */

/** How many requests may wait behind the open prompt before the rest
 *  are rejected. Small on purpose: a queued request is a window the
 *  user will be shown, so the queue is a spam budget, not a buffer. */
const MAX_QUEUED_APPROVALS = 3;
/** Sliding window for the per-origin prompt cap. */
const ORIGIN_RATE_WINDOW_MS = 60_000;
/** Prompts a single origin may open per `ORIGIN_RATE_WINDOW_MS`. Well
 *  above what a human can click through, so a real dapp flow (connect,
 *  sign, pay) never sees it. */
const MAX_PROMPTS_PER_ORIGIN = 10;

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

/** Tail of the approval queue. Resolved (never rejected) when the
 *  holder releases the slot, so a failed approval cannot poison the
 *  queue for the next one. */
let queueTail: Promise<void> = Promise.resolve();
/** Requests currently holding OR waiting for the single slot. */
let slotHolders = 0;
/** origin -> unix ms of the prompts it opened inside the rate window. */
const promptsByOrigin = new Map<string, number[]>();

/** Drop origins whose most recent prompt fell out of the rate window,
 *  so a page that cycles through subdomains can't grow the map. */
function pruneOriginPrompts(now: number): void {
  for (const [origin, hits] of promptsByOrigin) {
    const last = hits[hits.length - 1];
    if (last === undefined || now - last >= ORIGIN_RATE_WINDOW_MS) {
      promptsByOrigin.delete(origin);
    }
  }
}

/** True when this origin has already opened its allowance of prompts.
 *  Records the prompt when it doesn't (only opened prompts count, so a
 *  rejected burst can't lock an origin out for longer than it earned). */
function rateLimitOrigin(origin: string, now: number): boolean {
  const hits = (promptsByOrigin.get(origin) ?? []).filter(
    (t) => now - t < ORIGIN_RATE_WINDOW_MS,
  );
  if (hits.length >= MAX_PROMPTS_PER_ORIGIN) {
    promptsByOrigin.set(origin, hits);
    return true;
  }
  hits.push(now);
  promptsByOrigin.set(origin, hits);
  return false;
}

/** Run `open` with exclusive ownership of the one approval window.
 *  Each caller parks on the previous caller's release and always
 *  releases its own, including on throw, so nothing deadlocks the
 *  queue. */
async function withApprovalSlot(
  open: () => Promise<ApprovalResult>,
): Promise<ApprovalResult> {
  const previous = queueTail;
  let release: () => void = () => undefined;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await open();
  } finally {
    release();
  }
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
  const permissions = chromeStoragePermissionStore();
  return async function requestApproval(
    req: ApprovalRequest,
  ): Promise<ApprovalResult> {
    const origin = req.origin.origin;
    // Take the place in line synchronously: the checks below await
    // storage, and without the reservation a burst of concurrent
    // requests would all read an empty queue and pile in together.
    const ahead = slotHolders;
    slotHolders += 1;
    try {
      if (ahead > 0) {
        if (ahead > MAX_QUEUED_APPROVALS) {
          throw new Error(
            'Smirk: too many approval requests are already waiting. Answer the open prompt first.',
          );
        }
        // An origin with no grant yet can produce these at will, so it
        // never gets to hold a place in the queue; it is told to retry
        // once the user has dealt with the open prompt.
        const perm = await permissions.get(origin);
        if (!perm) {
          throw new Error(
            'Smirk: another approval prompt is already open. Answer it, then try again.',
          );
        }
      }
      const now = Date.now();
      pruneOriginPrompts(now);
      if (rateLimitOrigin(origin, now)) {
        throw new Error(
          'Smirk: too many approval prompts from this site. Try again in a minute.',
        );
      }
      return await withApprovalSlot(() => openApprovalWindow(req));
    } finally {
      slotHolders -= 1;
    }
  };
}

/** The single-prompt flow: post the pending request, open the window,
 *  wait for the decision, clean both up. Runs while holding the slot. */
async function openApprovalWindow(
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
    return await waitForResult(id, win?.id);
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
}

function waitForResult(
  id: string,
  windowId: number | undefined,
): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    const key = resultKey(id);
    let settled = false;

    const settle = (result: ApprovalResult) => {
      if (settled) return;
      settled = true;
      chrome.storage.onChanged.removeListener(listener);
      if (windowId !== undefined) {
        chrome.windows.onRemoved.removeListener(onWindowClosed);
      }
      resolve(result);
    };

    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'session') return;
      const change = changes[key];
      if (!change || change.newValue === undefined) return;
      settle(change.newValue as ApprovalResult);
    };
    chrome.storage.onChanged.addListener(listener);

    // A window the user dismisses without deciding must not hold the
    // approval slot (or the dapp's call) open forever: treat the close
    // as a denial, which is also the fail-closed answer.
    const onWindowClosed = (closedId: number) => {
      if (closedId !== windowId) return;
      // The popup writes its decision and closes itself ~50ms later, so
      // the removal event can still beat the storage event. Re-read the
      // key before calling this a denial.
      void chrome.storage.session.get(key).then((existing) => {
        const v = existing[key];
        settle(v !== undefined ? (v as ApprovalResult) : { approved: false });
      });
    };
    if (windowId !== undefined) {
      chrome.windows.onRemoved.addListener(onWindowClosed);
    }

    // Race condition guard: the popup may write the result BEFORE
    // our listener registers (cold SW + fast clicker). Check
    // immediately after subscribing.
    void chrome.storage.session.get(key).then((existing) => {
      const v = existing[key];
      if (v !== undefined) {
        settle(v as ApprovalResult);
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
