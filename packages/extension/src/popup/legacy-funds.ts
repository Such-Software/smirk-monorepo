/**
 * Funds at this seed's older Smirk addresses: check, remember, move.
 *
 * Discovery lives in `@smirk/core` (`legacy-recovery`); this file adds what only
 * the extension has: the signer, the operation-password policy, storage, and the
 * send journal. See the core module header for the privacy levels.
 *
 * - `maybeAutoLegacyCheck` runs once per wallet after a full password unlock or
 *   an import (it needs the phrase), reading only older addresses the server
 *   already watches. It never registers anything and never moves anything.
 *   Every read it makes is authenticated, so it waits for this window's
 *   sign-in: see `startLegacyWorkAfterSignIn`.
 * - `runLegacyCheck` is the manual check from Settings, optionally asking the
 *   server to scan older Monero/Wownero addresses it does not watch yet.
 * - `moveLegacyFunds` sweeps one older address into the current wallet, after
 *   the user has seen the amount and fee.
 */

import {
  api,
  chainProviders,
  discoverLegacyFunds,
  legacyAccountsFor,
  legacyCheckRecordKey,
  wipeLegacyAccounts,
  type LegacyCheckRecord,
  type LegacyDiscoveryOptions,
  type LegacyFinding,
  type UnlockedWallet,
} from '@smirk/core';
import { storage, store } from './singletons';
import { verifyKeyImage } from './key-image';
import { sweepCryptonoteKeys, sweepUtxoKey, type SweepSummary } from './tip-claim-handler';
import { assertOperationSession, authorizeOperation } from './operation-auth';
import { journalKeyFor, recordSend } from './send-journal';

/** The last check for this wallet, or `null` if it was never checked. */
export async function readLegacyCheck(fingerprint: string): Promise<LegacyCheckRecord | null> {
  try {
    return (await storage.get<LegacyCheckRecord>(legacyCheckRecordKey(fingerprint))) ?? null;
  } catch {
    return null;
  }
}

async function writeLegacyCheck(fingerprint: string, record: LegacyCheckRecord): Promise<void> {
  try {
    await storage.set(legacyCheckRecordKey(fingerprint), record);
  } catch {
    // Display state only; a failed write just means the check runs again.
  }
}

/** Whether the automatic check is on (default on; see `ui.legacyFundsAutoCheck`). */
export async function legacyAutoCheckEnabled(): Promise<boolean> {
  try {
    const s = await store.load();
    return s.ui.legacyFundsAutoCheck !== false;
  } catch {
    return true;
  }
}

/**
 * Check the older addresses and store the result. Needs the phrase (a fresh
 * unlock or an import); a warm session restore has none and is refused.
 */
export async function runLegacyCheck(
  wallet: UnlockedWallet,
  opts: { mode: 'probe' | 'scan'; userId?: string | null },
): Promise<LegacyCheckRecord> {
  if (!wallet.mnemonic) {
    throw new Error('Unlock Smirk with your password first: checking older addresses needs your recovery phrase in memory.');
  }
  let restorePolicy: LegacyDiscoveryOptions['restorePolicy'];
  if (opts.mode === 'scan') {
    try {
      const caps = await api.getCapabilities();
      restorePolicy = caps.data?.restore ?? undefined;
    } catch {
      restorePolicy = undefined;
    }
  }
  const findings = await discoverLegacyFunds(wallet.mnemonic, {
    providers: chainProviders,
    mode: opts.mode,
    userId: opts.userId ?? null,
    verifyKeyImage,
    currentAddresses: {
      btc: wallet.addresses.btc,
      ltc: wallet.addresses.ltc,
      xmr: wallet.addresses.xmr,
      wow: wallet.addresses.wow,
    },
    ...(restorePolicy ? { restorePolicy } : {}),
  });
  const record: LegacyCheckRecord = { checkedAt: Date.now(), mode: opts.mode, findings };
  await writeLegacyCheck(wallet.fingerprint, record);
  return record;
}

/**
 * Whether a stored result already counts as the wallet's automatic check. A
 * probe that could not read some older address does not: it found out nothing
 * there, so the next unlock looks again. A scan the user asked for is never
 * replaced by a probe.
 */
function autoCheckDone(record: LegacyCheckRecord | null): boolean {
  if (!record) return false;
  return record.mode === 'scan' || !record.findings.some((f) => f.state === 'error');
}

/** One automatic check per wallet at a time; `readLegacyCheck` alone is not atomic. */
const autoCheckInFlight = new Map<string, Promise<LegacyCheckRecord | null>>();

/**
 * The once-per-wallet automatic check. Read-only (`probe`), silent, and never
 * fatal: anything that goes wrong just leaves the manual check in Settings.
 *
 * Runs only while this window is signed in. Lock drops the session token, and
 * this check used to start at unlock, before sign-in had put one back: its
 * reads were refused, and the refusals were kept as the wallet's one automatic
 * result (BTC/LTC `error`, XMR/WOW `not-scanned`), never to be checked again.
 * A read refused for sign-in now leaves no result at all.
 */
export function maybeAutoLegacyCheck(wallet: UnlockedWallet): Promise<LegacyCheckRecord | null> {
  const running = autoCheckInFlight.get(wallet.fingerprint);
  if (running) return running;
  const check = autoLegacyCheck(wallet).finally(() => autoCheckInFlight.delete(wallet.fingerprint));
  autoCheckInFlight.set(wallet.fingerprint, check);
  return check;
}

async function autoLegacyCheck(wallet: UnlockedWallet): Promise<LegacyCheckRecord | null> {
  try {
    if (!wallet.mnemonic) return null;
    if (!api.getAccessToken()) return null;
    if (!(await legacyAutoCheckEnabled())) return null;
    if (autoCheckDone(await readLegacyCheck(wallet.fingerprint))) return null;
    return await runLegacyCheck(wallet, { mode: 'probe' });
  } catch (e) {
    // Includes LegacySignInRequiredError: runLegacyCheck stored nothing, so
    // the next signed-in unlock checks again.
    console.warn('[smirk] older-address check skipped', e instanceof Error ? e.message : e);
    return null;
  }
}

export type MoveOutcome =
  | { ok: true; txid: string; summary: SweepSummary }
  | { ok: false; error: string };

/**
 * Move everything spendable at one older address into the current wallet.
 *
 * `confirm` is shown the exact amount and fee before anything is signed and may
 * refuse by throwing; the operation-password policy applies after it. Unsettled
 * value (unconfirmed, or not yet unlocked) stays behind for a later move.
 */
export async function moveLegacyFunds(
  wallet: UnlockedWallet,
  finding: LegacyFinding,
  confirm: (summary: SweepSummary) => Promise<void>,
): Promise<MoveOutcome> {
  if (!wallet.mnemonic) {
    return { ok: false, error: 'Unlock Smirk with your password first: moving funds from an older address needs your recovery phrase.' };
  }
  const accounts = legacyAccountsFor(wallet.mnemonic);
  try {
    const account = accounts.find((a) => a.asset === finding.asset && a.address === finding.address);
    if (!account) {
      return { ok: false, error: 'This older address does not belong to the unlocked wallet.' };
    }
    const authorize = async (summary: SweepSummary) => {
      await confirm(summary);
      await authorizeOperation('send', wallet, `Move funds from an older ${finding.asset.toUpperCase()} address to your wallet`);
      assertOperationSession(wallet);
    };
    const outcome =
      account.kind === 'utxo'
        ? await sweepUtxoKey(account.asset, account.privateKey, account.address, wallet, { settledOnly: true, authorize })
        : await sweepCryptonoteKeys(
            account.asset,
            account.privateSpendKey,
            account.privateViewKey,
            account.address,
            wallet,
            { settledOnly: true, authorize },
          );
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const key = journalKeyFor(wallet);
    if (key) {
      void recordSend(
        {
          txid: outcome.txid,
          asset: finding.asset,
          destination: wallet.addresses[finding.asset] ?? '',
          amountAtomic: outcome.summary.amountAtomic.toString(),
          feeAtomic: outcome.summary.feeAtomic.toString(),
          ...(outcome.txKeyHex ? { txKeyHex: outcome.txKeyHex } : {}),
          createdAt: Date.now(),
          recovery: { fromAddress: finding.address, source: finding.source },
        },
        key,
      );
    }
    // Reflect the move in the stored check so Home stops pointing at it.
    const record = await readLegacyCheck(wallet.fingerprint);
    if (record) {
      record.findings = record.findings.map((f) =>
        f.asset === finding.asset && f.address === finding.address
          ? {
              ...f,
              state: outcome.summary.unsettledAtomic > 0n ? 'funds' : 'empty',
              spendableAtomic: '0',
              pendingAtomic: outcome.summary.unsettledAtomic.toString(),
            }
          : f,
      );
      await writeLegacyCheck(wallet.fingerprint, record);
    }
    return { ok: true, txid: outcome.txid, summary: outcome.summary };
  } finally {
    wipeLegacyAccounts(accounts);
  }
}
