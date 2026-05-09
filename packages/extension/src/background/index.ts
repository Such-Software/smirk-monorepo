/**
 * Smirk background service worker — skeleton.
 *
 * Boots `@smirk/core`'s singleton API client so we can verify the
 * workspace plumbing works. Real message handlers, state machine,
 * alarms, and notifications migrate in from
 * `Such-Software/smirk-extension/src/background/` as the substantive
 * port progresses.
 *
 * MV3 service workers can't statically import WASM — `@smirk/wasm`
 * imports must stay dynamic (`await import('@smirk/wasm')`). When the
 * crypto-using flows (sign, derive, etc.) port over, follow that
 * pattern.
 */

import { api, CORE_PACKAGE_VERSION } from '@smirk/core';

console.log('[smirk] background worker starting', {
  core: CORE_PACKAGE_VERSION,
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[smirk] installed; api base:', (api as unknown as { baseUrl: string }).baseUrl);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Skeleton: respond to a single ping so the popup can verify the
  // worker is alive. Real message routing migrates in next.
  if (message?.type === 'PING') {
    sendResponse({ ok: true, core: CORE_PACKAGE_VERSION });
    return true;
  }
  sendResponse({ ok: false, error: 'not implemented (skeleton build)' });
  return true;
});
