/**
 * Frame guard for the F-legacy-recovery live recorder.
 *
 * The demo lane's guard (`demo/guard.mjs`) refuses and aborts. A live run that
 * must record every operation cannot abort on the lock screen, so this guard
 * classifies each frame instead:
 *
 *   - `card`:  the screen itself is a secret (phrase entry or reveal, private-key
 *              text, or a known secret seen anywhere). The whole frame is
 *              replaced by a labelled redaction card; no pixels are kept.
 *   - `mask`:  the screen is fine but named elements are not (password fields,
 *              tip share URLs, a revealed tx key, filled claim-link inputs).
 *              The screenshot is taken with those elements painted over.
 *   - `clean`: nothing secret is visible.
 *
 * `classifyFrame` runs INSIDE the page, so it must stay self-contained (no
 * closure over module scope). Reasons name the kind of surface, never its
 * content. The known-secret canary compares keyed digests only: the recorder
 * holds a random per-run HMAC key and the digests of the phrase (three-word
 * windows), the wallet password and any claim-link fragment, and never the
 * values themselves once the digests exist.
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
 * A per-run canary. `add` digests secret values immediately; the caller drops
 * its copy afterwards. `forPage` is the only thing sent to the page: a random
 * key and digests, never a secret.
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
    forPage() {
      return { keyHex: key.toString('hex'), digests: [...digests] };
    },
  };
}

/**
 * Classify the current frame. Runs in the page; must not reference module scope.
 * @param {{ patterns: typeof FRAME_GUARD_PATTERNS, canary: { keyHex: string, digests: string[] } | null }} args
 * @returns {Promise<{ kind: 'clean' | 'mask' | 'card', reasons: string[] }>}
 */
export async function classifyFrame(args) {
  const { patterns, canary } = args;
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
  for (const element of document.querySelectorAll('input:not([type="password"]), textarea')) {
    if (visible(element) && claimLink.test(valueOf(element))) reasons.add('mask:claim-link-input');
  }

  if (canary && canary.digests.length) {
    const bytes = new Uint8Array(canary.keyHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const wanted = new Set(canary.digests);
    const encoder = new TextEncoder();
    const hit = async (unit) => {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unit)));
      return wanted.has([...mac].map((b) => b.toString(16).padStart(2, '0')).join(''));
    };
    const units = (text) => {
      const out = [];
      const words = String(text).toLowerCase().match(/[a-z]+/g) ?? [];
      for (let i = 0; i + 3 <= words.length; i++) out.push(words.slice(i, i + 3).join(' '));
      for (const token of String(text).split(/[^A-Za-z0-9_~.+=-]+/)) if (token.length >= 12) out.push(token);
      return out;
    };
    const sources = [body];
    for (const element of document.querySelectorAll('input:not([type="password"]), textarea')) sources.push(valueOf(element));
    search: for (const source of sources) {
      for (const unit of units(source)) {
        if (await hit(unit)) {
          card = true;
          reasons.add('known-secret');
          break search;
        }
      }
    }
  }

  const sorted = [...reasons].sort();
  if (card) return { kind: 'card', reasons: sorted };
  return { kind: sorted.length ? 'mask' : 'clean', reasons: sorted };
}
