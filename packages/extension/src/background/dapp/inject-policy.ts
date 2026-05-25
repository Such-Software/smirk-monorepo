/**
 * Content-script injection policy.
 *
 * Closes the short-term ask in [`Such-Software/smirk-extension#1`](
 * https://github.com/Such-Software/smirk-extension/issues/1): the mere
 * presence of `window.smirk` is a fingerprinting vector. Until the
 * longer-term event-driven opt-in design lands, the user can globally
 * disable injection from Settings; the content script reads this flag
 * before it injects `inject.js`.
 *
 * **Storage shape.** A single boolean under `smirk:dapp:inject-disabled`
 * in `chrome.storage.local`. `true` means "do not inject"; absent or
 * `false` means "inject" (default-on, matching what every existing
 * user expects from the legacy extension).
 *
 * **Why a dedicated key, not a field on the session-state store.**
 * The content script can read `chrome.storage.local` directly from
 * the content-script world without any messaging round-trip — that
 * matters because `injectSmirkAPI` is on the critical path at
 * `document_start` and any latency there is observable to the page.
 * Co-locating the flag with the rest of session state would force
 * a JSON parse of the whole settings blob; a dedicated key keeps
 * it ~one storage.get call.
 *
 * **Effective scope.** Changes take effect on the next page load
 * for each tab (Chrome doesn't re-run content scripts in already-
 * open pages). UI hint says as much.
 */

export const INJECT_DISABLED_KEY = 'smirk:dapp:inject-disabled';

/** Returns true iff the user has explicitly disabled `window.smirk`
 *  injection on web pages. Safe to call from content scripts or
 *  the popup; both contexts have `chrome.storage.local` access. */
export async function isInjectDisabled(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(INJECT_DISABLED_KEY);
    return res[INJECT_DISABLED_KEY] === true;
  } catch {
    // Defensive: if storage is somehow unavailable, default to the
    // less-private but more-functional behavior (inject). Matches
    // legacy semantics so a misconfigured environment doesn't
    // silently kill dapp interop.
    return false;
  }
}

/** Flip the flag from the popup Settings UI. `true` disables
 *  injection, `false` (or removing the key) re-enables it. */
export async function setInjectDisabled(disabled: boolean): Promise<void> {
  if (disabled) {
    await chrome.storage.local.set({ [INJECT_DISABLED_KEY]: true });
  } else {
    await chrome.storage.local.remove(INJECT_DISABLED_KEY);
  }
}
