/**
 * Static-render tests for `BrowserUrlBar`.
 *
 * Uses `preact-render-to-string` rather than jsdom + a full testing-
 * library setup. This gives us:
 *  - Confidence the component compiles + renders without throwing.
 *  - Verification of ARIA roles / labels (a11y contract).
 *  - Verification of prop-driven content (URL display, security
 *    glyph, button labels).
 *
 * It does NOT exercise interactive flows (typing, clicks, focus
 * transitions). Those will be covered when we add jsdom +
 * `@testing-library/preact` in a focused infrastructure pass.
 *
 * Tests use Preact's `h()` (createElement) directly rather than JSX
 * so they don't depend on the test runner's JSX transform settings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';

import type { BrowserNavigationState } from '@smirk/dapp-browser';
import { BrowserUrlBar } from '../BrowserUrlBar';

const noop = (): void => undefined;

function stateOver(
  patch: Partial<BrowserNavigationState> = {},
): BrowserNavigationState {
  return {
    url: 'https://example.com',
    title: 'Example',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    origin: 'https://example.com',
    securityState: 'secure',
    ...patch,
  };
}

const baseHandlers = {
  onBack: noop,
  onForward: noop,
  onReload: noop,
  onSubmitUrl: noop,
};

describe('BrowserUrlBar — static render', () => {
  it('renders without throwing for the canonical happy-path state', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver(), ...baseHandlers }),
    );
    assert.ok(html.includes('smirk-browser-urlbar'));
    assert.ok(html.includes('https://example.com'));
  });

  it('renders aria-label="Address" on the URL input', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver(), ...baseHandlers }),
    );
    assert.match(html, /aria-label="Address"/);
  });

  it('renders Back / Forward / Reload buttons each with an aria-label', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver(), ...baseHandlers }),
    );
    assert.match(html, /aria-label="Back"/);
    assert.match(html, /aria-label="Forward"/);
    assert.match(html, /aria-label="Reload"/);
  });

  it('the Reload button becomes "Stop" while isLoading is true', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver({ isLoading: true }), ...baseHandlers }),
    );
    assert.match(html, /aria-label="Stop"/);
    assert.doesNotMatch(html, /aria-label="Reload"/);
  });

  it('Back is disabled when canGoBack is false', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver({ canGoBack: false }), ...baseHandlers }),
    );
    assert.match(
      html,
      /<button[^>]*aria-label="Back"[^>]*disabled[^>]*>/,
      'Back button should render with disabled attribute',
    );
  });

  it('Back is NOT disabled when canGoBack is true', () => {
    const html = renderToString(
      h(BrowserUrlBar, { state: stateOver({ canGoBack: true }), ...baseHandlers }),
    );
    assert.doesNotMatch(
      html,
      /<button[^>]*aria-label="Back"[^>]*disabled[^>]*>/,
    );
  });

  it('renders the secure glyph for securityState=secure', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver({ securityState: 'secure' }),
        ...baseHandlers,
      }),
    );
    assert.match(html, /title="Connection: secure"/);
  });

  it('renders the insecure glyph for securityState=insecure', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver({ securityState: 'insecure' }),
        ...baseHandlers,
      }),
    );
    assert.match(html, /title="Connection: insecure"/);
  });

  it('renders the mixed-content glyph for securityState=mixed', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver({ securityState: 'mixed' }),
        ...baseHandlers,
      }),
    );
    assert.match(html, /title="Connection: mixed"/);
  });

  it('renders an unknown indicator for non-network schemes', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver({ url: 'about:blank', securityState: 'unknown' }),
        ...baseHandlers,
      }),
    );
    assert.match(html, /title="Connection: unknown"/);
  });

  it('renders optional trailing content when provided', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver(),
        ...baseHandlers,
        trailing: h('span', { 'data-testid': 'bookmark-star' }, '⭐'),
      }),
    );
    assert.match(html, /data-testid="bookmark-star"/);
  });

  it('renders the URL from state when no draft is in flight', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver({ url: 'https://dapp.example.com/dashboard' }),
        ...baseHandlers,
      }),
    );
    assert.match(html, /value="https:\/\/dapp\.example\.com\/dashboard"/);
  });

  it('applies a custom class when `class` prop is supplied', () => {
    const html = renderToString(
      h(BrowserUrlBar, {
        state: stateOver(),
        class: 'my-custom-bar',
        ...baseHandlers,
      }),
    );
    assert.match(html, /class="smirk-browser-urlbar my-custom-bar"/);
  });
});
