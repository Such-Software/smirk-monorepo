/**
 * Wallet ↔ backend bootstrap flows: auth + balance fetch.
 *
 * Layered above `@smirk/core/api` (raw HTTP client) and
 * `@smirk/core/keystore` (unlocked wallet). Belongs in core because
 * it's identical across extension / mobile / desktop wallets — only
 * the storage and UI shells differ.
 *
 * ## Auth
 *
 * Two-step:
 *   1. `checkRestore(fingerprint, keys)` — does the backend remember
 *      this wallet? If yes, retrieve the previously-stored XMR / WOW
 *      LWS scan start heights so we can resume scanning from the
 *      right block instead of either rescanning from genesis (slow)
 *      or starting from "now" (misses balance).
 *   2. `extensionRegister(...)` — sign the canonical
 *      `smirk-auth-{timestamp}` challenge with the derived BTC
 *      private key (Bitcoin message signature, BIP-137-shaped Base64),
 *      submit with all five public keys + fingerprint + the start
 *      heights from step 1. Backend looks up by fingerprint, verifies
 *      the signature, and returns a JWT.
 *
 * The same `extensionRegister` endpoint creates a new user if none
 * exists for that fingerprint (`isNew: true`) — so a single call covers
 * both first-run and subsequent unlocks.
 *
 * The access token is cached in-memory only via
 * `globalThis.__smirk_api_token__` (`SmirkApi.setAccessToken`). We do
 * NOT persist the refresh token to `chrome.storage.local`
 * (legacy pattern flagged in the 2026-05-10 audit) — re-running this
 * bootstrap on SW restart is cheap and avoids a plaintext-credential
 * surface.
 */

import { signBitcoinMessage, bytesToHex } from './crypto';
import type { UnlockedWallet } from './keystore';
import type { SmirkApi } from './api';
import { chainProviders, type ChainProviderRegistry } from './chain';
import { solvePowChallenge, type AltchaPayload } from './pow';

export interface BootstrapAuthResult {
  userId: string;
  username?: string;
  isNew: boolean;
  /** LWS scan-start heights echoed by the backend, if known. */
  xmrStartHeight?: number;
  wowStartHeight?: number;
}

/**
 * Build the keys list as the backend expects it.
 *
 * For Cryptonote chains (XMR, WOW), the backend identifies a wallet by
 * its **public spend key** — the half of the address that's tied to
 * the spend authority. The public view key is sent separately because
 * the LWS needs it to scan; but the wallet's identity per the backend
 * is the spend key.
 *
 * Match the legacy `smirk-extension` exactly here, otherwise
 * `checkRestore` returns `keysValid: false` and we silently lose the
 * stored start heights — which is exactly the symptom we just hit.
 */
function buildKeysList(wallet: UnlockedWallet) {
  return [
    { asset: 'btc', publicKey: bytesToHex(wallet.keys.btc.publicKey) },
    { asset: 'ltc', publicKey: bytesToHex(wallet.keys.ltc.publicKey) },
    { asset: 'xmr', publicKey: bytesToHex(wallet.keys.xmr.publicSpendKey) },
    { asset: 'wow', publicKey: bytesToHex(wallet.keys.wow.publicSpendKey) },
    { asset: 'grin', publicKey: bytesToHex(wallet.keys.grin.publicKey) },
  ];
}

/**
 * Sign in (or register if first time) the unlocked wallet against the
 * backend, and cache the resulting access token on the API client.
 *
 * **Smirk-only-imports posture.** The wallet only ever creates or
 * imports Smirk-shaped seeds, so the backend is the canonical source of
 * truth for *birthday* (the wallet creation timestamp + LWS start
 * heights). The first registration writes this; every subsequent
 * registration — including re-imports after a clean reinstall — reads
 * it back via `checkRestore`. We never start an XMR/WOW LWS scan from
 * "now" for an existing wallet, which would silently miss historical
 * balance.
 *
 * If `checkRestore` says the wallet is unknown, it's treated as a fresh
 * registration: we stamp `walletBirthday = now` so the backend has the
 * height to resume from on the next import. (A user importing a
 * non-Smirk seed would land here with the wrong birthday and a missed
 * scan — that's acceptable since non-Smirk imports are out of scope.)
 *
 * Throws if the backend rejects the signature or the network fails.
 * Caller should surface the error to the user — auth is required for
 * any subsequent balance / tip / signing operation.
 */
/**
 * Optional dependency injection for `bootstrapAuth` callers.
 *
 * `powSolver` lets the host wallet plug in its own PoW pipeline. The
 * extension wires this to a background-service-worker job that
 * survives popup close (so a screenshot or alt-tab during the ~2s
 * solve doesn't kill the registration). The Tauri desktop and
 * future Capacitor builds can keep the inline solver since their
 * popup-style hosts don't have the same lifecycle problem.
 *
 * Resolve with the `altchaSolution` payload to attach (an
 * `altcha-lib` `{ challenge, solution }` envelope) or `null` to
 * proceed without one — the graceful-migration path the backend
 * accepts during the v0.2 → v0.3 window.
 */
export interface BootstrapAuthOptions {
  /**
   * Host-provided PoW solver. Receives the bound api client and
   * resolves with the `AltchaPayload` envelope (or `null` on soft
   * failure). Defaults to the in-process `solvePowChallenge` when
   * omitted.
   *
   * The typed return is non-negotiable — see `pow.ts::AltchaPayload`
   * comment. A regression here is what caused the 2026-06-11 wallet
   * registration outage (bare Solution sent instead of envelope).
   */
  powSolver?: (api: SmirkApi) => Promise<AltchaPayload | null>;
}

export async function bootstrapAuth(
  api: SmirkApi,
  wallet: UnlockedWallet,
  options: BootstrapAuthOptions = {},
): Promise<BootstrapAuthResult> {
  const keys = buildKeysList(wallet);

  // Best-effort restore lookup. Failure here (network blip, fresh
  // backend) doesn't abort the bootstrap — we just register fresh.
  let xmrStartHeight: number | undefined;
  let wowStartHeight: number | undefined;
  let isKnownWallet = false;
  try {
    const restoreCheck = await api.checkRestore({ fingerprint: wallet.fingerprint, keys });
    if (restoreCheck.data?.exists) {
      isKnownWallet = true;
      // Backend returns `null` for wallets registered before height
      // tracking shipped — don't pass that downstream; treat as
      // "no stored height".
      xmrStartHeight =
        typeof restoreCheck.data.xmrStartHeight === 'number'
          ? restoreCheck.data.xmrStartHeight
          : undefined;
      wowStartHeight =
        typeof restoreCheck.data.wowStartHeight === 'number'
          ? restoreCheck.data.wowStartHeight
          : undefined;
    }
  } catch (e) {
    console.warn('[smirk-bootstrap] checkRestore threw', e);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const message = `smirk-auth-${timestamp}`;
  const signature = signBitcoinMessage(message, wallet.keys.btc.privateKey);

  // For an unknown-fingerprint wallet, stamp the birthday now so the
  // backend can hand it back next time. For a known wallet the backend
  // already has it — ignore on resubmission.
  const walletBirthday = isKnownWallet ? undefined : Math.floor(Date.now() / 1000);

  // ALTCHA proof-of-work — only for genuinely new wallets.
  //
  // The backend's `is_returning_user` check (smirk-backend
  // src/api/auth.rs) accepts a re-registration for an already-known
  // pubkey_hash WITHOUT a PoW solution, even when POW_REQUIRED=true.
  // The bypass is intentional — it's how v0.2.x stragglers and
  // lock+unlock flows avoid burning CPU on a solution the server
  // immediately discards.
  //
  // We mirror the same predicate client-side using the
  // `isKnownWallet` flag `checkRestore` just gave us. Skipping the
  // solve here saves ~3-5s of PBKDF2 on every lock+unlock and on
  // every import of an already-registered wallet — the desktop
  // wallet feels noticeably faster, and the extension SW handler
  // also benefits via this code path.
  //
  // New wallets still solve normally — that's the Sybil gate doing
  // its job. POW_REQUIRED=true with no isKnownWallet exemption =
  // a real new-user PoW cost.
  //
  // Host wallets can inject their own solver via `options.powSolver`
  // (the extension passes a background-SW-backed solver so the work
  // survives popup close — see `packages/extension/src/popup/jobs/`).
  let altchaSolution: AltchaPayload | null = null;
  if (!isKnownWallet) {
    altchaSolution = await (options.powSolver ?? solvePowChallenge)(api);
  }

  const result = await api.extensionRegister({
    keys,
    seedFingerprint: wallet.fingerprint,
    signedTimestamp: timestamp,
    signature,
    ...(walletBirthday !== undefined ? { walletBirthday } : {}),
    ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
    ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
    ...(altchaSolution !== null ? { altchaSolution } : {}),
  });

  if (result.error || !result.data) {
    throw new Error(result.error ?? 'Auth failed');
  }

  api.setAccessToken(result.data.accessToken);

  // Register the user's bech32 Grin slatepack address into `wallets`
  // so the relay's address-match join (`recipient_address IN (SELECT
  // address FROM wallets WHERE user_id = $1 AND asset = 'grin')`)
  // finds them. XMR/WOW get their `wallets` row inserted during
  // NOTE 2026-05-17: Grin re-registration moved out of bootstrap.
  // `wallet.addresses.grin` here comes from @smirk/core's deriveGrinKey
  // (custom `SHA256(master || "smirk:grin:v1")`), which does NOT match
  // the canonical grin-wallet/Grim derivation that `@smirk/wasm`'s
  // `slatepack_address` produces. Registering the legacy address
  // meant senders encrypted to a pubkey the receiver's wasm-derived
  // secret couldn't decrypt — every Smirk→Smirk Grin send failed
  // with "age decrypt: No matching keys found".
  //
  // The popup now re-registers via `canonicalGrinSlatepackAddress`
  // after wasm init. See [popup/index.tsx] mount effect.

  return {
    userId: result.data.user.id,
    ...(result.data.user.username !== undefined ? { username: result.data.user.username } : {}),
    isNew: result.data.user.isNew ?? false,
    ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
    ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
  };
}

/**
 * Per-asset balance, in atomic units.
 *
 * - `confirmed`: spendable right now (received - locked - server-claimed-spent).
 * - `pending`: known incoming + locked-but-not-yet-spendable + outgoing-in-mempool, lumped.
 * - `error`: per-asset fetch failure; UI can show "—" or a retry.
 *
 * NOTE: For XMR/WOW, the spent-output set returned by the LWS is
 * server-claimed and unverified. A malicious LWS could over-report
 * spent (under-reporting our balance), but cannot under-report spent
 * (over-reporting our balance) without knowing our spend key. Wiring
 * the WASM key-image verification path to filter `spent_outputs` is
 * tracked in `docs/TECHNICAL_DEBT.md` (legacy code path exists in
 * `smirk-extension/src/lib/balance.ts`).
 */
export interface AssetBalance {
  /** Spendable right now: total received − verified spent − locked. */
  confirmed: bigint;
  /**
   * Incoming, not-yet-mineable balance — server-reported mempool amount
   * plus client-side `pendingOutgoing` reconciliation (Phase 2b). For
   * CryptoNote chains this is purely incoming; outgoing is tracked
   * separately by `pendingOutgoing` once Phase 2b lands.
   */
  pending: bigint;
  /**
   * On-chain but inside the protocol lock window. CryptoNote chains
   * (XMR ≥10 confs to spend, WOW ≥4 confs) expose this so the UI can
   * tell the user "your change is in the chain but not spendable for
   * another N minutes". Optional — UTXO chains and Grin leave this
   * undefined since they don't carry a meaningful lock-window concept
   * in our flow.
   */
  locked?: bigint;
  error?: string;
  /**
   * LWS scan progress for this asset (XMR/WOW only). Populated when the
   * LWS reports `scanned_height < blockchain_height` — meaning the
   * displayed balance may be stale until the scanner catches up.
   * Undefined for assets that don't use LWS or when the scan is current.
   */
  scanProgress?: ScanProgress;
  /**
   * Chain-appropriate identifiers of inputs the network now reflects
   * as spent, in the same format as `PendingOutgoingTx.inputs`. For
   * CryptoNote (XMR/WOW) these are the lowercase-hex key images that
   * verified against our spend key (the same computation as the
   * balance verified-spent path — surfacing is free). Consumed by
   * `reconcilePendingOutgoing()` to drop in-flight entries whose
   * inputs are all now reflected as spent. UTXO chains and Grin
   * leave this undefined; their pendingOutgoing entries reconcile
   * via timing age-out.
   */
  verifiedSpentInputs?: string[];
}

/**
 * Verifies a server-reported spent-output by recomputing its key image
 * with the wallet's spend key. Returns the recomputed key image as
 * lowercase hex. Compare against the server's reported `key_image` —
 * mismatch means false positive (the LWS thought an output of yours
 * was spent, but it's actually a decoy in someone else's ring).
 *
 * Without this filter we'd subtract decoys from `total_received` and
 * over-report spend, often showing 0 when the real balance is positive.
 *
 * Injected as a dependency so `@smirk/core` doesn't pull in WASM —
 * each platform shell provides its own verifier (extension uses
 * `@smirk/wasm` directly, mobile may use a native module, etc.).
 */
export type KeyImageVerifier = (params: {
  privateViewKeyHex: string;
  privateSpendKeyHex: string;
  txPubKeyHex: string;
  outputIndex: number;
}) => Promise<string>;

export interface ScanProgress {
  scannedHeight: number;
  blockchainHeight: number;
  /** 0–1; useful directly for a UI progress bar. */
  fraction: number;
}

export type Balances = Record<'btc' | 'ltc' | 'xmr' | 'wow' | 'grin', AssetBalance>;

/**
 * Fetch all five asset balances in parallel. For XMR/WOW this also
 * idempotently registers the wallet's view key with the backend's LWS
 * (no-op if already registered, with start heights when available so
 * historical balance is reachable). Returns a partial result if any
 * asset fails — failures are recorded per-asset on `AssetBalance.error`.
 */
export interface FetchBalancesOptions {
  /**
   * When provided, filter LWS-reported `spent_outputs` by recomputing
   * their key images locally with the wallet's spend key — only the
   * matches are subtracted from `total_received`. Without this the
   * popup over-subtracts (LWS includes decoys-of-your-outputs as
   * candidate spends, since it can't tell with view-key alone).
   *
   * Strongly recommended for XMR/WOW. Without it the displayed balance
   * is a lower bound (sometimes 0 when there are real funds present).
   */
  verifyKeyImage?: KeyImageVerifier;

  /**
   * The chain-provider registry. Defaults to the global `chainProviders`
   * (which targets the Smirk backend). When a server-options config swaps a
   * chain to a direct source (electrum, lws), balance reads for that chain
   * come from there instead. Injectable so tests can supply a mock registry.
   */
  providers?: ChainProviderRegistry;

  /**
   * Optional whitelist of asset ids to actually fetch. When omitted,
   * every supported asset is fetched (legacy behavior). When set,
   * any asset NOT in the list gets a zeroed `AssetBalance` returned
   * and ZERO network round-trips are made for it.
   *
   * Used by `Show/Hide assets` to keep backend round-trips
   * proportional to what the user wants to see — hiding 2-3 assets
   * cuts the popup-open balance-fetch cost by 40-60%.
   *
   * Shape stays stable regardless: `Balances` always has all 5
   * keys, callers that read by id never need to null-check.
   */
  visibleAssetIds?: ReadonlyArray<string>;

  /**
   * Progressive-render callback. Fires *each time* a per-asset
   * balance resolves, before the overall `Promise<Balances>`
   * settles. Lets the UI paint each row as soon as its chain is
   * back, rather than waiting for the slowest chain (often an
   * LWS scan still catching up). Cold-start XMR can lag minutes
   * behind blockchain tip; BTC/LTC/Grin shouldn't wait for it.
   *
   * Fires once per asset. May fire in any order. Failures are
   * delivered through the same callback with the error field on
   * the AssetBalance set (matches the all-or-nothing return path's
   * per-asset error semantics).
   */
  onAssetBalance?: (assetId: keyof Balances, balance: AssetBalance) => void;
}

export async function fetchAllBalances(
  wallet: UnlockedWallet,
  bootstrap: BootstrapAuthResult,
  options: FetchBalancesOptions = {},
): Promise<Balances> {
  const xmrViewKeyHex = bytesToHex(wallet.keys.xmr.privateViewKey);
  const wowViewKeyHex = bytesToHex(wallet.keys.wow.privateViewKey);
  const xmrSpendKeyHex = bytesToHex(wallet.keys.xmr.privateSpendKey);
  const wowSpendKeyHex = bytesToHex(wallet.keys.wow.privateSpendKey);

  // Visibility gate: skip the network round-trip for any asset the
  // user has hidden in Settings. We still return a zeroed
  // AssetBalance for hidden assets so the shape is stable for
  // consumers — totals math, asset-detail direct-nav, etc. all keep
  // working without per-call branching. See
  // docs/MULTI_ASSET_ARCHITECTURE.md for the long-form rationale.
  const visible = (id: string): boolean =>
    !(options.visibleAssetIds && !options.visibleAssetIds.includes(id));
  const zero: AssetBalance = { confirmed: 0n, pending: 0n };
  const providers = options.providers ?? chainProviders;

  // Wrap each fetch so its callback fires as soon as the underlying
  // promise resolves — independent of the slowest sibling. The
  // outer Promise.all still waits for everything (for the return
  // value), but the UI gets per-asset updates progressively.
  const tap = <K extends keyof Balances>(
    id: K,
    p: Promise<AssetBalance>,
  ): Promise<AssetBalance> =>
    options.onAssetBalance
      ? p.then(
          (b) => {
            options.onAssetBalance!(id, b);
            return b;
          },
          (e) => {
            const err: AssetBalance = {
              confirmed: 0n,
              pending: 0n,
              error: e instanceof Error ? e.message : 'Fetch failed',
            };
            options.onAssetBalance!(id, err);
            return err;
          },
        )
      : p;

  const [btc, ltc, xmr, wow, grin] = await Promise.all([
    tap(
      'btc',
      visible('btc')
        ? fetchUtxoBalance(providers, 'btc', wallet.addresses.btc)
        : Promise.resolve(zero),
    ),
    tap(
      'ltc',
      visible('ltc')
        ? fetchUtxoBalance(providers, 'ltc', wallet.addresses.ltc)
        : Promise.resolve(zero),
    ),
    tap(
      'xmr',
      visible('xmr')
        ? fetchLwsBalance(
            providers,
            bootstrap.userId,
            'xmr',
            wallet.addresses.xmr,
            xmrViewKeyHex,
            xmrSpendKeyHex,
            bootstrap.xmrStartHeight,
            options.verifyKeyImage,
          )
        : Promise.resolve(zero),
    ),
    tap(
      'wow',
      visible('wow')
        ? fetchLwsBalance(
            providers,
            bootstrap.userId,
            'wow',
            wallet.addresses.wow,
            wowViewKeyHex,
            wowSpendKeyHex,
            bootstrap.wowStartHeight,
            options.verifyKeyImage,
          )
        : Promise.resolve(zero),
    ),
    tap(
      'grin',
      visible('grin')
        ? fetchGrinBalance(providers, bootstrap.userId)
        : Promise.resolve(zero),
    ),
  ]);

  return { btc, ltc, xmr, wow, grin };
}

async function fetchUtxoBalance(
  providers: ChainProviderRegistry,
  asset: 'btc' | 'ltc',
  address: string,
): Promise<AssetBalance> {
  const result = await providers.utxo(asset).getBalance(address);
  if (result.error || !result.data) {
    return { confirmed: 0n, pending: 0n, error: result.error ?? 'Network error' };
  }
  return {
    confirmed: BigInt(result.data.confirmed),
    pending: BigInt(result.data.unconfirmed),
  };
}

async function fetchLwsBalance(
  providers: ChainProviderRegistry,
  userId: string,
  asset: 'xmr' | 'wow',
  address: string,
  viewKeyHex: string,
  spendKeyHex: string,
  startHeight: number | undefined,
  verifyKeyImage: KeyImageVerifier | undefined,
): Promise<AssetBalance> {
  // Best-effort idempotent registration. Backend treats re-registrations
  // as no-ops; we intentionally don't fail the whole balance fetch if
  // this errors. Pass the previously-stored scan height so LWS resumes
  // from the right block on re-registration of an imported wallet.
  //
  // Awaited (not raced): for a first-ever XMR/WOW use the LWS account
  // doesn't exist yet, so a racing getLwsBalance call returns "address
  // not found" — surfacing that as a one-tick error is the kind of
  // jank we shouldn't ship. The ~100-200 ms savings for returning
  // wallets aren't worth the first-use UX cliff.
  await providers
    .lws(asset)
    .registerAccount(userId, address, viewKeyHex, startHeight)
    .catch(() => undefined);

  const result = await providers.lws(asset).getBalance(address, viewKeyHex);
  if (result.error || !result.data) {
    return { confirmed: 0n, pending: 0n, error: result.error ?? 'Network error' };
  }

  // Balance computation:
  //
  //   verified_spent = sum(spent_outputs where computed key_image == server's key_image)
  //   spendable      = max(0, total_received - verified_spent - locked_balance)
  //   pending        = locked_balance + pending_balance
  //
  // monero-lws cannot distinguish "your output spent by you" from
  // "your output appearing as a decoy in someone else's ring sig" with
  // the view key alone — it reports BOTH as candidate `spent_outputs`.
  // The spend-key-derived key image disambiguates them: if the server's
  // reported key_image matches what WE compute with the spend key, it's
  // a real spend; otherwise it's a decoy false positive.
  //
  // If `verifyKeyImage` isn't injected, fall back to trusting the
  // server's list (over-subtracts and may render 0 when balance is
  // actually positive). Always inject it in production paths.
  const total = BigInt(result.data.total_received);
  const locked = BigInt(result.data.locked_balance);
  const pending = BigInt(result.data.pending_balance);

  let spent = 0n;
  // Capture verified-spent key images for reconciliation. Same loop
  // that decides `spent` populates this — no extra wasm calls. Each
  // entry here is what the server flagged AND our spend key confirms,
  // so it's safe to use as a "spent" signal for pendingOutgoing.
  const verifiedSpentInputs: string[] = [];
  if (verifyKeyImage && result.data.spent_outputs.length > 0) {
    for (const out of result.data.spent_outputs) {
      try {
        const computed = await verifyKeyImage({
          privateViewKeyHex: viewKeyHex,
          privateSpendKeyHex: spendKeyHex,
          txPubKeyHex: out.tx_pub_key,
          outputIndex: out.out_index,
        });
        if (computed.toLowerCase() === out.key_image.toLowerCase()) {
          spent += BigInt(out.amount);
          verifiedSpentInputs.push(computed.toLowerCase());
        }
        // else: false positive (decoy match). Skip.
      } catch (e) {
        // Failure to verify a single output shouldn't block the whole
        // balance; log and treat as unverified (i.e. don't subtract).
        // The downside is a single broken output silently hides a real
        // spend — but we'd rather over-report than crash the popup.
        console.warn('[smirk] key-image verify failed for one output', e);
      }
    }
  } else {
    // No verifier: legacy fallback (trust server, over-subtract).
    spent = result.data.spent_outputs.reduce(
      (acc, o) => acc + BigInt(o.amount),
      0n,
    );
  }

  const remaining = total - spent;
  const confirmed = remaining - locked;

  // Surface scan progress when LWS is materially behind the chain.
  // Threshold matches the auto-rescan threshold on the backend so we
  // don't flicker progress when LWS is within a few minutes of tip.
  const SCAN_LAG_THRESHOLD_BLOCKS = 5;
  const scannedHeight = result.data.scanned_height;
  const blockchainHeight = result.data.blockchain_height;
  const scanProgress: ScanProgress | undefined =
    blockchainHeight > 0 && scannedHeight + SCAN_LAG_THRESHOLD_BLOCKS < blockchainHeight
      ? {
          scannedHeight,
          blockchainHeight,
          fraction: Math.max(
            0,
            Math.min(
              1,
              (scannedHeight - result.data.start_height) /
                Math.max(1, blockchainHeight - result.data.start_height),
            ),
          ),
        }
      : undefined;

  // Split locked out of pending so the UI can render the two states
  // separately. Pre-Phase-2 they were lumped — "pending" included both
  // mempool incoming AND on-chain-but-locked, which obscured why a
  // user's balance was tied up.
  const lockedClamped = locked < 0n ? 0n : locked;
  return {
    confirmed: confirmed < 0n ? 0n : confirmed,
    pending,
    locked: lockedClamped,
    ...(scanProgress ? { scanProgress } : {}),
    ...(verifiedSpentInputs.length > 0 ? { verifiedSpentInputs } : {}),
  };
}

async function fetchGrinBalance(
  providers: ChainProviderRegistry,
  userId: string,
): Promise<AssetBalance> {
  const result = await providers.grin().getBalance(userId);
  if (result.error || !result.data) {
    return { confirmed: 0n, pending: 0n, error: result.error ?? 'Network error' };
  }
  // Map the backend's three-bucket model onto the shared AssetBalance
  // shape:
  //   unspent (≥10 confs)                    → confirmed (spendable now)
  //   on-chain but <10 confs / 'locked' DB   → locked   (in chain, maturing)
  //   no block_height yet ('unconfirmed')    → pending  (in mempool only)
  // Matches XMR/WOW semantics so the asset row reads the same way
  // across chains. Earlier this lumped `locked + pending` together and
  // displayed everything in-flight as "pending", confusing on a chain
  // where most of the wait time is post-broadcast confirmation depth.
  return {
    confirmed: BigInt(result.data.confirmed),
    locked: BigInt(result.data.locked),
    pending: BigInt(result.data.pending),
  };
}

/**
 * USD prices keyed by asset id. `null` indicates the price feed
 * doesn't have a quote for that asset (e.g. WOW pre-listing).
 */
export type Prices = Record<'btc' | 'ltc' | 'xmr' | 'wow' | 'grin', number | null>;

/** Fetch current spot prices in USD. Best-effort — returns nulls on failure. */
export async function fetchPrices(api: SmirkApi): Promise<Prices> {
  const result = await api.getPrices();
  if (result.error || !result.data) {
    return { btc: null, ltc: null, xmr: null, wow: null, grin: null };
  }
  // v3 backends nest the quotes under `prices` ({ currency, prices:{...},
  // updated_at }); legacy backends return them flat. Read whichever is present,
  // and coerce to number|null so a missing/opted-out quote is a clean null.
  const data = result.data as Record<string, unknown> & {
    prices?: Record<string, unknown>;
  };
  const src = data.prices ?? data;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    btc: num(src.btc),
    ltc: num(src.ltc),
    xmr: num(src.xmr),
    wow: num(src.wow),
    grin: num(src.grin),
  };
}

/**
 * Sum across all assets converted to fiat at current prices. Skips
 * assets whose price is null (no quote available). Atomic-unit math
 * uses `BigInt`, then divides by `10 ** decimals` at the very end —
 * no floating-point on amounts, only on the (price * float) display.
 *
 * Counts confirmed + pending + locked — i.e. "total wealth on chain",
 * not "spendable right now". The locked component matters: a user
 * with 32 WOW change inside the 4-conf lock window has $X of value,
 * just not movable yet, and the headline shouldn't hide that.
 */
export function totalFiat(
  balances: Balances,
  prices: Prices,
  decimalsByAsset: Record<string, number>,
): number {
  return sumBalanceFieldFiat(balances, prices, decimalsByAsset, (b) =>
    b.confirmed + b.pending + (b.locked ?? 0n),
  );
}

/** Fiat sum of the `pending` field across all priced assets. */
export function pendingFiat(
  balances: Balances,
  prices: Prices,
  decimalsByAsset: Record<string, number>,
): number {
  return sumBalanceFieldFiat(balances, prices, decimalsByAsset, (b) => b.pending);
}

/** Fiat sum of the `locked` field across all priced assets. */
export function lockedFiat(
  balances: Balances,
  prices: Prices,
  decimalsByAsset: Record<string, number>,
): number {
  return sumBalanceFieldFiat(balances, prices, decimalsByAsset, (b) => b.locked ?? 0n);
}

function sumBalanceFieldFiat(
  balances: Balances,
  prices: Prices,
  decimalsByAsset: Record<string, number>,
  pick: (b: AssetBalance) => bigint,
): number {
  let total = 0;
  for (const [asset, balance] of Object.entries(balances) as Array<[
    keyof Balances,
    AssetBalance,
  ]>) {
    const price = prices[asset];
    if (price === null) continue;
    const decimals = decimalsByAsset[asset];
    if (decimals === undefined) continue;
    const value = pick(balance);
    if (value === 0n) continue;
    // Convert to a Number at this single boundary. For supported assets
    // the worst case is XMR (12 decimals) which fits well in a double's
    // 53-bit mantissa for any realistic balance.
    const asFloat = Number(value) / 10 ** decimals;
    total += asFloat * price;
  }
  return total;
}
