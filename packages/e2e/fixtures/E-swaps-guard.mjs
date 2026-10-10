/**
 * Frame guard for the E-swaps live lane: redact and continue.
 *
 * The demo lane's guard (demo/guard.mjs) refuses a whole run on any secret
 * surface. A long live run cannot work that way: the lock screen, an operation
 * password prompt and the swap status link all appear during ordinary swaps.
 * So every frame is classified instead:
 *
 *   clean   nothing sensitive is on screen;
 *   masked  something sensitive is on screen, and every such element is covered
 *           by a screenshot mask (see MASK_SELECTORS);
 *   card    the screen cannot be made safe by masking (a recovery phrase, key
 *           text, a tip claim link). No screenshot is taken; the timeline shows
 *           a labelled redaction card for that interval.
 *
 * `frameSurface` runs inside the page and must stay self-contained. It returns
 * labels that name the kind of surface, never its content, plus the visible
 * text and input values outside the masks so the Node side can compare them
 * with the secrets it knows (`Canary`, below). Those strings stay in memory
 * and are never written or printed.
 */

import { createHash } from 'node:crypto';

/** Elements always covered by a screenshot mask when present. */
export const MASK_SELECTORS = Object.freeze([
  'input[type="password"]',
  '[data-testid="lockscreen-password-input"]',
  '[data-testid="operation-password"]',
  '[data-testid="settings-reveal-password"]',
  '[data-testid="migrate-password"]',
  '[data-testid="nostr-unlock-input"]',
  '[data-testid="tip-share-url"]',
  '[data-testid="paste-tip-input"]',
  '[data-testid="paste-dispatch-input"]',
  '[data-testid="tx-detail-tx-key"]',
  '[data-testid^="nostr-nsec-"]',
  '[data-testid="nostr-import-nsec"]',
  '[data-testid="nostr-restore-input"]',
]);

/** Patterns that turn a frame into a redaction card. */
export const CARD_PATTERNS = Object.freeze({
  // Phrase entry and display: masking word by word is not enough, the
  // arrangement of the grid is itself the secret.
  testId: '^(onboarding-create-seed-word-\\d+|onboarding-verify-word-\\d+|onboarding-import-word-\\d+|settings-revealed-phrase|settings-revealed-phrase-.*)$',
  // Bech32 nsec and BIP32 private extended keys.
  keyText: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  // A tip claim link: the fragment after # is the claim key.
  tipLink: '/tip/[A-Za-z0-9_-]{4,}#[A-Za-z0-9_-]{8,}',
});

/**
 * Inside the page: classify the visible surface. `masks` are MASK_SELECTORS,
 * `patterns` is CARD_PATTERNS (one argument, as page.evaluate passes it). Returns
 *   { card: string | null, masked: string[], text: string, values: string[] }
 * where `masked` names (by test id or tag) the visible elements a mask covers.
 */
export function frameSurface({ masks, patterns }) {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const name = (element) => {
    const id = element.dataset?.testid;
    return id ? id.replace(/[^a-z0-9-]/gi, '').slice(0, 48) : element.tagName.toLowerCase();
  };
  const selector = masks.join(',');
  const maskedElements = [...document.querySelectorAll(selector)].filter(visible);
  const insideMask = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return !!element && !!element.closest(selector);
  };

  const cardId = new RegExp(patterns.testId);
  const phrase = [...document.querySelectorAll('[data-testid]')].find((element) => cardId.test(element.dataset.testid) && visible(element));
  if (phrase) return { card: 'recovery phrase', masked: [], text: '', values: [] };

  // Visible text outside the masks.
  const parts = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || insideMask(node) || !visible(parent)) continue;
    const value = node.nodeValue?.trim();
    if (value) parts.push(value);
  }
  const text = parts.join('\n');
  // Input values outside the masks (password inputs are always masked).
  const values = [...document.querySelectorAll('input, textarea')]
    .filter((element) => visible(element) && !insideMask(element) && element.value)
    .map((element) => element.value);

  const keyText = new RegExp(patterns.keyText);
  if (keyText.test(text) || values.some((value) => keyText.test(value))) {
    return { card: 'private key text', masked: [], text: '', values: [] };
  }
  const tipLink = new RegExp(patterns.tipLink);
  if (tipLink.test(text) || values.some((value) => tipLink.test(value))) {
    return { card: 'tip claim link', masked: [], text: '', values: [] };
  }
  return { card: null, masked: maskedElements.map(name).sort(), text, values };
}

/**
 * Refuse a footage label that could carry a value. Labels are static words in
 * source; this catches a value slipping in through a template literal.
 */
export function assertStaticLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z][A-Za-z ,.'()&:+-]{0,79}$/.test(label)) {
    throw new Error('footage labels are static words only (letters, spaces and light punctuation, at most 80 characters)');
  }
  return label;
}

const hashRun = (words) => createHash('sha256').update(words.join(' ')).digest('hex');

/**
 * Known secrets for this run, held in memory only (Node side). Phrase words
 * are kept as hashes of every run of three consecutive words, so the plain
 * phrase can be zeroed right after import while the canary still recognises
 * it on screen.
 */
export class Canary {
  #phraseRuns = new Set();
  #literals = [];

  addPhrase(words) {
    for (let i = 0; i + 3 <= words.length; i++) this.#phraseRuns.add(hashRun(words.slice(i, i + 3)));
  }

  /**
   * A password, key, bearer link or token (at least 12 characters). A link is
   * also recognised by its last long segment, unless that segment is shown
   * publicly anyway (`publicParts`, e.g. a trade id the status step prints).
   */
  addLiteral(value, publicParts = []) {
    if (typeof value !== 'string' || value.length < 12) throw new Error('canary literals must be at least 12 characters');
    this.#literals.push(value);
    const tail = value.split(/[/?#=&]/).filter((part) => part.length >= 16).at(-1);
    if (tail && tail !== value && !publicParts.some((p) => p && (p === tail || p.includes(tail)))) this.#literals.push(tail);
  }

  /** True when any known secret is visible outside the masks. */
  hit(surface) {
    const haystacks = [surface.text ?? '', ...(surface.values ?? [])];
    if (this.#literals.some((secret) => haystacks.some((h) => h.includes(secret)))) return true;
    if (this.#phraseRuns.size === 0) return false;
    for (const h of haystacks) {
      const words = h.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      for (let i = 0; i + 3 <= words.length; i++) {
        if (this.#phraseRuns.has(hashRun(words.slice(i, i + 3)))) return true;
      }
    }
    return false;
  }
}
