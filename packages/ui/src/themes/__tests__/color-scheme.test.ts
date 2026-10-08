import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorSchemeFor } from '../apply';
import { listThemes } from '../registry';

test('dark backgrounds declare a dark color-scheme', () => {
  assert.equal(colorSchemeFor('#0e0e10'), 'dark');
  assert.equal(colorSchemeFor('#0055aa'), 'dark');
  assert.equal(colorSchemeFor('#000'), 'dark');
});

test('light backgrounds declare a light color-scheme', () => {
  assert.equal(colorSchemeFor('#ece9d8'), 'light');
  assert.equal(colorSchemeFor('#c0c0c0'), 'light');
  assert.equal(colorSchemeFor('#fff'), 'light');
});

test('an unparseable background falls back to the default theme (dark)', () => {
  assert.equal(colorSchemeFor('linear-gradient(red, blue)'), 'dark');
  assert.equal(colorSchemeFor(''), 'dark');
});

test('every built-in theme declares a scheme matching its background', () => {
  for (const theme of listThemes()) {
    const scheme = colorSchemeFor(theme.tokens.bg ?? '#0e0e10');
    assert.ok(scheme === 'dark' || scheme === 'light', theme.id);
  }
  const byId = new Map(listThemes().map((t) => [t.id, t]));
  assert.equal(colorSchemeFor(byId.get('winxp')!.tokens.bg!), 'light');
  assert.equal(colorSchemeFor(byId.get('default')!.tokens.bg!), 'dark');
});
