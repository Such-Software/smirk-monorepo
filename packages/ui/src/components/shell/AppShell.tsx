/**
 * AppShell: header + scrollable body + bottom nav.
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
  /**
   * Route renderers per top-level tab. `Partial` because not every
   * shell wires every tab: the desktop adds `browse`; the extension
   * popup doesn't. The shell falls back to `null` for missing
   * renderers, which trivially renders nothing.
   */
  routes: Partial<Record<Tab, ComponentChildren>>;
  /**
   * Optional callback for the pop-out button in the header. If
   * omitted (or we detect we're already in pop-out), the button is
   * hidden.
   */
  onPopOut?: () => void;
  /**
   * Brand mark in the header / sidebar. Defaults to text-only "Smirk
   * Wallet". Pass an icon URL to render a logo glyph alongside the
   * label; extension/mobile/desktop each supply their own.
   */
  brand?: { label?: string; iconUrl?: string };
  /**
   * Extra content rendered in the header (between the brand and the
   * pop-out button). Used for things like a refresh button on Home;
   * the consumer is responsible for hiding it on tabs where it doesn't
   * apply.
   */
  headerActions?: ComponentChildren;
  /**
   * Optional per-tab badge counts forwarded to the BottomNav (Inbox
   * uses this for pending Grin exchanges; future surfaces could too).
   */
  tabBadges?: Partial<Record<Tab, number>>;
  /** Optional class for outermost div, for consumer styling hooks. */
  class?: string;
}

export function AppShell({ routes, onPopOut, brand, headerActions, tabBadges, class: className }: AppShellProps) {
  const { tab } = useRoute();
  const isPopout = useIsPopout();
  const showPopOutButton = !isPopout && onPopOut !== undefined;

  const label = brand?.label ?? 'Smirk Wallet';
  const iconUrl = brand?.iconUrl;

  return (
    <div
      class={className}
      data-testid="app-shell-root"
      style={{
        display: 'flex',
        flexDirection: isPopout ? 'row' : 'column',
        height: '100vh',
        width: '100%',
      }}
    >
      {!isPopout && (
        <Header
          label={label}
          {...(iconUrl ? { iconUrl } : {})}
          {...(showPopOutButton ? { onPopOut } : {})}
          {...(headerActions !== undefined ? { extra: headerActions } : {})}
        />
      )}

      {isPopout && (
        <SidebarNav
          label={label}
          {...(iconUrl ? { iconUrl } : {})}
          {...(tabBadges ? { badges: tabBadges } : {})}
          {...(headerActions !== undefined ? { extra: headerActions } : {})}
        />
      )}

      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          minWidth: 0,
        }}
      >
        {routes[tab] ?? null}
      </main>

      {!isPopout && <BottomNav {...(tabBadges ? { badges: tabBadges } : {})} />}
    </div>
  );
}

// ----- Header (popup mode) -----

interface HeaderProps {
  label: string;
  iconUrl?: string;
  onPopOut?: () => void;
  extra?: ComponentChildren;
}

function Header({ label, iconUrl, onPopOut, extra }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
        gap: 8,
      }}
    >
      <BrandMark label={label} {...(iconUrl ? { iconUrl } : {})} size={16} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {extra}
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
      </div>
    </header>
  );
}

interface BrandMarkProps {
  label: string;
  iconUrl?: string;
  size: number;
}

function BrandMark({ label, iconUrl, size }: BrandMarkProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {iconUrl && (
        <img
          src={iconUrl}
          alt=""
          width={size}
          height={size}
          style={{ display: 'block' }}
        />
      )}
      <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
    </span>
  );
}

// ----- Sidebar (pop-out mode) -----

function SidebarNav({
  label,
  iconUrl,
  badges,
  extra,
}: {
  label: string;
  iconUrl?: string;
  badges?: Partial<Record<Tab, number>>;
  extra?: ComponentChildren;
}) {
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <BrandMark label={label} {...(iconUrl ? { iconUrl } : {})} size={20} />
        {extra && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {extra}
          </div>
        )}
      </div>
      <BottomNav orientation="vertical" {...(badges ? { badges } : {})} />
    </aside>
  );
}
