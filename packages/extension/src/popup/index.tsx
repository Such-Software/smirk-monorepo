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
  HomeTab,
  LockScreen,
  OnboardingWizard,
  ReceiveScreen,
  SendWizard,
  StateProvider,
  applyTheme,
  defaultTheme,
  getTheme,
  listThemes,
  useRoute,
  useSessionState,
} from '@smirk/ui';
import { listAssets, mustGetAsset } from '@smirk/assets';
import { send } from './send-handler';
import { startGrinSend, processGrinS2, cancelGrinSend } from './grin-flows';
import { initialize as initSmirkWasm, monero as wasmMonero } from '@smirk/wasm';

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
  }, []);

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
  return (
    <StateProvider store={store} router={router}>
      <AppShell
        onPopOut={openPopOut}
        brand={{
          label: 'Smirk Wallet',
          iconUrl: chrome.runtime.getURL('icons/favicon-16.png'),
        }}
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
          inbox: <InboxStub />,
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
          // Smirk-to-Smirk auto-detect (look up recipient address →
          // user_id, drop slatepack at relay) lands in Phase 3.3 when
          // the address-to-user endpoint is wired through the API
          // client. For now, every Grin send is clipboard-mode; the
          // recipient pastes our S1 into their wallet and pastes the
          // S2 response back.
          const recipientUserId: string | undefined = undefined;
          try {
            const result = await startGrinSend({
              userId: wallet.fingerprint,
              mnemonic: wallet.mnemonic,
              senderSlatepackAddress: wallet.addresses.grin,
              recipientSlatepackAddress: toAddress,
              ...(recipientUserId ? { recipientUserId } : {}),
              amount: Number(amountAtomic),
              resolver: {
                fetchSpendable: async () => {
                  const r = await api.getGrinOutputs(wallet.fingerprint);
                  if (r.error || !r.data) {
                    throw new Error(r.error ?? 'Failed to fetch Grin outputs');
                  }
                  return {
                    outputs: r.data.outputs
                      .filter((o) => o.status === 'unspent')
                      .map((o) => ({
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
          try {
            const result = await processGrinS2({
              userId: wallet.fingerprint,
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
            userId: wallet.fingerprint,
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
        onTip: () => {
          // TODO: tip-maker wizard route.
        },
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
 * Reads from `wallet.addresses` which is populated at unlock time by
 * `deriveAddresses` in `@smirk/core/keystore`.
 */
function resolveAddressForAsset(wallet: UnlockedWallet, assetId: string): string {
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

function InboxStub() {
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Inbox</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        Slatepacks, swap rounds, tip notes, and DMs land here. Empty for now.
      </p>
    </div>
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
