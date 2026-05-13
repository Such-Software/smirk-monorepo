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
}

interface TabConfig {
  id: Tab;
  label: string;
  icon: string;
}

const TABS: TabConfig[] = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'swap', label: 'Swap', icon: '⇄' },
  { id: 'inbox', label: 'Inbox', icon: '✉' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function BottomNav({ orientation = 'horizontal' }: BottomNavProps) {
  const { tab: activeTab, switchTab, navigate, route } = useRoute();

  const isVertical = orientation === 'vertical';

  return (
    <nav
      class="smirk-bottom-nav"
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
            <span style={{ fontSize: isVertical ? 16 : 18 }}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
