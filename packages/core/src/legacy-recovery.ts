/**
 * Funds at older Smirk addresses.
 *
 * Before v0.3, Smirk derived Monero and Wownero keys in two earlier ways
 * (derivation v1 and v2) and Bitcoin and Litecoin keys at `m/44'`. v0.3 derives
 * v3 keys only: Monero and Wownero at the Cake-compatible path, Bitcoin and
 * Litecoin at `m/84'`. The seed is the same, so the coins at the older
 * addresses still belong to the user; the wallet simply never looks there.
 *
 * Two real ways money ends up there:
 *  - a v0.2.4 wallet ran its key-format migration while a payment was still
 *    locked (minutes old). The migration treated the locked output as "nothing
 *    to sweep", finished, and never looked back (the 50 WOW of 2026-08-21);
 *  - a pre-v0.3 wallet that never migrated is imported straight into v0.3.
 *
 * This module finds those funds. It derives the older addresses from the seed,
 * reads their balances, and reports what it saw. Moving the funds (signing a
 * sweep) is the host's job, because only the host has the signer.
 *
 * PRIVACY
 * -------
 * Reading a Monero or Wownero balance means handing that address's view key to
 * the backend, which asks its light-wallet server. Two levels:
 *  - `probe` (the default, automatic once per wallet): ask about the older
 *    addresses the light-wallet server already watches. Old Smirk addresses
 *    were registered there by the old backend, so this usually suffices. The
 *    view key is sent with the question, as with every balance read.
 *  - `scan` (only on an explicit tap): register an older address the server
 *    does not know yet, so it scans history for it. The old view key then stays
 *    on the server like the wallet's current one does. This costs server work
 *    and, past the free window, a small restore proof-of-work.
 * Bitcoin and Litecoin reads go through the same Electrum proxy the wallet
 * already uses and reveal only the old address.
 *
 * FAIL HONEST: a check that cannot complete is reported as `error` or
 * `not-scanned`, never as `empty`. "Nothing here" must only ever mean we looked.
 * Every read is authenticated, so a read the backend refuses for want of a
 * sign-in (HTTP 401) voids the whole check: it throws `LegacySignInRequiredError`
 * rather than reporting a per-address result that was never looked up.
 */

import { bytesToHex } from './crypto';
import { deriveAllKeys, type DerivationVersion } from './hd';
import { xmrAddress, wowAddress } from './address';
import { legacyBtcLtcKey } from './migration';
import { requiredRestorePowBits, solveRestorePow, type RestorePowPolicy } from './pow';
import type { ApiResponse } from './api/client';
import type { ChainProviderRegistry } from './chain/registry';
import type { LwsBalance, UtxoListing } from './chain/types';
import type { KeyImageVerifier } from './wallet-flow';

export type LegacyAsset = 'btc' | 'ltc' | 'xmr' | 'wow';
/** Where an older address came from. `m44` covers BTC/LTC for v1 and v2 alike
 *  (both used `m/44'`); `v1`/`v2` are the two older Monero/Wownero derivations. */
export type LegacySource = 'm44' | 'v1' | 'v2';

/** Public description of one older address. Safe to store and display. */
export interface LegacyAddress {
  asset: LegacyAsset;
  source: LegacySource;
  address: string;
}

/** An older address with its keys. Callers must zero the key bytes when done. */
export interface LegacyUtxoAccount extends LegacyAddress {
  kind: 'utxo';
  asset: 'btc' | 'ltc';
  privateKey: Uint8Array;
}
export interface LegacyCryptonoteAccount extends LegacyAddress {
  kind: 'cryptonote';
  asset: 'xmr' | 'wow';
  privateSpendKey: Uint8Array;
  privateViewKey: Uint8Array;
}
export type LegacyAccount = LegacyUtxoAccount | LegacyCryptonoteAccount;

/**
 * Every older address this seed controls: BTC and LTC at `m/44'`, and Monero and
 * Wownero at derivations v1 and v2. Excludes anything identical to the current
 * (v3) address, so the current wallet is never reported as "old".
 */
export function legacyAccountsFor(
  mnemonic: string,
  current?: Partial<Record<LegacyAsset, string>>,
): LegacyAccount[] {
  const out: LegacyAccount[] = [];
  for (const asset of ['btc', 'ltc'] as const) {
    const k = legacyBtcLtcKey(mnemonic, asset);
    if (current?.[asset] === k.address) {
      k.privateKey.fill(0);
      continue;
    }
    out.push({ kind: 'utxo', asset, source: 'm44', address: k.address, privateKey: k.privateKey });
  }
  const seen = new Set<string>();
  for (const version of [1, 2] as const satisfies readonly DerivationVersion[]) {
    const keys = deriveAllKeys(mnemonic, '', version);
    for (const asset of ['xmr', 'wow'] as const) {
      const ck = keys[asset];
      const address =
        asset === 'xmr'
          ? xmrAddress(ck.publicSpendKey, ck.publicViewKey)
          : wowAddress(ck.publicSpendKey, ck.publicViewKey);
      if (current?.[asset] === address || seen.has(address)) continue;
      seen.add(address);
      out.push({
        kind: 'cryptonote',
        asset,
        source: version === 1 ? 'v1' : 'v2',
        address,
        privateSpendKey: ck.privateSpendKey.slice(),
        privateViewKey: ck.privateViewKey.slice(),
      });
    }
    // The other per-asset secrets of an older derivation are not needed here.
    keys.btc.privateKey.fill(0);
    keys.ltc.privateKey.fill(0);
    keys.xmr.privateSpendKey.fill(0);
    keys.xmr.privateViewKey.fill(0);
    keys.wow.privateSpendKey.fill(0);
    keys.wow.privateViewKey.fill(0);
    keys.grin.privateKey.fill(0);
    keys.nostr.privateKey.fill(0);
  }
  return out;
}

/** Zero every key held by a list of older accounts. */
export function wipeLegacyAccounts(accounts: LegacyAccount[]): void {
  for (const a of accounts) {
    if (a.kind === 'utxo') a.privateKey.fill(0);
    else {
      a.privateSpendKey.fill(0);
      a.privateViewKey.fill(0);
    }
  }
}

/**
 * What a check found at one older address.
 *
 * - `funds`: something is there (spendable now, or still unlocking/pending).
 * - `empty`: we looked and found nothing.
 * - `not-scanned`: Monero/Wownero only; the server does not watch this address
 *   and the user has not asked us to register it, so we do not know.
 * - `scanning`: registered, but the server has not caught up to the chain tip;
 *   amounts so far are partial.
 * - `error`: the check failed; we do not know.
 */
export type LegacyFindingState = 'funds' | 'empty' | 'not-scanned' | 'scanning' | 'error';

export interface LegacyFinding extends LegacyAddress {
  state: LegacyFindingState;
  /** Spendable now, atomic units, decimal string (u64 exceeds a JS number). */
  spendableAtomic: string;
  /** Received but not yet spendable (recently arrived or unconfirmed), atomic units. */
  pendingAtomic: string;
  /** Monero/Wownero scan progress when the server is behind. */
  scan?: { scannedHeight: number; blockchainHeight: number; startHeight: number };
  /** Short, user-safe reason when `state` is `error` or `not-scanned`. */
  detail?: string;
}

export interface LegacyDiscoveryOptions {
  providers: ChainProviderRegistry;
  /** Required for `scan` mode: registration is per signed-in user. */
  userId?: string | null;
  /**
   * `probe`: only read addresses the server already watches.
   * `scan`: also register unknown Monero/Wownero older addresses so the server
   * scans them (explicit user consent; see the module header).
   */
  mode: 'probe' | 'scan';
  /** Spend check for Monero/Wownero: tells a real spend from a ring decoy. */
  verifyKeyImage?: KeyImageVerifier;
  /** Operator restore pricing, from `/capabilities` → `restore`. */
  restorePolicy?: RestorePowPolicy & { max_depth_days?: number | null | undefined };
  /** Current wallet addresses, so the current wallet is never reported as old. */
  currentAddresses?: Partial<Record<LegacyAsset, string>>;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * The backend refused a read because this window holds no live sign-in (HTTP
 * 401). Says nothing about any older address, so a check that hits it has no
 * result to report or keep.
 */
export class LegacySignInRequiredError extends Error {
  constructor() {
    super('Sign in to Smirk first, then check your older addresses again.');
    this.name = 'LegacySignInRequiredError';
  }
}

/** First day any Smirk wallet existed; older addresses cannot hold Smirk-era funds before it. */
export const LEGACY_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Actual chain block rates, for turning a date into a scan start height. */
const CHAIN_BLOCKS_PER_DAY: Record<'xmr' | 'wow', number> = {
  xmr: 720, // 120 s blocks
  wow: 288, // 300 s blocks
};

/**
 * Where to start scanning an older Monero/Wownero address: the Smirk epoch,
 * bounded by the operator's maximum restore depth. Never negative.
 */
export function legacyScanStartHeight(
  asset: 'xmr' | 'wow',
  tip: number,
  nowMs: number,
  maxDepthDays?: number | null,
): number {
  let days = Math.ceil(Math.max(0, nowMs - LEGACY_EPOCH_MS) / 86_400_000);
  if (typeof maxDepthDays === 'number' && maxDepthDays >= 0) days = Math.min(days, maxDepthDays);
  return Math.max(0, tip - days * CHAIN_BLOCKS_PER_DAY[asset]);
}

/** Below this many blocks behind the tip, a scan counts as caught up. */
const SCAN_LAG_BLOCKS = 5;

/**
 * Check every older address for funds. Never throws for expected failures;
 * each address gets its own state, so one bad read never hides another's money.
 * The exception is a refused sign-in (`LegacySignInRequiredError`), which every
 * read would hit alike.
 */
export async function discoverLegacyFunds(
  mnemonic: string,
  opts: LegacyDiscoveryOptions,
): Promise<LegacyFinding[]> {
  const accounts = legacyAccountsFor(mnemonic, opts.currentAddresses);
  try {
    const findings: LegacyFinding[] = [];
    for (const account of accounts) {
      findings.push(
        account.kind === 'utxo'
          ? await checkUtxo(account, opts)
          : await checkCryptonote(account, opts),
      );
    }
    return findings;
  } finally {
    wipeLegacyAccounts(accounts);
  }
}

function publicOf(a: LegacyAccount): LegacyAddress {
  return { asset: a.asset, source: a.source, address: a.address };
}

async function checkUtxo(
  account: LegacyUtxoAccount,
  opts: LegacyDiscoveryOptions,
): Promise<LegacyFinding> {
  const base = publicOf(account);
  const failed: LegacyFinding = { ...base, state: 'error', spendableAtomic: '0', pendingAtomic: '0', detail: 'Could not read this address right now.' };
  let r: ApiResponse<UtxoListing>;
  try {
    r = await opts.providers.utxo(account.asset).listOutputs(account.address);
  } catch {
    return failed;
  }
  if (r.status === 401) throw new LegacySignInRequiredError();
  if (r.error || !r.data) return failed;
  let confirmed = 0n;
  let pending = 0n;
  for (const u of r.data.utxos) {
    if (u.height > 0) confirmed += BigInt(u.value);
    else pending += BigInt(u.value);
  }
  return {
    ...base,
    state: confirmed > 0n || pending > 0n ? 'funds' : 'empty',
    spendableAtomic: confirmed.toString(),
    pendingAtomic: pending.toString(),
  };
}

type LwsBalanceData = {
  total_received: string | number;
  locked_balance: string | number;
  pending_balance: string | number;
  start_height: number;
  scanned_height: number;
  blockchain_height: number;
  spent_outputs: Array<{
    amount: string | number;
    key_image: string;
    tx_pub_key: string;
    out_index: number;
    subaddr_index?: { major: number; minor: number };
  }>;
};

async function readBalance(
  account: LegacyCryptonoteAccount,
  viewKeyHex: string,
  opts: LegacyDiscoveryOptions,
): Promise<{ data?: LwsBalanceData; error?: string }> {
  let r: ApiResponse<LwsBalance>;
  try {
    r = await opts.providers.lws(account.asset).getBalance(account.address, viewKeyHex);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'request failed' };
  }
  // Not "the server does not watch this address": the read never got that far.
  if (r.status === 401) throw new LegacySignInRequiredError();
  if (r.error || !r.data) return { error: r.error ?? 'no data' };
  return { data: r.data as unknown as LwsBalanceData };
}

async function checkCryptonote(
  account: LegacyCryptonoteAccount,
  opts: LegacyDiscoveryOptions,
): Promise<LegacyFinding> {
  const base = publicOf(account);
  const viewKeyHex = bytesToHex(account.privateViewKey);
  const spendKeyHex = bytesToHex(account.privateSpendKey);
  const none = { spendableAtomic: '0', pendingAtomic: '0' };

  // Read first. Re-registering an account the server already watches would
  // rewind its scan cursor, so registration is only ever the answer to a read
  // that failed.
  let read = await readBalance(account, viewKeyHex, opts);
  if (read.error) {
    if (opts.mode !== 'scan') {
      return {
        ...base,
        state: 'not-scanned',
        ...none,
        detail: 'The Smirk server does not watch this older address yet. Scan it to check for funds.',
      };
    }
    if (!opts.userId) {
      return { ...base, state: 'error', ...none, detail: 'Sign in to Smirk first, then scan again.' };
    }
    try {
      const provider = opts.providers.lws(account.asset);
      const tipRes = await provider.getHeight();
      const tip = tipRes.data?.height ?? 0;
      if (!(tip > 0)) {
        return { ...base, state: 'error', ...none, detail: 'Could not read the current block height.' };
      }
      const now = (opts.now ?? Date.now)();
      const start = legacyScanStartHeight(account.asset, tip, now, opts.restorePolicy?.max_depth_days);
      const policy = opts.restorePolicy;
      const bits = policy ? requiredRestorePowBits(account.asset, start, tip, policy) : 0;
      const nonce = await solveRestorePow(account.asset, account.address, start, bits);
      const reg = await provider.registerAccount(opts.userId, account.address, viewKeyHex, start, undefined, nonce);
      if (reg.error || reg.data?.success === false) {
        return { ...base, state: 'error', ...none, detail: 'The server refused to scan this older address.' };
      }
    } catch {
      return { ...base, state: 'error', ...none, detail: 'Could not ask the server to scan this older address.' };
    }
    read = await readBalance(account, viewKeyHex, opts);
    if (read.error || !read.data) {
      // Registered, but the first read can lag the registration.
      return { ...base, state: 'scanning', ...none };
    }
  }
  const d = read.data!;

  // Same arithmetic as the main balance path: only spends our spend key
  // confirms are subtracted; the rest are ring decoys from other people's
  // transactions. Without a verifier, trust the server (may under-report).
  const total = BigInt(d.total_received);
  const locked = BigInt(d.locked_balance);
  const pendingBal = BigInt(d.pending_balance);
  let spent = 0n;
  for (const out of d.spent_outputs ?? []) {
    if (!opts.verifyKeyImage) {
      spent += BigInt(out.amount);
      continue;
    }
    try {
      const computed = await opts.verifyKeyImage({
        privateViewKeyHex: viewKeyHex,
        privateSpendKeyHex: spendKeyHex,
        txPubKeyHex: out.tx_pub_key,
        outputIndex: out.out_index,
        ...(out.subaddr_index ? { subaddrMajor: out.subaddr_index.major, subaddrMinor: out.subaddr_index.minor } : {}),
      });
      if (computed.toLowerCase() === out.key_image.toLowerCase()) spent += BigInt(out.amount);
    } catch {
      // Cannot verify: count it as spent. Under-reporting is the safe direction.
      spent += BigInt(out.amount);
    }
  }
  const remaining = total - spent;
  const spendable = remaining - locked > 0n ? remaining - locked : 0n;
  const pending = locked + pendingBal;
  const behind = d.blockchain_height > 0 && d.scanned_height + SCAN_LAG_BLOCKS < d.blockchain_height;
  const scan = behind
    ? { scannedHeight: d.scanned_height, blockchainHeight: d.blockchain_height, startHeight: d.start_height }
    : undefined;
  const state: LegacyFindingState =
    spendable > 0n || pending > 0n ? 'funds' : behind ? 'scanning' : 'empty';
  return {
    ...base,
    state,
    spendableAtomic: spendable.toString(),
    pendingAtomic: pending.toString(),
    ...(scan ? { scan } : {}),
  };
}

/** True when a finding has something the user should act on or wait for. */
export function legacyFindingNeedsAttention(f: LegacyFinding): boolean {
  return f.state === 'funds';
}

/** Durable per-wallet record of the last check. Public data only (addresses and amounts). */
export interface LegacyCheckRecord {
  checkedAt: number;
  mode: 'probe' | 'scan';
  findings: LegacyFinding[];
}

/** Storage slot for a wallet's last check. Scoped by fingerprint so wallets never mix. */
export function legacyCheckRecordKey(fingerprint: string): string {
  return `smirk:legacy-funds:v1:${fingerprint}`;
}

/** Plain-language name of an older address's origin, for the UI. */
export function legacySourceLabel(f: LegacyAddress): string {
  if (f.source === 'm44') return 'Older Smirk address (before v0.3)';
  return f.source === 'v1' ? 'Older Smirk address (first key format)' : 'Older Smirk address (second key format)';
}
