/**
 * Live-money safety for the send, receive and history lane.
 *
 * Three rails stand between a spec and a real broadcast, and each refuses on
 * its own:
 *
 *   1. AddressBook: an allowlist of destinations. An address enters it only
 *      when the harness has read it off one of the three demo wallets' own
 *      Receive (or Nostr identity) screens, in process. `require` refuses
 *      anything else, so a typo, a stale constant or a pasted outside address
 *      can never be paid.
 *   2. SpendLedger: per-asset caps per send and per run, persisted under the
 *      run directory (0700, file 0600). A leg is reserved BEFORE its Send tap
 *      and stays counted even if the process dies mid-broadcast. Legs are keyed
 *      by a stable id, so a re-run resumes a leg that already broadcast instead
 *      of paying it twice; a leg left "reserved" with no outcome refuses until
 *      someone checks the chain.
 *   3. BroadcastMonitor: watches every broadcast endpoint the wallet can hit.
 *      In "observe" mode it counts (the duplicate-decoy retry is allowed only
 *      when nothing was broadcast). In "block" mode it aborts them, which is
 *      how Review-only and refusal checks prove that nothing left the wallet.
 *
 * Nothing here ever handles a phrase, key or password. The ledger records
 * wallet names, amounts, fees and transaction ids, all public.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Response, Route } from '@playwright/test';

export type LiveAsset = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
export type WalletName = 'alice' | 'bob' | 'carol';
export type DestinationKind = 'address' | 'npub';

export const LIVE_ASSETS: readonly LiveAsset[] = ['btc', 'ltc', 'xmr', 'wow', 'grin'];
export const WALLET_NAMES: readonly WalletName[] = ['alice', 'bob', 'carol'];

export const ASSET_DECIMALS: Readonly<Record<LiveAsset, number>> = {
  btc: 8,
  ltc: 8,
  xmr: 12,
  wow: 11,
  grin: 9,
};

export const TICKER: Readonly<Record<LiveAsset, string>> = {
  btc: 'BTC',
  ltc: 'LTC',
  xmr: 'XMR',
  wow: 'WOW',
  grin: 'GRIN',
};

/** Parse a decimal amount exactly. Refuses anything with more precision than the asset has. */
export function toAtomic(asset: LiveAsset, decimal: string): bigint {
  const text = decimal.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`not a plain decimal amount for ${TICKER[asset]}`);
  const decimals = ASSET_DECIMALS[asset];
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`${TICKER[asset]} has only ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Format atomic units the way the wallet does: trailing zeros trimmed, no ticker. */
export function fromAtomic(asset: LiveAsset, atomic: bigint, maxFractionDigits?: number): string {
  const decimals = ASSET_DECIMALS[asset];
  const cap = Math.min(decimals, maxFractionDigits ?? decimals);
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, '0').slice(0, cap).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Caps, in atomic units. `perSend` bounds one leg, `perRun` bounds the sum of
 * every leg in one run directory, and `feeCap` is the most a single leg may
 * pay in network fee before the spec calls the fee wrong. The planned rings
 * (RING_AMOUNTS) sit well inside them: BTC 7,500 of 10,000 sat, LTC 0.009 of
 * 0.05, XMR 0.006 of 0.05, WOW 0.6 of 5, GRIN 0.9 of 2.
 */
export const SPEND_CAPS: Readonly<Record<LiveAsset, { perSend: bigint; perRun: bigint; feeCap: bigint }>> = {
  btc: { perSend: 6_000n, perRun: 10_000n, feeCap: 5_000n },
  ltc: { perSend: toAtomic('ltc', '0.025'), perRun: toAtomic('ltc', '0.05'), feeCap: toAtomic('ltc', '0.001') },
  xmr: { perSend: toAtomic('xmr', '0.025'), perRun: toAtomic('xmr', '0.05'), feeCap: toAtomic('xmr', '0.001') },
  wow: { perSend: toAtomic('wow', '2.5'), perRun: toAtomic('wow', '5'), feeCap: toAtomic('wow', '0.1') },
  grin: { perSend: toAtomic('grin', '1.1'), perRun: toAtomic('grin', '2'), feeCap: toAtomic('grin', '0.05') },
};

/**
 * What the funding plan sets aside for one leg's network fee. Realistic, not
 * the cap: `feeCap` is where a fee becomes wrong, which is about ten times a
 * normal one, and planning with it refused rings the wallets could pay. Each
 * leg still checks the wallet's own estimate on Compose or Review before it
 * reserves anything. BTC 1,500 sat covers a two-input segwit send at about
 * 7 sat/vB; the others are several times their usual fee.
 */
export const FEE_RESERVE: Readonly<Record<LiveAsset, bigint>> = {
  btc: 1_500n,
  ltc: toAtomic('ltc', '0.0002'),
  xmr: toAtomic('xmr', '0.0005'),
  wow: toAtomic('wow', '0.05'),
  grin: toAtomic('grin', '0.05'),
};

/**
 * One coin's payments form a ring through the three wallets, largest first.
 * Each amount covers the next leg plus its fee reserve, so only the wallet
 * that starts the ring needs a balance of its own; the other two pay from
 * what they just received. Every amount is a small multiple of the coin's
 * minimum useful output, and the coins only circulate: the cost of a ring is
 * three network fees.
 */
export const RING_AMOUNTS: Readonly<Record<LiveAsset, readonly [string, string, string]>> = {
  btc: ['0.00004', '0.000025', '0.00001'],
  ltc: ['0.004', '0.003', '0.002'],
  xmr: ['0.003', '0.002', '0.001'],
  wow: ['0.3', '0.2', '0.1'],
  grin: ['0.5', '0.3', '0.1'],
};

export type GrinVia = 'npub' | 'address' | 'pasted';

export interface RingEdge {
  from: WalletName;
  to: WalletName;
  /** Grin only: how the slate travels on this edge. */
  via?: GrinVia;
}

/** The on-chain coins' ring: alice pays bob, bob pays carol, carol pays alice. */
export const CHAIN_RING: readonly RingEdge[] = [
  { from: 'alice', to: 'bob' },
  { from: 'bob', to: 'carol' },
  { from: 'carol', to: 'alice' },
];

/** Grin's ring: one edge per delivery path (Nostr npub, pasted slatepack, grin1 address). */
export const GRIN_RING: readonly RingEdge[] = [
  { from: 'carol', to: 'alice', via: 'npub' },
  { from: 'alice', to: 'bob', via: 'pasted' },
  { from: 'bob', to: 'carol', via: 'address' },
];

export interface PlannedLeg extends RingEdge {
  /** Stable per edge, so a re-run resumes the same payment whatever order it planned. */
  id: string;
  asset: LiveAsset;
  amount: string;
  /** 0 for the leg that starts the ring. */
  position: number;
}

export type RingPlan =
  | { ok: true; legs: PlannedLeg[]; startsWith: WalletName; resumed: boolean }
  | { ok: false; reason: string };

export function ringLegId(asset: LiveAsset, edge: RingEdge): string {
  return `${asset}-${edge.from}-${edge.to}`;
}

/**
 * Choose where a coin's ring starts. The preferred order comes first; another
 * start is used only when the preferred starter cannot fund it. `balances` are
 * the wallets' header totals now, which already include any leg this run
 * broadcast earlier. When this run's ledger already holds legs of the ring,
 * the order they were planned in is kept (their amounts say their positions),
 * so a resumed run never pays an edge twice or at a different amount.
 */
export function planRing(
  asset: LiveAsset,
  ring: readonly RingEdge[],
  balances: ReadonlyMap<WalletName, bigint>,
  ledger: readonly LedgerEntry[],
): RingPlan {
  const amounts = RING_AMOUNTS[asset];
  const reserve = FEE_RESERVE[asset];
  const order = (start: number): PlannedLeg[] =>
    [0, 1, 2].map((position) => {
      const edge = ring[(start + position) % ring.length]!;
      return { ...edge, id: ringLegId(asset, edge), asset, amount: amounts[position]!, position };
    });
  const ids = new Set(ring.map((edge) => ringLegId(asset, edge)));
  const known = ledger.filter((e) => e.asset === asset && e.status !== 'refused' && ids.has(e.legId));
  let starts = [0, 1, 2];
  if (known.length > 0) {
    starts = starts.filter((s) =>
      known.every((k) => {
        const leg = order(s).find((l) => l.id === k.legId)!;
        return toAtomic(asset, leg.amount).toString() === k.amountAtomic;
      }),
    );
    if (starts.length !== 1) {
      return { ok: false, reason: `this run's ledger holds ${TICKER[asset]} legs that fit no single ring order; check them before re-running` };
    }
  }
  const tried: string[] = [];
  for (const start of starts) {
    const legs = order(start);
    const have = new Map(balances);
    let shortfall: string | null = null;
    for (const leg of legs) {
      // A leg this run already broadcast has moved its coins: they are in the balances.
      if (known.some((k) => k.legId === leg.id && k.status === 'broadcast')) continue;
      const amount = toAtomic(asset, leg.amount);
      const need = amount + reserve;
      const holds = have.get(leg.from) ?? 0n;
      if (holds < need) {
        shortfall =
          `${leg.from} would hold ${fromAtomic(asset, holds)} ${TICKER[asset]} but ${leg.id} needs ` +
          `${fromAtomic(asset, need)} (${leg.amount} plus a ${fromAtomic(asset, reserve)} fee reserve)`;
        break;
      }
      have.set(leg.from, holds - need);
      have.set(leg.to, (have.get(leg.to) ?? 0n) + amount);
    }
    if (!shortfall) return { ok: true, legs, startsWith: legs[0]!.from, resumed: known.length > 0 };
    tried.push(`starting with ${legs[0]!.from}, ${shortfall}`);
  }
  return { ok: false, reason: `no ${TICKER[asset]} ring order can be funded: ${tried.join('; ')}` };
}

/** Shapes a destination must have before it is even considered for the allowlist. */
const ADDRESS_SHAPE: Readonly<Record<LiveAsset, RegExp>> = {
  btc: /^bc1[02-9ac-hj-np-z]{11,87}$/,
  ltc: /^ltc1[02-9ac-hj-np-z]{11,87}$/,
  xmr: /^[48][1-9A-HJ-NP-Za-km-z]{94}$/,
  wow: /^W[1-9A-HJ-NP-Za-km-z]{96}$/,
  grin: /^grin1[02-9ac-hj-np-z]{58}$/,
};
const NPUB_SHAPE = /^npub1[02-9ac-hj-np-z]{58}$/;

/** True when `address` has the receive-address shape for `asset`. */
export function looksLikeReceiveAddress(asset: LiveAsset, address: string): boolean {
  return ADDRESS_SHAPE[asset].test(address);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivateLine(file: string, line: string): void {
  ensurePrivateDir(dirname(file));
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

interface BookEntry {
  wallet: WalletName;
  asset: LiveAsset;
  kind: DestinationKind;
  value: string;
}

/**
 * The destination allowlist. Entries come only from `register`, which the
 * Receive and identity flows call with what the wallet itself displayed.
 */
export class AddressBook {
  private readonly entries: BookEntry[] = [];

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as BookEntry;
        if (this.valid(e)) this.entries.push(e);
      }
    }
  }

  private valid(e: BookEntry): boolean {
    if (!WALLET_NAMES.includes(e.wallet) || !LIVE_ASSETS.includes(e.asset)) return false;
    return e.kind === 'npub' ? e.asset === 'grin' && NPUB_SHAPE.test(e.value) : looksLikeReceiveAddress(e.asset, e.value);
  }

  register(wallet: WalletName, asset: LiveAsset, value: string, kind: DestinationKind = 'address'): void {
    const e: BookEntry = { wallet, asset, kind, value: value.trim() };
    if (!this.valid(e)) {
      throw new Error(`${wallet}'s ${TICKER[asset]} ${kind} does not have the expected shape; refusing to allowlist it`);
    }
    const clash = this.entries.find((x) => x.value === e.value && (x.wallet !== wallet || x.asset !== asset));
    if (clash) throw new Error(`${wallet}'s ${TICKER[asset]} ${kind} is already registered to ${clash.wallet}`);
    const same = this.entries.find((x) => x.wallet === wallet && x.asset === asset && x.kind === kind);
    if (same && same.value !== e.value) {
      // A receive address that changes mid-run means the wallet derived a
      // different one (subaddress flag, a different account). Refuse rather
      // than silently pay the newer one.
      throw new Error(`${wallet}'s ${TICKER[asset]} ${kind} changed during the run`);
    }
    if (!same) {
      this.entries.push(e);
      if (this.file) writePrivateLine(this.file, JSON.stringify(e));
    }
  }

  has(wallet: WalletName, asset: LiveAsset, kind: DestinationKind = 'address'): boolean {
    return this.entries.some((x) => x.wallet === wallet && x.asset === asset && x.kind === kind);
  }

  get(wallet: WalletName, asset: LiveAsset, kind: DestinationKind = 'address'): string {
    const e = this.entries.find((x) => x.wallet === wallet && x.asset === asset && x.kind === kind);
    if (!e) throw new Error(`no ${TICKER[asset]} ${kind} read for ${wallet} yet`);
    return e.value;
  }

  /** The wallet that owns `value`, or a refusal. This is the allowlist gate. */
  require(asset: LiveAsset, value: string): WalletName {
    const e = this.entries.find((x) => x.asset === asset && x.value === value.trim());
    if (!e) throw new Error(`refusing to pay a ${TICKER[asset]} destination that is not one of the demo wallets' own`);
    return e.wallet;
  }
}

export type LedgerStatus = 'reserved' | 'broadcast' | 'refused';

export interface LedgerEntry {
  legId: string;
  asset: LiveAsset;
  from: WalletName;
  to: WalletName;
  amountAtomic: string;
  status: LedgerStatus;
  at: string;
  txid?: string;
  feeAtomic?: string;
  /** Grin's on-chain identifier. */
  kernel?: string;
  slateId?: string;
  /** What the sender's history detail said right after the broadcast. */
  firstStatus?: string;
  /**
   * The browser profiles (by their import id) that signed and, for Grin,
   * received the payment. The send record behind the history sheet's
   * recipient, fee and transaction key, and every Grin history row, live
   * only in that profile.
   */
  senderProfile?: string;
  recipientProfile?: string;
  /** Short non-secret note, e.g. the refusal class. */
  note?: string;
}

/** A spend reservation, a broadcast, and a refusal are appended; the last line per leg wins. */
export class SpendLedger {
  private readonly legs = new Map<string, LedgerEntry>();

  constructor(
    private readonly file: string,
    private readonly book: AddressBook,
  ) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as LedgerEntry;
        this.legs.set(e.legId, { ...this.legs.get(e.legId), ...e });
      }
    }
  }

  private write(e: LedgerEntry): void {
    this.legs.set(e.legId, e);
    writePrivateLine(this.file, JSON.stringify(e));
  }

  entries(asset?: LiveAsset): LedgerEntry[] {
    return [...this.legs.values()].filter((e) => !asset || e.asset === asset);
  }

  get(legId: string): LedgerEntry | undefined {
    return this.legs.get(legId);
  }

  /** The leg's broadcast, when an earlier attempt of this run already made it. */
  completed(legId: string): LedgerEntry | undefined {
    const e = this.legs.get(legId);
    return e?.status === 'broadcast' ? e : undefined;
  }

  /** Total committed for an asset: every broadcast and every unresolved reservation. */
  committed(asset: LiveAsset): bigint {
    return this.entries(asset)
      .filter((e) => e.status !== 'refused')
      .reduce((sum, e) => sum + BigInt(e.amountAtomic), 0n);
  }

  /**
   * Reserve a leg before its Send tap. Refuses an outside destination, a
   * self-send, a leg over the per-send cap, a run over the per-run cap, and a
   * leg whose earlier attempt has no recorded outcome.
   */
  reserve(leg: {
    legId: string;
    asset: LiveAsset;
    from: WalletName;
    destination: string;
    amountAtomic: bigint;
  }): WalletName {
    const to = this.book.require(leg.asset, leg.destination);
    if (to === leg.from) throw new Error(`refusing a self-send from ${leg.from}`);
    const caps = SPEND_CAPS[leg.asset];
    if (leg.amountAtomic <= 0n) throw new Error('refusing a non-positive amount');
    if (leg.amountAtomic > caps.perSend) {
      throw new Error(`${TICKER[leg.asset]} leg ${leg.legId} exceeds the per-send cap`);
    }
    const prior = this.legs.get(leg.legId);
    if (prior?.status === 'broadcast') throw new Error(`leg ${leg.legId} already broadcast; resume it instead`);
    if (prior?.status === 'reserved') {
      throw new Error(
        `leg ${leg.legId} was reserved by an earlier attempt that recorded no outcome; ` +
          'check the sender\'s history for a broadcast before re-running with a new run label',
      );
    }
    if (this.committed(leg.asset) + leg.amountAtomic > caps.perRun) {
      throw new Error(`${TICKER[leg.asset]} would exceed the per-run cap`);
    }
    this.write({
      legId: leg.legId,
      asset: leg.asset,
      from: leg.from,
      to,
      amountAtomic: leg.amountAtomic.toString(),
      status: 'reserved',
      at: new Date().toISOString(),
    });
    return to;
  }

  broadcast(
    legId: string,
    outcome: {
      txid?: string;
      kernel?: string;
      slateId?: string;
      feeAtomic?: bigint;
      senderProfile?: string;
      recipientProfile?: string;
    },
  ): void {
    const e = this.legs.get(legId);
    if (!e) throw new Error(`leg ${legId} was never reserved`);
    this.write({
      ...e,
      status: 'broadcast',
      at: new Date().toISOString(),
      ...(outcome.txid ? { txid: outcome.txid } : {}),
      ...(outcome.kernel ? { kernel: outcome.kernel } : {}),
      ...(outcome.slateId ? { slateId: outcome.slateId } : {}),
      ...(outcome.feeAtomic !== undefined ? { feeAtomic: outcome.feeAtomic.toString() } : {}),
      ...(outcome.senderProfile ? { senderProfile: outcome.senderProfile } : {}),
      ...(outcome.recipientProfile ? { recipientProfile: outcome.recipientProfile } : {}),
    });
  }

  annotate(legId: string, patch: Pick<LedgerEntry, 'firstStatus' | 'feeAtomic' | 'note'>): void {
    const e = this.legs.get(legId);
    if (!e) return;
    this.write({ ...e, ...patch });
  }

  /** Release a reservation whose send was refused before anything was broadcast. */
  refuse(legId: string, note: string): void {
    const e = this.legs.get(legId);
    if (!e) return;
    this.write({ ...e, status: 'refused', at: new Date().toISOString(), note: note.slice(0, 80) });
  }
}

/**
 * Every HTTP path a wallet broadcast can take: BTC/LTC (both API dialects),
 * XMR/WOW (both LWS dialects) and Grin finalize.
 */
export const BROADCAST_PATH = /\/wallet\/(?:utxo\/broadcast|broadcast|lws\/submit_tx|lws\/submit|grin\/broadcast)(?:[?#]|$)/;

export type BroadcastMode = 'observe' | 'block';

/**
 * Counts (observe) or aborts (block) broadcast requests in one browser
 * context, including approval popups. `mark()`/`since()` scope a count to one
 * attempt. The aborted request fails the wallet's own send, which is the
 * point: a Review-only or refusal check proves nothing was broadcast by
 * showing nothing could have been.
 */
export class BroadcastMonitor {
  private seen = 0;
  private blocked = 0;

  private constructor(
    private readonly context: BrowserContext,
    private mode: BroadcastMode,
  ) {}

  private readonly handler = async (route: Route): Promise<void> => {
    if (route.request().method() === 'OPTIONS') {
      await route.continue();
      return;
    }
    this.seen += 1;
    if (this.mode === 'block') {
      this.blocked += 1;
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  };

  static async attach(context: BrowserContext, mode: BroadcastMode): Promise<BroadcastMonitor> {
    const m = new BroadcastMonitor(context, mode);
    await context.route(BROADCAST_PATH, m.handler);
    return m;
  }

  setMode(mode: BroadcastMode): void {
    this.mode = mode;
  }

  get currentMode(): BroadcastMode {
    return this.mode;
  }

  /** Broadcast requests seen so far (observed or blocked). */
  count(): number {
    return this.seen;
  }

  blockedCount(): number {
    return this.blocked;
  }

  mark(): number {
    return this.seen;
  }

  since(mark: number): number {
    return this.seen - mark;
  }

  /** Run `fn` with broadcasts blocked, then restore the previous mode. Returns how many were attempted. */
  async blocking<T>(fn: () => Promise<T>): Promise<{ value: T; attempted: number }> {
    const previous = this.mode;
    const start = this.seen;
    this.mode = 'block';
    try {
      const value = await fn();
      return { value, attempted: this.seen - start };
    } finally {
      this.mode = previous;
    }
  }

  async detach(): Promise<void> {
    await this.context.unroute(BROADCAST_PATH, this.handler);
  }
}

/** The refusal a CLSAG ring assembly gives when the sampled pool repeats an index. */
export const DUPLICATE_DECOY_REFUSAL = /Could not assemble a full ring|Failed to create Decoys|invalid Decoys/i;

/** The wallet's own Grin tip request: `GET /wallet/grin/height`, answering `{ height }`. */
export const GRIN_HEIGHT_PATH = /\/wallet\/grin\/height$/;

/**
 * The Grin chain tip as the wallets' own balance refreshes report it. The
 * wallet asks the backend for the tip before every Grin scan; this reads
 * those answers (a public block height, nothing else) off the browser's
 * network events, so the harness never holds a session token. Absent
 * evidence is not progress: `latest` stays null until a real answer lands,
 * and a wait that needs the tip refuses on a stale one.
 */
export class ChainTip {
  private best: { height: number; at: number } | null = null;

  /** Feed every response of a wallet's browser context through here. */
  watch(response: Response): void {
    let path: string;
    try {
      path = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!GRIN_HEIGHT_PATH.test(path) || !response.ok()) return;
    void response
      .json()
      .then((body: unknown) => {
        const height = (body as { height?: unknown } | null)?.height;
        if (typeof height === 'number' && Number.isSafeInteger(height) && height > 0) this.observe(height);
      })
      .catch(() => undefined);
  }

  observe(height: number): void {
    if (!this.best || height >= this.best.height) this.best = { height, at: Date.now() };
  }

  /** The highest tip seen, and when a response last reported it (or a higher one). */
  latest(): { height: number; at: number } | null {
    return this.best;
  }
}
