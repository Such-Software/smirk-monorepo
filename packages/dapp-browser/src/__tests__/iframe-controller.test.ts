/**
 * `IframeBrowserController` test file.
 *
 * Runs the shared conformance suite (same one `MockController` runs)
 * and adds iframe-specific assertions for the methods that aren't on
 * the `DappBrowserController` interface: `dispatchPageMessage`,
 * `getReloadGen`, `notifyTabLoaded`, `notifyTabTitle`, `inlineMode`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IframeBrowserController } from '../iframe-controller';
import { makeTabId } from '../types';
import { runControllerConformance } from './conformance';

runControllerConformance({
  name: 'IframeBrowserController',
  factory: () => new IframeBrowserController(),
});

describe('IframeBrowserController — iframe-specific behaviour', () => {
  it('advertises inlineMode = true', () => {
    const c = new IframeBrowserController();
    assert.equal(c.inlineMode, true);
  });

  it('setInitScripts is a no-op (cross-origin iframes block injection)', async () => {
    const c = new IframeBrowserController();
    await c.setInitScripts(['var x = 1;']);
    // No throw, no side effect. Sanity: controller still opens
    // and accepts a new tab.
    await c.open();
    const tab = await c.newTab('https://example.com');
    assert.ok(tab);
  });

  it('setFrameRect / hideFrame are no-ops (CSS-laid iframes need no positioning)', async () => {
    const c = new IframeBrowserController();
    await c.open();
    // open() auto-allocates one tab: that's the conformance
    // contract. Operate on it directly.
    await c.setFrameRect({ x: 10, y: 20, width: 300, height: 400 });
    await c.hideFrame();
    // No throw; controller is still usable.
    const tabs = await c.listTabs();
    assert.equal(tabs.length, 1);
  });

  it('getReloadGen starts at 0 and increments per reload() call', async () => {
    const c = new IframeBrowserController();
    await c.open();
    const tab = await c.activeTab();
    assert.equal(c.getReloadGen(tab), 0);
    await c.reload();
    assert.equal(c.getReloadGen(tab), 1);
    await c.reload();
    assert.equal(c.getReloadGen(tab), 2);
  });

  it('getReloadGen returns 0 for unknown tabs', () => {
    const c = new IframeBrowserController();
    assert.equal(c.getReloadGen(makeTabId('does-not-exist')), 0);
  });

  it('reload preserves the URL but bumps reloadGen', async () => {
    const c = new IframeBrowserController({ homeUrl: 'https://example.com/path' });
    await c.open();
    const tab = await c.activeTab();
    const tabsBefore = await c.listTabs();
    const urlBefore = tabsBefore[0]?.state.url;
    await c.reload();
    const tabsAfter = await c.listTabs();
    assert.equal(tabsAfter[0]?.state.url, urlBefore);
    assert.equal(c.getReloadGen(tab), 1);
  });

  it('dispatchPageMessage forwards to the installed handler', async () => {
    const c = new IframeBrowserController();
    await c.open();
    const tab = await c.activeTab();
    let received: { origin: string; tab: string; request: unknown } | null = null;
    c.setPageRequestHandler(async (req) => {
      received = {
        origin: req.origin,
        tab: req.tab as string,
        request: req.request,
      };
      return { ok: true };
    });
    const response = await c.dispatchPageMessage(
      'https://example.com',
      tab,
      { foo: 'bar' },
    );
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(received, {
      origin: 'https://example.com',
      tab: tab as string,
      request: { foo: 'bar' },
    });
  });

  it('dispatchPageMessage returns null when no handler is installed', async () => {
    const c = new IframeBrowserController();
    await c.open();
    const tab = await c.activeTab();
    const response = await c.dispatchPageMessage('https://x.test', tab, {});
    assert.equal(response, null);
  });

  it('notifyTabLoaded flips isLoading to false and emits a snapshot', async () => {
    const c = new IframeBrowserController({ homeUrl: 'https://example.com' });
    await c.open();
    const tab = await c.activeTab();
    const snapshots: boolean[] = [];
    c.subscribe((snap) => snapshots.push(snap.activeState.isLoading));
    // Subscription emits the current snapshot synchronously; the
    // first entry is the post-open loading state.
    assert.equal(snapshots[0], true);
    c.notifyTabLoaded(tab);
    assert.equal(snapshots[snapshots.length - 1], false);
  });

  it('notifyTabTitle updates the active tab title', async () => {
    const c = new IframeBrowserController({ homeUrl: 'https://example.com' });
    await c.open();
    const tab = await c.activeTab();
    c.notifyTabTitle(tab, 'Example');
    const tabs = await c.listTabs();
    const found = tabs.find((t) => t.id === tab);
    assert.equal(found?.state.title, 'Example');
  });

  it('back / forward navigate the per-tab history without touching url state directly', async () => {
    const c = new IframeBrowserController({ homeUrl: 'https://a.test' });
    await c.open();
    const tab = await c.activeTab();
    await c.navigate('https://b.test', tab);
    await c.navigate('https://c.test', tab);

    let tabs = await c.listTabs();
    let cur = tabs.find((t) => t.id === tab);
    assert.equal(cur?.state.url, 'https://c.test');
    assert.equal(cur?.state.canGoBack, true);
    assert.equal(cur?.state.canGoForward, false);

    await c.goBack(tab);
    tabs = await c.listTabs();
    cur = tabs.find((t) => t.id === tab);
    assert.equal(cur?.state.url, 'https://b.test');
    assert.equal(cur?.state.canGoBack, true);
    assert.equal(cur?.state.canGoForward, true);

    await c.goBack(tab);
    tabs = await c.listTabs();
    cur = tabs.find((t) => t.id === tab);
    assert.equal(cur?.state.url, 'https://a.test');
    assert.equal(cur?.state.canGoBack, false);
  });

  it('navigating after a back-step truncates forward history', async () => {
    const c = new IframeBrowserController({ homeUrl: 'https://a.test' });
    await c.open();
    const tab = await c.activeTab();
    await c.navigate('https://b.test', tab);
    await c.navigate('https://c.test', tab);
    await c.goBack(tab); // now at b
    await c.navigate('https://d.test', tab); // truncates c
    const tabs = await c.listTabs();
    const cur = tabs.find((t) => t.id === tab);
    assert.equal(cur?.state.url, 'https://d.test');
    assert.equal(cur?.state.canGoForward, false);
  });
});
