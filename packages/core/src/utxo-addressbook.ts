/**
 * BTC/LTC HD gap-limit address book (Lane 5).
 *
 * Tracks, per `(seed fingerprint, asset)`, which BIP84 receive (`/0/i`) and
 * change (`/1/j`) indices the wallet has used, so it can hand out FRESH
 * receive addresses (unlinkable on-chain receives) and FRESH change
 * addresses (change no longer clusters back onto the receive address).
 *
 * ## Ship-dark contract
 *
 * The whole feature is gated behind {@link btcLtcFreshAddrsEnabled}
 * (`ENABLE_BTCLTC_FRESH_ADDRS`, default OFF). With the flag OFF the wallet
 * never advances past index 0: receive stays `m/84'/coin'/0'/0/0`, balance /
 * UTXO / history read that single address, and change returns to it — exactly
 * today's behavior. Existing index-0 funds stay visible and spendable
 * regardless of the flag, because index 0 is always in the scan range.
 *
 * ## Money gates
 *
 * - **G12 (gap discovery).** {@link UtxoAddressBook.advanceReceive} REFUSES to
 *   hand out a receive index more than {@link GAP_LIMIT} beyond the highest
 *   index observed with on-chain activity. Handing out an address past the gap
 *   limit would strand funds sent to it: a from-seed restore stops scanning
 *   after {@link GAP_LIMIT} consecutive empty addresses, so anything beyond
 *   the gap is invisible on recovery.
 * - **Monotonic change.** {@link UtxoAddressBook.reserveChange} is serialized
 *   through a promise-chain mutex (mirroring `SessionStateStore.update`) and
 *   persists BEFORE returning, so two concurrent sends can never reserve the
 *   same change index and burn each other's change into one address (which
 *   would defeat the privacy goal and, worse, could collide with a receive
 *   scan assumption).
 * - **Change discovery.** {@link UtxoAddressBook.changeScanIndices} scans a full
 *   {@link GAP_LIMIT} past the highest known change index, and
 *   {@link recordUtxoActivity} folds what the scan finds back into the book.
 *   `changeNext` alone is local bookkeeping: after a from-seed restore or a
 *   cleared profile it reads 0, and a change-only scan range would then be
 *   empty while real change sits at `/1/j`. That output would be missing from
 *   the balance and unselectable by any in-app spend, even though an external
 *   wallet restored from the same seed finds it.
 */

import type { PlatformStorage } from './state/platform';
import type { UtxoAddressRef } from './chain/types';
import { btcAddressAt, ltcAddressAt } from './address';

/**
 * BIP44 gap limit. Standard across Bitcoin wallets (Electrum, BIP44 §
 * "Address gap limit"): a restore scans forward until it hits this many
 * consecutive unused addresses, then stops. We must never hand out an
 * address beyond `highestUsed + GAP_LIMIT` or a restored wallet won't find
 * funds sent to it.
 */
export const GAP_LIMIT = 20;

/** Default state of the `ENABLE_BTCLTC_FRESH_ADDRS` client flag: OFF. */
export const ENABLE_BTCLTC_FRESH_ADDRS_DEFAULT = false;

/**
 * Resolve the `ENABLE_BTCLTC_FRESH_ADDRS` client flag.
 *
 * Default OFF (ship-dark). Overridable at runtime via
 * `globalThis.__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__` — the host shell sets it
 * from its own config/settings surface, and unit tests set it to force the
 * feature on. Reading a global (rather than a compile-time const) is what
 * lets tests exercise the flag-on path without a rebuild.
 */
export function btcLtcFreshAddrsEnabled(): boolean {
  const g = globalThis as { __SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__?: unknown };
  const v = g.__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__;
  return typeof v === 'boolean' ? v : ENABLE_BTCLTC_FRESH_ADDRS_DEFAULT;
}

/** Thrown by {@link UtxoAddressBook.advanceReceive} when the gap limit blocks a fresh receive. */
export class GapLimitError extends Error {
  constructor(readonly nextIndex: number, readonly usedHigh: number) {
    super(
      `gap limit: refusing to hand out receive index ${nextIndex}; ` +
        `highest used is ${usedHigh}, limit is ${usedHigh} + ${GAP_LIMIT} = ${usedHigh + GAP_LIMIT}. ` +
        `Receive at an earlier unused index first, or wait for funds to land.`,
    );
    this.name = 'GapLimitError';
  }
}

/**
 * Persisted per-(fingerprint,asset) book. Plain JSON — round-trips through
 * `storage.local` unchanged (all numbers, no `Uint8Array`).
 */
export interface UtxoAddressBookState {
  readonly version: 1;
  /** Highest receive index observed to have on-chain activity. `-1` = none. */
  usedReceiveHigh: number;
  /**
   * Highest receive index the wallet has advanced its "current fresh receive"
   * pointer to. Starts at 0 (the primary address). Always `>= 0`.
   */
  receiveHigh: number;
  /** Next change index to reserve. Monotonic, only ever increases. Starts 0. */
  changeNext: number;
  /**
   * Highest change index observed to have on-chain activity. `-1` = none.
   *
   * Load-bearing after a restore or a cleared `storage.local`: `changeNext` is
   * purely local bookkeeping, so a wallet that has sent from another device (or
   * simply lost its local state) reads `changeNext === 0` while real change sits
   * at `/1/3`. Discovery writes what it finds here, and
   * {@link UtxoAddressBook.changeScanIndices} scans a gap window past it, so the
   * change output is found instead of being invisible and unspendable in-app.
   */
  changeUsedHigh: number;
}

function defaultState(): UtxoAddressBookState {
  return { version: 1, usedReceiveHigh: -1, receiveHigh: 0, changeNext: 0, changeUsedHigh: -1 };
}

/** Narrow an arbitrary stored blob into a valid book, self-healing on corruption. */
function parseState(raw: unknown): UtxoAddressBookState {
  if (!raw || typeof raw !== 'object') return defaultState();
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, min: number, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fallback;
  return {
    version: 1,
    usedReceiveHigh: int(r.usedReceiveHigh, -1, -1),
    receiveHigh: int(r.receiveHigh, 0, 0),
    changeNext: int(r.changeNext, 0, 0),
    // Absent on a book written before change discovery existed. `-1` ("nothing
    // observed") is the honest default; the scan window still covers a full gap
    // limit past `changeNext`, so nothing is hidden while discovery catches up.
    changeUsedHigh: int(r.changeUsedHigh, -1, -1),
  };
}

export type UtxoBookAsset = 'btc' | 'ltc';

/** Storage-key namespace for the address book. */
const KEY_PREFIX = 'smirk:utxo-addressbook:v1';

function storageKey(fingerprint: string, asset: UtxoBookAsset): string {
  return `${KEY_PREFIX}:${fingerprint}:${asset}`;
}

/**
 * Per-(fingerprint,asset) HD address book over a {@link PlatformStorage}
 * (the persistent `storage.local` tier — the book must survive browser
 * close, unlike session state).
 *
 * Construct one per asset. All mutating operations are serialized through an
 * internal promise-chain mutex so a load → mutate → save cycle is atomic even
 * under concurrent callers.
 */
export class UtxoAddressBook {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: PlatformStorage,
    private readonly fingerprint: string,
    private readonly asset: UtxoBookAsset,
  ) {}

  private get key(): string {
    return storageKey(this.fingerprint, this.asset);
  }

  /** Current book (read-only snapshot). */
  async read(): Promise<UtxoAddressBookState> {
    return parseState(await this.storage.get(this.key));
  }

  /**
   * Run `mutator` under the mutex: load the current state, apply the mutation,
   * persist, and return the mutator's result. Serialized so concurrent callers
   * observe each other's writes (mirrors `SessionStateStore.update`).
   */
  private runExclusive<T>(mutator: (s: UtxoAddressBookState) => { next: UtxoAddressBookState; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const current = parseState(await this.storage.get(this.key));
      const { next, result } = mutator(current);
      await this.storage.set(this.key, next);
      return result;
    };
    const p = this.chain.then(run, run);
    // Keep the chain alive across rejections so one failing op doesn't strand
    // every subsequent queued op.
    this.chain = p.catch(() => {});
    return p;
  }

  /**
   * The current fresh receive index — the address to SHOW the user. Does not
   * advance the pointer. With the feature off this is always 0.
   */
  async currentReceiveIndex(): Promise<number> {
    return (await this.read()).receiveHigh;
  }

  /**
   * Advance to (and return) the next fresh receive index. Money gate G12:
   * refuses to move more than {@link GAP_LIMIT} past the highest USED index —
   * throws {@link GapLimitError} rather than hand out an unrecoverable address.
   *
   * Idempotent-ish contract: it always advances by exactly one when allowed;
   * callers wanting "show me a fresh one" call this, callers wanting "what am I
   * showing" call {@link currentReceiveIndex}.
   */
  async advanceReceive(): Promise<number> {
    return this.runExclusive((s) => {
      const candidate = s.receiveHigh + 1;
      if (candidate > s.usedReceiveHigh + GAP_LIMIT) {
        throw new GapLimitError(candidate, s.usedReceiveHigh);
      }
      return { next: { ...s, receiveHigh: candidate }, result: candidate };
    });
  }

  /**
   * Record that a receive index was observed with on-chain activity (funds
   * or history). Raises `usedReceiveHigh` monotonically; a lower or equal
   * index is a no-op. This is what unlocks further {@link advanceReceive}
   * calls (the gap window slides forward as real funds land).
   */
  async markReceiveUsed(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) return;
    await this.runExclusive((s) => {
      if (index <= s.usedReceiveHigh) return { next: s, result: undefined };
      // Keep the visible receive pointer at/ahead of the highest used index so
      // the user is never shown an address that already received funds.
      const receiveHigh = Math.max(s.receiveHigh, index);
      return { next: { ...s, usedReceiveHigh: index, receiveHigh }, result: undefined };
    });
  }

  /**
   * Reserve the next change index. Monotonic + atomic: two concurrent sends
   * get two distinct indices, and the increment is persisted BEFORE the
   * caller receives its index, so a crash after reserve never re-hands the
   * same index (at worst it burns an index — a gap, never a collision).
   */
  async reserveChange(): Promise<number> {
    return this.runExclusive((s) => {
      const j = s.changeNext;
      return { next: { ...s, changeNext: j + 1 }, result: j };
    });
  }

  /**
   * Record that a CHANGE index was observed with on-chain activity. Raises
   * `changeUsedHigh` monotonically, and drags `changeNext` past it so the next
   * reservation cannot re-use an index that already holds money.
   *
   * This is the discovery half of the change chain. Without it, `changeNext`
   * (local-only) is the sole input to the change scan set, so a restored or
   * storage-cleared wallet scans no change addresses at all and the change
   * output holding the user's funds is in no scan set: invisible in the balance
   * and unselectable by any in-app spend, while an external wallet restored
   * from the same seed finds it immediately.
   */
  async markChangeUsed(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) return;
    await this.runExclusive((s) => {
      if (index <= s.changeUsedHigh && index < s.changeNext) {
        return { next: s, result: undefined };
      }
      return {
        next: {
          ...s,
          changeUsedHigh: Math.max(s.changeUsedHigh, index),
          // A used index is spoken for; never hand it out again as "next".
          changeNext: Math.max(s.changeNext, index + 1),
        },
        result: undefined,
      };
    });
  }

  /**
   * Receive indices to SCAN for balance/UTXO/history aggregation: `0` through
   * `max(receiveHigh, usedReceiveHigh) + GAP_LIMIT`, inclusive. Index 0 is
   * always included, so existing primary-address funds are always visible —
   * even with the feature off (where the range collapses toward `[0]` for a
   * fresh wallet, and the caller only actually queries index 0).
   */
  async receiveScanIndices(): Promise<number[]> {
    const s = await this.read();
    const top = Math.max(s.receiveHigh, s.usedReceiveHigh) + GAP_LIMIT;
    return range0(top);
  }

  /**
   * Change indices to SCAN: `0` through
   * `max(changeNext, changeUsedHigh) + GAP_LIMIT`, inclusive.
   *
   * The gap window is not optional here, it is the discovery mechanism. The
   * previous range (`0 .. changeNext - 1`) covered only what THIS install had
   * reserved, and `changeNext` lives in `storage.local` alone: after a
   * from-seed restore, a profile reset, or a send made from another device, it
   * reads 0 and the scan set is empty. The change output holding the user's
   * money is then in no scan set: omitted from the balance and unspendable
   * in-app, though Electrum or Sparrow restored from the same seed would find
   * it. Scanning a full gap limit past the highest known change index is what
   * every other BIP44 wallet does, and it lets {@link markChangeUsed} slide the
   * window forward as real change is found.
   */
  async changeScanIndices(): Promise<number[]> {
    const s = await this.read();
    return range0(Math.max(s.changeNext, s.changeUsedHigh) + GAP_LIMIT);
  }
}

/** `[0, 1, ..., top]` (empty guard for a negative `top`). */
function range0(top: number): number[] {
  if (top < 0) return [];
  const out: number[] = [];
  for (let i = 0; i <= top; i++) out.push(i);
  return out;
}

// ============================================================================
// Address / path helpers (bridge the index book to concrete addresses)
// ============================================================================

/** SLIP-0044 coin types for the BIP84 path, matching `hd.ts`. */
const BIP84_COIN_TYPE: Record<UtxoBookAsset, number> = { btc: 0, ltc: 2 };

/** `m/84'/coin'/0'/change/index` — the master path the signer resolves against. */
export function bip84MasterPath(asset: UtxoBookAsset, change: 0 | 1, index: number): string {
  return `m/84'/${BIP84_COIN_TYPE[asset]}'/0'/${change}/${index}`;
}

/** P2WPKH address at `change/index` under the asset's account xpub. */
export function utxoAddressAt(
  asset: UtxoBookAsset,
  accountXpub: string,
  change: 0 | 1,
  index: number,
): string {
  return asset === 'btc'
    ? btcAddressAt(accountXpub, change, index)
    : ltcAddressAt(accountXpub, change, index);
}

/**
 * Build the full set of `(address, masterPath)` refs to SCAN for this asset:
 * every receive index in `receiveScanIndices()` plus every change index in
 * `changeScanIndices()`. Index `(0,0)` is always first, so the primary-address
 * funds are always covered. The returned refs feed the multi-address balance /
 * UTXO / history calls; the master path on each is what the signer later trusts
 * (money gate G9).
 *
 * Both windows carry a gap limit, so the ref set is routinely larger than one
 * batch request allows. The API layer chunks it (see
 * `UTXO_MULTI_MAX_ADDRESSES`); callers pass the whole set.
 */
export async function buildUtxoScanRefs(
  book: UtxoAddressBook,
  asset: UtxoBookAsset,
  accountXpub: string,
): Promise<UtxoAddressRef[]> {
  const [recv, chg] = await Promise.all([book.receiveScanIndices(), book.changeScanIndices()]);
  const refs: UtxoAddressRef[] = [];
  for (const i of recv) {
    refs.push({ address: utxoAddressAt(asset, accountXpub, 0, i), masterPath: bip84MasterPath(asset, 0, i) });
  }
  for (const j of chg) {
    refs.push({ address: utxoAddressAt(asset, accountXpub, 1, j), masterPath: bip84MasterPath(asset, 1, j) });
  }
  return refs;
}

/**
 * Read `(change, index)` back out of a BIP84 master path produced by
 * {@link bip84MasterPath}. Returns `null` for anything that is not one of ours,
 * so an unexpected path can never be mistaken for a chain position.
 */
export function parseBip84MasterPath(path: string): { change: 0 | 1; index: number } | null {
  const m = /^m\/84'\/\d+'\/\d+'\/([01])\/(\d+)$/.exec(path);
  if (!m) return null;
  const change = Number(m[1]) as 0 | 1;
  const index = Number(m[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { change, index };
}

/**
 * Fold observed on-chain activity back into the book: every ref in
 * `activeAddresses` marks its index used, on the receive chain or the change
 * chain as its master path says.
 *
 * This is the discovery scan. It runs against the refs that were just queried,
 * so it costs no extra round-trip, and it is what makes both gap windows slide:
 * receive indices unlock further {@link UtxoAddressBook.advanceReceive} calls,
 * and change indices seed `changeNext` / `changeUsedHigh` on a wallet that has
 * no local history (a from-seed restore, a cleared profile, or funds moved from
 * another device).
 *
 * Best-effort and idempotent: unknown addresses and unparseable paths are
 * ignored, and re-reporting the same index is a no-op.
 */
export async function recordUtxoActivity(
  book: UtxoAddressBook,
  refs: readonly UtxoAddressRef[],
  activeAddresses: Iterable<string>,
): Promise<void> {
  const pathByAddress = new Map(refs.map((r) => [r.address, r.masterPath]));
  let receiveHigh = -1;
  let changeHigh = -1;
  for (const address of activeAddresses) {
    const path = pathByAddress.get(address);
    if (path === undefined) continue;
    const pos = parseBip84MasterPath(path);
    if (!pos) continue;
    if (pos.change === 0) receiveHigh = Math.max(receiveHigh, pos.index);
    else changeHigh = Math.max(changeHigh, pos.index);
  }
  // One write per chain rather than one per address: both marks are monotonic,
  // so only the highest matters.
  if (receiveHigh >= 0) await book.markReceiveUsed(receiveHigh);
  if (changeHigh >= 0) await book.markChangeUsed(changeHigh);
}
