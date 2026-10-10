/**
 * C-tips capture guard: the per-frame decision for the live tip lane.
 *
 * Every wallet frame gets exactly one verdict before it is kept:
 *
 *   - card:   the whole frame is replaced by a static labelled card. The strict
 *             demo guard (demo/guard.mjs secretSurface) decides first and is
 *             never relaxed here: anything it refuses, including the lock
 *             screen, Settings' root and any password field, becomes a card.
 *             Phrase surfaces and any unmasked known secret also become cards.
 *   - masked: the frame is kept with masks painted over tip claim links (the
 *             success screen's link, the Sent tips link panel, which has no test
 *             id, and a filled paste box), a revealed tx key or nsec, and any
 *             password field.
 *   - clean:  nothing to hide.
 *
 * `cTipsSurvey` runs inside the page and must stay self-contained. It finds the
 * elements to mask and returns the visible text that is NOT masked, so the
 * known-secret canary (`findLeak`) runs in Node and the secrets themselves
 * never enter the page.
 *
 * Masks that are matched by text (a claim link with no test id) or by state (a
 * filled paste box) have no stable selector, so the recorder marks them with a
 * per-capture nonce before the screenshot ('mark') and checks after it
 * ('verify') that every element the rules select still carries that nonce. A
 * node the app re-created in between lacks it, so the frame is dropped instead
 * of kept unmasked. 'scan' only reads: it never touches the page's attributes.
 */
export { secretSurface, PRIVATE_TEXT } from '../demo/guard.mjs';

/** A tip claim link: `/tip/<uuid>#<fragment>` on any host. */
export const TIP_LINK_SOURCE = '/tip/[0-9a-fA-F-]{8,}#[A-Za-z0-9_-]{16,}';

export const C_TIPS_RULES = Object.freeze({
  // Whole-frame cards: recovery phrase entry, verification and reveal.
  cardTestId: '^(onboarding-(create-seed|verify|import)-word-|settings-revealed-phrase)',
  // Masked whenever visible.
  maskSelectors: Object.freeze([
    'input[type="password"]',
    '[data-testid="tip-share-url"]',
    '[data-testid="tx-detail-tx-key"]',
    '[data-testid^="nostr-nsec-"]',
  ]),
  // Masked once they hold anything.
  maskWhenFilled: Object.freeze([
    'paste-tip-input',
    'paste-dispatch-input',
    'nostr-import-nsec',
    'nostr-restore-input',
  ]),
  tipLink: TIP_LINK_SOURCE,
  markAttribute: 'data-c-tips-mask',
});

/** Locator selector for the elements one capture marked with `nonce`. */
export function maskSelectorFor(nonce) {
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) throw new Error('a mask nonce is lowercase hex');
  return `[${C_TIPS_RULES.markAttribute}="${nonce}"]`;
}

/**
 * In-page survey. `mode` is 'scan' (read only), 'mark' (clear old marks, then
 * mark every target with `nonce`) or 'verify' (read only; count targets that do
 * not carry `nonce`). Returns `{ card }` instead when a phrase surface is visible.
 */
export function cTipsSurvey({ rules, nonce, mode }) {
  const attr = rules.markAttribute;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const cardId = new RegExp(rules.cardTestId);
  const phrase = [...document.querySelectorAll('[data-testid]')].find((el) => cardId.test(el.dataset.testid ?? '') && visible(el));
  if (phrase) return { card: 'phrase', masked: 0, unmarked: 0, signature: '', segments: [] };

  const targets = new Set();
  for (const selector of rules.maskSelectors) {
    for (const el of document.querySelectorAll(selector)) if (visible(el)) targets.add(el);
  }
  for (const id of rules.maskWhenFilled) {
    for (const el of document.querySelectorAll(`[data-testid="${id}"]`)) {
      if ('value' in el && el.value) targets.add(el);
    }
  }
  const link = new RegExp(rules.tipLink);
  // The deepest element whose text holds a claim link: its parent's text holds
  // it too, so taking only the deepest keeps the mask tight.
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (!link.test(el.textContent ?? '')) continue;
    if ([...el.children].some((child) => link.test(child.textContent ?? ''))) continue;
    targets.add(el);
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (link.test(el.value ?? '')) targets.add(el);
  }

  if (mode === 'mark') {
    for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    for (const el of targets) el.setAttribute(attr, nonce);
  }
  const unmarked = mode === 'verify' ? [...targets].filter((el) => el.getAttribute(attr) !== nonce).length : 0;

  const covered = (node) => {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (targets.has(el)) return true;
    }
    return false;
  };
  const segments = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || covered(node)) continue;
      segments.push(text);
    }
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.value && visible(el) && !covered(el)) segments.push(el.value);
  }
  const ordered = [...targets].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const boxes = ordered.map((el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  });
  return { card: null, masked: targets.size, unmarked, signature: boxes.join(';'), segments };
}

const NSEC_OR_XPRV = /(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})/;

/**
 * Node-side canary over the unmasked text. Returns a short label for the first
 * leak, never the leaked value: a structural claim link, nsec or xprv text, a
 * registered exact secret, or three consecutive recovery phrase words.
 */
export function findLeak(segments, secrets = {}) {
  const link = new RegExp(TIP_LINK_SOURCE);
  const exact = (secrets.exact ?? []).filter((value) => typeof value === 'string' && value.length >= 8);
  for (const segment of segments) {
    if (link.test(segment)) return 'an unmasked tip claim link';
    if (NSEC_OR_XPRV.test(segment)) return 'private key text';
    for (const value of exact) if (segment.includes(value)) return 'a registered secret';
  }
  const words = secrets.phraseWords ?? [];
  if (words.length >= 3) {
    const trigrams = new Set();
    for (let i = 0; i + 2 < words.length; i++) trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    const text = segments.join(' ').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i + 2 < text.length; i++) {
      if (trigrams.has(`${text[i]} ${text[i + 1]} ${text[i + 2]}`)) return 'recovery phrase words';
    }
  }
  return null;
}

/**
 * Marker labels are static strings: never amounts read from the screen, URLs,
 * keys or ids. Throws on anything that looks like a value.
 */
export function assertStaticLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9 ,.:;()'+/&-]{1,96}$/.test(label)
    || /:\/\/|#|npub1|nsec1|[0-9a-fA-F]{16,}/.test(label)) {
    throw new Error('footage labels must be short static descriptions, never values, URLs or keys');
  }
  return label;
}
