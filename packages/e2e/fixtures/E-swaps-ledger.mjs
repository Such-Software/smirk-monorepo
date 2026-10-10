/**
 * In-flight real swaps of the E-swaps live lane, kept across runs.
 *
 * A real swap spends a deposit the moment Send is tapped, and a provider may
 * take hours to pay out. A rerun that starts the same swap again spends a
 * second deposit while the first is still in flight. So each real swap is
 * written here just before its Send tap and removed only when the lane sees
 * the provider finish it (completed, refunded or failed). While an entry is
 * open, the lane refuses to start another swap of that provider and pair, on
 * any demo wallet, in any run.
 *
 * Clearing an entry is an operator decision after checking the swap at the
 * provider: E_SWAPS_CLEAR_INFLIGHT names the keys to clear (comma separated),
 * and the lane records each clearance in the run's evidence.
 *
 * The file holds public facts only (provider, pair, wallet name, txid, run id,
 * times) and is written 0600 in a 0700 directory, outside any run directory.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY = /^[a-z]+:[a-z]+-[a-z]+$/;

export function swapKey(provider, from, to) {
  const key = `${provider}:${from}-${to}`;
  if (!KEY.test(key)) throw new Error('an in-flight key is provider:from-to in lower case');
  return key;
}

export class InflightLedger {
  #file;

  constructor(file) {
    this.#file = file;
  }

  #read() {
    if (!existsSync(this.#file)) return {};
    const parsed = JSON.parse(readFileSync(this.#file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.swaps !== 'object') throw new Error('the in-flight ledger is unreadable; inspect it before any real swap');
    return parsed.swaps;
  }

  #write(swaps) {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, swaps }, null, 1)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#file);
    chmodSync(this.#file, 0o600);
  }

  /** The open entry for this key, or null. */
  open(key) {
    return this.#read()[key] ?? null;
  }

  /** Why a new swap of this key must not start, or null. */
  refusal(key) {
    const entry = this.open(key);
    if (!entry) return null;
    const where = entry.txid ? `deposit ${entry.txid}` : 'a deposit that may have been broadcast (check the wallet history)';
    return `a ${key} swap from run ${entry.runId} (${entry.wallet}, ${where}) is not known to have finished; check it at the provider, then set E_SWAPS_CLEAR_INFLIGHT=${key} to clear it`;
  }

  /** Written just before the Send tap: from here a deposit may exist. */
  begin(key, { wallet, runId }) {
    const swaps = this.#read();
    if (swaps[key]) throw new Error(this.refusal(key));
    swaps[key] = { wallet, runId, phase: 'sending', since: new Date().toISOString() };
    this.#write(swaps);
  }

  broadcast(key, txid) {
    const swaps = this.#read();
    if (!swaps[key]) throw new Error(`no open ${key} entry to record a broadcast on`);
    swaps[key] = { ...swaps[key], phase: 'broadcast', txid };
    this.#write(swaps);
  }

  /** The provider finished it (completed, refunded or failed). */
  finish(key) {
    const swaps = this.#read();
    delete swaps[key];
    this.#write(swaps);
  }

  /** Operator clearance. Returns the entries removed. */
  clear(keys) {
    const swaps = this.#read();
    const removed = [];
    for (const key of keys) {
      if (!KEY.test(key)) throw new Error('E_SWAPS_CLEAR_INFLIGHT names keys as provider:from-to');
      if (swaps[key]) {
        removed.push({ key, ...swaps[key] });
        delete swaps[key];
      }
    }
    if (removed.length) this.#write(swaps);
    return removed;
  }
}
