/**
 * Preact hooks wrapping `@smirk/core/state`.
 *
 * Components opt into reactive session-state via these hooks; updates
 * trigger re-renders the way React/Preact users expect. The
 * underlying store is framework-agnostic: keeps `@smirk/core` clean,
 * lets a hypothetical Tauri+Solid frontend swap in its own bindings.
 *
 * @example
 * ```tsx
 * import { StateProvider, useSessionState, useRoute, useWizard } from '@smirk/ui';
 *
 * function App({ store, router }: { store: SessionStateStore; router: RouteController }) {
 *   return (
 *     <StateProvider store={store} router={router}>
 *       <Shell />
 *     </StateProvider>
 *   );
 * }
 *
 * function Shell() {
 *   const state = useSessionState();
 *   const { route, navigate, back } = useRoute();
 *   // ...
 * }
 * ```
 */

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_SESSION_STATE,
  type SessionState,
  type SessionStateStore,
  type Route,
  type RouteController,
  type Tab,
  Wizard,
  tabOf,
} from '@smirk/core';

// ============================================================================
// Context
// ============================================================================

interface StateContextValue {
  store: SessionStateStore;
  router: RouteController;
}

const StateContext = createContext<StateContextValue | null>(null);

export interface StateProviderProps extends StateContextValue {
  children: ComponentChildren;
}

/**
 * Wrap your app root. Boots a single shared store + router that all
 * descendant hooks bind to.
 */
export function StateProvider({ store, router, children }: StateProviderProps) {
  const value = useMemo(() => ({ store, router }), [store, router]);
  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

function useStateContext(): StateContextValue {
  const ctx = useContext(StateContext);
  if (!ctx) {
    throw new Error(
      'useStateContext: no StateProvider in tree. Wrap your app in <StateProvider store={...} router={...}>.',
    );
  }
  return ctx;
}

// ============================================================================
// Reactive session state
// ============================================================================

/**
 * Subscribe to the full session state. Re-renders the consumer on every
 * state change (local or cross-context).
 *
 * On first render, returns `DEFAULT_SESSION_STATE` while the store
 * loads asynchronously; wrap critical reads in conditionals if you
 * need to wait for real data, or accept the default-flash.
 */
export function useSessionState(): SessionState {
  const { store } = useStateContext();
  const [state, setState] = useState<SessionState>(DEFAULT_SESSION_STATE);

  useEffect(() => {
    let alive = true;
    void store.load().then((s) => {
      if (alive) setState(s);
    });
    const unsub = store.subscribe((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [store]);

  return state;
}

// ============================================================================
// Route hook
// ============================================================================

export interface UseRouteApi {
  /** Current route. Reactive: re-renders on change. */
  route: Route;
  /** Top-level tab (computed from `route.current`). */
  tab: Tab;
  /** Navigate to a new route. */
  navigate: (current: string, params?: Record<string, unknown>) => Promise<void>;
  /** Pop one segment. `home/asset/btc` → `home`. */
  back: () => Promise<void>;
  /** Switch tab while remembering each tab's last drill-down. */
  switchTab: (tab: Tab) => Promise<void>;
}

/**
 * Reactive route hook. Updates whenever the route changes: local
 * navigations, cross-context navigations, or restored from storage
 * on session resume.
 *
 * Remembers per-tab drill-down so switching tabs and switching back
 * lands on the previously-viewed sub-screen, not the tab root.
 */
export function useRoute(): UseRouteApi {
  const { router } = useStateContext();
  const state = useSessionState();
  const route = state.route;

  // Remember each tab's most recently-viewed sub-route, so switching
  // tabs and switching back returns to the drill-down rather than
  // the tab root.
  const lastByTab = useRef<Record<Tab, string>>({
    home: 'home',
    swap: 'swap',
    inbox: 'inbox',
    feed: 'feed',
    settings: 'settings',
    browse: 'browse',
  });
  useEffect(() => {
    lastByTab.current[tabOf(route)] = route.current;
  }, [route]);

  return useMemo<UseRouteApi>(
    () => ({
      route,
      tab: tabOf(route),
      navigate: (current, params) => router.navigate(current, params),
      back: () => router.back(),
      switchTab: (tab) => router.switchTab(tab, lastByTab.current),
    }),
    [route, router],
  );
}

// ============================================================================
// Wizard hook
// ============================================================================

export interface UseWizardApi<TFields extends Record<string, unknown>> {
  /** True iff this wizard has any active state. */
  active: boolean;
  /** Current step (0 if inactive; check `active` first). */
  step: number;
  /** Collected fields so far. Empty object if inactive. */
  fields: Partial<TFields>;

  start: () => Promise<void>;
  cancel: () => Promise<void>;
  next: () => Promise<void>;
  back: () => Promise<void>;
  goToStep: (step: number) => Promise<void>;
  setField: <K extends keyof TFields>(name: K, value: TFields[K]) => Promise<void>;
  patchFields: (patch: Partial<TFields>) => Promise<void>;
}

/**
 * Reactive wizard hook. Pass a stable wizard id and a defaults
 * object: restored across pop-out, session resume, and cross-context
 * writes.
 *
 * The defaults object is captured at mount; changing it across
 * renders won't re-init the wizard.
 */
export function useWizard<TFields extends Record<string, unknown>>(
  id: string,
  defaults: TFields,
): UseWizardApi<TFields> {
  const { store } = useStateContext();
  const state = useSessionState();
  const w = state.wizards[id];

  // Wizard handle is stable across renders. We rebuild it only when
  // the store or id changes (effectively never, in normal apps).
  const defaultsRef = useRef(defaults);
  const wizard = useMemo(
    () => new Wizard<TFields>(store, id, defaultsRef.current),
    [store, id],
  );

  return useMemo<UseWizardApi<TFields>>(
    () => ({
      active: w !== undefined,
      step: w?.step ?? 0,
      fields: (w?.fields as Partial<TFields>) ?? {},
      start: () => wizard.start().then(() => undefined),
      cancel: () => wizard.cancel(),
      next: () => wizard.next().then(() => undefined),
      back: () => wizard.back().then(() => undefined),
      goToStep: (step) => wizard.goToStep(step),
      setField: (name, value) => wizard.setField(name, value),
      patchFields: (patch) => wizard.patchFields(patch),
    }),
    [w, wizard],
  );
}

// ============================================================================
// Pop-out detection
// ============================================================================

/**
 * Detect whether this document is the embedded extension popup or
 * the popped-out window.
 *
 * Heuristic: the extension popup is rendered in a fixed-width frame
 * (≤ ~500px wide). Pop-out windows / Capacitor full-screen / Tauri
 * windowed are wider.
 *
 * Returns `false` during SSR (no `window`).
 */
export function useIsPopout(threshold = 500): boolean {
  const [isPopout, setIsPopout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.outerWidth > threshold;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setIsPopout(window.outerWidth > threshold);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [threshold]);

  return isPopout;
}
