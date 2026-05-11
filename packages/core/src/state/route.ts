/**
 * Route persistence — tab + screen state survives popup close.
 *
 * Routes are flat strings with optional params. The popup doesn't
 * use a real URL router — Chrome MV3 popups don't have meaningful
 * URLs anyway, and Capacitor/Tauri shells don't either. Instead the
 * app interprets a route id directly.
 *
 * Conventions:
 *
 * | Route id                    | Meaning                              |
 * |-----------------------------|--------------------------------------|
 * | `home`                      | Home tab, top level                   |
 * | `home/asset/<id>`           | Home tab, asset-detail drill-down     |
 * | `swap`                      | Swap tab, default state               |
 * | `swap/active/<swap-id>`     | Swap tab, viewing an active swap      |
 * | `inbox`                     | Inbox tab                             |
 * | `inbox/item/<item-id>`      | Inbox item detail                     |
 * | `settings`                  | Settings tab, root                    |
 * | `settings/rpc/<assetId>`    | Settings, per-asset RPC config        |
 * | `wizard/<wizard-id>`        | Active wizard (Tip Maker, Send, etc.) |
 *
 * The first path segment (`home`, `swap`, etc.) is the tab. Sub-paths
 * are drill-downs that the back-button collapses one segment at a
 * time — implemented in the Preact hook layer, not here.
 */

import type { SessionStateStore, Route } from './session-state';

/** Top-level tab parsed from a route id. */
export type Tab = 'home' | 'swap' | 'inbox' | 'settings';

/** Get the tab segment of a route id. */
export function tabOf(route: Route): Tab {
  const first = route.current.split('/')[0];
  if (first === 'home' || first === 'swap' || first === 'inbox' || first === 'settings') {
    return first;
  }
  // Wizards + unknown routes default to home as the conceptual parent.
  return 'home';
}

/** Helpers that read/write the route field on a [`SessionStateStore`]. */
export class RouteController {
  constructor(private readonly store: SessionStateStore) {}

  async get(): Promise<Route> {
    const state = await this.store.load();
    return state.route;
  }

  /** Replace the current route. Clears params if not provided. */
  async navigate(current: string, params?: Record<string, unknown>): Promise<void> {
    await this.store.update((s) => {
      s.route = params === undefined ? { current } : { current, params };
    });
  }

  /**
   * Navigate up one route segment. `home/asset/btc` → `home`.
   * Top-level routes (`home`, `swap`, …) stay where they are.
   */
  async back(): Promise<void> {
    await this.store.update((s) => {
      const segments = s.route.current.split('/');
      if (segments.length <= 1) return;
      segments.pop();
      s.route = { current: segments.join('/') };
    });
  }

  /** Switch tab while remembering each tab's last drill-down. */
  async switchTab(tab: Tab, store: Record<Tab, string> | null = null): Promise<void> {
    await this.store.update((s) => {
      const remembered = store?.[tab];
      s.route = { current: remembered ?? tab };
    });
  }

  /** Save scroll position for the current route. */
  async saveScroll(scrollY: number): Promise<void> {
    await this.store.update((s) => {
      s.scroll[s.route.current] = scrollY;
    });
  }

  /** Restore the scroll position for a route, or 0 if unrecorded. */
  async getScroll(routeId?: string): Promise<number> {
    const s = await this.store.load();
    const id = routeId ?? s.route.current;
    return s.scroll[id] ?? 0;
  }
}
