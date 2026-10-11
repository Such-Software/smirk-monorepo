/**
 * Test helper for the privacy tests: values a wallet test can hold, in the
 * forms a careless label, title or message would carry them, and a check for
 * any part of them in text. failure-record.test.mjs, private-reporter.test.mjs
 * and test-private-capture.mjs share it, so each asserts one property: no part
 * of any probe reaches the log or the console, in any case or separator.
 *
 * TEST_PHRASE is the first twelve words of the BIP-39 list, never a wallet's.
 * Every other value is random per run. Assertion messages name a probe, never
 * its value.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { PHRASE_WORDS } from './phrase-words.mjs';

/** Twelve phrase words that no output or source of these tests uses as words. */
export const TEST_PHRASE = Object.freeze(['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident']);

const LIST = [...PHRASE_WORDS];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const capital = (word) => word[0].toUpperCase() + word.slice(1);

/** `count` distinct random phrase words. */
export function randomPhrase(count = 12) {
  const words = new Set();
  while (words.size < count) words.add(LIST[randomInt(LIST.length)]);
  return [...words];
}

/** A phrase as a careless label might carry it: every case and separator, whole or in part. */
export function phraseForms(words) {
  return {
    'lower case': words.join(' '),
    'capitalized first word': [capital(words[0]), ...words.slice(1)].join(' '),
    'title case': words.map(capital).join(' '),
    'upper case': words.join(' ').toUpperCase(),
    'comma separated': words.join(', '),
    numbered: words.map((word, i) => `${i + 1}. ${word}`).join(' '),
    'one per line': words.join('\n'),
    hyphenated: words.join('-'),
    'eleven words': words.slice(0, 11).join(' '),
    'six words': words.slice(3, 9).join(', '),
    'in a sentence': `Confirm ${words.join(', ')} before continuing`,
  };
}

/** Letters of both cases with a digit in every fourth place: a token no long-run rule sees. */
export function mixedToken(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += i % 4 === 3 ? String(randomInt(10)) : LETTERS[randomInt(LETTERS.length)];
  return out;
}

/**
 * Every probe: `value` is what a label, title or message would quote, and
 * `parts` what must never appear (a claim link's key, not its host). `idShaped`
 * marks the values a screen test id is shaped against (failure-record.mjs
 * safeTestId: keys, addresses, long numbers, phrase runs). A password is not
 * one: the app never builds a test id from one, and its plain-word parts would
 * look like any other id word.
 */
export function probes() {
  const key = randomBytes(32).toString('hex');
  const whole = (name, value, idShaped = false) => ({ name, value, parts: [value], idShaped });
  return [
    ...Object.entries(phraseForms(TEST_PHRASE)).map(([form, value]) => ({ name: `phrase, ${form}`, value, parts: TEST_PHRASE, idShaped: true })),
    whole('hex key', key, true),
    whole('lane password', randomBytes(24).toString('base64url')),
    whole('password split by a hyphen', `${mixedToken(14)}-${mixedToken(14)}`),
    whole('base64 split by slash and plus', `${mixedToken(10)}/${mixedToken(10)}+${mixedToken(10)}`),
    whole('person password', 'Hunter-correct-horse-7'),
    whole('person password, title case', 'Correct-Horse-Battery-9'),
    whole('password with digits', 'Quokka-e2e-pass1'),
    whole('npub', `npub1${'q'.repeat(58)}`, true),
    whole('monero address', `4${'A'.repeat(94)}`, true),
    { name: 'claim link', value: `https://smirk.cash/tip/x#k=${key.slice(0, 32)}`, parts: [key.slice(0, 32)], idShaped: true },
    { name: 'bitcoin address', value: `bc1q${key.slice(0, 38)}`, parts: [key.slice(0, 38)], idShaped: true },
    { name: 'handle', value: `${key.slice(0, 20)}@example.org`, parts: [key.slice(0, 20)], idShaped: true },
    whole('long number', '123456789', true),
  ];
}

/**
 * Whether any part of `parts` appears in `text`, ignoring case: each piece of
 * four to seven letters or digits as a whole word, each longer piece by any
 * eight characters of it.
 */
export function leaked(text, parts) {
  const haystack = String(text).toLowerCase();
  for (const part of parts) {
    for (const piece of String(part).toLowerCase().split(/[^a-z0-9]+/)) {
      if (piece.length < 4) continue;
      if (piece.length < 8) {
        if (new RegExp(`(?<![a-z0-9])${piece}(?![a-z0-9])`).test(haystack)) return true;
        continue;
      }
      for (let i = 0; i + 8 <= piece.length; i++) if (haystack.includes(piece.slice(i, i + 8))) return true;
    }
  }
  return false;
}
