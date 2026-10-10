/**
 * Frame guard for the F-legacy-recovery live recorder.
 *
 * The demo lane's guard (`demo/guard.mjs`) refuses and aborts. A live run that
 * must record every operation cannot abort on the lock screen, so this guard
 * classifies each frame instead:
 *
 *   - `card`:  the screen itself is a secret (phrase entry or reveal, private-key
 *              text, a claim link the recorder cannot cover, a known secret seen
 *              anywhere, or a page outside the extension). The whole frame is
 *              replaced by a labelled redaction card; no pixels are kept.
 *   - `mask`:  the screen is fine but named elements are not (password fields,
 *              tip share URLs, a revealed tx key, filled claim-link inputs).
 *              The screenshot is taken with those elements painted over.
 *   - `clean`: nothing secret is visible.
 *
 * Two halves:
 *   - `classifyFrame` runs INSIDE the page and must stay self-contained (no
 *     closure over module scope). It judges structure only and receives nothing
 *     secret. It returns the page's visible text and non-password input values
 *     so the known-secret check can run in Node.
 *   - `finalVerdict` runs in Node: it compares those texts with the canary and
 *     refuses any page that is not an extension page.
 *
 * The canary never leaves this process. It holds a random per-run HMAC key and
 * the digests of the phrase (three-word windows), the wallet password and any
 * claim-link fragment, never the values themselves once the digests exist. A
 * page cannot see the key or the digests, so a page cannot brute-force a
 * phrase out of them. Reasons name the kind of surface, never its content.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const FRAME_GUARD_PATTERNS = Object.freeze({
  // Whole-frame redaction: these surfaces ARE the secret.
  cardTestId:
    '^(onboarding-create-seed-word-|onboarding-verify-word-|onboarding-import-word-|settings-revealed-phrase$)|(mnemonic|seed-word|recovery-phrase|private-key|secret-key|xprv)',
  privateText: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  // Masked in place whenever visible, empty or not.
  mask: [
    ['password-field', 'input[type="password"]'],
    ['tip-share-url', '[data-testid="tip-share-url"]'],
    ['tx-key', '[data-testid="tx-detail-tx-key"]'],
    ['nostr-nsec', '[data-testid^="nostr-nsec-"]'],
  ],
  // Masked when they hold anything.
  maskWhenFilled: [
    ['claim-link-input', '[data-testid="paste-tip-input"]'],
    ['dispatch-input', '[data-testid="paste-dispatch-input"]'],
    ['nsec-import-input', '[data-testid="nostr-import-nsec"]'],
    ['nostr-restore-input', '[data-testid="nostr-restore-input"]'],
  ],
  // A claim link with its key fragment, e.g. https://smirk.cash/tip/<id>#<key>.
  claimLinkText: '/tip/[^\\s#/]+#[A-Za-z0-9_~.+=-]{8,}',
});

/** The only origin whose pages the recorder keeps: the wallet's own extension pages. */
export const RECORDABLE_PROTOCOL = 'chrome-extension:';

/** Every CSS selector the recorder masks; the in-page reasons map onto these. */
export function maskSelectors(patterns = FRAME_GUARD_PATTERNS) {
  return [...patterns.mask, ...patterns.maskWhenFilled].map(([, selector]) => selector);
}

/** Split text into the units the canary compares: three-word windows and long tokens. */
export function canaryUnits(text) {
  const units = [];
  const words = String(text).toLowerCase().match(/[a-z]+/g) ?? [];
  for (let i = 0; i + 3 <= words.length; i++) units.push(words.slice(i, i + 3).join(' '));
  for (const token of String(text).split(/[^A-Za-z0-9_~.+=-]+/)) if (token.length >= 12) units.push(token);
  return units;
}

/**
 * A per-run canary. `add*` digest secret values immediately; the caller drops
 * its copy afterwards. Nothing here is ever sent to a page: `hit` compares in
 * this process.
 */
export function createCanary() {
  const key = randomBytes(32);
  const digests = new Set();
  const digest = (unit) => createHmac('sha256', key).update(unit, 'utf8').digest('hex');
  return {
    /** Phrase words become three-word windows; other values are whole tokens. */
    addPhrase(words) {
      const clean = words.map((w) => String(w).toLowerCase());
      for (let i = 0; i + 3 <= clean.length; i++) digests.add(digest(clean.slice(i, i + 3).join(' ')));
    },
    addToken(value) {
      const v = String(value);
      if (v.length >= 12) digests.add(digest(v));
    },
    size() {
      return digests.size;
    },
    /** True when any unit of any text is a known secret. */
    hit(texts) {
      if (digests.size === 0) return false;
      for (const text of texts) {
        for (const unit of canaryUnits(text)) if (digests.has(digest(unit))) return true;
      }
      return false;
    },
  };
}

/**
 * Classify the current frame's structure. Runs in the page; must not reference
 * module scope. Receives no secret. Returns the verdict plus the texts the Node
 * side checks against the canary (never stored).
 * @param {{ patterns: typeof FRAME_GUARD_PATTERNS }} args
 * @returns {Promise<{ kind: 'clean' | 'mask' | 'card', reasons: string[], texts: string[], protocol: string }>}
 */
export async function classifyFrame(args) {
  const { patterns } = args;
  const reasons = new Set();
  let card = false;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const valueOf = (element) => ('value' in element ? String(element.value ?? '') : '');

  const cardId = new RegExp(patterns.cardTestId, 'i');
  for (const element of document.querySelectorAll('[data-testid]')) {
    if (cardId.test(element.dataset.testid ?? '') && visible(element)) {
      card = true;
      reasons.add('phrase-surface');
      break;
    }
  }
  const body = document.body ? document.body.innerText : '';
  if (new RegExp(patterns.privateText).test(body)) {
    card = true;
    reasons.add('private-key-text');
  }

  for (const [name, selector] of patterns.mask) {
    if ([...document.querySelectorAll(selector)].some(visible)) reasons.add(`mask:${name}`);
  }
  for (const [name, selector] of patterns.maskWhenFilled) {
    if ([...document.querySelectorAll(selector)].some((element) => visible(element) && valueOf(element) !== '')) {
      reasons.add(`mask:${name}`);
    }
  }

  // A claim link must sit inside one text node so a text locator can cover it;
  // anything the recorder could not localise is redacted whole.
  const claimLink = new RegExp(patterns.claimLinkText);
  if (claimLink.test(body)) {
    let localised = false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (claimLink.test(node.textContent ?? '') && node.parentElement && visible(node.parentElement)) localised = true;
    }
    if (localised) reasons.add('mask:claim-link');
    else {
      card = true;
      reasons.add('claim-link-unlocalised');
    }
  }
  // A claim link inside a field. Only the named claim and import fields have a
  // mask locator; a link in any other field would be recorded as typed, so the
  // whole frame is redacted instead.
  const masked = [...patterns.mask, ...patterns.maskWhenFilled].map(([, selector]) => selector).join(', ');
  const texts = [body];
  for (const element of document.querySelectorAll('input:not([type="password"]), textarea')) {
    const value = valueOf(element);
    if (value !== '') texts.push(value);
    if (visible(element) && claimLink.test(value) && !element.matches(masked)) {
      card = true;
      reasons.add('claim-link-in-unmasked-field');
    }
  }

  const sorted = [...reasons].sort();
  const protocol = location.protocol;
  if (card) return { kind: 'card', reasons: sorted, texts, protocol };
  return { kind: sorted.length ? 'mask' : 'clean', reasons: sorted, texts, protocol };
}

/**
 * The verdict the recorder acts on, decided in Node: a page outside the
 * extension is redacted whole (its main world is not ours to trust), and a
 * known secret anywhere in the page text or a field redacts the frame. The
 * returned verdict carries no text.
 * @param {{ kind: string, reasons: string[], texts: string[], protocol: string }} raw
 * @param {{ hit(texts: string[]): boolean } | null} canary
 * @returns {{ kind: 'clean' | 'mask' | 'card', reasons: string[] }}
 */
export function finalVerdict(raw, canary) {
  const reasons = new Set(raw.reasons);
  let card = raw.kind === 'card';
  if (raw.protocol !== RECORDABLE_PROTOCOL) {
    card = true;
    reasons.add('outside-extension');
  }
  if (canary && canary.hit(raw.texts)) {
    card = true;
    reasons.add('known-secret');
  }
  const sorted = [...reasons].sort();
  if (card) return { kind: 'card', reasons: sorted };
  return { kind: sorted.length ? 'mask' : 'clean', reasons: sorted };
}
