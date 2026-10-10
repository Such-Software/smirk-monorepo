/**
 * Area H (cross-browser and desktop) capture policy: hold durations, the
 * redaction rules the in-page guard applies, the known-secret canary, label
 * hygiene and the timeline verifier.
 *
 * This module never prints, logs or returns a secret. Every helper that sees
 * one (the canary) keeps only salted digests and answers with a static label.
 *
 * The rules here are the H lane's copy of the reviewed capture-lane design
 * (redact and continue rather than refuse and abort). They live in an
 * area-prefixed file so the shared demo guard (demo/guard.mjs) is unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AREA = 'H-cross-browser-desktop';

/**
 * Owner's VIDEO POLICY, enforced by the recorder and checked on the timeline.
 * @type {Readonly<{ preTapMs: number, settledMs: number, resultMs: number }>}
 */
export const HOLDS = Object.freeze({
  /** Static screen before every tap. */
  preTapMs: 6_000,
  /** Every settled screen stays still at least this long. */
  settledMs: 12_000,
  /** Key results: balances, confirmations, tip claimed, message received, swap status, history detail. */
  resultMs: 25_000,
});

/** About four frames a second; identical frames are stored once. */
export const FRAME_INTERVAL_MS = 250;

/** Two consecutive clean passes, this far apart, end a secret scope. */
export const CLEAN_PASS_GAP_MS = 400;

/** The exact release candidate under test (run 11204, source 14a74e10). */
export const RELEASE = Object.freeze({
  version: '0.3.1',
  run: '11204',
  sourceCommit: '14a74e10af383cfb6f76049024c4f750f89fe279',
  buildsWrapper: 'b615d731d30e307e130840de8ca84a6a61ed12f8',
  stagedDir: join(homedir(), 'Build', 'smirk-release', 'v0.3.1-run-11204', 'staged'),
  chromeZip: Object.freeze({
    file: 'smirk-wallet-chrome-v0.3.1.zip',
    sha256: 'e64fb7aca1012b10cc078fcdc272685e0966e356297a5c8aa59485aa08485776',
  }),
  firefoxZip: Object.freeze({
    file: 'smirk-wallet-firefox-v0.3.1.zip',
    sha256: 'd1bc246338f1fb520717a0e76e125c1a301e9b58743e8a027cadfc2d4e6647c4',
  }),
  geckoId: 'wallet@smirk.cash',
  macBundleId: 'cash.smirk.wallet',
  macTeamId: 'D8PL9F7X33',
});

/** Machine-local footage root. Never promoted automatically. */
export const FOOTAGE_ROOT = join(homedir(), 'Build', 'smirk-e2e', 'v0.3.1-run-11204', 'footage');

/** Assets in Home order; test ids are asset-row-<id> and asset-row-<id>-balance. */
export const ASSETS = Object.freeze(['btc', 'ltc', 'xmr', 'wow', 'grin']);

/**
 * Masked surfaces. The in-page guard detects them with these exact selectors
 * and the Chromium recorder masks the same selectors, so detection and masking
 * cannot drift apart. Firefox (WebDriver) has no masks: any hit there turns the
 * whole frame into a redaction card.
 */
export const MASKS = Object.freeze({
  'Password field': Object.freeze({ css: 'input[type="password"]' }),
  'Tip share link': Object.freeze({ css: '[data-testid="tip-share-url"]' }),
  'Tip paste field': Object.freeze({ css: '[data-testid="paste-tip-input"], [data-testid="paste-dispatch-input"]', whenFilled: true }),
  'Transaction key': Object.freeze({ css: '[data-testid="tx-detail-tx-key"]' }),
  'Nostr key field': Object.freeze({ css: '[data-testid^="nostr-nsec-"]' }),
  'Nostr import field': Object.freeze({ css: '[data-testid="nostr-import-nsec"], [data-testid="nostr-restore-input"]', whenFilled: true }),
  'Swap private link': Object.freeze({ css: '[data-testid="swap-status-private-link"]' }),
});

/** Claim links carry their key in the fragment: /tip/<id>#<fragment>. */
export const CLAIM_LINK_TEXT = String.raw`/tip/[A-Za-z0-9_-]{4,}#[A-Za-z0-9_~.%-]{8,}`;

/** Rules handed to the in-page guard (fixtures/H-cross-browser-desktop-guard.mjs). */
export const GUARD_RULES = Object.freeze({
  // Whole frame becomes a card: these screens exist to show or take a phrase.
  cardTestId: '^(onboarding-create-seed-word-\\d+|onboarding-verify-word-\\d+|onboarding-import-word-\\d+|settings-revealed-phrase)$',
  // Fail closed: any other protected-looking id that is not admitted below.
  protectedTestId: '(mnemonic|seed|recovery|backup|export|reveal|nsec|private|secret|password|unlock|import-word|tx-key|share-url)',
  // Admitted: request-only controls (behind a password prompt) and fields the
  // mask rules cover. The welcome screen, lock screen, Settings root and History
  // are recordable; their password fields are masked.
  admittedTestId: '^(settings-reveal-btn|settings-reveal-password|lockscreen-root|lockscreen-error|lockscreen-unlock-btn|lockscreen-password-input'
    + '|tx-detail-reveal-key|tx-detail-tx-key|require-password-sends|require-password-signing|bootstrap-error-unlock|legacy-needs-unlock'
    + '|nostr-unlock-prompt|nostr-unlock-input|nostr-unlock-submit|nostr-unlock-manage|nostr-export-backup|nostr-import-nsec|nostr-restore-input'
    + '|nostr-reveal-[0-9a-f]{64}|nostr-nsec-[0-9a-f]{64}|onboarding-password-input|onboarding-password-confirm-input|operation-password'
    + '|operation-password-confirm|migrate-password|tip-share-url|swap-status-private-link|home-error-relock-btn)$',
  privateKeyText: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  claimLinkText: CLAIM_LINK_TEXT,
  masks: MASKS,
});

const LABEL = /^[A-Za-z][A-Za-z0-9 ,.:;()'/+&-]{0,79}$/;
const VALUE_LIKE = /:\/\/|[0-9a-f]{16,}|[1-9A-HJ-NP-Za-km-z]{26,}|\d{5,}/i;

/**
 * Footage labels are short static strings, never values or URLs. The error
 * deliberately does not echo the label, which could be the value it rejects.
 */
export function assertStaticLabel(label) {
  if (typeof label !== 'string' || !LABEL.test(label) || VALUE_LIKE.test(label)) {
    throw new Error('footage labels must be short static text, never values, addresses or URLs');
  }
  return label;
}

const digest = (salt, value) => createHash('sha256').update(salt).update('\0').update(value).digest('hex');

/**
 * Known-secret canary. Holds only salted digests: the caller may zero its
 * plaintext afterwards. `check` answers with a static label or null.
 *
 * Phrase words: a run of three consecutive phrase words in visible text, or
 * three input values that are phrase words. A single BIP39 word on screen is
 * ordinary UI text ("fee", "swap"); three in phrase order is a leak.
 * Exact secrets (passwords, claim fragments, transaction keys): any whitespace
 * token or input value equal to one, or containing one.
 */
export function makeCanary({ phraseWords = [], exact = [] } = {}) {
  const salt = randomBytes(16);
  const words = phraseWords.map((word) => digest(salt, word.trim().toLowerCase()));
  const wordSet = new Set(words);
  const exactSet = new Set();
  const exactLengths = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || value.length < 8) return;
    exactSet.add(digest(salt, value));
    exactLengths.add(value.length);
  };
  exact.forEach(add);
  const containsExact = (haystack) => {
    if (!haystack || !exactSet.size) return false;
    for (const length of exactLengths) {
      for (let at = 0; at + length <= haystack.length; at++) {
        if (exactSet.has(digest(salt, haystack.slice(at, at + length)))) return true;
      }
    }
    return false;
  };
  return {
    /** Remember another exact secret (a claim fragment, a revealed tx key). */
    remember: add,
    check(snapshot) {
      const text = snapshot?.text ?? '';
      const values = (snapshot?.values ?? []).filter((value) => typeof value === 'string');
      if (words.length >= 3) {
        const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((token) => digest(salt, token));
        for (let i = 0; i + 2 < tokens.length; i++) {
          for (let w = 0; w + 2 < words.length; w++) {
            if (tokens[i] === words[w] && tokens[i + 1] === words[w + 1] && tokens[i + 2] === words[w + 2]) return 'Phrase words visible';
          }
        }
        if (values.filter((value) => wordSet.has(digest(salt, value.trim().toLowerCase()))).length >= 3) return 'Phrase words in fields';
      }
      // Exact secrets: short haystacks are scanned fully; long page text by token.
      for (const value of values) if (value.length <= 4096 && containsExact(value)) return 'Known secret in a field';
      for (const token of text.split(/\s+/)) if (token.length >= 8 && token.length <= 4096 && containsExact(token)) return 'Known secret visible';
      return null;
    },
  };
}

/**
 * Timeline verifier: every hold meets policy, every frame has a guard verdict
 * and every label is static. Returns violations as static strings.
 */
export function verifyTimeline(timeline, holds = HOLDS) {
  const problems = [];
  const minimum = { tap: holds.preTapMs, settled: holds.settledMs, result: holds.resultMs };
  for (const event of timeline.events ?? []) {
    try { assertStaticLabel(event.label); } catch { problems.push(`an ${event.kind} event has a non-static label`); }
    const floor = minimum[event.kind];
    if (floor !== undefined && !(event.holdMs >= floor)) problems.push(`${event.kind} hold shorter than ${floor} ms`);
  }
  for (const frame of timeline.frames ?? []) {
    if (!['clean', 'masked', 'card'].includes(frame.verdict)) { problems.push('a frame has no guard verdict'); break; }
    if (frame.verdict === 'card' && frame.file) { problems.push('a redaction card frame carries a screenshot'); break; }
  }
  return problems;
}
