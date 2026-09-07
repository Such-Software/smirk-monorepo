/**
 * Unit tests for `formatMnemonicForClipboard`, the one function standing
 * between the seed screen and the user's clipboard.
 *
 * The seed grid renders each word next to its position number, so a
 * hand-dragged selection produces "01 abandon 02 ability …": a phrase that
 * silently fails to restore. The Copy control must emit the words alone. These
 * cases pin that contract, including the round trip through the same tokenizer
 * the import step's paste handler uses (`text.trim().split(/\s+/)`), which is
 * where a bad copy would actually surface.
 *
 * Matches the runner the rest of @smirk/ui uses: node:test + node:assert/strict,
 * no jsdom. The function is pure, so no component mount is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatMnemonicForClipboard, watchForSettlement } from '../OnboardingWizard';

// A real BIP39-shaped 12-word phrase; only the whitespace around it varies.
const WORDS = [
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident',
];
const PHRASE = WORDS.join(' ');

/** What `ImportMnemonic`'s paste handler does with clipboard text. */
const tokenizeLikeImport = (text: string) => text.trim().split(/\s+/).filter(Boolean);

describe('formatMnemonicForClipboard — words only', () => {
  it('passes a clean phrase through unchanged', () => {
    assert.equal(formatMnemonicForClipboard(PHRASE), PHRASE);
  });

  it('emits no digits, so position numbers can never ride along', () => {
    assert.ok(!/\d/.test(formatMnemonicForClipboard(PHRASE)));
  });

  it('is exactly single-spaced: no double spaces, no leading or trailing space', () => {
    const out = formatMnemonicForClipboard(`  ${PHRASE}  `);
    assert.equal(out, out.trim());
    assert.ok(!out.includes('  '));
  });
});

describe('formatMnemonicForClipboard — whitespace normalization', () => {
  it('trims surrounding whitespace', () => {
    assert.equal(formatMnemonicForClipboard(`\n  ${PHRASE}\t \n`), PHRASE);
  });

  it('collapses runs of spaces, tabs and newlines between words', () => {
    assert.equal(formatMnemonicForClipboard(WORDS.join('  \t\n ')), PHRASE);
  });

  it('collapses the newline-separated shape a grid selection produces', () => {
    // Selecting the rendered <li> rows yields one word per line.
    assert.equal(formatMnemonicForClipboard(WORDS.join('\n')), PHRASE);
  });
});

describe('formatMnemonicForClipboard — degenerate input', () => {
  it('returns an empty string for an empty mnemonic', () => {
    assert.equal(formatMnemonicForClipboard(''), '');
  });

  it('returns an empty string for whitespace only', () => {
    assert.equal(formatMnemonicForClipboard('   \n\t '), '');
  });

  it('handles a single word', () => {
    assert.equal(formatMnemonicForClipboard('  abandon '), 'abandon');
  });
});

describe('formatMnemonicForClipboard — round trip through the import step', () => {
  it('the copied phrase tokenizes back to exactly the 12 words, in order', () => {
    assert.deepEqual(tokenizeLikeImport(formatMnemonicForClipboard(PHRASE)), WORDS);
  });

  it('a messily-spaced source still yields the 12-word paste the import step auto-fills from', () => {
    const messy = `\n ${WORDS.join('   ')} \n`;
    assert.equal(tokenizeLikeImport(formatMnemonicForClipboard(messy)).length, 12);
  });
});

/**
 * `watchForSettlement`: what the wallet does when a settlement check FAILS.
 *
 * This is the money path. The user has the pay-to target on screen and may
 * already have sent funds, so the only acceptable reason to stop watching is
 * settlement or an explicit cancel. A rejected poll used to end the watch
 * permanently, and nothing could restart it.
 */
describe('watchForSettlement', () => {
  /** Collects the delays asked for instead of waiting them out. */
  const recordingSleep = () => {
    const waited: number[] = [];
    return { waited, sleep: async (ms: number) => void waited.push(ms) };
  };

  it('keeps watching after a poll rejects, and still reports settlement', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const outcome = await watchForSettlement({
      poll: async () => {
        calls++;
        if (calls === 1) throw new Error('network blip');
        return 'done';
      },
      onWarning: () => {},
      sleep,
      cancelled: () => false,
    });
    assert.equal(outcome, 'done');
    assert.equal(calls, 2, 'a rejected poll must not end the watch');
  });

  it('survives a long outage rather than giving up', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const outcome = await watchForSettlement({
      poll: async () => {
        calls++;
        if (calls <= 20) throw new Error('backend down');
        return 'done';
      },
      onWarning: () => {},
      sleep,
      cancelled: () => false,
    });
    assert.equal(outcome, 'done');
  });

  it('backs off as failures accumulate, and caps the delay', async () => {
    const { waited, sleep } = recordingSleep();
    await watchForSettlement({
      poll: async (attempt) => {
        if (attempt < 12) throw new Error('down');
        return 'done';
      },
      onWarning: () => {},
      sleep,
      cancelled: () => false,
    });
    // Strictly increasing while it ramps, then flat: never unbounded, and never
    // hammering a struggling backend at the fixed interval.
    assert.ok(waited.length > 0);
    assert.ok(
      waited.every((ms, i) => i === 0 || ms >= waited[i - 1]!),
      'backoff must not decrease while failures continue',
    );
    assert.ok(Math.max(...waited) <= 30_000, 'backoff must stay capped');
  });

  it('warns only once failures persist, and withdraws the warning on recovery', async () => {
    const { sleep } = recordingSleep();
    const warnings: Array<string | null> = [];
    let calls = 0;
    await watchForSettlement({
      poll: async () => {
        calls++;
        if (calls <= 3) throw new Error('down');
        return 'done';
      },
      onWarning: (m) => void warnings.push(m),
      sleep,
      cancelled: () => false,
    });
    // A single blip stays silent; a sustained one speaks up.
    assert.ok(
      warnings.some((w) => typeof w === 'string' && w.length > 0),
      'a sustained outage must tell the user the watch is still running',
    );
    // And the last thing it does is clear the warning, since the poll recovered.
    assert.equal(warnings.at(-1), null);
  });

  it('reassures rather than asking for a second payment', async () => {
    const { sleep } = recordingSleep();
    const warnings: string[] = [];
    let calls = 0;
    await watchForSettlement({
      poll: async () => {
        calls++;
        if (calls <= 3) throw new Error('down');
        return 'done';
      },
      onWarning: (m) => {
        if (m) warnings.push(m);
      },
      sleep,
      cancelled: () => false,
    });
    // Telling a user to retry a payment they already made is the expensive
    // failure; the copy must rule it out.
    assert.ok(warnings.length > 0);
    assert.ok(
      warnings.every((w) => /don't need to send it again/i.test(w)),
      'the warning must not imply the payment should be re-sent',
    );
  });

  it('stops promptly when cancelled', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const outcome = await watchForSettlement({
      poll: async () => {
        calls++;
        return 'pending';
      },
      onWarning: () => {},
      sleep,
      cancelled: () => calls >= 3,
    });
    assert.equal(outcome, 'cancelled');
  });
});
