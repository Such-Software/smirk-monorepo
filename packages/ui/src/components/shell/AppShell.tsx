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
import { useEffect, useRef, useState } from 'preact/hooks';
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
  /**
   * Which layout to use. `auto` (the default) decides from the layout
   * viewport. A host that KNOWS its surface should say so: an action popup
   * passes `popup`, because width alone is not trustworthy there (Firefox
   * reports the whole browser window as `outerWidth`, and a popup's viewport
   * is unsettled while it opens).
   */
  layout?: 'auto' | 'popup' | 'wide';
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
  layout = 'auto',
}: AppShellProps) {
  const { tab } = useRoute();
  const rootRef = useRef<HTMLDivElement>(null);
  // `auto` decides from the shell's OWN measured width once it is known, which
  // hardened browsers cannot misreport the way they round window and screen
  // sizes (resistFingerprinting); the viewport is only the first-paint guess.
  const viewportIsWide = useIsPopout();
  const elementWidth = useElementWidth(rootRef, layout === 'auto');
  const autoIsWide = elementWidth === null ? viewportIsWide : elementWidth > 500;
  const isPopout = layout === 'popup' ? false : layout === 'wide' ? true : autoIsWide;
  const showPopOutButton = !isPopout && onPopOut !== undefined;

  const label = brand?.label ?? 'Smirk Wallet';
  const iconUrl = brand?.iconUrl;

  return (
    <div
      ref={rootRef}
      class={className}
      data-testid="app-shell-root"
      data-layout={isPopout ? 'wide' : 'popup'}
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

/**
 * The element's own content width, tracked with a ResizeObserver; `null`
 * until measured or when not enabled (or no ResizeObserver, e.g. SSR).
 */
function useElementWidth(ref: { current: HTMLElement | null }, enabled: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') {
      setWidth(null);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      // A zero width means "not laid out yet" (a popup still opening), not
      // "narrow"; keep the previous answer instead of flapping layouts.
      if (typeof w === 'number' && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
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
        // Its own stacking layer: a positioned card in the content (themes such
        // as WinXP position the balance card) must never paint over, and so
        // swallow clicks meant for, the header controls.
        position: 'relative',
        zIndex: 2,
      }}
    >
      {/* The brand gives way first. Without minWidth 0 a flex item cannot shrink
          below its content, so a narrow surface pushed the actions past the
          right edge instead, where nothing could click them. */}
      <div style={{ minWidth: 0, overflow: 'hidden', flex: '0 1 auto' }}>
        <BrandMark label={label} {...(iconUrl ? { iconUrl } : {})} size={16} />
      </div>
      <div
        data-testid="app-shell-header-actions"
        style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
      >
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
        // Same stacking rule as the popup header: content never paints over it.
        position: 'relative',
        zIndex: 2,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          // The identity chip plus the actions can be wider than 200px; wrap
          // them under the brand rather than spilling over the main pane.
          flexWrap: 'wrap',
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
