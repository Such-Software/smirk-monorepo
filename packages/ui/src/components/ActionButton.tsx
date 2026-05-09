/**
 * ActionButton — primary CTA used in the action-centric Home tab.
 *
 * Per UI_DESIGN.md Principle 1, top-level navigation is verbs (Tip,
 * Send, Swap, Claim) not nouns. This is the chrome those verbs render
 * into: large icon + label, vertically stacked, equally-sized in a row.
 *
 * @example
 * ```tsx
 * <ActionButton label="Tip" icon="🎁" onClick={() => navigate('/tip')} />
 * ```
 *
 * The `icon` prop is intentionally `JSX.Element | string` rather than a
 * specific icon-library type — consumers bring their own icon set.
 */

import type { ComponentChildren } from 'preact';

export interface ActionButtonProps {
  /** Short verb (≤ 6 chars works best). */
  label: string;
  /** Icon glyph — string emoji, image element, or SVG component. */
  icon?: ComponentChildren;
  /** Click handler. */
  onClick?: () => void;
  /** Disable the action (greyed out, no click). */
  disabled?: boolean;
  /** Visual variant. `primary` is the default Smirk-purple; `subtle` is
   *  for secondary actions in a row of mostly-primary CTAs. */
  variant?: 'primary' | 'subtle';
  class?: string;
}

export function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  variant = 'primary',
  class: className,
}: ActionButtonProps) {
  const bg =
    variant === 'primary' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)';
  const accent = variant === 'primary' ? '#8b5cf6' : 'rgba(255, 255, 255, 0.7)';

  return (
    <button
      class={className}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '12px 8px',
        background: bg,
        border: 'none',
        borderRadius: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        color: 'inherit',
        flex: 1,
        minHeight: 72,
      }}
    >
      {icon && (
        <span
          style={{
            fontSize: 22,
            color: accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ fontSize: 12, fontWeight: 500, color: accent }}>{label}</span>
    </button>
  );
}

/**
 * ActionRow — convenience wrapper for a row of equally-sized
 * ActionButtons. The Home tab uses this for its primary action strip.
 */
export interface ActionRowProps {
  children: ComponentChildren;
  class?: string;
}

export function ActionRow({ children, class: className }: ActionRowProps) {
  return (
    <div
      class={className}
      style={{
        display: 'flex',
        gap: 8,
        width: '100%',
      }}
    >
      {children}
    </div>
  );
}
