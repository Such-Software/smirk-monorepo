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
  type InboxItem,
  type RecentRecipient,
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

function App() {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [grinInbox, setGrinInbox] = useState<{
    items: InboxItem[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: false, error: null });

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
      const bootstrap = await bootstrapAuth(api, wallet);
      const [balances, prices] = await Promise.all([
        fetchAllBalances(api, wallet, bootstrap, { verifyKeyImage }),
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
        fetchAllBalances(api, wallet, bootstrap, { verifyKeyImage }),
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
    // backend returns 401, and the wallets row is never updated to
    // the canonical address — leaving senders encrypting to the
    // legacy address and receivers unable to decrypt.
    if (!session?.bootstrap?.userId) return;
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
      const next = await fetchGrinInbox(userId);
      if (!alive) return;
      setGrinInbox(next);
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
          await refresh();
        }}
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
    await walletKeystore.lock();
    await refresh();
  };
  const handleRefresh = () =>
    session
      ? refreshBalances(walletState.wallet, session.bootstrap)
      : Promise.resolve();
  const refreshGrinInbox = async () => {
    if (walletState.kind !== 'unlocked') return;
    const userId = session?.bootstrap?.userId;
    if (!userId) return;
    setGrinInbox((s) => ({ ...s, loading: true }));
    setGrinInbox(await fetchGrinInbox(userId));
  };

  return (
    <StateProvider store={store} router={router}>
      <AppShell
        onPopOut={openPopOut}
        brand={{
          label: 'Smirk Wallet',
          iconUrl: chrome.runtime.getURL('icons/favicon-16.png'),
        }}
        tabBadges={{ inbox: grinInbox.items.length }}
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
            />
          ),
          swap: <SwapStub />,
          inbox: (
            <InboxRouter
              wallet={walletState.wallet}
              userId={session?.bootstrap?.userId ?? ''}
              inbox={grinInbox}
              onRefresh={refreshGrinInbox}
            />
          ),
          settings: (
            <SettingsStub
              onLock={lockHandler}
              onForgetComplete={async () => {
                await sessionStorage.remove(SESSION_CACHE_KEY);
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
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Reserved — pull-to-refresh on Home will call this. Header refresh button uses it directly. */
  onRefresh: () => Promise<void>;
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
        assetIds={listAssets().map((a) => a.id)}
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
          // Grin: static formula (weight × DEFAULT_ACCEPT_FEE_BASE).
          // Typical send is 1 input + 2 outputs + 1 kernel → 23M
          // nanogrin. Sweep mode would need the actual input count, but
          // the Send wizard doesn't expose a Max-button for Grin yet,
          // so 1-in 2-out covers every current path.
          if (assetId === 'grin') {
            const numIn = options?.sweep ? 2 : 1; // heuristic for now
            return BigInt(calcGrinFee(numIn, 2, 1));
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
        assetIds={listAssets().map((a) => a.id)}
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
            if (relayId) {
              await api
                .signGrinSlatepack({
                  relayId,
                  userId: grinUserId,
                  signedSlatepack: signed.s2_armored,
                })
                .catch(() => undefined);
            }
            return {
              ok: true,
              slate_id: signed.slate_id,
              s2_armored: signed.s2_armored,
              amount_atomic: String(signed.amount),
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onExit={() => void navigate('home/receive')}
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
            if (relayId) {
              await api
                .signGrinSlatepack({
                  relayId,
                  userId: grinUserId,
                  signedSlatepack: signed.armored,
                })
                .catch(() => undefined);
            }
            return {
              ok: true,
              slate_id: signed.slate_id,
              i2_armored: signed.armored,
              amount_atomic: String(
                JSON.parse(signed.slate_json).amt ?? 0,
              ),
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }}
        onExit={() => void navigate('inbox')}
      />
    );
  }

  if (route.current === 'home/tip') {
    return (
      <TipMaker
        assetIds={listAssets().map((a) => a.id)}
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
      assets={listAssets().map((a) => {
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
        Aggregator (THORChain) vs Native (P2P) sub-toggle lands when the THORChain
        prototype work begins. `@smirk/swap` interface is scaffolded.
      </p>
    </div>
  );
}

function InboxRouter({
  wallet,
  userId,
  inbox,
  onRefresh,
}: {
  wallet: UnlockedWallet;
  /** Backend user UUID from `bootstrap.userId`. Required for Grin API
   *  calls — the local seed fingerprint won't parse as a UUID
   *  server-side. */
  userId: string;
  inbox: { items: InboxItem[]; loading: boolean; error: string | null };
  onRefresh: () => Promise<void>;
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
      loading={inbox.loading}
      error={inbox.error}
      onRefresh={() => void onRefresh()}
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

function SettingsStub({ onLock, onForgetComplete }: {
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
}) {
  const sessionState = useSessionState();
  const autoLockMinutes = sessionState.ui.autoLockMinutes ?? 0;
  const themeId = sessionState.ui.theme ?? 'default';
  const [forgetOpen, setForgetOpen] = useState(false);

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

const root = document.getElementById('root');
if (root) render(<App />, root);
