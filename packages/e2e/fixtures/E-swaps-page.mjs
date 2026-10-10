/**
 * Page-side readers for the E-swaps live lane. Each runs inside the wallet
 * page through page.evaluate, so each is self-contained, and each reads text
 * nodes rather than innerText: CSS may uppercase a label (Send's Review rows
 * do), and innerText returns what CSS shows. Tested in real Chromium by
 * E-swaps-page.test.mjs.
 */

/**
 * Whether visible text still says the screen is loading. A swap provider
 * card that already says "Live now" counts as settled even when the build
 * leaves its first note ("Checking NonLogs…") on it: that note is not a load.
 */
export function loadingProbe(pattern) {
  const re = new RegExp(pattern);
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !re.test(node.nodeValue ?? '')) continue;
    const box = parent.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || getComputedStyle(parent).visibility === 'hidden') continue;
    const card = parent.closest('[data-testid^="swap-provider-"]');
    if (card && /Live now/.test(card.textContent ?? '')) continue;
    return true;
  }
  return false;
}

/**
 * The value of Send's Review row labelled `label` (a label span over a value
 * span). Null unless exactly one row has that label.
 */
export function reviewRow(label) {
  const rows = Array.from(document.querySelectorAll('span')).filter(
    (span) => (span.textContent ?? '').trim() === label && span.parentElement?.children.length === 2 && span.parentElement.firstElementChild === span,
  );
  if (rows.length !== 1) return null;
  return (rows[0].nextElementSibling?.textContent ?? '').trim() || null;
}

/**
 * Watch the swap pair step from before the Get quote tap, so the outcome is
 * read from what happened after it: `started` becomes true once the button
 * reads "Quoting…" or the step is gone.
 */
export function armQuoteWatch() {
  window.__eSwapsQuote?.observer.disconnect();
  const state = { started: false, observer: null };
  state.observer = new MutationObserver(() => {
    const button = document.querySelector('[data-testid="swap-pair-get-quote"]');
    if (!button || (button.textContent ?? '').includes('Quoting')) state.started = true;
  });
  state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__eSwapsQuote = state;
}

/** The pair step after a Get quote tap: wizard step, button text, whether the quote started, and its error. */
export function quoteState() {
  const step = document.querySelector('[data-testid="swap-wizard-step"]')?.textContent?.trim() ?? '';
  const button = document.querySelector('[data-testid="swap-pair-get-quote"]');
  // The step's error is the text-only element right above the button.
  const above = button?.previousElementSibling;
  const error = above && above.children.length === 0 ? (above.textContent ?? '').trim() || null : null;
  return { step, button: button ? (button.textContent ?? '').trim() : null, started: window.__eSwapsQuote?.started === true, error };
}
