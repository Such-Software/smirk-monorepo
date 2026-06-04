/**
 * ReadyToShareTipsBanner — Home-tab affordance for sent public tips
 * whose funding has buried far enough for the share URL to be safely
 * distributable.
 *
 * Mirrors `ClaimableTipsBanner` for the inverse direction. Surfaces at
 * the top of Home so a sender who created a public tip and then
 * walked away comes back to a "your tip is ready to share" prompt
 * instead of having to drill into Sent Tips. v0.2.4 had the
 * equivalent on its WalletView; v0.3 dropped it and senders had no
 * cue that their pending public tip had matured. Tapping routes to
 * the cross-asset Sent Tips list where the URL + Copy-link sits.
 *
 * Hidden when `count === 0` — caller doesn't need a `count > 0` guard.
 */

import type { JSX } from 'preact';

export interface ReadyToShareTipsBannerProps {
  /** Number of public tips with funding past the confirmation gate. */
  count: number;
  /** Click handler — typically navigates to the Sent Tips surface. */
  onView: () => void;
}

export function ReadyToShareTipsBanner({
  count,
  onView,
}: ReadyToShareTipsBannerProps): JSX.Element | null {
  if (count <= 0) return null;
  const label =
    count === 1
      ? '1 public tip ready to share'
      : `${count} public tips ready to share`;
  return (
    <button
      onClick={onView}
      aria-label={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--smirk-accent)',
        color: 'var(--smirk-accent-fg, #fff)',
        border: 'none',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16 }}>
        🔗
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span aria-hidden="true" style={{ opacity: 0.85, fontSize: 14 }}>
        ›
      </span>
    </button>
  );
}
