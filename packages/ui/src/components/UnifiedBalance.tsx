/**
 * UnifiedBalance — the single large total at the top of Home.
 *
 * Per UI_DESIGN.md Principle 8: Home leads with one big number that
 * answers *"how much do I have?"*. Per-asset rows live below in a
 * BalanceCard list.
 *
 * This component is purely presentational — it takes pre-formatted
 * strings for the total and pending values. Aggregation across assets,
 * denomination conversion, and price-feed staleness handling live in
 * the consumer (extension/mobile/desktop), not here. That keeps the
 * `@smirk/ui` package free of price-fetching and currency math.
 *
 * The consumer-supplied click handler on the total cycles denominations
 * (fiat → BTC → sat → atomic, etc.); the eye toggle masks all balance
 * fields globally.
 */

import { ActionButton } from './ActionButton';

export interface UnifiedBalanceProps {
  /**
   * Already-formatted total (e.g. `"$2,134.27"` or `"0.04123 BTC"`).
   * Pass `null` for "not available yet" — renders as a placeholder.
   */
  totalDisplay: string | null;
  /**
   * Already-formatted pending total. Omit (or pass `null`) when there's
   * nothing pending. Empty string suppresses the row.
   */
  pendingDisplay?: string | null;
  /**
   * Currently active denomination label, shown subtly under the total
   * (e.g. `"USD"`, `"BTC"`, `"sat"`). Helps the user understand what
   * they're looking at when cycling.
   */
  denominationLabel?: string;
  /**
   * Cycle the active denomination. UI_DESIGN says tap the total to
   * cycle, long-press to open a picker — long-press is platform-
   * specific so we expose a separate `onPickDenomination` for callers.
   */
  onCycleDenomination?: () => void;
  /** Open the full denomination picker (settings drill-down). */
  onPickDenomination?: () => void;
  /** Whether values are hidden (eye toggle). */
  hidden: boolean;
  /** Toggle hidden state. */
  onToggleHidden: () => void;
  /**
   * Loading state for the headline number — consumers can show this
   * while initial balances stream in. Pending row stays hidden when
   * loading.
   */
  loading?: boolean;
  class?: string;
}

const HIDDEN_PLACEHOLDER = '••••••';

export function UnifiedBalance({
  totalDisplay,
  pendingDisplay,
  denominationLabel,
  onCycleDenomination,
  onPickDenomination,
  hidden,
  onToggleHidden,
  loading,
  class: className,
}: UnifiedBalanceProps) {
  const showPending =
    !hidden && !loading && pendingDisplay !== undefined && pendingDisplay !== null && pendingDisplay !== '';

  const total = hidden
    ? HIDDEN_PLACEHOLDER
    : loading
      ? '…'
      : (totalDisplay ?? '—');

  const TotalEl = onCycleDenomination ? 'button' : 'div';

  return (
    <section
      class={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '12px 12px 8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          justifyContent: 'center',
        }}
      >
        <TotalEl
          {...(onCycleDenomination
            ? {
                onClick: onCycleDenomination,
                onContextMenu: (e: Event) => {
                  e.preventDefault();
                  onPickDenomination?.();
                },
              }
            : {})}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: onCycleDenomination ? 'pointer' : 'default',
            fontSize: 36,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            padding: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
          aria-live={loading ? 'polite' : 'off'}
        >
          {total}
        </TotalEl>
        <button
          onClick={onToggleHidden}
          aria-label={hidden ? 'Show balances' : 'Hide balances'}
          title={hidden ? 'Show balances' : 'Hide balances'}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--smirk-fg-muted)',
            cursor: 'pointer',
            fontSize: 18,
            padding: '4px 8px',
            lineHeight: 1,
          }}
        >
          {hidden ? '👁' : '👁‍🗨'}
        </button>
      </div>

      {!hidden && denominationLabel && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {denominationLabel}
        </div>
      )}

      {showPending && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            marginTop: 4,
          }}
          title="Unconfirmed / mempool / swap-in-progress"
        >
          + {pendingDisplay} pending
        </div>
      )}
    </section>
  );
}

/**
 * Convenience action row matching UI_DESIGN.md Principle 1's four
 * universal verbs. Consumers can compose `ActionButton` directly if
 * they want a different set, but most surfaces should use this.
 */
export interface HomeActionRowProps {
  onTip?: () => void;
  onSend?: () => void;
  onReceive?: () => void;
  onSwap?: () => void;
  /** Disable any combination — e.g. Swap when no swap routes available. */
  disabled?: Partial<Record<'tip' | 'send' | 'receive' | 'swap', boolean>>;
  class?: string;
}

export function HomeActionRow({
  onTip,
  onSend,
  onReceive,
  onSwap,
  disabled = {},
  class: className,
}: HomeActionRowProps) {
  return (
    <div
      class={className}
      role="group"
      aria-label="Wallet actions"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 8,
        padding: '4px 0 8px',
      }}
    >
      <ActionButton label="Tip" icon="🎁" {...(onTip ? { onClick: onTip } : {})} {...(disabled.tip ? { disabled: true } : {})} />
      <ActionButton label="Send" icon="↗" {...(onSend ? { onClick: onSend } : {})} {...(disabled.send ? { disabled: true } : {})} />
      <ActionButton label="Receive" icon="↘" {...(onReceive ? { onClick: onReceive } : {})} {...(disabled.receive ? { disabled: true } : {})} />
      <ActionButton label="Swap" icon="⇄" {...(onSwap ? { onClick: onSwap } : {})} {...(disabled.swap ? { disabled: true } : {})} />
    </div>
  );
}
