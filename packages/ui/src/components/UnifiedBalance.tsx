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
import { FreshnessCue } from './FreshnessCue';
import type { FreshnessCueProps } from './FreshnessCue';

export interface UnifiedBalanceProps {
  /**
   * Already-formatted total (e.g. `"$2,134.27"` or `"0.04123 BTC"`).
   * Pass `null` for "not available yet" — renders as a placeholder.
   */
  totalDisplay: string | null;
  /**
   * Already-formatted pending-incoming total. Omit/null/"" suppresses
   * the row.
   */
  pendingDisplay?: string | null;
  /**
   * Already-formatted locked total (on-chain but inside lock window —
   * CryptoNote chains only). Omit/null/"" suppresses the row.
   */
  lockedDisplay?: string | null;
  /**
   * Already-formatted "in-flight outgoing" total across all assets
   * (sender-side pendingOutgoing — see
   * `@smirk/core/state/pending-outgoing`). Omit/null/"" suppresses.
   */
  sendingDisplay?: string | null;
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
  /**
   * Escalating freshness cue rendered beneath the total: a subtle "updating"
   * dot while a background refresh runs, escalating to an amber warning (>30s)
   * then a red error (>60s) if refreshes keep failing. Omit to render no cue.
   * See {@link FreshnessCue}.
   */
  freshness?: FreshnessCueProps;
  class?: string;
}

const HIDDEN_PLACEHOLDER = '••••••';

export function UnifiedBalance({
  totalDisplay,
  pendingDisplay,
  lockedDisplay,
  sendingDisplay,
  denominationLabel,
  onCycleDenomination,
  onPickDenomination,
  hidden,
  onToggleHidden,
  loading,
  freshness,
  class: className,
}: UnifiedBalanceProps) {
  // Show cached pending/locked/sending during a refresh too (don't blank on
  // every background update). They're still gated on having an actual value.
  const showPending =
    !hidden && pendingDisplay !== undefined && pendingDisplay !== null && pendingDisplay !== '';
  const showLocked =
    !hidden && lockedDisplay !== undefined && lockedDisplay !== null && lockedDisplay !== '';
  const showSending =
    !hidden && sendingDisplay !== undefined && sendingDisplay !== null && sendingDisplay !== '';

  // Seamless balances: once we have a total, KEEP showing it during a background
  // refresh (the freshness cue below signals the update). Only fall back to the
  // loading glyph when there is no cached total at all — never blank a known
  // number to "…" just because a refresh is in flight.
  const total = hidden
    ? HIDDEN_PLACEHOLDER
    : (totalDisplay ?? (loading ? '…' : '—'));

  const TotalEl = onCycleDenomination ? 'button' : 'div';

  return (
    <section
      class={['smirk-unified-balance', className].filter(Boolean).join(' ')}
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
          data-testid="home-total-balance"
          class="smirk-headline-action"
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
            // Buttons don't inherit font-family from their parent —
            // UA stylesheets set their own. Force inherit so pixel
            // themes (DMG, Workbench) actually paint the balance
            // in their theme font.
            fontFamily: 'inherit',
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
          class="smirk-headline-action"
          onClick={onToggleHidden}
          aria-label={hidden ? 'Show balances' : 'Hide balances'}
          title={hidden ? 'Show balances' : 'Hide balances'}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--smirk-fg-muted)',
            cursor: 'pointer',
            padding: '4px 8px',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <EyeGlyph hidden={hidden} />
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

      {freshness && <FreshnessCue {...freshness} />}

      {(showPending || showLocked || showSending) && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            marginTop: 4,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          {showSending && (
            <span
              style={{ color: 'var(--smirk-warning)' }}
              title="In-flight outgoing transactions — waiting for network confirmation"
            >
              ↑ {sendingDisplay} sending
            </span>
          )}
          {showPending && (
            <span title="Unconfirmed / mempool / swap-in-progress">
              + {pendingDisplay} pending
            </span>
          )}
          {showLocked && (
            <span title="On-chain but inside the protocol lock window (XMR ≥10 confs, WOW ≥4 confs to be spendable)">
              🔒 {lockedDisplay} locked
            </span>
          )}
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
  /** Hide the Tip action entirely — the backend advertises no social tips. The
   *  row reflows to the remaining verbs. Default: shown. */
  showTip?: boolean;
  /** Disable any combination — e.g. Swap when no swap routes available. */
  disabled?: Partial<Record<'tip' | 'send' | 'receive' | 'swap', boolean>>;
  class?: string;
}

export function HomeActionRow({
  onTip,
  onSend,
  onReceive,
  onSwap,
  showTip = true,
  disabled = {},
  class: className,
}: HomeActionRowProps) {
  // Build only the visible verbs so a hidden Tip reflows the grid (no empty
  // cell) instead of leaving a dead slot.
  const buttons = [
    showTip && (
      <ActionButton key="tip" testid="home-action-tip" label="Tip" icon="🎁" {...(onTip ? { onClick: onTip } : {})} {...(disabled.tip ? { disabled: true } : {})} />
    ),
    <ActionButton key="send" testid="home-action-send" label="Send" icon="↗" {...(onSend ? { onClick: onSend } : {})} {...(disabled.send ? { disabled: true } : {})} />,
    <ActionButton key="receive" testid="home-action-receive" label="Receive" icon="↘" {...(onReceive ? { onClick: onReceive } : {})} {...(disabled.receive ? { disabled: true } : {})} />,
    <ActionButton key="swap" testid="home-action-swap" label="Swap" icon="⇄" {...(onSwap ? { onClick: onSwap } : {})} {...(disabled.swap ? { disabled: true } : {})} />,
  ].filter(Boolean);
  return (
    <div
      class={className}
      role="group"
      aria-label="Wallet actions"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${buttons.length}, 1fr)`,
        gap: 8,
        padding: '4px 0 8px',
      }}
    >
      {buttons}
    </div>
  );
}

/**
 * Eye / eye-with-slash glyph for the hide-balance toggle. Inline SVG
 * instead of an emoji because the eye-in-speech-bubble ZWJ sequence
 * (`👁‍🗨`) renders inconsistently across Linux desktops, and the
 * lone-eye codepoint (`👁`) renders as a tofu box on systems without
 * a color emoji font (Tauri on Ubuntu, for one). Stroke colour
 * inherits from the button.
 */
function EyeGlyph({ hidden }: { hidden: boolean }) {
  const stroke = 'currentColor';
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {hidden && <line x1="3" y1="21" x2="21" y2="3" />}
    </svg>
  );
}
