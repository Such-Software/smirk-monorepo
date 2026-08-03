/**
 * Smirk popup — the action-popup wallet UI entry point.
 *
 * The single largest file in the repo. It's structured top-down,
 * roughly: imports → module-level singletons → `App` component →
 * routed sub-screens (Home, Send, Receive, Tip, Asset Detail, Inbox,
 * Settings) → onboarding / lock-screen renderers. Splitting it into
 * per-screen files is a pending refactor.
 *
 * **Where to look:**
 *
 * | Concern                                | Search for                       |
 * |----------------------------------------|----------------------------------|
 * | Asset icon registry                    | `ICON_BY_KEY`                    |
 * | Wallet keystore + storage              | `walletKeystore`                 |
 * | Session cache (auto-lock, bootstrap)   | `SESSION_CACHE_KEY`              |
 * | App component + routing                | `function App()`                 |
 * | Onboarding flow                        | `walletState.kind === 'empty'`   |
 * | Lock screen                            | `walletState.kind === 'locked'`  |
 * | Home tab + per-asset rows              | `<HomeTab`                       |
 * | Send / Receive routes                  | `home/send`, `home/receive`      |
 * | Tip creation                           | `home/tip`                       |
 * | Inbox (claimable tips)                 | `tab === 'inbox'`                |
 * | Swap tab                               | `tab === 'swap'`                 |
 * | Settings tab                           | `tab === 'settings'`             |
 * | Dapp approval (separate window mode)   | `runMode === 'approval'`         |
 */

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  LEGACY_WALLET_KEY,
  SESSION_CACHE_KEY,
  api,
  fetchAllBalances,
  mergeBalancesKeepLastKnown,
  visibleAssetIds,
  withAssetVisibility,
  fetchPrices,
  generateMnemonicPhrase,
  isValidMnemonic,
  totalFiat,
  pendingOutgoingTotalWithFee,
  inFlightInputsTotal,
  expectedLockedChange,
  isPendingOutgoingStale,
  recentlySpentInputs,
  reconcilePendingOutgoing,
  chainProviders,
  btcLtcFreshAddrsEnabled,
  UtxoAddressBook,
  buildUtxoScanRefs,
  recordUtxoActivity,
  type UtxoAddressRef,
  fallbackFeeTiers,
  deriveNostrIdentity,
  buildSlatepackChannels,
  readAllInbound,
  isGoblinPayUri,
  parseGoblinPayUri,
  encodeNpub,
  shortNpub,
  type InboundSlatepack,
  detectLegacyWallet,
  migrateLegacyWallet,
  type Balances,
  type BootstrapAuthResult,
  type Prices,
  type UnlockedWallet,
  type WalletState,
  writeBackendConfig,
  applyBackendConfig,
  planRegistration,
  computeSeedFingerprint,
  deriveAllKeys,
  type WalletApiStyle,
  // Capabilities: memoized session cache + opt-in feature gates. Everything is
  // opt-in — a minimal backend may advertise no prices/tips/grin/feed, so we
  // gate reads + hide surfaces instead of firing calls that 404.
  loadCapabilities,
  initSmirkMessaging,
  invalidateCapabilities,
  capAllowsPrices,
  capHasTips,
  capAllowsGrin,
  capHasFeed,
  type BackendCapabilities,
} from '@smirk/core';
import { PAYMENT_PENDING_SENTINEL } from '../background/jobs/types';
import { setPendingRegistrationInvoice } from './pending-registration-invoice';
import { formatUsd, parseAmount, bytesToHex, hexToBytes } from './format';
import {
  validateSendRecipient,
  recipientNpubToHex,
  isNip05Name,
  resolveAddressForAsset,
  primaryAddressForAsset,
} from './address';
import {
  issueNewReceiveAddress,
  subaddressReceiveEnabled,
} from './receive-subaddress-index';
import { encodeNostrRelayRef } from './relay-ref';
import { respondToInboxItem } from './inbox-actions';
import {
  getActiveNostrIdentity,
  getActiveNostrIdentityFromWallet,
  clearCachedActiveNostrKey,
} from './nostr-vault';
import { HeaderIdentitySwitcher } from './identity-switcher';
import { nip05Resolver, instanceHomeDomain } from './nip05';
import { storage, store, router, walletKeystore, sessionStorage } from './singletons';
import { readBalanceSnapshot, writeBalanceSnapshot, clearBalanceSnapshot } from './balance-snapshot';
import { bootBackendSelection, DEFAULT_BACKEND } from '../backend-boot';
import {
  AppShell,
  ClaimableTipsBanner,
  ReadyToShareTipsBanner,
  GrinPasteIncomingWizard,
  GrinPayInvoiceWizard,
  GrinRequestWizard,
  HomeTab,
  LockScreen,
  MigrationWizard,
  OnboardingWizard,
  ReceiveScreen,
  SendWizard,
  StateProvider,
  TipMaker,
  applyTheme,
  defaultTheme,
  getTheme,
  useRoute,
  useSessionState,
  type ExistingIdentity,
  type ExistingSocial,
  type InboxItem,
  type InboxTipItem,
  type OnboardingRegistration,
  type RecentRecipient,
} from '@smirk/ui';
import { listAssets } from '@smirk/assets';
import { send } from './send-handler';
import { bootstrapAuthInExtension } from './jobs/bootstrap-in-extension';
import {
  startGrinSend,
  processGrinS2,
  cancelGrinSend,
  startGrinInvoice,
  signGrinInvoice,
  processGrinI2,
  signIncomingGrinSlate,
  inspectSlatepack,
  canonicalGrinSlatepackAddress,
  calcGrinFee,
  makeGrinResolver,
  resolveGrinSpendable,
  grinRewindHashFromMnemonic,
  grinOverlay,
} from './grin-flows';
import { dispatchSocialTip } from './tip-handler';
import {
  claimSocialTip,
  claimPublicTip,
  parseShareUrl,
} from './tip-claim-handler';
import {
  writeDappPublicCache,
  clearDappPublicCache,
} from '../background/dapp/provider';
import { setInjectDisabled } from '../background/dapp/inject-policy';
import {
  monero as wasmMonero,
  grin as wasmGrin,
} from '@smirk/wasm';
// --- extracted popup modules (see routes/ + shared modules) ---
import type { WalletSession } from './types';
import { resolveIcon } from './icons';
import { isTipStale } from './tip-inbox';
import { dappPublicCacheFor } from './dapp-public-cache';
import { tryRestoreSessionCache, writeSessionCache, convergeLegacySweep } from './session-cache';
import { readBootstrapCache, writeBootstrapCache, clearBootstrapCache } from './bootstrap-cache';
import { browserController } from './browser-controller';
import { probeBackend } from './routes/backend';
import { FeedRoute } from './routes/feed';
import { SettingsRouter } from './routes/settings';
import { ensureWasmInit } from './wasm-init';
import { ApprovalApp } from './routes/approval';
import { AssetDetailRoute } from './routes/asset-detail';
import { SwapRouter } from './routes/swap';
import { InboxRouter, InboxPasteRouter, PasteTipLinkScreen } from './routes/inbox';
import { linkPrimaryNostrIdentity } from './nostr-link';
import { RefreshIconButton, ScanProgressBanner } from './routes/misc';
import { BootstrappingPlaceholder, BootstrapErrorScreen } from './routes/bootstrap-screens';
import { BrowseTab } from './routes/browse';


/** Wizard slots that hold a Grin slate ceremony in flight. Each one
 *  persists across popup-close; left untouched forever they'd leak
 *  state for slates the backend already dropped. */
const GRIN_WIZARD_IDS = ['send', 'grin-request', 'grin-paste-incoming'] as const;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop Grin wizard slots whose `startedAt` is more than 7 days old.
 * Matches the backend relay's row TTL — once `grin_slatepacks.expires_at`
 * fires server-side, the local wizard has no counterparty left to
 * resume against. Runs once on popup mount; visual age indicators on
 * Inbox rows (1h "Stale", 24h "Expiring") are independent and never
 * drop anything.
 */
async function sweepStaleGrinWizards(): Promise<void> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  await store.update((s) => {
    for (const id of GRIN_WIZARD_IDS) {
      const w = s.wizards[id];
      if (w && w.startedAt < cutoff) {
        delete s.wizards[id];
      }
    }
  });
}

/**
 * Recent tip recipients for TipMaker's chip row. Always empty: there is no
 * per-session sent-tips cache to read from, and TipMaker renders without the
 * "Recent" row.
 */
function recentTipRecipients(
  session: WalletSession | null,
): RecentRecipient[] {
  void session;
  return [];
}

/**
 * Pull incoming social tips for the current user. Bucketed and
 * passed straight to InboxTab as `tips`.
 *
 * Backend `getReceivedTips` returns the full history (any status);
 * we filter to ones that are still actionable for the recipient —
 * status='pending' (funding-waiting OR ready-to-claim, distinguished
 * inside the component by `fundingConfirmations >= confirmationsRequired`).
 *
 * Anything in 'claimed' / 'cancelled' / 'clawed_back' is already
 * settled and doesn't belong in the Inbox.
 */
async function fetchTipInbox(): Promise<{
  tips: InboxTipItem[];
  error: string | null;
}> {
  // `getReceivedSocialTips` is the social-tip flow (named recipient
  // tips with two-phase create); `getReceivedTips` on the same client
  // is the legacy LINK-tip flow and is shaped completely differently.
  // See api/index.ts for the disambiguation.
  const r = await api.getReceivedSocialTips();
  if (r.error || !r.data) {
    return { tips: [], error: r.error ?? 'Failed to load received tips' };
  }
  const tips: InboxTipItem[] = r.data.tips
    // `claiming` status = the user already hit Claim once but the
    // sweep failed client-side (LWS 500, wallet locked, etc.). The
    // backend's `claim_social_tip` is idempotent for the same user,
    // so re-rendering the row + letting them tap Claim again is the
    // recovery path. Without this filter widening, stuck-claiming
    // tips disappear from the Inbox forever and the on-chain funds
    // become invisible to the recipient.
    .filter(
      (t) =>
        t.status === 'pending' ||
        t.status === 'pending_confirmation' ||
        t.status === 'claiming',
    )
    // Finding 12 in the v0.3.0 pre-ship audit: hide stale public
    // tips in `claiming` state. Public-tip `encrypted_key` is
    // sealed with the URL fragment, not the recipient's BTC
    // pubkey, so the Inbox `Claim` path (which uses recipient-key
    // ECIES) can't decrypt it — every retry surfaces "Decryption
    // failed: bad point: got length 33". Active claims (≤ 2 min
    // old by `claimed_at`, which `mark_tip_claiming` stamps on
    // every attempt including retries) stay visible so the user
    // sees "Claiming…" during the legitimate 5–10s WASM sweep
    // window for XMR/WOW; anything older is orphaned by a failed
    // dapp-claim attempt and the only recovery is re-pasting the
    // URL via `+ Paste tip link`. Targeted tips
    // (`is_public === false`) ignore this filter because their
    // `encrypted_key` IS sealed with the recipient's BTC pubkey —
    // the Inbox path handles them natively.
    .filter((t) => {
      if (!t.is_public) return true;
      if (t.status !== 'claiming') return true;
      const claimedAt = t.claimed_at ? Date.parse(t.claimed_at) : NaN;
      if (!Number.isFinite(claimedAt)) return false;
      const STALE_CLAIMING_MS = 2 * 60_000;
      return Date.now() - claimedAt < STALE_CLAIMING_MS;
    })
    // Stale-tip filter: hide pending tips that are still at zero
    // confirmations more than 24h after creation. Every supported
    // chain produces a first confirmation well inside an hour under
    // normal mempool conditions (BTC ~10m, LTC ~2.5m, XMR/WOW ~2m,
    // Grin ~1m), so a 24h zero-conf row is the sender's funding tx
    // having died in the mempool — the tip will never be claimable.
    // We hide rather than rendering "0/X stale" rows to keep the
    // Inbox actionable.
    //
    // TODO(backend): add a server-side autocancel job that moves
    // these from `pending` to a terminal `expired` status after
    // ~48h with no funding progress, so the server-of-truth matches
    // the client view. Until then, the row still exists in the
    // database — hidden but not deleted.
    .filter((t) => !isTipStale(t.funding_confirmations ?? 0, t.created_at))
    .map((t) => {
      // Render sender attribution only when the sender (a) opted in
      // (sender_anonymous=false) AND (b) actually has a Smirk @handle
      // reserved. Either condition false ⇒ "from anonymous". Matches
      // the per-asset history copy in `loadAssetTipRows` so the two
      // surfaces never disagree.
      const senderDisplay: string | null =
        !t.sender_anonymous && t.sender_username
          ? `@${t.sender_username}`
          : null;
      return {
        tipId: t.id,
        assetId: t.asset as InboxTipItem['assetId'],
        amountAtomic: BigInt(t.amount),
        senderDisplay,
        fundingConfirmations: t.funding_confirmations ?? 0,
        confirmationsRequired: t.confirmations_required ?? 1,
        createdAt: t.created_at,
      };
    });
  return { tips, error: null };
}


/** Map a transport-normalized inbound slatepack to the shell's InboxItem
 *  (seconds → ISO; stage → the shell's two-bucket kind). */
function inboundToInboxItem(s: InboundSlatepack): InboxItem {
  const iso = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : '');
  return {
    kind: s.stage === 'to-sign' ? 'pending_to_sign' : 'pending_to_finalize',
    // Backend items carry the bare slate_id; Nostr items pack slate_id +
    // counterparty pubkey so respond/cancel can gift-wrap back to the sender.
    relayId: s.channel === 'nostr' ? encodeNostrRelayRef(s.slateId, s.counterpartyRef) : s.id,
    slateId: s.slateId,
    // Display: a Nostr counterparty is a pubkey — show a short npub, not raw hex.
    // (Routing to them lives in relayId, so this field is display-only.)
    counterpartyUserId:
      s.channel === 'nostr'
        ? shortNpub(encodeNpub(hexToBytes(s.counterpartyRef)))
        : s.counterpartyRef,
    amountAtomic: BigInt(s.amountNanogrin),
    slatepack: s.slatepack,
    createdAt: iso(s.createdAt),
    expiresAt: iso(s.expiresAt),
  };
}

/**
 * Load the Grin inbox. With the unlocked `identity`, merge BOTH transports (the
 * backend relay + the Nostr gift-wrap inbox) via {@link readAllInbound} so a
 * payment sent over Nostr — including from a Goblin wallet — shows up here.
 * Without it (locked / no seed), fall back to the backend-only path so the inbox
 * still works pre-identity.
 */
async function fetchGrinInbox(
  userId: string,
  wallet?: UnlockedWallet | null,
): Promise<{ items: InboxItem[]; loading: boolean; error: string | null }> {
  if (wallet) {
    try {
      // The ACTIVE identity drives the inbox — a burner/imported identity sees
      // gift-wraps addressed to IT, not always account 0. Works on a warm resume
      // (no mnemonic) for the default identity via the cached account-0 key.
      const resolved = await getActiveNostrIdentityFromWallet(wallet);
      if (resolved.identity) {
        const channels = buildSlatepackChannels({ grin: api, userId, identity: resolved.identity });
        const inbound = await readAllInbound(channels);
        return { items: inbound.map(inboundToInboxItem), loading: false, error: null };
      }
    } catch (e) {
      // Fall through to the backend-only path on any channel-construction error.
      void e;
    }
  }
  const r = await api.getGrinPendingSlatepacks(userId);
  if (r.error || !r.data) {
    return { items: [], loading: false, error: r.error ?? 'Failed to load inbox' };
  }
  const items: InboxItem[] = [
    ...r.data.pending_to_sign.map((e) => ({
      kind: 'pending_to_sign' as const,
      relayId: e.id,
      slateId: e.slate_id,
      counterpartyUserId: e.sender_user_id,
      amountAtomic: BigInt(e.amount),
      slatepack: e.slatepack,
      createdAt: e.created_at,
      expiresAt: e.expires_at,
    })),
    ...r.data.pending_to_finalize.map((e) => ({
      kind: 'pending_to_finalize' as const,
      relayId: e.id,
      slateId: e.slate_id,
      counterpartyUserId: e.sender_user_id,
      amountAtomic: BigInt(e.amount),
      slatepack: e.slatepack,
      createdAt: e.created_at,
      expiresAt: e.expires_at,
    })),
  ];
  return { items, loading: false, error: null };
}

// The client-only Grin pending overlay (v3 is non-custodial — no server output
// store) is the shared `grinOverlay` singleton exported from ./grin-flows, so
// this popup, the tip/claim handler, and the inbox actions all mutate ONE
// instance over the single chrome.storage slot. Imported above.

/**
 * Compute the wallet's Grin `rewind_hash` (view-only scan credential) for
 * fetchAllBalances. Requires wasm + mnemonic; returns undefined when either is
 * unavailable (locked wallet), in which case the Grin balance is returned zeroed
 * with no round-trip rather than throwing.
 */
async function computeGrinRewindHash(wallet: UnlockedWallet): Promise<string | undefined> {
  if (!wallet.mnemonic) return undefined;
  try {
    await ensureWasmInit();
    return grinRewindHashFromMnemonic(wallet.mnemonic);
  } catch {
    return undefined;
  }
}

/**
 * BTC/LTC multi-address scan context for a balance fetch: the `(address, path)`
 * refs to read, plus the callback that folds observed activity back into the
 * address book.
 *
 * Returns `null` whenever `ENABLE_BTCLTC_FRESH_ADDRS` is off (the default) or
 * the session predates account xpubs. The balance path then reads the single
 * primary address, exactly as it does today.
 *
 * Supplying the refs here is what keeps the BALANCE and the SEND path agreeing:
 * `send-handler` already spends across the whole book, so a balance read of the
 * primary address alone would show less money than the wallet can actually
 * spend. Reporting activity back is what makes both gap windows slide, so a
 * restored wallet discovers its change chain instead of leaving those outputs
 * out of every scan set.
 */
async function buildUtxoScanContext(wallet: UnlockedWallet): Promise<{
  refs: { btc?: UtxoAddressRef[]; ltc?: UtxoAddressRef[] };
  onUtxoActivity: (asset: 'btc' | 'ltc', active: string[]) => Promise<void>;
} | null> {
  if (!btcLtcFreshAddrsEnabled()) return null;
  const refs: { btc?: UtxoAddressRef[]; ltc?: UtxoAddressRef[] } = {};
  const books = new Map<'btc' | 'ltc', UtxoAddressBook>();
  for (const asset of ['btc', 'ltc'] as const) {
    const xpub = (wallet.keys as unknown as Record<string, { accountXpub?: string }>)[asset]
      ?.accountXpub;
    if (typeof xpub !== 'string') continue;
    const book = new UtxoAddressBook(storage, wallet.fingerprint, asset);
    books.set(asset, book);
    refs[asset] = await buildUtxoScanRefs(book, asset, xpub);
  }
  if (!refs.btc && !refs.ltc) return null;
  return {
    refs,
    onUtxoActivity: async (asset, active) => {
      const book = books.get(asset);
      const set = refs[asset];
      if (!book || !set) return;
      await recordUtxoActivity(book, set, active);
    },
  };
}

/**
 * Recompute a spent-output's key image with the wallet's spend key, so the
 * balance path can tell a real spend from a ring decoy.
 *
 * `subaddrMajor` / `subaddrMinor` are the index the output was RECEIVED at, as
 * reported on the spend record. Both omitted (or `(0, 0)`) is the primary
 * address and produces the exact pre-subaddress call. For a subaddress output
 * both MUST reach wasm: the subaddress secret is folded into the key offset, so
 * computing it against the primary index yields a key image that never matches
 * the reported one, the spend reads as a decoy, and its amount is never
 * subtracted, so the wallet shows money it has already spent, forever, and
 * later sends fail for insufficient funds while the UI insists otherwise.
 *
 * A half-supplied index is an error inside wasm, not a quiet fall back to the
 * primary address, so a plumbing mistake surfaces as a failure rather than as a
 * wrong balance.
 */
const verifyKeyImage = async ({
  privateViewKeyHex,
  privateSpendKeyHex,
  txPubKeyHex,
  outputIndex,
  subaddrMajor,
  subaddrMinor,
}: {
  privateViewKeyHex: string;
  privateSpendKeyHex: string;
  txPubKeyHex: string;
  outputIndex: number;
  subaddrMajor?: number;
  subaddrMinor?: number;
}): Promise<string> => {
  await ensureWasmInit();
  const resultJson = wasmMonero.computeKeyImage(
    privateViewKeyHex,
    privateSpendKeyHex,
    txPubKeyHex,
    outputIndex,
    subaddrMajor,
    subaddrMinor,
  );
  const result = JSON.parse(resultJson) as { success: boolean; data?: string; error?: string };
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'compute_key_image failed');
  }
  return result.data;
};




function openPopOut() {
  const popoutUrl = chrome.runtime.getURL('popup.html');
  void chrome.windows.create({
    url: popoutUrl,
    type: 'popup',
    width: 480,
    height: 720,
  });
  window.close();
}



/** How long balances may stay stale before we warn the user in-app. */
const BALANCE_STALE_WARN_MS = 15 * 60 * 1000;
// chrome.storage.local flag: the user declined linking their Nostr identity to
// their handle, so don't re-prompt on every unlock (Settings still offers Link).
const NOSTR_LINK_DECLINED_KEY = 'smirk:nostrLinkDeclined';

/** Steady-state background balance refresh cadence while the popup is open AND
 *  visible. Keeps the number live without hammering (XMR/WOW chains advance
 *  ~every 2 min); also gives the freshness cue real successes/failures to track.
 *  Suppressed while a chain is mid-scan (the 8s scan poll covers that window). */
const BACKGROUND_REFRESH_MS = 25_000;

/** Debounce for the focus/visibility refresh: skip it if we already refreshed
 *  within this window, so a rapid close/reopen (or an OS focus flurry) doesn't
 *  stack redundant fetches on top of the periodic loop. */
const FOCUS_REFRESH_MIN_GAP_MS = 5_000;

/** Compute the next `balancesStaleSince` given the merged balances + the prior
 *  value: start the clock when any asset is stale, clear it when none are. */
function nextStaleSince(balances: Balances | null, prior: number | null): number | null {
  const anyStale = !!balances && Object.values(balances).some((b) => b?.stale);
  if (!anyStale) return null;
  return prior ?? Date.now();
}

/** True when a refresh got NO fresh data: every asset we actually attempted came
 *  back with an `error` (i.e. the backend/chains were unreachable). Drives the
 *  freshness cue's "updates are failing" signal — a whole-cloth failure, not a
 *  single flaky chain (one erroring asset among successes returns false, so a
 *  transient blip never trips the escalating warning). Assets skipped for
 *  visibility/derivation return zeroed with no error and are ignored here. */
function allAttemptedBalancesFailed(
  balances: Balances,
  visibleIds: ReadonlyArray<string>,
): boolean {
  const attempted = visibleIds
    .map((id) => balances[id as keyof Balances])
    .filter((b): b is Balances[keyof Balances] => !!b);
  if (attempted.length === 0) return false;
  return attempted.every((b) => !!b.error);
}



// The balance snapshot cache lives in `./balance-snapshot.ts`. BigInt fields
// are stringified at the storage boundary because some builds (Brave) silently
// stringify BigInt in chrome.storage.session: a revived string mixed with a
// freshly-fetched BigInt throws "Cannot mix BigInt and other types" deep in the
// fiat-aggregation and comparison paths (`b.pending > 0n`).

function App() {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  // True when a legacy v0.2 walletState exists but no v0.3 keystore yet — the
  // MigrationWizard shows instead of onboarding. Resolved in refresh().
  const [needsMigration, setNeedsMigration] = useState(false);
  const [session, setSession] = useState<WalletSession | null>(null);
  // Live ref to walletState so async closures (notably the BrowseTab
  // dapp-approval handler) can read the latest unlock status at the
  // moment they need it, without re-creating the effect on every
  // walletState change.
  const walletStateRef = useRef<WalletState | null>(walletState);
  walletStateRef.current = walletState;
  // Backend-derived identity that survives an import — Smirk handle
  // and/or linked third-party socials (Telegram, Discord, future
  // platforms). Set inside the onboarding `onComplete` callback after
  // bootstrap so the setup wizard can swap the reserve-handle prompt
  // for a "Welcome back" summary. `null` means "no identity to surface
  // yet" (the default on a fresh-create flow).
  const [existingIdentity, setExistingIdentity] = useState<ExistingIdentity | null>(null);
  // The active backend's registration policy, fetched from /capabilities for the
  // onboarding gate router (free / invite / payment / choose / sequential). Null
  // until fetched or when not onboarding; the wizard treats absent as `free`.
  const [regPlan, setRegPlan] = useState<OnboardingRegistration | null>(null);
  // Whether the capabilities read that produces `regPlan` has actually resolved.
  // The wizard fails closed while this is false rather than defaulting to the
  // free path on a gated backend.
  const [regResolved, setRegResolved] = useState(false);
  // True once the user has pressed Create or Import. Gates the /capabilities
  // read so a cold launch touches no network. See `onBegin` on OnboardingWizard.
  const [onboardingBegun, setOnboardingBegun] = useState(false);
  // Username pending a Nostr-identity link with the user's CONSENT (never auto).
  // Set when an unlocked account has a handle but no linked npub; a top banner asks
  // before publishing the username->npub mapping. Null = no prompt.
  const [nostrLinkPrompt, setNostrLinkPrompt] = useState<string | null>(null);
  // The account's Smirk handle (`name@domain`) for surfacing it as the primary
  // identity (Receive screen). Fetched independently of the seed so it survives a
  // warm resume; null until a username is claimed.
  const [smirkHandle, setSmirkHandle] = useState<string | null>(null);
  // Shared state for the interactive pay-to-register flow: the wallet created at
  // `payment.begin` and the invoice minted for it, read back by `payment.poll`.
  const paymentWalletRef = useRef<UnlockedWallet | null>(null);
  const paymentInvoiceRef = useRef<string | null>(null);
  // The minted invoice's display details, cached so a PaymentStep REMOUNT (back
  // then forward) reuses the same invoice instead of minting a second one and
  // stranding the first — a double-charge risk.
  const paymentInvoiceDetailsRef = useRef<
    { payTo: string; amount: string; currency: string } | null
  >(null);
  // Fetch the active backend's registration policy while onboarding, so the
  // wizard can route the gate (invite / payment / choose). Absent => `free`.
  useEffect(() => {
    if (walletState?.kind !== 'empty' || needsMigration) return;
    // PRIVACY: wait for the user to actually start onboarding. Opening the popup
    // is not consent, and an unprompted request still tells an observer that
    // someone just installed a privacy wallet, even when the endpoint is ours.
    // Deferring to the first real action is what keeps a cold launch at zero
    // network contact (see the `first-launch-exposure` spec).
    //
    // Fail-closed is unaffected: the wizard still blocks on `regResolved` before
    // committing a keystore, so a gated backend cannot be bypassed. Only the
    // START of the read moved, not the gate.
    if (!onboardingBegun) return;
    let stale = false;
    setRegResolved(false);
    const load = async () => {
      // Retry a transient capabilities failure rather than falling through to the
      // free path: an unresolved read must leave `regResolved` false so the wizard
      // fails closed instead of committing a keystore we can't register on a
      // gated backend. A non-2xx (r.error) is a failed attempt, not "open".
      for (let attempt = 0; attempt < 4 && !stale; attempt++) {
        try {
          const r = await api.getCapabilities();
          if (stale) return;
          if (!r.error && r.data) {
            const plan = planRegistration(r.data.registration);
            setRegPlan({
              kind: plan.kind,
              methods: plan.methods,
              ...(plan.price ? { price: plan.price } : {}),
            });
            setRegResolved(true);
            return;
          }
        } catch {
          /* network failure — retry below */
        }
        if (attempt < 3) {
          await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        }
      }
      // Persistent failure: regResolved stays false, so the wizard blocks the
      // password step with a retry instead of defaulting to free.
    };
    void load();
    return () => {
      stale = true;
    };
  }, [walletState?.kind, needsMigration, onboardingBegun]);

  // Shared post-register onboarding wiring: warm the bootstrap cache and surface
  // any identity this wallet already owns. Used by both the free/invite
  // `onComplete` and the pay-to-register poll's success path.
  const finishOnboardRegister = async (
    wallet: UnlockedWallet,
    onboardBootstrap: Awaited<ReturnType<typeof bootstrapAuthInExtension>>,
  ) => {
    const token = api.getAccessToken();
    if (token) {
      await writeBootstrapCache(wallet.fingerprint, token, onboardBootstrap);
    }
    try {
      const [nameRes, socialsRes] = await Promise.all([
        api.getMySmirkUsername(),
        api.getMyLinkedSocials(),
      ]);
      const smirkName =
        !nameRes.error && typeof nameRes.data === 'string' && nameRes.data.length > 0
          ? nameRes.data
          : undefined;
      const linkedSocials: ExistingSocial[] =
        !socialsRes.error && socialsRes.data
          ? socialsRes.data.socials
              .slice()
              .sort((a, b) => Number(b.verified) - Number(a.verified))
              .map((s) => ({
                platform: s.platform,
                username: s.username ?? s.display_name ?? s.platform_user_id ?? '',
                verified: s.verified,
              }))
              .filter((s) => s.username.length > 0)
          : [];
      if (smirkName || linkedSocials.length > 0) {
        setExistingIdentity({
          ...(smirkName ? { smirkName } : {}),
          linkedSocials,
        });
      }
    } catch (e) {
      console.warn('[smirk] identity lookup failed during onboarding', e);
    }
  };

  const [grinInbox, setGrinInbox] = useState<{
    items: InboxItem[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: false, error: null });
  const [tipInbox, setTipInbox] = useState<{
    tips: InboxTipItem[];
    error: string | null;
  }>({ tips: [], error: null });

  // This backend's capabilities (memoized in core). Drives all opt-in gating:
  // fiat/tips/grin/feed surfaces hide, and their calls stop firing, when the
  // instance doesn't advertise them. Null until loaded / on a caps-less backend
  // (gates read null as permissive, preserving legacy behavior).
  const [caps, setCaps] = useState<BackendCapabilities | null>(null);
  useEffect(() => {
    if (walletState?.kind !== 'unlocked') return undefined;
    let cancelled = false;
    void loadCapabilities(api).then((c) => {
      if (cancelled) return;
      setCaps(c);
      // Reflect feed availability into the nav (BottomNav reads this flag).
      (globalThis as { __smirk_feed__?: boolean }).__smirk_feed__ = capHasFeed(c);
      // Configure the relay set for EVERY surface, not just Messages.
      // `messagingRelays()` used to fall back to hardcoded third-party relays
      // when nothing had configured it, so the Grin Nostr payment path (which
      // never called this) published gift-wraps to damus/nos.lol on an instance
      // whose operator may run neither. The fallback is gone, so this init is
      // now load-bearing: without it those paths correctly have no relay.
      initSmirkMessaging({
        ...(c?.messaging?.relay_url ? { relayUrl: c.messaging.relay_url } : {}),
        publicRelays: [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [walletState?.kind, session?.bootstrap?.userId]);

  // Refresh from the keystore. Called on mount and after every state
  // transition (create / unlock / lock / destroy) so the gate re-renders.
  // Also opportunistically restores a non-expired session cache.
  const refresh = async () => {
    await tryRestoreSessionCache();
    const ks = await walletKeystore.getState();
    setWalletState(ks);
    // Legacy-wallet detection only matters while there's no v0.3 keystore.
    setNeedsMigration(
      ks.kind === 'empty' ? await detectLegacyWallet(storage) : false,
    );
  };

  /**
   * Auth + initial balance fetch + price fetch. Called when the wallet
   * transitions to `unlocked` (either fresh creation or unlock).
   * Balances and prices fire in parallel after auth completes.
   */
  const startSession = async (wallet: UnlockedWallet) => {
    // Hydrate from the balance snapshot BEFORE awaiting anything so
    // the user sees their last-known numbers within a paint. The
    // refresh path below replaces these with fresh values when the
    // network roundtrip resolves. `refreshing: true` makes the
    // header spinner spin so users know the numbers are being
    // re-fetched. Bootstrap-less placeholder so the existing render
    // path doesn't blow up; the real bootstrap lands in the try below.
    const snap = await readBalanceSnapshot(wallet.fingerprint, api.getBaseUrl());
    if (snap) {
      setSession({
        bootstrap: { userId: '', isNew: false },
        balances: snap.balances,
        prices: snap.prices,
        error: null,
        refreshing: true,
        refreshedAt: new Date(snap.cachedAt),
        // The snapshot was written on a past success, so anchor the freshness
        // clock to it and open with no failure: the imminent refresh escalates
        // only if it actually fails.
        lastSuccessAt: snap.cachedAt,
        lastRefreshFailed: false,
      });
    } else {
      // No snapshot (first unlock ever, or chrome.storage.session was wiped by an
      // extension reload / browser restart). Open in the refreshing state so the
      // headline shows the loading glyph "…" rather than a blank "—" that reads as
      // broken while the first fetch runs.
      setSession((prev) => prev ?? ({ refreshing: true } as WalletSession));
    }
    try {
      // Prices are unauthenticated — kick them off in parallel with
      // auth so they don't sit behind the bootstrap round-trip on
      // cold start. Saves ~500ms on every fresh popup.
      const pricesPromise = fetchPrices(api).catch(
        () => null as Prices | null,
      );
      // Seed prices into the session the moment they resolve, decoupled from the
      // balance fetch below. `fetchAllBalances` is bound to the SLOWEST chain
      // (e.g. a firewalled-Fulcrum LTC can take ~10s), but prices land in ~500ms.
      // Committing them early lets the USD total render from the balances already
      // streamed in via onAssetBalance, instead of blanking to "…" (the
      // totalDisplay gate needs both balances AND prices) until the whole
      // Promise.all clears. Guarded on prev so we never resurrect a torn-down
      // session; the final setSession below still commits the authoritative view.
      void pricesPromise.then((p) => {
        if (!p) return;
        setSession((prev) => (prev ? { ...prev, prices: p } : prev));
      });

      // Try the warm path first: if we have a cached bootstrap from
      // a recent popup open this browser session, reuse it and skip
      // the auth round-trip (challenge + signature + extensionRegister
      // = ~1-2s on a slow backend). Falls back to a full bootstrap if
      // the cached token gets rejected by the first balance call, so
      // a server-side rotation can't strand us.
      let bootstrap: BootstrapAuthResult;
      const warm = await readBootstrapCache(wallet.fingerprint);
      if (warm) {
        api.setAccessToken(warm.accessToken);
        bootstrap = warm.bootstrap;
      } else {
        // Full bootstrap runs in the background SW so popup-close
        // doesn't strand a half-finished registration. See
        // packages/extension/src/background/jobs/handlers/bootstrap-auth.ts
        // for the handler; the popup-side wrapper handles dedup +
        // reuse of recently-completed jobs from a prior popup mount.
        bootstrap = await bootstrapAuthInExtension(api, wallet);
        const tok = api.getAccessToken();
        if (tok) {
          await writeBootstrapCache(wallet.fingerprint, tok, bootstrap);
        }
      }
      // Progressive render: as each per-asset balance resolves, patch
      // it into session.balances immediately. UI updates one row at a
      // time, so BTC/LTC/Grin landing in 1-2s don't wait for an
      // LWS-scan-catching-up XMR balance that might take much longer.
      const visible = visibleAssetIds(await store.load(), listAssets()).map(
        (a) => a.id,
      );
      const grinRewindHash = await computeGrinRewindHash(wallet);
      // BTC/LTC scan set + gap discovery. `null` (and therefore no extra keys
      // at all) whenever ENABLE_BTCLTC_FRESH_ADDRS is off, which is the default.
      const utxoScan = await buildUtxoScanContext(wallet);
      const balances = await fetchAllBalances(wallet, bootstrap, {
        verifyKeyImage,
        // Only meaningful once the wallet can hold subaddress outputs. With the
        // flag off this is false and the spent-output filter is unchanged.
        strictSpentSubaddrIndex: subaddressReceiveEnabled(),
        ...(utxoScan
          ? { utxoAddressRefs: utxoScan.refs, onUtxoActivity: utxoScan.onUtxoActivity }
          : {}),
        visibleAssetIds: visible,
        backendUrl: api.getBaseUrl(),
        ...(grinRewindHash ? { grinRewindHash } : {}),
        grinPending: grinOverlay,
        onAssetBalance: (assetId, balance) => {
          setSession((prev) => {
            if (!prev) return prev;
            const base = prev.balances ?? {
              btc: { confirmed: 0n, pending: 0n },
              ltc: { confirmed: 0n, pending: 0n },
              xmr: { confirmed: 0n, pending: 0n },
              wow: { confirmed: 0n, pending: 0n },
              grin: { confirmed: 0n, pending: 0n },
            };
            // Keep the last-known value (flagged stale) if this fetch errored and
            // we already had a good number — don't flash the row to 0.
            const prior = base[assetId];
            const next =
              balance.error && prior && !prior.error
                ? { ...prior, stale: true }
                : balance;
            return { ...prev, balances: { ...base, [assetId]: next } };
          });
        },
      });
      const prices = await pricesPromise;
      // Merge the fresh fetch over the pre-fetch snapshot so an asset whose fetch
      // errored keeps its last-known number (flagged stale) instead of flashing 0.
      const merged = mergeBalancesKeepLastKnown(snap?.balances ?? null, balances);
      const failed = allAttemptedBalancesFailed(balances, visible);
      setSession((prev) => ({
        bootstrap,
        balances: merged,
        prices,
        error: null,
        refreshing: false,
        refreshedAt: new Date(),
        balancesStaleSince: nextStaleSince(merged, prev?.balancesStaleSince ?? null),
        lastRefreshFailed: failed,
        lastSuccessAt: failed ? (prev?.lastSuccessAt ?? snap?.cachedAt ?? null) : Date.now(),
      }));
      // Persist the merged (last-known) view for instant, non-zero next-open.
      void writeBalanceSnapshot(wallet.fingerprint, api.getBaseUrl(), merged, prices);
    } catch (e) {
      // If a warm-path balance call rejected (auth error), drop the
      // cache and force a fresh bootstrap on the next render. Surface
      // the error so the user sees something rather than a silent
      // empty state.
      await clearBootstrapCache();
      // A resumed pay-to-register whose invoice has not settled yet throws the
      // pending sentinel: show a clear status (not the raw sentinel), and keep
      // the persisted invoice so the next unlock finishes once it confirms.
      const message =
        e instanceof Error && e.message === PAYMENT_PENDING_SENTINEL
          ? 'Your registration payment is still confirming. Reopen Smirk once it clears to finish.'
          : e instanceof Error
            ? e.message
            : 'Failed to connect to backend';
      setSession((prev) => ({
        bootstrap: { userId: '', isNew: false },
        // Keep showing last-known balances (snapshot / prior session) behind the
        // error banner instead of blanking the wallet on a transient auth/network
        // failure. Null only if we truly have nothing cached.
        balances: prev?.balances ?? snap?.balances ?? null,
        prices: prev?.prices ?? snap?.prices ?? null,
        error: message,
        refreshing: false,
        refreshedAt: prev?.refreshedAt ?? null,
        balancesStaleSince: prev?.balancesStaleSince ?? (snap ? Date.now() : null),
        // Bootstrap/network failed outright: mark the attempt failed and hold the
        // last-success anchor (snapshot cachedAt if that's all we have) so the
        // cue escalates on TIME rather than jumping straight to red.
        lastRefreshFailed: true,
        lastSuccessAt: prev?.lastSuccessAt ?? snap?.cachedAt ?? null,
      }));
    }
  };

  /** Refresh balances + prices — assumes a session already exists. */
  const refreshBalances = async (wallet: UnlockedWallet, bootstrap: BootstrapAuthResult) => {
    setSession((prev) => (prev ? { ...prev, refreshing: true } : prev));
    try {
      // Same progressive-render pattern as startSession. Prices are
      // unauth so they fly in parallel; per-asset balances patch the
      // UI as each chain resolves rather than blocking on the
      // slowest one (often XMR catching up its scan).
      const pricesPromise = fetchPrices(api).catch(
        () => null as Prices | null,
      );
      const visible = visibleAssetIds(await store.load(), listAssets()).map(
        (a) => a.id,
      );
      const grinRewindHash = await computeGrinRewindHash(wallet);
      // BTC/LTC scan set + gap discovery. `null` (and therefore no extra keys
      // at all) whenever ENABLE_BTCLTC_FRESH_ADDRS is off, which is the default.
      const utxoScan = await buildUtxoScanContext(wallet);
      const balances = await fetchAllBalances(wallet, bootstrap, {
        verifyKeyImage,
        // Only meaningful once the wallet can hold subaddress outputs. With the
        // flag off this is false and the spent-output filter is unchanged.
        strictSpentSubaddrIndex: subaddressReceiveEnabled(),
        ...(utxoScan
          ? { utxoAddressRefs: utxoScan.refs, onUtxoActivity: utxoScan.onUtxoActivity }
          : {}),
        visibleAssetIds: visible,
        backendUrl: api.getBaseUrl(),
        ...(grinRewindHash ? { grinRewindHash } : {}),
        grinPending: grinOverlay,
        onAssetBalance: (assetId, balance) => {
          setSession((prev) => {
            if (!prev || !prev.balances) return prev;
            const prior = prev.balances[assetId];
            // Keep last-known (stale) on a fetch error; don't flash the row to 0.
            const next =
              balance.error && prior && !prior.error
                ? { ...prior, stale: true }
                : balance;
            return { ...prev, balances: { ...prev.balances, [assetId]: next } };
          });
        },
      });
      const prices = (await pricesPromise) ?? {
        btc: null,
        ltc: null,
        xmr: null,
        wow: null,
        grin: null,
      };
      // Reconcile pendingOutgoing against the freshly-fetched balances
      // before storing. Two-pass:
      //   1. Per-asset, run reconcilePendingOutgoing against the new
      //      verifiedSpentInputs set (XMR/WOW path — primary signal).
      //   2. Drop any remaining entries past their per-asset age-out
      //      (timing backstop; covers BTC/LTC which don't surface
      //      verifiedSpentInputs and any chain where reconciliation
      //      missed for whatever reason).
      // Net effect: a successful XMR/WOW spend drops its
      // pendingOutgoing entry on the next refresh after LWS reflects
      // (~one block + scan tick), instead of waiting for the 5/30 min
      // timeout.
      const now = Date.now();
      await store.update((s) => {
        if (!s.pendingOutgoing || s.pendingOutgoing.length === 0) return;
        let kept = s.pendingOutgoing;
        for (const [assetId, b] of Object.entries(balances) as Array<[
          string,
          { verifiedSpentInputs?: string[] },
        ]>) {
          if (!b.verifiedSpentInputs || b.verifiedSpentInputs.length === 0) continue;
          const verifiedSet = new Set(b.verifiedSpentInputs);
          kept = reconcilePendingOutgoing(kept, assetId, verifiedSet);
        }
        kept = kept.filter((e) => !isPendingOutgoingStale(e, now));
        if (kept.length !== s.pendingOutgoing.length) {
          s.pendingOutgoing = kept;
        }
      });
      let mergedForSnapshot: Balances = balances;
      const failed = allAttemptedBalancesFailed(balances, visible);
      setSession((prev) => {
        const merged = mergeBalancesKeepLastKnown(prev?.balances ?? null, balances);
        mergedForSnapshot = merged;
        return prev
          ? {
              ...prev,
              balances: merged,
              prices,
              error: null,
              refreshing: false,
              refreshedAt: new Date(),
              balancesStaleSince: nextStaleSince(merged, prev.balancesStaleSince ?? null),
              lastRefreshFailed: failed,
              // Advance the success anchor only when fresh data actually landed;
              // a fully-failed refresh keeps the old anchor so the cue escalates.
              lastSuccessAt: failed ? (prev.lastSuccessAt ?? null) : Date.now(),
            }
          : prev;
      });
      void writeBalanceSnapshot(wallet.fingerprint, api.getBaseUrl(), mergedForSnapshot, prices);
    } catch (e) {
      // A whole-refresh failure keeps the last-known balances (already in
      // session) and just surfaces the error + starts the stale clock.
      setSession((prev) =>
        prev
          ? {
              ...prev,
              error: e instanceof Error ? e.message : 'Refresh failed',
              refreshing: false,
              balancesStaleSince: prev.balancesStaleSince ?? Date.now(),
              // Thrown refresh: mark failed, hold the last-success anchor so the
              // freshness cue climbs from warn to error over time, not instantly.
              lastRefreshFailed: true,
            }
          : prev,
      );
    }
  };

  useEffect(() => {
    void refresh();
    // Kick off WASM load in the background. Grin inbox actions (sign /
    // pay / finalize) all call into wasmGrin synchronously — if the
    // user clicks an Inbox row before this resolves they get
    // "Cannot read properties of undefined (reading '__wbindgen_free')"
    // from the wasm-bindgen shim. Each Grin handler also awaits
    // ensureWasmInit() before any wasm call, so this is purely a
    // warmup; correctness is upheld at the call sites.
    void ensureWasmInit();
    // Sweep stale Grin wizard state on mount. 7 days matches the
    // backend relay's row TTL (`expires_at` in `grin_slatepacks`); once
    // the relay drops a row, the local wizard slot it was tracking has
    // no counterparty left to talk to. Shorter visual indicators (1h
    // "Stale", 24h "Expiring") live on each Inbox row but don't drop
    // anything — the user can still cancel/resume manually. Only the
    // 7-day floor wipes local state, in lockstep with the backend.
    void sweepStaleGrinWizards();
  }, []);

  // Re-register the wallet's CANONICAL grin slatepack address
  // (grin-wallet/Grim-compatible derivation, via wasm) once the wallet
  // is unlocked AND wasm is up. The bootstrap registered
  // `wallet.addresses.grin` which comes from @smirk/core's
  // `deriveGrinKey` — a custom SHA256 path that doesn't match what
  // wasm's `slatepack_address_secret` produces, so senders encrypted
  // to one pubkey and receivers decrypted with another. Every
  // Smirk→Smirk encrypted Grin send was failing at age decrypt with
  // "No matching keys found" because of this mismatch.
  //
  // Idempotent on the backend (UPSERT) — runs once per unlocked
  // session as a cheap fixup. Address compatibility for existing
  // pending slatepacks is not preserved; users with rows pending
  // against the LEGACY address must cancel + re-send.
  useEffect(() => {
    if (walletState?.kind !== 'unlocked' || !walletState.wallet.mnemonic) return;
    // Wait until bootstrap auth has set the API token. Firing before
    // that means the register POST goes out unauthenticated, the
    // backend returns 401 with a non-JSON body, the client returns
    // "Unknown error", and the wallets row is never updated to the
    // canonical address — leaving senders encrypting to the legacy
    // address and receivers unable to decrypt. `session.bootstrap.userId`
    // is set BEFORE the token is attached to the request layer (the
    // global token), so gate on the live token instead of just the
    // bootstrap flag.
    if (!session?.bootstrap?.userId) return;
    if (!api.getAccessToken()) return;
    const mnemonic = walletState.wallet.mnemonic;
    void (async () => {
      await ensureWasmInit();
      // Opt-in: skip Grin key registration entirely when the backend advertises
      // no Grin relay (permissive on unknown/legacy caps).
      if (!capAllowsGrin(await loadCapabilities(api))) return;
      try {
        // Register the CANONICAL bech32 slatepack address under the grin key so
        // username→address discovery AND the address→npub/user lookup
        // (find_user_by_grin_address WHERE public_key = addr) match. buildKeysList
        // stored @smirk/core's custom-derived hex at auth — the wrong value — so
        // re-register the canonical address here (idempotent UPSERT).
        //
        // v3 has no seed-only "recovery" step: POST /wallet/grin/scan already IS
        // recovery (rewind_hash rewinds the whole UTXO set), so balance and
        // spendable inputs are recovered on every fetch. No output store to seed.
        const canonical = canonicalGrinSlatepackAddress(mnemonic);
        const res = await api.registerKey('grin', canonical);
        if (res.error && res.status !== 404) {
          console.warn('[smirk-popup] register canonical grin key rejected:', res.error);
        }
      } catch (e) {
        console.warn('[smirk-popup] register canonical grin key threw:', e);
      }
    })();
  }, [walletState, session?.bootstrap?.userId]);

  // Auto-link the PRIMARY (account-0) Nostr identity once the user has claimed a
  // handle but hasn't linked yet — so `<handle>@<domain>` resolves and the verified
  // kind-0 profile publishes without a manual Settings step. This is the "claiming a
  // name should just work on Nostr" path, and it also back-fills existing users who
  // claimed a handle before linking existed. Gated on a fresh unlock (the NIP-98 link
  // must be signed with the seed) + auth; idempotent — a no-op once `nostrPubkey` is
  // set. linkPrimaryNostrIdentity both links and publishes the profile.
  useEffect(() => {
    if (walletState?.kind !== 'unlocked' || !walletState.wallet.mnemonic) return;
    if (!session?.bootstrap?.userId || !api.getAccessToken()) return;
    void (async () => {
      try {
        const me = await api.getMe();
        if (!me.data?.username || me.data.nostrPubkey) return;
        // ASK before linking: publishing the username->npub mapping is public and
        // binds this account's main identity to the handle, so it must be the user's
        // choice, not a silent back-fill on upgrade. Respect a prior "Not now".
        const declined = await chrome.storage.local.get(NOSTR_LINK_DECLINED_KEY);
        if (declined[NOSTR_LINK_DECLINED_KEY]) return;
        setNostrLinkPrompt(me.data.username);
      } catch {
        /* non-fatal — the user can always Link in Settings → Nostr identities */
      }
    })();
  }, [walletState, session?.bootstrap?.userId]);

  // Fetch the claimed handle to surface as the primary identity. Independent of the
  // seed (no mnemonic needed), so it populates on a warm resume too.
  useEffect(() => {
    if (walletState?.kind !== 'unlocked' || !session?.bootstrap?.userId || !api.getAccessToken()) {
      setSmirkHandle(null);
      return;
    }
    let stale = false;
    void api.getMe().then((me) => {
      if (!stale && me.data?.username) setSmirkHandle(`${me.data.username}@${instanceHomeDomain()}`);
    });
    return () => {
      stale = true;
    };
  }, [walletState, session?.bootstrap?.userId]);

  // Consent handlers for the Nostr-link banner.
  const confirmNostrLink = async () => {
    const mnemonic =
      walletState?.kind === 'unlocked' ? walletState.wallet.mnemonic : undefined;
    setNostrLinkPrompt(null);
    if (!mnemonic) return;
    try {
      await linkPrimaryNostrIdentity(mnemonic);
    } catch {
      /* non-fatal — Settings → Nostr identities still offers Link */
    }
  };
  const declineNostrLink = () => {
    setNostrLinkPrompt(null);
    void chrome.storage.local.set({ [NOSTR_LINK_DECLINED_KEY]: true });
  };

  // Apply persisted theme on boot and whenever it changes. Subscribing
  // here (not inside a deep child) means the theme swaps cleanly even
  // when no tab is rendering — e.g. the Settings picker changes the
  // theme while Home is mounted, the picker doesn't have to know
  // about every other tab.
  useEffect(() => {
    const apply = (themeId: string) => {
      applyTheme(getTheme(themeId) ?? defaultTheme);
    };
    void store.load().then((s) => apply(s.ui.theme ?? 'default'));
    return store.subscribe((s) => apply(s.ui.theme ?? 'default'));
  }, []);

  // Grin inbox poller — fetch pending slatepacks every 30 s while the
  // popup is open and the wallet is unlocked. The poll is gated on
  // wallet+session being ready so it never races initial auth.
  // Refresh fires immediately on first ready-state, then on the
  // interval; closing the popup cancels the timer (chrome.alarms picks
  // this up at v0.4 mobile time).
  useEffect(() => {
    if (
      walletState?.kind !== 'unlocked' ||
      !session ||
      session.error ||
      !session.bootstrap?.userId
    ) {
      return undefined;
    }
    // Backend's Grin endpoints key by user UUID — NOT the local seed
    // fingerprint. bootstrap.userId is the only acceptable identifier.
    const userId = session.bootstrap.userId;
    let alive = true;
    const tick = async () => {
      setGrinInbox((s) => ({ ...s, loading: true }));
      // Fetch Grin slatepacks + received tips in parallel — both go
      // to the same Inbox surface so a single 30s tick refreshes
      // everything. Tip poll failure is silent (kept null in state
      // so InboxTab still renders Grin sections normally); slatepack
      // failure surfaces as before.
      //
      // Grin slatepack relay is asset-specific: skip the round-trip
      // entirely when the user has hidden Grin. Tip poll is per-
      // user (not per-asset) so it always runs — incoming tips for
      // any asset, hidden or not, need to surface in the Inbox so
      // the user can claim them.
      const sess = await store.load();
      // Opt-in gating (memoized caps): skip the Grin relay round-trip when the
      // backend runs no Grin relay OR the user hid Grin; skip the tip poll when
      // the backend advertises no social tips. This is the main recurring-404
      // source on a minimal backend.
      const caps = await loadCapabilities(api);
      const grinHidden = (sess.ui.hiddenAssets ?? []).includes('grin');
      const grinOff = grinHidden || !capAllowsGrin(caps);
      const tipsOff = !capHasTips(caps);
      const [nextGrin, nextTips] = await Promise.all([
        grinOff
          ? Promise.resolve({ items: [], loading: false, error: null })
          : fetchGrinInbox(userId, walletState.wallet),
        tipsOff
          ? Promise.resolve({ tips: [], error: null })
          : fetchTipInbox().catch((e) => ({
              tips: [],
              error: e instanceof Error ? e.message : 'Tip fetch failed',
            })),
      ]);
      if (!alive) return;
      setGrinInbox(nextGrin);
      setTipInbox(nextTips);
    };
    void tick();
    const handle = setInterval(() => void tick(), 30000);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [walletState, session?.error, session?.bootstrap?.userId]);

  // Auto-poll while a chain is mid-scan. We don't want a chatty poll
  // for normal idle state (the chain advances every ~2 min for XMR/WOW,
  // not worth hammering for steady-state). Activates only when at
  // least one asset reports an in-flight `scanProgress`, then ticks
  // every 8 s so the progress bar visibly moves.
  useEffect(() => {
    if (
      walletState?.kind !== 'unlocked' ||
      !session ||
      session.refreshing ||
      !session.balances
    ) {
      return undefined;
    }
    const anyScanning = (Object.values(session.balances) as Array<{ scanProgress?: unknown }>).some(
      (b) => b.scanProgress !== undefined,
    );
    if (!anyScanning) return undefined;

    const handle = setInterval(() => {
      void refreshBalances(walletState.wallet, session.bootstrap);
    }, 8000);
    return () => clearInterval(handle);
  }, [walletState, session]);

  // Steady-state background refresh: keep balances live while the popup is open
  // and visible, and give the freshness cue real successes/failures to track.
  // Coordinated with the 8s scan poll above so the two never double-fetch:
  //   - skips entirely while any chain is scanning (the scan poll owns that
  //     window at its faster cadence), and
  //   - the effect early-returns on `session.refreshing`, so no interval exists
  //     while a refresh is already in flight (this and the scan poll both tear
  //     down + rebuild on every `session` change, refreshing included).
  // Deliberately does NOT stop on `session.error`: a persistent outage must keep
  // retrying so the cue escalates and then recovers on its own.
  useEffect(() => {
    if (
      walletState?.kind !== 'unlocked' ||
      !session?.bootstrap?.userId ||
      session.refreshing ||
      !session.balances
    ) {
      return undefined;
    }
    const anyScanning = (Object.values(session.balances) as Array<{ scanProgress?: unknown }>).some(
      (b) => b.scanProgress !== undefined,
    );
    if (anyScanning) return undefined; // the 8s scan poll owns this window

    const handle = setInterval(() => {
      // Don't poll a backgrounded popout — only refresh what the user can see.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshBalances(walletState.wallet, session.bootstrap);
    }, BACKGROUND_REFRESH_MS);
    return () => clearInterval(handle);
  }, [walletState, session]);

  // Refresh on regained focus/visibility: a popup is usually reopened rather
  // than left open, so a possibly-stale number should snap fresh the instant the
  // user looks at it. Debounced against the periodic loop (and reopen flurries)
  // via `FOCUS_REFRESH_MIN_GAP_MS`; skips when a refresh is already in flight so
  // it can't stack on top of the loop.
  useEffect(() => {
    if (walletState?.kind !== 'unlocked' || !session?.bootstrap?.userId || !session.balances) {
      return undefined;
    }
    const wallet = walletState.wallet;
    const bootstrap = session.bootstrap;
    const maybeRefresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (session.refreshing) return;
      const last = session.refreshedAt ? session.refreshedAt.getTime() : 0;
      if (Date.now() - last < FOCUS_REFRESH_MIN_GAP_MS) return;
      void refreshBalances(wallet, bootstrap);
    };
    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, [walletState, session]);

  // Whenever we land in the `unlocked` state without an active session,
  // bootstrap auth + fetch balances. This covers both the
  // password-unlock path and the fresh-create path.
  useEffect(() => {
    if (walletState?.kind === 'unlocked' && !session) {
      void startSession(walletState.wallet);
    }
    // Drop the session when the wallet leaves the unlocked state.
    if (walletState?.kind !== 'unlocked' && session) {
      api.setAccessToken(null);
      setSession(null);
    }
  }, [walletState, session]);

  // Mirror the unlocked wallet's public material into a shared
  // `chrome.storage.local` cache so the background SW can answer
  // dapp `getPublicKeys` / `getAddresses` calls without holding
  // any secret state. Cleared on every transition out of unlocked.
  // The auto-lock minutes are stamped into `sessionExpiresAtMs` so
  // the SW provider can detect "session expired while popup was
  // closed" without IPC (Finding 13).
  useEffect(() => {
    if (walletState?.kind === 'unlocked') {
      void store.load().then((s) => {
        const minutes = s.ui.autoLockMinutes ?? 0;
        void writeDappPublicCache(
          dappPublicCacheFor(walletState.wallet, minutes),
        );
      });
    } else if (walletState) {
      void clearDappPublicCache();
    }
  }, [walletState]);

  if (!walletState) {
    return (
      <div style={{ padding: '40px 16px', textAlign: 'center', opacity: 0.6 }}>
        Loading…
      </div>
    );
  }

  if (walletState.kind === 'empty' && needsMigration) {
    return (
      <MigrationWizard
        dogeMiningImageUrl={chrome.runtime.getURL('doge-mining.webp')}
        onMigrate={async (password) => {
          // Decrypt the v0.2 seed + re-seal into the v0.3 keystore (the crash-
          // safe commit point). Throws on a wrong password (wizard retries).
          const wallet = await migrateLegacyWallet(walletKeystore, storage, password);
          const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
          await writeSessionCache(wallet, minutes);
          // Bootstrap auth; the backend re-points the existing user by
          // seed_fingerprint (derivation rotation), preserving the @handle.
          const bootstrap = await bootstrapAuthInExtension(api, wallet);
          const token = api.getAccessToken();
          if (token) {
            await writeBootstrapCache(wallet.fingerprint, token, bootstrap);
          }
          // Link the NEW seed-derived Nostr identity (v0.2 had none) to the
          // re-pointed user. Idempotent: a 409 (already linked) is fine.
          try {
            if (wallet.mnemonic) {
              await api.linkNostr(deriveNostrIdentity(wallet.mnemonic, 0));
            }
          } catch (e) {
            console.warn('[smirk] linkNostr during migration failed', e);
          }
          // Sweep legacy m/44' BTC/LTC funds to the new m/84' addresses, then
          // report what actually happened. The done screen used to assert
          // "Funds swept" regardless of outcome; it now says only what is true.
          // The pre-v3 CryptoNote derivation cohort. v0.3 derives v3 keys
          // unconditionally (keystore.ts), so a wallet written with
          // derivationVersion 1 or 2 has XMR/WOW at an address this wallet does
          // not watch, and there is no in-app sweep for it. Saying nothing while
          // the wizard promises "same seed, same funds" is how someone concludes
          // their Monero is gone. `assessLegacyCleanupSafety` can live-probe
          // those addresses but has never been wired up; flagging the cohort is
          // the honest minimum until it is.
          const legacyBlob = await storage.get<{ derivationVersion?: 1 | 2 | 3 }>(
            LEGACY_WALLET_KEY,
          );
          const preV3 =
            legacyBlob?.derivationVersion === 1 || legacyBlob?.derivationVersion === 2;

          const sweep = await convergeLegacySweep(wallet);
          const moved = (['btc', 'ltc'] as const).filter(
            (a) => sweep[a]?.status === 'swept',
          );
          const cohortNote = preV3
            ? ' Your old wallet used an earlier Monero/Wownero key derivation, so any XMR, WOW or Grin it held sits at a different address that this wallet does not watch. Your seed still controls it. Keep your old wallet until you have moved those funds.'
            : '';
          if (sweep.errored) {
            return `Your old BTC/LTC funds could not be moved just yet; the wallet will retry automatically.${cohortNote}`;
          }
          if (moved.length) {
            return `Funds swept to your new ${moved.map((a) => a.toUpperCase()).join(' and ')} address${moved.length > 1 ? 'es' : ''}.${cohortNote}`;
          }
          if (sweep.btc?.status === 'already-swept' || sweep.ltc?.status === 'already-swept') {
            return `Your old BTC/LTC funds were already moved across.${cohortNote}`;
          }
          return `No old BTC/LTC funds needed moving.${cohortNote}`;
        }}
        onDone={refresh}
      />
    );
  }

  if (walletState.kind === 'empty') {
    return (
      <OnboardingWizard
        onBegin={() => setOnboardingBegun(true)}
        generateMnemonic={generateMnemonicPhrase}
        isValidMnemonic={isValidMnemonic}
        dogeMiningImageUrl={chrome.runtime.getURL('doge-mining.webp')}
        backendPicker={{
          probe: probeBackend,
          // Pre-wallet: no session/JWT yet, so just persist the choice + re-point
          // this context. The subsequent create/import bootstraps against it.
          onUse: async (info) => {
            const apiStyle = info.apiStyle as WalletApiStyle;
            await writeBackendConfig(storage, {
              url: info.url,
              apiStyle,
              chosenAt: Date.now(),
            });
            applyBackendConfig({ url: info.url, apiStyle });
          },
          defaultUrl: DEFAULT_BACKEND.url,
        }}
        {...(regPlan ? { registration: regPlan } : {})}
        registrationResolved={regResolved}
        payment={{
          // Create the wallet (once) + mint an invoice bound to its BTC key.
          // The SAME wallet + invoice are read back by `poll`.
          begin: async (mnemonic, password) => {
            const wallet =
              paymentWalletRef.current ??
              (await walletKeystore.createWallet({ mnemonic, password }));
            paymentWalletRef.current = wallet;
            const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
            await writeSessionCache(wallet, minutes);
            // Reuse an invoice already minted this session (a PaymentStep remount
            // must not mint a second one and strand the first — F8). The refs
            // persist across the remount; on a full popup close the wizard isn't
            // shown again (keystore now exists) so bootstrap resumes instead.
            if (paymentInvoiceRef.current && paymentInvoiceDetailsRef.current) {
              return paymentInvoiceDetailsRef.current;
            }
            const btcPub = bytesToHex(wallet.keys.btc.publicKey);
            const inv = await api.createPaymentInvoice(btcPub);
            if (inv.error || !inv.data) {
              // Already registered on this backend (a re-import): no payment
              // needed — the gate is bypassed server-side. Register directly.
              if (/already registered/i.test(inv.error ?? '')) {
                const b = await bootstrapAuthInExtension(api, wallet);
                await finishOnboardRegister(wallet, b);
                return { alreadyRegistered: true as const };
              }
              throw new Error(inv.error ?? 'Could not create a payment invoice.');
            }
            paymentInvoiceRef.current = inv.data.invoiceId;
            const details = {
              payTo: inv.data.payTo,
              amount: inv.data.amount,
              currency: inv.data.currency,
            };
            paymentInvoiceDetailsRef.current = details;
            // Persist durably so a popup closed mid-payment resumes on the next
            // unlock (the fee is never stranded).
            await setPendingRegistrationInvoice(
              wallet.fingerprint,
              inv.data.invoiceId,
            );
            return details;
          },
          // One register attempt with a FRESH signature. `pending` => keep
          // polling; `done` => registered (backend consumed the settled invoice).
          poll: async (attempt, inviteCode) => {
            const wallet = paymentWalletRef.current;
            const invoiceId = paymentInvoiceRef.current;
            if (!wallet || !invoiceId) {
              throw new Error('Payment session lost. Please restart onboarding.');
            }
            try {
              const onboardBootstrap = await bootstrapAuthInExtension(api, wallet, {
                paymentInvoiceId: invoiceId,
                ...(inviteCode ? { inviteCode } : {}),
                pollAttempt: attempt,
              });
              await finishOnboardRegister(wallet, onboardBootstrap);
              return 'done';
            } catch (e) {
              if (e instanceof Error && e.message === PAYMENT_PENDING_SENTINEL) {
                return 'pending';
              }
              throw e;
            }
          },
        }}
        isReturningWallet={async (mnemonic) => {
          // Derive the seed's public keys transiently (no keystore write) and ask
          // the backend whether it's already registered here. Lets the wizard
          // skip the gate for a re-import (server bypasses gates for returning
          // wallets anyway). Any failure => treat as new (the gate applies).
          try {
            const keys = deriveAllKeys(mnemonic, '', 3);
            const r = await api.checkRestore({
              fingerprint: computeSeedFingerprint(mnemonic),
              keys: [
                { asset: 'btc', publicKey: bytesToHex(keys.btc.publicKey) },
                { asset: 'ltc', publicKey: bytesToHex(keys.ltc.publicKey) },
                { asset: 'xmr', publicKey: bytesToHex(keys.xmr.publicSpendKey) },
                { asset: 'wow', publicKey: bytesToHex(keys.wow.publicSpendKey) },
                { asset: 'grin', publicKey: bytesToHex(keys.grin.publicKey) },
              ],
            });
            return !!r.data?.exists;
          } catch {
            return false;
          }
        }}
        onComplete={async (mnemonic, password, gate) => {
          const wallet = await walletKeystore.createWallet({ mnemonic, password });
          // Respect the user's stored auto-lock preference. For a brand-new
          // wallet this is normally `0` (immediate), so no session cache.
          const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
          await writeSessionCache(wallet, minutes);
          // Bootstrap NOW (with any invite-gate credential) so the wizard's setup
          // step has a valid JWT for handle-reservation, and warm the bootstrap
          // cache so the unlocked-shell startSession effect skips a re-bootstrap.
          const onboardBootstrap = await bootstrapAuthInExtension(
            api,
            wallet,
            gate,
          );
          await finishOnboardRegister(wallet, onboardBootstrap);
        }}
        reserveSmirkName={async (handle) => {
          // Double-import guard: handles are PER-INSTANCE, so ask THIS backend
          // whether the wallet already owns one before claiming. Importing the
          // same seed twice otherwise re-runs the claim and falsely reports a
          // fresh reservation. `getMe` is read-only; skip the claim if a
          // username is already set and surface it instead of re-claiming.
          const me = await api.getMe();
          if (me.data?.username) {
            throw new Error(`You already have @${me.data.username}.`);
          }
          const res = await api.setMySmirkUsername(handle);
          if (res.error) {
            throw new Error(res.error);
          }
        }}
        setInjectEnabled={async (enabled) => {
          await setInjectDisabled(!enabled);
        }}
        {...(existingIdentity ? { existingIdentity } : {})}
        onFullyDone={refresh}
      />
    );
  }

  if (walletState.kind === 'locked') {
    return (
      <LockScreen
        iconUrl={chrome.runtime.getURL('icons/icon-128.png')}
        onUnlock={async (password) => {
          const wallet = await walletKeystore.unlock(password);
          const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
          await writeSessionCache(wallet, minutes);
          // Converge any un-swept legacy m/44' funds (in-between wallets that
          // migrated the keystore before the sweep shipped). Fire-and-forget so
          // unlock stays snappy; idempotent + gated on legacy state presence.
          void convergeLegacySweep(wallet);
          await refresh();
        }}
      />
    );
  }

  // walletState.kind === 'unlocked'
  const lockHandler = async () => {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    await clearCachedActiveNostrKey();
    await clearBootstrapCache();
    await clearDappPublicCache();
    await walletKeystore.lock();
    await refresh();
  };
  const handleRefresh = () =>
    // `session` is briefly an empty `{}` cast between the bootstrap kick-off
    // and the bootstrapAuth resolution (see `startSession`), so a truthiness
    // check on `session` alone is not enough. Guard on bootstrap.userId
    // being present too — otherwise `refreshBalances` derefs
    // `bootstrap.userId` inside `fetchAllBalances` and explodes with
    // "Cannot read properties of undefined (reading 'userId')".
    session?.bootstrap?.userId
      ? refreshBalances(walletState.wallet, session.bootstrap)
      : Promise.resolve();
  const refreshGrinInbox = async () => {
    if (walletState.kind !== 'unlocked') return;
    const userId = session?.bootstrap?.userId;
    if (!userId) return;
    setGrinInbox((s) => ({ ...s, loading: true }));
    // Match the 30s poll loop: when Grin is hidden, skip the
    // slatepack relay round-trip but still refresh tips.
    const sess = await store.load();
    const grinHidden = (sess.ui.hiddenAssets ?? []).includes('grin');
    const [nextGrin, nextTips] = await Promise.all([
      grinHidden
        ? Promise.resolve({ items: [], loading: false, error: null })
        : fetchGrinInbox(userId, walletState.wallet),
      fetchTipInbox().catch((e) => ({
        tips: [],
        error: e instanceof Error ? e.message : 'Tip fetch failed',
      })),
    ]);
    setGrinInbox(nextGrin);
    setTipInbox(nextTips);
  };

  const onClaimTipHandler = async (item: InboxTipItem) => {
    if (walletState.kind !== 'unlocked') {
      throw new Error('Wallet must be unlocked to claim');
    }
    const userId = session?.bootstrap?.userId;
    if (!userId) throw new Error('No active session — wallet not bootstrapped');
    const outcome = await claimSocialTip(
      walletState.wallet,
      userId,
      item.tipId,
      item.assetId,
    );
    if (!outcome.ok) throw new Error(outcome.error);
    // Optimistically drop the row from the local cache so the user
    // gets immediate feedback that the tip is gone. Next 30s tick
    // will re-fetch authoritatively.
    setTipInbox((s) => ({
      ...s,
      tips: s.tips.filter((t) => t.tipId !== item.tipId),
    }));
    // Auto-unhide the asset if the user had hidden it. Claiming money
    // is an explicit "I want to see this" signal — leaving the swept
    // funds invisible because the user hid the asset weeks ago would
    // be confusing. They can re-hide from Settings if they prefer.
    await store.update((s) => {
      if ((s.ui.hiddenAssets ?? []).includes(item.assetId)) {
        s.ui.hiddenAssets = withAssetVisibility(
          s.ui.hiddenAssets ?? [],
          item.assetId,
          true,
        );
      }
    });
    // Refresh balances so the swept funds appear in the asset row.
    if (session?.bootstrap) {
      void refreshBalances(walletState.wallet, session.bootstrap);
    }
  };

  // Render a "Setting up wallet…" placeholder only while we have
  // NOTHING to show — no balance snapshot, no live data. If a
  // snapshot is in `session.balances` (the typical case after the
  // first successful bootstrap), render the Home tab with stale
  // numbers + the refreshing-spinner header so users don't see the
  // doge on every unlock — they only see it during a cold start.
  //
  // Bootstrap-dependent effects (tip inbox, etc.) already guard on
  // `session.bootstrap.userId` being non-empty (search for the
  // identical guard in this file). The snapshot path stamps
  // `userId: ''` as a placeholder for exactly that reason.
  if (!session?.balances) {
    // A failed bootstrap must surface its error + a retry — NOT sit forever on the
    // "Setting up wallet…" placeholder (which reads as an infinite hang).
    if (session?.error) {
      return (
        <BootstrapErrorScreen
          message={session.error}
          onRetry={() => setSession(null)}
        />
      );
    }
    return (
      <BootstrappingPlaceholder
        dogeImageUrl={chrome.runtime.getURL('doge-mining.webp')}
      />
    );
  }

  return (
    <StateProvider store={store} router={router}>
      <AppShell
        onPopOut={openPopOut}
        brand={{
          label: 'Smirk Wallet',
          iconUrl: chrome.runtime.getURL('icons/favicon-16.png'),
        }}
        tabBadges={{ inbox: grinInbox.items.length + tipInbox.tips.length }}
        headerActions={
          session && !session.error ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HeaderIdentitySwitcher wallet={walletState.wallet} />
              <RefreshIconButton
                busy={session.refreshing}
                onClick={() => void handleRefresh()}
              />
            </div>
          ) : null
        }
        routes={{
          home: (
            <HomeRouter
              wallet={walletState.wallet}
              session={session}
              caps={caps}
              tips={tipInbox.tips}
              onRefresh={handleRefresh}
              nostrLinkPrompt={nostrLinkPrompt}
              confirmNostrLink={confirmNostrLink}
              declineNostrLink={declineNostrLink}
              smirkHandle={smirkHandle}
              onTipClaim={async (tipId, assetId) => {
                try {
                  await onClaimTipHandler({
                    tipId,
                    assetId,
                    // Fields below aren't read by the handler — supply
                    // benign defaults so the InboxTipItem cast holds.
                    amountAtomic: 0n,
                    senderDisplay: null,
                    fundingConfirmations: 0,
                    confirmationsRequired: 0,
                    createdAt: new Date().toISOString(),
                  });
                  return { ok: true };
                } catch (e) {
                  return {
                    ok: false,
                    error: e instanceof Error ? e.message : 'Claim failed',
                  };
                }
              }}
            />
          ),
          swap: <SwapRouter wallet={walletState.wallet} session={session} />,
          inbox: (
            <InboxRouter
              wallet={walletState.wallet}
              userId={session?.bootstrap?.userId ?? ''}
              inbox={grinInbox}
              tips={tipInbox.tips}
              onRefresh={refreshGrinInbox}
              onClaimTip={onClaimTipHandler}
            />
          ),
          // Feed is opt-in — present only when the backend advertises an operator
          // feed. BottomNav shows the tab off the same capability (globalThis flag).
          ...(capHasFeed(caps)
            ? { feed: <FeedRoute wallet={walletState.wallet} caps={caps} /> }
            : {}),
          settings: (
            <SettingsRouter
              wallet={walletState.wallet}
              session={session}
              onRefresh={handleRefresh}
              onLock={lockHandler}
              onForgetComplete={async () => {
                await sessionStorage.remove(SESSION_CACHE_KEY);
                await clearCachedActiveNostrKey();
                await clearBootstrapCache();
                await clearDappPublicCache();
                await walletKeystore.destroy();
                await refresh();
              }}
              onBackendSwitched={async () => {
                // The JWT is per-backend; drop it + the caches + the session so
                // the unlocked-shell effect re-bootstraps against the new backend.
                api.setAccessToken(null);
                // Capabilities are per-backend too — drop the memoized copy so
                // gating re-evaluates against the new instance's advertisement.
                invalidateCapabilities();
                await clearBootstrapCache();
                await clearDappPublicCache();
                // Drop the balance snapshot too: it's keyed by the OLD backend, so
                // the re-bootstrap against the new instance must not paint stale
                // cross-backend numbers on first open.
                await clearBalanceSnapshot();
                // And the relay set, which is a module global that otherwise
                // SURVIVES the switch: the wallet would keep publishing DMs and
                // payments to the previous operator's relay while believing it had
                // moved. Cleared here and repopulated by the capabilities effect
                // from the new instance's advertisement.
                initSmirkMessaging({ publicRelays: [] });
                setSession(null);
                await refresh();
              }}
            />
          ),
          // `browse` is desktop-only — the desktop shell installs
          // `globalThis.__smirk_browser__` at boot and the
          // BottomNav renders the tab only when the controller is
          // present. Extension users never see it.
          ...(browserController
            ? {
                browse: (
                  <BrowseTab
                    controller={browserController}
                    walletStateRef={walletStateRef}
                  />
                ),
              }
            : {}),
        }}
      />
    </StateProvider>
  );
}


// ----- Home & its drill-downs -----

function HomeRouter({
  wallet,
  session,
  caps,
  tips,
  onRefresh,
  onTipClaim,
  nostrLinkPrompt,
  confirmNostrLink,
  declineNostrLink,
  smirkHandle,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Handle awaiting a consented Nostr-identity link, or null. Owned by App. */
  nostrLinkPrompt: string | null;
  confirmNostrLink: () => Promise<void>;
  declineNostrLink: () => void;
  /** The account's Smirk handle (name@domain) to surface on Receive, or null. */
  smirkHandle: string | null;
  /** All received tips, pending + claimable. Home only renders a
   *  claim banner for the subset where funding has matured; Inbox
   *  owns the full list + per-tip rows. */
  tips: InboxTipItem[];
  /** Refresh balances + prices. Used by the header refresh button, after a send
   *  and after a tip claim, and threaded into the asset-detail screen. */
  onRefresh: () => Promise<void>;
  /** Claim a tip from an asset-detail row. Threaded through to
   *  `AssetDetailRoute` so the per-row Claim button fires the same
   *  sweep logic as the InboxTab "Claim" affordance. */
  onTipClaim?: (
    tipId: string,
    assetId: InboxTipItem['assetId'],
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Backend capabilities — gates the fiat headline (prices) + Tip action (tips).
   *  Null reads permissive (legacy/loading), so nothing hides by accident. */
  caps: BackendCapabilities | null;
}) {
  const { route, navigate, switchTab } = useRoute();
  const sessionState = useSessionState();
  const showFiat = capAllowsPrices(caps);
  const showTip = capHasTips(caps);
  const balancesHidden = sessionState.ui.balanceHidden;
  const toggleBalancesHidden = () => {
    void store.update((s) => {
      s.ui.balanceHidden = !s.ui.balanceHidden;
    });
  };
  // Backend's Grin endpoints key by user UUID (`bootstrap.userId`),
  // not the local seed fingerprint. wallet.fingerprint is a 64-char
  // SHA-256(seed) used only for keystore lookup during auth bootstrap.
  // Passing it as the user_id route param yields "Invalid user_id"
  // from the backend's UUID parse.
  const grinUserId = session?.bootstrap?.userId ?? '';

  // route.current is e.g. "home", "home/send", "home/receive", "home/asset/btc"
  if (route.current === 'home/send') {
    return (
      <SendWizard
        // Filter to assets that are both (a) sendable per registry AND
        // (b) not hidden by the user. The chooser should never list
        // anything the user explicitly hid or the registry never
        // intended to be sendable.
        assetIds={visibleAssetIds(sessionState, listAssets(), caps)
          .filter((a) => a.sendable)
          .map((a) => a.id)}
        validateAddress={validateSendRecipient}
        parseAmount={parseAmount}
        resolveBalance={(assetId) => {
          // Read confirmed balance from current session. Returns 0n if
          // not yet loaded — Compose surfaces this as "Insufficient
          // funds" if user tries to send before balances arrive.
          const b = (session?.balances as Record<string, { confirmed: bigint } | undefined> | undefined)?.[assetId];
          return b?.confirmed ?? 0n;
        }}
        resolveFeeRates={async (assetId) => {
          if (assetId !== 'btc' && assetId !== 'ltc') {
            // Other assets (XMR/WOW/Grin) don't use sat/vB tiers. Stub
            // with nulls — Compose will surface "Loading…" / error.
            return { fast: null, normal: null, slow: null };
          }
          const r = await chainProviders.utxo(assetId).estimateFee();
          if (r.error || r.data?.model !== 'rate-estimate' || r.data.normal == null) {
            // Fee endpoint unavailable or returned no usable rate: fall back to a
            // safe floored tier set instead of throwing, so Send stays usable (the
            // tx still lands at a sane rate) rather than the button locking out.
            // Overpaying slightly on a rare estimate outage beats stranding the user.
            return fallbackFeeTiers();
          }
          return { fast: r.data.fast, normal: r.data.normal, slow: r.data.slow };
        }}
        resolveSendFeeEstimate={async (assetId, options) => {
          // Grin: fee = weight × DEFAULT_ACCEPT_FEE_BASE where weight
          // depends on real input count. To produce an honest estimate
          // we replay the same greedy largest-first selection the send
          // handler will run, against the user's actual unspent
          // outputs. Falls back to 1-in if amount is unknown so the
          // hint never goes stale waiting for selection — but the UI
          // gates display on amountAtomic > 0 anyway (see SendWizard
          // useEffect).
          if (assetId === 'grin') {
            if (!options?.amountAtomic) return null;
            if (!wallet.mnemonic) return null;
            await ensureWasmInit();
            let resolved;
            try {
              resolved = await resolveGrinSpendable({
                mnemonic: wallet.mnemonic,
                rewindHash: grinRewindHashFromMnemonic(wallet.mnemonic),
                overlay: grinOverlay,
              });
            } catch {
              return null;
            }
            const spendable = [...resolved.outputs].sort((a, b) => b.amount - a.amount);
            const target = Number(options.amountAtomic);
            // Iterate until input count converges (fee itself moves the
            // target). Cap at MAX_ITER to stay fast; the count almost
            // always stabilizes in 1-2 passes.
            let numIn = 1;
            let fee = calcGrinFee(numIn, 2, 1);
            for (let iter = 0; iter < 6; iter++) {
              let acc = 0;
              let picked = 0;
              for (const o of spendable) {
                picked += 1;
                acc += o.amount;
                if (acc >= target + fee) break;
              }
              const nextFee = calcGrinFee(picked, 2, 1);
              if (picked === numIn && nextFee === fee) break;
              numIn = picked;
              fee = nextFee;
            }
            return BigInt(fee);
          }
          // Live fee preview for assets without a sat/vB tier picker.
          // Pulls per_byte_fee + fee_mask from LWS unspent_outs (the
          // same numbers the send-handler uses at sign time). Input
          // count: 1 by default (typical send out of our single-address
          // scheme), or the actual spendable-output count when sweep
          // mode is requested — sweep TX size scales linearly with
          // input count, so a 1-input estimate would massively
          // under-report the fee for fragmented wallets.
          if (assetId !== 'xmr' && assetId !== 'wow') return null;
          const fromAddress = wallet.addresses[assetId];
          if (!fromAddress) return null;
          const viewKeyHex = bytesToHex(wallet.keys[assetId].privateViewKey);
          const unspent = await chainProviders.lws(assetId).listOutputs(fromAddress, viewKeyHex);
          if (unspent.error || !unspent.data) return null;
          const { per_byte_fee, fee_mask, outputs } = unspent.data;
          const numInputs = options?.sweep && outputs.length > 0 ? outputs.length : 1;
          const feeJson = wasmMonero.estimateFee(
            numInputs,
            2,
            BigInt(per_byte_fee),
            BigInt(fee_mask),
          );
          const parsed = JSON.parse(feeJson) as { success: boolean; data?: number };
          if (!parsed.success || parsed.data === undefined) return null;
          return BigInt(parsed.data);
        }}
        onSubmit={async (fields) => {
          // Build the exclude-set from existing pendingOutgoing
          // entries for this asset so the handler doesn't pick an
          // input we just spent before LWS/Electrum has reflected it.
          const excludeInputs = recentlySpentInputs(
            sessionState.pendingOutgoing ?? [],
            fields.fromAssetId,
          );
          const result = await send(wallet, fields, excludeInputs);
          if (result.ok && result.amountAtomic !== undefined && result.feeAtomic !== undefined) {
            // Carry through the wizard's stashed `pendingContext` (if
            // any) — set by non-vanilla entry points like the Trocador
            // prefill so the resulting Activity row says "Swap deposit
            // → XMR (CDNQ…)" and taps back to the right surface.
            // Vanilla sends from the Home action bar default to
            // `{kind: 'send'}` at render time.
            // Pull pendingContext + its seed. The seed is what the
            // prefill entry-point (e.g. Trocador "Open Send →
            // pre-filled") captured at the moment it wrote the
            // wizard. If the user has since back-navigated and
            // changed fromAsset / toAddress to something unrelated,
            // applying the swap-deposit context to the resulting
            // pendingOutgoing entry would mis-tag a vanilla send
            // as "Swap deposit → XMR (trade …)" and deep-link to
            // the wrong swap. Verify match; drop ctx on mismatch.
            const sendFields = (await store.load()).wizards.send?.fields as
              | {
                  pendingContext?: import('@smirk/core').PendingOutgoingContext;
                  pendingContextSeed?: { fromAssetId?: string; toAddress?: string };
                }
              | undefined;
            const rawCtx = sendFields?.pendingContext;
            const seed = sendFields?.pendingContextSeed;
            const seedMatches =
              !seed ||
              (seed.fromAssetId === fields.fromAssetId &&
                seed.toAddress === fields.toAddress);
            const ctx: import('@smirk/core').PendingOutgoingContext | undefined =
              rawCtx && seedMatches ? rawCtx : undefined;
            if (rawCtx && !seedMatches) {
              console.info(
                '[send] dropping stale pendingContext — user diverged from the prefill seed',
                {
                  seed,
                  fromAssetId: fields.fromAssetId,
                  toAddress: fields.toAddress,
                },
              );
            }
            // One atomic store.update writes both the pendingOutgoing
            // entry AND the wizard's lastTxid. The wizard's inner
            // onSubmit *also* writes lastTxid via patchFields, but
            // running both writes through this one transaction makes
            // the txid persisted *before* the wizard advances step,
            // so the DoneStep render never sees step=TOTAL_STEPS
            // without a corresponding lastTxid. The wizard's
            // subsequent write becomes idempotent.
            const entry = {
              asset: fields.fromAssetId,
              txHash: result.txid,
              amount: result.amountAtomic.toString(),
              fee: result.feeAtomic.toString(),
              recipient: fields.toAddress,
              submittedAt: Date.now(),
              ...(result.inputs && result.inputs.length > 0
                ? { inputs: result.inputs }
                : {}),
              ...(result.inputsTotalAtomic !== undefined
                ? { inputsTotal: result.inputsTotalAtomic.toString() }
                : {}),
              ...(ctx ? { context: ctx } : {}),
            };
            await store.update((s) => {
              s.pendingOutgoing.push(entry);
              const w = s.wizards.send;
              if (w) {
                w.fields.lastTxid = result.txid;
              }
            });
            // Pull the real on-chain balance forward instead of waiting for the
            // next periodic/scan poll. Two shots through the existing refresh
            // path: one now (catches an already-reflected UTXO spend), one after
            // a short delay (Electrum/LWS often need a few seconds to surface the
            // mempool tx). Both are best-effort and reconcile pendingOutgoing.
            void onRefresh();
            setTimeout(() => void onRefresh(), 4000);
          }
          return result;
        }}
        onGrinBuildSlate={async ({ amountAtomic, toAddress }) => {
          // Resolve mnemonic + wallet's slatepack address.
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          let recipientUserId: string | undefined;
          // If the recipient field is a Nostr npub OR a NIP-05 name
          // (alice@goblin.st — federation), route the send over the gift-wrap
          // channel instead of a grin slatepack address. npub/hex resolve
          // synchronously; a NIP-05 name resolves against the domain's
          // /.well-known/nostr.json here at send time.
          let recipientPubkeyHex = recipientNpubToHex(toAddress);
          if (!recipientPubkeyHex && isNip05Name(toAddress)) {
            // Federation: resolve the name to a key via the TOFU-pinning resolver,
            // and show the user WHICH key before paying — a name is only a lookup;
            // the key is what's authoritative ("follow the key, not the name").
            const res = await nip05Resolver.resolve(toAddress, { homeDomain: instanceHomeDomain() });
            if (!res.ok) {
              return { ok: false, error: `Couldn't resolve ${toAddress}: ${res.error}` };
            }
            if (res.keyChanged) {
              const prev = shortNpub(encodeNpub(hexToBytes(res.pinnedPubkeyHex)));
              const ok = window.confirm(
                `⚠️ The Nostr key for ${toAddress} CHANGED since you last used it.\n\n` +
                  `Previously: ${prev}\nNow:        ${shortNpub(res.resolution.npub)}\n\n` +
                  `This can happen legitimately (key rotation) or mean the name was hijacked. ` +
                  `Only continue if you trust this change.`,
              );
              if (!ok) return { ok: false, error: 'Send cancelled — key change not confirmed' };
              await nip05Resolver.confirmPin(toAddress, res.resolution.pubkeyHex, {
                homeDomain: instanceHomeDomain(),
              });
            } else if (res.firstSeen) {
              const ok = window.confirm(
                `Pay ${toAddress}?\n\nResolves to ${shortNpub(res.resolution.npub)}.\n` +
                  `Smirk will remember this key and warn you if it ever changes.`,
              );
              if (!ok) return { ok: false, error: 'Send cancelled' };
            }
            recipientPubkeyHex = res.resolution.pubkeyHex;
          }
          // Bare grin1 slatepack address: look up its registered owner so we can
          // route over a channel (finding #1 fix — address→npub/user bridge).
          // Prefer the owner's npub (Nostr, Goblin-interoperable); else their
          // backend user_id (same-instance relay); else fall through to manual.
          if (!recipientPubkeyHex && !isNip05Name(toAddress)) {
            const owner = await api.getGrinAddressUser(toAddress).catch(() => null);
            if (owner?.data?.registered) {
              const ownerNpubHex = owner.data.npub ? recipientNpubToHex(owner.data.npub) : null;
              if (ownerNpubHex) recipientPubkeyHex = ownerNpubHex;
              else if (owner.data.user_id) recipientUserId = owner.data.user_id;
            }
          }
          // Build both transports under the ACTIVE identity (from the vault), so a
          // send from a burner/imported identity is gift-wrapped by IT, not always
          // account 0. selectSendChannel inside startGrinSend picks Nostr vs backend.
          const identity = await getActiveNostrIdentity(wallet.mnemonic);
          const channels = buildSlatepackChannels({ grin: api, userId: grinUserId, identity });
          try {
            const result = await startGrinSend({
              mnemonic: wallet.mnemonic,
              senderSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              ...(recipientPubkeyHex ? { recipientPubkeyHex } : {}),
              ...(recipientUserId ? { recipientUserId } : {}),
              // Encrypt to the grin address for the non-Nostr paths (backend relay
              // + manual); the Nostr path armors plain (gift-wrap secures it).
              ...(recipientPubkeyHex ? {} : { recipientSlatepackAddress: toAddress }),
              channels,
              amount: Number(amountAtomic),
              resolver: makeGrinResolver({
                mnemonic: wallet.mnemonic,
                rewindHash: grinRewindHashFromMnemonic(wallet.mnemonic),
                overlay: grinOverlay,
              }),
              // Reserve the selected inputs + change index at build time.
              overlay: grinOverlay,
            });
            return {
              ok: true,
              slate_id: result.slate_id,
              armored: result.armored,
              sender_context_json: result.sender_context_json,
              sender_inputs_json: JSON.stringify(result.sender_inputs),
              ...(result.change_output
                ? { change_output_json: JSON.stringify(result.change_output) }
                : {}),
              ...(result.relay_id ? { relay_id: result.relay_id } : {}),
              fee_atomic: result.fee,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onGrinFinalize={async ({ s2, senderContextJson, senderInputsJson, changeOutputJson, relayId }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          const identity = await getActiveNostrIdentity(wallet.mnemonic);
          const channels = buildSlatepackChannels({ grin: api, userId: grinUserId, identity });
          try {
            const result = await processGrinS2({
              mnemonic: wallet.mnemonic,
              s2,
              sender_context_json: senderContextJson,
              sender_inputs: JSON.parse(senderInputsJson),
              ...(changeOutputJson ? { change_output: JSON.parse(changeOutputJson) } : {}),
              ...(relayId ? { relay_id: relayId } : {}),
              channels,
              overlay: grinOverlay,
            });
            return {
              ok: true,
              slate_id: result.slate_id,
              kernel_excess_hex: result.kernel_excess_hex,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onGrinCancel={async ({ slateId, relayId }) => {
          if (!wallet.mnemonic) {
            // Still free the reserved inputs locally even if we can't build the
            // channel to notify the counterparty.
            await grinOverlay.remove(slateId).catch(() => undefined);
            return;
          }
          await ensureWasmInit();
          const identity = await getActiveNostrIdentity(wallet.mnemonic);
          const channels = buildSlatepackChannels({ grin: api, userId: grinUserId, identity });
          await cancelGrinSend({
            slate_id: slateId,
            ...(relayId ? { relay_id: relayId } : {}),
            channels,
            overlay: grinOverlay,
          }).catch(() => undefined);
        }}
        onExit={() => void navigate('home')}
        resolveIcon={resolveIcon}
      />
    );
  }

  if (route.current === 'home/receive') {
    return (
      <ReceiveScreen
        // Receivable assets only, minus any the user hid. See
        // SendWizard for the rationale on capability + visibility
        // double-gating.
        assetIds={visibleAssetIds(sessionState, listAssets(), caps)
          .filter((a) => a.receivable)
          .map((a) => a.id)}
        // PURE READ. This closure is re-created every render, so ShowAddress's
        // address effect re-fires every render; `resolveAddressForAsset` never
        // advances the issuance counter, which is what keeps the displayed
        // address stable instead of burning a subaddress per frame.
        // The backend URL scopes the issuance counter: a ceiling one instance's
        // LWS granted says nothing about another's, so switching backends must
        // not reuse it.
        resolveAddress={(assetId) => resolveAddressForAsset(wallet, assetId, api.getBaseUrl())}
        // Only XMR/WOW have subaddresses, and only with the flag on. Flag off
        // (the default) means the button never renders and the screen behaves
        // exactly as it does today.
        // Also requires a REAL bootstrap. When a cached balance snapshot exists
        // the session is seeded with `bootstrap.userId: ''` as a placeholder so
        // the render path has something to work with while the authenticated
        // bootstrap is still in flight. During that window the wallet looks
        // signed in (a balance is on screen) but provisioning cannot be
        // authorized, so offering the button would only produce a refusal.
        canIssueNewAddress={(assetId) =>
          (assetId === 'xmr' || assetId === 'wow') &&
          subaddressReceiveEnabled() &&
          !!session?.bootstrap?.userId
        }
        onNewAddress={(assetId) => {
          if (assetId !== 'xmr' && assetId !== 'wow') {
            return Promise.reject(new Error(`No fresh-address support for ${assetId}`));
          }
          // Defence in depth: the button is hidden without a userId, but a
          // stale render could still get here. Say something a user can act on
          // rather than surfacing the internal "no active session".
          const userId = session?.bootstrap?.userId;
          if (!userId) {
            return Promise.reject(
              new Error('Still finishing sign-in. Try again in a moment.'),
            );
          }
          return issueNewReceiveAddress(
            wallet,
            assetId,
            userId,
            api.getBaseUrl(),
          );
        }}
        // Keeps the primary address reachable behind an advanced disclosure
        // while a subaddress is on screen. `null` for every other asset: they
        // have no separate primary, and this runs on each render, so a Grin
        // slatepack re-derivation here would be pure waste.
        resolvePrimaryAddress={(assetId) =>
          assetId === 'xmr' || assetId === 'wow'
            ? primaryAddressForAsset(wallet, assetId)
            : null
        }
        onCopy={(text) => void navigator.clipboard.writeText(text)}
        onExit={() => void navigate('home')}
        resolveIcon={resolveIcon}
        {...(smirkHandle ? { handle: smirkHandle } : {})}
        onRequestInvoice={(assetId) => {
          // Only Grin has an interactive-invoice flow today. ReceiveScreen
          // calls this for every asset that has the callback set, so guard
          // here rather than per-asset on the props.
          if (assetId === 'grin') {
            void navigate('home/receive/grin-request');
          }
        }}
      />
    );
  }

  // Asset detail drill-down — tapping a coin row on Home lands here.
  // Pulls per-chain history + sparkline; renders BalanceCard + sparkline
  // + action row + activity list. Per-chain shape adapters live in
  // `loadAssetHistory` below.
  if (route.current.startsWith('home/asset/')) {
    const drilldownAssetId = route.current.substring('home/asset/'.length);
    return (
      <AssetDetailRoute
        assetId={drilldownAssetId}
        wallet={wallet}
        session={session}
        onRefresh={onRefresh}
        onBack={() => void navigate('home')}
        onSend={() => void navigate('home/send')}
        onReceive={() => void navigate('home/receive')}
        // Carry the asset id forward as a route segment so the Tip
        // composer pre-selects this coin instead of defaulting to
        // whatever has the largest balance.
        onTip={() => void navigate(`home/tip/${drilldownAssetId}`)}
        {...(onTipClaim ? { onTipClaim } : {})}
        resolveIcon={resolveIcon}
      />
    );
  }

  if (route.current === 'home/receive/grin-request') {
    return (
      <GrinRequestWizard
        assetId="grin"
        parseAmount={parseAmount}
        onBuild={async ({ amountAtomic, feeAtomic }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          try {
            const result = await startGrinInvoice({
              mnemonic: wallet.mnemonic,
              receiverSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              amount: Number(amountAtomic),
              fee: Number(feeAtomic),
              resolver: makeGrinResolver({
                mnemonic: wallet.mnemonic,
                rewindHash: grinRewindHashFromMnemonic(wallet.mnemonic),
                overlay: grinOverlay,
              }),
              overlay: grinOverlay,
            });
            return {
              ok: true,
              slate_id: result.slate_id,
              armored: result.armored,
              receiver_context_json: result.receiver_context_json,
              amount: result.amount,
              fee: result.fee,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onFinalize={async ({ i2, receiverContextJson }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          try {
            const result = await processGrinI2({
              mnemonic: wallet.mnemonic,
              i2,
              receiver_context_json: receiverContextJson,
              overlay: grinOverlay,
            });
            return {
              ok: true,
              slate_id: result.slate_id,
              kernel_excess_hex: result.kernel_excess_hex,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onCancel={async ({ slateId }) => {
          if (!slateId) return;
          // v3 has no server tx record to mark cancelled. startGrinInvoice records
          // NO pending-incoming entry (it doesn't inflate the pending balance), so
          // there's normally nothing to drop; the reserved receive-output index is
          // intentionally never released (reuse would risk a duplicate commitment).
          // remove() stays as a harmless no-op / safety net for any later entry.
          await grinOverlay.remove(slateId).catch(() => undefined);
        }}
        onExit={() => void navigate('home/receive')}
      />
    );
  }

  if (route.current === 'home/receive/grin-incoming') {
    return (
      <GrinPasteIncomingWizard
        assetId="grin"
        onReadClipboard={async () => navigator.clipboard.readText()}
        onCopy={(text) => void navigator.clipboard.writeText(text)}
        onSign={async ({ s1Armored, relayId }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          try {
            const signed = await signIncomingGrinSlate({
              mnemonic: wallet.mnemonic,
              receiverSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              s1Armored,
              resolver: makeGrinResolver({
                mnemonic: wallet.mnemonic,
                rewindHash: grinRewindHashFromMnemonic(wallet.mnemonic),
                overlay: grinOverlay,
              }),
              overlay: grinOverlay,
            });
            // When the S1 came from a Smirk relay row (Inbox tap), post
            // the S2 back via the relay's `sign` endpoint so the
            // sender's queue advances and the row moves from
            // pending_to_sign → pending_to_finalize on their side.
            // Manual-paste flows have no relayId — sender gets the S2
            // from the clipboard copy instead.
            // Relay back the S2 so the sender's `pending_to_finalize`
            // counter ticks immediately. If this fails the receiver is
            // still in a valid state — their S2 is in `signed.s2_armored`
            // and they can hand it to the sender out-of-band. Surface
            // the failure so the UI can render a "copy manually" hint
            // instead of silently lying about success.
            // Deliver the S2 back over the item's transport: a Nostr gift-wrap
            // item (relayId packs the counterparty) is answered with a gift-wrap
            // response; a backend item hits the relay's `sign` endpoint. Either
            // way the receiver is still valid on failure — their S2 is in
            // `signed.s2_armored` for manual hand-off.
            let relayDeliveryFailed = false;
            if (relayId) {
              const relayRes = await respondToInboxItem({
                relayId,
                s2Armored: signed.s2_armored,
                userId: grinUserId,
                mnemonic: wallet.mnemonic,
              });
              if (relayRes.error) {
                console.warn('[smirk-popup] S2 delivery failed:', relayRes.error);
                relayDeliveryFailed = true;
              }
            }
            return {
              ok: true,
              slate_id: signed.slate_id,
              s2_armored: signed.s2_armored,
              amount_atomic: String(signed.amount),
              relay_delivery_failed: relayDeliveryFailed,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onExit={() => void navigate('home')}
      />
    );
  }

  // Inbox → "+ Paste a slatepack" universal entry point. Inspects the
  // sta field and routes to the appropriate downstream wizard so the
  // user never has to know if they have an S1 / S2 / I1 / I2 in their
  // clipboard — they just paste once and we figure out what to do.
  if (route.current === 'home/inbox/paste') {
    return (
      <InboxPasteRouter
        onReadClipboard={async () => navigator.clipboard.readText()}
        onDispatch={async (armored) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          // A GoblinPay pay-link (goblin:/nostr:) isn't a slatepack. Parse it
          // and pre-fill the Send flow — Grin to the recipient npub, amount from
          // the link — so pasting a Magick Market checkout URI lands the user at
          // send review. This is the "be a valid Magick Market buyer" path.
          const pasted = armored.trim();
          if (isGoblinPayUri(pasted)) {
            let pay;
            try {
              pay = parseGoblinPayUri(pasted);
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : 'Invalid pay link' };
            }
            await store.update((s) => {
              s.wizards.send = {
                step: 1,
                startedAt: Date.now(),
                fields: {
                  fromAssetId: 'grin',
                  toAddress: pay.recipientPubkeyHex,
                  ...(pay.amountGrin ? { amountText: pay.amountGrin } : {}),
                  ...(pay.memo ? { grinPayMemo: pay.memo } : {}),
                },
              };
            });
            void navigate('home/send');
            return { ok: true };
          }
          await ensureWasmInit();
          // Derive the slatepack secret upfront so we can decrypt
          // encrypted slatepacks. Plain slatepacks work too — wasm's
          // unpackWithSecret handles both modes.
          const secretKeyHex = wasmGrin.slatepackAddressSecret(wallet.mnemonic, 0);
          let inspected;
          try {
            inspected = inspectSlatepack(armored, secretKeyHex);
          } catch (e) {
            return {
              ok: false,
              error: e instanceof Error ? e.message : 'Failed to parse slatepack',
            };
          }
          switch (inspected.sta) {
            case 'S1': {
              await store.update((s) => {
                s.wizards['grin-paste-incoming'] = {
                  step: 1,
                  startedAt: Date.now(),
                  fields: { armoredIncoming: armored },
                };
              });
              void navigate('home/receive/grin-incoming');
              return { ok: true };
            }
            case 'I1': {
              await store.update((s) => {
                s.wizards['grin-pay-invoice'] = {
                  step: 1, // skip Paste, go to Confirm
                  startedAt: Date.now(),
                  fields: {
                    armoredIncoming: armored,
                    inspectedAmount: inspected.amount,
                    inspectedFee: inspected.fee,
                    inspectedSlateId: inspected.id,
                  },
                };
              });
              void navigate('home/inbox/pay-invoice');
              return { ok: true };
            }
            case 'S2': {
              // Pre-fill the SendWizard's S2 textarea + clipboard fallback.
              await store.update((s) => {
                const w = s.wizards.send;
                if (w) w.fields.grinPastedS2 = armored;
              });
              void navigator.clipboard.writeText(armored).catch(() => undefined);
              void navigate('home/send');
              return { ok: true };
            }
            case 'I2': {
              await store.update((s) => {
                const w = s.wizards['grin-request'];
                if (w) w.fields.pastedI2 = armored;
              });
              void navigator.clipboard.writeText(armored).catch(() => undefined);
              void navigate('home/receive/grin-request');
              return { ok: true };
            }
            case 'S3':
            case 'I3':
              return {
                ok: false,
                error: `This slatepack is already finalized (${inspected.sta}) — nothing left to do.`,
              };
            default:
              return {
                ok: false,
                error: `Unknown slate state "${inspected.sta}". Expected S1/S2/I1/I2.`,
              };
          }
        }}
        onExit={() => void navigate('inbox')}
      />
    );
  }

  // Inbox → "+ Paste tip link" entry point for public tips shared as
  // smirk.cash/tip/<id>#<fragment> URLs. Public tips never appear in
  // the received-tips list (they're not addressed to a username) — this
  // is the only path for the URL holder to claim. Parses the URL,
  // fetches via getPublicSocialTip (unauthenticated, server doesn't
  // know who is claiming), decrypts the spend key with the fragment,
  // and sweeps to the user's wallet.
  if (route.current === 'home/inbox/paste-tip') {
    return (
      <PasteTipLinkScreen
        onReadClipboard={async () => navigator.clipboard.readText()}
        onClaim={async (url) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          const userId = session?.bootstrap?.userId;
          if (!userId) {
            return { ok: false, error: 'No active session — wallet not bootstrapped' };
          }
          const parsed = parseShareUrl(url);
          if (!parsed) {
            return {
              ok: false,
              error: 'Not a recognised Smirk tip link. Expected smirk.cash/tip/<id>#<key>.',
            };
          }
          const outcome = await claimPublicTip(
            wallet,
            userId,
            parsed.tipId,
            parsed.fragmentKey,
          );
          if (!outcome.ok) return { ok: false, error: outcome.error };
          const claimedAssetId = outcome.assetId;
          const claimedAmount = outcome.amountAtomic;
          // Auto-unhide the swept asset so the funds show up on Home,
          // matching the received-tips flow.
          if (claimedAssetId) {
            await store.update((s) => {
              if ((s.ui.hiddenAssets ?? []).includes(claimedAssetId)) {
                s.ui.hiddenAssets = withAssetVisibility(
                  s.ui.hiddenAssets ?? [],
                  claimedAssetId,
                  true,
                );
              }
            });
          }
          void onRefresh();
          const success: { ok: true; assetId?: string; amountAtomic?: bigint } = { ok: true };
          if (claimedAssetId !== undefined) success.assetId = claimedAssetId;
          if (claimedAmount !== undefined) success.amountAtomic = claimedAmount;
          return success;
        }}
        onExit={() => void navigate('inbox')}
      />
    );
  }

  if (route.current === 'home/inbox/pay-invoice') {
    return (
      <GrinPayInvoiceWizard
        assetId="grin"
        onReadClipboard={async () => navigator.clipboard.readText()}
        onCopy={(text) => void navigator.clipboard.writeText(text)}
        onInspect={(i1Armored) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          try {
            const secretKeyHex = wasmGrin.slatepackAddressSecret(wallet.mnemonic, 0);
            const i = inspectSlatepack(i1Armored, secretKeyHex);
            return {
              ok: true,
              sta: i.sta,
              amount: i.amount,
              fee: i.fee,
              slate_id: i.id,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onSign={async ({ i1Armored, relayId }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          try {
            const signed = await signGrinInvoice({
              mnemonic: wallet.mnemonic,
              payerSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              i1Armored,
              resolver: makeGrinResolver({
                mnemonic: wallet.mnemonic,
                rewindHash: grinRewindHashFromMnemonic(wallet.mnemonic),
                overlay: grinOverlay,
              }),
              overlay: grinOverlay,
            });
            // See `signGrinSlatepack` rationale at the receiver-S2
            // handler above — receiver is in a valid state regardless,
            // surface a flag for the UI to render a fallback hint.
            let relayDeliveryFailed = false;
            if (relayId) {
              const relayRes = await respondToInboxItem({
                relayId,
                s2Armored: signed.armored,
                userId: grinUserId,
                mnemonic: wallet.mnemonic,
              });
              if (relayRes.error) {
                console.warn('[smirk-popup] I2 delivery failed:', relayRes.error);
                relayDeliveryFailed = true;
              }
            }
            return {
              ok: true,
              slate_id: signed.slate_id,
              i2_armored: signed.armored,
              amount_atomic: String(
                JSON.parse(signed.slate_json).amt ?? 0,
              ),
              relay_delivery_failed: relayDeliveryFailed,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onExit={() => void navigate('inbox')}
      />
    );
  }

  // `home/tip` opens the Tip composer with the default-asset heuristic.
  // `home/tip/<assetId>` arrives from a per-asset detail screen's Tip
  // button and pre-selects that asset — much less surprising than
  // landing on whatever asset has the biggest balance.
  if (route.current === 'home/tip' || route.current.startsWith('home/tip/')) {
    const tipPrefilledAsset = route.current.startsWith('home/tip/')
      ? route.current.substring('home/tip/'.length)
      : undefined;
    return (
      <TipMaker
        // Tip composer respects both the per-asset socialTipping
        // capability (future assets can opt out of being tip-able)
        // and the user's hide-list. See SendWizard for the
        // capability + visibility double-gating pattern.
        assetIds={visibleAssetIds(sessionState, listAssets(), caps)
          .filter((a) => a.socialTipping)
          .map((a) => a.id)}
        {...(tipPrefilledAsset ? { prefilledAssetId: tipPrefilledAsset } : {})}
        // All 5 assets wired: BTC/LTC fresh-keypair, XMR/WOW
        // fresh-primary-keypair + LWS registration, Grin
        // voucher-pattern via createGrinVoucher (primitives in
        // crates/grin-ext::voucher, 588ee2c).
        resolveBalance={(assetId) => {
          const b = (
            session?.balances as
              | Record<string, { confirmed: bigint } | undefined>
              | undefined
          )?.[assetId];
          return b?.confirmed ?? 0n;
        }}
        parseAmount={parseAmount}
        recentRecipients={recentTipRecipients(session)}
        lookupRecipient={async (platform, username) => {
          // Smirk usernames → lookupSmirkName; external platforms →
          // lookupSocial with the platform tag. Backend returns
          // `registered` + per-asset public_keys map.
          const r =
            platform === 'smirk'
              ? await api.lookupSmirkName(username)
              : await api.lookupSocial(platform, username);
          if (r.error || !r.data) return { registered: false, hasAssetWallet: false };
          return {
            registered: r.data.registered,
            // We can refine "hasAssetWallet" per current asset later;
            // for now any registered user is presumed to have a wallet
            // for any asset since all v0.3 wallets register all 5.
            hasAssetWallet: r.data.registered,
          };
        }}
        onSubmit={async (fields) => {
          await ensureWasmInit();
          // Grin voucher tips are scan-based (non-custodial): thread the view-only
          // rewind hash + the client pending overlay so createGrinTip can select
          // inputs and reserve child indices.
          const grinRewindHash = wallet.mnemonic
            ? grinRewindHashFromMnemonic(wallet.mnemonic)
            : undefined;
          return dispatchSocialTip({
            wallet,
            senderUserId: grinUserId,
            fields,
            grinPending: grinOverlay,
            ...(grinRewindHash ? { grinRewindHash } : {}),
            // Record pendingOutgoing on tip broadcast so the sender's
            // balance reflects the deduction immediately — matches the
            // SendWizard onSubmit flow above. Without this, XMR/WOW
            // tips look like nothing happened for ~1-2 minutes (until
            // LWS reflects the spend), which is what made the failed
            // 3 WOW tip look like a no-op to the user.
            onBroadcast: async (e) => {
              await store.update((s) => {
                s.pendingOutgoing.push({
                  asset: e.assetId,
                  txHash: e.txid,
                  amount: e.amountAtomic.toString(),
                  fee: e.feeAtomic.toString(),
                  recipient: e.recipient,
                  submittedAt: Date.now(),
                  context: { kind: 'tip-fund', tipId: e.tipId },
                  ...(e.inputs && e.inputs.length > 0
                    ? { inputs: e.inputs }
                    : {}),
                  ...(e.inputsTotalAtomic !== undefined
                    ? { inputsTotal: e.inputsTotalAtomic.toString() }
                    : {}),
                });
              });
            },
          });
        }}
        onExit={() => void navigate('home')}
        resolveIcon={resolveIcon}
      />
    );
  }

  // Default: Home root.

  // Sent public tips whose funding has buried past the per-asset
  // confirmation gate — the URL we minted at create time is now safe
  // to actually distribute. v0.2.4 surfaced this as a banner on its
  // WalletView; v0.3 dropped it and senders had no cue. We poll on
  // mount + every 60s so a tip that matures while Home is open
  // lights up the banner without a manual refresh.
  const [readyToShareCount, setReadyToShareCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // Opt-in: no tips capability → no sent-tips poll (skips a recurring 404).
      if (!capHasTips(await loadCapabilities(api))) {
        if (alive) setReadyToShareCount(0);
        return;
      }
      const r = await api.getSentSocialTips().catch(() => null);
      const rows = r?.data?.tips ?? [];
      const ready = rows.filter(
        (t) =>
          t.is_public &&
          t.status === 'pending' &&
          (t.funding_confirmations ?? 0) >= (t.confirmations_required ?? 1),
      );
      if (alive) setReadyToShareCount(ready.length);
    };
    void tick();
    const handle = window.setInterval(() => void tick(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(handle);
    };
  }, []);

  const balances = session?.balances;
  const prices = session?.prices;
  const decimalsByAsset: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    for (const a of listAssets()) m[a.id] = a.decimals;
    return m;
  })();
  const totalDisplay = (() => {
    // Opt-in: no price feed on this backend → no fiat headline (avoids a
    // misleading "$0.00" when quotes are all null).
    if (!showFiat) return null;
    if (session?.error) return '—';
    if (!balances || !prices) return null;
    // Headline shows total wealth on chain (confirmed + pending +
    // locked). We deliberately do NOT subtract pendingOutgoing here:
    // doing so would double-count for the ~2 min window between LWS
    // picking up the spend and the entry aging out — legacy commit
    // 839e001's exact failure mode. The user instead sees the in-flight
    // amount in the `sending` subtitle and on each asset row, while
    // the headline reflects the natural LWS state.
    const usd = totalFiat(balances, prices, decimalsByAsset);
    return formatUsd(usd);
  })();
  // Note: the headline used to surface aggregated pending/locked/
  // sending here as a fiat subtitle (`+ $X pending · 🔒 $Y locked`).
  // Pulled in 2026-05-13 — the per-asset rows already show which
  // coin has what state, which is strictly more useful than the
  // wallet-wide aggregate. Removing it also cures a popup scrollbar
  // that appeared when the subtitle pushed the headline card past
  // the popup's natural height. `pendingFiat` / `lockedFiat` remain
  // in `@smirk/core` for shells (mobile, desktop) that want them.

  // Collect any asset that LWS reports as still catching up. These
  // are the wallets where the displayed balance is provisional until
  // the scanner reaches the chain tip — and where "0" is "waiting"
  // rather than "broken". UX needs to make that distinction obvious.
  const scanningAssets = balances
    ? (Object.entries(balances) as Array<[string, { scanProgress?: { scannedHeight: number; blockchainHeight: number; fraction: number } }]>).filter(
        ([, b]) => b.scanProgress !== undefined,
      )
    : [];

  return (
    <HomeTab
      balance={{
        totalDisplay,
        denominationLabel: showFiat && balances ? 'USD' : '',
        hidden: balancesHidden,
        onToggleHidden: toggleBalancesHidden,
        // onCycleDenomination intentionally omitted — UnifiedBalance
        // suppresses the pointer cursor when the handler is absent so
        // users don't get a misleading "click me" affordance. Wire
        // this when denomination cycling lands (tracked for v0.3.x).
        loading: session?.refreshing ?? false,
        // Escalating freshness cue: subtle "updating" dot on a live refresh,
        // amber warning after 30s of failed refreshes, red error after 60s.
        // Time-since-last-success based, so a single blip stays quiet.
        freshness: {
          refreshing: session?.refreshing ?? false,
          lastSuccessAt: session?.lastSuccessAt ?? session?.refreshedAt?.getTime() ?? null,
          lastAttemptFailed: session?.lastRefreshFailed ?? false,
        },
      }}
      actions={{
        // Tip is opt-in: hidden when the backend advertises no social tips.
        showTip,
        onTip: () => void navigate('home/tip'),
        onSend: () => void navigate('home/send'),
        onReceive: () => void navigate('home/receive'),
        onSwap: () => void switchTab('swap'),
      }}
      assets={visibleAssetIds(sessionState, listAssets(), caps).map((a) => {
        const b = (balances as Record<string, { confirmed: bigint; pending: bigint; locked?: bigint } | undefined> | undefined)?.[a.id];
        const hasLockedConcept =
          a.id === 'xmr' || a.id === 'wow' || a.id === 'grin';
        // Defense-in-depth: for chains with a `locked` concept, once
        // LWS reflects the spend (locked > 0), the change output is
        // already on-chain & accounted for. Suppress all in-flight
        // adjustments — subtracting on top would double-count, the
        // legacy-839e001 failure mode.
        const lwsReflectsSpend =
          hasLockedConcept &&
          b !== undefined &&
          b.locked !== undefined &&
          b.locked > 0n;
        const entries = sessionState.pendingOutgoing ?? [];
        const sendingAmount = lwsReflectsSpend
          ? 0n
          : pendingOutgoingTotalWithFee(entries, a.id);
        // For CryptoNote/Grin during in-flight: subtract the entire
        // input total from displayed-available (change isn't spendable
        // until lock window passes), and add (inputsTotal − amount −
        // fee) to displayed-locked as the expected change. For UTXO:
        // change is immediately spendable, so subtract only amount+fee.
        const availableDeduction =
          !lwsReflectsSpend && hasLockedConcept
            ? inFlightInputsTotal(entries, a.id)
            : sendingAmount;
        const expectedLocked =
          !lwsReflectsSpend && hasLockedConcept
            ? expectedLockedChange(entries, a.id)
            : 0n;
        const rawConfirmed = b ? b.confirmed : 0n;
        const rawLocked = b && b.locked !== undefined ? b.locked : 0n;
        const displayedConfirmed =
          rawConfirmed - availableDeduction < 0n
            ? 0n
            : rawConfirmed - availableDeduction;
        const displayedLocked = rawLocked + expectedLocked;
        return {
          assetId: a.id,
          balanceAtomic: displayedConfirmed,
          ...(b && b.pending > 0n ? { pendingAtomic: b.pending } : {}),
          ...(displayedLocked > 0n ? { lockedAtomic: displayedLocked } : {}),
          ...(sendingAmount > 0n ? { sendingAtomic: sendingAmount } : {}),
          loading: !balances && session?.refreshing === true,
          hidden: balancesHidden,
        };
      })}
      onAssetClick={(id) => void navigate(`home/asset/${id}`)}
      resolveIcon={resolveIcon}
      topNotice={
        <>
          {nostrLinkPrompt && (
            <div
              data-testid="nostr-link-consent"
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                padding: '10px 12px',
                borderRadius: 8,
                marginBottom: 8,
                background: 'var(--smirk-bg-sunken)',
                border: '1px solid var(--smirk-border)',
                color: 'var(--smirk-fg-muted)',
              }}
            >
              <div>
                Link your Nostr identity to <b>@{nostrLinkPrompt}</b>? This publishes{' '}
                <b>
                  {nostrLinkPrompt}@{instanceHomeDomain()}
                </b>{' '}
                so people can find and message you. Your npub is public; your keys stay
                on your device.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => void confirmNostrLink()}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 8,
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: 'var(--smirk-accent)',
                    color: 'var(--smirk-accent-fg, #1a1a1a)',
                  }}
                >
                  Link
                </button>
                <button
                  onClick={declineNostrLink}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: 'transparent',
                    color: 'var(--smirk-fg-muted)',
                    border: '1px solid var(--smirk-border)',
                  }}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
          {(() => {
            // Sustained-failure warning: balances stayed stale past the threshold,
            // so the numbers on screen are last-known, not live. See
            // balancesStaleSince / BALANCE_STALE_WARN_MS.
            const since = session?.balancesStaleSince ?? null;
            if (!since || Date.now() - since < BALANCE_STALE_WARN_MS) return null;
            const mins = Math.floor((Date.now() - since) / 60_000);
            return (
              <div
                data-testid="balance-stale-warning"
                style={{
                  fontSize: 12,
                  lineHeight: 1.4,
                  padding: '8px 12px',
                  borderRadius: 8,
                  marginBottom: 8,
                  background: 'var(--smirk-bg-sunken)',
                  border: '1px solid var(--smirk-warning, #b8860b)',
                  color: 'var(--smirk-fg-muted)',
                }}
              >
                ⚠ Couldn't reach the backend for {mins} min — showing your last-known
                balances. They'll update as soon as the connection recovers.
              </div>
            );
          })()}
          {(() => {
            const claimable = tips.filter(
              (t) => t.fundingConfirmations >= t.confirmationsRequired,
            );
            if (claimable.length === 0) return null;
            const single = claimable.length === 1 ? claimable[0] : undefined;
            return (
              <ClaimableTipsBanner
                count={claimable.length}
                {...(single
                  ? {
                      singleTip: {
                        assetId: single.assetId,
                        amountAtomic: single.amountAtomic,
                      },
                    }
                  : {})}
                onView={() => void switchTab('inbox')}
              />
            );
          })()}
          <ReadyToShareTipsBanner
            count={readyToShareCount}
            onView={() => void navigate('settings/sent-tips')}
          />
          {scanningAssets.length > 0 ? (
            <ScanProgressBanner
              entries={scanningAssets.map(([assetId, b]) => ({
                assetId,
                ...b.scanProgress!,
              }))}
              refreshedAt={session?.refreshedAt ?? null}
            />
          ) : null}
        </>
      }
      footer={
        session?.error ? (
          <div
            style={{
              fontSize: 11,
              color: '#ff6b6b',
              textAlign: 'center',
              padding: '6px 0',
            }}
          >
            {session.error}
          </div>
        ) : null
      }
    />
  );
}


/** Format a USD amount with thousands separators and 2-decimal precision. */
// ----- Stubbed wallet ops (replaced incrementally) -----
//
// SECURITY GUARD: stubs accept anything that resembles a string and return
// fake success — they exist purely so the popup can be exercised visually
// before the real wallet wiring lands. They MUST NOT ship in a release
// build. The block below trips at module-load time when the build sets
// `VITE_SMIRK_RELEASE=true` (only set by the release pipeline, never by
// `npm run build:chrome` during development). Vite replaces the env
// access with a literal at build time, so the throw becomes a real
// top-level throw and Chrome refuses to load the extension.
if (import.meta.env.VITE_SMIRK_RELEASE === 'true') {
  throw new Error(
    '[smirk] stub wallet ops detected in a release build. Replace ' +
      'stubValidateAddress / stubSubmit / stubResolveAddress with real ' +
      'wallet wiring before shipping. (See docs/SECURITY_AUDIT.md M2.)',
  );
}


// ============================================================================
// Approval mode — the SW opens us as a standalone popup window with URL
// `popup.html#approval/<id>` when a dapp asks for user consent. We mount
// `<ApprovalApp />` instead of the normal `<App />` in that case. Same
// build, same wallet singletons, different UI.
// ============================================================================

/** Parse the approval id from `window.location.hash`, or null. */
function parseApprovalId(): string | null {
  const h = window.location.hash || '';
  const m = h.match(/^#approval\/([A-Za-z0-9_-]+)/);
  return m && m[1] ? m[1] : null;
}


// signMessage logic moved to `../dapp-popup/signers.ts` and is
// invoked by `executeApproval`. Same code, single source of truth,
// reused by the desktop BrowseTab modal.

// Configure the API backend before the UI bootstraps: build default → durable
// user selection → re-applied on a cross-context switch. See backend-boot.ts.
bootBackendSelection();

const root = document.getElementById('root');
if (root) {
  const approvalId = parseApprovalId();
  if (approvalId) {
    render(<ApprovalApp approvalId={approvalId} />, root);
  } else {
    render(<App />, root);
  }
}
