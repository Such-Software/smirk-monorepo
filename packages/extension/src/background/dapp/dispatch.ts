/**
 * Glues `chrome.runtime.onMessage` to the transport-agnostic
 * `WalletHandlerDispatch` from `@such-software/smirk-dapp-api`.
 *
 * **Why a separate file from `background/index.ts`.** The SW root
 * file is the boot script — it has to stay short, predictable, and
 * import-only-what-it-must (MV3 SW eviction means every wake-up
 * re-evaluates the file, so heavy top-level work multiplies startup
 * latency for unrelated events like alarms). The dapp dispatcher is
 * self-contained enough to live behind a single `installDappBridge()`
 * call.
 *
 * **MV3 sendResponse + async pattern.** Returning `true` from the
 * onMessage listener keeps the message channel open so we can call
 * `sendResponse` from a Promise resolution. If we forgot the `true`,
 * chrome would close the channel synchronously and the page would
 * get `chrome.runtime.lastError: "The message port closed before a
 * response was received."` — exactly the bug we've seen before on
 * cross-context messaging.
 */

import {
  createWalletHandler,
  PROTOCOL_VERSION,
  SmirkWireRequest,
  SmirkWireResponse,
  type OriginContext,
} from '@such-software/smirk-dapp-api';

import { chromePopupApprovalHandler } from './approval';
import { chromeStoragePermissionStore } from './permissions';
import { chromePublicCacheProvider } from './provider';

/**
 * Wire the dapp-api handler into the SW's onMessage channel. Call
 * exactly once from `background/index.ts` after the SW's other
 * listeners are registered.
 *
 * The listener is a typed gatekeeper: it only handles messages with
 * our discriminator/version, ignores everything else so other SW
 * features (PING, future commands) keep working unaffected.
 */
export function installDappBridge(): void {
  const handler = createWalletHandler({
    provider: chromePublicCacheProvider(),
    permissions: chromeStoragePermissionStore(),
    approval: chromePopupApprovalHandler(),
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isWireRequest(message)) return; // not ours — let other listeners handle it
    const origin = deriveOrigin(sender);
    if (!origin) {
      // No verifiable origin (e.g., a popup-side message). Refuse —
      // permissions are origin-scoped and an unknown origin can't
      // satisfy any of them.
      sendResponse({
        type: 'SMIRK_RESPONSE',
        v: PROTOCOL_VERSION,
        id: message.id,
        error: {
          code: 'INTERNAL',
          message: 'Could not determine sender origin',
        },
      } satisfies SmirkWireResponse);
      return false;
    }

    // Fire-and-forget the handler call; resolve sendResponse with
    // its result. The `return true` below keeps the channel open
    // for the async response.
    void handler(message, origin)
      .then((resp) => sendResponse(resp))
      .catch((e) => {
        // Defense in depth: handler() always wraps internally and
        // resolves with an error envelope, but if something
        // misbehaves we don't want to leave the channel hanging.
        console.error('[smirk-dapp-bridge] unexpected handler throw:', e);
        sendResponse({
          type: 'SMIRK_RESPONSE',
          v: PROTOCOL_VERSION,
          id: message.id,
          error: {
            code: 'INTERNAL',
            message: e instanceof Error ? e.message : 'unknown error',
          },
        } satisfies SmirkWireResponse);
      });
    return true; // keep channel open for async sendResponse
  });
}

function isWireRequest(m: unknown): m is SmirkWireRequest {
  if (!m || typeof m !== 'object') return false;
  const r = m as Partial<SmirkWireRequest>;
  return (
    r.type === 'SMIRK_REQUEST' &&
    typeof r.id === 'number' &&
    typeof r.method === 'string' &&
    r.v === PROTOCOL_VERSION
  );
}

/** Derive `OriginContext` from `chrome.runtime.MessageSender`.
 *  Content-script-sourced messages carry `sender.tab.url` (full URL
 *  of the page running the content script) and optionally `sender.tab.favIconUrl`.
 *  The origin is the source-of-truth — siteName / favicon are
 *  best-effort cosmetics for the approval UI. */
function deriveOrigin(
  sender: chrome.runtime.MessageSender,
): OriginContext | null {
  const url = sender.tab?.url ?? sender.url;
  if (!url) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const out: OriginContext = { origin };
  if (sender.tab?.title) out.siteName = sender.tab.title;
  if (sender.tab?.favIconUrl) out.favicon = sender.tab.favIconUrl;
  return out;
}
