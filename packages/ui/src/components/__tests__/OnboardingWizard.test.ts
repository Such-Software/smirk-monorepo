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

import { formatMnemonicForClipboard } from '../OnboardingWizard';

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
