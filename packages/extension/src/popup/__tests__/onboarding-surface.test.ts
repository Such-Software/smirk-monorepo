/**
 * Onboarding must never start somewhere the browser can destroy it mid-flow.
 *
 * Reported from real use on 2026-08-23: generate a seed in the action popup,
 * copy it, switch windows to paste it, come back. The popup has been rebuilt
 * from scratch at the welcome screen, and pressing create mints a DIFFERENT
 * seed. Save the first, fund the second, and the recovery phrase in your hand
 * belongs to a wallet that is not yours, with nothing on screen saying so.
 *
 * The mnemonic is held in memory on purpose (2026-05-10 audit: it must not
 * reach chrome.storage.session), so the surface is what has to change, not the
 * storage. These tests pin that decision down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type G = typeof globalThis & {
  chrome?: Record<string, unknown>;
  location?: { search: string };
};

function withEnv(search: string, runtimeId: string, fn: () => void) {
  const g = globalThis as G;
  const prevChrome = g.chrome;
  const prevLocation = g.location;
  g.chrome = { runtime: { id: runtimeId, getURL: (p: string) => `chrome-extension://x/${p}` } };
  Object.defineProperty(g, 'location', { value: { search }, configurable: true, writable: true });
  try {
    fn();
  } finally {
    g.chrome = prevChrome;
    Object.defineProperty(g, 'location', { value: prevLocation, configurable: true, writable: true });
  }
}

test('the action popup may not host onboarding', async () => {
  const { canHostOnboarding } = await import('../onboarding-surface.ts');
  withEnv('', 'abcdef', () => {
    assert.equal(
      canHostOnboarding(),
      false,
      'a popup with no ctx=tab marker must hand off, not render a seed it can lose',
    );
  });
});

test('a tab-hosted document may host onboarding', async () => {
  const { canHostOnboarding } = await import('../onboarding-surface.ts');
  withEnv('?ctx=tab', 'abcdef', () => {
    assert.equal(canHostOnboarding(), true);
  });
});

test('desktop hosts onboarding directly, being a real window already', async () => {
  const { canHostOnboarding } = await import('../onboarding-surface.ts');
  withEnv('', 'smirk-desktop', () => {
    assert.equal(canHostOnboarding(), true);
  });
});

test('an unreadable location fails toward the safe surface', async () => {
  const { canHostOnboarding } = await import('../onboarding-surface.ts');
  const g = globalThis as G;
  const prevChrome = g.chrome;
  const prevLocation = g.location;
  g.chrome = { runtime: { id: 'abcdef' } };
  Object.defineProperty(g, 'location', {
    get() {
      throw new Error('no location here');
    },
    configurable: true,
  });
  try {
    // Refusing is the safe direction: worst case the user clicks one extra
    // button, versus being shown a seed on a surface that can vanish.
    assert.equal(canHostOnboarding(), false);
  } finally {
    g.chrome = prevChrome;
    Object.defineProperty(g, 'location', { value: prevLocation, configurable: true, writable: true });
  }
});

test('the onboarding URL carries the marker canHostOnboarding looks for', async () => {
  const { onboardingUrl, canHostOnboarding } = await import('../onboarding-surface.ts');
  withEnv('', 'abcdef', () => {
    const url = onboardingUrl();
    const search = url.slice(url.indexOf('?'));
    // The producer and the consumer must agree, or first-run opens a tab that
    // immediately hands off to itself.
    withEnv(search, 'abcdef', () => {
      assert.equal(canHostOnboarding(), true, `round-trip failed for ${url}`);
    });
  });
});
