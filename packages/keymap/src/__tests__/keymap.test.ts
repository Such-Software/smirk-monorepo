/**
 * Tests for the cross-platform keymap registry.
 *
 * Coverage:
 *  - `lookup()` returns only bindings for the requested platform.
 *  - `chordMatches()` exact-matches keys + every modifier flag.
 *  - `actionsFromEvent()` resolves zero, one, or multiple actions.
 *  - `detectPlatform()` composes host + OS correctly.
 *  - `DEFAULT_KEYMAP` invariants (no orphan actions, no duplicate
 *    bindings, every action has at least one desktop or extension
 *    binding).
 *
 * The DEFAULT_KEYMAP invariants are checked as a single suite to make
 * accidental regressions obvious in CI output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEYMAP,
  actionsFromEvent,
  chordMatches,
  detectPlatform,
  lookup,
} from '../index';
import type {
  KeyChord,
  KeymapAction,
  KeymapEntry,
  KeymapPlatform,
} from '../index';

// Re-create a minimal KeyboardEvent shape for tests. We only need the
// fields `chordMatches` reads: `key`, `ctrlKey`, `metaKey`, `altKey`,
// `shiftKey`. Casting through `unknown` keeps the call site honest
// without forcing tests into jsdom.
function fakeEvent(opts: {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}): KeyboardEvent {
  return {
    key: opts.key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    altKey: !!opts.alt,
    shiftKey: !!opts.shift,
  } as unknown as KeyboardEvent;
}

// ----------------------------------------------------------------------
// lookup()
// ----------------------------------------------------------------------

describe('lookup', () => {
  it('returns bindings filtered to the requested platform', () => {
    const bindings = lookup('browser:focus-url-bar', 'desktop-mac');
    assert.ok(bindings.length >= 1);
    for (const b of bindings) {
      assert.equal(b.platform, 'desktop-mac');
    }
  });

  it('returns an empty array for an action without bindings on this platform', () => {
    // Mobile platforms have no bindings in the default keymap.
    const bindings = lookup('browser:focus-url-bar', 'mobile-ios');
    assert.deepEqual(bindings, []);
  });

  it('returns an empty array when given a custom keymap that omits the action', () => {
    const custom: readonly KeymapEntry[] = [];
    const bindings = lookup('wallet:lock', 'desktop-mac', custom);
    assert.deepEqual(bindings, []);
  });

  it('mac binding for focus-url-bar uses meta (Cmd)', () => {
    const bindings = lookup('browser:focus-url-bar', 'desktop-mac');
    assert.ok(bindings.some((b) => b.chord.key === 'l' && b.chord.meta === true));
  });

  it('win binding for focus-url-bar uses ctrl, not meta', () => {
    const bindings = lookup('browser:focus-url-bar', 'desktop-win');
    assert.ok(bindings.some((b) => b.chord.key === 'l' && b.chord.ctrl === true));
    for (const b of bindings) {
      assert.notEqual(b.chord.meta, true);
    }
  });

  it('linux binding for focus-url-bar uses ctrl, not meta', () => {
    const bindings = lookup('browser:focus-url-bar', 'desktop-linux');
    assert.ok(bindings.some((b) => b.chord.key === 'l' && b.chord.ctrl === true));
    for (const b of bindings) {
      assert.notEqual(b.chord.meta, true);
    }
  });
});

// ----------------------------------------------------------------------
// chordMatches()
// ----------------------------------------------------------------------

describe('chordMatches', () => {
  it('matches when key + every modifier flag match', () => {
    const chord: KeyChord = { key: 'l', meta: true };
    assert.equal(chordMatches(fakeEvent({ key: 'l', meta: true }), chord), true);
  });

  it('does NOT match when an unwanted modifier is present', () => {
    const chord: KeyChord = { key: 'l', meta: true };
    assert.equal(
      chordMatches(fakeEvent({ key: 'l', meta: true, shift: true }), chord),
      false,
    );
  });

  it('does NOT match when a required modifier is missing', () => {
    const chord: KeyChord = { key: 'l', meta: true, shift: true };
    assert.equal(chordMatches(fakeEvent({ key: 'l', meta: true }), chord), false);
  });

  it('does NOT match when the key differs', () => {
    const chord: KeyChord = { key: 'l', meta: true };
    assert.equal(chordMatches(fakeEvent({ key: 'k', meta: true }), chord), false);
  });

  it('matches a no-modifier chord (e.g. F5)', () => {
    const chord: KeyChord = { key: 'F5' };
    assert.equal(chordMatches(fakeEvent({ key: 'F5' }), chord), true);
    assert.equal(chordMatches(fakeEvent({ key: 'F5', ctrl: true }), chord), false);
  });

  it('is case-sensitive on the `key` value', () => {
    const chord: KeyChord = { key: 'L', meta: true, shift: true };
    assert.equal(
      chordMatches(fakeEvent({ key: 'L', meta: true, shift: true }), chord),
      true,
    );
    assert.equal(
      chordMatches(fakeEvent({ key: 'l', meta: true, shift: true }), chord),
      false,
    );
  });
});

// ----------------------------------------------------------------------
// actionsFromEvent()
// ----------------------------------------------------------------------

describe('actionsFromEvent', () => {
  it('returns the action for a matching desktop-mac event', () => {
    const actions = actionsFromEvent(
      fakeEvent({ key: 'l', meta: true }),
      'desktop-mac',
    );
    assert.deepEqual(actions, ['browser:focus-url-bar']);
  });

  it('returns the action for a matching desktop-win event', () => {
    const actions = actionsFromEvent(
      fakeEvent({ key: 'l', ctrl: true }),
      'desktop-win',
    );
    assert.deepEqual(actions, ['browser:focus-url-bar']);
  });

  it('returns an empty array when no binding matches', () => {
    const actions = actionsFromEvent(
      fakeEvent({ key: 'q', meta: true }),
      'desktop-mac',
    );
    assert.deepEqual(actions, []);
  });

  it('returns the action only once even if it has multiple matching bindings', () => {
    // `browser:reload` declares both `Cmd+R` and `F5` on mac. An
    // event matching `Cmd+R` should yield exactly one action entry —
    // not duplicated by both bindings firing.
    const actions = actionsFromEvent(
      fakeEvent({ key: 'r', meta: true }),
      'desktop-mac',
    );
    assert.deepEqual(actions, ['browser:reload']);
  });

  it('matches F5 → browser:reload on every desktop platform', () => {
    for (const platform of ['desktop-mac', 'desktop-win', 'desktop-linux'] as const) {
      const actions = actionsFromEvent(fakeEvent({ key: 'F5' }), platform);
      assert.deepEqual(actions, ['browser:reload'], `failed on ${platform}`);
    }
  });

  it('Cmd+Shift+R fires wallet:refresh-balances, not browser:reload, on mac', () => {
    const actions = actionsFromEvent(
      fakeEvent({ key: 'r', meta: true, shift: true }),
      'desktop-mac',
    );
    assert.deepEqual(actions, ['wallet:refresh-balances']);
  });

  it('Cmd+1..4 switches between wallet tabs on mac', () => {
    const cases: Array<[string, KeymapAction]> = [
      ['1', 'wallet:switch-tab-home'],
      ['2', 'wallet:switch-tab-swap'],
      ['3', 'wallet:switch-tab-inbox'],
      ['4', 'wallet:switch-tab-settings'],
    ];
    for (const [key, expected] of cases) {
      const actions = actionsFromEvent(fakeEvent({ key, meta: true }), 'desktop-mac');
      assert.deepEqual(actions, [expected], `Cmd+${key} should fire ${expected}`);
    }
  });

  it('mobile platforms get no actions from a synthetic desktop chord', () => {
    const actions = actionsFromEvent(
      fakeEvent({ key: 'l', meta: true }),
      'mobile-ios',
    );
    assert.deepEqual(actions, []);
  });
});

// ----------------------------------------------------------------------
// detectPlatform()
// ----------------------------------------------------------------------

describe('detectPlatform', () => {
  it('returns a string of the form `${host}-${os}`', () => {
    // We don't control the test runner's UA so the OS half varies;
    // assert the prefix structure only.
    const p = detectPlatform('desktop');
    assert.match(p, /^desktop-(mac|win|linux|ios|android)$/);
  });

  it('returns extension-* for the extension host', () => {
    const p = detectPlatform('extension');
    assert.match(p, /^extension-(mac|win|linux|ios|android)$/);
  });

  it('returns mobile-* for the mobile host', () => {
    const p = detectPlatform('mobile');
    assert.match(p, /^mobile-(mac|win|linux|ios|android)$/);
  });
});

// ----------------------------------------------------------------------
// DEFAULT_KEYMAP invariants
// ----------------------------------------------------------------------

describe('DEFAULT_KEYMAP invariants', () => {
  it('every entry has at least one binding', () => {
    for (const entry of DEFAULT_KEYMAP) {
      assert.ok(
        entry.bindings.length > 0,
        `action ${entry.action} has zero bindings`,
      );
    }
  });

  it('no two entries declare the same action', () => {
    const seen = new Set<string>();
    for (const entry of DEFAULT_KEYMAP) {
      assert.ok(
        !seen.has(entry.action),
        `duplicate action: ${entry.action}`,
      );
      seen.add(entry.action);
    }
  });

  it('every entry has a non-empty label', () => {
    for (const entry of DEFAULT_KEYMAP) {
      assert.ok(entry.label.length > 0, `empty label for ${entry.action}`);
    }
  });

  it('no binding chord is empty (would match every event)', () => {
    for (const entry of DEFAULT_KEYMAP) {
      for (const b of entry.bindings) {
        assert.ok(
          b.chord.key.length > 0,
          `empty key in binding for ${entry.action}`,
        );
      }
    }
  });

  it('no two bindings on the same platform collide on the same chord', () => {
    const seen = new Map<string, KeymapAction>();
    for (const entry of DEFAULT_KEYMAP) {
      for (const b of entry.bindings) {
        const key = chordSignature(b.platform, b.chord);
        const owner = seen.get(key);
        assert.ok(
          owner === undefined,
          `chord collision on ${b.platform} between ${owner} and ${entry.action}: ${key}`,
        );
        seen.set(key, entry.action);
      }
    }
  });

  it('every action has at least one desktop OR extension binding', () => {
    // Mobile-only is allowed in principle but no actions in the
    // default keymap should be mobile-only — that's a sign the
    // desktop binding got dropped.
    for (const entry of DEFAULT_KEYMAP) {
      const hasDesktopOrExt = entry.bindings.some(
        (b) =>
          b.platform.startsWith('desktop-') || b.platform.startsWith('extension-'),
      );
      assert.ok(
        hasDesktopOrExt,
        `action ${entry.action} has no desktop or extension binding`,
      );
    }
  });
});

function chordSignature(platform: KeymapPlatform, chord: KeyChord): string {
  return [
    platform,
    chord.key,
    chord.ctrl ? 'C' : '',
    chord.meta ? 'M' : '',
    chord.alt ? 'A' : '',
    chord.shift ? 'S' : '',
  ].join('|');
}
