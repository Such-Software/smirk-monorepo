/**
 * Smirk popup — Phase 3.
 *
 * Real `HomeTab` with action row, `SendWizard` and `ReceiveScreen`
 * wired in as drill-downs from Home (`home/send`, `home/receive`).
 *
 * Data is stubbed for visual-smoke purposes — zero balances, allow-all
 * address validation, fake submit. Real wallet wiring (key derivation,
 * balances from LWS, signing, broadcast) lands incrementally; the UI
 * surface is what we wanted to verify visually first.
 */

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  ChromeLocalStorage,
  ChromeSessionStorage,
  SessionStateStore,
  RouteController,
  SESSION_CACHE_KEY,
  WalletKeystore,
  api,
  bootstrapAuth,
  fetchAllBalances,
  visibleAssetIds,
  withAssetVisibility,
  fetchPrices,
  generateMnemonicPhrase,
  isValidBtcAddress,
  isValidGrinSlatepackAddress,
  isValidLtcAddress,
  isValidMnemonic,
  isValidWowAddress,
  isValidXmrAddress,
  rebuildUnlockedFromMnemonic,
  totalFiat,
  pendingOutgoingTotalWithFee,
  inFlightInputsTotal,
  expectedLockedChange,
  isPendingOutgoingStale,
  recentlySpentInputs,
  reconcilePendingOutgoing,
  type Balances,
  type BootstrapAuthResult,
  type Prices,
  type SessionCacheEntry,
  type UnlockedWallet,
  type WalletState,
} from '@smirk/core';
import {
  AppShell,
  ApprovalScreen,
  AssetDetailScreen,
  GrinPasteIncomingWizard,
  GrinPayInvoiceWizard,
  GrinRequestWizard,
  HomeTab,
  InboxTab,
  LockScreen,
  OnboardingWizard,
  ReceiveScreen,
  SendWizard,
  StateProvider,
  TipMaker,
  applyTheme,
  defaultTheme,
  getTheme,
  listThemes,
  useRoute,
  useSessionState,
  type ApprovalRequest as UiApprovalRequest,
  type ApprovalApproval,
  type AssetDetailTxRow,
  type InboxItem,
  type InboxTipItem,
  type RecentRecipient,
  type SparklinePoint,
} from '@smirk/ui';
import { listAssets, mustGetAsset } from '@smirk/assets';
import { send } from './send-handler';
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
} from './grin-flows';
import { dispatchSocialTip } from './tip-handler';
import { claimSocialTip } from './tip-claim-handler';
import { listTipKeyBackups, removeTipKeyBackup } from './tip-key-backup';
import {
  writeDappPublicCache,
  clearDappPublicCache,
  type DappPublicCache,
} from '../background/dapp/provider';
import { approvalPopupBridge, type PendingApproval } from '../background/dapp/approval';
import { isInjectDisabled, setInjectDisabled } from '../background/dapp/inject-policy';
import type {
  ApprovalResult as DappApprovalResult,
  SmirkAddresses,
  SmirkPublicKeys,
  SmirkSignResult,
} from '@smirk/dapp-api';
import { signBitcoinMessage, signEd25519WithScalar } from '@smirk/core';
import {
  initialize as initSmirkWasm,
  monero as wasmMonero,
  grin as wasmGrin,
} from '@smirk/wasm';

/**
 * Lazy WASM-init verifier: defers `initSmirkWasm()` until the first
 * spent-output verification call. We don't block the popup's first
 * paint on WASM (~150-200KB) — load on demand when balance fetch
 * actually needs it.
 *
 * The no-modules glue can't auto-resolve the .wasm URL when bundled into
 * a `<script type="module">` (document.currentScript is null for module
 * scripts), so we pass the extension-relative URL explicitly.
 */
let wasmInitPromise: Promise<void> | null = null;
function ensureWasmInit(): Promise<void> {
  if (!wasmInitPromise) {
    const wasmUrl = chrome.runtime.getURL('wasm/smirk_wasm_bg.wasm');
    wasmInitPromise = initSmirkWasm(wasmUrl);
  }
  return wasmInitPromise;
}

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
 * Pull the user's pending Grin slatepacks from the relay and shape them
 * for the InboxTab component. Shared by the 30-second poll loop and the
 * manual refresh handler in InboxRouter.
 */
/**
 * Pull recent tip recipients from the current session's sent-tips
 * history. Sorts newest-first and dedupes by platform+username so the
 * TipMaker's chip row stays tight even when a user has tipped @bob 12
 * times.
 *
 * Returns [] when session isn't loaded yet — TipMaker just renders
 * without the "Recent" row in that case.
 */
function recentTipRecipients(
  session: WalletSession | null,
): RecentRecipient[] {
  // Future: pull from `session.sentTips` once we cache them. For now
  // start empty; the TipMaker renders fine without recents and the
  // user can type the username directly. Populated in the next commit
  // when we wire api.getSentSocialTips on bootstrap.
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

/** Returns true iff a `pending` tip's funding has stalled — zero
 *  confirmations beyond a generous wall-clock cutoff. Used to drop
 *  abandoned tips from the Inbox and per-asset history. */
const STALE_TIP_NO_CONF_MS = 24 * 60 * 60 * 1000;
function isTipStale(
  fundingConfirmations: number,
  createdAtIso: string,
): boolean {
  if (fundingConfirmations > 0) return false;
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return false;
  return Date.now() - created > STALE_TIP_NO_CONF_MS;
}

async function fetchGrinInbox(userId: string): Promise<{
  items: InboxItem[];
  loading: boolean;
  error: string | null;
}> {
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

const verifyKeyImage = async ({
  privateViewKeyHex,
  privateSpendKeyHex,
  txPubKeyHex,
  outputIndex,
}: {
  privateViewKeyHex: string;
  privateSpendKeyHex: string;
  txPubKeyHex: string;
  outputIndex: number;
}): Promise<string> => {
  await ensureWasmInit();
  const resultJson = wasmMonero.computeKeyImage(
    privateViewKeyHex,
    privateSpendKeyHex,
    txPubKeyHex,
    outputIndex,
  );
  const result = JSON.parse(resultJson) as { success: boolean; data?: string; error?: string };
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'compute_key_image failed');
  }
  return result.data;
};

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Project an `UnlockedWallet` into the public-material shape the
 * background SW reads when servicing dapp `getPublicKeys` /
 * `getAddresses` calls. Public material only — no private bytes
 * leave this function. Written into `chrome.storage.local` on every
 * unlock transition; cleared on lock / destroy.
 */
function dappPublicCacheFor(wallet: UnlockedWallet): DappPublicCache {
  const publicKeys: SmirkPublicKeys = {
    btc: bytesToHex(wallet.keys.btc.publicKey),
    ltc: bytesToHex(wallet.keys.ltc.publicKey),
    // CryptoNote: dapps that need to verify "this address corresponds
    // to that pubkey" use the public *spend* key, the same field
    // bootstrapAuth sends to the backend's key-list (see
    // `wallet-flow.ts buildKeysList`).
    xmr: bytesToHex(wallet.keys.xmr.publicSpendKey),
    wow: bytesToHex(wallet.keys.wow.publicSpendKey),
    grin: bytesToHex(wallet.keys.grin.publicKey),
  };
  const addresses: SmirkAddresses = {
    btc: wallet.addresses.btc,
    ltc: wallet.addresses.ltc,
    xmr: wallet.addresses.xmr,
    wow: wallet.addresses.wow,
    grin: wallet.addresses.grin,
  };
  return {
    fingerprint: wallet.fingerprint,
    addresses,
    publicKeys,
    unlockedAt: Date.now(),
  };
}

/**
 * Map asset registry `iconKey` → bundled coin SVG path. The extension
 * package owns its own icon assets; `@smirk/ui` stays asset-free.
 */
const ICON_BY_KEY: Record<string, string> = {
  btc: 'icons/coins/bitcoin.svg',
  ltc: 'icons/coins/litecoin.svg',
  xmr: 'icons/coins/monero.svg',
  wow: 'icons/coins/wownero.svg',
  grin: 'icons/coins/grin.svg',
};
const resolveIcon = (key: string): string | undefined =>
  ICON_BY_KEY[key] ? chrome.runtime.getURL(ICON_BY_KEY[key]) : undefined;

// Session-state storage. Even though it's called "session" semantically,
// the user preferences it holds (autoLockMinutes, theme, denomination,
// balanceHidden) are real preferences — they must survive browser
// restart. So we back on chrome.storage.local, not chrome.storage.session.
//
// The schema currently has no sensitive-ephemeral fields (no
// password-mid-typing, etc.); wizards hold form fields like recipient
// address and amount, which are not privacy-regressing if persisted.
// If sensitive ephemeral state lands later, it should get its own
// session-tier store rather than co-mingle here.
const storage = new ChromeLocalStorage();
const store = new SessionStateStore(storage);
const router = new RouteController(store);

/**
 * Persistent encrypted-keystore storage. Lives in `chrome.storage.local`
 * — survives browser restart, NEVER holds plaintext seed material
 * (the seed is XChaCha20-Poly1305 encrypted under a PBKDF2-stretched
 * password before write). On MV3 service-worker restart, the in-memory
 * unlocked state is lost and the user re-enters their password — see
 * `docs/SECURITY_AUDIT.md` for the audit-backed rationale.
 */
const walletKeystore = new WalletKeystore(new ChromeLocalStorage());

/**
 * Ephemeral cache for the unlocked mnemonic, used by the opt-in
 * "stay unlocked for N minutes" Settings feature. Cleared on browser
 * close. Default behavior (autoLockMinutes = 0) writes nothing here —
 * the seed never leaves popup-process memory.
 */
const sessionStorage = new ChromeSessionStorage();

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

/**
 * Live wallet session — auth bootstrap + fetched balances. Re-derived
 * whenever the user unlocks (or transitions empty → unlocked via
 * onboarding). Lives in module memory only; SW restart drops it and
 * the user re-enters their password. Per the audit posture: no
 * persistent JWT.
 */
interface WalletSession {
  bootstrap: BootstrapAuthResult;
  balances: Balances | null;
  prices: Prices | null;
  /** Top-level fetch error (auth failure, network down). Per-asset errors live on AssetBalance. */
  error: string | null;
  /** True while a balance refresh is in flight, for UI spinners. */
  refreshing: boolean;
  /** When the latest successful balance fetch completed. */
  refreshedAt: Date | null;
}

/**
 * Try to restore a previously-cached unlocked wallet from
 * `chrome.storage.session`. Returns `null` if the cache is empty,
 * expired, malformed, or the wallet keystore's fingerprint doesn't
 * match (defensive: a re-imported wallet should NOT be auto-unlocked
 * from another wallet's cache).
 *
 * On a successful restore, writes the wallet back into
 * `walletKeystore.cached` so the rest of the app treats the state as
 * normally-unlocked.
 */
async function tryRestoreSessionCache(): Promise<UnlockedWallet | null> {
  const raw = await sessionStorage.get(SESSION_CACHE_KEY);
  if (!raw) return null;
  if (typeof raw !== 'object') return null;
  const entry = raw as Partial<SessionCacheEntry>;
  if (
    typeof entry.mnemonic !== 'string' ||
    typeof entry.fingerprint !== 'string' ||
    typeof entry.expiresAtMs !== 'number'
  ) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  if (entry.expiresAtMs < NEVER_EXPIRES_MS && Date.now() >= entry.expiresAtMs) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  // Cross-check fingerprint against the keystore on disk — if the user
  // re-imported a different wallet, the stale cache must not unlock it.
  const ksState = await walletKeystore.getState();
  if (ksState.kind === 'empty' || ksState.keystore.fingerprint !== entry.fingerprint) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  try {
    const wallet = rebuildUnlockedFromMnemonic(entry.mnemonic, entry.fingerprint);
    (walletKeystore as unknown as { cached: UnlockedWallet }).cached = wallet;
    return wallet;
  } catch {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
}

/**
 * Sentinel for "never expires" (the `autoLockMinutes: -1` setting).
 * Avoiding `Infinity` because some serialization layers (notably
 * `JSON.stringify`) collapse it to `null`; chrome.storage.session
 * does preserve it via structured clone, but a plain bigint is
 * portable across any backend. ~year 285616 — safely never.
 */
const NEVER_EXPIRES_MS = Number.MAX_SAFE_INTEGER;

/** Persist the unlocked mnemonic for `minutes` of auto-unlock. */
async function writeSessionCache(wallet: UnlockedWallet, minutes: number): Promise<void> {
  if (minutes === 0) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return;
  }
  const expiresAtMs = minutes < 0 ? NEVER_EXPIRES_MS : Date.now() + minutes * 60_000;
  const entry: SessionCacheEntry = {
    mnemonic: wallet.mnemonic,
    fingerprint: wallet.fingerprint,
    expiresAtMs,
  };
  await sessionStorage.set(SESSION_CACHE_KEY, entry);
}

// ============================================================================
// Bootstrap (JWT + userId + LWS heights) cache — chrome.storage.session
// scoped, ~5 min TTL. Skipping the auth round-trip on every popup open
// shaves 1-2s off the warm-open feel; the cache dies on browser restart
// AND on wallet fingerprint change (defensive: a re-imported wallet
// must NOT inherit the previous wallet's JWT).
//
// Threat model: the access token is short-lived (server-controlled, ~1h),
// the storage tier is non-persistent (browser-session lifetime), and a
// stale-cache hit either succeeds (fast path) or surfaces an auth error
// which we recover from by clearing the cache and re-bootstrapping. No
// regression vs. the in-memory-only baseline that auditors signed off on
// for v0.2.x — the access token never touches chrome.storage.local
// (which IS persistent and IS the legacy anti-pattern).
// ============================================================================

const BOOTSTRAP_CACHE_KEY = 'smirk_bootstrap_cache_v1';
const BOOTSTRAP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface BootstrapCacheEntry {
  fingerprint: string;
  accessToken: string;
  bootstrap: BootstrapAuthResult;
  cachedAt: number;
}

async function readBootstrapCache(
  walletFingerprint: string,
): Promise<{ accessToken: string; bootstrap: BootstrapAuthResult } | null> {
  try {
    const raw = await sessionStorage.get(BOOTSTRAP_CACHE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as BootstrapCacheEntry;
    if (entry.fingerprint !== walletFingerprint) return null;
    if (Date.now() - entry.cachedAt > BOOTSTRAP_CACHE_TTL_MS) return null;
    if (!entry.accessToken || !entry.bootstrap?.userId) return null;
    return { accessToken: entry.accessToken, bootstrap: entry.bootstrap };
  } catch {
    return null;
  }
}

async function writeBootstrapCache(
  walletFingerprint: string,
  accessToken: string,
  bootstrap: BootstrapAuthResult,
): Promise<void> {
  const entry: BootstrapCacheEntry = {
    fingerprint: walletFingerprint,
    accessToken,
    bootstrap,
    cachedAt: Date.now(),
  };
  try {
    await sessionStorage.set(BOOTSTRAP_CACHE_KEY, entry);
  } catch (e) {
    console.warn('[smirk] bootstrap cache write failed', e);
  }
}

async function clearBootstrapCache(): Promise<void> {
  try {
    await sessionStorage.remove(BOOTSTRAP_CACHE_KEY);
  } catch {
    /* best-effort */
  }
}

function App() {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [grinInbox, setGrinInbox] = useState<{
    items: InboxItem[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: false, error: null });
  const [tipInbox, setTipInbox] = useState<{
    tips: InboxTipItem[];
    error: string | null;
  }>({ tips: [], error: null });

  // Refresh from the keystore. Called on mount and after every state
  // transition (create / unlock / lock / destroy) so the gate re-renders.
  // Also opportunistically restores a non-expired session cache.
  const refresh = async () => {
    await tryRestoreSessionCache();
    setWalletState(await walletKeystore.getState());
  };

  /**
   * Auth + initial balance fetch + price fetch. Called when the wallet
   * transitions to `unlocked` (either fresh creation or unlock).
   * Balances and prices fire in parallel after auth completes.
   */
  const startSession = async (wallet: UnlockedWallet) => {
    setSession((prev) => prev ?? ({} as WalletSession));
    try {
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
        bootstrap = await bootstrapAuth(api, wallet);
        const tok = api.getAccessToken();
        if (tok) {
          await writeBootstrapCache(wallet.fingerprint, tok, bootstrap);
        }
      }
      const [balances, prices] = await Promise.all([
        (async () => {
          // Read the user's hidden-asset preference NOW so balance
          // polling skips network round-trips for hidden assets.
          // We re-read on every refresh so toggles in Settings take
          // effect on the next poll without needing a popup remount.
          const visible = visibleAssetIds(await store.load(), listAssets()).map(
            (a) => a.id,
          );
          return fetchAllBalances(api, wallet, bootstrap, {
            verifyKeyImage,
            visibleAssetIds: visible,
          });
        })(),
        fetchPrices(api),
      ]);
      setSession({
        bootstrap,
        balances,
        prices,
        error: null,
        refreshing: false,
        refreshedAt: new Date(),
      });
    } catch (e) {
      // If a warm-path balance call rejected (auth error), drop the
      // cache and force a fresh bootstrap on the next render. Surface
      // the error so the user sees something rather than a silent
      // empty state.
      await clearBootstrapCache();
      setSession({
        bootstrap: { userId: '', isNew: false },
        balances: null,
        prices: null,
        error: e instanceof Error ? e.message : 'Failed to connect to backend',
        refreshing: false,
        refreshedAt: null,
      });
    }
  };

  /** Refresh balances + prices — assumes a session already exists. */
  const refreshBalances = async (wallet: UnlockedWallet, bootstrap: BootstrapAuthResult) => {
    setSession((prev) => (prev ? { ...prev, refreshing: true } : prev));
    try {
      const [balances, prices] = await Promise.all([
        (async () => {
          // Read the user's hidden-asset preference NOW so balance
          // polling skips network round-trips for hidden assets.
          // We re-read on every refresh so toggles in Settings take
          // effect on the next poll without needing a popup remount.
          const visible = visibleAssetIds(await store.load(), listAssets()).map(
            (a) => a.id,
          );
          return fetchAllBalances(api, wallet, bootstrap, {
            verifyKeyImage,
            visibleAssetIds: visible,
          });
        })(),
        fetchPrices(api),
      ]);
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
      setSession((prev) =>
        prev
          ? { ...prev, balances, prices, error: null, refreshing: false, refreshedAt: new Date() }
          : prev,
      );
    } catch (e) {
      setSession((prev) =>
        prev
          ? {
              ...prev,
              error: e instanceof Error ? e.message : 'Refresh failed',
              refreshing: false,
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
      try {
        const canonical = canonicalGrinSlatepackAddress(mnemonic);
        const res = await api.registerGrinAddress(canonical);
        if (res.error) {
          console.warn('[smirk-popup] register canonical grin address rejected:', res.error);
        } else {
          console.info('[smirk-popup] registered canonical grin address:', canonical);
        }
      } catch (e) {
        console.warn('[smirk-popup] register canonical grin address threw:', e);
      }
    })();
  }, [walletState, session?.bootstrap?.userId]);

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
      const grinHidden = (sess.ui.hiddenAssets ?? []).includes('grin');
      const [nextGrin, nextTips] = await Promise.all([
        grinHidden
          ? Promise.resolve({ items: [], loading: false, error: null })
          : fetchGrinInbox(userId),
        fetchTipInbox().catch((e) => ({
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
  useEffect(() => {
    if (walletState?.kind === 'unlocked') {
      void writeDappPublicCache(dappPublicCacheFor(walletState.wallet));
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

  if (walletState.kind === 'empty') {
    return (
      <OnboardingWizard
        generateMnemonic={generateMnemonicPhrase}
        isValidMnemonic={isValidMnemonic}
        onComplete={async (mnemonic, password) => {
          const wallet = await walletKeystore.createWallet({ mnemonic, password });
          // Respect the user's stored auto-lock preference, if any was
          // set previously. For a brand-new wallet this is normally the
          // default `0` (immediate), so no session cache is written.
          const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
          await writeSessionCache(wallet, minutes);
          // Bootstrap NOW so the wizard's setup step has a valid JWT
          // for handle-reservation. We don't `refresh()` here yet —
          // walletState stays `empty` so the wizard keeps owning the
          // screen through its setup step. `onFullyDone` below flips
          // it to `unlocked` after the user is done.
          //
          // The standard `startSession` effect (fires when walletState
          // becomes unlocked) will re-bootstrap once that happens;
          // idempotent on the backend, costs one extra round-trip we
          // can pay once at onboarding.
          await bootstrapAuth(api, wallet);
        }}
        reserveSmirkName={async (handle) => {
          const res = await api.setMySmirkUsername(handle);
          if (res.error) {
            throw new Error(res.error);
          }
        }}
        setInjectEnabled={async (enabled) => {
          await setInjectDisabled(!enabled);
        }}
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
          await refresh();
        }}
      />
    );
  }

  // walletState.kind === 'unlocked'
  const lockHandler = async () => {
    await sessionStorage.remove(SESSION_CACHE_KEY);
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
        : fetchGrinInbox(userId),
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
            <RefreshIconButton
              busy={session.refreshing}
              onClick={() => void handleRefresh()}
            />
          ) : null
        }
        routes={{
          home: (
            <HomeRouter
              wallet={walletState.wallet}
              session={session}
              onRefresh={handleRefresh}
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
          swap: <SwapStub />,
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
          settings: (
            <SettingsStub
              onLock={lockHandler}
              onForgetComplete={async () => {
                await sessionStorage.remove(SESSION_CACHE_KEY);
                await clearBootstrapCache();
                await clearDappPublicCache();
                await walletKeystore.destroy();
                await refresh();
              }}
            />
          ),
        }}
      />
    </StateProvider>
  );
}

/** Circular ↻ button next to the pop-out icon in the AppShell header. */
function RefreshIconButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-label="Refresh balances"
      title="Refresh balances"
      style={{
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: busy ? 'wait' : 'pointer',
        fontSize: 14,
        padding: '4px 8px',
        opacity: busy ? 0.4 : 0.75,
        // Slow rotation while a refresh is in flight.
        animation: busy ? 'smirk-spin 1s linear infinite' : 'none',
      }}
    >
      ↻
    </button>
  );
}

// ----- Home & its drill-downs -----

function HomeRouter({
  wallet,
  session,
  onRefresh: _onRefresh,
  onTipClaim,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Reserved — pull-to-refresh on Home will call this. Header refresh button uses it directly. */
  onRefresh: () => Promise<void>;
  /** Claim a tip from an asset-detail row. Threaded through to
   *  `AssetDetailRoute` so the per-row Claim button fires the same
   *  sweep logic as the InboxTab "Claim" affordance. */
  onTipClaim?: (
    tipId: string,
    assetId: InboxTipItem['assetId'],
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { route, navigate, switchTab } = useRoute();
  const sessionState = useSessionState();
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
        assetIds={visibleAssetIds(sessionState, listAssets())
          .filter((a) => a.sendable)
          .map((a) => a.id)}
        validateAddress={validateAddress}
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
          const r = await api.estimateFee(assetId);
          if (r.error || !r.data) {
            throw new Error(r.error ?? 'Failed to fetch fee rates');
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
            const grinUserId = session?.bootstrap?.userId;
            if (!grinUserId) return null;
            const outs = await api.getGrinOutputs(grinUserId);
            if (outs.error || !outs.data) return null;
            const spendable = outs.data.outputs
              .filter((o) => o.status === 'unspent')
              .sort((a, b) => b.amount - a.amount);
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
          const unspent = await api.getUnspentOuts(assetId, fromAddress, viewKeyHex);
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
          // (Phase 2C piece 1: mempool double-spend prevention.)
          const excludeInputs = recentlySpentInputs(
            sessionState.pendingOutgoing ?? [],
            fields.fromAssetId,
          );
          const result = await send(wallet, fields, excludeInputs);
          if (result.ok && result.amountAtomic !== undefined && result.feeAtomic !== undefined) {
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
            };
            await store.update((s) => {
              s.pendingOutgoing.push(entry);
              const w = s.wizards.send;
              if (w) {
                w.fields.lastTxid = result.txid;
              }
            });
          }
          return result;
        }}
        onGrinBuildSlate={async ({ amountAtomic, toAddress }) => {
          // Resolve mnemonic + wallet's slatepack address.
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          await ensureWasmInit();
          // Smirk-to-Smirk auto-detect (look up recipient address →
          // user_id, drop slatepack at relay) lands in Phase 3.3 when
          // the address-to-user endpoint is wired through the API
          // client. For now, every Grin send is clipboard-mode; the
          // recipient pastes our S1 into their wallet and pastes the
          // S2 response back.
          const recipientUserId: string | undefined = undefined;
          try {
            const result = await startGrinSend({
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              senderSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              recipientSlatepackAddress: toAddress,
              ...(recipientUserId ? { recipientUserId } : {}),
              amount: Number(amountAtomic),
              resolver: {
                fetchSpendable: async () => {
                  const r = await api.getGrinOutputs(grinUserId);
                  if (r.error || !r.data) {
                    throw new Error(r.error ?? 'Failed to fetch Grin outputs');
                  }
                  return {
                    outputs: r.data.outputs
                      .filter((o) => o.status === 'unspent')
                      .map((o) => ({
                        id: o.id,
                        key_id: o.key_id,
                        n_child: o.n_child,
                        amount: o.amount,
                        commitment: o.commitment,
                        is_coinbase: o.is_coinbase,
                      })),
                    next_child_index: r.data.next_child_index,
                  };
                },
              },
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
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onGrinFinalize={async ({ s2, senderContextJson, senderInputsJson, changeOutputJson, relayId }) => {
          if (!wallet.mnemonic) {
            return { ok: false, error: 'Wallet not unlocked' };
          }
          try {
            const result = await processGrinS2({
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              s2,
              sender_context_json: senderContextJson,
              sender_inputs: JSON.parse(senderInputsJson),
              ...(changeOutputJson ? { change_output: JSON.parse(changeOutputJson) } : {}),
              ...(relayId ? { relay_id: relayId } : {}),
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
          await cancelGrinSend({
            userId: grinUserId,
            slate_id: slateId,
            ...(relayId ? { relay_id: relayId } : {}),
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
        assetIds={visibleAssetIds(sessionState, listAssets())
          .filter((a) => a.receivable)
          .map((a) => a.id)}
        resolveAddress={(assetId) => resolveAddressForAsset(wallet, assetId)}
        onCopy={(text) => void navigator.clipboard.writeText(text)}
        onExit={() => void navigate('home')}
        resolveIcon={resolveIcon}
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              receiverSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              amount: Number(amountAtomic),
              fee: Number(feeAtomic),
              resolver: {
                fetchSpendable: async () => {
                  const r = await api.getGrinOutputs(grinUserId);
                  if (r.error || !r.data) {
                    throw new Error(r.error ?? 'Failed to fetch Grin outputs');
                  }
                  return {
                    outputs: r.data.outputs
                      .filter((o) => o.status === 'unspent')
                      .map((o) => ({
                        id: o.id,
                        key_id: o.key_id,
                        n_child: o.n_child,
                        amount: o.amount,
                        commitment: o.commitment,
                        is_coinbase: o.is_coinbase,
                      })),
                    next_child_index: r.data.next_child_index,
                  };
                },
              },
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              i2,
              receiver_context_json: receiverContextJson,
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
          // Phase 3.5 will add server-side unlock-reserved-output cleanup.
          // For now, mark cancelled on backend so it stops appearing in
          // pending lists.
          await api
            .updateGrinTransaction({
              userId: grinUserId,
              slateId,
              status: 'cancelled',
            })
            .catch(() => undefined);
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              receiverSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              s1Armored,
              resolver: {
                fetchSpendable: async () => {
                  const r = await api.getGrinOutputs(grinUserId);
                  if (r.error || !r.data) {
                    throw new Error(r.error ?? 'Failed to fetch Grin outputs');
                  }
                  return {
                    outputs: r.data.outputs
                      .filter((o) => o.status === 'unspent')
                      .map((o) => ({
                        id: o.id,
                        key_id: o.key_id,
                        n_child: o.n_child,
                        amount: o.amount,
                        commitment: o.commitment,
                        is_coinbase: o.is_coinbase,
                      })),
                    next_child_index: r.data.next_child_index,
                  };
                },
              },
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
            let relayDeliveryFailed = false;
            if (relayId) {
              const relayRes = await api
                .signGrinSlatepack({
                  relayId,
                  userId: grinUserId,
                  signedSlatepack: signed.s2_armored,
                })
                .catch((err) => {
                  console.warn('[smirk-popup] signGrinSlatepack threw:', err);
                  return { error: err instanceof Error ? err.message : 'Relay delivery failed' };
                });
              if (relayRes && 'error' in relayRes && relayRes.error) {
                console.warn(
                  '[smirk-popup] signGrinSlatepack rejected:',
                  relayRes.error,
                );
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              payerSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              i1Armored,
              resolver: {
                fetchSpendable: async () => {
                  const r = await api.getGrinOutputs(grinUserId);
                  if (r.error || !r.data) {
                    throw new Error(r.error ?? 'Failed to fetch Grin outputs');
                  }
                  return {
                    outputs: r.data.outputs
                      .filter((o) => o.status === 'unspent')
                      .map((o) => ({
                        id: o.id,
                        key_id: o.key_id,
                        n_child: o.n_child,
                        amount: o.amount,
                        commitment: o.commitment,
                        is_coinbase: o.is_coinbase,
                      })),
                    next_child_index: r.data.next_child_index,
                  };
                },
              },
            });
            // See `signGrinSlatepack` rationale at the receiver-S2
            // handler above — receiver is in a valid state regardless,
            // surface a flag for the UI to render a fallback hint.
            let relayDeliveryFailed = false;
            if (relayId) {
              const relayRes = await api
                .signGrinSlatepack({
                  relayId,
                  userId: grinUserId,
                  signedSlatepack: signed.armored,
                })
                .catch((err) => {
                  console.warn('[smirk-popup] signGrinSlatepack (i2) threw:', err);
                  return { error: err instanceof Error ? err.message : 'Relay delivery failed' };
                });
              if (relayRes && 'error' in relayRes && relayRes.error) {
                console.warn(
                  '[smirk-popup] signGrinSlatepack (i2) rejected:',
                  relayRes.error,
                );
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
        assetIds={visibleAssetIds(sessionState, listAssets())
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
          // BTC/LTC fully wired below. XMR/WOW + Grin currently surface
          // a "ships next commit" error inside the dispatcher.
          return dispatchSocialTip({
            wallet,
            senderUserId: grinUserId,
            fields,
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
  const balances = session?.balances;
  const prices = session?.prices;
  const decimalsByAsset: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    for (const a of listAssets()) m[a.id] = a.decimals;
    return m;
  })();
  const totalDisplay = (() => {
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
        denominationLabel: balances ? 'USD' : '',
        hidden: balancesHidden,
        onToggleHidden: toggleBalancesHidden,
        onCycleDenomination: () => {
          // TODO: cycle denomination once price-feed wiring lands.
        },
        loading: session?.refreshing ?? false,
      }}
      actions={{
        onTip: () => void navigate('home/tip'),
        onSend: () => void navigate('home/send'),
        onReceive: () => void navigate('home/receive'),
        onSwap: () => void switchTab('swap'),
      }}
      assets={visibleAssetIds(sessionState, listAssets()).map((a) => {
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
        scanningAssets.length > 0 ? (
          <ScanProgressBanner
            entries={scanningAssets.map(([assetId, b]) => ({
              assetId,
              ...b.scanProgress!,
            }))}
            refreshedAt={session?.refreshedAt ?? null}
          />
        ) : null
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

/**
 * Banner shown above the asset list when LWS is still catching up on
 * one or more assets. Without this, a user whose wallet is mid-rescan
 * sees "0 XMR" and can't tell whether it's a bug, a derivation issue,
 * or a scan in progress.
 */
function ScanProgressBanner({
  entries,
  refreshedAt,
}: {
  entries: Array<{ assetId: string; scannedHeight: number; blockchainHeight: number; fraction: number }>;
  refreshedAt: Date | null;
}) {
  // Tick a counter every second so the "Xs ago" string updates even
  // when the underlying balances haven't refreshed yet. Lightweight —
  // a single integer setState per popup.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const secondsAgo = refreshedAt
    ? Math.max(0, Math.floor((Date.now() - refreshedAt.getTime()) / 1000))
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        background: 'rgba(139, 92, 246, 0.08)',
        border: '1px solid rgba(139, 92, 246, 0.25)',
        borderRadius: 8,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span style={{ opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {entries.length === 1
            ? `Scanning ${mustGetAsset(entries[0]!.assetId).ticker}…`
            : `Scanning ${entries.length} chains…`}
        </span>
        {secondsAgo !== null && (
          <span style={{ opacity: 0.5, fontSize: 10, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {secondsAgo}s ago
          </span>
        )}
      </div>
      {entries.map((e) => {
        const ticker = mustGetAsset(e.assetId).ticker;
        const pct = Math.round(e.fraction * 100);
        return (
          <div key={e.assetId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 32, fontFamily: 'monospace', opacity: 0.65 }}>{ticker}</span>
            <div
              style={{
                flex: 1,
                height: 4,
                background: 'rgba(255,255,255,0.08)',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: '#8b5cf6',
                  transition: 'width 400ms ease',
                }}
              />
            </div>
            <span style={{ fontFamily: 'monospace', opacity: 0.55, fontSize: 10 }}>
              {pct}% · {e.scannedHeight.toLocaleString()} / {e.blockchainHeight.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Format a USD amount with thousands separators and 2-decimal precision. */
function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

/**
 * Per-asset address validation dispatcher.
 *
 * Returns `null` if `addr` decodes correctly for the given asset (bech32
 * prefix + checksum for BTC/LTC; Cryptonote varint prefix + Keccak-256
 * checksum for XMR/WOW; Grin bech32 + 32-byte ed25519 payload for Grin
 * slatepack), or a short user-facing string describing why it failed.
 *
 * Validators live in `@smirk/core/address`; their regression tests in
 * `packages/core/src/__tests__/address.test.ts` cover round-trip,
 * single-char tampering, wrong-network rejection, and malformed input.
 */
function validateAddress(assetId: string, addr: string): string | null {
  const trimmed = addr.trim();
  if (!trimmed) return 'Address is empty';

  const ok =
    assetId === 'btc'
      ? isValidBtcAddress(trimmed)
      : assetId === 'ltc'
        ? isValidLtcAddress(trimmed)
        : assetId === 'xmr'
          ? isValidXmrAddress(trimmed)
          : assetId === 'wow'
            ? isValidWowAddress(trimmed)
            : assetId === 'grin'
              ? isValidGrinSlatepackAddress(trimmed)
              : false;

  if (ok) return null;

  const ticker = mustGetAsset(assetId).ticker;

  // For CryptoNote chains (XMR/WOW), if the decode failed, look for the
  // first character outside the Monero base58 alphabet and surface it
  // — copy-paste from a web/chat context often introduces `0`, `O`,
  // `I`, `l`, or HTML-escape gunk (`&`, `;`) that's not in the
  // alphabet. The generic "not a valid address" doesn't help the user
  // figure out which char to retype.
  if (assetId === 'xmr' || assetId === 'wow') {
    const cnAlphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 0; i < trimmed.length; i++) {
      if (!cnAlphabet.includes(trimmed[i]!)) {
        return `Not a valid ${ticker} address — char '${trimmed[i]}' at position ${i + 1} isn't in base58 (likely copy-paste mangled)`;
      }
    }
  }

  return `Not a valid ${ticker} address`;
}

/**
 * Resolve the receive address for a given asset from the unlocked wallet.
 *
 * Special-cased for Grin: `wallet.addresses.grin` is the legacy Smirk
 * SHA256-custom derivation (see grin-flows.ts comment on
 * `canonicalGrinSlatepackAddress`). Displaying that and letting the
 * user share it means senders encrypt to a pubkey the receiver's
 * wasm-derived secret can't decrypt — every Smirk→Smirk send fails
 * with "age decrypt: No matching keys found". Override with the wasm
 * canonical derivation so the displayed/shared address is the same
 * one used for encryption + decryption end-to-end.
 *
 * Requires wasm to be initialized (warmed up on popup mount; user
 * reaches the Receive screen long after that resolves).
 */
function resolveAddressForAsset(wallet: UnlockedWallet, assetId: string): string {
  if (assetId === 'grin' && wallet.mnemonic) {
    return canonicalGrinSlatepackAddress(wallet.mnemonic);
  }
  const addr = (wallet.addresses as unknown as Record<string, string | undefined>)[assetId];
  if (!addr) throw new Error(`No receive address for asset "${assetId}"`);
  return addr;
}

/**
 * Parse a decimal string into atomic units using the asset's registered
 * decimals. Pure BigInt math — no floating point.
 */
function parseAmount(assetId: string, text: string): bigint | null {
  const asset = mustGetAsset(assetId);
  const decimals = asset.decimals;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Cap input length to prevent multi-megabyte BigInt construction from
  // a pasted-junk amount field (UI hang, not a security bug). 32 chars
  // covers any sane amount: 21M satoshis is 16 chars, full-precision XMR
  // (12 decimals) tops out around 26.
  if (trimmed.length > 32) return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) return null;
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  if (intPart === '' && fracPart === '') return null;
  if (fracPart.length > decimals) return null;
  const padded = fracPart.padEnd(decimals, '0');
  try {
    const intBig = BigInt(intPart || '0');
    const fracBig = padded === '' ? 0n : BigInt(padded);
    const result = intBig * 10n ** BigInt(decimals) + fracBig;
    if (result < 0n) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * InboxPasteRouter — universal paste-and-dispatch screen.
 *
 * One textarea. User pastes a slatepack of any sta (S1/S2/I1/I2/S3/I3);
 * the shell's onDispatch inspects the slate, seeds the appropriate
 * wizard slot, and navigates there. The user never has to know what
 * kind of slatepack they have — they just paste once.
 */
function InboxPasteRouter({
  onReadClipboard,
  onDispatch,
  onExit,
}: {
  onReadClipboard?: () => Promise<string>;
  onDispatch: (armored: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onExit: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const looksLikeSlatepack = (s: string): boolean =>
    s.trimStart().startsWith('BEGINSLATEPACK');

  const submit = async () => {
    const trimmed = text.trim();
    if (!looksLikeSlatepack(trimmed)) {
      setError("Doesn't look like a slatepack — expected BEGINSLATEPACK…");
      return;
    }
    setError(null);
    setBusy(true);
    const result = await onDispatch(trimmed);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const pasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      if (looksLikeSlatepack(clip)) {
        setText(clip);
        setError(null);
      } else {
        setError("Clipboard doesn't contain a slatepack.");
      }
    } catch {
      setError('Could not read clipboard. Paste manually below.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button
          onClick={onExit}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            padding: '4px 8px',
          }}
        >
          ‹ Back
        </button>
        <span style={{ opacity: 0.5 }}>Paste slatepack</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Paste a slatepack</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
        Drop in any Grin slatepack — incoming payment (S1), invoice (I1),
        signed response (S2/I2). We'll figure out what kind it is and
        route you to the right next step.
      </div>

      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK.&#10;…&#10;ENDSLATEPACK."
        rows={6}
        autoFocus
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 11,
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid var(--smirk-border)',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          color: 'inherit',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {onReadClipboard && (
          <button
            onClick={pasteFromClipboard}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '1px solid var(--smirk-border)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 6,
            }}
          >
            📋 Paste from clipboard
          </button>
        )}
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          style={{
            flex: 1,
            background: text.trim() && !busy ? 'var(--smirk-accent)' : 'rgba(255,255,255,0.06)',
            color: 'var(--smirk-accent-fg, #fff)',
            border: 'none',
            cursor: text.trim() && !busy ? 'pointer' : 'not-allowed',
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 16px',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'Inspecting…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

// ----- Other tabs (still stubs) -----

function SwapStub() {
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Swap</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        CEX (Trocador aggregator) launches in v0.3.0. DEX (native atomic
        swaps via adaptor signatures) lights up in v0.4. See V0_3_PLAN.md
        Decision 2.
      </p>
    </div>
  );
}

/**
 * Asset-detail route. Pulls per-chain history + sparkline, normalizes
 * into AssetDetailTxRow, hands off to the @smirk/ui presentational
 * component. Per-chain adapters live in `loadAssetHistory` below.
 */
function AssetDetailRoute({
  assetId,
  wallet,
  session,
  onBack,
  onSend,
  onReceive,
  onTip,
  onTipClaim,
  resolveIcon,
}: {
  assetId: string;
  wallet: UnlockedWallet;
  session: WalletSession | null;
  onBack: () => void;
  onSend: () => void;
  onReceive: () => void;
  onTip: () => void;
  /** Claim a received tip from this asset's history. Reuses the
   *  popup-shell-level tip-claim handler; the AssetDetailScreen
   *  renders the per-row Claim button when this is wired. */
  onTipClaim?: (
    tipId: string,
    assetId: InboxTipItem['assetId'],
  ) => Promise<{ ok: boolean; error?: string }>;
  resolveIcon: (key: string) => string | undefined;
}) {
  const [history, setHistory] = useState<AssetDetailTxRow[]>([]);
  const [sparkline, setSparkline] = useState<SparklinePoint | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // assetId arrives as a freeform string from the `home/asset/<id>`
  // route segment. The router only ever navigates here with a valid
  // SmirkAsset id (see `home/asset/${a.id}` in the asset list), but
  // TS can't prove that across the route boundary. Narrow at the
  // indexing site.
  const balance = session?.balances?.[assetId as keyof typeof session.balances];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setHistory([]);
    setSparkline(undefined);
    void (async () => {
      const [chainRows, tipRows, spark] = await Promise.all([
        loadAssetHistory(assetId, wallet, session?.bootstrap?.userId).catch(
          (e) => {
            console.warn('[asset-detail] history failed:', e);
            return [] as AssetDetailTxRow[];
          },
        ),
        loadAssetTipRows(assetId).catch((e) => {
          console.warn('[asset-detail] tips failed:', e);
          return [] as AssetDetailTxRow[];
        }),
        api.getSparkline(assetId).then(
          (r) =>
            r.data
              ? ({
                  prices: r.data.prices,
                  min: r.data.min,
                  max: r.data.max,
                  changePct: r.data.change_pct,
                } as SparklinePoint)
              : undefined,
          () => undefined,
        ),
      ]);
      if (!alive) return;
      // Merge + sort newest-first. Tips and chain rows both carry an
      // ISO timestamp (Grin / cryptonote / utxo-with-timestamp /
      // tip-{sent,received}). Rows without a timestamp (UTXO with
      // height-only) sort last.
      const merged = [...chainRows, ...tipRows].sort((a, b) => {
        const ta = rowTimestamp(a);
        const tb = rowTimestamp(b);
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      });
      setHistory(merged);
      setSparkline(spark);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [assetId, wallet, session?.bootstrap?.userId, reloadKey]);

  return (
    <AssetDetailScreen
      assetId={assetId}
      balanceAtomic={balance?.confirmed ?? 0n}
      {...(balance?.pending !== undefined && balance.pending > 0n
        ? { pendingAtomic: balance.pending }
        : {})}
      {...(balance?.locked !== undefined && balance.locked > 0n
        ? { lockedAtomic: balance.locked }
        : {})}
      {...(sparkline ? { sparkline } : {})}
      history={history}
      loading={loading}
      onBack={onBack}
      onSend={onSend}
      onReceive={onReceive}
      onTip={onTip}
      onOpenExplorer={(row) => {
        // Tip rows are tracked by tip_id, not chain-level — no
        // explorer URL applies. Skip silently for those.
        if (row.kind === 'tip-sent' || row.kind === 'tip-received') return;
        const url = explorerUrlForRow(assetId, row);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }}
      onTipClawback={async (tipId) => {
        const r = await api.clawbackSocialTip(tipId);
        if (r.error || !r.data) {
          return { ok: false, error: r.error ?? 'Clawback failed' };
        }
        await removeTipKeyBackup(tipId);
        return { ok: true };
      }}
      onTipDiscard={async (tipId) => {
        const r = await api.cancelSocialTip(tipId);
        if (r.error || !r.data) {
          return { ok: false, error: r.error ?? 'Discard failed' };
        }
        await removeTipKeyBackup(tipId);
        return { ok: true };
      }}
      {...(onTipClaim
        ? {
            onTipClaim: (tipId: string) =>
              onTipClaim(tipId, assetId as InboxTipItem['assetId']),
          }
        : {})}
      onTipActionDone={() => setReloadKey((k) => k + 1)}
      resolveIcon={resolveIcon}
    />
  );
}

/** Pull sent + received tips and normalize into AssetDetailTxRow
 *  variants filtered to the given asset. Layers in local IndexedDB
 *  tip-key backups so sent-tip rows surface a 🔐 badge + an
 *  always-available clawback affordance even if the backend doesn't
 *  know about the tip (DR scenario). */
async function loadAssetTipRows(assetId: string): Promise<AssetDetailTxRow[]> {
  const [sentResp, recvResp, backups] = await Promise.all([
    api.getSentSocialTips(),
    api.getReceivedSocialTips().catch(() => ({ data: undefined, error: undefined })),
    listTipKeyBackups().catch(() => []),
  ]);
  const backupIds = new Set(backups.map((b) => b.tipId));
  const out: AssetDetailTxRow[] = [];

  if (sentResp.data?.tips) {
    for (const t of sentResp.data.tips) {
      if (t.asset !== assetId) continue;
      const counterparty = t.is_public
        ? 'public link'
        : `@${t.recipient_username ?? '?'}`;
      const row: Extract<AssetDetailTxRow, { kind: 'tip-sent' }> = {
        kind: 'tip-sent',
        tipId: t.id,
        amountAtomic: BigInt(t.amount),
        ticker: assetId.toUpperCase(),
        counterparty,
        ...(t.recipient_platform ? { platform: t.recipient_platform } : {}),
        timestamp: t.created_at,
        status: t.status,
        fundingConfirmations: t.funding_confirmations,
        confirmationsRequired: t.confirmations_required,
        ...(backupIds.has(t.id) ? { hasLocalBackup: true } : {}),
      };
      out.push(row);
    }
  }

  // Orphan local backups — backend has no row, user can still
  // recover (Sent Tips screen surfaces these via the asset-detail
  // tip-sent variant tagged hasLocalBackup).
  if (sentResp.data?.tips) {
    const serverIds = new Set(sentResp.data.tips.map((t) => t.id));
    for (const b of backups) {
      if (b.asset !== assetId) continue;
      if (serverIds.has(b.tipId)) continue;
      out.push({
        kind: 'tip-sent',
        tipId: b.tipId,
        amountAtomic: BigInt(b.amount),
        ticker: assetId.toUpperCase(),
        counterparty: 'recipient',
        timestamp: new Date(b.createdAt).toISOString(),
        status: 'pending',
        hasLocalBackup: true,
      });
    }
  }

  if (recvResp.data?.tips) {
    for (const t of recvResp.data.tips) {
      if (t.asset !== assetId) continue;
      // Mirror the InboxTab stale filter: abandoned 0-conf tips
      // older than the cutoff don't belong in the per-asset history
      // either. Claimed / clawed-back / claiming tips are NOT
      // subject to this — `claiming` rows are retry-eligible (see
      // InboxTab fetcher comment) and need to stay visible so the
      // user can take the retry action; terminal states stay so the
      // user sees full history.
      if (
        (t.status === 'pending' || t.status === 'pending_confirmation') &&
        isTipStale(t.funding_confirmations ?? 0, t.created_at)
      ) {
        continue;
      }
      // For public tips the counterparty is the share-URL stranger,
      // not a known sender — leave the "public link" label.
      // For targeted tips: show the sender's @handle when they opted
      // in AND have one set; otherwise "anonymous". Matches
      // InboxTipItem.senderDisplay rendering so the InboxTab and
      // asset-detail history always agree.
      const counterparty = t.is_public
        ? 'public link'
        : !t.sender_anonymous && t.sender_username
          ? `@${t.sender_username}`
          : 'anonymous';
      const row: Extract<AssetDetailTxRow, { kind: 'tip-received' }> = {
        kind: 'tip-received',
        tipId: t.id,
        amountAtomic: BigInt(t.amount),
        ticker: assetId.toUpperCase(),
        counterparty,
        ...(t.recipient_platform ? { platform: t.recipient_platform } : {}),
        timestamp: t.created_at,
        // Surface status + confs so the row can render the
        // confirmation progress + the Claim button on ready tips.
        // Matches the InboxTab plumbing.
        status: t.status,
        fundingConfirmations: t.funding_confirmations ?? 0,
        confirmationsRequired: t.confirmations_required ?? 1,
      };
      out.push(row);
    }
  }

  return out;
}

function rowTimestamp(row: AssetDetailTxRow): number | null {
  if (row.kind === 'utxo') return null;
  const iso = row.timestamp;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Per-chain adapter. Pulls from whichever history endpoint the asset's
 * family supports, normalizes to the AssetDetailTxRow shape the UI
 * component renders.
 */
async function loadAssetHistory(
  assetId: string,
  wallet: UnlockedWallet,
  userId: string | undefined,
): Promise<AssetDetailTxRow[]> {
  if (assetId === 'btc' || assetId === 'ltc') {
    const addr = wallet.addresses[assetId];
    if (!addr) return [];
    const r = await api.getHistory(assetId, addr);
    if (r.error || !r.data) return [];
    return r.data.transactions.map(
      (t): AssetDetailTxRow => ({
        kind: 'utxo',
        // Electrum returns total_received / total_sent in atomic units.
        // direction is whichever is non-zero; amount is the absolute value.
        direction: (t.total_received ?? 0) > 0 ? 'in' : 'out',
        amountAtomic: BigInt(
          (t.total_received ?? 0) > 0
            ? (t.total_received ?? 0)
            : (t.total_sent ?? 0),
        ),
        txid: t.txid,
        heightOrPending: t.height > 0 ? t.height : 'pending',
        ...(t.fee !== undefined ? { feeAtomic: BigInt(t.fee) } : {}),
      }),
    );
  }
  if (assetId === 'xmr' || assetId === 'wow') {
    const addr = wallet.addresses[assetId];
    const viewKeyHex = bytesToHex(wallet.keys[assetId].privateViewKey);
    if (!addr) return [];
    const r = await api.getLwsHistory(assetId, addr, viewKeyHex);
    if (r.error || !r.data) return [];
    return r.data.transactions.map(
      (t): AssetDetailTxRow => ({
        kind: 'cryptonote',
        // total_received > 0 means we received; spent_outputs presence
        // means we sent. LWS rows can be both (change), in which case
        // direction = 'in' if net is positive, else 'out'.
        direction: t.total_received > 0 ? 'in' : 'out',
        amountAtomic: BigInt(
          t.total_received > 0
            ? t.total_received
            : t.spent_outputs.reduce((s, o) => s + o.amount, 0),
        ),
        txid: t.txid,
        heightOrPending: t.is_pending ? 'pending' : t.height,
        timestamp: t.timestamp,
      }),
    );
  }
  if (assetId === 'grin') {
    if (!userId) return [];
    const r = await api.getGrinUserHistory(userId);
    if (r.error || !r.data) return [];
    return r.data.transactions.map(
      (t): AssetDetailTxRow => ({
        kind: 'grin',
        direction: t.direction === 'receive' ? 'in' : 'out',
        amountAtomic: BigInt(t.amount),
        feeAtomic: BigInt(t.fee),
        kernelExcess: t.kernel_excess,
        slateId: t.slate_id,
        status: t.status,
        timestamp: t.created_at,
      }),
    );
  }
  return [];
}

/**
 * Build the explorer URL for a tap on a tx row. Mirrors the explorer
 * lookup in `SendWizard.tsx` — duplicated here because the row union
 * is shaped differently from the Done-step txid string.
 */
function explorerUrlForRow(
  assetId: string,
  row: AssetDetailTxRow,
): string | null {
  if (row.kind === 'utxo') {
    if (assetId === 'btc') return `https://mempool.space/tx/${row.txid}`;
    if (assetId === 'ltc') return `https://litecoinspace.org/tx/${row.txid}`;
  }
  if (row.kind === 'cryptonote') {
    if (assetId === 'xmr') return `https://xmrchain.net/tx/${row.txid}`;
    if (assetId === 'wow') return `https://explore.wownero.com/tx/${row.txid}`;
  }
  if (row.kind === 'grin' && row.kernelExcess) {
    return `https://grincoin.org/kernel/${row.kernelExcess}`;
  }
  return null;
}

function InboxRouter({
  wallet,
  userId,
  inbox,
  tips,
  onRefresh,
  onClaimTip,
}: {
  wallet: UnlockedWallet;
  /** Backend user UUID from `bootstrap.userId`. Required for Grin API
   *  calls — the local seed fingerprint won't parse as a UUID
   *  server-side. */
  userId: string;
  inbox: { items: InboxItem[]; loading: boolean; error: string | null };
  tips: InboxTipItem[];
  onRefresh: () => Promise<void>;
  onClaimTip: (item: InboxTipItem) => Promise<void>;
}) {
  const { navigate } = useRoute();
  // Tapping a pending_to_sign row seeds the GrinPasteIncomingWizard
  // with the relay's slatepack + relayId so the user lands at the
  // auto-sign step instead of pasting manually. The wizard's sign
  // handler posts S2 back through the relay (api.signGrinSlatepack)
  // when relayId is set, advancing the sender's queue automatically.
  const handleOpenIncomingSign = async (
    slatepack: string,
    relayId: string,
  ) => {
    await store.update((s) => {
      s.wizards['grin-paste-incoming'] = {
        step: 1, // skip the Paste step — already have S1
        startedAt: Date.now(),
        fields: {
          armoredIncoming: slatepack,
          relayId,
        },
      };
    });
    void navigate('home/receive/grin-incoming');
    // wallet param reserved for v0.4 (multi-pending tracking that keys
    // wizard slots by counterparty / relay_id rather than overwriting
    // the singleton slot).
    void wallet;
  };
  // pending_to_finalize: the SendWizard's existing wizard.fields already
  // hold the sender context for the in-flight S1 (set on send-time).
  // Pre-fill the S2 textarea via wizard.fields.grinPastedS2 so the
  // user just hits "Finalize & broadcast" in the Exchange step. If the
  // wizard's slate_id doesn't match the inbox row (e.g. user sent
  // twice), they can still cancel + restart manually.
  const handleOpenIncomingFinalize = async (slatepack: string) => {
    await store.update((s) => {
      const w = s.wizards.send;
      if (w) {
        w.fields.grinPastedS2 = slatepack;
      }
    });
    // Clipboard fallback for the "wizard slot mismatch" case.
    void navigator.clipboard.writeText(slatepack).catch(() => undefined);
    void navigate('home/send');
  };
  // Drop a row from the relay. Backend marks the entry cancelled; our
  // 30s poll will pick up the removal. For pending_to_finalize rows
  // (which represent an in-flight send we initiated), also unlock the
  // reserved outputs and mark the local tx record cancelled so the
  // wallet's pendingOutgoing tristate clears.
  const handleCancel = async (item: InboxItem) => {
    // Don't silently swallow — if the backend says we can't cancel this
    // relay row (e.g. ownership check fails) the user sees nothing
    // happen and the row sticks around forever. Surface the failure so
    // they can act on it instead of poking the X repeatedly.
    const cancelRes = await api.cancelGrinSlatepack({
      relayId: item.relayId,
      userId,
    });
    if (cancelRes.error) {
      window.alert(`Couldn't cancel: ${cancelRes.error}`);
      return;
    }
    if (item.kind === 'pending_to_finalize') {
      await api
        .unlockGrinOutputs({ userId, txSlateId: item.slateId })
        .catch(() => undefined);
      await api
        .updateGrinTransaction({
          userId,
          slateId: item.slateId,
          status: 'cancelled',
        })
        .catch(() => undefined);
    }
    await onRefresh();
  };
  return (
    <InboxTab
      items={inbox.items}
      tips={tips}
      loading={inbox.loading}
      error={inbox.error}
      onRefresh={() => void onRefresh()}
      onClaimTip={(item) => onClaimTip(item)}
      onPasteSlatepack={() => {
        // Reset prior paste-router state so the user starts fresh.
        void store
          .update((s) => {
            if (s.wizards['grin-paste-router']) {
              delete s.wizards['grin-paste-router'];
            }
          })
          .then(() => navigate('home/inbox/paste'));
      }}
      onOpenIncomingSign={(item) =>
        void handleOpenIncomingSign(item.slatepack, item.relayId)
      }
      onOpenIncomingFinalize={(item) =>
        void handleOpenIncomingFinalize(item.slatepack)
      }
      onCancel={(item) => void handleCancel(item)}
    />
  );
}

/**
 * The auto-lock dropdown options. `0` = lock immediately on popup close
 * (safe default). `-1` = never auto-lock. Positive = minutes.
 *
 * When non-zero, the popup persists the unlocked mnemonic into
 * `chrome.storage.session` for the chosen duration. That's a
 * convenience-vs-security tradeoff with explicit user opt-in — the
 * 2026-05-10 audit's "do not persist seed material" rule applies to
 * the *default* behavior, which we keep at `0` (immediate).
 */
const AUTO_LOCK_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Immediately (most secure)' },
  { value: 10, label: '10 minutes' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  { value: -1, label: 'Never (until browser closes)' },
];

/**
 * Settings → Assets — show/hide each registered asset.
 *
 * Hidden assets disappear from Home, the Send/Receive/Tip choosers,
 * and balance-poll round-trips. They're still routable directly
 * (claim notifications, external links) and the wallet still owns
 * their keys — visibility is a UI preference, not a destructive
 * action.
 *
 * Footer count gives at-a-glance feedback. Auto-unhide-on-claim
 * (handled elsewhere) and onboarding hint round out the surface.
 */
function AssetsVisibilityPanel({
  sessionState,
}: {
  sessionState: ReturnType<typeof useSessionState>;
}) {
  const hidden = sessionState.ui.hiddenAssets ?? [];
  const all = listAssets();
  const visibleCount = all.filter((a) => !hidden.includes(a.id)).length;
  const toggle = async (assetId: string, visible: boolean) => {
    await store.update((s) => {
      s.ui.hiddenAssets = withAssetVisibility(
        s.ui.hiddenAssets ?? [],
        assetId,
        visible,
      );
    });
  };
  return (
    <section style={{ marginTop: 20 }}>
      <label
        style={{
          display: 'block',
          fontSize: 12,
          opacity: 0.8,
          marginBottom: 6,
        }}
      >
        Assets
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          padding: '6px 8px',
        }}
      >
        {all.map((a) => {
          const isVisible = !hidden.includes(a.id);
          return (
            <label
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 13,
                padding: '6px 4px',
                cursor: 'pointer',
                lineHeight: 1.2,
              }}
            >
              <input
                type="checkbox"
                checked={isVisible}
                onChange={(e) =>
                  void toggle(a.id, (e.target as HTMLInputElement).checked)
                }
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                {a.displayName}{' '}
                <span
                  style={{
                    opacity: 0.55,
                    fontSize: 11,
                    fontFamily: 'var(--smirk-font-family-mono, monospace)',
                  }}
                >
                  {a.ticker}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p
        style={{
          fontSize: 11,
          opacity: 0.55,
          margin: '6px 0 0',
          lineHeight: 1.4,
        }}
      >
        {visibleCount} visible · {hidden.length} hidden. Hidden assets stop
        polling the backend until you re-enable them. The wallet still
        owns the keys — hiding never destroys access.
      </p>
    </section>
  );
}

function SettingsStub({ onLock, onForgetComplete }: {
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
}) {
  const sessionState = useSessionState();
  const autoLockMinutes = sessionState.ui.autoLockMinutes ?? 0;
  const themeId = sessionState.ui.theme ?? 'default';
  const [forgetOpen, setForgetOpen] = useState(false);
  // window.smirk injection toggle — closes the short-term ask in
  // Such-Software/smirk-extension#1. Lives in chrome.storage.local
  // (read directly by the content script at document_start) rather
  // than the session-state store, so the toggle isn't gated on a
  // JSON-blob parse on the hot path.
  const [injectDisabled, setInjectDisabledState] = useState<boolean | null>(null);
  useEffect(() => {
    void isInjectDisabled().then(setInjectDisabledState);
  }, []);
  const toggleInjectDisabled = async (next: boolean) => {
    await setInjectDisabled(next);
    setInjectDisabledState(next);
  };

  const setThemeId = async (next: string) => {
    await store.update((s) => {
      s.ui.theme = next;
    });
  };

  const setAutoLock = async (minutes: number) => {
    await store.update((s) => {
      s.ui.autoLockMinutes = minutes;
    });
    if (minutes === 0) {
      // Immediate-lock chosen: wipe any existing session-cache so the
      // new policy takes effect now, not when the old timer expires.
      await sessionStorage.remove(SESSION_CACHE_KEY);
    } else {
      // Re-stamp the session cache against the currently-unlocked
      // wallet so the new TTL applies immediately. Without this, a
      // user who unlocks with "Immediately" (no cache) and then
      // switches to "Never" sees no effect until the next manual
      // unlock — defeating the toggle.
      const ks = await walletKeystore.getState();
      if (ks.kind === 'unlocked') {
        await writeSessionCache(ks.wallet, minutes);
      }
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Settings</h2>

      <section style={{ marginTop: 16 }}>
        <label
          style={{
            display: 'block',
            fontSize: 12,
            opacity: 0.8,
            marginBottom: 6,
          }}
        >
          Auto-lock wallet after
        </label>
        <select
          value={String(autoLockMinutes)}
          onChange={(e) => void setAutoLock(Number((e.target as HTMLSelectElement).value))}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          {AUTO_LOCK_OPTIONS.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        {autoLockMinutes !== 0 && (
          <p
            style={{
              fontSize: 11,
              opacity: 0.55,
              margin: '6px 0 0',
              lineHeight: 1.4,
            }}
          >
            ⚠ While unlocked, your seed phrase is held in browser session
            storage. Only choose a non-immediate option on devices you
            trust physically.
          </p>
        )}
      </section>

      <section style={{ marginTop: 20 }}>
        <label
          style={{
            display: 'block',
            fontSize: 12,
            opacity: 0.8,
            marginBottom: 6,
          }}
        >
          Theme
        </label>
        <select
          value={themeId}
          onChange={(e) => void setThemeId((e.target as HTMLSelectElement).value)}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          {listThemes().map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </section>

      {/* Assets visibility — let the user curate which coins appear
          on Home, in choosers, and in balance polling. Hiding an
          asset never destroys access; the wallet still owns the keys.
          See docs/MULTI_ASSET_ARCHITECTURE.md for the long-form
          rationale + the polling cost savings. */}
      <AssetsVisibilityPanel sessionState={sessionState} />

      <section style={{ marginTop: 20 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            fontSize: 13,
            cursor: injectDisabled === null ? 'default' : 'pointer',
            lineHeight: 1.35,
          }}
        >
          <input
            type="checkbox"
            checked={injectDisabled === true}
            disabled={injectDisabled === null}
            onChange={(e) =>
              void toggleInjectDisabled((e.target as HTMLInputElement).checked)
            }
            style={{ marginTop: 2 }}
          />
          <span>
            Disable <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>window.smirk</code> on websites
          </span>
        </label>
        <p
          style={{
            fontSize: 11,
            opacity: 0.55,
            margin: '6px 0 0 24px',
            lineHeight: 1.4,
          }}
        >
          Prevents websites from detecting Smirk is installed. Breaks
          dapp integrations (smirk.cash login, tip claims, etc.).
          Takes effect on next page load for each tab.
        </p>
      </section>

      <button
        onClick={() => void onLock()}
        style={{
          marginTop: 20,
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Lock wallet now
      </button>

      <section style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', opacity: 0.85 }}>
          Danger zone
        </h3>
        <p style={{ fontSize: 11, opacity: 0.55, margin: '0 0 10px', lineHeight: 1.4 }}>
          Deleting this wallet wipes its encrypted keystore from this device. You
          can only recover with your 12-word recovery phrase.
        </p>
        {!forgetOpen ? (
          <button
            onClick={() => setForgetOpen(true)}
            style={{
              padding: '8px 14px',
              background: 'rgba(239, 68, 68, 0.10)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: 6,
              color: '#ef4444',
              fontFamily: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Forget this wallet…
          </button>
        ) : (
          <ForgetWalletFlow
            onCancel={() => setForgetOpen(false)}
            onConfirmed={onForgetComplete}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Three-gate destructive confirmation for "Forget wallet":
 *
 *   1. Warning panel (acknowledge what's about to happen)
 *   2. Checkbox: "I have my recovery phrase written down"
 *   3. Type-to-confirm: type the word `FORGET` to enable the
 *      destructive button
 *
 * Order matters — each gate clears the next, in sequence. Nothing
 * about this needs to be slick; this is the one place in the app
 * where friction is the feature.
 */
function ForgetWalletFlow({
  onCancel,
  onConfirmed,
}: {
  onCancel: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const CONFIRM_WORD = 'FORGET';
  const typedMatches = typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <div
      style={{
        background: 'rgba(239, 68, 68, 0.06)',
        border: '1px solid rgba(239, 68, 68, 0.3)',
        borderRadius: 8,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ef4444', marginBottom: 6 }}>
          ⚠ Forget this wallet
        </div>
        <p style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: 0 }}>
          This <strong>permanently deletes</strong> the encrypted keystore from
          this device. Smirk cannot recover it for you — there is no support
          channel that can.
        </p>
        <p style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: '8px 0 0' }}>
          You can only restore from your <strong>12-word recovery phrase</strong>.
          If you don't have your phrase written down somewhere safe right now,
          <strong> all coins in this wallet will be lost forever.</strong>
        </p>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          fontSize: 12,
          cursor: 'pointer',
          opacity: 0.9,
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged((e.target as HTMLInputElement).checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          I have my 12-word recovery phrase written down somewhere safe.
        </span>
      </label>

      <div style={{ opacity: acknowledged ? 1 : 0.4, pointerEvents: acknowledged ? 'auto' : 'none' }}>
        <label style={{ display: 'block', fontSize: 11, opacity: 0.75, marginBottom: 4 }}>
          To confirm, type <strong>{CONFIRM_WORD}</strong> below:
        </label>
        <input
          type="text"
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder={CONFIRM_WORD}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6,
            color: 'inherit',
            fontFamily: 'monospace',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            letterSpacing: '0.1em',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: '8px 14px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 6,
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 13,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          disabled={!acknowledged || !typedMatches || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirmed();
            } finally {
              setBusy(false);
            }
          }}
          style={{
            padding: '8px 14px',
            background:
              !acknowledged || !typedMatches
                ? 'rgba(239, 68, 68, 0.10)'
                : '#ef4444',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            borderRadius: 6,
            color:
              !acknowledged || !typedMatches ? 'rgba(239, 68, 68, 0.6)' : '#fff',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor:
              !acknowledged || !typedMatches || busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Forgetting…' : 'Permanently forget wallet'}
        </button>
      </div>
    </div>
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

interface ApprovalAppProps {
  approvalId: string;
}

function ApprovalApp({ approvalId }: ApprovalAppProps) {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [missing, setMissing] = useState(false);

  // Mirror the main App's theme bootstrap — without this the
  // approval popup renders with NO `--smirk-*` CSS variables set,
  // so ApprovalScreen's themed colors (asset-chip background,
  // origin text contrast, etc.) all fall back to "undefined" and
  // the popup looks like an unstyled white-on-black mess (the
  // exact bug shown in the connect-prompt screenshot).
  useEffect(() => {
    const apply = (themeId: string) => {
      applyTheme(getTheme(themeId) ?? defaultTheme);
    };
    void store.load().then((s) => apply(s.ui.theme ?? 'default'));
    return store.subscribe((s) => apply(s.ui.theme ?? 'default'));
  }, []);

  const refresh = async () => {
    await tryRestoreSessionCache();
    const ks = await walletKeystore.getState();
    setWalletState(ks);
    const p = await approvalPopupBridge.readPending(approvalId);
    if (!p) {
      // SW already cleaned it up (race), or never wrote it. Show
      // "no longer valid" and close shortly.
      setMissing(true);
      return;
    }
    setPending(p);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Cache public material on unlock just like the main app does, so
  // the SW provider stays consistent even if the user first unlocked
  // inside an approval flow.
  useEffect(() => {
    if (walletState?.kind === 'unlocked') {
      void writeDappPublicCache(dappPublicCacheFor(walletState.wallet));
    }
  }, [walletState]);

  if (missing) {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.7 }}>
        This approval is no longer valid.
        <div style={{ marginTop: 12 }}>
          <button onClick={() => window.close()} style={{ padding: '6px 12px' }}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!walletState || !pending) {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>Loading…</div>
    );
  }

  if (walletState.kind === 'empty') {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.7 }}>
        No wallet — open Smirk to create one, then approve again.
        <div style={{ marginTop: 12 }}>
          <button onClick={() => window.close()} style={{ padding: '6px 12px' }}>
            Close
          </button>
        </div>
      </div>
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
          await refresh();
        }}
      />
    );
  }

  const wallet = walletState.wallet;

  const finish = async (result: DappApprovalResult) => {
    await approvalPopupBridge.writeResult(approvalId, result);
    // Give the SW a tick to pick up the storage change before the
    // window disappears — chrome.storage.onChanged fires async.
    setTimeout(() => window.close(), 50);
  };

  const handleApprove = async (approval: ApprovalApproval) => {
    switch (approval.kind) {
      case 'connect': {
        await finish({
          kind: 'connect',
          approved: true,
          approvedAssets: approval.approvedAssets,
        });
        return;
      }
      case 'signMessage': {
        if (pending.request.kind !== 'signMessage') {
          throw new Error('Pending request kind mismatch');
        }
        const result = signMessageInPopup(wallet, pending.request.message, pending.request.assets);
        await finish({ kind: 'signMessage', approved: true, result });
        return;
      }
      case 'requestPayment': {
        // PHASE-2: wire to existing send-handler. For v0.3 dapp-api
        // launch we only need connect + signMessage to unblock
        // smirk.cash registration. Surface a clear error so a
        // misconfigured dapp doesn't think the user denied.
        throw new Error('requestPayment is not yet implemented in v0.3 dapp adapter');
      }
      case 'claimPublicTip': {
        // PHASE-2: wire to tip-handler claim path.
        throw new Error('claimPublicTip is not yet implemented in v0.3 dapp adapter');
      }
    }
  };

  // Translate the dapp-api ApprovalRequest into the UI's shape. They
  // line up 1:1 by design — this is just a name-spaced cast that
  // keeps the UI package decoupled from the protocol package.
  const uiRequest = pending.request as unknown as UiApprovalRequest;

  return (
    <ApprovalScreen
      request={uiRequest}
      onApprove={handleApprove}
      onDeny={() => void finish({ approved: false })}
    />
  );
}

/**
 * Compute one signature per authorized asset. BTC/LTC use the
 * canonical Bitcoin-message format (`signBitcoinMessage`); XMR/WOW
 * sign the raw UTF-8 message bytes with their ed25519 private
 * spend-key scalar; Grin signs with its slatepack ed25519 scalar.
 * All ed25519 signatures go through `signEd25519WithScalar` because
 * our keys are stored as raw scalars, not RFC-8032 seeds — passing
 * them to `ed25519.sign` would re-clamp into a different scalar and
 * yield signatures that don't verify against the public keys we
 * actually publish.
 *
 * Per-asset failures are captured per-asset (empty signature string)
 * rather than aborting the whole result — smirk.cash and similar
 * dapps pick the signature for the asset the user chose, so one
 * failing asset shouldn't kill the others.
 */
function signMessageInPopup(
  wallet: UnlockedWallet,
  message: string,
  assets: Array<'btc' | 'ltc' | 'xmr' | 'wow' | 'grin'>,
): SmirkSignResult {
  const msgBytes = new TextEncoder().encode(message);
  const signatures: SmirkSignResult['signatures'] = [];
  for (const asset of assets) {
    try {
      switch (asset) {
        case 'btc':
          signatures.push({
            asset: 'btc',
            signature: signBitcoinMessage(message, wallet.keys.btc.privateKey),
            publicKey: bytesToHex(wallet.keys.btc.publicKey),
          });
          break;
        case 'ltc':
          signatures.push({
            asset: 'ltc',
            signature: signBitcoinMessage(message, wallet.keys.ltc.privateKey),
            publicKey: bytesToHex(wallet.keys.ltc.publicKey),
          });
          break;
        case 'xmr': {
          const pub = wallet.keys.xmr.publicSpendKey;
          signatures.push({
            asset: 'xmr',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.xmr.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'wow': {
          const pub = wallet.keys.wow.publicSpendKey;
          signatures.push({
            asset: 'wow',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.wow.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'grin': {
          const pub = wallet.keys.grin.publicKey;
          signatures.push({
            asset: 'grin',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.grin.privateKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
      }
    } catch (e) {
      console.error(`[signMessage] ${asset} signing failed:`, e);
      // Emit an empty-signature entry so the dapp gets a clear "we
      // know about this asset, we just couldn't sign" signal rather
      // than silently dropping the asset. smirk.cash surfaces this
      // as "No signature found for <asset>" downstream.
    }
  }
  return { message, signatures };
}

const root = document.getElementById('root');
if (root) {
  const approvalId = parseApprovalId();
  if (approvalId) {
    render(<ApprovalApp approvalId={approvalId} />, root);
  } else {
    render(<App />, root);
  }
}
