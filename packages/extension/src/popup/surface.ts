/**
 * Which surface this popup.html instance is running in.
 *
 * The same page serves the toolbar action popup, the pop-out window, a
 * browser tab (?ctx=tab) and the desktop app. Only the action popup is pinned
 * to a small fixed size, and only there must the compact layout be forced: in
 * Firefox the popup's window.outerWidth is the whole browser window and its
 * viewport is unsettled while it opens, so measuring cannot be trusted there.
 *
 * `extension.getViews({ type: 'popup' })` lists exactly the open action
 * popups (a window from chrome.windows.create({ type: 'popup' }) is not one),
 * in Chrome and in Firefox. Hosts without it (the desktop shim, tests) are not
 * an action popup.
 */
interface ViewsApi {
  getViews?: (filter: { type: 'popup' }) => unknown[];
}

export function isActionPopup(
  win: unknown = typeof window === 'undefined' ? undefined : window,
  extension: ViewsApi | undefined = (globalThis as { chrome?: { extension?: ViewsApi } }).chrome
    ?.extension,
): boolean {
  if (!win || !extension?.getViews) return false;
  try {
    const views = extension.getViews({ type: 'popup' });
    return Array.isArray(views) && views.includes(win);
  } catch {
    return false;
  }
}
