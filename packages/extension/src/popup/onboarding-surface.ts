/**
 * Where onboarding is allowed to run.
 *
 * The action popup is destroyed by the browser the moment it loses focus, and
 * onboarding is the one flow whose state cannot be restored afterwards: the
 * mnemonic lives in `useState` only, deliberately, so it never reaches
 * `chrome.storage.session` (see the header of `OnboardingWizard.tsx` and the
 * 2026-05-10 audit). Everything else in the wallet already survives a blur,
 * because the route, per-route scroll and every wizard's fields are persisted
 * through `SessionStateStore`.
 *
 * The consequence, reported from real use on 2026-08-23: generate a seed, copy
 * it, switch windows to paste it, come back, and the popup has been rebuilt
 * from scratch at the welcome screen. Pressing create again mints a DIFFERENT
 * seed. A user who saved the first one and funds the second has a recovery
 * phrase for a wallet that is not theirs, with nothing on screen saying so.
 *
 * So onboarding does not run in the action popup. It runs in a tab, which
 * survives focus changes, and the popup shows a hand-off card instead. Desktop
 * is already a real window and needs none of this.
 */

/** Marks a popup.html instance that was opened as a full tab. */
export const TAB_CONTEXT_PARAM = 'ctx';
export const TAB_CONTEXT_VALUE = 'tab';

/** URL of the onboarding surface: popup.html, flagged as tab-hosted. */
export function onboardingUrl(): string {
  return `${chrome.runtime.getURL('popup.html')}?${TAB_CONTEXT_PARAM}=${TAB_CONTEXT_VALUE}`;
}

/**
 * True when this document can host onboarding safely: a real tab, or the Tauri
 * desktop window, which is a first-class window and never blurs away.
 */
export function canHostOnboarding(): boolean {
  if (chrome.runtime?.id === 'smirk-desktop') return true;
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    return params.get(TAB_CONTEXT_PARAM) === TAB_CONTEXT_VALUE;
  } catch {
    // No location (tests, odd hosts): fail toward the safe surface rather than
    // rendering a seed somewhere it can be destroyed mid-flow.
    return false;
  }
}

/**
 * Focus the existing onboarding tab, or open one.
 *
 * The open tab's id is remembered in session storage rather than found with
 * `tabs.query({url})`, which would require adding the broad `tabs` permission
 * just to read extension URLs. Reusing the tab matters: a second tab would
 * show a second seed, which is the confusion this module exists to prevent.
 */
const TAB_ID_KEY = 'onboarding:tabId';

export async function openOnboardingTab(): Promise<void> {
  const url = onboardingUrl();
  const tabsApi = (chrome as unknown as { tabs?: typeof chrome.tabs }).tabs;
  if (!tabsApi?.create) {
    // No tabs API (or a host without one): a window still survives losing
    // focus, which is the property that matters here.
    await chrome.windows?.create?.({ url, type: 'popup', width: 480, height: 720 });
    return;
  }

  const stored = await chrome.storage.session.get(TAB_ID_KEY);
  const tabId = stored[TAB_ID_KEY];
  if (typeof tabId === 'number') {
    try {
      const tab = await tabsApi.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await chrome.windows?.update?.(tab.windowId, { focused: true });
      }
      return;
    } catch {
      // Tab was closed since. Fall through and open a fresh one.
    }
  }

  const created = await tabsApi.create({ url, active: true });
  if (created?.id !== undefined) {
    await chrome.storage.session.set({ [TAB_ID_KEY]: created.id });
  }
}
