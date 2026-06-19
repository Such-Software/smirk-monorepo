/**
 * SwapTab — top-level Swap surface for the wallet.
 *
 * Two concerns in one tab:
 *
 *   1. **Provider list** — every swap route we surface, each labeled
 *      [CEX] or [DEX] so the user can see the trust model at a glance.
 *      Single scrollable list rather than two sub-tabs because (a) the
 *      list is shorter than a screen on every form factor, (b) mobile
 *      doesn't love nested tab bars, and (c) hiding DEX entries behind
 *      a tab when most of them are "coming soon" makes them feel
 *      forgotten instead of telegraphed.
 *   2. **Active provider wizard** — once the user picks an active
 *      provider, the list collapses and that provider's wizard takes
 *      over the tab. v0.3 wires only the Trocador CEX wizard; every
 *      other entry is `coming_soon` or `paused` with status copy.
 *
 * Why a single list instead of CEX/DEX nav: the user's mental model
 * is "which route to use right now", not "which architecture". The
 * [CEX]/[DEX] badge surfaces the trust model without making the user
 * navigate twice. New providers slot in by extending PROVIDERS.
 *
 * Cross-platform: zero platform-specific imports. State persists via
 * `useWizard('swap-trocador')` which uses the @smirk/core store —
 * the same primitive backs the extension popup, Tauri desktop, and
 * Capacitor mobile.
 *
 * Strictly presentational. The consumer wires the actual Trocador
 * calls + persistence + Send-handoff via the handler props.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { useWizard } from '../state/hooks';
import { AssetIcon } from './AssetIcon';
import { formatAmountWithTicker, formatAmount } from '../format';

// ============================================================================
// Public types
// ============================================================================

/** Quote returned from `onTrocadorQuote`. All non-JSON-friendly fields
 *  (no Date, no bigint) so it can sit inside wizard.fields and survive
 *  serialization to chrome.storage / IndexedDB / wherever the platform
 *  persists session state.
 *
 *  Critically — `tradeId` (Trocador's `trade_id` from /new_rate) lives
 *  here so the Confirm step can finalize the same draft after a
 *  popup-close mid-wizard, without re-quoting and risking a stale rate. */
export interface SwapQuoteSummary {
  /** Trocador trade_id from /new_rate. Reused by /new_trade on confirm. */
  tradeId: string;
  fromAsset: string;
  toAsset: string;
  fromAmountAtomic: string;
  toAmountEstimateAtomic: string;
  feeEstimateAtomic: string;
  provider: string;
  etaSeconds: number;
  /** Unix ms; UI computes "valid for Ns" off this. */
  expiresAtMs: number;
}

/** A started swap. Persisted so popup-close mid-deposit recovers and
 *  the Status step has somewhere to resume from. */
export interface SwapInFlight {
  /** Trocador trade_id. */
  id: string;
  fromAsset: string;
  toAsset: string;
  fromAmountAtomic: string;
  toAmountEstimateAtomic: string;
  depositAddress: string;
  state:
    | { state: 'pending'; reason: 'awaiting_deposit' | 'awaiting_confirmations' | 'in_progress' }
    | { state: 'completed'; outboundTxId: string; toAmount: string }
    | { state: 'refunded'; refundTxId: string; reason: string }
    | { state: 'failed'; reason: string };
}

/**
 * One row of the user's swap history, shaped for the "Recent swaps"
 * surface that resurfaces any non-terminal swap whose wizard state
 * was destroyed (X-button cancel, popup-close-during-confirm,
 * browser restart). Built from the backend's `listSwaps` response.
 *
 * Pre-2026-06-13 the wallet had no consumer for `listSwaps` so any
 * cancel-and-no-recovery scenario stranded the user — they'd have
 * to hunt through their Trocador confirmation email for the
 * trade_id. The Recent-swaps section restores in-wallet recovery
 * without making the wizard "forward-only" (which would lose the
 * fast-path for users who just want to dismiss).
 */
export interface SwapSummary {
  id: string;
  fromAsset: string;
  toAsset: string;
  fromAmountAtomic: string;
  toAmountEstimateAtomic: string;
  depositAddress: string;
  /** Trocador-string status (`new`, `waiting`, ..., `finished`). */
  status: string;
  /** ISO timestamp for the row's createdAt, used for sort + "started
   *  N min ago" rendering. */
  createdAt: string;
}

export type SwapKindBadge = 'CEX' | 'DEX';
export type SwapProviderStatus = 'active' | 'coming_soon' | 'paused';

export interface SwapTabProps {
  /** Assets the user can swap *from*. Filtered by the consumer to
   *  those Trocador supports + the wallet has a balance in. */
  fromAssets: ReadonlyArray<string>;
  /** Assets the user can swap *to*. Typically same set as `fromAssets`. */
  toAssets: ReadonlyArray<string>;
  resolveBalance: (assetId: string) => bigint | null;
  parseAmount: (assetId: string, text: string) => bigint | null;
  /** Hit Trocador for a quote. */
  onTrocadorQuote: (req: {
    fromAsset: string;
    toAsset: string;
    fromAmountAtomic: string;
  }) => Promise<SwapQuoteSummary>;
  /** Commit the quote (calls /new_trade + persists swap on backend). */
  onTrocadorConfirm: (args: {
    quote: SwapQuoteSummary;
    toAddress: string;
    refundAddress: string;
  }) => Promise<SwapInFlight>;
  /** Open the wallet's SendWizard pre-filled with the deposit address
   *  + amount. Consumer routes; we just fire the intent. */
  onOpenSend: (deposit: SwapInFlight) => void;
  /** Refresh status of an in-flight swap. Polled on a ~10s cadence
   *  on the Status step. Optional — consumers that haven't wired the
   *  backend's GET /api/v1/swaps/:id can omit and the user gets a
   *  static last-known-status display. */
  onTrocadorFetchStatus?: (id: string) => Promise<SwapInFlight>;
  /** Resolve the wallet's own address for `assetId`. Used to
   *  pre-fill the refund address (which is almost always the user's
   *  own from-asset address) and to surface a one-click "Use my
   *  address" affordance on the receive-address input. Return null
   *  when the wallet doesn't have an address for that asset (e.g.
   *  an asset that's registered but not yet derived for some
   *  reason). */
  resolveAddress?: (assetId: string) => string | null;
  /**
   * Validate an address against an asset id. Same shape as the
   * SendWizard's `validateAddress` — returns `null` if valid, a
   * short human-readable error if not. Called on Confirm in the
   * QuoteStep so a user pasting a BTC address into an XMR receive
   * field (or holding a stale refund address from a previous
   * quote with a different from-asset) doesn't ship a /new_trade
   * call that the provider may silently accept and refund to a
   * wrong-network address — irrecoverable. Optional only for
   * back-compat; consumers SHOULD wire it.
   */
  validateAddress?: (assetId: string, address: string) => string | null;
  /**
   * Pull the user's recent swaps from the backend. Shown above the
   * provider list when the wizard is inactive — gives any swap whose
   * wizard state was destroyed (X-button cancel, popup-close during
   * confirm, browser restart) a "Resume" affordance instead of
   * stranding the user. Optional only for back-compat; consumers
   * SHOULD wire it for v0.3.0 ship.
   */
  onListRecentSwaps?: () => Promise<SwapSummary[]>;
  /**
   * Resume a backend-known swap in the wizard. The consumer is
   * responsible for the store write — rehydrate the wizard with
   * `inFlight` set + `step=3` so the user lands directly on
   * StatusStep with live polling. SwapTab fires this on a recent-
   * swap row click; consumer's job to map SwapSummary onto the
   * SwapInFlight shape, including initial state mapping.
   */
  onResumeSwap?: (swap: SwapSummary) => Promise<void> | void;
  resolveIcon?: (iconKey: string) => string | undefined;
}

// ============================================================================
// Provider list
// ============================================================================

interface SupportContact {
  /** "support@trocador.app", "@TrocadorSupportBot", etc. */
  label: string;
  /** Where clicking lands the user. `mailto:`, `https:`, `tg:`, `matrix:`,
   *  `xmpp:` — anything the platform's url handler can resolve. */
  href: string;
}

interface ProviderCard {
  id: string;
  kind: SwapKindBadge;
  name: string;
  blurb: string;
  status: SwapProviderStatus;
  /** Reason / ETA copy when status !== 'active'. */
  statusNote?: string;
  /** Provider's support channels, displayed in StatusStep failure
   *  states and via the "Provider support" affordance on active cards.
   *  Stack Wallet feedback: 95% of swap support burden comes from
   *  swap failures the wallet can't fix — pushing those to the
   *  provider's channels with the trade_id in hand makes the user's
   *  next step obvious AND lets us not be in the middle of it. */
  support?: ReadonlyArray<SupportContact>;
  /** Pattern for the provider's public per-trade status page. `{ID}`
   *  is replaced with the swap's trade_id. Surfaced as a clickable
   *  link in StatusStep so the user can dig deeper without leaving
   *  context. Omit when the provider has no per-trade UI. */
  publicTradeUrl?: string;
}

/** Single source of truth for what the user sees on the Swap tab.
 *  Adding a provider is one entry here + (if active) wiring a wizard
 *  branch below. Keep ordering meaningful — actives first within each
 *  category, then coming-soon, then paused. */
const PROVIDERS: ReadonlyArray<ProviderCard> = [
  {
    id: 'trocador',
    kind: 'CEX',
    name: 'Trocador',
    blurb: 'Aggregator routing across 20+ providers. BTC, LTC, XMR; WOW/GRIN best-effort.',
    status: 'active',
    // Ordered most-responsive first. Telegram bot is real-time, email
    // is hours-to-a-day, Matrix is a community channel (peer help),
    // X is slow + public — try in that order when you're stuck.
    support: [
      { label: '@TrocadorSupportBot on Telegram', href: 'https://t.me/TrocadorSupportBot' },
      { label: 'support@trocador.app', href: 'mailto:support@trocador.app' },
      {
        label: '#Trocador.app on Matrix',
        href: 'https://matrix.to/#/%23Trocador.app:matrix.org',
      },
      { label: '@TrocadorApp on X', href: 'https://x.com/TrocadorApp' },
    ],
    publicTradeUrl: 'https://trocador.app/trade?id={ID}',
  },
  {
    id: 'moonpay',
    kind: 'CEX',
    name: 'MoonPay',
    blurb: 'Buy BTC / LTC / XMR with USD or EUR. Card and bank.',
    status: 'coming_soon',
    statusNote: 'Drops in when MoonPay onboarding clears (post-v0.3).',
  },
  {
    id: 'native_atomic',
    kind: 'DEX',
    name: 'Native atomic swaps',
    blurb: 'Adaptor-signature P2P swaps. Grin↔BTC/LTC first, WOW↔XMR after.',
    status: 'coming_soon',
    statusNote: 'v0.4 — see V0_3_PLAN.md "Beyond v0.3" roadmap.',
  },
  {
    id: 'p2p_nostr',
    kind: 'DEX',
    name: 'P2P (Nostr orderbook)',
    blurb: 'Sybil-resistant orderbook on public Nostr relays. NIP-13 PoW + WoT filtering.',
    status: 'coming_soon',
    statusNote: 'v0.5 — pairs with native atomic swaps for end-to-end P2P.',
  },
  {
    id: 'serai',
    kind: 'DEX',
    name: 'Serai',
    blurb: 'Cross-chain DEX on a dedicated app-chain. XMR/BTC/ETH liquidity.',
    status: 'coming_soon',
    statusNote: 'Watching mainnet stability.',
  },
  {
    id: 'thorswap',
    kind: 'DEX',
    name: 'THORChain (THORSwap)',
    blurb: 'BTC ↔ LTC ↔ ETH cross-chain DEX. XMR pending.',
    status: 'paused',
    statusNote: 'Returning if/when they recover from the May 2026 incident.',
  },
];

// ============================================================================
// Trocador wizard fields (persisted via useWizard)
// ============================================================================

/** Stable wizard id for the Trocador swap flow. Exported so the
 *  popup can write into the same slot before the wizard's own
 *  patchFields callback runs (e.g. mid-`onConfirm` preserve of the
 *  inFlight trade before awaiting backend mirror), without
 *  duplicating the magic string. */
export const TROCADOR_WIZARD_ID = 'swap-trocador';

interface TrocadorFields extends Record<string, unknown> {
  step: 0 | 1 | 2 | 3;
  fromAsset?: string;
  toAsset?: string;
  amountText?: string;
  /**
   * Set after step 0 advances to step 1 (quote returned). Widened
   * with `| undefined` so the wizard's `patchFields` can explicitly
   * clear it via `{ quote: undefined }` on the re-quote path —
   * `exactOptionalPropertyTypes` doesn't let an `optional T` accept
   * undefined.
   */
  quote?: SwapQuoteSummary | undefined;
  toAddress?: string;
  refundAddress?: string;
  /**
   * The from-asset id the QuoteStep auto-filled `refundAddress`
   * against. Used to detect the "back to PairStep, switch
   * fromAsset, re-quote" loop in which the persisted refundAddress
   * is for the OLD fromAsset's network — a refund to that address
   * routes funds to oblivion. Cleared on user edit, compared on
   * mount; mismatch nukes refundAddress so it re-fills fresh.
   * Pre-2026-06-13 the autofill was mount-only with no re-trigger.
   * Widened to `| undefined` for the same exactOptionalPropertyTypes
   * reason as `quote`.
   */
  refundAddressAutoFilledFor?: string | undefined;
  /** Set after step 1 advances to step 2 (trade created on Trocador). */
  inFlight?: SwapInFlight;
}

// ============================================================================
// Component
// ============================================================================

export function SwapTab(props: SwapTabProps) {
  const wizard = useWizard<TrocadorFields>(TROCADOR_WIZARD_ID, {
    step: 0,
  });

  // Provider list when no active wizard; otherwise the active
  // provider's wizard takes the whole tab.
  if (!wizard.active) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SwapHeader />
        {/* Recent swaps surface — surfaces any swap whose wizard
            state was destroyed but whose backend row is still
            non-terminal (or recently completed). The user can
            re-enter the StatusStep from here. Pre-2026-06-13 the
            wallet had zero consumer for listSwaps, so cancelling
            the wizard mid-flight orphaned the user. */}
        {props.onListRecentSwaps && props.onResumeSwap && (
          <RecentSwaps
            onList={props.onListRecentSwaps}
            onResume={props.onResumeSwap}
            {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PROVIDERS.map((p) => {
            const activate =
              p.status === 'active' && p.id === 'trocador'
                ? () => void wizard.start()
                : null;
            return (
              <ProviderRow
                key={p.id}
                provider={p}
                {...(activate ? { onActivate: activate } : {})}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // Trocador is the only provider with an active wizard in v0.3.
  const trocadorCard = PROVIDERS.find((p) => p.id === 'trocador')!;
  // Step-aware cancel. When the wizard already holds a real Trocador
  // trade (step ≥ 2 and a non-terminal inFlight), destroying the
  // wizard state strands the user — no recovery surface for the
  // trade_id, no breadcrumb back to the deposit address. Confirm
  // before deleting, and tell the user the swap still continues at
  // the provider. The Recent-swaps surface (when wired) will
  // resurface non-terminal swaps for re-entry.
  const stepFromFields = (wizard.fields.step ?? 0) as 0 | 1 | 2 | 3;
  const inFlight = wizard.fields.inFlight;
  const inFlightNonTerminal =
    inFlight !== undefined &&
    (inFlight.state.state === 'pending' || inFlight.state.state === 'failed' /* keep recoverable */);
  const cancel = () => {
    if (stepFromFields >= 2 && inFlight && inFlightNonTerminal) {
      // window.confirm in a popup is jank but it's available and
      // blocks the click — adequate for v0.3.0 ship. A future fix
      // can drop in an in-tree modal that matches the wallet's
      // visual language.
      const ok = window.confirm(
        `Close this view? Your swap (${inFlight.id}) continues at the provider — recover it from "Recent swaps" or the Activity row.`,
      );
      if (!ok) return;
    }
    void wizard.cancel();
  };
  return (
    <TrocadorWizard
      provider={trocadorCard}
      fields={wizard.fields}
      step={stepFromFields}
      patchFields={wizard.patchFields}
      cancel={cancel}
      fromAssets={props.fromAssets}
      toAssets={props.toAssets}
      resolveBalance={props.resolveBalance}
      parseAmount={props.parseAmount}
      onQuote={props.onTrocadorQuote}
      onConfirm={props.onTrocadorConfirm}
      onOpenSend={props.onOpenSend}
      {...(props.onTrocadorFetchStatus
        ? { onFetchStatus: props.onTrocadorFetchStatus }
        : {})}
      {...(props.resolveAddress ? { resolveAddress: props.resolveAddress } : {})}
      {...(props.validateAddress ? { validateAddress: props.validateAddress } : {})}
      {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
    />
  );
}

// ----- Recent swaps surface ----------------------------------------

function RecentSwaps({
  onList,
  onResume,
}: {
  onList: () => Promise<SwapSummary[]>;
  onResume: (swap: SwapSummary) => Promise<void> | void;
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  const [rows, setRows] = useState<SwapSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    onList().then(
      (xs) => {
        if (!alive) return;
        // Only surface non-terminal swaps. Terminal rows belong on a
        // future swaps-history page; pinning them here would crowd
        // the provider list and add noise the user can't act on.
        const live = xs.filter((s) => {
          return !TERMINAL_STATUS_STRINGS.includes(s.status);
        });
        live.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
        setRows(live);
      },
      (e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [onList]);
  if (err) {
    // Don't block the provider list on a backend hiccup — silently
    // hide the section and log. The user can still create a fresh
    // swap; the resume affordance is best-effort.
    console.warn('[swap] RecentSwaps fetch failed', err);
    return null;
  }
  if (rows === null || rows.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--smirk-fg-muted)' }}>
        Resume in-flight swap
      </div>
      {rows.map((s) => (
        <button
          key={s.id}
          onClick={() => void onResume(s)}
          data-testid={`swap-recent-resume-${s.fromAsset.toLowerCase()}-${s.toAsset.toLowerCase()}`}
          style={{
            textAlign: 'left',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
            border: '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            color: 'inherit',
            fontSize: 12,
          }}
        >
          <span>
            {s.fromAsset.toUpperCase()} → {s.toAsset.toUpperCase()}{' '}
            <span style={{ color: 'var(--smirk-fg-muted)' }}>· {s.status}</span>
          </span>
          <span style={{ color: 'var(--smirk-accent)' }}>Resume ›</span>
        </button>
      ))}
    </div>
  );
}

/** Mirrors backend `TERMINAL_STATUSES`. Kept inline so the UI doesn't
 *  reach into @smirk/core for a 4-entry array. */
const TERMINAL_STATUS_STRINGS: ReadonlyArray<string> = [
  'finished',
  'refunded',
  'expired',
  'error',
];

function SwapHeader() {
  return (
    <header>
      <h2 style={{ margin: 0, fontSize: 16 }}>Swap</h2>
      <div
        style={{
          fontSize: 11,
          color: 'var(--smirk-fg-muted)',
          marginTop: 2,
          lineHeight: 1.5,
        }}
      >
        CEX aggregators are non-custodial-for-Smirk but custodial for
        the underlying provider. DEX routes (coming) are fully
        trust-minimized. Pick the route that fits the trust model you
        want for this trade.
      </div>
    </header>
  );
}

function ProviderRow({
  provider,
  onActivate,
}: {
  provider: ProviderCard;
  onActivate?: () => void;
}) {
  const interactive = provider.status === 'active' && onActivate !== undefined;
  return (
    <button
      onClick={onActivate}
      disabled={!interactive}
      title={provider.statusNote}
      {...(provider.id === 'trocador' ? { 'data-testid': 'swap-provider-trocador' } : {})}
      style={{
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        background: interactive ? 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))' : 'transparent',
        border: `1px solid ${interactive ? 'var(--smirk-border)' : 'var(--smirk-border)'}`,
        borderRadius: 'var(--smirk-radius, 8px)',
        cursor: interactive ? 'pointer' : 'default',
        opacity: interactive ? 1 : 0.55,
        fontFamily: 'inherit',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.05em',
            padding: '2px 6px',
            borderRadius: 4,
            background:
              provider.kind === 'CEX' ? 'rgba(255,255,255,0.06)' : 'var(--smirk-accent)',
            color: provider.kind === 'CEX' ? 'var(--smirk-fg-muted)' : 'var(--smirk-accent-fg, #fff)',
          }}
        >
          {provider.kind}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{provider.name}</span>
        {provider.status !== 'active' && (
          <span
            style={{
              fontSize: 9,
              padding: '2px 6px',
              borderRadius: 4,
              border: `1px solid ${
                provider.status === 'paused'
                  ? 'var(--smirk-negative, #ff6b6b)'
                  : 'var(--smirk-border)'
              }`,
              color:
                provider.status === 'paused'
                  ? 'var(--smirk-negative, #ff6b6b)'
                  : 'var(--smirk-fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 700,
            }}
          >
            {provider.status === 'paused' ? 'Paused' : 'Soon'}
          </span>
        )}
        {interactive && (
          <span aria-hidden="true" style={{ marginLeft: 'auto', opacity: 0.6 }}>
            ›
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', lineHeight: 1.5 }}>
        {provider.blurb}
      </div>
      {provider.statusNote && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            fontStyle: 'italic',
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {provider.statusNote}
        </div>
      )}
      {/* Support contacts deliberately NOT rendered on the entry-point
          card — pre-quote is the wrong moment to surface "where to
          file a complaint." StatusStep does the heavy lift on
          failed/refunded states where the contacts are actually
          actionable, with the trade_id in hand. */}
    </button>
  );
}

// ============================================================================
// Trocador wizard
// ============================================================================

interface TrocadorWizardProps {
  provider: ProviderCard;
  fields: Partial<TrocadorFields>;
  step: 0 | 1 | 2 | 3;
  patchFields: (patch: Partial<TrocadorFields>) => Promise<void>;
  cancel: () => void;
  fromAssets: ReadonlyArray<string>;
  toAssets: ReadonlyArray<string>;
  resolveBalance: (assetId: string) => bigint | null;
  parseAmount: (assetId: string, text: string) => bigint | null;
  onQuote: (req: {
    fromAsset: string;
    toAsset: string;
    fromAmountAtomic: string;
  }) => Promise<SwapQuoteSummary>;
  onConfirm: (args: {
    quote: SwapQuoteSummary;
    toAddress: string;
    refundAddress: string;
  }) => Promise<SwapInFlight>;
  onOpenSend: (deposit: SwapInFlight) => void;
  onFetchStatus?: (id: string) => Promise<SwapInFlight>;
  resolveAddress?: (assetId: string) => string | null;
  validateAddress?: (assetId: string, address: string) => string | null;
  resolveIcon?: (iconKey: string) => string | undefined;
}

function TrocadorWizard(props: TrocadorWizardProps) {
  const { fields, step } = props;
  const setStep = (next: 0 | 1 | 2 | 3) => void props.patchFields({ step: next });
  const canGoBack = step > 0 && step < 3;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Single-row compact header: back chevron + badge + title + step
          + close. The previous layout used full-width <Button> for
          Back/Cancel which expanded into chunky theme-clashing blocks
          on darker themes. Icon-only nav buttons stay visually quiet
          across every theme and free the screen for the actual flow. */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 28,
        }}
      >
        {canGoBack ? (
          <button
            onClick={() => setStep((step - 1) as 0 | 1 | 2 | 3)}
            aria-label="Back"
            data-testid="swap-wizard-back"
            style={iconHeaderBtn()}
          >
            ‹
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.05em',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.06)',
            color: 'var(--smirk-fg-muted)',
          }}
        >
          CEX
        </span>
        <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>Trocador</h2>
        <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }} data-testid="swap-wizard-step">
          {step + 1}/4
        </span>
        <button
          onClick={props.cancel}
          aria-label="Cancel swap"
          title="Cancel swap"
          data-testid="swap-wizard-cancel"
          style={iconHeaderBtn()}
        >
          ✕
        </button>
      </header>

      {step === 0 && (
        <PairStep
          fromAssets={props.fromAssets}
          toAssets={props.toAssets}
          fields={fields}
          resolveBalance={props.resolveBalance}
          parseAmount={props.parseAmount}
          onPatch={(p) => void props.patchFields(p)}
          onQuote={async (q) => {
            const sum = await props.onQuote(q);
            await props.patchFields({ quote: sum, step: 1 });
          }}
          {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
        />
      )}

      {step === 1 && fields.quote && (
        <QuoteStep
          quote={fields.quote}
          toAddress={fields.toAddress ?? ''}
          refundAddress={fields.refundAddress ?? ''}
          refundAddressAutoFilledFor={fields.refundAddressAutoFilledFor}
          {...(props.resolveAddress ? { resolveAddress: props.resolveAddress } : {})}
          {...(props.validateAddress ? { validateAddress: props.validateAddress } : {})}
          onPatch={(p) => void props.patchFields(p)}
          onReQuote={() => {
            // Quote expired (or user pressed the explicit re-quote
            // path). Clear the quote so PairStep re-quotes fresh,
            // and bounce back to step 0. fromAsset/toAsset/
            // amountText/toAddress/refundAddress survive in fields
            // so the user just re-confirms a fresh rate.
            void props.patchFields({ quote: undefined, step: 0 });
          }}
          onConfirm={async (args) => {
            const sw = await props.onConfirm(args);
            await props.patchFields({ inFlight: sw, step: 2 });
          }}
        />
      )}

      {step === 2 && fields.inFlight && (
        <DepositStep
          swap={fields.inFlight}
          onOpenSend={() => {
            // Hand the deposit off to Send, AND advance the wizard to
            // the status step in the same tick. Without this, the user
            // sends, comes back to the Swap tab and lands back on the
            // "Send to deposit address" view as if nothing happened. If
            // they bail on the Send wizard the status page just shows
            // "waiting for deposit" until Trocador's quote-validity
            // window expires — same terminal we already handle.
            props.onOpenSend(fields.inFlight!);
            setStep(3);
          }}
          onContinue={() => setStep(3)}
        />
      )}

      {step === 3 && fields.inFlight && (
        <StatusStep
          swap={fields.inFlight}
          provider={props.provider}
          {...(props.onFetchStatus ? { onFetchStatus: props.onFetchStatus } : {})}
          onUpdate={(next) => {
            // Merge — `next` from the direct-Trocador fallback path
            // carries empty fromAsset/toAsset/etc. (Trocador's /trade
            // response doesn't echo them in a stable shape). Without
            // merging, the empty strings overwrite the persisted
            // values; `mustGetAsset('')` then throws on next render
            // and the whole wizard crashes. The state field is the
            // only thing that should change per poll; everything else
            // is immutable post-start.
            const prev = fields.inFlight!;
            void props.patchFields({
              inFlight: {
                ...prev,
                ...next,
                fromAsset: next.fromAsset || prev.fromAsset,
                toAsset: next.toAsset || prev.toAsset,
                fromAmountAtomic: next.fromAmountAtomic || prev.fromAmountAtomic,
                toAmountEstimateAtomic:
                  next.toAmountEstimateAtomic || prev.toAmountEstimateAtomic,
                depositAddress: next.depositAddress || prev.depositAddress,
                state: next.state,
              },
            });
          }}
          onReset={props.cancel}
        />
      )}
    </div>
  );
}

// ----- Step 0: Pair ----------------------------------------------------

function PairStep({
  fromAssets,
  toAssets,
  fields,
  resolveBalance,
  parseAmount,
  resolveIcon,
  onPatch,
  onQuote,
}: {
  fromAssets: ReadonlyArray<string>;
  toAssets: ReadonlyArray<string>;
  fields: Partial<TrocadorFields>;
  resolveBalance: (assetId: string) => bigint | null;
  parseAmount: (assetId: string, text: string) => bigint | null;
  resolveIcon?: (k: string) => string | undefined;
  onPatch: (p: Partial<TrocadorFields>) => void;
  onQuote: (req: {
    fromAsset: string;
    toAsset: string;
    fromAmountAtomic: string;
  }) => Promise<void>;
}) {
  const fromAsset = fields.fromAsset ?? fromAssets[0] ?? '';
  const toAsset =
    fields.toAsset ?? toAssets.find((a) => a !== fromAsset) ?? '';
  const amountText = fields.amountText ?? '';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedAmount =
    fromAsset && amountText.trim() ? parseAmount(fromAsset, amountText) : null;
  const balance = fromAsset ? resolveBalance(fromAsset) : null;
  const insufficient =
    parsedAmount !== null && balance !== null && parsedAmount > balance;

  const handleGetQuote = async () => {
    setError(null);
    if (!fromAsset || !toAsset || parsedAmount === null || parsedAmount <= 0n) {
      setError('Pick assets and enter an amount.');
      return;
    }
    if (fromAsset === toAsset) {
      setError('From and to must be different.');
      return;
    }
    setBusy(true);
    try {
      await onQuote({
        fromAsset,
        toAsset,
        fromAmountAtomic: parsedAmount.toString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Quote failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <AssetRow
        label="From"
        assetId={fromAsset}
        options={fromAssets}
        onChange={(id) => onPatch({ fromAsset: id })}
        {...(resolveIcon ? { resolveIcon } : {})}
      />
      <div>
        <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>Amount</label>
        <input
          type="text"
          inputMode="decimal"
          value={amountText}
          onInput={(e) => onPatch({ amountText: (e.target as HTMLInputElement).value })}
          placeholder="0.0"
          data-testid="swap-pair-amount"
          style={{
            display: 'block',
            width: '100%',
            marginTop: 4,
            padding: '10px 12px',
            background: 'var(--smirk-bg-sunken)',
            border: `1px solid ${insufficient ? 'var(--smirk-negative, #ff6b6b)' : 'var(--smirk-border)'}`,
            borderRadius: 'var(--smirk-radius, 8px)',
            color: 'inherit',
            fontSize: 16,
            fontFamily: 'var(--smirk-font-family-mono)',
            boxSizing: 'border-box',
          }}
        />
        {balance !== null && fromAsset && (
          <div
            style={{
              fontSize: 11,
              color: insufficient ? 'var(--smirk-negative, #ff6b6b)' : 'var(--smirk-fg-muted)',
              marginTop: 4,
            }}
          >
            {insufficient ? 'Insufficient — ' : 'Available — '}
            {formatAmountWithTicker(balance, fromAsset)}
          </div>
        )}
      </div>

      <AssetRow
        label="To"
        assetId={toAsset}
        options={toAssets.filter((a) => a !== fromAsset)}
        onChange={(id) => onPatch({ toAsset: id })}
        {...(resolveIcon ? { resolveIcon } : {})}
      />

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>{error}</div>
      )}

      <button
        onClick={() => void handleGetQuote()}
        disabled={busy || insufficient || !fromAsset || !toAsset || !amountText.trim()}
        data-testid="swap-pair-get-quote"
        style={primaryBtnStyle(
          busy || insufficient || !fromAsset || !toAsset || !amountText.trim(),
          busy,
        )}
      >
        {busy ? 'Quoting…' : 'Get quote'}
      </button>
    </div>
  );
}

function AssetRow({
  label,
  assetId,
  options,
  onChange,
  resolveIcon,
}: {
  label: string;
  assetId: string;
  options: ReadonlyArray<string>;
  onChange: (id: string) => void;
  resolveIcon?: (k: string) => string | undefined;
}) {
  // Row discriminator so the From and To pill rows emit distinct
  // testids (swap-pair-from-<ticker> vs swap-pair-to-<ticker>).
  const rowSlug = label.toLowerCase();
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>{label}</label>
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginTop: 4,
          flexWrap: 'wrap',
        }}
      >
        {options.map((id) => {
          const asset = mustGetAsset(id);
          const isActive = id === assetId;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              data-testid={`swap-pair-${rowSlug}-${asset.ticker}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                background: isActive ? 'var(--smirk-accent)' : 'var(--smirk-bg-sunken)',
                color: isActive ? 'var(--smirk-accent-fg, #fff)' : 'inherit',
                border: `1px solid ${isActive ? 'var(--smirk-accent)' : 'var(--smirk-border)'}`,
                borderRadius: 'var(--smirk-radius, 8px)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <AssetIcon
                assetId={id}
                size={16}
                {...(resolveIcon ? { resolveIcon } : {})}
              />
              {asset.ticker}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----- Step 1: Quote ---------------------------------------------------

function QuoteStep({
  quote,
  toAddress,
  refundAddress,
  refundAddressAutoFilledFor,
  resolveAddress,
  validateAddress,
  onPatch,
  onReQuote,
  onConfirm,
}: {
  quote: SwapQuoteSummary;
  toAddress: string;
  refundAddress: string;
  refundAddressAutoFilledFor: string | undefined;
  resolveAddress?: (assetId: string) => string | null;
  validateAddress?: (assetId: string, address: string) => string | null;
  onPatch: (p: Partial<TrocadorFields>) => void;
  /** Called when the user wants a fresh quote — either explicitly via
   *  the "Quote expired — re-quote" CTA or implicitly when the wizard
   *  needs to bounce back to step 0. Consumer clears `quote` and
   *  resets step so PairStep can re-fetch. */
  onReQuote: () => void;
  onConfirm: (args: {
    quote: SwapQuoteSummary;
    toAddress: string;
    refundAddress: string;
  }) => Promise<void>;
}) {
  const from = mustGetAsset(quote.fromAsset);
  const to = mustGetAsset(quote.toAsset);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 1Hz tick so the "Quote valid for Ns" countdown actually ticks.
  // The countdown was computed at render time only — nothing else
  // triggers re-renders on this step, so it sat frozen at whatever
  // it was when the user arrived. useState + setInterval is the
  // minimum-overhead way to force a re-render every second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const secondsLeft = Math.max(0, Math.round((quote.expiresAtMs - now) / 1000));
  const expired = secondsLeft === 0;

  // Wallet-owned addresses for the from / to assets. Used to
  // pre-fill the refund (almost always the user's own address —
  // there's rarely a separate refund channel) and to surface a
  // one-tap "use my address" on the receive input.
  const myFromAddress = resolveAddress?.(quote.fromAsset) ?? null;
  const myToAddress = resolveAddress?.(quote.toAsset) ?? null;

  // Auto-fill refund address with the user's own from-asset address
  // whenever (a) the field is empty AND we have a fresh address to
  // offer, OR (b) the persisted refund address was previously
  // auto-filled for a DIFFERENT from-asset. Case (b) is the silent
  // funds-loss bug pre-2026-06-13: the user reached QuoteStep with
  // fromAsset=BTC (BTC address auto-fills), back-navigated to
  // PairStep, changed fromAsset to XMR, re-quoted — and the stale
  // BTC refund address survived because the original effect only
  // fired once per mount with an empty-check that the persisted
  // value defeated. On a refund event the provider would then send
  // XMR to a BTC address. We rebind the autofill to `quote.fromAsset`
  // and track which asset the autofill was sourced for. The user can
  // still type a custom value freely — `refundAddressAutoFilledFor`
  // gets cleared when they edit so the rebind doesn't stomp their
  // explicit choice.
  useEffect(() => {
    if (myFromAddress && refundAddressAutoFilledFor !== quote.fromAsset) {
      // Either no autofill has happened yet, or it was for a previous
      // from-asset — refresh.
      if (
        !refundAddress ||
        (refundAddressAutoFilledFor &&
          refundAddressAutoFilledFor !== quote.fromAsset)
      ) {
        onPatch({
          refundAddress: myFromAddress,
          refundAddressAutoFilledFor: quote.fromAsset,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.fromAsset, myFromAddress]);

  const handleConfirm = async () => {
    setError(null);
    const trimmedTo = toAddress.trim();
    const trimmedRefund = refundAddress.trim();
    if (!trimmedTo) {
      setError('Enter the address where you want to receive the swap.');
      return;
    }
    if (!trimmedRefund) {
      setError(
        `Enter a ${from.ticker} refund address. Required by the provider.`,
      );
      return;
    }
    // Per-asset address validation. The receive address must match
    // the to-asset network or the user is sending funds to a place
    // they can't receive at; the refund address must match the
    // from-asset network or any refund event is irrecoverable. Pre-
    // 2026-06-13 the QuoteStep did neither check — the SendWizard
    // had `validateAddress` but the swap surface ignored it.
    if (validateAddress) {
      const toErr = validateAddress(quote.toAsset, trimmedTo);
      if (toErr) {
        setError(`Receive address: ${toErr}`);
        return;
      }
      const refundErr = validateAddress(quote.fromAsset, trimmedRefund);
      if (refundErr) {
        setError(`Refund address: ${refundErr}`);
        return;
      }
    }
    // Last-second expiry check between the click and the network
    // round-trip — a `setBusy(true)` race could otherwise let an
    // expired quote through and the wizard advances to DepositStep
    // with a stale rate. Trocador is the server-side authority but
    // the wallet should refuse to call /new_trade with what it
    // knows is expired.
    if (Date.now() >= quote.expiresAtMs) {
      setError('Quote expired. Re-quote to confirm at the current rate.');
      return;
    }
    setBusy(true);
    try {
      await onConfirm({
        quote,
        toAddress: trimmedTo,
        refundAddress: trimmedRefund,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start swap');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          padding: 12,
          background: 'var(--smirk-bg-sunken)',
          border: '1px solid var(--smirk-border)',
          borderRadius: 'var(--smirk-radius, 8px)',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Row label="You send">
          {formatAmountWithTicker(BigInt(quote.fromAmountAtomic), from.id)}
        </Row>
        <Row label="You receive (est.)">
          {formatAmountWithTicker(BigInt(quote.toAmountEstimateAtomic), to.id)}
        </Row>
        <Row label="Network/provider fee">
          ≈ {formatAmount(BigInt(quote.feeEstimateAtomic), from.id, 8)} {from.ticker}
        </Row>
        <Row label="Provider">{quote.provider}</Row>
        <Row label="ETA">{Math.max(1, Math.round(quote.etaSeconds / 60))} min</Row>
        <Row label="Quote valid for">
          <span
            style={{
              color: secondsLeft < 30 ? 'var(--smirk-negative, #ff6b6b)' : 'inherit',
            }}
          >
            {secondsLeft}s
          </span>
        </Row>
      </div>

      <div>
        <div style={addrLabelRowStyle()}>
          <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
            Your {to.ticker} receive address
          </label>
          {myToAddress && myToAddress !== toAddress && (
            <button
              type="button"
              onClick={() => onPatch({ toAddress: myToAddress })}
              data-testid="swap-quote-use-my-to-address"
              style={inlineLinkBtn()}
            >
              Use my {to.ticker} address
            </button>
          )}
        </div>
        <input
          type="text"
          value={toAddress}
          onInput={(e) => onPatch({ toAddress: (e.target as HTMLInputElement).value })}
          placeholder={`Where to send ${to.ticker}`}
          data-testid="swap-quote-to-address"
          style={addrInputStyle()}
        />
      </div>

      <div>
        <div style={addrLabelRowStyle()}>
          <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
            {from.ticker} refund address (required)
          </label>
          {myFromAddress && myFromAddress !== refundAddress && (
            <button
              type="button"
              onClick={() => onPatch({ refundAddress: myFromAddress })}
              data-testid="swap-quote-use-my-refund-address"
              style={inlineLinkBtn()}
            >
              Use my {from.ticker} address
            </button>
          )}
        </div>
        <input
          type="text"
          value={refundAddress}
          onInput={(e) =>
            onPatch({
              refundAddress: (e.target as HTMLInputElement).value,
              // User edited — drop the autofill provenance so the
              // mount effect doesn't stomp their explicit choice on
              // the next re-quote.
              refundAddressAutoFilledFor: undefined,
            })
          }
          placeholder={`Where to return ${from.ticker} on failure`}
          data-testid="swap-quote-refund-address"
          style={addrInputStyle()}
        />
        <div style={helperTextStyle()}>
          If the swap can't complete, the provider returns deposited
          funds here.
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>{error}</div>
      )}

      {/*
        When the quote is live, the CTA is "Confirm swap" and runs
        the address-validating, expiry-rechecking confirm flow.
        When the quote has expired, the CTA flips to "Quote expired
        — re-quote" and routes to the parent's re-quote handler
        (clears quote + step=0). Pre-2026-06-13 the expired button
        kept its `onClick=handleConfirm` and stayed disabled — the
        label promised an action and the button refused. The
        chevron back-arrow in the header was the only escape and
        users didn't read it as "restart the quote".
      */}
      <button
        onClick={() => {
          if (expired) {
            onReQuote();
            return;
          }
          void handleConfirm();
        }}
        disabled={busy || (!expired && (!toAddress.trim() || !refundAddress.trim()))}
        data-testid="swap-quote-confirm"
        style={primaryBtnStyle(
          busy || (!expired && (!toAddress.trim() || !refundAddress.trim())),
          busy,
        )}
      >
        {busy ? 'Creating trade…' : expired ? 'Quote expired — re-quote' : 'Confirm swap'}
      </button>
    </div>
  );
}

// ----- Step 2: Deposit -------------------------------------------------

function DepositStep({
  swap,
  onOpenSend,
  onContinue,
}: {
  swap: SwapInFlight;
  onOpenSend: () => void;
  onContinue: () => void;
}) {
  const from = mustGetAsset(swap.fromAsset);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          padding: 12,
          background: 'var(--smirk-bg-sunken)',
          border: '1px solid var(--smirk-accent)',
          borderRadius: 'var(--smirk-radius, 8px)',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>Send to the deposit address</div>
        <Row label="Amount">
          {(() => {
            const a = safeAtomicBigInt(swap.fromAmountAtomic, 'DepositStep.fromAmountAtomic');
            return a !== null ? formatAmountWithTicker(a, from.id) : '—';
          })()}
        </Row>
        <Row label="Address" mono>
          <span data-testid="swap-deposit-address">{swap.depositAddress}</span>
        </Row>
        {/* Deposit window warning. Trocador (and the providers it
            aggregates) honor deposits within ~15-30 minutes of
            /new_trade. A user who hands off to Send, closes the
            popup, and broadcasts hours later may land at a stale
            trade that the provider refuses to honor at the quoted
            rate — refund flow at best, off-quote forced fill at
            worst. The warning is generic because Trocador doesn't
            return an explicit deposit_window field. */}
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-fg-muted)',
            lineHeight: 1.45,
            marginTop: 4,
          }}
        >
          Send within ~15-30 minutes. Providers may not honor stale
          deposits at the quoted rate.
        </div>
      </div>

      <button onClick={onOpenSend} data-testid="swap-deposit-open-send" style={primaryBtnStyle(false, false)}>
        Open Send → pre-filled
      </button>

      <button
        onClick={onContinue}
        data-testid="swap-deposit-show-status"
        style={{
          padding: '8px 12px',
          background: 'transparent',
          color: 'inherit',
          border: '1px solid var(--smirk-border)',
          borderRadius: 'var(--smirk-radius, 8px)',
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        I've already sent — show status
      </button>
    </div>
  );
}

// ----- Step 3: Status --------------------------------------------------

function StatusStep({
  swap,
  provider,
  onFetchStatus,
  onUpdate,
  onReset,
}: {
  swap: SwapInFlight;
  /** The active provider's card — used to pull support contacts +
   *  public trade URL into the status display. */
  provider: ProviderCard;
  onFetchStatus?: (id: string) => Promise<SwapInFlight>;
  onUpdate: (next: SwapInFlight) => void;
  onReset: () => void;
}) {
  // Ref-based polling so the interval doesn't restart on every
  // parent render. Pre-2026-06-13 the effect deps included
  // `onUpdate` and `onFetchStatus`, both inline closures recreated
  // on each TrocadorWizard render — sibling state changes (balance
  // refresh, theme apply) tore down the 10s timer and started a
  // fresh one, perpetually delaying the first poll. Reading the
  // latest callbacks from refs lets the timer survive renders and
  // still pick up the freshest closures.
  const onUpdateRef = useRef(onUpdate);
  const onFetchStatusRef = useRef(onFetchStatus);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);
  useEffect(() => {
    onFetchStatusRef.current = onFetchStatus;
  }, [onFetchStatus]);
  useEffect(() => {
    if (!onFetchStatusRef.current) return;
    if (swap.state.state !== 'pending') return;
    let alive = true;
    const tick = async () => {
      const fetcher = onFetchStatusRef.current;
      if (!fetcher) return;
      try {
        const next = await fetcher(swap.id);
        if (alive) onUpdateRef.current(next);
      } catch {
        // Transient — retry next tick.
      }
    };
    const handle = window.setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      window.clearInterval(handle);
    };
  }, [swap.id, swap.state.state]);

  const from = mustGetAsset(swap.fromAsset);
  const to = mustGetAsset(swap.toAsset);
  const terminal = swap.state.state !== 'pending';
  // "Bad outcome" — refund or failure. Stack Wallet's support data
  // says ~95% of swap support tickets come from these states; surface
  // the provider's channels prominently so the user's next step is
  // obvious and we're not in the middle of it.
  const needsProviderHelp =
    swap.state.state === 'failed' || swap.state.state === 'refunded';
  const tradeUrl = provider.publicTradeUrl
    ? provider.publicTradeUrl.replace('{ID}', encodeURIComponent(swap.id))
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          padding: 12,
          background: 'var(--smirk-bg-sunken)',
          border: `1px solid ${
            needsProviderHelp
              ? 'var(--smirk-negative, #ff6b6b)'
              : 'var(--smirk-border)'
          }`,
          borderRadius: 'var(--smirk-radius, 8px)',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Row label="Status">
          <span data-testid="swap-status-state">{statusLabel(swap.state, swap.toAsset)}</span>
        </Row>
        <Row label="From">
          {(() => {
            const a = safeAtomicBigInt(swap.fromAmountAtomic, 'fromAmountAtomic');
            return a !== null ? formatAmountWithTicker(a, from.id) : '—';
          })()}
        </Row>
        <Row label="To (est.)">
          {(() => {
            const a = safeAtomicBigInt(swap.toAmountEstimateAtomic, 'toAmountEstimateAtomic');
            return a !== null ? formatAmountWithTicker(a, to.id) : '—';
          })()}
        </Row>
        <Row label="Trade id" mono>
          {tradeUrl ? (
            <a
              href={tradeUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--smirk-accent)', textDecoration: 'none' }}
            >
              {swap.id} ↗
            </a>
          ) : (
            swap.id
          )}
        </Row>
      </div>

      {/* Provider support panel — shown prominently on failed/refunded
          states, and as a compact footer otherwise. Reaching the
          provider with the trade_id in hand is the single most useful
          thing the user can do when a swap goes sideways. */}
      {provider.support && provider.support.length > 0 && (
        <div
          style={{
            padding: 12,
            background: needsProviderHelp
              ? 'rgba(255, 107, 107, 0.06)'
              : 'transparent',
            border: needsProviderHelp
              ? '1px solid var(--smirk-negative, #ff6b6b)'
              : '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {needsProviderHelp
              ? `Need help? Contact ${provider.name} support with the trade id above.`
              : `${provider.name} support`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {provider.support.map((c, i) => (
              <a
                key={i}
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--smirk-accent)',
                  textDecoration: 'none',
                  fontSize: 12,
                }}
              >
                {c.label} ↗
              </a>
            ))}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              lineHeight: 1.5,
            }}
          >
            Smirk publishes the wallet; the swap itself runs on{' '}
            {provider.name}. We can't intervene in the swap once it's
            in flight — the provider's team can.
          </div>
        </div>
      )}

      {terminal && (
        <button onClick={onReset} data-testid="swap-status-start-another" style={primaryBtnStyle(false, false)}>
          Start another swap
        </button>
      )}
    </div>
  );
}

/** Defensive parse of an atomic-units string into BigInt. Returns
 *  null when the input doesn't parse — most commonly when a
 *  decimal-string slipped past a backend/SDK boundary that was
 *  supposed to do the decimal→atomic conversion. Pre-2026-06-13 a
 *  bare BigInt() call here would throw on Trocador's "0.025…"
 *  amount_to once it landed in the column labelled atomic, white-
 *  screening the entire StatusStep render. This helper keeps the
 *  fallback path local: show "—" instead of crashing the wizard.
 *  Callers log so the upstream bug is still visible to ops. */
function safeAtomicBigInt(raw: string | undefined | null, label: string): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch (e) {
    console.warn(`[swap] ${label}: BigInt(${JSON.stringify(raw)}) threw — using fallback`, e);
    return null;
  }
}

function statusLabel(state: SwapInFlight['state'], toAssetId: string): string {
  switch (state.state) {
    case 'pending':
      switch (state.reason) {
        case 'awaiting_deposit':
          return 'Waiting for your deposit';
        case 'awaiting_confirmations':
          return 'Deposit confirming on-chain';
        case 'in_progress':
          return 'Provider exchanging — sending your output';
      }
      return 'Pending';
    case 'completed': {
      // `state.toAmount` is an atomic-units string from the
      // underlying Trocador response; format with the to-asset's
      // decimals so the user sees "0.0139 LTC" instead of
      // "139900946". Defensive parse — a decimal-string here used
      // to white-screen the wizard before the 2026-06-13 backend
      // decimal→atomic conversion fix.
      const parsed = safeAtomicBigInt(state.toAmount, 'completed.toAmount');
      const formatted = parsed !== null
        ? formatAmountWithTicker(parsed, toAssetId)
        : 'output';
      return `Completed — ${formatted} sent`;
    }
    case 'refunded':
      return `Refunded — ${state.reason}`;
    case 'failed':
      return `Failed — ${state.reason}`;
  }
}

// ----- shared bits -----------------------------------------------------

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: preact.ComponentChildren;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--smirk-fg-muted)' }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? 'var(--smirk-font-family-mono)' : 'inherit',
          textAlign: 'right',
          // `break-all` only when truly needed (long mono addresses
          // / hex). For amount + ticker values it splits inside the
          // ticker ("0.013218 X\nMR") on the narrow extension popup
          // width. `break-word` respects ticker boundaries.
          wordBreak: mono ? 'break-all' : 'break-word',
          // Whitespace before the ticker shouldn't be a break point.
          // `nowrap` would force overflow, so use the softer "keep
          // amount + ticker on one logical token" via whiteSpace
          // settings handled by the consumer when needed.
          minWidth: 0,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** Row that holds an address-input's label on the left and the
 *  "Use my X address" inline button on the right when applicable. */
function addrLabelRowStyle(): preact.JSX.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  };
}

/** Subtle accent-colored text button — used for "Use my address"
 *  affordances. Quiet enough not to fight the primary CTA but
 *  obvious enough that the user notices the shortcut exists. */
function inlineLinkBtn(): preact.JSX.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color: 'var(--smirk-accent)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '2px 0',
    fontFamily: 'inherit',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  };
}

/** Small explainer text under an input. Explicit `lineHeight: 1.5`
 *  so the chunky pixel fonts used by some themes (Gameboy / DMG
 *  Workbench) don't crash into the previous line. */
function helperTextStyle(): preact.JSX.CSSProperties {
  return {
    fontSize: 10,
    color: 'var(--smirk-fg-muted)',
    marginTop: 6,
    lineHeight: 1.5,
  };
}

function addrInputStyle(): preact.JSX.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '8px 10px',
    background: 'var(--smirk-bg-sunken)',
    border: '1px solid var(--smirk-border)',
    borderRadius: 'var(--smirk-radius, 8px)',
    color: 'inherit',
    fontSize: 12,
    fontFamily: 'var(--smirk-font-family-mono)',
    boxSizing: 'border-box',
  };
}

/** Compact icon button used in the wizard header for back / close.
 *  Stays visually quiet on every theme so the primary CTA at the
 *  bottom of each step keeps the visual weight. */
function iconHeaderBtn(): preact.JSX.CSSProperties {
  return {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: '1px solid var(--smirk-border)',
    borderRadius: 6,
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 14,
    fontFamily: 'inherit',
    padding: 0,
    lineHeight: 1,
  };
}

function primaryBtnStyle(disabled: boolean, busy: boolean): preact.JSX.CSSProperties {
  return {
    padding: '10px 16px',
    background: disabled ? 'rgba(255,255,255,0.06)' : 'var(--smirk-accent)',
    color: 'var(--smirk-accent-fg, #fff)',
    border: 'none',
    borderRadius: 'var(--smirk-radius, 8px)',
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
  };
}
