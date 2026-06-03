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

import { useEffect, useState } from 'preact/hooks';
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

const TROCADOR_WIZARD_ID = 'swap-trocador';

interface TrocadorFields extends Record<string, unknown> {
  step: 0 | 1 | 2 | 3;
  fromAsset?: string;
  toAsset?: string;
  amountText?: string;
  /** Set after step 0 advances to step 1 (quote returned). */
  quote?: SwapQuoteSummary;
  toAddress?: string;
  refundAddress?: string;
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
  return (
    <TrocadorWizard
      provider={trocadorCard}
      fields={wizard.fields}
      step={(wizard.fields.step ?? 0) as 0 | 1 | 2 | 3}
      patchFields={wizard.patchFields}
      cancel={() => void wizard.cancel()}
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
      {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
    />
  );
}

function SwapHeader() {
  return (
    <header>
      <h2 style={{ margin: 0, fontSize: 16 }}>Swap</h2>
      <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginTop: 2 }}>
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
      <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', lineHeight: 1.3 }}>
        {provider.blurb}
      </div>
      {provider.statusNote && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            fontStyle: 'italic',
            marginTop: 2,
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
        <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
          {step + 1}/4
        </span>
        <button
          onClick={props.cancel}
          aria-label="Cancel swap"
          title="Cancel swap"
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
          onPatch={(p) => void props.patchFields(p)}
          onConfirm={async (args) => {
            const sw = await props.onConfirm(args);
            await props.patchFields({ inFlight: sw, step: 2 });
          }}
        />
      )}

      {step === 2 && fields.inFlight && (
        <DepositStep
          swap={fields.inFlight}
          onOpenSend={() => props.onOpenSend(fields.inFlight!)}
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
  onPatch,
  onConfirm,
}: {
  quote: SwapQuoteSummary;
  toAddress: string;
  refundAddress: string;
  onPatch: (p: Partial<TrocadorFields>) => void;
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

  const handleConfirm = async () => {
    setError(null);
    if (!toAddress.trim()) {
      setError('Enter the address where you want to receive the swap.');
      return;
    }
    if (!refundAddress.trim()) {
      setError(
        `Enter a ${from.ticker} refund address. Required by the provider.`,
      );
      return;
    }
    setBusy(true);
    try {
      await onConfirm({
        quote,
        toAddress: toAddress.trim(),
        refundAddress: refundAddress.trim(),
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
        <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
          Your {to.ticker} receive address
        </label>
        <input
          type="text"
          value={toAddress}
          onInput={(e) => onPatch({ toAddress: (e.target as HTMLInputElement).value })}
          placeholder={`Where to send ${to.ticker}`}
          style={addrInputStyle()}
        />
      </div>

      <div>
        <label style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
          {from.ticker} refund address (if the swap fails)
        </label>
        <input
          type="text"
          value={refundAddress}
          onInput={(e) => onPatch({ refundAddress: (e.target as HTMLInputElement).value })}
          placeholder={`Where to return ${from.ticker} on failure`}
          style={addrInputStyle()}
        />
        <div
          style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', marginTop: 4 }}
        >
          The provider returns deposited funds here if the swap can't complete.
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>{error}</div>
      )}

      <button
        onClick={() => void handleConfirm()}
        disabled={busy || expired || !toAddress.trim() || !refundAddress.trim()}
        style={primaryBtnStyle(
          busy || expired || !toAddress.trim() || !refundAddress.trim(),
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
          {formatAmountWithTicker(BigInt(swap.fromAmountAtomic), from.id)}
        </Row>
        <Row label="Address" mono>
          {swap.depositAddress}
        </Row>
      </div>

      <button onClick={onOpenSend} style={primaryBtnStyle(false, false)}>
        Open Send → pre-filled
      </button>

      <button
        onClick={onContinue}
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
  useEffect(() => {
    if (!onFetchStatus) return;
    if (swap.state.state !== 'pending') return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await onFetchStatus(swap.id);
        if (alive) onUpdate(next);
      } catch {
        // Transient — retry next tick.
      }
    };
    const handle = window.setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      window.clearInterval(handle);
    };
  }, [swap.id, swap.state.state, onFetchStatus, onUpdate]);

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
        <Row label="Status">{statusLabel(swap.state, swap.toAsset)}</Row>
        <Row label="From">
          {formatAmountWithTicker(BigInt(swap.fromAmountAtomic), from.id)}
        </Row>
        <Row label="To (est.)">
          {formatAmountWithTicker(BigInt(swap.toAmountEstimateAtomic), to.id)}
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
          <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
            Smirk publishes the wallet; the swap itself runs on{' '}
            {provider.name}. We can't intervene in the swap once it's
            in flight — the provider's team can.
          </div>
        </div>
      )}

      {terminal && (
        <button onClick={onReset} style={primaryBtnStyle(false, false)}>
          Start another swap
        </button>
      )}
    </div>
  );
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
      // "139900946". Empty-string defends against missing data.
      const formatted = state.toAmount
        ? formatAmountWithTicker(BigInt(state.toAmount), toAssetId)
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
