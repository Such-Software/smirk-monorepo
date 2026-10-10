/**
 * Frame guard for the send, receive and history lane's guarded recorder.
 *
 * It composes the reviewed demo guard (`demo/guard.mjs`) rather than replacing
 * it. Two things differ, both narrow:
 *
 *   - One more control is admitted: the history detail sheet's
 *     `tx-detail-reveal-key` BUTTON ("Show transaction key"). The reviewed
 *     pattern refuses every test id containing "reveal", which would blank
 *     every XMR and WOW send detail. The button only requests the key; the
 *     key itself (`tx-detail-tx-key`, and its "Transaction key (secret)"
 *     label) is refused by `extraSecretSurface` below, and the sheet never
 *     renders the button and the key together.
 *   - More surfaces are refused that the demo guard does not know about: the
 *     revealed transaction key, a tip claim link, an nsec display, and the
 *     onboarding phrase words and Settings phrase reveal by name.
 *
 * Everything else, including every password field, Settings root and the
 * phrase screens, still refuses exactly as the demo lane does. A refused frame
 * is replaced by a redaction card; it is never written.
 *
 * `extraSecretSurface` and `canarySnapshot` run inside the page through
 * `page.evaluate`, so each stays self-contained.
 */
import { secretSurface, PRIVATE_TEXT } from '../demo/guard.mjs';

export { secretSurface };

export const B_PATTERNS = Object.freeze({
  ...PRIVATE_TEXT,
  allowedButton: '^(nostr-reveal-[0-9a-f]{64}|nostr-export-backup|tx-detail-reveal-key)$',
});

export const B_EXTRA = Object.freeze({
  selectors: Object.freeze([
    '[data-testid="tx-detail-tx-key"]',
    '[data-testid="tip-share-url"]',
    '[data-testid^="nostr-nsec"]',
    '[data-testid="settings-revealed-phrase"]',
    '[data-testid^="onboarding-create-seed-word-"]',
    '[data-testid^="onboarding-verify-word-"]',
    '[data-testid^="onboarding-import-word-"]',
  ]),
  // The revealed tx key's label, and a tip claim link (its fragment is the claim key).
  text: '(Transaction key \\(secret\\)|/tip/[0-9A-Za-z_-]{6,}#[0-9A-Za-z_-]{8,})',
});

/**
 * Elements painted over in every frame that is admitted at all. Belt and
 * braces: a frame showing any of these with content is already refused, but
 * a mask costs nothing if a rule ever misses.
 */
export const MASK_SELECTORS = Object.freeze([
  'input[type="password"]',
  '[data-testid="operation-password"]',
  '[data-testid="tx-detail-tx-key"]',
  '[data-testid="tip-share-url"]',
  '[data-testid="paste-tip-input"]',
  '[data-testid="paste-dispatch-input"]',
  '[data-testid^="nostr-nsec"]',
  '[data-testid="nostr-import-nsec"]',
  '[data-testid="nostr-restore-input"]',
]);

export function extraSecretSurface(extra) {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  for (const selector of extra.selectors) {
    const hit = [...document.querySelectorAll(selector)].find(visible);
    if (hit) return `a protected surface (${(hit.dataset.testid ?? 'no test id').replace(/[^a-z-]/gi, '').slice(0, 40)})`;
  }
  if (new RegExp(extra.text).test(document.body?.innerText ?? '')) return 'protected text';
  return null;
}

/** Visible text and every field value, for the in-memory known-secret canary. */
export function canarySnapshot() {
  const values = [...document.querySelectorAll('input, textarea')]
    .map((element) => element.value)
    .filter((value) => typeof value === 'string' && value.length > 0);
  return { text: document.body?.innerText ?? '', values };
}
