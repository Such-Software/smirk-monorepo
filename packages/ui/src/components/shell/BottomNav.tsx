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
  const { tab: activeTab, switchTab } = useRoute();

  const isVertical = orientation === 'vertical';

  return (
    <nav
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        borderTop: isVertical ? 'none' : '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
        flex: isVertical ? 1 : 'none',
      }}
      role="tablist"
    >
      {TABS.map((t) => {
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => switchTab(t.id)}
            style={{
              display: 'flex',
              flexDirection: isVertical ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: isVertical ? 'flex-start' : 'center',
              gap: isVertical ? 12 : 4,
              padding: isVertical ? '12px 16px' : '8px 4px',
              flex: isVertical ? 'none' : 1,
              background: active ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: active ? '#8b5cf6' : 'rgba(255,255,255,0.7)',
              fontSize: 11,
              fontWeight: active ? 600 : 500,
              textAlign: isVertical ? 'left' : 'center',
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
