/**
 * BottomNav — the four-tab navigation bar (UI_DESIGN.md, navigation
 * summary). Used in popup mode (horizontal at the bottom) and
 * pop-out / desktop / mobile mode (vertical sidebar).
 */

import type { Tab } from '@smirk/core';
import { useRoute } from '../../state/hooks';

export interface BottomNavProps {
  /** `horizontal` (popup, default) or `vertical` (sidebar). */
  orientation?: 'horizontal' | 'vertical';
  /**
   * Optional per-tab badge counts. When > 0, the tab renders a small
   * pill next to its label. Today only the Inbox tab uses this (pending
   * Grin exchanges). Counts above 99 render as "99+".
   */
  badges?: Partial<Record<Tab, number>>;
}

interface TabConfig {
  id: Tab;
  label: string;
  icon: string;
}

const BASE_TABS: TabConfig[] = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'swap', label: 'Swap', icon: '⇄' },
  { id: 'inbox', label: 'Inbox', icon: '✉' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

// `◯` (U+25EF, GREAT CIRCLE) — same Geometric Shapes Unicode block
// as the other nav glyphs (House, Envelope, Gear, Arrow pair) so
// the cross-platform font story is consistent. Smoke-tested on
// Linux/WebKitGTK. Move all nav icons to inline SVG together if a
// future platform regresses.
const BROWSE_TAB: TabConfig = { id: 'browse', label: 'Browse', icon: '◯' };

// `☷` would clash with theme glyphs; `≋` (U+224B) reads as a "feed/stream" of
// posts and sits in the Math Operators block that renders cross-platform.
const FEED_TAB: TabConfig = { id: 'feed', label: 'Feed', icon: '≋' };

/**
 * Feed tab renders only when the active backend advertises an operator feed
 * (`features.feed`). The app sets `globalThis.__smirk_feed__` once capabilities
 * load; a backend that runs no feed never surfaces the tab. Same opt-in idiom as
 * Browse — read per-render so a backend switch re-evaluates cleanly.
 */
function isFeedAvailable(): boolean {
  return Boolean(
    typeof globalThis !== 'undefined' &&
      (globalThis as { __smirk_feed__?: unknown }).__smirk_feed__,
  );
}

/**
 * Browse tab renders only when an embedded-browser controller is
 * wired into the runtime via `globalThis.__smirk_browser__`. The
 * desktop shell installs the global at boot; the extension popup
 * never does, so extension users see the original 4-tab nav.
 *
 * The order places Browse last (right side / bottom of the vertical
 * sidebar) so it doesn't shuffle existing muscle memory.
 *
 * Per-render (not module-load) so import-order quirks under HMR /
 * tests don't lock us into a stale answer. The lookup is two field
 * reads — cheaper than a single style recompute.
 */
function isBrowseAvailable(): boolean {
  return Boolean(
    typeof globalThis !== 'undefined' &&
      (globalThis as { __smirk_browser__?: unknown }).__smirk_browser__,
  );
}

export function BottomNav({ orientation = 'horizontal', badges }: BottomNavProps) {
  const { tab: activeTab, switchTab, navigate, route } = useRoute();

  const isVertical = orientation === 'vertical';
  // Feed slots before Settings (a content tab, not a config tab); Browse stays
  // last. Both are opt-in and absent by default.
  const feedTabs: TabConfig[] = isFeedAvailable()
    ? [...BASE_TABS.slice(0, 3), FEED_TAB, ...BASE_TABS.slice(3)]
    : BASE_TABS;
  const TABS: TabConfig[] = isBrowseAvailable() ? [...feedTabs, BROWSE_TAB] : feedTabs;

  return (
    <nav
      class="smirk-bottom-nav"
      data-testid="bottom-nav"
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        borderTop: isVertical ? 'none' : '1px solid var(--smirk-border)',
        flexShrink: 0,
        flex: isVertical ? 1 : 'none',
      }}
      role="tablist"
    >
      {TABS.map((t) => {
        const active = t.id === activeTab;
        // Mobile UX convention: tapping the *current* tab pops to the
        // tab root (escapes any drill-down like home/send or
        // home/asset/btc). Tapping a *different* tab uses switchTab,
        // which remembers each tab's last sub-route so coming back
        // resumes where you were. Pre-fix, every tap went through
        // switchTab and restored the drill-down — making the Home
        // button useless once you'd opened Send or Receive.
        const onTabClick =
          active && route.current !== t.id
            ? () => void navigate(t.id)
            : () => void switchTab(t.id);
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            data-testid={`nav-tab-${t.id}`}
            onClick={onTabClick}
            class={['smirk-bottom-nav__tab', active && 'smirk-bottom-nav__tab--active']
              .filter(Boolean)
              .join(' ')}
            style={{
              display: 'flex',
              flexDirection: isVertical ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: isVertical ? 'flex-start' : 'center',
              gap: isVertical ? 12 : 4,
              padding: isVertical ? '12px 16px' : '8px 4px',
              flex: isVertical ? 'none' : 1,
              background: active
                ? 'color-mix(in srgb, var(--smirk-accent) 15%, transparent)'
                : 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: active ? 'var(--smirk-accent)' : 'var(--smirk-fg-muted)',
              fontSize: 11,
              fontWeight: active ? 600 : 500,
              textAlign: isVertical ? 'left' : 'center',
              fontFamily: 'inherit',
            }}
          >
            <span
              style={{
                fontSize: isVertical ? 16 : 18,
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {t.icon}
              {badges && (badges[t.id] ?? 0) > 0 && (
                <span
                  aria-label={`${badges[t.id]} pending`}
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -8,
                    minWidth: 14,
                    height: 14,
                    padding: '0 4px',
                    borderRadius: 7,
                    background: 'var(--smirk-accent)',
                    color: 'var(--smirk-accent-fg, #fff)',
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: '14px',
                    textAlign: 'center',
                  }}
                >
                  {(badges[t.id] ?? 0) > 99 ? '99+' : badges[t.id]}
                </span>
              )}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
