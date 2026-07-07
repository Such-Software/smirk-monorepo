/**
 * Balance snapshot cache — persist the last-seen balances + prices in
 * `chrome.storage.session` so a reopened popup paints instantly instead of
 * flashing zeros while the network refresh runs. BigInt balances are stored as
 * strings (JSON can't carry BigInt) and revived on read. Extracted verbatim from
 * index.tsx; `readBalanceSnapshot`/`writeBalanceSnapshot` are the public API.
 */

import type { Balances, Prices } from '@smirk/core';

import { sessionStorage } from './singletons';

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

export async function readBalanceSnapshot(
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

export async function writeBalanceSnapshot(
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
