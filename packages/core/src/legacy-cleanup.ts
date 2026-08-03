/**
 * Legacy-cleanup fund-safety warn-block (FUND-CRITICAL).
 *
 * The v0.2 -> v0.3 migration deliberately KEEPS the legacy `walletState` blob
 * around after re-sealing the seed into the v0.3 keystore (see migration.ts).
 * `walletState` doubles as the "this wallet still has un-finished v0.2 business"
 * beacon: while it exists, `convergeLegacySweep` keeps sweeping legacy m/44'
 * BTC/LTC funds on every unlock. Deleting it is the irreversible "I'm done with
 * v0.2" act, so it must never strand recoverable funds.
 *
 * Ground truth (from the 4-subsystem audit): deleting `walletState` ITSELF is
 * safe-by-default once the v0.3 keystore exists (every field re-derives from the
 * seed, which is already resealed). The genuine stranding risks live ELSEWHERE:
 *   1. legacy `pendingSocialTips` entries still `pending`: each wraps an
 *      EPHEMERAL, non-seed-derivable tip key that is the only sender clawback.
 *   2. legacy `grinPendingInvoice`: per-slate finalize secrets not on the
 *      backend and not seed-derivable; losing them forfeits an in-flight receive.
 *      (`grinPendingReceive` is the softer, copy-outable, 24h-TTL sibling.)
 *   3. LIVE confirmed BTC/LTC at the m/44' address: auto-swept ONLY while
 *      `walletState` exists, so it must be empty before we turn the sweep off.
 *      The durable `smirk_legacy_sweep_<asset>` record is NOT sufficient: a late
 *      deposit re-strands after a prior sweep, so a live check is mandatory.
 *   4. XMR/WOW at a v1/v2 Cryptonote address for the pre-v3 cohort: there is
 *      NO in-app sweep for these; the live wallet only ever watches the v3 addr.
 *
 * FAIL CLOSED: any check that cannot complete (locked wallet, missing keystore,
 * network error, unreadable data) yields a HARD `check-failed` blocker. A false
 * "safe" strands funds irreversibly, so an indeterminate check is never "safe".
 */
import { bytesToHex } from './crypto';
import {
  LEGACY_WALLET_KEY,
  V03_KEYSTORE_KEY,
  legacyBtcLtcKey,
  type LegacyWalletState,
} from './migration';
import { deriveAllKeys } from './hd';
import { xmrAddress, wowAddress } from './address';
import { chainProviders, type ChainProviderRegistry } from './chain/registry';
import type { UnlockedWallet } from './keystore';
import type { PlatformStorage } from './state/platform';

/** Legacy v0.2 chrome.storage.local keys holding ephemeral, non-seed-derivable
 *  fund secrets. These are DISJOINT from `walletState`; a `storage.local.clear()`
 *  would wipe them, so cleanup must scan (and preserve) them explicitly. Note
 *  `grinPendingInvoice` was accessed by string literal in v0.2 (never in the
 *  STORAGE_KEYS enum), so we scan the literal. */
export const LEGACY_PENDING_TIPS_KEY = 'pendingSocialTips';
export const LEGACY_GRIN_INVOICE_KEY = 'grinPendingInvoice';
export const LEGACY_GRIN_RECEIVE_KEY = 'grinPendingReceive';

/** `grinPendingReceive` auto-expired after 24h in v0.2 (a signed-receive half
 *  the sender drives to finalize); past that it is no longer worth blocking on. */
const GRIN_RECEIVE_TTL_MS = 24 * 60 * 60 * 1000;

export type BlockerSeverity = 'hard' | 'warn';

/** A reason cleanup of the legacy wallet is unsafe or inadvisable right now.
 *  `hard` blockers make `safe` false and MUST refuse deletion; `warn` blockers
 *  are advisory (the UI may require an explicit acknowledgement). */
export type CleanupBlocker =
  | { kind: 'keystore-missing'; severity: 'hard'; detail: string }
  | { kind: 'wallet-locked'; severity: 'hard'; detail: string }
  | {
      kind: 'unclaimed-tips';
      severity: 'hard';
      count: number;
      assets: string[];
      detail: string;
    }
  | {
      kind: 'grin-in-flight';
      severity: BlockerSeverity;
      source: 'grinPendingInvoice' | 'grinPendingReceive';
      detail: string;
    }
  | {
      kind: 'btcltc-unswept';
      severity: BlockerSeverity;
      asset: 'btc' | 'ltc';
      confirmedSat: number;
      unconfirmedSat: number;
      legacyAddress: string;
      detail: string;
    }
  | {
      kind: 'xmrwow-stranded';
      severity: 'hard';
      asset: 'xmr' | 'wow';
      derivationVersion: 1 | 2;
      legacyAddress?: string;
      detail: string;
    }
  | { kind: 'check-failed'; severity: 'hard'; check: string; detail: string };

export interface CleanupSafety {
  /** True IFF there are no `hard` blockers. */
  safe: boolean;
  blockers: CleanupBlocker[];
}

/** Minimal shape of a legacy v0.2 `pendingSocialTips` entry (only the fields we
 *  read). `status === 'pending'` means funds may still sit at the tip address
 *  and the local ephemeral key is the sole sender recovery. */
interface LegacyPendingTip {
  status?: string;
  asset?: string;
  tipId?: string;
}

interface LegacyGrinReceive {
  createdAt?: number;
}

/**
 * Assess whether the legacy v0.2 wallet data can be safely cleaned up (i.e. the
 * `walletState` beacon deleted) without stranding recoverable funds. Pure with
 * respect to storage: reads what it needs from `storage` and does LIVE chain
 * reads via `providers`. Never throws for expected states; a thrown/failed check
 * becomes a HARD `check-failed` blocker (fail closed).
 *
 * @returns `{ safe, blockers }` where `safe === blockers.every(b => b.severity !== 'hard')`.
 */
export async function assessLegacyCleanupSafety(
  wallet: UnlockedWallet,
  storage: PlatformStorage,
  providers: ChainProviderRegistry = chainProviders,
): Promise<CleanupSafety> {
  const blockers: CleanupBlocker[] = [];

  // CHECK 0: the v0.3 keystore MUST exist. If it doesn't, `walletState` may be
  // the only copy of the seed; deleting it strands everything. Stop immediately.
  const keystore = await storage.get<unknown>(V03_KEYSTORE_KEY);
  if (keystore == null) {
    blockers.push({
      kind: 'keystore-missing',
      severity: 'hard',
      detail:
        'The v0.3 keystore is missing, so the legacy wallet may hold your only seed copy. Finish the upgrade before cleaning up.',
    });
    return finalize(blockers);
  }

  // CHECK 1: need the mnemonic to derive the legacy addresses. A session-cache
  // restore drops it; without it every fund check is indeterminate. Stop.
  if (!wallet.mnemonic) {
    blockers.push({
      kind: 'wallet-locked',
      severity: 'hard',
      detail:
        'Unlock with your password first. A session-restored wallet cannot derive the old addresses to confirm they are empty.',
    });
    return finalize(blockers);
  }
  const mnemonic = wallet.mnemonic;

  const legacy = await storage.get<LegacyWalletState>(LEGACY_WALLET_KEY);

  // CHECK 2: legacy unclaimed outgoing tips (ephemeral clawback key, no bridge).
  try {
    const tips = await storage.get<LegacyPendingTip[]>(LEGACY_PENDING_TIPS_KEY);
    const pending = Array.isArray(tips)
      ? tips.filter((t) => t?.status === 'pending')
      : [];
    if (pending.length > 0) {
      const assets = [...new Set(pending.map((t) => t.asset ?? 'unknown'))];
      blockers.push({
        kind: 'unclaimed-tips',
        severity: 'hard',
        count: pending.length,
        assets,
        detail: `You have ${pending.length} unclaimed v0.2 tip(s) whose funds only your local backup can reclaim. Claim or clawback them first.`,
      });
    }
  } catch {
    blockers.push({
      kind: 'check-failed',
      severity: 'hard',
      check: 'unclaimed-tips',
      detail: 'Could not read your legacy pending tips to confirm none are unclaimed.',
    });
  }

  // CHECK 4: Grin in-flight slates (finalize secrets not seed/backend-derivable).
  try {
    const invoice = await storage.get<unknown>(LEGACY_GRIN_INVOICE_KEY);
    if (invoice != null) {
      blockers.push({
        kind: 'grin-in-flight',
        severity: 'hard',
        source: 'grinPendingInvoice',
        detail:
          'A Grin invoice is mid-exchange. Its finalize secret lives only here and cannot be rebuilt from your seed. Complete or cancel it first.',
      });
    }
    const receive = await storage.get<LegacyGrinReceive>(LEGACY_GRIN_RECEIVE_KEY);
    if (receive != null) {
      const age =
        typeof receive.createdAt === 'number'
          ? Date.now() - receive.createdAt
          : 0;
      if (age < GRIN_RECEIVE_TTL_MS) {
        blockers.push({
          kind: 'grin-in-flight',
          severity: 'warn',
          source: 'grinPendingReceive',
          detail:
            'A signed Grin receive is waiting for the sender to finalize. Keep it until the payment confirms.',
        });
      }
    }
  } catch {
    blockers.push({
      kind: 'check-failed',
      severity: 'hard',
      check: 'grin-in-flight',
      detail: 'Could not read your legacy Grin state to confirm nothing is in flight.',
    });
  }

  // CHECK 5: LIVE BTC/LTC balance at the legacy m/44' address. Confirmed funds
  // are a hard block (the sweep only runs while walletState exists); unconfirmed
  // is a warn (will sweep once it confirms). Independent of the durable record.
  for (const asset of ['btc', 'ltc'] as const) {
    try {
      const legacyAddress = legacyBtcLtcKey(mnemonic, asset).address;
      const live = await providers.utxo(asset).listOutputs(legacyAddress);
      if (live.error || !live.data) {
        blockers.push({
          kind: 'check-failed',
          severity: 'hard',
          check: `btcltc-${asset}`,
          detail: `Could not verify your old ${asset.toUpperCase()} address is empty (${live.error ?? 'no data'}).`,
        });
        continue;
      }
      const confirmedSat = live.data.utxos
        .filter((u) => u.height > 0)
        .reduce((s, u) => s + u.value, 0);
      const unconfirmedSat = live.data.utxos
        .filter((u) => u.height <= 0)
        .reduce((s, u) => s + u.value, 0);
      if (confirmedSat > 0) {
        blockers.push({
          kind: 'btcltc-unswept',
          severity: 'hard',
          asset,
          confirmedSat,
          unconfirmedSat,
          legacyAddress,
          detail: `${confirmedSat} sat still sits at your old ${asset.toUpperCase()} address. Let the automatic sweep finish before cleaning up.`,
        });
      } else if (unconfirmedSat > 0) {
        blockers.push({
          kind: 'btcltc-unswept',
          severity: 'warn',
          asset,
          confirmedSat: 0,
          unconfirmedSat,
          legacyAddress,
          detail: `An incoming ${asset.toUpperCase()} deposit at your old address is still confirming; it will sweep once confirmed.`,
        });
      }
    } catch {
      blockers.push({
        kind: 'check-failed',
        severity: 'hard',
        check: `btcltc-${asset}`,
        detail: `The legacy ${asset.toUpperCase()} balance check failed.`,
      });
    }
  }

  // CHECK 6: XMR/WOW stranded at a v1/v2 Cryptonote address. Only the pre-v3
  // cohort is at risk (the live wallet is hardcoded to v3). There is NO in-app
  // sweep for these, so we LIVE-probe the re-derived legacy address and block on
  // any unspent (or fail closed if we cannot verify). v3/undefined => the wallet
  // already watches that address; nothing stranded.
  const ver = legacy?.derivationVersion;
  if (ver === 1 || ver === 2) {
    for (const asset of ['xmr', 'wow'] as const) {
      let legacyAddress: string | undefined;
      try {
        const keys = deriveAllKeys(mnemonic, '', ver);
        const ck = keys[asset];
        legacyAddress =
          asset === 'xmr'
            ? xmrAddress(ck.publicSpendKey, ck.publicViewKey)
            : wowAddress(ck.publicSpendKey, ck.publicViewKey);
        const viewKey = bytesToHex(ck.privateViewKey);
        const bal = await providers.lws(asset).getBalance(legacyAddress, viewKey);
        if (bal.error || !bal.data) {
          blockers.push({
            kind: 'check-failed',
            severity: 'hard',
            check: `xmrwow-${asset}`,
            detail: `Could not verify your old ${asset.toUpperCase()} (v${ver}) address is empty (${bal.error ?? 'no data'}).`,
          });
          continue;
        }
        const spent = (bal.data.spent_outputs ?? []).reduce(
          (s, o) => s + BigInt(o.amount),
          0n,
        );
        const unspent = BigInt(bal.data.total_received) - spent;
        if (unspent > 0n) {
          blockers.push({
            kind: 'xmrwow-stranded',
            severity: 'hard',
            asset,
            derivationVersion: ver,
            legacyAddress,
            detail: `Funds remain at your old ${asset.toUpperCase()} address (older v${ver} derivation, no in-app sweep). Move them with seed recovery before cleaning up.`,
          });
        }
      } catch {
        blockers.push({
          kind: 'check-failed',
          severity: 'hard',
          check: `xmrwow-${asset}`,
          detail: `The legacy ${asset.toUpperCase()} (v${ver}) balance check failed.`,
        });
      }
    }
  }

  return finalize(blockers);
}

function finalize(blockers: CleanupBlocker[]): CleanupSafety {
  return { safe: blockers.every((b) => b.severity !== 'hard'), blockers };
}

/** Thrown by `cleanupLegacyWallet` when a hard blocker is present. Carries the
 *  offending blockers so the UI can list exactly what to resolve first. */
export class LegacyCleanupBlockedError extends Error {
  readonly blockers: CleanupBlocker[];
  constructor(blockers: CleanupBlocker[]) {
    super('Legacy wallet cleanup is blocked by unresolved recoverable funds.');
    this.name = 'LegacyCleanupBlockedError';
    this.blockers = blockers;
  }
}

/**
 * Delete the legacy `walletState` beacon, but ONLY after re-asserting safety at
 * call time (so a deposit that lands between a UI check and the click is caught).
 * Refuses with `LegacyCleanupBlockedError` on any hard blocker. Deletes nothing
 * else: the ephemeral-secret keys (`pendingSocialTips` / `grinPendingInvoice` /
 * `grinPendingReceive`) and all v0.3-live state (`smirk_keystore_v1`,
 * `smirk:popup-state`, `smirk:tip-key-backup:*`) are left untouched.
 *
 * Idempotent: once `walletState` is gone a re-run finds nothing to remove.
 * Removing `walletState` is the irreversible turn-off of `convergeLegacySweep`,
 * so it is the very last act and only happens when `safe`.
 */
export async function cleanupLegacyWallet(
  wallet: UnlockedWallet,
  storage: PlatformStorage,
  providers: ChainProviderRegistry = chainProviders,
): Promise<{ removed: string[] }> {
  const { safe, blockers } = await assessLegacyCleanupSafety(
    wallet,
    storage,
    providers,
  );
  if (!safe) {
    throw new LegacyCleanupBlockedError(
      blockers.filter((b) => b.severity === 'hard'),
    );
  }
  const existed = (await storage.get<unknown>(LEGACY_WALLET_KEY)) != null;
  await storage.remove(LEGACY_WALLET_KEY);
  return { removed: existed ? [LEGACY_WALLET_KEY] : [] };
}
