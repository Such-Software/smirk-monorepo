/**
 * MockController tests — runs the shared conformance suite plus
 * mock-specific test-helper assertions.
 *
 * The conformance suite is the contract every controller impl must
 * satisfy; mock-specific behaviour (simulatePageLoad, getInitScripts,
 * getFrameRect) is exercised separately here so a real platform impl
 * isn't forced to expose those hooks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockController } from '../mock-controller';
import { NotSupportedError, makeTabId } from '../types';
import { runControllerConformance } from './conformance';

// ----------------------------------------------------------------------
// Conformance suite — exercises the full interface.
// ----------------------------------------------------------------------

runControllerConformance({
  name: 'MockController',
  factory: () => new MockController({ homeUrl: 'about:blank' }),
});

// ----------------------------------------------------------------------
// Mock-specific behaviour.
// ----------------------------------------------------------------------

describe('MockController — test helpers', () => {
  it('homeUrl is used as the initial tab destination', async () => {
    const c = new MockController({ homeUrl: 'https://home.example.com' });
    await c.open();
    const tabs = await c.listTabs();
    assert.equal(tabs[0]!.state.url, 'https://home.example.com');
    await c.close();
  });

  it('default homeUrl is about:blank', async () => {
    const c = new MockController();
    await c.open();
    const tabs = await c.listTabs();
    assert.equal(tabs[0]!.state.url, 'about:blank');
    await c.close();
  });

  it('getInitScripts reports what setInitScripts stored', async () => {
    const c = new MockController();
    const scripts = ['globalThis.a = 1;', 'globalThis.b = 2;'];
    await c.setInitScripts(scripts);
    assert.deepEqual(c.getInitScripts(), scripts);
  });

  it('getFrameRect reports the most recent rect; hideFrame zeroes it', async () => {
    const c = new MockController();
    await c.open();
    assert.equal(c.getFrameRect(), null);
    await c.setFrameRect({ x: 10, y: 20, width: 800, height: 600 });
    assert.deepEqual(c.getFrameRect(), { x: 10, y: 20, width: 800, height: 600 });
    await c.hideFrame();
    assert.deepEqual(c.getFrameRect(), { x: 0, y: 0, width: 0, height: 0 });
    await c.close();
  });

  it('simulatePageLoad sets title, clears isLoading, attaches favicon', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('https://example.com');
    c.simulatePageLoad('Example Domain', { faviconUrl: 'https://example.com/favicon.ico' });
    const id = await c.activeTab();
    const tabs = await c.listTabs();
    const active = tabs.find((t) => t.id === id)!;
    assert.equal(active.state.title, 'Example Domain');
    assert.equal(active.state.isLoading, false);
    assert.equal(active.state.faviconUrl, 'https://example.com/favicon.ico');
    await c.close();
  });

  it('simulatePageLoad without a favicon preserves the previous one', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('https://example.com');
    c.simulatePageLoad('First', { faviconUrl: 'https://example.com/a.ico' });
    c.simulatePageLoad('Second');
    const id = await c.activeTab();
    const tabs = await c.listTabs();
    const active = tabs.find((t) => t.id === id)!;
    assert.equal(active.state.title, 'Second');
    assert.equal(active.state.faviconUrl, 'https://example.com/a.ico');
    await c.close();
  });

  it('simulatePageRequest routes through the registered handler', async () => {
    const c = new MockController();
    await c.open();
    const id = await c.activeTab();
    c.setPageRequestHandler(async (req) => ({ ok: true, gotOrigin: req.origin }));
    const response = await c.simulatePageRequest({
      origin: 'https://dapp.example.com',
      tab: id,
      request: { method: 'getAccounts' },
    });
    assert.deepEqual(response, { ok: true, gotOrigin: 'https://dapp.example.com' });
    await c.close();
  });

  it('simulatePageRequest throws when no handler is registered', async () => {
    const c = new MockController();
    await c.open();
    const id = await c.activeTab();
    await assert.rejects(
      c.simulatePageRequest({ origin: 'https://x', tab: id, request: null }),
      (e: unknown) => e instanceof NotSupportedError,
    );
    await c.close();
  });

  it('navigate sets securityState=secure for https and insecure for http', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('https://secure.example.com');
    let id = await c.activeTab();
    let tabs = await c.listTabs();
    assert.equal(tabs.find((t) => t.id === id)!.state.securityState, 'secure');
    await c.navigate('http://insecure.example.com');
    id = await c.activeTab();
    tabs = await c.listTabs();
    assert.equal(tabs.find((t) => t.id === id)!.state.securityState, 'insecure');
    await c.close();
  });

  it('navigate computes origin from the URL', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('https://sub.example.com/some/path');
    const id = await c.activeTab();
    const tabs = await c.listTabs();
    assert.equal(tabs.find((t) => t.id === id)!.state.origin, 'https://sub.example.com');
    await c.close();
  });

  it('navigate leaves origin empty for non-URL inputs', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('about:blank');
    const id = await c.activeTab();
    const tabs = await c.listTabs();
    const state = tabs.find((t) => t.id === id)!.state;
    assert.equal(state.origin, '');
    assert.equal(state.securityState, 'unknown');
    await c.close();
  });

  it('reload toggles isLoading and clears on next microtask', async () => {
    const c = new MockController();
    await c.open();
    await c.navigate('https://example.com');
    c.simulatePageLoad('Loaded');
    await c.reload();
    // Microtask runs synchronously between awaits.
    await Promise.resolve();
    const id = await c.activeTab();
    const tabs = await c.listTabs();
    assert.equal(tabs.find((t) => t.id === id)!.state.isLoading, false);
    await c.close();
  });

  it('listTabs returns tabs in insertion order', async () => {
    const c = new MockController();
    await c.open();
    const a = await c.newTab('https://a.example.com');
    const b = await c.newTab('https://b.example.com');
    const tabs = await c.listTabs();
    // Initial tab (from open()) + a + b.
    const ids = tabs.map((t) => t.id);
    assert.ok(ids.indexOf(a) < ids.indexOf(b));
    await c.close();
  });

  it('UnknownTabError message includes the offending id', async () => {
    const c = new MockController();
    await c.open();
    try {
      await c.switchTab(makeTabId('bogus-id'));
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.match((e as Error).message, /bogus-id/);
    }
    await c.close();
  });
});
