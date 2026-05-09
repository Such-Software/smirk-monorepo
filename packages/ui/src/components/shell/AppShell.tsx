/**
 * AppShell — header + scrollable body + bottom nav.
 *
 * The chrome the action-centric redesign sits inside. Renders the
 * current tab's content via the `routes` map; consumers supply
 * per-tab components.
 *
 * Responsive: at popup widths (≤ ~500px) the bottom nav sits below
 * the content; at pop-out widths it's a sidebar. Same component, CSS
 * does the lift.
 *
 * @example
 * ```tsx
 * <StateProvider store={store} router={router}>
 *   <AppShell
 *     routes={{
 *       home: <HomeTab />,
 *       swap: <SwapTab />,
 *       inbox: <InboxTab />,
 *       settings: <SettingsTab />,
 *     }}
 *     onPopOut={() => chrome.windows.create({ url: 'popup.html', type: 'popup' })}
 *   />
 * </StateProvider>
 * ```
 */

import type { ComponentChildren } from 'preact';
import { useRoute, useIsPopout } from '../../state/hooks';
import type { Tab } from '@smirk/core';
import { BottomNav } from './BottomNav';

export interface AppShellProps {
  /** Per-tab content. Each tab's render is the consumer's responsibility. */
  routes: Record<Tab, ComponentChildren>;
  /**
   * Optional callback for the pop-out button in the header. If
   * omitted (or we detect we're already in pop-out), the button is
   * hidden.
   */
  onPopOut?: () => void;
  /** Optional class for outermost div, for consumer styling hooks. */
  class?: string;
}

export function AppShell({ routes, onPopOut, class: className }: AppShellProps) {
  const { tab } = useRoute();
  const isPopout = useIsPopout();
  const showPopOutButton = !isPopout && onPopOut !== undefined;

  return (
    <div
      class={className}
      style={{
        display: 'flex',
        flexDirection: isPopout ? 'row' : 'column',
        height: '100vh',
        width: '100%',
      }}
    >
      {!isPopout && (
        <Header {...(showPopOutButton ? { onPopOut } : {})} />
      )}

      {isPopout && <SidebarNav />}

      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          minWidth: 0,
        }}
      >
        {routes[tab]}
      </main>

      {!isPopout && <BottomNav />}
    </div>
  );
}

// ----- Header (popup mode) -----

interface HeaderProps {
  onPopOut?: () => void;
}

function Header({ onPopOut }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>Smirk</span>
      {onPopOut && (
        <button
          onClick={onPopOut}
          aria-label="Open in window"
          title="Open in window"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 14,
            padding: '4px 8px',
          }}
        >
          ⤢
        </button>
      )}
    </header>
  );
}

// ----- Sidebar (pop-out mode) -----

function SidebarNav() {
  // Reuse BottomNav's logic but render as a column. Single source of
  // truth for the tab list lives in BottomNav.
  return (
    <aside
      style={{
        width: 200,
        borderRight: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          fontSize: 14,
          fontWeight: 600,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        Smirk
      </div>
      <BottomNav orientation="vertical" />
    </aside>
  );
}
