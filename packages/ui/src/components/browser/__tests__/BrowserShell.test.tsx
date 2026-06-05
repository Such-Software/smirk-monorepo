/**
 * Static-render tests for `BrowserShell`.
 *
 * `BrowserShell` subscribes to the controller inside `useEffect`,
 * which does NOT run during SSR. So a server-render of the shell
 * shows the empty-snapshot path: just the outer container and the
 * frame slot. That's actually the most important thing to test here —
 * it's what a screen reader announces on first paint, before the JS
 * runtime has propagated any controller state.
 *
 * Interactive controller-driven rendering (tab strip + URL bar)
 * happens once `useEffect` has fired and is exercised by
 * MockController's own conformance suite.
 *
 * JSX is replaced by `h()` to keep the tests independent of the
 * runner's JSX-transform settings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';

import { MockController } from '@smirk/dapp-browser';
import { BrowserShell } from '../BrowserShell';

describe('BrowserShell — static (no useEffect)', () => {
  it('renders without throwing', () => {
    const controller = new MockController();
    const html = renderToString(h(BrowserShell, { controller }));
    assert.ok(html.length > 0);
  });

  it('always renders the frame slot with role="region"', () => {
    const controller = new MockController();
    const html = renderToString(h(BrowserShell, { controller }));
    assert.match(html, /role="region"/);
  });

  it('frame slot has aria-label="Embedded browser content"', () => {
    const controller = new MockController();
    const html = renderToString(h(BrowserShell, { controller }));
    assert.match(html, /aria-label="Embedded browser content"/);
  });

  it('outer container carries the smirk-browser-shell class', () => {
    const controller = new MockController();
    const html = renderToString(h(BrowserShell, { controller }));
    assert.match(html, /class="smirk-browser-shell"/);
  });

  it('applies a custom class when provided', () => {
    const controller = new MockController();
    const html = renderToString(
      h(BrowserShell, { controller, class: 'my-shell' }),
    );
    assert.match(html, /class="smirk-browser-shell my-shell"/);
  });

  it('omits tab strip + URL bar on first SSR render (useEffect has not fired)', () => {
    // Until useEffect runs and the controller emits a snapshot, the
    // shell renders only the frame slot. This is intentional — it's
    // the "before JS" view and what screen readers see on first paint.
    const controller = new MockController();
    const html = renderToString(h(BrowserShell, { controller }));
    assert.doesNotMatch(html, /smirk-browser-urlbar/);
    assert.doesNotMatch(html, /smirk-browser-tabstrip/);
  });
});
