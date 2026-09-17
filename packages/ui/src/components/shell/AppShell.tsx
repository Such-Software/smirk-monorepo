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
   * Optional callback for the open-in-tab button. A tab survives a click
   * elsewhere, which a popup does not, and unlike the pop-out window it keeps
   * the browser's own tab management (pinning, restore on relaunch). Hidden
   * when omitted.
   */
  onOpenInTab?: () => void;
  /**
   * Optional callback for the lock button. Locking had no control at all: the
   * only ways out were the auto-lock timer and closing the window, so a user
   * stepping away from an unlocked wallet had nothing to press. Hidden when
   * omitted, and shown in both the popup header and the pop-out sidebar,
   * because wanting to lock does not depend on which one you are looking at.
   */
  onLock?: () => void;
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

export function AppShell({
  routes,
  onPopOut,
  onOpenInTab,
  onLock,
  brand,
  headerActions,
  tabBadges,
  class: className,
}: AppShellProps) {
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
          {...(onOpenInTab ? { onOpenInTab } : {})}
          {...(onLock ? { onLock } : {})}
          {...(headerActions !== undefined ? { extra: headerActions } : {})}
        />
      )}

      {isPopout && (
        <SidebarNav
          label={label}
          {...(iconUrl ? { iconUrl } : {})}
          {...(tabBadges ? { badges: tabBadges } : {})}
          {...(onOpenInTab ? { onOpenInTab } : {})}
          {...(onLock ? { onLock } : {})}
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
  onOpenInTab?: () => void;
  onLock?: () => void;
  extra?: ComponentChildren;
}

function Header({ label, iconUrl, onPopOut, onOpenInTab, onLock, extra }: HeaderProps) {
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
        <ShellActions
          {...(onOpenInTab ? { onOpenInTab } : {})}
          {...(onPopOut ? { onPopOut } : {})}
          {...(onLock ? { onLock } : {})}
        />
      </div>
    </header>
  );
}

/**
 * The header/sidebar icon buttons, in one place so the popup and the pop-out
 * cannot drift into offering different controls.
 *
 * Lock is rendered last and given its own separating margin: it is the only one
 * that throws away wallet state, and it should not sit flush against a button
 * that merely moves the window.
 */
function ShellActions({
  onOpenInTab,
  onPopOut,
  onLock,
}: {
  onOpenInTab?: () => void;
  onPopOut?: () => void;
  onLock?: () => void;
}) {
  return (
    <>
      {onOpenInTab && (
        <ShellIconButton onClick={onOpenInTab} label="Open in a browser tab" glyph="⧉" />
      )}
      {onPopOut && <ShellIconButton onClick={onPopOut} label="Open in its own window" glyph="⤢" />}
      {onLock && (
        <ShellIconButton onClick={onLock} label="Lock wallet" glyph="🔒" style={{ marginLeft: 4 }} />
      )}
    </>
  );
}

function ShellIconButton({
  onClick,
  label,
  glyph,
  style,
}: {
  onClick: () => void;
  label: string;
  glyph: string;
  style?: Record<string, string | number>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
        padding: '4px 8px',
        ...style,
      }}
    >
      {glyph}
    </button>
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
  onOpenInTab,
  onLock,
  extra,
}: {
  label: string;
  iconUrl?: string;
  badges?: Partial<Record<Tab, number>>;
  onOpenInTab?: () => void;
  onLock?: () => void;
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {extra}
          <ShellActions
            {...(onOpenInTab ? { onOpenInTab } : {})}
            {...(onLock ? { onLock } : {})}
          />
        </div>
      </div>
      <BottomNav orientation="vertical" {...(badges ? { badges } : {})} />
    </aside>
  );
}
