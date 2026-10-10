import { createHmac, randomBytes } from 'node:crypto';

/**
 * The demo-capture secret guard. `secretSurface` runs inside the page (it must
 * stay self-contained) and returns a short label for the first visible secret
 * surface, or null. Labels name the kind of surface, never its content.
 */
export const PRIVATE_TEXT = {
  testId: '(mnemonic|seed|recovery|backup|export|reveal|nsec|private|secret|password|unlock|onboarding|import-word)',
  text: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  // Buttons that only REQUEST a secret (behind a password prompt) are safe to
  // show. Anything they reveal is caught by the other rules.
  allowedButton: '^(nostr-reveal-[0-9a-f]{64}|nostr-export-backup)$',
  // Import fields are safe only while EMPTY; any content refuses.
  allowedEmptyInput: '^nostr-import-nsec$',
};

export function secretSurface(patterns) {
  const testId = new RegExp(patterns.testId, 'i');
  const text = new RegExp(patterns.text);
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const emptyAllowed = new RegExp(patterns.allowedEmptyInput);
  const password = [...document.querySelectorAll('input[type="password"]')].find((element) => visible(element)
    && !(element.value === '' && emptyAllowed.test(element.dataset.testid ?? '')));
  if (password) {
    const holder = password.dataset.testid ? password : password.closest('[data-testid]');
    return `a password field (${holder ? holder.dataset.testid.replace(/[^a-z-]/gi, '').slice(0, 40) : 'no test id'})`;
  }
  const allowedButton = new RegExp(patterns.allowedButton);
  const allowedEmptyInput = new RegExp(patterns.allowedEmptyInput);
  const marked = [...document.querySelectorAll('[data-testid]')].filter((element) => testId.test(element.dataset.testid) && visible(element)
    && !(element.tagName === 'BUTTON' && allowedButton.test(element.dataset.testid))
    && !(element.tagName === 'INPUT' && element.value === '' && allowedEmptyInput.test(element.dataset.testid)));
  if (marked.length) return `protected surfaces: ${marked.slice(0, 12).map((element) => `${element.tagName.toLowerCase()}#${element.dataset.testid.replace(/[^a-z-]/gi, '').slice(0, 40)}`).join(', ')}`;
  if (text.test(document.body?.innerText ?? '')) return 'private-key-like text';
  return null;
}

/*
 * Live-lane guard: redact and continue.
 *
 * The demo lane above refuses and aborts on any secret surface, which suits a
 * fixed promo tour. The live lane (playwright.live.config.ts with
 * fixtures/guarded-footage.ts) records whole wallet runs that pass through
 * phrase entry, lock screens and password prompts, so each frame gets a
 * verdict instead of a refusal:
 *
 *   card   a recovery phrase, a private key or an unrecognised secret-bearing
 *          surface is visible. No pixels are captured; a static labelled card
 *          stands in for the frame.
 *   mask   a password field, a claim link, a transaction key, an nsec or a
 *          filled secret paste field is visible. Those elements are painted
 *          over at capture time and the rest of the frame is kept.
 *   clean  nothing protected is visible.
 *
 * `liveFrameVerdict` runs inside the page, so it must stay self-contained. It
 * returns rule labels, never content, plus the visible text and field values
 * that the recorder's in-memory canary compares against known secrets. That
 * text never leaves the recording process.
 */

/** Attribute the verdict sets on the elements it decided to mask. */
export const LIVE_MASK_ATTRIBUTE = 'data-e2e-mask';

export const LIVE_RULES = Object.freeze({
  // Whole-frame redaction by test id: phrase grids, verify and import words,
  // and the revealed recovery phrase.
  cardTestId: '^(onboarding-create-seed-word-\\d+|onboarding-verify-word-\\d+|onboarding-import-word-\\d+|settings-revealed-phrase)$',
  // Whole-frame redaction by text: Nostr and extended private keys, and the raw
  // key export panel, whose hex keys no pattern can tell from a txid.
  cardText: PRIVATE_TEXT.text,
  cardLabelText: '(private (spend|view) key|private key \\(secp256k1\\)|private keys below)',
  // Masked in place, whatever their content.
  maskTestId: '^(tip-share-url|tx-detail-tx-key|nostr-nsec-[0-9a-f]{64}|swap-status-private-link)$',
  // Masked once they hold anything: paste fields for claim links and keys.
  maskFilledTestId: '^(paste-tip-input|paste-dispatch-input|nostr-import-nsec|nostr-restore-input)$',
  // A field that holds a password is masked even if a toggle made it type=text.
  maskFieldTestId: '(password|passphrase)',
  // A tip claim link carries its claim key in the fragment.
  claimLinkText: '/tip/[^\\s#/?]+#\\S{6,}',
  // Every mask rule as CSS, resolved again at capture time so a re-rendered
  // element is still covered. Masking an empty field is harmless.
  maskSelectors: Object.freeze([
    'input[type="password"]',
    'input[data-testid*="password" i]:not([type="checkbox"]):not([type="radio"])',
    'input[data-testid*="passphrase" i]:not([type="checkbox"]):not([type="radio"])',
    '[data-testid="tip-share-url"]',
    '[data-testid="tx-detail-tx-key"]',
    '[data-testid^="nostr-nsec-"]',
    '[data-testid="swap-status-private-link"]',
    '[data-testid="paste-tip-input"]',
    '[data-testid="paste-dispatch-input"]',
    '[data-testid="nostr-import-nsec"]',
    '[data-testid="nostr-restore-input"]',
  ]),
  // Anything else whose test id looks secret-bearing is carded unless admitted
  // below: an unknown surface fails closed.
  protectedTestId: '(mnemonic|seed|recovery|backup|export|reveal|nsec|private|secret|phrase|import-word|verify-word)',
  // Controls that only ASK for a secret behind a password prompt. Admitted as
  // buttons or checkboxes only; the same id on another element is carded.
  allowedControl: '^(settings-reveal-btn|lockscreen-unlock-btn|tx-detail-reveal-key|require-password-sends|require-password-signing|bootstrap-error-unlock|legacy-needs-unlock|nostr-reveal-[0-9a-f]{64}|nostr-export-backup|onboarding-create-copy-seed)$',
  // Status text that never carries a secret.
  allowedStatus: '^(onboarding-create-copy-seed-status|nostr-unlock-prompt)$',
  // Import fields are admitted while empty; once filled they are masked.
  allowedEmptyInput: '^(nostr-import-nsec)$',
});

export function liveFrameVerdict(rules) {
  const attribute = 'data-e2e-mask';
  for (const element of document.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute);
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const cardId = new RegExp(rules.cardTestId);
  const cardText = new RegExp(rules.cardText);
  const cardLabel = new RegExp(rules.cardLabelText, 'i');
  const maskId = new RegExp(rules.maskTestId);
  const maskFilled = new RegExp(rules.maskFilledTestId);
  const maskField = new RegExp(rules.maskFieldTestId, 'i');
  const claimLink = new RegExp(rules.claimLinkText);
  const protectedId = new RegExp(rules.protectedTestId, 'i');
  const allowedControl = new RegExp(rules.allowedControl);
  const allowedStatus = new RegExp(rules.allowedStatus);
  const allowedEmpty = new RegExp(rules.allowedEmptyInput);
  const testIdOf = (element) => (element && element.dataset ? element.dataset.testid ?? '' : '');
  const card = new Set();
  const masked = [];
  const mask = (element, reason) => {
    if (element.hasAttribute(attribute)) return;
    element.setAttribute(attribute, String(masked.length));
    masked.push(reason);
  };
  const values = [];

  // Fields first, so a masked field's content is never read as page text.
  for (const field of document.querySelectorAll('input, textarea')) {
    if (!visible(field)) continue;
    // A checkbox holds no secret, even one named for a password policy.
    if (field.type === 'checkbox' || field.type === 'radio') continue;
    const id = testIdOf(field) || testIdOf(field.closest('[data-testid]'));
    const value = typeof field.value === 'string' ? field.value : '';
    if (field.type === 'password' || maskField.test(id)) mask(field, 'password field');
    else if (maskId.test(testIdOf(field))) mask(field, 'protected value');
    else if (maskFilled.test(id) && value !== '') mask(field, 'filled secret field');
    else if (claimLink.test(value)) mask(field, 'claim link');
    else if (cardText.test(value)) mask(field, 'private key field');
    else if (value !== '') values.push(value);
  }

  for (const element of document.querySelectorAll('[data-testid]')) {
    const id = testIdOf(element);
    if (!visible(element)) continue;
    if (cardId.test(id)) card.add('recovery phrase');
    else if (maskId.test(id)) mask(element, 'protected value');
  }

  const text = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const value = node.nodeValue ?? '';
    if (!parent || !value.trim() || !visible(parent) || parent.closest(`[${attribute}]`)) continue;
    if (claimLink.test(value)) { mask(parent, 'claim link'); continue; }
    if (cardText.test(value)) card.add('private key text');
    else if (cardLabel.test(value)) card.add('raw private keys');
    text.push(value);
  }
  // A key split across adjacent text nodes still reads as one string here.
  if (cardText.test(text.join(''))) card.add('private key text');

  for (const element of document.querySelectorAll('[data-testid]')) {
    const id = testIdOf(element);
    if (!protectedId.test(id) || cardId.test(id) || !visible(element) || element.closest(`[${attribute}]`)) continue;
    const control = element.tagName === 'BUTTON' || (element.tagName === 'INPUT' && element.type === 'checkbox');
    if (control && allowedControl.test(id)) continue;
    if (allowedStatus.test(id)) continue;
    if (element.tagName === 'INPUT' && element.value === '' && allowedEmpty.test(id)) continue;
    card.add('protected surface');
  }

  return {
    mode: card.size ? 'card' : masked.length ? 'mask' : 'clean',
    reasons: [...new Set([...card, ...masked])].sort(),
    masks: masked.length,
    text: text.join('\n'),
    values,
  };
}

/** Static captions for each card reason. A caption never carries content. */
export const LIVE_CARD_CAPTIONS = Object.freeze({
  'recovery phrase': 'Recovery phrase hidden',
  'private key text': 'Private key hidden',
  'raw private keys': 'Private keys hidden',
  'protected surface': 'Protected screen hidden',
  'known secret': 'Secret hidden',
});

/**
 * The known-secret canary. It lives in the recording process only and keeps
 * keyed hashes, never the values: a password, a claim fragment or a tx key is
 * added whole, a recovery phrase as its three-word windows (single words are
 * ordinary English and would match everywhere). `hit` reports whether a sample
 * of visible text and field values contains any of them.
 */
export function createSecretCanary() {
  const key = randomBytes(32);
  const digest = (value) => createHmac('sha256', key).update(value).digest('base64');
  const exact = new Set();
  const lengths = new Set();
  const grams = new Set();
  const wordsOf = (text) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  // Secrets here are random strings (base64url passwords and fragments, hex
  // keys). A secret can sit inside a longer run, so each run is searched with a
  // window per known secret length rather than split on guessed punctuation.
  const runsOf = (text) => text.match(/[A-Za-z0-9_\-+~%]{8,}/g) ?? [];
  return {
    addSecret(value) {
      if (typeof value !== 'string' || value.length < 8) return;
      exact.add(digest(value));
      lengths.add(value.length);
    },
    addPhrase(words) {
      const normal = [...words].map((word) => String(word).toLowerCase());
      for (let i = 0; i + 3 <= normal.length; i++) grams.add(digest(normal.slice(i, i + 3).join(' ')));
    },
    hit(sample) {
      const text = typeof sample?.text === 'string' ? sample.text : '';
      const values = Array.isArray(sample?.values) ? sample.values.filter((value) => typeof value === 'string') : [];
      if (exact.size) {
        for (const value of values) if (exact.has(digest(value))) return true;
        for (const run of runsOf([text, ...values].join('\n'))) {
          for (const length of lengths) {
            for (let i = 0; i + length <= run.length; i++) if (exact.has(digest(run.slice(i, i + length)))) return true;
          }
        }
      }
      if (grams.size) {
        const words = wordsOf([text, ...values].join(' '));
        for (let i = 0; i + 3 <= words.length; i++) if (grams.has(digest(words.slice(i, i + 3).join(' ')))) return true;
      }
      return false;
    },
    get size() { return exact.size + grams.size; },
  };
}
