/**
 * XMR/WOW receive-subaddress issuance counter (Lane 4).
 *
 * Tracks, per `(backend, seed fingerprint, asset)`, which account-0 minor
 * subaddress index the wallet is currently handing out on the Receive screen,
 * plus the ceiling the SERVER says it has provisioned at the LWS.
 *
 * ## Ship-dark contract
 *
 * Everything here is gated behind {@link subaddressReceiveEnabled}
 * (`ENABLE_SUBADDRESS_RECEIVE`, default OFF). With the flag OFF nothing in this
 * module runs: `issued` stays 0, the Receive screen shows the primary address
 * exactly as it does today, and the wallet treats every output as primary.
 * Existing primary-address funds stay visible and spendable either way, because
 * the primary address is index `(0, 0)` and is always scanned.
 *
 * ## Why `issued` starts at 0
 *
 * `0` means "the primary address is what we are showing". Monero reserves
 * `(0, 0)` for the primary address, so the first real subaddress the wallet can
 * hand out is minor `1`. {@link ReceiveSubaddressIndex.advance} is the ONLY
 * thing that increments the counter; every read path is pure, which is what
 * makes the Receive screen stable under its re-render storm (the shell passes
 * an inline closure to `ReceiveScreen`, so its address effect re-fires on every
 * render; a read that advanced would burn a fresh address per frame).
 *
 * ## Money gates
 *
 * - **G4 (provision gate).** The wallet NEVER issues a minor index above
 *   `provisionedCeiling`. monero-lws only attributes receipts on subaddresses
 *   it has been told about (`provision_subaddrs`, bounded by its own
 *   `--max-subaddresses`, which defaults to 0 = subaddresses disabled).
 *   Handing out an unprovisioned subaddress would make funds sent to it
 *   INVISIBLE to the wallet: the LWS never reports the output, so it shows in
 *   no balance and is selectable by no spend. `advance` therefore asks the
 *   server to raise the ceiling and refuses (throws
 *   {@link ProvisionCeilingError}) when it cannot.
 * - **Server is the source of truth for the ceiling.** The ceiling is only ever
 *   set from a `provisionSubaddrs` response, never from a local constant. The
 *   LWS can provision fewer indices than asked for, so a hardcoded shared
 *   constant would drift straight into the invisible-funds case above. Every
 *   issuance round-trips to confirm it; there is no local headroom short-cut,
 *   because a cached ceiling is a claim about a DIFFERENT machine's state.
 * - **The ceiling belongs to one backend.** The counter is keyed by the active
 *   backend URL as well as `(fingerprint, asset)`. Provisioning happens at one
 *   instance's LWS, so a ceiling earned there says nothing about the LWS of a
 *   backend the user switches to (self-hosted, federated, or simply a second
 *   instance). Sharing one key across backends would let a ceiling one server
 *   granted authorise issuance against a server that provisioned nothing.
 * - **Monotonic issuance.** `advance` runs under a promise-chain mutex, and the
 *   write is a compare-and-set against the value it read, so two concurrent
 *   callers can never be handed the same index even from separate contexts. A
 *   crash after the write at worst burns an index (a gap, never a reuse).
 */

import {
  ChromeLocalStorage,
  chainProviders,
  xmrSubaddress,
  wowSubaddress,
  type PlatformStorage,
  type UnlockedWallet,
} from '@smirk/core';

/** Assets with a subaddress receive path. */
export type SubaddrAsset = 'xmr' | 'wow';

/** Default state of the `ENABLE_SUBADDRESS_RECEIVE` client flag: OFF. */
export const ENABLE_SUBADDRESS_RECEIVE_DEFAULT = false;

/**
 * Resolve the `ENABLE_SUBADDRESS_RECEIVE` client flag.
 *
 * Default OFF (ship-dark). Overridable at runtime via
 * `globalThis.__SMIRK_ENABLE_SUBADDRESS_RECEIVE__`: the host shell sets it
 * from its own settings surface, and unit tests set it to force the feature on.
 * Reading a global (rather than a compile-time const) is what lets tests
 * exercise the flag-on path without a rebuild.
 */
export function subaddressReceiveEnabled(): boolean {
  const g = globalThis as { __SMIRK_ENABLE_SUBADDRESS_RECEIVE__?: unknown };
  const v = g.__SMIRK_ENABLE_SUBADDRESS_RECEIVE__;
  return typeof v === 'boolean' ? v : ENABLE_SUBADDRESS_RECEIVE_DEFAULT;
}

/** How far past the index being issued to ASK the server to provision. The
 *  server may grant less; only its answer is believed. Asking for a batch keeps
 *  the LWS's provisioned range comfortably ahead of issuance; it never lets the
 *  client skip confirming the ceiling. */
export const PROVISION_BATCH = 32;

/** Persisted per-(fingerprint,asset) counter. Plain JSON, all numbers. */
export interface ReceiveSubaddrState {
  readonly version: 1;
  /**
   * Minor index currently being handed out on the Receive screen. `0` means the
   * primary address. Monotonic: only {@link ReceiveSubaddressIndex.advance}
   * raises it.
   */
  issued: number;
  /**
   * Highest minor index the SERVER has confirmed provisioned at the LWS. `0`
   * means "only the primary address is scanned", i.e. no subaddress may be
   * issued yet. Never inferred locally (money gate G4).
   */
  provisionedCeiling: number;
}

/** Thrown by {@link ReceiveSubaddressIndex.advance} when G4 blocks issuance. */
export class ProvisionCeilingError extends Error {
  constructor(
    readonly nextIndex: number,
    readonly ceiling: number,
    readonly provisionDetail?: string,
  ) {
    super(
      `subaddress provisioning: refusing to hand out minor index ${nextIndex}; ` +
        `the server has only provisioned up to ${ceiling}. Funds sent to an ` +
        `unprovisioned subaddress would not be seen by this wallet.` +
        (provisionDetail ? ` (provision attempt: ${provisionDetail})` : ''),
    );
    this.name = 'ProvisionCeilingError';
  }
}

function defaultState(): ReceiveSubaddrState {
  return { version: 1, issued: 0, provisionedCeiling: 0 };
}

/** Compare-and-set attempts before an issuance gives up. Two is enough for the
 *  realistic case (one other context wrote once); more would just extend how
 *  long a genuinely contended slot spins. */
const CAS_ATTEMPTS = 3;

/** Value equality for the CAS check. */
function sameState(a: ReceiveSubaddrState, b: ReceiveSubaddrState): boolean {
  return a.issued === b.issued && a.provisionedCeiling === b.provisionedCeiling;
}

/** Narrow an arbitrary stored blob into a valid counter, self-healing on
 *  corruption. Corruption self-heals DOWNWARD (to the primary address), which
 *  is the safe direction: showing the primary again is a privacy regression,
 *  showing an unprovisioned subaddress loses sight of money. */
function parseState(raw: unknown): ReceiveSubaddrState {
  if (!raw || typeof raw !== 'object') return defaultState();
  const r = raw as Record<string, unknown>;
  const nonNegInt = (v: unknown): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  return {
    version: 1,
    issued: nonNegInt(r.issued),
    provisionedCeiling: nonNegInt(r.provisionedCeiling),
  };
}

/** Storage-key namespace for the issuance counter. `v2` adds the backend
 *  scope; a `v1` blob is simply not read, which self-heals to "nothing issued". */
const KEY_PREFIX = 'smirk:receive-subaddr:v2';

/**
 * Canonical form of a backend base URL for use inside a storage key: trimmed,
 * lower-cased, trailing slashes removed, then percent-encoded so the `:` and
 * `/` in a URL cannot be confused with the key's own separators.
 *
 * An empty/unknown backend collapses to a single `unknown` bucket. That bucket
 * is still gated by the ceiling check, so the worst case is a counter that
 * refuses to issue, never one that issues past what a server provisioned.
 */
export function backendScope(backendUrl: string | undefined): string {
  const raw = (backendUrl ?? '').trim().toLowerCase().replace(/\/+$/, '');
  return raw === '' ? 'unknown' : encodeURIComponent(raw);
}

function storageKey(backendUrl: string | undefined, fingerprint: string, asset: SubaddrAsset): string {
  return `${KEY_PREFIX}:${backendScope(backendUrl)}:${fingerprint}:${asset}`;
}

/**
 * Raise the server-side provisioning ceiling to at least `maxMinor` and return
 * the ceiling the server confirms. Rejecting (or resolving below `maxMinor`) is
 * a legitimate answer and must block issuance, never be papered over.
 */
export type SubaddrProvisioner = (maxMinor: number) => Promise<number>;

/**
 * Per-(fingerprint,asset) receive-subaddress counter over a
 * {@link PlatformStorage} (the persistent `storage.local` tier; the counter
 * must survive browser close, or the wallet would re-hand-out an index it has
 * already published to someone).
 */
export class ReceiveSubaddressIndex {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: PlatformStorage,
    private readonly fingerprint: string,
    private readonly asset: SubaddrAsset,
    /** Active backend base URL. Scopes the counter, so a ceiling granted by one
     *  instance's LWS can never authorise issuance against another's. */
    private readonly backendUrl?: string,
  ) {}

  private get key(): string {
    return storageKey(this.backendUrl, this.fingerprint, this.asset);
  }

  /** Current counter (read-only snapshot). Pure: never advances, never writes. */
  async read(): Promise<ReceiveSubaddrState> {
    return parseState(await this.storage.get(this.key));
  }

  /**
   * The minor index to SHOW right now. `0` = the primary address. Pure and
   * idempotent, so it is safe to call from a render path (and it is: the Receive
   * screen's address effect re-fires on every render).
   */
  async currentIssued(): Promise<number> {
    return (await this.read()).issued;
  }

  /**
   * Run `mutator` under the mutex: load, mutate (possibly awaiting a network
   * provisioning call), persist, return.
   *
   * The promise-chain mutex serializes callers that share THIS instance, which
   * is every caller inside one popup (they go through the cached instance from
   * {@link receiveSubaddrIndexFor}). It cannot serialize a second context: a
   * pop-out window, the approval window, or a background job holding its own
   * instance over the same `chrome.storage.local` key.
   *
   * The write is therefore a compare-and-set: the slot is re-read after the
   * mutator finishes (it may have awaited a network round-trip) and the new
   * state is only committed while the slot still holds what was read. If
   * another context moved it, the whole cycle is retried against the fresh
   * value; exhausting the retries fails the operation rather than clobbering
   * the other writer's index, so two contexts can never be handed the same
   * subaddress to publish.
   */
  private runExclusive<T>(
    mutator: (s: ReceiveSubaddrState) => Promise<{ next: ReceiveSubaddrState; result: T }>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const observed = parseState(await this.storage.get(this.key));
        const { next, result } = await mutator(observed);
        const stillThere = parseState(await this.storage.get(this.key));
        if (sameState(stillThere, observed)) {
          await this.storage.set(this.key, next);
          return result;
        }
      }
      throw new Error(
        'receive subaddress counter: another window changed it while this issuance was in flight. Try again.',
      );
    };
    const p = this.chain.then(run, run);
    // Keep the chain alive across rejections so one failing op doesn't strand
    // every subsequent queued op.
    this.chain = p.catch(() => {});
    return p;
  }

  /**
   * Advance to (and return) the next minor index to hand out. The ONLY
   * incrementing operation.
   *
   * Money gate G4: refuses (throws {@link ProvisionCeilingError}) unless the
   * server has confirmed the candidate index is provisioned. EVERY issuance
   * calls `provision` first; whatever it returns becomes the new ceiling,
   * because the server is the only authority on what the LWS is scanning. A
   * failed provisioning leaves the ceiling untouched and blocks issuance rather
   * than guessing.
   *
   * There is deliberately no local-headroom short-cut. A cached ceiling is a
   * claim about the LWS's state at some earlier moment on a machine we do not
   * control: it can go stale through an LWS reset, a lowered
   * `--max-subaddresses`, an account re-registration, or a restore of that
   * server from backup. Issuing inside stale headroom hands the user an address
   * nobody is scanning, and funds sent to it are invisible to this wallet. The
   * user pressed a button and expects a network call, so paying for the
   * round-trip is the right trade.
   */
  async advance(provision: SubaddrProvisioner): Promise<number> {
    type Outcome =
      | { ok: true; index: number }
      | { ok: false; candidate: number; ceiling: number; note?: string };

    const outcome = await this.runExclusive<Outcome>(async (s) => {
      const candidate = s.issued + 1;
      let ceiling = s.provisionedCeiling;
      let note: string | undefined;

      try {
        const granted = await provision(candidate + PROVISION_BATCH);
        if (Number.isInteger(granted) && granted >= 0) {
          // ASSIGN, do not max() with the local value: the server's answer is
          // the truth about what the LWS scans. If it comes back lower than
          // what we had cached (an LWS reset, a lowered --max-subaddresses),
          // taking the max would keep issuing into a range nobody is
          // watching. Assigning instead blocks issuance until it recovers.
          ceiling = granted;
        } else {
          note = `server returned an unusable ceiling (${String(granted)})`;
        }
      } catch (e) {
        note = e instanceof Error ? e.message : String(e);
      }

      if (candidate > ceiling) {
        // Refuse, but STILL persist the observed ceiling (with `issued`
        // untouched). A ceiling the server just told us is lower than what we
        // had cached must stick, or the next call could sit inside the stale
        // headroom, skip the round-trip, and issue into a range the LWS is no
        // longer scanning. Throwing out of the mutator instead would roll the
        // observation back.
        return {
          next: { version: 1, issued: s.issued, provisionedCeiling: ceiling },
          result: { ok: false, candidate, ceiling, ...(note ? { note } : {}) } as Outcome,
        };
      }
      return {
        next: { version: 1, issued: candidate, provisionedCeiling: ceiling },
        result: { ok: true, index: candidate } as Outcome,
      };
    });

    if (!outcome.ok) {
      throw new ProvisionCeilingError(outcome.candidate, outcome.ceiling, outcome.note);
    }
    return outcome.index;
  }
}

// ============================================================================
// Shell bindings (storage + provisioner wiring)
// ============================================================================

// Storage is resolved LAZILY, and never at module load: `address.ts` imports
// this module, and constructing `ChromeLocalStorage` outside an extension
// context throws. Under the default flag-OFF path nothing here is ever
// touched, so a non-extension consumer (unit tests, the e2e harness) can import
// the address helpers without a `chrome` global at all.
let injectedStorage: PlatformStorage | null = null;
let lazyStorage: PlatformStorage | null = null;

/** Test seam: point the counter at an in-memory storage. `null` restores the
 *  real `chrome.storage.local` backing. */
export function setReceiveSubaddrStorage(storage: PlatformStorage | null): void {
  injectedStorage = storage;
  lazyStorage = null;
}

function resolveStorage(): PlatformStorage {
  if (injectedStorage) return injectedStorage;
  lazyStorage ??= new ChromeLocalStorage();
  return lazyStorage;
}

const indexCache = new Map<string, ReceiveSubaddressIndex>();

/** The counter for this backend + wallet + asset. Cached per key so the
 *  in-process mutex actually serializes concurrent callers (a fresh instance per
 *  call would each hold their own chain and could double-issue an index). */
export function receiveSubaddrIndexFor(
  fingerprint: string,
  asset: SubaddrAsset,
  backendUrl?: string,
): ReceiveSubaddressIndex {
  const key = `${backendScope(backendUrl)}:${fingerprint}:${asset}`;
  let idx = indexCache.get(key);
  if (!idx) {
    idx = new ReceiveSubaddressIndex(resolveStorage(), fingerprint, asset, backendUrl);
    indexCache.set(key, idx);
  }
  return idx;
}

/** Test seam: drop cached counters (and their mutex chains) between cases. */
export function resetReceiveSubaddrCache(): void {
  indexCache.clear();
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the provisioner for a wallet + asset over the active LWS chain
 * provider. The LWS account is keyed by the PRIMARY address + view key (a
 * subaddress is a view of that same account), so those are what get sent.
 *
 * Throws when the provider does not implement provisioning at all, which
 * `advance` turns into a refusal to issue, not a silent default (money gate
 * G4).
 */
export function backendProvisioner(
  wallet: UnlockedWallet,
  asset: SubaddrAsset,
  userId: string,
): SubaddrProvisioner {
  return async (maxMinor: number): Promise<number> => {
    const primary = wallet.addresses[asset];
    if (!primary) throw new Error(`no ${asset.toUpperCase()} address in wallet`);
    if (!userId) throw new Error('no active session; cannot provision subaddresses');
    const provider = chainProviders.lws(asset);
    if (!provider.provisionSubaddrs) {
      throw new Error('this chain provider does not support subaddress provisioning');
    }
    const viewKeyHex = bytesToHex(wallet.keys[asset].privateViewKey);
    const r = await provider.provisionSubaddrs(userId, primary, viewKeyHex, maxMinor);
    if (r.error || !r.data) throw new Error(r.error ?? 'provisioning failed');
    return r.data.provisionedMinorMax;
  };
}

/**
 * Advance the counter and return the NEW receive address. The only call path
 * that burns an index, so it is only ever reached from an explicit user action
 * ("New address"), never from a render.
 */
export async function issueNewReceiveAddress(
  wallet: UnlockedWallet,
  asset: SubaddrAsset,
  userId: string,
  backendUrl?: string,
): Promise<string> {
  const issued = await receiveSubaddrIndexFor(wallet.fingerprint, asset, backendUrl).advance(
    backendProvisioner(wallet, asset, userId),
  );
  return subaddressAt(wallet, asset, issued);
}

/**
 * The receive address to SHOW for a CryptoNote asset at minor index `issued`.
 * `issued <= 0` is the primary address; anything else is the account-0
 * subaddress at that minor index. Pure derivation, no I/O, no state.
 */
export function subaddressAt(
  wallet: UnlockedWallet,
  asset: SubaddrAsset,
  issued: number,
): string {
  const keys = wallet.keys[asset];
  return asset === 'xmr'
    ? xmrSubaddress(keys.publicSpendKey, keys.privateViewKey, 0, issued)
    : wowSubaddress(keys.publicSpendKey, keys.privateViewKey, 0, issued);
}
