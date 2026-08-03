/**
 * Controller conformance suite.
 *
 * Exercises the entire `DappBrowserController` interface against a
 * factory provided by the caller. The same suite is reused by each
 * platform implementation's test file (Mock, Iframe today) so that
 * drift between impls is caught at the test boundary. Native-platform
 * controllers should register it too.
 *
 * Pass a factory that returns a fresh, *un-opened* controller. The
 * suite calls `open()` / `close()` itself so that lifecycle invariants
 * (idempotency, post-close rejection) are part of the contract under
 * test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BrowserSnapshot, DappBrowserController } from '../controller';
import { NotSupportedError, UnknownTabError, makeTabId } from '../types';

export interface ConformanceOptions {
  /** Display name of the impl under test, used as the describe block label. */
  readonly name: string;
  /** Factory: each call returns a fresh, *un-opened* controller. */
  readonly factory: () => DappBrowserController;
}

/**
 * Register the conformance test suite for a controller impl. Call
 * inside the impl's `*.test.ts` file at module scope.
 */
export function runControllerConformance(opts: ConformanceOptions): void {
  describe(`DappBrowserController conformance — ${opts.name}`, () => {
    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------

    describe('lifecycle', () => {
      it('open() is idempotent', async () => {
        const c = opts.factory();
        await c.open();
        await c.open();
        const tabs = await c.listTabs();
        assert.equal(tabs.length, 1, 'second open() should not allocate another tab');
        await c.close();
      });

      it('close() releases the controller; reopen restores usability', async () => {
        const c = opts.factory();
        await c.open();
        await c.close();
        // After close, navigation operations are rejected.
        await assert.rejects(c.navigate('https://example.com'), (e: unknown) => {
          return e instanceof NotSupportedError;
        });
        // Reopening must work.
        await c.open();
        const tabs = await c.listTabs();
        assert.ok(tabs.length >= 1, 'reopen should reallocate at least one tab');
        await c.close();
      });

      it('close() before open() is a no-op (idempotent)', async () => {
        const c = opts.factory();
        await c.close();
        // Open after no-op close still works.
        await c.open();
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Tab management
    // ----------------------------------------------------------------

    describe('tab management', () => {
      it('newTab creates a tab and makes it active', async () => {
        const c = opts.factory();
        await c.open();
        const id = await c.newTab('https://example.com');
        const active = await c.activeTab();
        assert.equal(active, id);
        const tabs = await c.listTabs();
        assert.ok(tabs.some((t) => t.id === id));
        await c.close();
      });

      it('switchTab moves active focus without destroying tabs', async () => {
        const c = opts.factory();
        await c.open();
        const a = await c.newTab('https://a.example.com');
        const b = await c.newTab('https://b.example.com');
        await c.switchTab(a);
        assert.equal(await c.activeTab(), a);
        await c.switchTab(b);
        assert.equal(await c.activeTab(), b);
        const tabs = await c.listTabs();
        // The initial tab opened by `open()` plus a plus b.
        assert.ok(tabs.length >= 3);
        await c.close();
      });

      it('switchTab rejects unknown ids', async () => {
        const c = opts.factory();
        await c.open();
        await assert.rejects(
          c.switchTab(makeTabId('does-not-exist')),
          (e: unknown) => e instanceof UnknownTabError,
        );
        await c.close();
      });

      it('closeTab on the last tab leaves the controller with a fresh tab', async () => {
        const c = opts.factory();
        await c.open();
        const initial = await c.activeTab();
        await c.closeTab(initial);
        const tabs = await c.listTabs();
        assert.equal(tabs.length, 1, 'a replacement tab should exist');
        // The replacement is *not* the same id as the closed one.
        assert.notEqual(tabs[0]!.id, initial);
        await c.close();
      });

      it('closeTab on the active tab promotes another tab to active', async () => {
        const c = opts.factory();
        await c.open();
        const a = await c.newTab('https://a.example.com');
        const b = await c.newTab('https://b.example.com');
        await c.switchTab(b);
        await c.closeTab(b);
        const active = await c.activeTab();
        assert.notEqual(active, b);
        // Either the previous active tab `a` or the initial tab survived;
        // both are valid choices per the interface docs ("most-recently-
        // used"). We only assert that *some* surviving tab took over.
        const tabs = await c.listTabs();
        assert.ok(tabs.some((t) => t.id === active));
        await c.close();
      });

      it('closeTab rejects unknown ids', async () => {
        const c = opts.factory();
        await c.open();
        await assert.rejects(
          c.closeTab(makeTabId('does-not-exist')),
          (e: unknown) => e instanceof UnknownTabError,
        );
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Navigation
    // ----------------------------------------------------------------

    describe('navigation', () => {
      it('navigate updates the active tab when no tab is specified', async () => {
        const c = opts.factory();
        await c.open();
        await c.navigate('https://example.com');
        const activeId = await c.activeTab();
        const tabs = await c.listTabs();
        const active = tabs.find((t) => t.id === activeId);
        assert.ok(active, 'active tab should be present in the listing');
        assert.equal(active!.state.url, 'https://example.com');
        await c.close();
      });

      it('navigate targets a specific tab when one is passed', async () => {
        const c = opts.factory();
        await c.open();
        const a = await c.newTab('https://a.example.com');
        const b = await c.newTab('https://b.example.com');
        await c.switchTab(a);
        await c.navigate('https://b-redirect.example.com', b);
        const tabs = await c.listTabs();
        const bTab = tabs.find((t) => t.id === b)!;
        assert.equal(bTab.state.url, 'https://b-redirect.example.com');
        // Active tab `a` was untouched.
        const aTab = tabs.find((t) => t.id === a)!;
        assert.equal(aTab.state.url, 'https://a.example.com');
        await c.close();
      });

      it('reload does not throw on a fresh tab', async () => {
        const c = opts.factory();
        await c.open();
        await c.reload();
        await c.close();
      });

      it('goBack / goForward do not throw even when history is empty', async () => {
        const c = opts.factory();
        await c.open();
        await c.goBack();
        await c.goForward();
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Subscription
    // ----------------------------------------------------------------

    describe('subscription', () => {
      it('subscribe emits the current snapshot synchronously on attach', async () => {
        const c = opts.factory();
        await c.open();
        let received: BrowserSnapshot | null = null;
        const unsub = c.subscribe((s) => {
          received = s;
        });
        assert.ok(received, 'listener should have been called before subscribe() returned');
        assert.ok((received as unknown as BrowserSnapshot).tabs.length >= 1);
        unsub();
        await c.close();
      });

      it('subscribe re-emits on navigate', async () => {
        const c = opts.factory();
        await c.open();
        const snapshots: BrowserSnapshot[] = [];
        const unsub = c.subscribe((s) => snapshots.push(s));
        const initialCount = snapshots.length;
        await c.navigate('https://example.com');
        assert.ok(
          snapshots.length > initialCount,
          'navigate() should have caused at least one extra emit',
        );
        const last = snapshots[snapshots.length - 1]!;
        assert.equal(last.activeState.url, 'https://example.com');
        unsub();
        await c.close();
      });

      it('subscribe re-emits on newTab / switchTab / closeTab', async () => {
        const c = opts.factory();
        await c.open();
        const snapshots: BrowserSnapshot[] = [];
        const unsub = c.subscribe((s) => snapshots.push(s));
        const initialCount = snapshots.length;
        const a = await c.newTab('https://a.example.com');
        await c.switchTab(a);
        await c.closeTab(a);
        assert.ok(snapshots.length > initialCount + 2);
        unsub();
        await c.close();
      });

      it('unsubscribe stops further emits', async () => {
        const c = opts.factory();
        await c.open();
        let count = 0;
        const unsub = c.subscribe(() => {
          count++;
        });
        const afterAttach = count;
        unsub();
        await c.navigate('https://example.com');
        assert.equal(count, afterAttach, 'unsubscribed listener must not receive further snapshots');
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Frame positioning
    // ----------------------------------------------------------------

    describe('frame positioning', () => {
      it('setFrameRect accepts a rect without throwing', async () => {
        const c = opts.factory();
        await c.open();
        await c.setFrameRect({ x: 0, y: 0, width: 800, height: 600 });
        await c.close();
      });

      it('repeated identical rects are safe (idempotent)', async () => {
        const c = opts.factory();
        await c.open();
        const rect = { x: 10, y: 20, width: 800, height: 600 };
        await c.setFrameRect(rect);
        await c.setFrameRect(rect);
        await c.setFrameRect(rect);
        await c.close();
      });

      it('hideFrame does not throw and is safe to call repeatedly', async () => {
        const c = opts.factory();
        await c.open();
        await c.hideFrame();
        await c.hideFrame();
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Init scripts
    // ----------------------------------------------------------------

    describe('init scripts', () => {
      it('setInitScripts before open() does not throw', async () => {
        const c = opts.factory();
        await c.setInitScripts(['globalThis.foo = 1;']);
        await c.open();
        await c.close();
      });

      it('setInitScripts can be called with an empty array', async () => {
        const c = opts.factory();
        await c.setInitScripts([]);
        await c.open();
        await c.close();
      });
    });

    // ----------------------------------------------------------------
    // Wallet RPC bridge
    // ----------------------------------------------------------------

    describe('wallet RPC bridge', () => {
      it('setPageRequestHandler accepts a handler and null', () => {
        const c = opts.factory();
        c.setPageRequestHandler(async () => ({ ok: true }));
        c.setPageRequestHandler(null);
      });
    });

    // ----------------------------------------------------------------
    // Post-close rejection
    // ----------------------------------------------------------------

    describe('post-close behaviour', () => {
      it('rejects newTab / navigate / switchTab after close', async () => {
        const c = opts.factory();
        await c.open();
        await c.close();
        await assert.rejects(c.newTab(), (e) => e instanceof NotSupportedError);
        await assert.rejects(c.navigate('https://x'), (e) => e instanceof NotSupportedError);
        await assert.rejects(
          c.switchTab(makeTabId('anything')),
          (e) => e instanceof NotSupportedError,
        );
      });
    });
  });
}
