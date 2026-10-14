/**
 * SwapTab: top-level Swap surface for the wallet.
 *
 * Two concerns in one tab:
 *
 *   1. **Provider list**: every swap route we surface, each labeled
 *      [CEX] or [DEX] so the user can see the trust model at a glance.
 *      Single scrollable list rather than two sub-tabs because (a) the
 *      list is shorter than a screen on every form factor, (b) mobile
 *      doesn't love nested tab bars, and (c) hiding DEX entries behind
 *      a tab when most of them are "coming soon" makes them feel
 *      forgotten instead of telegraphed.
 *   2. **Active provider wizard**: once the user picks an active
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
 * `useWizard('swap-trocador')` which uses the @smirk/core store;
 * the same primitive backs the extension popup, Tauri desktop, and
 * Capacitor mobile.
 *
 * Strictly presentational. The consumer wires the actual Trocador
 * calls + persistence + Send-handoff via the handler props.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { getAsset, mustGetAsset } from '@smirk/assets';
import type { WizardState } from '@smirk/core';
import { useWizard } from '../state/hooks';
import { AssetIcon } from './AssetIcon';
import { formatAmountWithTicker, formatAmount } from '../format';
import { WhereToTrade, type TradePairPrice } from './WhereToTrade';

// ============================================================================
// Public types
// ============================================================================

/** Quote returned from `onTrocadorQuote`. All non-JSON-friendly fields
 *  (no Date, no bigint) so it can sit inside wizard.fields and survive
 *  serialization to chrome.storage / IndexedDB / wherever the platform
 *  persists session state.
 *
 *  Critically, `tradeId` (Trocador's `trade_id` from /new_rate) lives
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
  /** The asset `feeEstimateAtomic` is counted in. Absent means the from-asset.
   *  THORChain charges in the destination asset. */
  feeAssetId?: string;
  /** True when the fee is already taken out of `toAmountEstimateAtomic`, so
   *  the fee row reads as a breakdown, not a further charge. */
  feeIncludedInEstimate?: boolean;
  provider: string;
  etaSeconds: number;
  /** Unix ms; UI computes "valid for Ns" off this. */
  expiresAtMs: number;
  /** Provider-specific, JSON-safe data the confirm step hands back
   *  (THORChain: vault address, memo, limits). Absent for Trocador. */
  providerData?: unknown;
  /** Order-book reading for venues that fill against a public book
   *  (NonLogs). Shown beside the quote: expected receipt, price impact,
   *  depth, and both estimates when they disagree. */
  bookAnalysis?: BookAnalysisView;
  /** Notes the user must read before confirming, in plain words. */
  notices?: ReadonlyArray<string>;
}

/** JSON-safe order-book reading for the quote step. Amounts are decimal
 *  strings in the named coin, not atomic units. */
export interface BookAnalysisView {
  /** Markets walked, e.g. `["GRIN-BTC", "WOW-BTC"]`. */
  route: ReadonlyArray<string>;
  expectedReceive: string;
  /** Price impact against the mid price, as a fraction; null without one. */
  priceImpact: number | null;
  /** Largest input the visible books fill completely, in the input coin. */
  maxInput: string;
  exceedsDepth: boolean;
  warning: 'none' | 'notice' | 'strong' | 'exceeds_depth' | 'no_market';
  /** The venue's own estimate, when it differs materially from the books. */
  venueEstimate: string | null;
  estimatesDiffer: boolean;
  feesModelled: string;
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
  /** Which provider runs this swap. Absent means Trocador (older state). */
  provider?: string;
  /**
   * Instruction the deposit must carry (THORChain). When present the
   * deposit address must never be paid without it: Smirk's Send adds it,
   * another wallet will not, and a deposit without it is not swapped.
   */
  memo?: string;
  /** Unix ms after which the deposit must not be sent (THORChain). */
  depositBeforeMs?: number;
  /** Txid of the deposit once the wallet broadcast it (THORChain tracks
   *  swaps by the inbound txid). */
  depositTxid?: string;
  /** The provider's private status page for this swap (NonLogs). A bearer
   *  link: shown to the user only, never shared or logged. */
  statusUrl?: string;
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
 * Without this surface, a cancel-and-no-recovery scenario strands
 * the user: the only route back to a live trade is the trade_id in
 * a Trocador confirmation email. Recent swaps keeps recovery
 * in-wallet without making the wizard "forward-only", which would
 * lose the fast path for users who just want to dismiss it.
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
/**
 * `unavailable`: the wallet server offers this provider, but it has no live
 * pair right now (neutral, listed with the live providers). `paused`: the
 * wallet server has turned it off (listed last).
 */
export type SwapProviderStatus = 'active' | 'unavailable' | 'coming_soon' | 'paused';

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
   *  + amount. Consumer routes. Return (or resolve) `false` when Send did
   *  not open, for example because the user kept a Send draft: the swap then
   *  stays on its deposit step instead of moving to the status step. */
  onOpenSend: OpenSendHandler;
  /** Refresh status of an in-flight swap. Polled on a ~10s cadence
   *  on the Status step. Optional: consumers that haven't wired the
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
   * SendWizard's `validateAddress`: returns `null` if valid, a
   * short human-readable error if not. Called on Confirm in the
   * QuoteStep so a user pasting a BTC address into an XMR receive
   * field (or holding a stale refund address from a previous
   * quote with a different from-asset) doesn't ship a /new_trade
   * call that the provider may silently accept and refund to a
   * wrong-network address: irrecoverable. Optional only for
   * back-compat; consumers SHOULD wire it.
   */
  validateAddress?: (assetId: string, address: string) => string | null;
  /**
   * Pull the user's recent swaps from the backend. Shown above the
   * provider list when the wizard is inactive: gives any swap whose
   * wizard state was destroyed (X-button cancel, popup-close during
   * confirm, browser restart) a "Resume" affordance instead of
   * stranding the user. Optional only for back-compat; consumers
   * SHOULD wire it for v0.3.0 ship.
   */
  onListRecentSwaps?: () => Promise<SwapSummary[]>;
  /**
   * Resume a backend-known swap in the wizard. The consumer is
   * responsible for the store write: rehydrate the wizard with
   * `inFlight` set + `step=3` so the user lands directly on
   * StatusStep with live polling. SwapTab fires this on a recent-
   * swap row click; consumer's job to map SwapSummary onto the
   * SwapInFlight shape, including initial state mapping.
   */
  onResumeSwap?: (swap: SwapSummary) => Promise<void> | void;
  resolveIcon?: (iconKey: string) => string | undefined;
  /**
   * THORChain. Omit to hide its card. Pairs are decided
   * live by the consumer (THORChain's own state plus the wallet server's
   * policy), so an empty pair list shows `unavailableReason` instead.
   */
  thorchain?: ThorchainHandlers;
  /**
   * NonLogs (order-book exchange, brokered by the wallet server). Omit to
   * hide its card. Its quotes carry `bookAnalysis`.
   */
  nonlogs?: ProviderHandlers;
  /** Live DEX prices for the WOW/GRIN "where to trade" panel. Optional;
   *  the panel renders its venue list without them, and calls this only
   *  when the user asks for prices. */
  loadTradePrices?: () => Promise<TradePairPrice[]>;
}

/** Everything a live-provider wizard needs from the consumer. */
export type ProviderHandlers = ThorchainHandlers;

/** Everything the THORChain wizard needs from the consumer. */
export interface ThorchainHandlers {
  fromAssets: ReadonlyArray<string>;
  toAssets: ReadonlyArray<string>;
  /** Shown on the provider card when no pair is live. */
  unavailableReason?: string;
  /**
   * Whether the wallet server offers this provider (its `/capabilities`
   * switch). `false` hides its card; `true` or absent lists it with the live
   * providers, as a tap target or as unavailable right now.
   */
  offered?: boolean;
  /**
   * Ask the provider whether it is live. Opening the Swap tab is not a
   * request to contact a third party, so a provider that answers from its
   * own servers is checked only when the user taps its card (or has already
   * chosen it). Present while there is no live answer and no check running;
   * the card then reads as a tap target showing `unavailableReason`.
   */
  onCheck?: () => void;
  onQuote: (req: { fromAsset: string; toAsset: string; fromAmountAtomic: string }) => Promise<SwapQuoteSummary>;
  onConfirm: (args: { quote: SwapQuoteSummary; toAddress: string; refundAddress: string }) => Promise<SwapInFlight>;
  onFetchStatus?: (id: string) => Promise<SwapInFlight>;
}

// ============================================================================
// Provider list
// ============================================================================

interface SupportContact {
  /** "support@trocador.app", "@TrocadorSupportBot", etc. */
  label: string;
  /** Where clicking lands the user. `mailto:`, `https:`, `tg:`, `matrix:`,
   *  `xmpp:` (anything the platform's url handler can resolve). */
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
  /** Not live yet, but a tap asks the provider (see `ThorchainHandlers.onCheck`). */
  checkable?: boolean;
  /** Provider's support channels, displayed in StatusStep failure
   *  states and via the "Provider support" affordance on active cards.
   *  Stack Wallet feedback: 95% of swap support burden comes from
   *  swap failures the wallet can't fix; pushing those to the
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
 *  branch below. The order shown is computed by `orderProviders`: live and
 *  server-offered providers first, then coming-soon, then paused; within a
 *  tier, the order of this list. */
const PROVIDERS: ReadonlyArray<ProviderCard> = [
  {
    id: 'trocador',
    kind: 'CEX',
    name: 'Trocador',
    blurb: 'Aggregator routing across 20+ providers. BTC, LTC and XMR.',
    status: 'active',
    // Ordered most-responsive first. Telegram bot is real-time, email
    // is hours-to-a-day, Matrix is a community channel (peer help),
    // X is slow + public; try in that order when you're stuck.
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
    id: 'native_atomic',
    kind: 'DEX',
    name: 'Native atomic swaps',
    blurb: 'Adaptor-signature P2P swaps. Grin↔BTC/LTC first, WOW↔XMR after.',
    status: 'coming_soon',
    statusNote: 'In development.',
  },
  {
    id: 'p2p_nostr',
    kind: 'DEX',
    name: 'P2P (Nostr orderbook)',
    blurb: 'Sybil-resistant orderbook on public Nostr relays. NIP-13 PoW + WoT filtering.',
    status: 'coming_soon',
    statusNote: 'In development, together with native atomic swaps.',
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
    id: 'thorchain',
    kind: 'DEX',
    name: 'THORChain',
    blurb: 'Cross-chain pools. BTC and LTC; XMR once this wallet server enables it.',
    status: 'paused',
    statusNote: 'Not checked yet.',
    support: [
      { label: 'THORChain transaction tracker', href: 'https://thorchain.net' },
      { label: 'THORChain Discord', href: 'https://discord.gg/thorchain' },
    ],
    publicTradeUrl: 'https://thorchain.net/tx/{ID}',
  },
  {
    id: 'nonlogs',
    kind: 'CEX',
    name: 'NonLogs',
    blurb: 'Order-book exchange. WOW with BTC and XMR, plus BTC, LTC and XMR. Pays your own addresses.',
    status: 'paused',
    statusNote: 'Checking NonLogs…',
    support: [
      { label: 'info@nonlogs.io', href: 'mailto:info@nonlogs.io' },
      { label: 'NonLogs support', href: 'https://nonlogs.io' },
    ],
  },
];

/** A provider card as shown: its status after live state, and the label of
 *  the small badge beside its name (none for active cards). */
export type ShownProviderCard = ProviderCard & { badge?: string };

const liveProvider = (h: ProviderHandlers | undefined): boolean =>
  !!h && h.fromAssets.length > 0 && h.toAssets.length > 0;

const tickerList = (h: ProviderHandlers): string =>
  [...new Set([...h.fromAssets, ...h.toAssets])].map((a) => a.toUpperCase()).join(', ');

/** Display tier: live and server-offered providers before coming-soon. */
const TIER: Record<SwapProviderStatus, number> = { active: 0, unavailable: 0, coming_soon: 1, paused: 2 };

/**
 * The Swap tab's provider cards, in display order. A provider the wallet
 * server offers is never shown as paused: it is live, a tap target ("Tap to
 * check", for one that asks a third party only when tapped), or unavailable
 * right now. A provider the server does not offer (switched off, or not wired
 * by the consumer) is not listed at all; Trocador is always listed. Pure, so
 * the order, labels and visibility are testable.
 */
export function swapProviderCards(
  thor: ThorchainHandlers | undefined,
  nl: ProviderHandlers | undefined,
): ShownProviderCard[] {
  const shaped = (p: ProviderCard, h: ProviderHandlers | undefined, live: (h: ProviderHandlers) => string, offeredNote: string): ShownProviderCard | null => {
    if (!h || h.offered === false) return null;
    if (liveProvider(h)) {
      // The note is pre-check copy ("Not checked yet."); a live card has none.
      const { statusNote: _preCheck, ...rest } = p;
      return { ...rest, status: 'active', blurb: live(h) };
    }
    if (h.onCheck) return { ...p, status: 'unavailable', checkable: true, statusNote: h.unavailableReason ?? offeredNote, badge: 'Tap to check' };
    return { ...p, status: 'unavailable', statusNote: h.unavailableReason ?? offeredNote, badge: 'Unavailable now' };
  };
  const shapeCard = (p: ProviderCard): ShownProviderCard | null => {
    if (p.id === 'thorchain') {
      return shaped(p, thor, (h) => `Cross-chain pools. Live now: ${tickerList(h)}.`, 'No live pair right now.');
    }
    if (p.id === 'nonlogs') {
      return shaped(
        p,
        nl,
        (h) => `Order-book exchange. Live now: ${tickerList(h)}. Pays your own addresses.`,
        'No pair for this wallet right now.',
      );
    }
    if (p.status === 'coming_soon') return { ...p, badge: 'Soon' };
    if (p.status === 'paused') return { ...p, badge: 'Paused' };
    return p;
  };
  const cards = PROVIDERS.map(shapeCard).filter((c): c is ShownProviderCard => c !== null);
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => TIER[a.c.status] - TIER[b.c.status] || a.i - b.i)
    .map(({ c }) => c);
}

/** Stable wizard id for the THORChain flow. */
export const THORCHAIN_WIZARD_ID = 'swap-thorchain';

/** Stable wizard id for the NonLogs flow. */
export const NONLOGS_WIZARD_ID = 'swap-nonlogs';

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
   * clear it via `{ quote: undefined }` on the re-quote path:
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
   * is for the OLD fromAsset's network: a refund to that address
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

/**
 * True when a persisted swap wizard (any provider) holds a swap its provider
 * settled: delivered, or refunded to the sender. Nothing is left to resume.
 * A `failed` swap is not settled: its reasons include a refund still on its
 * way and a provider status the wallet could not read, so it stays restorable
 * with its trade id and support contacts.
 */
export function swapSettled(state: WizardState): boolean {
  const outcome = (state.fields as Partial<TrocadorFields>).inFlight?.state?.state;
  return outcome === 'completed' || outcome === 'refunded';
}

// ============================================================================
// Component
// ============================================================================

export function SwapTab(props: SwapTabProps) {
  const trocador = useWizard<TrocadorFields>(TROCADOR_WIZARD_ID, {
    step: 0,
  });
  const thorchain = useWizard<TrocadorFields>(THORCHAIN_WIZARD_ID, {
    step: 0,
  });
  const nonlogsWizard = useWizard<TrocadorFields>(NONLOGS_WIZARD_ID, {
    step: 0,
  });
  const thor = props.thorchain;
  const nl = props.nonlogs;
  const cards = swapProviderCards(thor, nl);

  // A THORChain wizard restored from an earlier session is the user's own
  // choice of provider, so it may ask THORChain, once per mount (a failed
  // check must not loop); the provider list never does.
  const thorNeedsCheck = thorchain.active && !!thor?.onCheck && !liveProvider(thor);
  const thorAutoChecked = useRef(false);
  useEffect(() => {
    if (!thorNeedsCheck || thorAutoChecked.current) return;
    thorAutoChecked.current = true;
    thor!.onCheck!();
  }, [thorNeedsCheck]);

  // Provider list when no active wizard; otherwise the active
  // provider's wizard takes the whole tab.
  if (!trocador.active && !thorchain.active && !nonlogsWizard.active) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SwapHeader />
        {/* Recent swaps surface: surfaces any swap whose wizard
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
          {cards.map((p) => {
            const activate =
              p.checkable && p.id === 'thorchain' && thor?.onCheck
                ? thor.onCheck
                : p.status !== 'active'
                ? null
                : p.id === 'trocador'
                  ? () => void trocador.start()
                  : p.id === 'thorchain'
                    ? () => void thorchain.start()
                    : p.id === 'nonlogs'
                      ? () => void nonlogsWizard.start()
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
        <WhereToTrade {...(props.loadTradePrices ? { loadPrices: props.loadTradePrices } : {})} />
      </div>
    );
  }

  const usingThor = thorchain.active && !!thor;
  const usingNonlogs = !usingThor && nonlogsWizard.active && !!nl;
  const wizard = usingThor ? thorchain : usingNonlogs ? nonlogsWizard : trocador;
  const card = cards.find((p) => p.id === (usingThor ? 'thorchain' : usingNonlogs ? 'nonlogs' : 'trocador'))!;
  // Step-aware cancel. When the wizard already holds a real Trocador
  // trade (step ≥ 2 and a non-terminal inFlight), destroying the
  // wizard state strands the user: no recovery surface for the
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
      // blocks the click: adequate for v0.3.0 ship. A future fix
      // can drop in an in-tree modal that matches the wallet's
      // visual language.
      const ok = window.confirm(
        usingThor
          ? 'Close this view? If you already sent the deposit, THORChain still completes the swap. Follow it from the Activity row.'
          : usingNonlogs
            ? 'Close this view? If you already sent the deposit, NonLogs still completes the swap. Follow it from the Activity row.'
            : `Close this view? Your swap (${inFlight.id}) continues at the provider — recover it from "Recent swaps" or the Activity row.`,
      );
      if (!ok) return;
    }
    void wizard.cancel();
  };
  const live2 = usingThor ? thor : usingNonlogs ? nl : undefined;
  const handlers = live2
    ? {
        fromAssets: live2.fromAssets,
        toAssets: live2.toAssets,
        onQuote: live2.onQuote,
        onConfirm: live2.onConfirm,
        onFetchStatus: live2.onFetchStatus,
      }
    : {
        fromAssets: props.fromAssets,
        toAssets: props.toAssets,
        onQuote: props.onTrocadorQuote,
        onConfirm: props.onTrocadorConfirm,
        onFetchStatus: props.onTrocadorFetchStatus,
      };
  return (
    <TrocadorWizard
      provider={card}
      fields={wizard.fields}
      step={stepFromFields}
      patchFields={wizard.patchFields}
      cancel={cancel}
      fromAssets={handlers.fromAssets}
      toAssets={handlers.toAssets}
      resolveBalance={props.resolveBalance}
      parseAmount={props.parseAmount}
      onQuote={handlers.onQuote}
      onConfirm={handlers.onConfirm}
      onOpenSend={props.onOpenSend}
      {...(handlers.onFetchStatus ? { onFetchStatus: handlers.onFetchStatus } : {})}
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
    // Don't block the provider list on a backend hiccup: silently
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
        CEX routes are non-custodial for Smirk but custodial at the
        exchange that runs the swap. DEX routes such as THORChain are
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
  provider: ShownProviderCard;
  onActivate?: () => void;
}) {
  const badge = provider.badge ?? (provider.status === 'paused' ? 'Paused' : provider.status === 'coming_soon' ? 'Soon' : undefined);
  const alarming = provider.status === 'paused';
  const interactive = (provider.status === 'active' || !!provider.checkable) && onActivate !== undefined;
  return (
    <button
      onClick={onActivate}
      disabled={!interactive}
      title={provider.statusNote}
      data-testid={`swap-provider-${provider.id}`}
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
        {provider.status !== 'active' && badge && (
          <span
            data-testid={`swap-provider-${provider.id}-badge`}
            style={{
              fontSize: 9,
              padding: '2px 6px',
              borderRadius: 4,
              border: `1px solid ${alarming ? 'var(--smirk-negative, #ff6b6b)' : 'var(--smirk-border)'}`,
              color: alarming ? 'var(--smirk-negative, #ff6b6b)' : 'var(--smirk-fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 700,
              whiteSpace: 'nowrap',
            }}
          >
            {badge}
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
          card: pre-quote is the wrong moment to surface "where to
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
  onOpenSend: OpenSendHandler;
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
          {props.provider.kind}
        </span>
        <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>{props.provider.name}</h2>
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
            // Hand the deposit off to Send, then advance the wizard to the
            // status step, so a user who sends and comes back does not land
            // on "Send to deposit address" as if nothing happened. Only when
            // Send opened: a user who kept their Send draft stays here, where
            // the deposit can still be paid (openSendFromDeposit).
            void openSendFromDeposit(props.onOpenSend, fields.inFlight!, () => props.patchFields({ step: 3 })).catch(
              (e: unknown) => console.warn('[swap] Open Send failed; the deposit step stays', e),
            );
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
            // Merge: `next` from the direct-Trocador fallback path
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

/** Exported for tests; the wizard is the only caller. */
export function QuoteStep({
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
  /** Called when the user wants a fresh quote: either explicitly via
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
  // The countdown was computed at render time only: nothing else
  // triggers re-renders on this step, so it sat frozen at whatever
  // it was when the user arrived. useState + setInterval is the
  // minimum-overhead way to force a re-render every second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const secondsLeft = Math.max(0, Math.round((quote.expiresAtMs - now) / 1000));
  // A confirm the provider refused as stale (`quote_expired`: the rate moved,
  // the vault rotated) needs a new quote just as an expired one does.
  const [stale, setStale] = useState(false);
  const expired = secondsLeft === 0 || stale;
  const feeAsset = mustGetAsset(quote.feeAssetId ?? quote.fromAsset);

  // Wallet-owned addresses for the from / to assets. Used to
  // pre-fill the refund (almost always the user's own address;
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
  // PairStep, changed fromAsset to XMR, re-quoted, and the stale
  // BTC refund address survived because the original effect only
  // fired once per mount with an empty-check that the persisted
  // value defeated. On a refund event the provider would then send
  // XMR to a BTC address. We rebind the autofill to `quote.fromAsset`
  // and track which asset the autofill was sourced for. The user can
  // still type a custom value freely: `refundAddressAutoFilledFor`
  // gets cleared when they edit so the rebind doesn't stomp their
  // explicit choice.
  useEffect(() => {
    if (myFromAddress && refundAddressAutoFilledFor !== quote.fromAsset) {
      // Either no autofill has happened yet, or it was for a previous
      // from-asset: refresh.
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
    // 2026-06-13 the QuoteStep did neither check: the SendWizard
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
    // round-trip: a `setBusy(true)` race could otherwise let an
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
      if ((e as { code?: unknown } | null)?.code === 'quote_expired') setStale(true);
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
          <span data-testid="swap-quote-fee">
            ≈ {formatAmount(BigInt(quote.feeEstimateAtomic), feeAsset.id, 8)} {feeAsset.ticker}
            {quote.feeIncludedInEstimate ? ', included in the estimate' : ''}
          </span>
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

      {quote.bookAnalysis && (
        <BookAnalysisPanel analysis={quote.bookAnalysis} fromTicker={from.ticker} toTicker={to.ticker} />
      )}
      {quote.notices && quote.notices.length > 0 && (
        <ul data-testid="swap-quote-notices" style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: 'var(--smirk-fg-muted)', lineHeight: 1.5 }}>
          {quote.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

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
              // User edited: drop the autofill provenance so the
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
        kept its `onClick=handleConfirm` and stayed disabled: the
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
        {busy ? 'Creating trade…' : stale ? 'Get a new quote' : expired ? 'Quote expired — re-quote' : 'Confirm swap'}
      </button>
    </div>
  );
}

/** Percent with one decimal, e.g. 0.0312 -> "3.1%". */
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * What the order books say about this fill: the expected receipt after
 * fees, the price impact against the mid, how much the visible books can
 * take, and the venue's own estimate when it disagrees materially.
 */
export function BookAnalysisPanel({
  analysis,
  fromTicker,
  toTicker,
}: {
  analysis: BookAnalysisView;
  fromTicker: string;
  toTicker: string;
}) {
  const a = analysis;
  const tone =
    a.warning === 'exceeds_depth' || a.warning === 'strong' || a.warning === 'no_market'
      ? 'var(--smirk-negative, #ff6b6b)'
      : a.warning === 'notice'
        ? 'var(--smirk-warning, #f0b429)'
        : 'var(--smirk-border)';
  const headline =
    a.warning === 'exceeds_depth'
      ? `This order is larger than the visible order book. At most ${a.maxInput} ${fromTicker} fills at the posted prices; the rest would wait for new orders or be refunded.`
      : a.warning === 'no_market'
        ? 'No order book could be read for this pair.'
        : a.warning === 'strong'
          ? `High price impact (${a.priceImpact === null ? 'unknown' : pct(a.priceImpact)}): this order moves the price a lot. Consider a smaller amount.`
          : a.warning === 'notice'
            ? `Noticeable price impact (${a.priceImpact === null ? 'no mid price' : pct(a.priceImpact)}).`
            : null;
  return (
    <div
      data-testid="swap-book-analysis"
      style={{
        padding: 12,
        border: `1px solid ${tone}`,
        borderRadius: 'var(--smirk-radius, 8px)',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 12 }}>From the live order book</div>
      <Row label="Expected to receive">
        <span data-testid="swap-book-expected">
          {a.expectedReceive} {toTicker}
        </span>
      </Row>
      {a.estimatesDiffer && a.venueEstimate !== null && (
        <Row label="Venue's own estimate">
          {a.venueEstimate} {toTicker}
        </Row>
      )}
      <Row label="Price impact">{a.priceImpact === null ? '—' : pct(a.priceImpact)}</Row>
      <Row label="Book depth">
        up to {a.maxInput} {fromTicker}
      </Row>
      <Row label="Route">{a.route.join(' → ')}</Row>
      {headline && <div style={{ color: tone, lineHeight: 1.5, marginTop: 4 }}>{headline}</div>}
      {a.estimatesDiffer && (
        <div style={{ color: 'var(--smirk-fg-muted)', lineHeight: 1.5 }}>
          The two estimates differ: the venue's is its own projection, the book figure walks the orders posted
          right now. Neither is guaranteed.
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', lineHeight: 1.5 }}>Fees included: {a.feesModelled}.</div>
    </div>
  );
}

// ----- Step 2: Deposit -------------------------------------------------

/**
 * The consumer's "open Send on this deposit". `false` means Send did not open;
 * anything else (including no answer, from a consumer that predates it) means
 * it did.
 */
export type OpenSendHandler = (deposit: SwapInFlight) => boolean | void | Promise<boolean | void>;

/**
 * The deposit step's "Open Send → pre-filled": hand `deposit` to the consumer
 * and run `toStatus` only once Send opened. Resolves whether it did.
 *
 * The status step has no pay action and no way back, and a memo deposit never
 * shows its address. Moving there while Send stayed closed (the user declined
 * to replace a Send draft) left a quoted deposit nothing in the wallet could
 * pay; the user had to cancel the swap and quote again.
 */
export async function openSendFromDeposit(
  onOpenSend: OpenSendHandler,
  deposit: SwapInFlight,
  toStatus: () => Promise<void>,
): Promise<boolean> {
  if ((await onOpenSend(deposit)) === false) return false;
  await toStatus();
  return true;
}

/** Exported for tests; the wizard is the only caller. */
export function DepositStep({
  swap,
  onOpenSend,
  onContinue,
}: {
  swap: SwapInFlight;
  onOpenSend: () => void;
  onContinue: () => void;
}) {
  const from = mustGetAsset(swap.fromAsset);
  const to = swap.toAsset ? getAsset(swap.toAsset) ?? null : null;
  const toEstimate = safeAtomicBigInt(swap.toAmountEstimateAtomic, 'DepositStep.toAmountEstimateAtomic');
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
          <span data-testid="swap-deposit-amount">
            {(() => {
              const a = safeAtomicBigInt(swap.fromAmountAtomic, 'DepositStep.fromAmountAtomic');
              return a !== null ? formatAmountWithTicker(a, from.id) : '—';
            })()}
          </span>
        </Row>
        {/* The figure this deposit was quoted at, which can differ from the
            estimate on the previous screen: the confirm re-quotes. */}
        {to && toEstimate !== null && (
          <Row label="You receive (est.)">
            <span data-testid="swap-deposit-receive">{formatAmountWithTicker(toEstimate, to.id)}</span>
          </Row>
        )}
        {swap.memo ? (
          // A memo deposit: the vault address alone is NOT a payment
          // destination. Paid from another wallet, or by hand, the deposit
          // arrives without its instruction and is not swapped. So the
          // address is not shown as something to copy, only Send is offered,
          // and the deadline is explicit.
          <div
            data-testid="swap-deposit-memo-warning"
            style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--smirk-fg)' }}
          >
            Use the button below. This deposit carries a swap instruction that
            only Smirk adds; paying the address from another wallet loses the
            funds to the pool.
            {swap.depositBeforeMs !== undefined && (
              <div style={{ marginTop: 6, color: 'var(--smirk-fg-muted)', fontSize: 11 }}>
                Send before {new Date(swap.depositBeforeMs).toLocaleTimeString()}. After that, get a new quote.
              </div>
            )}
          </div>
        ) : (
          <Row label="Address" mono>
            <span data-testid="swap-deposit-address">{swap.depositAddress}</span>
          </Row>
        )}
        {/* Deposit window warning. Trocador (and the providers it
            aggregates) honor deposits within ~15-30 minutes of
            /new_trade. A user who hands off to Send, closes the
            popup, and broadcasts hours later may land at a stale
            trade that the provider refuses to honor at the quoted
            rate: refund flow at best, off-quote forced fill at
            worst. The warning is generic because Trocador doesn't
            return an explicit deposit_window field. A memo deposit
            states its own deadline above. */}
        {!swap.memo && (
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
        )}
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
  /** The active provider's card: used to pull support contacts +
   *  public trade URL into the status display. */
  provider: ProviderCard;
  onFetchStatus?: (id: string) => Promise<SwapInFlight>;
  onUpdate: (next: SwapInFlight) => void;
  onReset: () => void;
}) {
  // Ref-based polling so the interval doesn't restart on every
  // parent render. Pre-2026-06-13 the effect deps included
  // `onUpdate` and `onFetchStatus`, both inline closures recreated
  // on each TrocadorWizard render: sibling state changes (balance
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
        // Transient: retry next tick.
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
  // "Bad outcome": refund or failure. Stack Wallet's support data
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
        {swap.statusUrl && (
          <Row label="Swap page">
            <a
              href={swap.statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="swap-status-private-link"
              style={{ color: 'var(--smirk-accent)', textDecoration: 'none' }}
            >
              Open on {provider.name} ↗
            </a>
          </Row>
        )}
      </div>
      {swap.statusUrl && (
        <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', lineHeight: 1.5, marginTop: -6 }}>
          That page is private to this swap: anyone with the link can see it, so do not share it.
        </div>
      )}

      {/* Provider support panel: shown prominently on failed/refunded
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
 *  null when the input doesn't parse: most commonly when a
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
      // "139900946". Defensive parse: a decimal-string here used
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

/** Subtle accent-colored text button: used for "Use my address"
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
