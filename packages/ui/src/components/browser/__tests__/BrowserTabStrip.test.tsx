/**
 * Static-render tests for `BrowserTabStrip`.
 *
 * As with `BrowserUrlBar`, these tests use `preact-render-to-string`
 * to cover rendering, ARIA roles, and conditional logic without a
 * jsdom dependency. JSX is replaced by explicit `h()` calls so the
 * tests are independent of the runner's JSX-transform setting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';

import type { BrowserTab, TabId } from '@smirk/dapp-browser';
import { makeTabId } from '@smirk/dapp-browser';
import { BrowserTabStrip } from '../BrowserTabStrip';

const noop = (): void => undefined;

function tab(
  id: string,
  url: string,
  title: string,
  faviconUrl?: string,
): BrowserTab {
  return {
    id: makeTabId(id),
    createdAt: 0,
    state: {
      url,
      title,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      origin: '',
      securityState: 'unknown',
      ...(faviconUrl !== undefined ? { faviconUrl } : {}),
    },
  };
}

const baseHandlers = {
  onSelectTab: noop,
  onCloseTab: noop,
  onNewTab: noop,
};

describe('BrowserTabStrip — static render', () => {
  it('returns null when collapseSingleTab is on and only one tab exists', () => {
    const tabs = [tab('a', 'https://a.example.com', 'A')];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    assert.equal(html, '');
  });

  it('renders the strip when collapseSingleTab is off even with one tab', () => {
    const tabs = [tab('a', 'https://a.example.com', 'A')];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
        collapseSingleTab: false,
      }),
    );
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"/);
  });

  it('renders one pill per tab when multiple tabs exist', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A'),
      tab('b', 'https://b.example.com', 'B'),
      tab('c', 'https://c.example.com', 'C'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    const matches = html.match(/role="tab"/g) ?? [];
    assert.equal(matches.length, 3);
    assert.ok(html.includes('A'));
    assert.ok(html.includes('B'));
    assert.ok(html.includes('C'));
  });

  it('marks the active tab with aria-selected="true"', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A'),
      tab('b', 'https://b.example.com', 'B'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('b'),
        ...baseHandlers,
      }),
    );
    const selectedCount = (html.match(/aria-selected="true"/g) ?? []).length;
    assert.equal(selectedCount, 1, 'exactly one tab should report aria-selected=true');
  });

  it('renders a New tab button with aria-label', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A'),
      tab('b', 'https://b.example.com', 'B'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    assert.match(html, /aria-label="New tab"/);
  });

  it('renders a Close tab button per pill with aria-label', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A'),
      tab('b', 'https://b.example.com', 'B'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    const closeCount = (html.match(/aria-label="Close tab"/g) ?? []).length;
    assert.equal(closeCount, 2);
  });

  it('falls back to URL when title is empty', () => {
    const tabs = [
      tab('a', 'https://a.example.com', ''),
      tab('b', 'https://b.example.com', ''),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    assert.ok(html.includes('https://a.example.com'));
    assert.ok(html.includes('https://b.example.com'));
  });

  it('falls back to "New tab" when both title and URL are empty', () => {
    const tabs = [tab('a', '', ''), tab('b', '', '')];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    const count = (html.match(/New tab/g) ?? []).length;
    // Two pills with the fallback label, plus the new-tab button's
    // aria-label, plus its title attribute → at least 4 occurrences.
    assert.ok(count >= 4, `expected at least 4 occurrences, got ${count}`);
  });

  it('renders favicon images when provided', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A', 'https://a.example.com/favicon.ico'),
      tab('b', 'https://b.example.com', 'B'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
      }),
    );
    assert.match(html, /src="https:\/\/a\.example\.com\/favicon\.ico"/);
  });

  it('applies a custom class when `class` prop is supplied', () => {
    const tabs = [
      tab('a', 'https://a.example.com', 'A'),
      tab('b', 'https://b.example.com', 'B'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: makeTabId('a'),
        ...baseHandlers,
        class: 'my-custom-strip',
      }),
    );
    assert.match(html, /class="smirk-browser-tabstrip my-custom-strip"/);
  });

  it('accepts opaque TabIds without unwrapping the brand', () => {
    // Compile-time check more than runtime: makeTabId returns the
    // branded type and the props accept it directly. If the brand
    // leaked through somewhere, this test would have failed
    // typechecking.
    const id: TabId = makeTabId('opaque');
    const tabs = [
      tab('opaque', 'https://x.example.com', 'X'),
      tab('y', 'https://y.example.com', 'Y'),
    ];
    const html = renderToString(
      h(BrowserTabStrip, {
        tabs,
        activeTab: id,
        ...baseHandlers,
      }),
    );
    assert.ok(html.length > 0);
  });
});
