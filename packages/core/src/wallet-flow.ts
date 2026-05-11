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
export async function bootstrapAuth(
  api: SmirkApi,
  wallet: UnlockedWallet,
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

  const result = await api.extensionRegister({
    keys,
    seedFingerprint: wallet.fingerprint,
    signedTimestamp: timestamp,
    signature,
    ...(walletBirthday !== undefined ? { walletBirthday } : {}),
    ...(xmrStartHeight !== undefined ? { xmrStartHeight } : {}),
    ...(wowStartHeight !== undefined ? { wowStartHeight } : {}),
  });

  if (result.error || !result.data) {
    throw new Error(result.error ?? 'Auth failed');
  }

  api.setAccessToken(result.data.accessToken);

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
  confirmed: bigint;
  pending: bigint;
  error?: string;
  /**
   * LWS scan progress for this asset (XMR/WOW only). Populated when the
   * LWS reports `scanned_height < blockchain_height` — meaning the
   * displayed balance may be stale until the scanner catches up.
   * Undefined for assets that don't use LWS or when the scan is current.
   */
  scanProgress?: ScanProgress;
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
}

export async function fetchAllBalances(
  api: SmirkApi,
  wallet: UnlockedWallet,
  bootstrap: BootstrapAuthResult,
  options: FetchBalancesOptions = {},
): Promise<Balances> {
  const xmrViewKeyHex = bytesToHex(wallet.keys.xmr.privateViewKey);
  const wowViewKeyHex = bytesToHex(wallet.keys.wow.privateViewKey);
  const xmrSpendKeyHex = bytesToHex(wallet.keys.xmr.privateSpendKey);
  const wowSpendKeyHex = bytesToHex(wallet.keys.wow.privateSpendKey);

  const [btc, ltc, xmr, wow, grin] = await Promise.all([
    fetchUtxoBalance(api, 'btc', wallet.addresses.btc),
    fetchUtxoBalance(api, 'ltc', wallet.addresses.ltc),
    fetchLwsBalance(
      api,
      bootstrap.userId,
      'xmr',
      wallet.addresses.xmr,
      xmrViewKeyHex,
      xmrSpendKeyHex,
      bootstrap.xmrStartHeight,
      options.verifyKeyImage,
    ),
    fetchLwsBalance(
      api,
      bootstrap.userId,
      'wow',
      wallet.addresses.wow,
      wowViewKeyHex,
      wowSpendKeyHex,
      bootstrap.wowStartHeight,
      options.verifyKeyImage,
    ),
    fetchGrinBalance(api, bootstrap.userId),
  ]);

  return { btc, ltc, xmr, wow, grin };
}

async function fetchUtxoBalance(
  api: SmirkApi,
  asset: 'btc' | 'ltc',
  address: string,
): Promise<AssetBalance> {
  const result = await api.getUtxoBalance(asset, address);
  if (result.error || !result.data) {
    return { confirmed: 0n, pending: 0n, error: result.error ?? 'Network error' };
  }
  return {
    confirmed: BigInt(result.data.confirmed),
    pending: BigInt(result.data.unconfirmed),
  };
}

async function fetchLwsBalance(
  api: SmirkApi,
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
  await api
    .registerLws(userId, asset, address, viewKeyHex, startHeight)
    .catch(() => undefined);

  const result = await api.getLwsBalance(asset, address, viewKeyHex);
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

  return {
    confirmed: confirmed < 0n ? 0n : confirmed,
    pending: pending + (locked < 0n ? 0n : locked),
    ...(scanProgress ? { scanProgress } : {}),
  };
}

async function fetchGrinBalance(api: SmirkApi, userId: string): Promise<AssetBalance> {
  const result = await api.getGrinUserBalance(userId);
  if (result.error || !result.data) {
    return { confirmed: 0n, pending: 0n, error: result.error ?? 'Network error' };
  }
  return {
    confirmed: BigInt(result.data.confirmed),
    pending: BigInt(result.data.locked) + BigInt(result.data.pending),
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
  return {
    btc: result.data.btc,
    ltc: result.data.ltc,
    xmr: result.data.xmr,
    wow: result.data.wow,
    grin: result.data.grin,
  };
}

/**
 * Sum across all assets converted to fiat at current prices. Skips
 * assets whose price is null (no quote available). Atomic-unit math
 * uses `BigInt`, then divides by `10 ** decimals` at the very end —
 * no floating-point on amounts, only on the (price * float) display.
 */
export function totalFiat(
  balances: Balances,
  prices: Prices,
  decimalsByAsset: Record<string, number>,
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
    const combined = balance.confirmed + balance.pending;
    if (combined === 0n) continue;
    // Convert to a Number at this single boundary. For supported assets
    // the worst case is XMR (12 decimals) which fits well in a double's
    // 53-bit mantissa for any realistic balance.
    const asFloat = Number(combined) / 10 ** decimals;
    total += asFloat * price;
  }
  return total;
}
