/**
 * Frame guard for the G-premium live lane (premium plans, invoices, checkout).
 *
 * The demo guard (demo/guard.mjs) refuses and aborts. A long recorded run
 * cannot abort on every lock screen, so this guard sorts each frame instead:
 *
 *   - `card`: a recovery phrase, revealed key, key-like text or tip claim link
 *     is visible. The whole frame is replaced by a static redaction card; no
 *     pixels are kept.
 *   - `masked`: a password, tx key or nsec field is visible. The screenshot is
 *     taken with those elements painted over.
 *   - `clean`: nothing protected is visible.
 *
 * `frameVerdict` runs inside the page, so it must stay self-contained. It
 * returns the visible text and the non-password input values so the caller can
 * run its known-secret canary in Node; neither is ever written anywhere.
 * Reasons name the kind of surface, never its content.
 */
export const PREMIUM_GUARD = Object.freeze({
  // Test ids that hold a phrase or a revealed key: the whole frame is redacted.
  card: '^(onboarding-(create-seed|verify|import)-word-\\d+|settings-revealed-phrase)$'
    + '|mnemonic|seed-word|recovery-phrase|revealed|private-key|spend-key|view-key',
  // Key-like text anywhere on the page: the whole frame is redacted.
  keyText: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  // Elements painted over in place. Kept in sync with MASK_SELECTORS below.
  mask: 'input[type="password"], [data-testid="tip-share-url"], [data-testid="tx-detail-tx-key"], '
    + '[data-testid^="nostr-nsec-"], [data-testid="paste-tip-input"], [data-testid="paste-dispatch-input"], '
    + '[data-testid="nostr-import-nsec"], [data-testid="nostr-restore-input"]',
  // A tip claim link carries its claim key in the fragment.
  claimText: '/tip/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+',
});

/** The same selectors as a list, for Playwright screenshot masks. */
export const MASK_SELECTORS = Object.freeze(PREMIUM_GUARD.mask.split(/,\s*/));

/** Runs in the page. Returns { verdict, reason, filledSecret, text, values }. */
export function frameVerdict(patterns) {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
      && style.display !== 'none' && style.opacity !== '0';
  };
  const card = new RegExp(patterns.card, 'i');
  const keyText = new RegExp(patterns.keyText);
  const claim = new RegExp(patterns.claimText);
  const text = document.body?.innerText ?? '';
  const inputs = [...document.querySelectorAll('input, textarea')];
  // Password values are the masked secret itself; the canary checks the rest.
  const values = inputs
    .filter((element) => element.type !== 'password' && visible(element))
    .map((element) => element.value)
    .filter(Boolean);
  const filledSecret = inputs.some((element) => visible(element) && element.value !== ''
    && element.matches(patterns.mask));
  const result = (verdict, reason) => ({ verdict, reason, filledSecret, text, values });

  const phrase = [...document.querySelectorAll('[data-testid]')]
    .find((element) => card.test(element.dataset.testid ?? '') && visible(element));
  if (phrase) return result('card', 'a phrase or key surface');
  if (keyText.test(text) || values.some((value) => keyText.test(value))) return result('card', 'private-key-like text');

  // A claim link can sit in any element, without a test id to mask it by, so
  // this lane redacts the whole frame rather than trust a text match to cover it.
  if (claim.test(text) || values.some((value) => claim.test(value))) return result('card', 'a tip claim link');

  const maskable = [...document.querySelectorAll(patterns.mask)].some(visible);
  if (maskable) return result('masked', 'a protected field');
  return result('clean', 'nothing protected');
}
