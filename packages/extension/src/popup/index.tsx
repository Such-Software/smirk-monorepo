/**
 * Smirk popup — the action-popup wallet UI entry point.
 *
 * The single largest file in the repo. It's structured top-down,
 * roughly: imports → module-level singletons → `App` component →
 * routed sub-screens (Home, Send, Receive, Tip, Asset Detail, Inbox,
 * Settings) → onboarding / lock-screen renderers. Splitting it into
 * per-screen files is tracked for a v0.3.x refactor — see
 * `docs/V0_3_PLAN.md`.
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

import { Fragment, render } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TrocadorSwap } from '@smirk/swap';
import {
  ChromeLocalStorage,
  ChromeSessionStorage,
  SessionStateStore,
  RouteController,
  SESSION_CACHE_KEY,
  WalletKeystore,
  api,
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
  restoreUnlockedFromCache,
  clampAutoLockMinutes,
  parseSessionCache,
  AUTO_LOCK_MAX_MINUTES,
  type SessionCachePayload,
  totalFiat,
  pendingOutgoingTotalWithFee,
  inFlightInputsTotal,
  expectedLockedChange,
  isPendingOutgoingStale,
  recentlySpentInputs,
  reconcilePendingOutgoing,
  initSmirkApi,
  chainProviders,
  deriveNostrIdentity,
  initSmirkMessaging,
  sendDm,
  subscribeDms,
  type Balances,
  type BootstrapAuthResult,
  type DirectMessage,
  type DmSubscription,
  type NostrIdentity,
  type Prices,
  type UnlockedWallet,
  type WalletState,
} from '@smirk/core';
import {
  AppShell,
  BrowserShell,
  IframeBrowserContent,
  SentTipsScreen,
  type SentTipRow,
  ApprovalScreen,
  AssetDetailScreen,
  ClaimableTipsBanner,
  ReadyToShareTipsBanner,
  GrinPasteIncomingWizard,
  GrinPayInvoiceWizard,
  GrinRequestWizard,
  HomeTab,
  InboxTab,
  SwapTab,
  TROCADOR_WIZARD_ID,
  type SwapInFlight,
  type SwapQuoteSummary,
  LockScreen,
  OnboardingWizard,
  ReceiveScreen,
  SendWizard,
  StateProvider,
  TipMaker,
  applyTheme,
  defaultTheme,
  formatAmountWithTicker,
  getTheme,
  listThemes,
  useRoute,
  useSessionState,
  type ApprovalRequest as UiApprovalRequest,
  type ApprovalApproval,
  type AssetDetailTxRow,
  type ExistingIdentity,
  type ExistingSocial,
  type InboxItem,
  type InboxTipItem,
  type RecentRecipient,
  type SparklinePoint,
} from '@smirk/ui';
import { listAssets, mustGetAsset } from '@smirk/assets';
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
  recoverGrinOutputs,
  shouldRecoverGrin,
  RECOVER_GRIN_BIRTHDAY_HEIGHT,
} from './grin-flows';
import { dispatchSocialTip } from './tip-handler';
import {
  claimSocialTip,
  claimPublicTip,
  clawbackSocialTip,
  parseShareUrl,
} from './tip-claim-handler';
import { listTipKeyBackups, removeTipKeyBackup } from './tip-key-backup';
import {
  writeDappPublicCache,
  clearDappPublicCache,
  type DappPublicCache,
} from '../background/dapp/provider';
import { chromeStoragePermissionStore } from '../background/dapp/permissions';
import { approvalPopupBridge, type PendingApproval } from '../background/dapp/approval';
import { isInjectDisabled, setInjectDisabled } from '../background/dapp/inject-policy';
import {
  createWalletHandler,
  type ApprovalRequest as DappApprovalRequest,
  type ApprovalResult as DappApprovalResult,
  type SmirkAddresses,
  type SmirkPublicKeys,
} from '@such-software/smirk-dapp-api';
import {
  createInPopupApprovalQueue,
  createLiveWalletProvider,
  createPageRequestBridge,
  executeApproval,
} from '../dapp-popup';
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
function dappPublicCacheFor(
  wallet: UnlockedWallet,
  autoLockMinutes: number,
): DappPublicCache {
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
  // Mirror the popup's own session-cache TTL into the dapp public
  // cache so the SW provider can detect "wallet auto-locked while
  // the popup was closed and never cleared the cache" without an
  // IPC round-trip. Per Finding 13 in the v0.3.0 pre-ship audit.
  //
  // autoLockMinutes is clamped to [0, AUTO_LOCK_MAX_MINUTES]. The
  // pre-2026-06-13 "Never" sentinel (negative / MAX_SAFE_INTEGER)
  // was dropped — legacy stored values self-heal to the 24h cap.
  const clampedAutoLock = clampAutoLockMinutes(autoLockMinutes);
  const sessionExpiresAtMs =
    clampedAutoLock === 0
      ? Date.now() // immediate lock: cache is stale the moment we write it
      : Date.now() + clampedAutoLock * 60_000;
  return {
    fingerprint: wallet.fingerprint,
    addresses,
    publicKeys,
    unlockedAt: Date.now(),
    sessionExpiresAtMs,
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

// ============================================================================
// Browse tab — desktop-only, mounted via globalThis.__smirk_browser__
// ============================================================================

/**
 * Shape of the embedded-browser controller the desktop shell exposes
 * on the global. Structurally compatible with `DappBrowserController`
 * from `@smirk/dapp-browser`, but typed locally to avoid the
 * extension package having to depend on `@smirk/dapp-browser`.
 */
type BrowserControllerGlobal = Parameters<
  typeof import('@smirk/ui').BrowserShell
>[0]['controller'];

// Imported as a type only — the actual class lives in
// `@smirk/dapp-browser` and is instantiated by `@smirk/desktop`'s
// `main.ts`. BrowseTab only needs the structural shape (the
// `inlineMode` brand + `dispatchPageMessage` / `getReloadGen` /
// `notifyTabLoaded` methods) when narrowing the controller to
// pass into `<IframeBrowserContent>`.
type IframeBrowserController = import('@smirk/dapp-browser').IframeBrowserController;

/**
 * BrowseTab wires the embedded-browser controller (provided by the
 * Tauri desktop shell on the `__smirk_browser__` global) to the
 * wallet's dapp surface. Three concerns live here:
 *
 *  1. **Open the browser** (`controller.open()`) and seed a first
 *     tab so the user lands somewhere useful instead of a blank
 *     frame slot.
 *  2. **Wire the page-RPC bridge** so `window.smirk` calls inside
 *     embedded pages route through the same `WalletHandler` the
 *     extension SW uses — full method parity (connect / signMessage
 *     / requestPayment / claimPublicTip). No SW round-trip; the
 *     unlocked wallet stays in this React tree.
 *  3. **Render the approval modal** on top of the browser shell
 *     when a dapp request needs user consent. Single-pending queue:
 *     a second concurrent request gets a deny so the user can't be
 *     tricked into approving the wrong thing.
 *
 * The provider + permission store are reused verbatim from the
 * extension's chrome-shim-backed factories — the chrome-shim turns
 * `chrome.storage.*` into Tauri's `plugin-store`, so the same code
 * persists per-origin permissions on desktop.
 *
 * `walletStateRef` lets the approval handler read the latest unlock
 * state at the moment the user clicks Approve (which may be many
 * seconds after the request arrived). A user who locks mid-decision
 * gets a clear "wallet locked" error instead of a stale signature.
 */
function BrowseTab({
  controller,
  walletStateRef,
}: {
  controller: BrowserControllerGlobal;
  walletStateRef: { current: WalletState | null };
}) {
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<DappApprovalRequest | null>(null);

  // Approval queue + wallet handler — created once per BrowseTab
  // mount. The queue's listener wiring lives in its own effect
  // below so the React subscriber unsubscribes on unmount.
  const queue = useMemo(() => createInPopupApprovalQueue(), []);

  useEffect(() => queue.subscribe(setPending), [queue]);

  // Hide the embedded WebviewWindow while an approval is pending.
  // The embedded webview is a separate top-level OS window stacked
  // over the wallet's frame slot — a React `position: fixed` modal
  // would render in the wallet popup BENEATH that window, invisible
  // to the user. `controller.hideFrame()` calls `embedded.hide()` on
  // the Rust side; when the user resolves the approval, we nudge a
  // resize event so `BrowserShell`'s `ResizeObserver` re-pushes the
  // frame rect to Rust, which restores the embedded webview to its
  // previous position via the apply_rect → show() path.
  const hadPendingRef = useRef(false);
  useEffect(() => {
    if (pending) {
      void controller.hideFrame();
      hadPendingRef.current = true;
    } else if (hadPendingRef.current) {
      hadPendingRef.current = false;
      // BrowserShell's `useFrameRect` listens for window resize and
      // re-measures + re-pushes. Fire it once after the React tree
      // settles so the resize handler reads the post-modal layout.
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  }, [pending, controller]);

  useEffect(() => {
    // Desktop uses a LIVE provider that reads `walletStateRef`
    // directly, not the chrome-shim-backed public cache. Two reasons:
    // (1) the cache's `sessionExpiresAtMs` is stamped to `Date.now()`
    // for `autoLockMinutes = 0` (the default), which the SW provider
    // treats as expired → every dapp call from the desktop browser
    // would come back `LOCKED`. (2) BrowseTab has direct access to
    // the unlocked wallet in this React tree, so going through a
    // cache adds a stale-read failure mode for no benefit. The
    // permission store still uses the chrome-shim — per-origin
    // permissions DO want to persist across wallet locks.
    const provider = createLiveWalletProvider(() => {
      const ws = walletStateRef.current;
      return ws && ws.kind === 'unlocked' ? ws.wallet : null;
    });
    const permissions = chromeStoragePermissionStore();
    const dispatch = createWalletHandler({
      provider,
      permissions,
      approval: queue.handler,
    });
    const bridge = createPageRequestBridge(dispatch);
    void controller.setPageRequestHandler(async (req) => {
      const resp = await bridge(req);
      return resp;
    });

    let cancelled = false;
    void controller.open().then(() => {
      if (cancelled) return;
      setOpened(true);
      void controller
        .listTabs()
        .then((tabs) => {
          if (cancelled) return;
          if (tabs.length === 0) {
            void controller.newTab('https://smirk.cash');
          }
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      // Unregister the page-request handler on unmount so a
      // re-mounted BrowseTab (different controller instance, or
      // simply hot-reload during dev) doesn't end up with a stale
      // listener pointing at a dead React tree.
      void controller.setPageRequestHandler(null);
      // Leave the controller's tabs OPEN across mounts so navigation
      // state persists when the user toggles back to Home and back
      // to Browse.
    };
  }, [controller, queue]);

  const handleApprove = async (approval: ApprovalApproval) => {
    if (!pending) return;
    const ws = walletStateRef.current;
    if (!ws || ws.kind !== 'unlocked') {
      // Wallet locked between request arrival and approve click.
      // Resolve as denied so the page sees USER_REJECTED rather
      // than hanging on the modal that just disappeared.
      queue.resolveCurrent({ approved: false });
      return;
    }
    try {
      const result = await executeApproval(pending, approval, {
        wallet: ws.wallet,
        ensureWasmInit,
        send,
        claimPublicTip,
        readBootstrapCache,
        api,
        loadState: () => store.load(),
        updateState: (m) => store.update(m),
      });
      queue.resolveCurrent(result);
    } catch (e) {
      console.error('[BrowseTab] executeApproval threw:', e);
      queue.resolveCurrent({ approved: false });
    }
  };

  const handleDeny = () => {
    queue.resolveCurrent({ approved: false });
  };

  // BrowserShell must render UNWRAPPED so its content-frame
  // `getBoundingClientRect` returns the same rect the parent
  // AppShell gave it — any extra flex/grid wrapper collapses the
  // measured slot and the embedded WebviewWindow ends up
  // positioned over a zero-size area (i.e. invisible).
  //
  // The approval modal renders as a sibling at `position: fixed`,
  // overlaying the entire wallet window (sidebar included). That's
  // intentional: while a dapp approval is pending, the only
  // sensible actions are Approve / Deny / close-wallet — letting
  // the user click the Home tab and forget the request open is a
  // worse UX.
  // When the controller advertises `inlineMode` (currently the
  // `IframeBrowserController` used on Linux desktop), pass an
  // `IframeBrowserContent` into `BrowserShell`'s frame slot so the
  // iframe elements live inside the React tree. For native-WebView
  // controllers (Tauri WebviewWindow on macOS / Windows) the slot
  // stays empty and the controller overlays its own native window
  // via `setFrameRect`. Same component for both — only the slot
  // content differs.
  const isInlineController =
    (controller as { inlineMode?: boolean }).inlineMode === true;
  const slotContent = isInlineController ? (
    <IframeBrowserContent
      controller={controller as unknown as IframeBrowserController}
    />
  ) : null;

  return (
    <Fragment>
      {!opened ? (
        <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>
          Loading browser…
        </div>
      ) : (
        <BrowserShell controller={controller} slotContent={slotContent} />
      )}
      {pending && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            style={{
              maxWidth: 420,
              width: '90%',
              maxHeight: '90%',
              overflow: 'auto',
              background: 'var(--smirk-bg)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 8,
            }}
          >
            <ApprovalScreen
              request={pending as unknown as UiApprovalRequest}
              onApprove={handleApprove}
              onDeny={handleDeny}
            />
          </div>
        </div>
      )}
    </Fragment>
  );
}

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
 * Placeholder rendered while the background `bootstrap-auth` job is
 * still running. Shows the animated doge so the wait reads as
 * intentional ("we're proving you're probably human") rather than
 * a hang. The actual work — PoW + register — happens in the
 * offscreen runner; this view just listens for the result.
 *
 * If the popup closes while this is showing, the SW continues the
 * bootstrap; the *next* popup mount finds the result in
 * `chrome.storage.session` via the bootstrap-auth job's dedup key.
 */
function BootstrappingPlaceholder({
  dogeImageUrl,
}: {
  dogeImageUrl: string;
}) {
  return (
    <div
      data-testid="bootstrapping-placeholder"
      style={{
        padding: '48px 16px 16px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          animation: 'smirk-bootstrap-bounce 0.9s ease-in-out infinite',
        }}
      >
        <img
          src={dogeImageUrl}
          alt=""
          style={{ width: 140, height: 'auto', display: 'block' }}
        />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.9 }}>
        Setting up wallet…
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          maxWidth: 280,
          lineHeight: 1.4,
        }}
      >
        Signing you in &mdash; this can take a few seconds. Safe to
        click away; the work continues in the background and resumes
        when you reopen the wallet.
      </div>
      <style>{`
        @keyframes smirk-bootstrap-bounce {
          0%, 100% { transform: translateY(0) rotate(-3deg); }
          50%      { transform: translateY(-12px) rotate(3deg); }
        }
      `}</style>
    </div>
  );
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

  // Parse via @smirk/core's `parseSessionCache` — rejects:
  //   - legacy v0.2.x { mnemonic, fingerprint, expiresAtMs } shape
  //   - missing version: 2 or missing _noMnemonic brand
  //   - any payload that re-introduces a `mnemonic` field
  // Any rejection drops the stored entry; the user re-enters their
  // password once. See keystore.ts SessionCachePayload + the
  // 2026-06-13 SECURITY_LOG.md entry.
  const entry = parseSessionCache(raw);
  if (!entry) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  if (Date.now() >= entry.expiresAtMs) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  // Cross-check fingerprint against the keystore on disk — if the
  // user re-imported a different wallet, the stale cache must not
  // unlock it.
  const ksState = await walletKeystore.getState();
  if (ksState.kind === 'empty' || ksState.keystore.fingerprint !== entry.fingerprint) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  try {
    const wallet = restoreUnlockedFromCache({
      keys: entry.keys,
      addresses: entry.addresses,
      fingerprint: entry.fingerprint,
    });
    (walletKeystore as unknown as { cached: UnlockedWallet }).cached = wallet;
    return wallet;
  } catch {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
}

/**
 * Persist the unlocked wallet's derived keys + addresses for
 * `minutes` of auto-unlock. Mnemonic is NEVER cached (2026-06-13
 * hardening — see keystore.ts file header + docs/SECURITY_LOG.md).
 *
 * `minutes` is clamped to `[0, AUTO_LOCK_MAX_MINUTES]`. The legacy
 * "Never" sentinel (negative / MAX_SAFE_INTEGER) was dropped in
 * v0.3.0; a stored legacy value self-heals to the 24h cap on read.
 */
async function writeSessionCache(wallet: UnlockedWallet, minutes: number): Promise<void> {
  const clamped = clampAutoLockMinutes(minutes);
  if (clamped === 0) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return;
  }
  const expiresAtMs = Date.now() + clamped * 60_000;
  const entry: SessionCachePayload = {
    version: 2,
    _noMnemonic: true,
    fingerprint: wallet.fingerprint,
    keys: wallet.keys,
    addresses: wallet.addresses,
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

// ============================================================================
// Balance snapshot cache.
//
// On popup reload the user previously stared at blank rows for ~10–20s
// while we re-bootstrapped and re-fetched balances from every chain.
// The data is *already* present — it just got dropped because the
// popup process was killed. Cache the last successful (balances,
// prices) tuple in chrome.storage.session so the next popup open
// renders cached values instantly, with a "refreshing" indicator
// while the background fetch repopulates fresh numbers. Stale-while-
// revalidate, identical to how the bootstrap cache speeds up auth.
//
// Trade-offs:
//   - Same chrome.storage.session backing as the bootstrap cache;
//     auto-cleared on browser close. No persistent state.
//   - Keyed by wallet fingerprint so account switching never shows
//     the previous wallet's numbers.
//   - 10 min TTL: long enough that a rapid reopen-after-close is
//     instant, short enough that a user returning from lunch sees
//     "loading" instead of trusting half-hour-old numbers.
// ============================================================================

// v1 → v2: BigInt fields explicitly stringified before storage. Brave's
// chrome.storage.session is documented to support structured clone but
// silently stringifies BigInts in practice — on read the values come
// back as strings, then mix with freshly-fetched BigInts on the next
// refresh and throw "Cannot mix BigInt and other types" deep in the
// fiat-aggregation / comparison paths (`b.pending > 0n` etc). Explicit
// string ⇄ BigInt at the boundary side-steps the ambiguity entirely.
const BALANCE_SNAPSHOT_KEY = 'smirk_balance_snapshot_v2';
const BALANCE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

interface SerializedAssetBalance {
  confirmed: string;
  pending: string;
  locked?: string;
  error?: string;
  scanProgress?: { scannedHeight: number; blockchainHeight: number; fraction: number };
  verifiedSpentInputs?: string[];
}

type SerializedBalances = Record<keyof Balances, SerializedAssetBalance>;

interface SerializedBalanceSnapshotEntry {
  fingerprint: string;
  balances: SerializedBalances;
  prices: Prices | null;
  cachedAt: number;
}

function serializeAssetBalance(b: Balances[keyof Balances]): SerializedAssetBalance {
  const out: SerializedAssetBalance = {
    confirmed: b.confirmed.toString(),
    pending: b.pending.toString(),
  };
  if (b.locked !== undefined) out.locked = b.locked.toString();
  if (b.error !== undefined) out.error = b.error;
  if (b.scanProgress !== undefined) out.scanProgress = b.scanProgress;
  if (b.verifiedSpentInputs !== undefined) out.verifiedSpentInputs = b.verifiedSpentInputs;
  return out;
}

function deserializeAssetBalance(s: SerializedAssetBalance): Balances[keyof Balances] {
  const out: Balances[keyof Balances] = {
    confirmed: BigInt(s.confirmed),
    pending: BigInt(s.pending),
  };
  if (s.locked !== undefined) out.locked = BigInt(s.locked);
  if (s.error !== undefined) out.error = s.error;
  if (s.scanProgress !== undefined) out.scanProgress = s.scanProgress;
  if (s.verifiedSpentInputs !== undefined) out.verifiedSpentInputs = s.verifiedSpentInputs;
  return out;
}

async function readBalanceSnapshot(
  walletFingerprint: string,
): Promise<{ balances: Balances; prices: Prices | null; cachedAt: number } | null> {
  try {
    const raw = await sessionStorage.get(BALANCE_SNAPSHOT_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as SerializedBalanceSnapshotEntry;
    if (entry.fingerprint !== walletFingerprint) return null;
    if (Date.now() - entry.cachedAt > BALANCE_SNAPSHOT_TTL_MS) return null;
    if (!entry.balances) return null;
    const balances = {
      btc: deserializeAssetBalance(entry.balances.btc),
      ltc: deserializeAssetBalance(entry.balances.ltc),
      xmr: deserializeAssetBalance(entry.balances.xmr),
      wow: deserializeAssetBalance(entry.balances.wow),
      grin: deserializeAssetBalance(entry.balances.grin),
    };
    return {
      balances,
      prices: entry.prices,
      cachedAt: entry.cachedAt,
    };
  } catch (e) {
    console.warn('[smirk] balance snapshot read failed', e);
    return null;
  }
}

async function writeBalanceSnapshot(
  walletFingerprint: string,
  balances: Balances,
  prices: Prices | null,
): Promise<void> {
  const entry: SerializedBalanceSnapshotEntry = {
    fingerprint: walletFingerprint,
    balances: {
      btc: serializeAssetBalance(balances.btc),
      ltc: serializeAssetBalance(balances.ltc),
      xmr: serializeAssetBalance(balances.xmr),
      wow: serializeAssetBalance(balances.wow),
      grin: serializeAssetBalance(balances.grin),
    },
    prices,
    cachedAt: Date.now(),
  };
  try {
    await sessionStorage.set(BALANCE_SNAPSHOT_KEY, entry);
  } catch (e) {
    console.warn('[smirk] balance snapshot write failed', e);
  }
}

// Read the embedded-browser controller the desktop shell installed on
// boot. `undefined` on extension builds — the BottomNav and routing
// branch on this. The narrow inline cast is the only place in the
// extension that touches the global; downstream code uses
// `browserController` instead.
const browserController: BrowserControllerGlobal | undefined =
  (globalThis as { __smirk_browser__?: BrowserControllerGlobal }).__smirk_browser__;

function App() {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
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
    // Hydrate from the balance snapshot BEFORE awaiting anything so
    // the user sees their last-known numbers within a paint. The
    // refresh path below replaces these with fresh values when the
    // network roundtrip resolves. `refreshing: true` makes the
    // header spinner spin so users know the numbers are being
    // re-fetched. Bootstrap-less placeholder so the existing render
    // path doesn't blow up; the real bootstrap lands in the try below.
    const snap = await readBalanceSnapshot(wallet.fingerprint);
    if (snap) {
      setSession({
        bootstrap: { userId: '', isNew: false },
        balances: snap.balances,
        prices: snap.prices,
        error: null,
        refreshing: true,
        refreshedAt: new Date(snap.cachedAt),
      });
    } else {
      setSession((prev) => prev ?? ({} as WalletSession));
    }
    try {
      // Prices are unauthenticated — kick them off in parallel with
      // auth so they don't sit behind the bootstrap round-trip on
      // cold start. Saves ~500ms on every fresh popup.
      const pricesPromise = fetchPrices(api).catch(
        () => null as Prices | null,
      );

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
      const balances = await fetchAllBalances(wallet, bootstrap, {
        verifyKeyImage,
        visibleAssetIds: visible,
        onAssetBalance: (assetId, balance) => {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  balances: {
                    ...(prev.balances ?? {
                      btc: { confirmed: 0n, pending: 0n },
                      ltc: { confirmed: 0n, pending: 0n },
                      xmr: { confirmed: 0n, pending: 0n },
                      wow: { confirmed: 0n, pending: 0n },
                      grin: { confirmed: 0n, pending: 0n },
                    }),
                    [assetId]: balance,
                  },
                }
              : prev,
          );
        },
      });
      const prices = await pricesPromise;
      setSession({
        bootstrap,
        balances,
        prices,
        error: null,
        refreshing: false,
        refreshedAt: new Date(),
      });
      // Persist for instant next-open. Best-effort.
      void writeBalanceSnapshot(wallet.fingerprint, balances, prices);
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
      const balances = await fetchAllBalances(wallet, bootstrap, {
        verifyKeyImage,
        visibleAssetIds: visible,
        onAssetBalance: (assetId, balance) => {
          setSession((prev) =>
            prev && prev.balances
              ? {
                  ...prev,
                  balances: { ...prev.balances, [assetId]: balance },
                }
              : prev,
          );
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
      setSession((prev) =>
        prev
          ? { ...prev, balances, prices, error: null, refreshing: false, refreshedAt: new Date() }
          : prev,
      );
      void writeBalanceSnapshot(wallet.fingerprint, balances, prices);
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
    const userId = session.bootstrap.userId;
    const wallet = walletState.wallet;
    const bootstrap = session.bootstrap;
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
        // STEP 4: seed-only Grin recovery (off by default; opt-in via build config).
        // Idempotent (backend dedupes by commitment) + best-effort, so it's
        // safe to run on every unlock and never blocks the wallet.
        if (shouldRecoverGrin(canonical)) {
          try {
            // Coalesce mid-scan refreshes: while one is in flight, skip — the
            // post-scan refresh below catches anything missed. Keeps the
            // balance live during the (minutes-long) full scan to the tip.
            let recoveryRefreshing = false;
            const recovery = await recoverGrinOutputs(mnemonic, userId, {
              startHeight: RECOVER_GRIN_BIRTHDAY_HEIGHT,
              onRecovered: () => {
                if (recoveryRefreshing) return;
                recoveryRefreshing = true;
                void refreshBalances(wallet, bootstrap).finally(() => {
                  recoveryRefreshing = false;
                });
              },
            });
            console.info('[smirk-popup] grin recovery:', recovery);
            // Final refresh to settle the full recovered total once the scan
            // completes (the mid-scan refreshes are best-effort/coalesced).
            if (recovery.recovered > 0) {
              await refreshBalances(wallet, bootstrap);
            }
          } catch (e) {
            console.warn('[smirk-popup] grin recovery threw:', e);
          }
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

  if (walletState.kind === 'empty') {
    return (
      <OnboardingWizard
        generateMnemonic={generateMnemonicPhrase}
        isValidMnemonic={isValidMnemonic}
        dogeMiningImageUrl={chrome.runtime.getURL('doge-mining.webp')}
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
          // Cache the bootstrap immediately so the standard
          // `startSession` effect (which fires the moment walletState
          // transitions to unlocked) finds a warm cache and skips a
          // second bootstrap. Pre-PoW that doubled call cost ~50ms;
          // post-PoW it would have re-run a full ~1-2s PBKDF2 solve.
          const onboardBootstrap = await bootstrapAuthInExtension(api, wallet);
          const onboardToken = api.getAccessToken();
          if (onboardToken) {
            await writeBootstrapCache(
              wallet.fingerprint,
              onboardToken,
              onboardBootstrap,
            );
          }
          // Surface any identity this wallet already owns on the
          // backend (Smirk handle + linked socials). Issued in
          // parallel — both are read-only and one slow leg shouldn't
          // hold up the other. Failures are non-fatal: the wizard
          // falls back to the reserve-handle prompt when the lookup
          // can't be completed (offline, transient 5xx, etc.).
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
                    // Render verified first to lead with the strongest signal,
                    // pending after. Ordering only affects display.
                    .slice()
                    .sort((a, b) => Number(b.verified) - Number(a.verified))
                    .map((s) => ({
                      platform: s.platform,
                      username: s.username ?? s.display_name ?? s.platform_user_id ?? '',
                      verified: s.verified,
                    }))
                    // Drop rows we can't usefully label.
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
              tips={tipInbox.tips}
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
          settings: (
            <SettingsRouter
              wallet={walletState.wallet}
              session={session}
              onRefresh={handleRefresh}
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
  tips,
  onRefresh,
  onTipClaim,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** All received tips, pending + claimable. Home only renders a
   *  claim banner for the subset where funding has matured; Inbox
   *  owns the full list + per-tip rows. */
  tips: InboxTipItem[];
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
          const r = await chainProviders.utxo(assetId).estimateFee();
          if (r.error || r.data?.model !== 'rate-estimate') {
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
            const outs = await chainProviders.grin().listOutputs(grinUserId);
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
          // (Phase 2C piece 1: mempool double-spend prevention.)
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
                  const r = await chainProviders.grin().listOutputs(grinUserId);
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              receiverSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              amount: Number(amountAtomic),
              fee: Number(feeAtomic),
              resolver: {
                fetchSpendable: async () => {
                  const r = await chainProviders.grin().listOutputs(grinUserId);
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
                  const r = await chainProviders.grin().listOutputs(grinUserId);
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
              userId: grinUserId,
              mnemonic: wallet.mnemonic,
              payerSlatepackAddress: canonicalGrinSlatepackAddress(wallet.mnemonic),
              i1Armored,
              resolver: {
                fetchSpendable: async () => {
                  const r = await chainProviders.grin().listOutputs(grinUserId);
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
        // onCycleDenomination intentionally omitted — UnifiedBalance
        // suppresses the pointer cursor when the handler is absent so
        // users don't get a misleading "click me" affordance. Wire
        // this when denomination cycling lands (tracked for v0.3.x).
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
        <>
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

/**
 * PasteTipLinkScreen — entry point for public tips shared as a URL.
 *
 * Public tips never land in the received-tips list because they're
 * not addressed to a specific username; the URL fragment is the only
 * access token. Whoever pastes the link in here can claim the funds.
 *
 * On success we render the swept amount + txid in a toast and bounce
 * back to Inbox; the shell auto-unhides the asset so the funds appear
 * on Home.
 */
function PasteTipLinkScreen({
  onReadClipboard,
  onClaim,
  onExit,
}: {
  onReadClipboard?: () => Promise<string>;
  onClaim: (
    url: string,
  ) => Promise<
    | { ok: true; assetId?: string; amountAtomic?: bigint }
    | { ok: false; error: string }
  >;
  onExit: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    assetId?: string;
    amountAtomic?: bigint;
  } | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Paste a tip link first.');
      return;
    }
    setError(null);
    setBusy(true);
    const outcome = await onClaim(trimmed);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    const next: { assetId?: string; amountAtomic?: bigint } = {};
    if (outcome.assetId !== undefined) next.assetId = outcome.assetId;
    if (outcome.amountAtomic !== undefined) next.amountAtomic = outcome.amountAtomic;
    setResult(next);
  };

  const pasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      setText(clip);
      setError(null);
    } catch {
      setError('Could not read clipboard. Paste manually below.');
    }
  };

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ width: 60 }} />
          <span style={{ opacity: 0.5 }}>Tip claimed</span>
          <span style={{ width: 60 }} />
        </header>
        <div
          data-testid="paste-tip-success"
          style={{
            padding: 16,
            background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
            border: '1px solid var(--smirk-accent)',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {result.assetId && result.amountAtomic !== undefined
              ? `Received ${formatAmountWithTicker(result.amountAtomic, result.assetId)}`
              : 'Tip claimed'}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--smirk-fg-muted)',
              marginTop: 6,
            }}
          >
            Funds are settling on-chain. They'll appear on Home shortly.
          </div>
        </div>
        <button
          onClick={onExit}
          data-testid="paste-tip-done-btn"
          style={{
            background: 'var(--smirk-accent)',
            color: 'var(--smirk-accent-fg, #fff)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            padding: '10px 16px',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          Back to Inbox
        </button>
      </div>
    );
  }

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
        <span style={{ opacity: 0.5 }}>Paste tip link</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Claim a tip from a link</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
        Paste a Smirk public-tip URL (smirk.cash/tip/…#…). The fragment
        after the # is the spend key — keep the full URL secret until
        you've claimed.
      </div>

      <textarea
        data-testid="paste-tip-input"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="https://smirk.cash/tip/…#…"
        rows={3}
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
        <div data-testid="paste-tip-error" style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {onReadClipboard && (
          <button
            data-testid="paste-tip-clipboard-btn"
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
          data-testid="paste-tip-claim-btn"
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
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      </div>
    </div>
  );
}

// ----- Other tabs (still stubs) -----

/**
 * SwapRouter — wires the @smirk/ui SwapTab to the TrocadorSwap library
 * and the wallet's send-handler. Single-provider for v0.3 (Trocador);
 * additional providers slot in by extending the wizard branch in
 * SwapTab and adding more handlers here.
 *
 * Client-direct architecture (V0_3_PLAN.md Decision 2): Trocador calls
 * go straight from this context to api.trocador.app. Backend
 * involvement is bookkeeping only — `POST /api/v1/swaps` so the
 * status mirror webhook has somewhere to write.
 */
function SwapRouter({
  wallet,
  session,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
}) {
  const { navigate } = useRoute();
  const apiKey = import.meta.env.VITE_TROCADOR_API_KEY ?? '';
  // Webhook URL pointing at *our* backend's receiver. Trocador POSTs
  // status changes here; receiver authenticates via the per-swap
  // webhook_token passed in `passthrough`.
  const webhookBase =
    import.meta.env.VITE_SMIRK_BACKEND_URL ?? 'https://backend.smirk.cash';
  const webhookUrl = `${webhookBase}/api/v1/webhook/trocador`;

  // Instantiate TrocadorSwap once per mount with build-time config.
  // passthrough is set on a per-trade basis (random token), not here.
  const trocador = useMemo(
    () =>
      apiKey
        ? new TrocadorSwap({ apiKey, webhookUrl })
        : null,
    [apiKey, webhookUrl],
  );

  if (!trocador) {
    return (
      <div>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Swap</h2>
        <p class="muted" style={{ fontSize: 12 }}>
          Swap is disabled in this build (VITE_TROCADOR_API_KEY unset).
          Set it at build time to enable Trocador.
        </p>
      </div>
    );
  }

  return (
    <SwapTab
      fromAssets={listAssets()
        .filter((a) => a.sendable && trocador.isKnownAsset(a.id))
        .map((a) => a.id)}
      toAssets={listAssets()
        .filter((a) => a.receivable && trocador.isKnownAsset(a.id))
        .map((a) => a.id)}
      resolveBalance={(assetId) => {
        // Pull from the session's last-fetched balance snapshot.
        const b = session?.balances?.[
          assetId as keyof NonNullable<WalletSession['balances']>
        ];
        return b ? b.confirmed : null;
      }}
      parseAmount={(assetId, text) => parseAmount(assetId, text)}
      resolveIcon={resolveIcon}
      resolveAddress={(assetId) =>
        (wallet.addresses as unknown as Record<string, string | undefined>)[
          assetId
        ] ?? null
      }
      // Reuse the SendWizard's validator. The swap surface ignored
      // address format pre-2026-06-13 — any address the user pasted
      // was forwarded to /new_trade unchanged, opening the wrong-
      // chain refund hazard (XMR refunded to a BTC address, etc.).
      // `validateAddress` is the same helper SendWizard uses.
      validateAddress={validateAddress}
      onListRecentSwaps={async () => {
        // Surface any non-terminal swap whose wizard state was lost
        // (X-button cancel, popup-close during confirm, browser
        // restart). listSwaps already shipped in @smirk/core but
        // had zero consumers before today.
        const res = await api.listSwaps().catch(() => null);
        if (!res || res.error || !res.data) return [];
        return res.data.swaps.map((r) => ({
          id: r.trade_id,
          fromAsset: r.from_asset,
          toAsset: r.to_asset,
          fromAmountAtomic: r.amount_from_atomic,
          toAmountEstimateAtomic: r.amount_to_atomic ?? '0',
          depositAddress: r.deposit_address,
          status: r.status,
          createdAt: r.created_at,
        }));
      }}
      onResumeSwap={async (summary) => {
        // Rehydrate the trocador wizard state in one atomic write so
        // the user lands directly on StatusStep with live polling.
        // The state is set from the cached backend summary; the
        // real-time merge happens via onTrocadorFetchStatus on the
        // first 10s tick. Step is 3 (Status), not 2 (Deposit),
        // because resuming means "I already sent" — DepositStep
        // would offer to re-pre-fill the Send wizard, which is
        // wrong for a resumed swap.
        await store.update((s) => {
          const w = s.wizards[TROCADOR_WIZARD_ID];
          const inFlight: SwapInFlight = {
            id: summary.id,
            fromAsset: summary.fromAsset,
            toAsset: summary.toAsset,
            fromAmountAtomic: summary.fromAmountAtomic,
            toAmountEstimateAtomic: summary.toAmountEstimateAtomic,
            depositAddress: summary.depositAddress,
            state: { state: 'pending', reason: 'awaiting_deposit' },
          };
          if (w) {
            w.fields = { ...w.fields, inFlight, step: 3 };
          } else {
            s.wizards[TROCADOR_WIZARD_ID] = {
              step: 0,
              fields: { step: 3, inFlight },
              startedAt: Date.now(),
            };
          }
        });
      }}
      onTrocadorQuote={async (req) => {
        const q = await trocador.quote({
          fromAsset: req.fromAsset,
          toAsset: req.toAsset,
          fromAmount: req.fromAmountAtomic,
        });
        const impl = q.implementationData as
          | { tradeId?: string; provider?: string }
          | null;
        const sum: SwapQuoteSummary = {
          tradeId: impl?.tradeId ?? '',
          fromAsset: q.fromAsset,
          toAsset: q.toAsset,
          fromAmountAtomic: q.fromAmount,
          toAmountEstimateAtomic: q.toAmountEstimate,
          feeEstimateAtomic: q.feeEstimate,
          provider: impl?.provider ?? '',
          etaSeconds: q.etaSeconds,
          expiresAtMs: q.expiresAt.getTime(),
        };
        return sum;
      }}
      onTrocadorConfirm={async ({ quote, toAddress, refundAddress }) => {
        if (!quote.tradeId || !quote.provider) {
          throw new Error('Quote is missing trade context — please re-quote.');
        }
        // Per-swap shared-secret. Trocador echoes back as
        // passthrough on the webhook; backend verifies match.
        const webhookToken = randomToken(24);
        // Rebuild a SwapQuote from persisted fields. The Trocador
        // library only reads (tradeId, provider, amountFromDecimal,
        // amountToDecimal) from implementationData on /new_trade —
        // we don't need to round-trip the original quote object.
        const fromAsset = mustGetAsset(quote.fromAsset);
        const toAsset = mustGetAsset(quote.toAsset);
        const rebuiltQuote = {
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          fromAmount: quote.fromAmountAtomic,
          toAmountEstimate: quote.toAmountEstimateAtomic,
          feeEstimate: quote.feeEstimateAtomic,
          etaSeconds: quote.etaSeconds,
          expiresAt: new Date(quote.expiresAtMs),
          kind: 'aggregator' as const,
          implementationData: {
            tradeId: quote.tradeId,
            provider: quote.provider,
            amountFromDecimal: atomicToText(quote.fromAmountAtomic, fromAsset.id),
            amountToDecimal: atomicToText(quote.toAmountEstimateAtomic, toAsset.id),
          },
        };
        const started = await trocador.start({
          quote: rebuiltQuote,
          toAddress,
          refundAddress,
          // Per-trade webhook secret. Without this, Trocador delivers
          // every webhook with passthrough=null and the backend
          // rejects every one as a token mismatch — the 60s backup
          // poller would be the only finalization path. See the
          // 2026-06-13 swap-e2e review ship-blocker write-up.
          passthrough: webhookToken,
        });

        // Build the SwapInFlight up front so we can persist it to
        // the trocador wizard BEFORE awaiting backend createSwap.
        // Trocador's /new_trade is non-idempotent network state —
        // an MV3 popup-close between /new_trade success and the
        // wizard write strands the trade with no recovery
        // affordance. Writing inFlight first means the user always
        // has the deposit address + trade_id locally even if
        // backend createSwap fails or the popup closes mid-handler.
        const sw: SwapInFlight = {
          id: started.id,
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          fromAmountAtomic: quote.fromAmountAtomic,
          toAmountEstimateAtomic: quote.toAmountEstimateAtomic,
          depositAddress: started.depositAddress,
          state: { state: 'pending', reason: 'awaiting_deposit' },
        };
        await store.update((s) => {
          const w = s.wizards[TROCADOR_WIZARD_ID];
          if (w) {
            w.fields = { ...w.fields, inFlight: sw, step: 2 };
          }
        });

        // Persist to backend so the webhook receiver knows the token.
        // Best-effort — failure here means status updates from the
        // webhook won't be authenticated (rejected as 404), but the
        // UI's direct-poll-on-Trocador path still works.
        let backendTrackingOk = true;
        try {
          const res = await api.createSwap({
            trade_id: started.id,
            from_asset: quote.fromAsset,
            to_asset: quote.toAsset,
            amount_from_atomic: quote.fromAmountAtomic,
            deposit_address: started.depositAddress,
            recipient_address: toAddress,
            refund_address: refundAddress,
            provider: quote.provider,
            webhook_token: webhookToken,
          });
          backendTrackingOk = !res.error;
          if (res.error) {
            console.warn('[swap] backend createSwap returned error:', res.error);
          }
        } catch (e) {
          backendTrackingOk = false;
          console.warn('[swap] backend createSwap threw (non-fatal)', e);
        }
        void backendTrackingOk;
        return sw;
      }}
      onOpenSend={(deposit) => {
        // Pre-fill the SendWizard with the deposit address + amount so
        // the user lands directly on Compose with everything filled.
        // Also stash a `pendingContext` so the resulting
        // pendingOutgoing entry is tagged as a swap-deposit — the
        // AssetDetail Activity row then renders "Swap deposit → XMR
        // (CDNQ…)" with a tap-link back to the swap status, instead
        // of a generic "Sending to LTC1Q…".
        //
        // Guard against silently destroying an in-progress send
        // draft: pre-2026-06-13 this handler unconditionally
        // overwrote s.wizards.send, so a user with a half-typed
        // send to a friend would lose their draft on the prefill
        // click. Other update sites at lines 2067, 2454, 4321 all
        // use the safe `const w = s.wizards.send; if (w)` pattern;
        // only this handler nuked the slot. Now we check, prompt,
        // and bail if the user wants to keep their draft.
        void (async () => {
          const current = await store.load();
          const existing = current.wizards.send;
          // Heuristic: a populated draft has at least one of the
          // user-typed fields (fromAssetId at non-empty, toAddress,
          // amountText). An empty step=0 wizard from a previous
          // visit doesn't count.
          const f = existing?.fields as
            | { fromAssetId?: string; toAddress?: string; amountText?: string }
            | undefined;
          const isPopulated =
            !!f &&
            (!!f.toAddress ||
              !!f.amountText ||
              (!!f.fromAssetId && (existing?.step ?? 0) > 0));
          if (isPopulated) {
            const ok = window.confirm(
              'You have a Send draft in progress — replace it with this swap deposit?',
            );
            if (!ok) return;
          }
          await store.update((s) => {
            s.wizards.send = {
              step: 2, // skip Pick + Address; jump to Compose
              startedAt: Date.now(),
              fields: {
                fromAssetId: deposit.fromAsset,
                toAddress: deposit.depositAddress,
                amountText: atomicToText(
                  deposit.fromAmountAtomic,
                  deposit.fromAsset,
                ),
                pendingContext: {
                  kind: 'swap-deposit',
                  tradeId: deposit.id,
                  toAsset: deposit.toAsset,
                  provider: 'trocador',
                },
                // Stash the original prefill seed so the
                // popup-level onSubmit cross-checker (below) can
                // verify the user didn't mutate fromAsset/toAddress
                // mid-flow into something unrelated. Mismatch =
                // drop the pendingContext at write time so the
                // resulting Activity row says "Send" not the wrong
                // "Swap deposit → XMR (trade …)".
                pendingContextSeed: {
                  fromAssetId: deposit.fromAsset,
                  toAddress: deposit.depositAddress,
                },
              },
            };
          });
          await navigate('home/send');
        })();
      }}
      onTrocadorFetchStatus={async (id) => {
        // Hybrid: backend for identities (from/to/amount/address),
        // Trocador direct for state. v0.3.0 originally trusted the
        // backend's `status` column unconditionally — but the only
        // signal that flips it is Trocador's webhook into
        // `/api/v1/webhook/trocador`, and there's no backend poller
        // to backstop a missed delivery. Real failure mode dogfooded
        // 2026-06-04: LTC→XMR swap completed on Trocador's side, no
        // webhook landed, backend stayed at `status='new'`, wallet
        // showed "Waiting for your deposit" forever.
        //
        // Fix: when backend has a record but its status is
        // non-terminal, ALSO query Trocador direct and prefer the
        // direct state. Terminal backend statuses (finished /
        // refunded / expired / error) are trusted as-is because the
        // backend mirror won't regress past those. If both calls
        // fail, fall through to whichever returned data.
        const backend = await api.getSwap(id).catch(() => null);
        if (backend && backend.data) {
          const r = backend.data;
          const backendTerminal =
            r.status === 'finished' ||
            r.status === 'refunded' ||
            r.status === 'expired' ||
            r.status === 'error';
          // Take the backend's identities + last-known state as the
          // baseline. `mapBackendStatus` uses these to render real
          // copy on terminal states (final to-amount on `finished`,
          // refund-address hint on `refunded`/`expired`).
          let state = mapBackendStatus(r.status, {
            ...(r.amount_to_atomic ? { amountToAtomic: r.amount_to_atomic } : {}),
            ...(r.refund_address ? { refundAddress: r.refund_address } : {}),
          });
          if (!backendTerminal) {
            // Augment with Trocador direct. Best-effort: a Trocador
            // outage shouldn't tank the polling loop — keep the
            // backend's state as a fallback.
            try {
              const live = await trocador.status(id);
              state = live;
            } catch (e) {
              console.warn(
                '[swap] Trocador direct status fallback failed; using backend state',
                e,
              );
            }
          }
          return {
            id,
            fromAsset: r.from_asset,
            toAsset: r.to_asset,
            fromAmountAtomic: r.amount_from_atomic,
            toAmountEstimateAtomic: r.amount_to_atomic ?? '0',
            depositAddress: r.deposit_address,
            state,
          };
        }
        // Backend doesn't know about this swap — go direct.
        const s = await trocador.status(id);
        return {
          id,
          // Identity fields aren't available from Trocador's /trade
          // response in a stable shape; the wizard merges via
          // onUpdate which preserves the persisted fields and only
          // overwrites `state` with the values we return.
          fromAsset: '',
          toAsset: '',
          fromAmountAtomic: '0',
          toAmountEstimateAtomic: '0',
          depositAddress: '',
          state: s,
        };
      }}
    />
  );
}

/** Translate the backend's status string (a verbatim mirror of
 *  Trocador's lifecycle) into the SwapInFlight discriminated union
 *  the UI renders. Kept here so the popup is the only place that
 *  knows the Trocador-string ↔ structured-state mapping.
 *
 *  `extra` carries the parts of the persisted SwapRecord that the
 *  status alone can't supply — the final to-amount (Trocador stores
 *  this on the row at terminal-transition; pre-2026-06-13 the
 *  mapper hardcoded '0' so every completed swap showed
 *  "Completed — 0 LTC sent"), and the refund address (needed so the
 *  'expired' state can tell the user where their deposit will return
 *  to if they did broadcast). Both are optional — the caller may
 *  not have them yet — and the mapper falls back to neutral copy
 *  when they're absent. */
function mapBackendStatus(
  status: string,
  extra?: { amountToAtomic?: string; refundAddress?: string },
): SwapInFlight['state'] {
  switch (status) {
    case 'new':
    case 'waiting':
      return { state: 'pending', reason: 'awaiting_deposit' };
    case 'confirming':
      return { state: 'pending', reason: 'awaiting_confirmations' };
    case 'exchanging':
    case 'sending':
      return { state: 'pending', reason: 'in_progress' };
    case 'finished':
      return {
        state: 'completed',
        outboundTxId: '',
        toAmount: extra?.amountToAtomic ?? '0',
      };
    case 'refunded': {
      // Surface the refund destination when we have it — gives the
      // user a chain address to watch instead of "trust us, it's on
      // its way back."
      const reason = extra?.refundAddress
        ? `Refunded by provider to ${extra.refundAddress}`
        : 'Refunded by provider';
      return { state: 'refunded', refundTxId: '', reason };
    }
    case 'expired': {
      // Trocador's `expired` covers TWO real-world cases: (a) the
      // quote validity window elapsed before any deposit arrived —
      // no money moved — and (b) deposit landed but the underlying
      // provider couldn't complete in time, refund in flight. We
      // don't have a reliable backend signal to discriminate (we'd
      // need historical state transitions or amount-observed
      // logging), so the copy here informs both cases honestly
      // rather than asserting "Quote expired before deposit" which
      // is actively wrong half the time. Refund address is surfaced
      // when we know it, so case (b) users can watch the right
      // chain.
      const refundHint = extra?.refundAddress
        ? ` If you deposited, funds will be returned to ${extra.refundAddress}.`
        : ' If you deposited, funds will be returned to your refund address.';
      return {
        state: 'failed',
        reason: `Quote expired or provider could not complete in time.${refundHint}`,
      };
    }
    case 'error':
      return { state: 'failed', reason: 'Provider reported error' };
    default:
      // Unknown status from the backend mirror. Surface it as a
      // failure with the raw value so the user (and Smirk support)
      // can act on it, rather than silently parking on
      // "in_progress" which the wizard renders as "Provider
      // exchanging" forever — that's how the 2026-06-04 audit
      // found a future-Trocador-status would manifest as a stuck
      // visual on a swap that actually completed.
      return {
        state: 'failed',
        reason: `Unknown provider status: ${status || '(empty)'}`,
      };
  }
}

function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  // base64url so it travels cleanly through Trocador's passthrough
  // round-trip without URL-encoding tripping anything up.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function atomicToText(atomic: string, assetId: string): string {
  const asset = mustGetAsset(assetId);
  const decimals = asset.decimals;
  const n = BigInt(atomic);
  if (decimals === 0) return n.toString();
  const padded = n.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
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
  onRefresh,
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
  /** Trigger a balance refresh. Called after sweeping (claim or
   *  clawback) so the user sees recovered funds without manual
   *  intervention. */
  onRefresh: () => Promise<void>;
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
  const sessionState = useSessionState();
  const { navigate } = useRoute();
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

  // In-flight outgoing rows: pulled live from session state so they
  // disappear cleanly when the entry ages out or reconciles, without
  // forcing a history refetch. Renders at the top of Activity (any
  // chain-side row of the same tx will show up at its real block
  // height; the pending row stays a separate "still mempool" entry
  // until the entry is reaped).
  const pendingRows: AssetDetailTxRow[] = useMemo(() => {
    const entries = sessionState.pendingOutgoing ?? [];
    return entries
      .filter((e) => e.asset === assetId)
      .map((e) => {
        const row: AssetDetailTxRow = {
          kind: 'pending-outgoing',
          txid: e.txHash,
          amountAtomic: BigInt(e.amount),
          feeAtomic: BigInt(e.fee),
          recipient: e.recipient,
          submittedAt: new Date(e.submittedAt).toISOString(),
          ...(e.context ? { context: e.context } : {}),
        };
        return row;
      });
  }, [sessionState.pendingOutgoing, assetId]);

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
      // Prepend in-flight outgoing rows so the user sees their just-
      // broadcast tx immediately — Home's `↑ X sending` subline and
      // this Activity row come from the same `pendingOutgoing` source.
      history={[...pendingRows, ...history]}
      loading={loading}
      onBack={onBack}
      onSend={onSend}
      onReceive={onReceive}
      onTip={onTip}
      onOpenExplorer={(row) => {
        // Tip rows are tracked by tip_id, not chain-level — no
        // explorer URL applies. Skip silently for those.
        if (row.kind === 'tip-sent' || row.kind === 'tip-received') return;
        // Pending-outgoing rows route by context: swap-deposit jumps
        // straight to the Swap tab so the user lands on the Trocador
        // status page they were probably trying to find. tip-fund
        // falls through to the chain explorer (the broadcast tx
        // exists on-chain even though the tip-detail surface doesn't
        // exist as a route yet). Plain sends → chain explorer.
        if (row.kind === 'pending-outgoing') {
          if (row.context?.kind === 'swap-deposit') {
            void navigate('swap');
            return;
          }
          const url = explorerUrlForPendingOutgoing(assetId, row.txid);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        const url = explorerUrlForRow(assetId, row);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }}
      onTipClawback={async (tipId) => {
        // Full on-chain clawback: decrypt local backup → sweep tip
        // address back into the sender's wallet → mark backend.
        // Pre-2026-06-04 this was a backend-only status flip; the
        // funds were left orphaned at the tip address. See
        // tip-claim-handler.ts::clawbackSocialTip.
        const userId = session?.bootstrap?.userId;
        if (!userId) return { ok: false, error: 'Wallet not bootstrapped' };
        const outcome = await clawbackSocialTip(wallet, userId, tipId);
        if (!outcome.ok) return { ok: false, error: outcome.error };
        await removeTipKeyBackup(tipId);
        // Refresh balances so the user sees the swept funds.
        void onRefresh();
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
  // pending-outgoing rows carry `submittedAt` (the broadcast time)
  // instead of `timestamp` — they pre-date any chain-side timestamp
  // so they sort to the very top of newest-first Activity.
  const iso = row.kind === 'pending-outgoing' ? row.submittedAt : row.timestamp;
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
    const r = await chainProviders.utxo(assetId).getHistory(addr);
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
    const r = await chainProviders.lws(assetId).getHistory(addr, viewKeyHex);
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
    const r = await chainProviders.grin().getHistory(userId);
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

/** Tap target for a `pending-outgoing` row when no richer context
 *  applies — opens the chain explorer for the broadcast txid. Grin's
 *  Mimblewimble model has no per-tx URL, so it returns null. */
function explorerUrlForPendingOutgoing(
  assetId: string,
  txid: string,
): string | null {
  if (assetId === 'btc') return `https://mempool.space/tx/${txid}`;
  if (assetId === 'ltc') return `https://litecoinspace.org/tx/${txid}`;
  if (assetId === 'xmr') return `https://xmrchain.net/tx/${txid}`;
  if (assetId === 'wow') return `https://explore.wownero.com/tx/${txid}`;
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
      onPasteTipLink={() => navigate('home/inbox/paste-tip')}
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
  // 2026-06-13: dropped the "Never (until browser closes)" /
  // -1 / MAX_SAFE_INTEGER option as part of the wrapped-key
  // session-cache hardening. AUTO_LOCK_MAX_MINUTES (24h) is the
  // hardest upper bound now — anything beyond clamps. See
  // keystore.ts file header.
  { value: AUTO_LOCK_MAX_MINUTES, label: '24 hours (maximum)' },
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

/**
 * Settings tab router.
 *
 * Two sub-routes today:
 *   - `settings`            — the main Settings page (SettingsStub)
 *   - `settings/sent-tips`  — cross-asset Sent Tips list with
 *                             inline Clawback + Discard Draft actions.
 *
 * Per-asset history already surfaces sent-tip rows inline in
 * AssetDetailScreen; this is the cross-asset surface — find a
 * forgotten clawback-eligible tip across all 5 chains in one place.
 */
function SettingsRouter({
  wallet,
  session,
  onRefresh,
  onLock,
  onForgetComplete,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Balance refresh — threaded through to SentTipsRoute so clawback
   *  can show the recovered funds immediately. */
  onRefresh: () => Promise<void>;
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
}) {
  const { route, navigate } = useRoute();
  if (route.current === 'settings/sent-tips') {
    return (
      <SentTipsRoute
        wallet={wallet}
        session={session}
        onRefresh={onRefresh}
        onBack={() => void navigate('settings')}
      />
    );
  }
  if (route.current === 'settings/nostr') {
    return <NostrIdentityRoute wallet={wallet} onBack={() => void navigate('settings')} />;
  }
  if (route.current === 'settings/messages') {
    return <MessagesRoute wallet={wallet} onBack={() => void navigate('settings')} />;
  }
  return (
    <SettingsStub
      wallet={wallet}
      onLock={onLock}
      onForgetComplete={onForgetComplete}
    />
  );
}

/**
 * Settings → Nostr identity (Identity Phase 1). Derives the seed's Nostr identity
 * (NIP-06 hardened account), shows the npub, links it to this account via a NIP-98
 * signed action (`api.linkNostr`), and supports account rotation. A linked npub
 * lets the user "Sign in with Nostr" (NIP-98) on any Smirk-compatible backend.
 *
 * The private key never leaves core; this screen only derives the npub for
 * display and hands the identity to `api.linkNostr`, which signs in-memory.
 */
function NostrIdentityRoute({
  wallet,
  onBack,
}: {
  wallet: UnlockedWallet;
  onBack: () => void;
}) {
  const [account, setAccount] = useState(0);
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [linkedPubkey, setLinkedPubkey] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'linking'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  // Derive the identity for the selected account (client-side, no network).
  useEffect(() => {
    const mnemonic = wallet.mnemonic;
    if (!mnemonic) {
      // Cleared, not stale: if the wallet locks while this screen is open, drop
      // the derived identity so the npub/badge don't linger next to the error.
      setIdentity(null);
      setError('Wallet is locked — unlock to view your Nostr identity');
      return;
    }
    try {
      setIdentity(deriveNostrIdentity(mnemonic, account));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to derive identity');
    }
  }, [wallet.mnemonic, account]);

  // Detect an already-linked npub so the linked badge shows on open. Race-guard:
  // ignore this result if the component unmounted, and never clobber a value a
  // concurrent link() already set (functional update keeps the non-null one).
  useEffect(() => {
    let stale = false;
    void api.getMe().then((r) => {
      const pk = r.data?.nostrPubkey;
      if (!stale && pk) setLinkedPubkey((prev) => prev ?? pk);
    });
    return () => {
      stale = true;
    };
  }, []);

  const isLinked = !!identity && linkedPubkey === identity.pubkeyHex;
  // The backend stores exactly ONE npub per account: a different linked key means
  // linking the selected one REPLACES it (rotation), not accumulates.
  const replacesExisting = !!linkedPubkey && !isLinked;

  const link = async () => {
    if (!identity) return;
    setStatus('linking');
    setError(undefined);
    const r = await api.linkNostr(identity);
    setStatus('idle');
    if (r.data?.nostrPubkey) {
      setLinkedPubkey(r.data.nostrPubkey);
    } else if (r.status === 409) {
      setError('This Nostr identity is already linked to a different Smirk account.');
    } else if (r.status === 401) {
      setError('Your session expired — unlock and try again.');
    } else {
      setError(r.error ?? 'Link failed');
    }
  };

  return (
    <div data-testid="settings-nostr-screen">
      <button
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
          padding: '4px 0',
          opacity: 0.7,
        }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, marginTop: 4 }}>Nostr identity</h2>
      <p style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4, marginTop: 4 }}>
        Your seed-derived Nostr key. Link it to sign in with Nostr (NIP-98) on any
        Smirk-compatible backend.
      </p>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>Your npub</span>
        <div
          data-testid="nostr-npub"
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            wordBreak: 'break-all',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6,
          }}
        >
          {identity?.npub ?? '…'}
        </div>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          opacity: 0.85,
          marginTop: 12,
        }}
      >
        Account
        <select
          value={String(account)}
          onChange={(e) => setAccount(Number((e.target as HTMLSelectElement).value))}
          data-testid="nostr-account-select"
          style={settingsInputStyle}
        >
          {[0, 1, 2, 3, 4].map((n) => (
            <option key={n} value={n} data-testid={`nostr-account-option-${n}`}>
              {n}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10, opacity: 0.5 }}>
          one linked identity — changing account replaces it
        </span>
      </label>

      {replacesExisting && (
        <p
          data-testid="nostr-replaces-note"
          style={{ fontSize: 11, color: '#f59e0b', marginTop: 10, lineHeight: 1.4 }}
        >
          A different Nostr identity is already linked to this account. Linking this
          one replaces it — you keep a single linked identity.
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        {isLinked ? (
          <div
            data-testid="nostr-linked-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 6,
              background: 'rgba(34,197,94,0.12)',
              border: '1px solid rgba(34,197,94,0.4)',
              color: '#22c55e',
              fontSize: 13,
            }}
          >
            ✓ Linked to this account
          </div>
        ) : (
          <button
            data-testid="nostr-link-btn"
            onClick={() => void link()}
            disabled={status === 'linking' || !identity}
            style={{
              padding: '8px 14px',
              background: 'var(--smirk-accent, #6366f1)',
              border: 'none',
              borderRadius: 6,
              color: 'var(--smirk-accent-fg, #fff)',
              fontFamily: 'inherit',
              fontSize: 13,
              cursor: status === 'linking' ? 'default' : 'pointer',
              opacity: status === 'linking' ? 0.7 : 1,
            }}
          >
            {status === 'linking'
              ? 'Linking…'
              : replacesExisting
                ? 'Replace linked identity'
                : 'Link this identity'}
          </button>
        )}
      </div>

      {error && (
        <div data-testid="nostr-error" style={{ color: '#ef4444', fontSize: 12, marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Messages (Identity/messaging plane). Basic NIP-17 encrypted DMs over
 * the backend's relay: subscribe to our inbox while open, and compose to an npub.
 * Reads the relay URL from /capabilities and self-disables when the instance runs
 * no relay. The subscription lives for the screen's lifetime (a basic surface;
 * background delivery + notifications are future work).
 */
function MessagesRoute({ wallet, onBack }: { wallet: UnlockedWallet; onBack: () => void }) {
  const [ready, setReady] = useState<'loading' | 'off' | 'on'>('loading');
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let sub: DmSubscription | undefined;
    let cancelled = false;
    void (async () => {
      const caps = await api.getCapabilities();
      const relayUrl = caps.data?.messaging?.relay_url;
      if (!caps.data?.features?.nostr_relay || !relayUrl) {
        if (!cancelled) setReady('off');
        return;
      }
      if (!wallet.mnemonic) {
        if (!cancelled) {
          setError('Unlock the wallet to use messaging');
          setReady('off');
        }
        return;
      }
      // Local-only for now: the Smirk relay is the inbox; public interop relays
      // are added when we resolve a recipient's kind-10050 (future).
      initSmirkMessaging({ relayUrl, publicRelays: [] });
      const id = deriveNostrIdentity(wallet.mnemonic, 0);
      if (cancelled) return;
      setIdentity(id);
      sub = subscribeDms(id, (dm) => {
        if (cancelled) return;
        setMessages((prev) =>
          prev.some((m) => m.id === dm.id)
            ? prev
            : [dm, ...prev].sort((a, b) => b.createdAt - a.createdAt),
        );
      });
      setReady('on');
    })().catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Messaging failed to start');
        setReady('off');
      }
    });
    return () => {
      cancelled = true;
      sub?.close();
    };
  }, [wallet.mnemonic]);

  const send = async () => {
    if (!identity || !recipient.trim() || !text.trim()) return;
    setStatus('sending');
    setError(undefined);
    try {
      await sendDm(identity, recipient.trim(), text.trim());
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    }
    setStatus('idle');
  };

  return (
    <div data-testid="messages-screen">
      <button
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
          padding: '4px 0',
          opacity: 0.7,
        }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, marginTop: 4 }}>Messages</h2>

      {ready === 'off' ? (
        <p data-testid="messages-relay-off" style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4 }}>
          {error ?? 'This backend does not run a Nostr relay, so encrypted messaging is unavailable.'}
        </p>
      ) : (
        <>
          <p style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.4, marginTop: 4 }}>
            End-to-end encrypted (NIP-17). Send to an npub; incoming messages appear
            below while this screen is open.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            <input
              data-testid="dm-recipient-input"
              placeholder="recipient npub1…"
              value={recipient}
              onInput={(e) => setRecipient((e.target as HTMLInputElement).value)}
              style={settingsInputStyle}
            />
            <textarea
              data-testid="dm-text-input"
              placeholder="Message"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{ ...settingsInputStyle, resize: 'vertical' }}
            />
            <button
              data-testid="dm-send-btn"
              onClick={() => void send()}
              disabled={status === 'sending' || ready !== 'on' || !recipient.trim() || !text.trim()}
              style={{
                padding: '8px 14px',
                background: 'var(--smirk-accent, #6366f1)',
                border: 'none',
                borderRadius: 6,
                color: 'var(--smirk-accent-fg, #fff)',
                fontFamily: 'inherit',
                fontSize: 13,
                cursor: status === 'sending' ? 'default' : 'pointer',
                opacity: status === 'sending' ? 0.7 : 1,
                alignSelf: 'flex-start',
              }}
            >
              {status === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>

          {error && (
            <div data-testid="messages-error" style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.length === 0 ? (
              <p style={{ fontSize: 12, opacity: 0.5 }}>No messages yet.</p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  data-testid="message-item"
                  style={{
                    padding: '8px 10px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 6,
                  }}
                >
                  <div
                    data-testid="message-from"
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 10,
                      opacity: 0.6,
                      wordBreak: 'break-all',
                    }}
                  >
                    {m.fromNpub}
                  </div>
                  <div data-testid="message-text" style={{ fontSize: 13, marginTop: 2 }}>
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Sent Tips cross-asset surface. Loads the user's sent tips from
 * the backend and overlays local IndexedDB backups so rows that
 * survived a backend incident still show up + can be clawed back
 * via the local key material.
 */
function SentTipsRoute({
  wallet,
  session,
  onRefresh,
  onBack,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  onRefresh: () => Promise<void>;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<SentTipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [resp, backups] = await Promise.all([
        api.getSentSocialTips(),
        listTipKeyBackups().catch(() => []),
      ]);
      const backupsById = new Map(backups.map((b) => [b.tipId, b]));
      const serverTips = resp.data?.tips ?? [];
      const serverIds = new Set(serverTips.map((t) => t.id));
      const out: SentTipRow[] = [];
      for (const t of serverTips) {
        const backup = backupsById.get(t.id);
        // Reconstruct the share URL only for public tips that have
        // (a) buried funding and (b) a local backup carrying the URL
        // fragment. Pre-2026-06-04 backups lack the fragment field —
        // those tips show no Copy link button (but can still be
        // clawed back; the funds are recoverable, just the URL
        // isn't). The fragment is the secret that decrypts the
        // backend's `encrypted_key`, must never leave the client.
        const fundingReady =
          (t.funding_confirmations ?? 0) >=
          (t.confirmations_required ?? 1);
        const shareUrl =
          t.is_public &&
          t.status === 'pending' &&
          fundingReady &&
          backup?.urlFragmentEncoded
            ? `https://smirk.cash/tip/${t.id}#${backup.urlFragmentEncoded}`
            : undefined;
        out.push({
          id: t.id,
          asset: t.asset,
          amount: t.amount,
          recipientPlatform: t.recipient_platform ?? null,
          recipientUsername: t.recipient_username ?? null,
          isPublic: t.is_public,
          status: t.status,
          createdAt: t.created_at,
          fundingConfirmations: t.funding_confirmations,
          confirmationsRequired: t.confirmations_required,
          ...(backup ? { hasLocalBackup: true } : {}),
          ...(shareUrl ? { shareUrl } : {}),
        });
      }
      // Orphan local backups — server lost the row but we can still
      // clawback locally via the stored key material.
      for (const b of backups) {
        if (serverIds.has(b.tipId)) continue;
        out.push({
          id: b.tipId,
          asset: b.asset,
          amount: b.amount,
          recipientPlatform: null,
          recipientUsername: null,
          isPublic: b.isPublic,
          status: 'pending',
          createdAt: new Date(b.createdAt).toISOString(),
          fundingConfirmations: 0,
          confirmationsRequired: 0,
          hasLocalBackup: true,
        });
      }
      setRows(out);
      if (resp.error) setError(resp.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sent tips');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <SentTipsScreen
      rows={rows}
      loading={loading}
      {...(error ? { error } : {})}
      onBack={onBack}
      onRefresh={load}
      onClawback={async (tipId) => {
        // Full on-chain clawback — see tip-claim-handler.ts.
        // Decrypts local backup, sweeps tip address back to sender's
        // wallet, marks backend as clawed_back, refreshes balances.
        const userId = session?.bootstrap?.userId;
        if (!userId) return { ok: false, error: 'Wallet not bootstrapped' };
        const outcome = await clawbackSocialTip(wallet, userId, tipId);
        if (!outcome.ok) return { ok: false, error: outcome.error };
        await removeTipKeyBackup(tipId);
        // Drop the row from local state — refresh will reflect new
        // backend state on next load.
        setRows((rs) => rs.filter((row) => row.id !== tipId));
        void onRefresh();
        return { ok: true };
      }}
      onDiscardDraft={async (tipId) => {
        const r = await api.cancelSocialTip(tipId);
        if (r.error || !r.data) {
          return { ok: false, error: r.error ?? 'Discard failed' };
        }
        await removeTipKeyBackup(tipId);
        setRows((rs) => rs.filter((row) => row.id !== tipId));
        return { ok: true };
      }}
      resolveIcon={resolveIcon}
    />
  );
}

/**
 * Settings → Security — three sub-panels:
 *   1. Seed fingerprint display (read-only identifier).
 *   2. Change password (in-place keystore rotation).
 *   3. Export raw keys (with strong warning + reveal-on-confirm).
 *
 * Each section is collapsed by default — they're rarely used and
 * shouldn't compete with everyday surfaces (auto-lock, theme).
 * Clicking the section header expands. Keeps the Settings tab
 * scrollable but not overwhelming.
 */
function SecurityPanel({ wallet }: { wallet: UnlockedWallet }) {
  const [openSection, setOpenSection] = useState<
    null | 'fingerprint' | 'password' | 'export'
  >(null);
  const toggle = (s: typeof openSection) =>
    setOpenSection(openSection === s ? null : s);

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
        Security
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
        <SecurityRow
          label="Wallet fingerprint"
          open={openSection === 'fingerprint'}
          onToggle={() => toggle('fingerprint')}
        >
          <FingerprintPanel fingerprint={wallet.fingerprint} />
        </SecurityRow>
        <SecurityRow
          label="Change password"
          open={openSection === 'password'}
          onToggle={() => toggle('password')}
        >
          <ChangePasswordPanel
            onClose={() => setOpenSection(null)}
          />
        </SecurityRow>
        <SecurityRow
          label="Export raw keys"
          open={openSection === 'export'}
          onToggle={() => toggle('export')}
        >
          <ExportKeysPanel wallet={wallet} />
        </SecurityRow>
      </div>
    </section>
  );
}

function SecurityRow({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '8px 4px',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{label}</span>
        <span style={{ opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ padding: '0 4px 8px' }}>{children}</div>}
    </div>
  );
}

function FingerprintPanel({ fingerprint }: { fingerprint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={{ fontSize: 11, opacity: 0.65, margin: 0, lineHeight: 1.4 }}>
        A one-way SHA-256 of your seed. Smirk uses this as your
        wallet&apos;s anonymous identifier across devices — not
        reversible, cannot move funds.
      </p>
      <div
        style={{
          fontFamily: 'var(--smirk-font-family-mono, monospace)',
          fontSize: 11,
          padding: '6px 8px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6,
          wordBreak: 'break-all',
        }}
      >
        {fingerprint}
      </div>
      <button
        onClick={() => void copy()}
        style={{
          alignSelf: 'flex-start',
          padding: '4px 10px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ChangePasswordPanel({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await walletKeystore.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setDone(true);
      // Auto-close the panel after the success message shows briefly.
      setTimeout(() => {
        setCurrent('');
        setNext('');
        setConfirm('');
        setDone(false);
        onClose();
      }, 1500);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to change password',
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p
        style={{
          fontSize: 12,
          color: 'var(--smirk-positive, #4ade80)',
          margin: 0,
        }}
      >
        ✓ Password changed. Use the new password next time you unlock.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 11, opacity: 0.65, margin: 0, lineHeight: 1.4 }}>
        Rotates the local encryption key on your keystore. Your seed
        phrase is unchanged — this only affects how the wallet is
        unlocked on this device.
      </p>
      <input
        type="password"
        value={current}
        onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
        placeholder="Current password"
        autoComplete="current-password"
        style={settingsInputStyle}
      />
      <input
        type="password"
        value={next}
        onInput={(e) => setNext((e.target as HTMLInputElement).value)}
        placeholder="New password (≥ 8 chars)"
        autoComplete="new-password"
        style={settingsInputStyle}
      />
      <input
        type="password"
        value={confirm}
        onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
        placeholder="Confirm new password"
        autoComplete="new-password"
        style={settingsInputStyle}
      />
      {error && (
        <p
          style={{
            fontSize: 11,
            color: 'var(--smirk-negative, #ff6b6b)',
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
      <button
        onClick={() => void submit()}
        disabled={busy}
        style={{
          alignSelf: 'flex-start',
          padding: '6px 12px',
          background: 'var(--smirk-accent)',
          color: 'var(--smirk-accent-fg)',
          border: 'none',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </div>
  );
}

function ExportKeysPanel({ wallet }: { wallet: UnlockedWallet }) {
  const [revealed, setRevealed] = useState(false);
  const [powHash, setPowHash] = useState<string>('computing…');
  const keys = wallet.keys;

  useEffect(() => {
    // SHA-256 of the BTC pubkey hex string. Matches the backend's
    // `hash_public_key` exactly so the value here pastes verbatim
    // into TEST_POW_REQUIRED_FOR_PUBKEYS for safe pre-flip testing.
    void (async () => {
      const pubkeyHex = bytesToHex(keys.btc.publicKey);
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(pubkeyHex),
      );
      const hash = bytesToHex(new Uint8Array(buf));
      setPowHash(hash);
    })();
  }, [keys.btc.publicKey]);

  // Always-visible public material: addresses, public keys, the PoW
  // gate hash. Safe to show without the reveal gate. Lives above the
  // gate so a user doesn't have to opt into "I understand the risk"
  // just to copy a public address or a hash that's only useful for
  // anti-abuse config.
  const publicMaterial = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KeyRow
        label="Smirk PoW gate hash"
        sub="SHA-256 of your BTC pubkey hex — paste into TEST_POW_REQUIRED_FOR_PUBKEYS on the backend"
        value={powHash}
      />
      <KeyRow
        label="BTC address"
        sub="bech32 P2WPKH — m/84'/0'/0'/0/0"
        value={wallet.addresses.btc}
      />
      <KeyRow
        label="BTC public key (compressed)"
        sub="33-byte secp256k1 pubkey"
        value={bytesToHex(keys.btc.publicKey)}
      />
      <KeyRow
        label="LTC address"
        sub="bech32 P2WPKH — m/84'/2'/0'/0/0"
        value={wallet.addresses.ltc}
      />
      <KeyRow
        label="LTC public key (compressed)"
        sub="33-byte secp256k1 pubkey"
        value={bytesToHex(keys.ltc.publicKey)}
      />
      <KeyRow
        label="XMR address"
        sub="standard CryptoNote address (95 chars)"
        value={wallet.addresses.xmr}
      />
      <KeyRow
        label="XMR public spend key"
        sub="32-byte ed25519 — half of the public address"
        value={bytesToHex(keys.xmr.publicSpendKey)}
      />
      <KeyRow
        label="XMR public view key"
        sub="32-byte ed25519 — half of the public address"
        value={bytesToHex(keys.xmr.publicViewKey)}
      />
      <KeyRow
        label="WOW address"
        sub="standard Wownero address"
        value={wallet.addresses.wow}
      />
      <KeyRow
        label="WOW public spend key"
        sub="32-byte ed25519"
        value={bytesToHex(keys.wow.publicSpendKey)}
      />
      <KeyRow
        label="WOW public view key"
        sub="32-byte ed25519"
        value={bytesToHex(keys.wow.publicViewKey)}
      />
      <KeyRow
        label="Grin slatepack address"
        sub="bech32-encoded ed25519 pubkey"
        value={wallet.addresses.grin}
      />
      <KeyRow
        label="Grin public key"
        sub="32-byte ed25519 pubkey"
        value={bytesToHex(keys.grin.publicKey)}
      />
    </div>
  );

  if (!revealed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p
          style={{
            fontSize: 11,
            opacity: 0.65,
            margin: 0,
            lineHeight: 1.4,
          }}
        >
          For recovering your wallet in another tool (Monero CLI,
          grin-wallet, Sparrow, Electrum, etc.) and for backend
          anti-abuse config. Public material below is safe to copy;
          private keys require a confirmation tap.
        </p>
        {publicMaterial}
        <div
          style={{
            padding: '8px 10px',
            background: 'rgba(239, 68, 68, 0.10)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: 6,
            fontSize: 11,
            color: '#ef4444',
            lineHeight: 1.4,
          }}
        >
          ⚠ <strong>Never share private keys.</strong> Anyone with
          these can spend your funds. Smirk staff will NEVER ask
          for these. Don&apos;t paste them into websites, chat apps,
          or AI assistants.
        </div>
        <button
          onClick={() => setRevealed(true)}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            background: 'rgba(239, 68, 68, 0.10)',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            color: '#ef4444',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          I understand the risk — reveal private keys
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {publicMaterial}
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(239, 68, 68, 0.08)',
          borderRadius: 4,
          fontSize: 10,
          color: '#ef4444',
          opacity: 0.85,
        }}
      >
        Private keys below — full spend access.
      </div>
      <KeyRow
        label="BTC private key (secp256k1)"
        sub="BIP84 path m/84'/0'/0'/0/0 — import into Sparrow/Electrum"
        value={bytesToHex(keys.btc.privateKey)}
      />
      <KeyRow
        label="LTC private key (secp256k1)"
        sub="BIP84 path m/84'/2'/0'/0/0 — import into Electrum-LTC"
        value={bytesToHex(keys.ltc.privateKey)}
      />
      <KeyRow
        label="XMR private spend key"
        sub="32-byte ed25519 scalar — Cake/Feather: import 'spend key' + view key below"
        value={bytesToHex(keys.xmr.privateSpendKey)}
      />
      <KeyRow
        label="XMR private view key"
        sub="32-byte ed25519 scalar — pair with spend key above for read-only import"
        value={bytesToHex(keys.xmr.privateViewKey)}
      />
      <KeyRow
        label="WOW private spend key"
        sub="32-byte ed25519 scalar — Cake/Feather Wownero: import 'spend key' + view key below"
        value={bytesToHex(keys.wow.privateSpendKey)}
      />
      <KeyRow
        label="WOW private view key"
        sub="32-byte ed25519 scalar — pair with spend key above"
        value={bytesToHex(keys.wow.privateViewKey)}
      />
      <KeyRow
        label="Grin slatepack secret key"
        sub="32-byte ed25519 scalar — grin-wallet/Grim Smirk-compat import"
        value={bytesToHex(keys.grin.privateKey)}
      />
      <button
        onClick={() => setRevealed(false)}
        style={{
          alignSelf: 'flex-start',
          padding: '4px 10px',
          background: 'transparent',
          border: '1px solid var(--smirk-border)',
          color: 'inherit',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        Hide
      </button>
    </div>
  );
}

function KeyRow({
  label,
  sub,
  value,
}: {
  label: string;
  sub: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 10, opacity: 0.5 }}>{sub}</div>
      <div
        style={{
          fontFamily: 'var(--smirk-font-family-mono, monospace)',
          fontSize: 10,
          padding: '4px 6px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 4,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
      <button
        onClick={() => void copy()}
        style={{
          alignSelf: 'flex-start',
          padding: '2px 8px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 10,
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Compact nav row used in Settings to deep-link into sub-screens
 * (Sent Tips, future: per-asset RPC config, etc.). Two lines —
 * label + hint — with a chevron at the right and a hover affordance.
 */
function SettingsNavRow({
  label,
  hint,
  onClick,
  testid,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <section style={{ marginTop: 20 }}>
      <button
        onClick={onClick}
        data-testid={testid}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--smirk-fg-muted)',
              lineHeight: 1.3,
            }}
          >
            {hint}
          </span>
        </div>
        <span style={{ opacity: 0.5, fontSize: 14 }}>›</span>
      </button>
    </section>
  );
}

const settingsInputStyle = {
  fontSize: 12,
  padding: '6px 8px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 6,
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
} as const;

function SettingsStub({ wallet, onLock, onForgetComplete }: {
  wallet: UnlockedWallet;
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
}) {
  const { navigate } = useRoute();
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
            <option
              key={o.value}
              value={String(o.value)}
              data-testid={o.value === 0 ? 'settings-autolock-immediately' : undefined}
            >
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
        {browserController && (
          // Desktop-only callout: the chrome-shim does not polyfill
          // `chrome.alarms`, so the auto-lock timer only runs while
          // the wallet window is open. A user who closes the wallet
          // does NOT relock until they reopen the app — make sure
          // they know. Tracked for a `WalletTimers` abstraction in
          // `@smirk/core/state/platform.ts`.
          <p
            style={{
              fontSize: 11,
              opacity: 0.7,
              margin: '6px 0 0',
              lineHeight: 1.4,
              color: 'var(--smirk-warn, #c69)',
            }}
          >
            Desktop: the auto-lock timer pauses while the wallet
            window is closed. Closing the window does not relock
            until you reopen it. Plan accordingly when stepping
            away from the device.
          </p>
        )}
      </section>

      {browserController && (
        // Desktop-only: surface the v0.3.0 known limitations a user
        // would otherwise blame on a bug. Notifications are silent
        // because chrome.notifications isn't polyfilled. Tracked
        // alongside auto-lock under `WalletTimers` /
        // `WalletNotifications` in `@smirk/core/state/platform.ts`.
        <section
          style={{
            marginTop: 20,
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
            Desktop limitations (v0.3.0)
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 16,
              fontSize: 11,
              opacity: 0.65,
              lineHeight: 1.5,
            }}
          >
            <li>
              Auto-lock pauses while the wallet window is closed
              (no background timer).
            </li>
            <li>
              Tip-arrival notifications are silent (no OS-level
              alerts). Check the Inbox tab for new tips.
            </li>
          </ul>
        </section>
      )}

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

      {/* Security section — fingerprint display, change-password
          flow, export-raw-keys panel. Three audit-flagged TODOs
          rolled into one Settings group. */}
      <SecurityPanel wallet={wallet} />

      {/* Cross-asset Sent Tips entry point. Per-asset history covers
          the day-to-day case (a few rows per coin); this is for
          finding a forgotten clawback-eligible tip across all 5
          chains in one view. Same affordances as the per-asset
          rows — Clawback + Discard Draft — but in a single list. */}
      <SettingsNavRow
        label="Sent Tips"
        hint="Cross-asset list of every tip you've sent + inline clawback"
        onClick={() => void navigate('settings/sent-tips')}
        testid="settings-sent-tips-nav"
      />

      {/* Nostr identity — link the seed-derived npub for "Sign in with Nostr"
          (NIP-98) on any Smirk-compatible backend (Identity Phase 1). */}
      <SettingsNavRow
        label="Nostr identity"
        hint="Link your seed-derived npub to sign in with Nostr"
        onClick={() => void navigate('settings/nostr')}
        testid="settings-nostr-nav"
      />

      {/* Encrypted DMs over the backend's optional Nostr relay (self-disables
          when the instance runs no relay). */}
      <SettingsNavRow
        label="Messages"
        hint="Encrypted direct messages over your backend's Nostr relay"
        onClick={() => void navigate('settings/messages')}
        testid="settings-messages-nav"
      />

      <button
        onClick={() => void onLock()}
        data-testid="settings-lock-now-btn"
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
  // inside an approval flow. Threads `autoLockMinutes` through so
  // the SW provider's session-expiry check works (Finding 13).
  useEffect(() => {
    if (walletState?.kind === 'unlocked') {
      void store.load().then((s) => {
        const minutes = s.ui.autoLockMinutes ?? 0;
        void writeDappPublicCache(
          dappPublicCacheFor(walletState.wallet, minutes),
        );
      });
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
    // Delegate to the shared executor used by every wallet-foreground
    // approval surface (extension popup window AND Tauri desktop's
    // BrowseTab modal). The executor calls `ensureWasmInit()` itself,
    // computes signatures with the unlocked wallet, performs payments
    // / claims, and returns the result envelope to pass back to the
    // SW via `approvalPopupBridge.writeResult`.
    const result = await executeApproval(pending.request, approval, {
      wallet,
      ensureWasmInit,
      send,
      claimPublicTip,
      readBootstrapCache,
      api,
      loadState: () => store.load(),
      updateState: (m) => store.update(m),
    });
    await finish(result);
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

// signMessage logic moved to `../dapp-popup/signers.ts` and is
// invoked by `executeApproval`. Same code, single source of truth,
// reused by the desktop BrowseTab modal.

// Configure the API backend (staging / local / self-hosted) before the UI
// bootstraps; no-op for default production builds (VITE_SMIRK_BACKEND_URL unset).
initSmirkApi({
  baseUrl: import.meta.env.VITE_SMIRK_BACKEND_URL,
  walletApiStyle: import.meta.env.VITE_SMIRK_API_STYLE as 'flat' | 'namespaced' | undefined,
});

const root = document.getElementById('root');
if (root) {
  const approvalId = parseApprovalId();
  if (approvalId) {
    render(<ApprovalApp approvalId={approvalId} />, root);
  } else {
    render(<App />, root);
  }
}
