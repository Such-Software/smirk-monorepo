/**
 * `BrowserShell` — the top-level embedded-browser surface.
 *
 * Composes `BrowserTabStrip` and `BrowserUrlBar` and leaves a "frame
 * area" empty for the native webview overlay. Subscribes to a
 * `DappBrowserController` for state, dispatches user actions back
 * through controller methods, and measures the frame area's bounding
 * rect so the controller can position its native webview on top.
 *
 * Usage:
 *
 * ```tsx
 * import { BrowserShell } from '@smirk/ui';
 * import { TauriBrowserController } from '../dapp/tauri-browser-controller';
 *
 * const ctrl = new TauriBrowserController();
 * await ctrl.setInitScripts([pageApiScript]);
 * await ctrl.open();
 *
 * <BrowserShell controller={ctrl} />
 * ```
 *
 * The shell takes care of:
 *  - Subscribing to controller snapshots and re-rendering.
 *  - Routing nav actions through controller methods.
 *  - Measuring the frame slot and calling `setFrameRect` whenever it
 *    changes (resize, tab strip collapse, etc.).
 *  - Hiding the webview when the controller's snapshot reports no
 *    tabs (e.g. between `close()` and `open()`).
 *
 * The shell does NOT take care of:
 *  - Persisting bookmarks / history (consumer wires those into the
 *    controller's stores).
 *  - URL normalization (the consumer's `onSubmitUrl` decides whether
 *    `youtube.com` becomes `https://youtube.com` or routes through a
 *    search provider).
 *
 * ## Accessibility
 *
 * This component coordinates an interaction pattern with non-obvious
 * a11y semantics; full conventions live in
 * [docs/ACCESSIBILITY.md](../../../../../docs/ACCESSIBILITY.md).
 * The shell's contract:
 *
 * - **Frame slot semantics.** The empty `<div>` that the native
 *   webview overlays carries `role="region"` and
 *   `aria-label="Embedded browser content"` so screen readers
 *   announce entry into the browseable area before descending into
 *   the OS-native a11y tree of the webview itself.
 * - **Focus order.** DOM order: tab strip → URL bar (back, forward,
 *   reload, security indicator, URL input, trailing slot) → frame
 *   slot. Reverse order on `Shift+Tab`. The wallet shell consuming
 *   `BrowserShell` is responsible for routing focus into the URL
 *   input via the `browser:focus-url-bar` keymap action (Cmd/Ctrl+L)
 *   — `BrowserShell` does not bind keys itself; the consuming shell
 *   wires `@smirk/keymap` and exposes a `focusUrlBar()` imperative
 *   handle when that lands.
 * - **Live regions.** Loading-state transitions DO NOT emit a live
 *   announcement (would spam during navigation). Critical state
 *   changes (security downgrade, certificate error) route through
 *   `<LiveRegion>` with `politeness="assertive"` once the security
 *   error UI lands.
 * - **Reduced motion.** The shell renders no animations directly;
 *   child components respect `prefers-reduced-motion`.
 *
 * Behaviour any new platform implementation MUST preserve to remain
 * accessible:
 *
 *  1. The frame slot's DOM presence must remain even when the
 *     native webview is overlaying it — screen readers rely on the
 *     `role="region"` for the announcement boundary.
 *  2. `controller.setFrameRect()` is called whenever the slot's
 *     bounding rect changes; the native impl must respect zero-sized
 *     rects (i.e. hide the webview) so a settings overlay obscuring
 *     the browser doesn't leave a stale webview painted on top.
 */

import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type {
  BrowserSnapshot,
  DappBrowserController,
} from '@smirk/dapp-browser';

import { BrowserTabStrip } from './BrowserTabStrip';
import { BrowserUrlBar } from './BrowserUrlBar';

export interface BrowserShellProps {
  /**
   * The controller backing this shell. The shell calls `subscribe()`
   * on mount and unsubscribes on unmount; lifecycle (`open` / `close`)
   * is the consumer's responsibility.
   */
  readonly controller: DappBrowserController;

  /**
   * Hook for URL normalization on user submit. Default behaviour
   * (when omitted) inserts `https://` if the input lacks a scheme and
   * does NOT route through a search provider. Provide your own to
   * implement bar-as-search.
   */
  readonly normalizeUrl?: (raw: string) => string;

  /**
   * Optional class for the outer container — useful when the consumer
   * needs to constrain the shell to a region of the wallet UI.
   */
  readonly class?: string;
}

/** See file header for usage. */
export function BrowserShell(props: BrowserShellProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);

  // Subscribe to the controller. We re-subscribe whenever the
  // controller identity changes, which should be rare (the consumer
  // typically constructs one and holds it for the wallet's lifetime).
  useEffect(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    return unsubscribe;
  }, [props.controller]);

  // Measure the frame slot and push the rect to the controller. We
  // re-measure on window resize and whenever the tab strip's
  // visibility changes (which moves the frame's `y` by ~28px).
  const frameRef = useRef<HTMLDivElement | null>(null);
  useFrameRect(frameRef, props.controller, snapshot?.tabs.length ?? 0);

  return (
    <div
      class={['smirk-browser-shell', props.class].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--smirk-bg, #0e0e10)',
        color: 'var(--smirk-fg, #f5f5f5)',
      }}
    >
      {snapshot && (
        <>
          <BrowserTabStrip
            tabs={snapshot.tabs}
            activeTab={snapshot.activeTab}
            onSelectTab={(id) => {
              void props.controller.switchTab(id);
            }}
            onCloseTab={(id) => {
              void props.controller.closeTab(id);
            }}
            onNewTab={() => {
              void props.controller.newTab();
            }}
          />
          <BrowserUrlBar
            state={snapshot.activeState}
            onBack={() => void props.controller.goBack()}
            onForward={() => void props.controller.goForward()}
            onReload={() => void props.controller.reload()}
            onSubmitUrl={(raw) => {
              const normalize = props.normalizeUrl ?? defaultNormalizeUrl;
              const target = normalize(raw);
              void props.controller.navigate(target);
            }}
          />
        </>
      )}

      {/* Frame area — left empty for the native webview overlay. The
          controller paints its native webview on top of this region
          via `setFrameRect`. We deliberately render no content
          inside; anything we draw here would be invisible behind the
          overlay anyway and would skew the bounding-rect measurement.

          a11y: `role="region"` + `aria-label` mark the boundary
          between the chrome (URL bar, tabs) and the embedded page.
          Screen readers announce entry into "Embedded browser
          content" and then traverse the OS-native a11y tree of the
          webview itself for the page's own content. See file header
          for the full a11y contract. */}
      <div
        ref={frameRef}
        class="smirk-browser-shell__frame"
        role="region"
        aria-label="Embedded browser content"
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--smirk-bg-sunken, rgba(0,0,0,0.2))',
        }}
      />
    </div>
  );
}

// ======================================================================
// Internals
// ======================================================================

/**
 * Default URL normalizer: scheme-less inputs get `https://` prepended.
 * Anything with `://` is passed through unchanged. Empty input is
 * mapped to `about:blank` so the controller has something to load
 * rather than no-op'ing on the user's empty Enter press.
 *
 * Consumers wanting bar-as-search (treat ambiguous input as a search
 * query) should pass their own `normalizeUrl` prop. Not done here
 * because the search-provider choice is policy, not mechanism.
 */
function defaultNormalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return 'about:blank';
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Hook: measure the frame element's bounding rect and push it to the
 * controller. Re-measures on window resize, on tab-count change
 * (which moves the strip in / out), and on a controller change.
 *
 * Uses a `ResizeObserver` when available (every modern target) so
 * arbitrary layout changes — Settings overlay sliding in, font size
 * change, etc. — also propagate without us having to enumerate them.
 */
function useFrameRect(
  frameRef: RefObject<HTMLDivElement>,
  controller: DappBrowserController,
  tabCount: number,
): void {
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const push = () => {
      const rect = el.getBoundingClientRect();
      void controller.setFrameRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    push();

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(push) : null;
    observer?.observe(el);
    window.addEventListener('resize', push);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', push);
    };
    // `tabCount` is in the deps because hiding/showing the tab strip
    // changes our `y` offset — ResizeObserver fires for size changes
    // but not necessarily position-only changes, so be explicit.
  }, [frameRef, controller, tabCount]);
}
