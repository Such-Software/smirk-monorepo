/**
 * `BrowserUrlBar` — the address-bar / status-indicator strip.
 *
 * Renders:
 *  - Back / forward / reload buttons on the left.
 *  - A security-indicator + URL input in the middle.
 *  - Optional trailing slot for app-level affordances (bookmark
 *    star, menu, etc.).
 *
 * The component is presentational. Navigation commands flow back
 * through the consumer-supplied callbacks rather than touching the
 * controller directly — keeps the component testable without a real
 * controller and keeps the layering clean.
 */

import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { BrowserNavigationState } from '@smirk/dapp-browser';

export interface BrowserUrlBarProps {
  /** Current navigation state of the active tab. */
  readonly state: BrowserNavigationState;

  /** User asked for back navigation. */
  readonly onBack: () => void;
  /** User asked for forward navigation. */
  readonly onForward: () => void;
  /** User asked for reload. */
  readonly onReload: () => void;
  /**
   * User submitted a new URL (typed and pressed enter). Caller is
   * responsible for any URL normalization (scheme inference,
   * search-redirect, etc.).
   */
  readonly onSubmitUrl: (raw: string) => void;

  /**
   * Optional trailing content (bookmark star, menu button, etc.).
   * Rendered after the URL input. Lets the consumer extend the bar
   * without forking the component.
   */
  readonly trailing?: ComponentChildren;

  /**
   * Optional class for the outer container. Useful when the consumer
   * needs to override layout — e.g. compact mode on small screens.
   */
  readonly class?: string;
}

/** Address-bar strip. See file header for usage. */
export function BrowserUrlBar(props: BrowserUrlBarProps): JSX.Element {
  // Local draft state so the user can type without each keystroke
  // hitting `onSubmitUrl`. Sync the draft with `state.url` only on
  // explicit submit or when the user blurs without changes — that
  // way external navigation (back/forward/click) updates the bar but
  // doesn't clobber a partially-typed URL.
  const [draft, setDraft] = useState(props.state.url);
  const [focused, setFocused] = useState(false);
  const displayedValue = focused ? draft : props.state.url;

  return (
    <div
      class={['smirk-browser-urlbar', props.class].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderBottom: '1px solid var(--smirk-border, rgba(255,255,255,0.08))',
        background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.02))',
      }}
    >
      <NavButton
        label="Back"
        glyph="‹"
        disabled={!props.state.canGoBack}
        onClick={props.onBack}
      />
      <NavButton
        label="Forward"
        glyph="›"
        disabled={!props.state.canGoForward}
        onClick={props.onForward}
      />
      <NavButton
        label={props.state.isLoading ? 'Stop' : 'Reload'}
        glyph={props.state.isLoading ? '✕' : '↻'}
        onClick={props.onReload}
      />

      <SecurityIndicator state={props.state.securityState} />

      <input
        type="text"
        value={displayedValue}
        spellcheck={false}
        aria-label="Address"
        onFocus={() => {
          setDraft(props.state.url);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            props.onSubmitUrl(draft.trim());
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(props.state.url);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '6px 10px',
          fontSize: 12,
          fontFamily: 'var(--smirk-font-family-mono, monospace)',
          color: 'var(--smirk-fg, #f5f5f5)',
          background: 'var(--smirk-bg, rgba(0,0,0,0.2))',
          border: '1px solid var(--smirk-border, rgba(255,255,255,0.12))',
          borderRadius: 6,
          outline: 'none',
        }}
      />

      {props.trailing}
    </div>
  );
}

// ======================================================================
// Internals
// ======================================================================

interface NavButtonProps {
  readonly label: string;
  readonly glyph: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

function NavButton(props: NavButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        color: 'var(--smirk-fg, #f5f5f5)',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.4 : 0.85,
        fontSize: 16,
        fontFamily: 'inherit',
      }}
    >
      {props.glyph}
    </button>
  );
}

interface SecurityIndicatorProps {
  readonly state: BrowserNavigationState['securityState'];
}

/**
 * Tiny coloured glyph showing the current security posture. We avoid
 * an actual lock icon to keep the component dependency-free; the
 * consumer can replace this via CSS targeting
 * `.smirk-browser-urlbar__security` if richer iconography is needed.
 */
function SecurityIndicator(props: SecurityIndicatorProps): JSX.Element {
  const glyph =
    props.state === 'secure' ? '⊠'
      : props.state === 'mixed' ? '⚠'
        : props.state === 'insecure' ? '✕'
          : '·';
  const color =
    props.state === 'secure' ? 'var(--smirk-positive, #22c55e)'
      : props.state === 'mixed' ? 'var(--smirk-warning, #f59e0b)'
        : props.state === 'insecure' ? 'var(--smirk-negative, #ef4444)'
          : 'var(--smirk-fg-muted, #888)';
  return (
    <span
      class="smirk-browser-urlbar__security"
      title={`Connection: ${props.state}`}
      style={{
        display: 'inline-block',
        width: 14,
        textAlign: 'center',
        color,
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {glyph}
    </span>
  );
}
