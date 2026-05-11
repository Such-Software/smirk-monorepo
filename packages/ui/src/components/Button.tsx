/**
 * Button — full-width primary / secondary CTA for in-flow screens.
 *
 * Distinct from `ActionButton` (which is a column-stacked tile for the
 * Home tab's verb row). `Button` is the rectangular labelled button you
 * use for "Continue", "Create wallet", "Send", "Unlock" — anywhere a
 * flow needs a clear primary action.
 *
 * Sizes are roomy by default (height 44px, horizontal padding 16px) so
 * the popup doesn't feel cramped. Buttons go full-width inside their
 * container; wrap in a flex/grid parent if you want side-by-side.
 */

import type { ComponentChildren } from 'preact';

export interface ButtonProps {
  children: ComponentChildren;
  onClick?: () => void;
  disabled?: boolean;
  /**
   * `primary` — Smirk purple, the default for the main CTA on a screen.
   * `secondary` — outlined / muted, for the side action (Cancel, Back).
   * `danger` — red tint, for destructive confirms.
   */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Submit type for forms — defaults to `'button'` to avoid surprise form submits. */
  type?: 'button' | 'submit';
  /** Render at full container width (default). Pass `false` for inline. */
  fullWidth?: boolean;
  class?: string;
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
  fullWidth = true,
  class: className,
}: ButtonProps) {
  const styles = (() => {
    switch (variant) {
      case 'primary':
        return {
          background: '#8b5cf6',
          color: '#ffffff',
          border: 'none',
        };
      case 'secondary':
        return {
          background: 'transparent',
          color: 'inherit',
          border: '1px solid rgba(255,255,255,0.18)',
        };
      case 'danger':
        return {
          background: 'rgba(239, 68, 68, 0.15)',
          color: '#ef4444',
          border: '1px solid rgba(239, 68, 68, 0.4)',
        };
    }
  })();

  return (
    <button
      class={className}
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 44,
        padding: '0 16px',
        borderRadius: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontSize: 14,
        fontWeight: 600,
        fontFamily: 'inherit',
        letterSpacing: '0.01em',
        width: fullWidth ? '100%' : 'auto',
        transition: 'opacity 120ms ease, transform 60ms ease',
      }}
    >
      {children}
    </button>
  );
}
