/**
 * Host-portable clipboard write.
 *
 * `navigator.clipboard` is only defined in a secure context. Our five hosts do
 * not agree on what counts as one: Chrome/Firefox extension pages and the
 * macOS/Windows Tauri webviews qualify, but WebKitGTK on Linux serves the app
 * from a custom scheme that is not always registered as trustworthy, leaving
 * `navigator.clipboard` `undefined` outright. Dereferencing it there is a
 * synchronous TypeError, not a rejected promise.
 *
 * So: try the modern API, then fall back to the `execCommand('copy')` route,
 * which works from a plain document in every host we ship. Only if both fail
 * do we throw; callers surface that to the user rather than claiming a copy
 * that never happened.
 */
export async function copyText(text: string): Promise<void> {
  // Guarded with `?.` on purpose: the failure mode we are defending against is
  // `navigator.clipboard` being absent, which optional chaining turns into a
  // skipped branch instead of a throw.
  try {
    const write = globalThis.navigator?.clipboard?.writeText;
    if (typeof write === 'function') {
      await globalThis.navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Permission denied, or a host that defines the API but refuses it.
    // Fall through: execCommand is a genuinely different path and may work.
  }

  if (typeof document === 'undefined') {
    throw new Error('clipboard unavailable: no document');
  }

  // execCommand copies the current selection, so we need a real, focusable,
  // on-screen-enough node. `position: fixed` + zero opacity keeps it invisible
  // without the `display: none` / off-screen tricks that make some engines
  // treat the selection as empty.
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.setAttribute('aria-hidden', 'true');
  scratch.style.position = 'fixed';
  scratch.style.top = '0';
  scratch.style.left = '0';
  scratch.style.width = '1px';
  scratch.style.height = '1px';
  scratch.style.padding = '0';
  scratch.style.border = 'none';
  scratch.style.opacity = '0';

  const previouslyFocused = document.activeElement;
  document.body.appendChild(scratch);
  try {
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    // eslint-disable-next-line deprecation/deprecation: the modern API is
    // tried first; this is the fallback that keeps Linux working.
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('clipboard unavailable: copy command rejected');
  } finally {
    scratch.remove();
    // Returning focus matters on the seed screen, where the copy button sits
    // in a keyboard-navigable confirmation flow.
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }
}
