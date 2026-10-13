/**
 * E-swaps, live: THORChain, NonLogs and Trocador swaps and the Where to trade
 * panel, driven in the release build against the configured backend with the
 * owner-approved demo wallets (alice, bob, carol).
 *
 * Run only through its own lane (E-swaps.live.config.ts sets E2E_LANE=live);
 * the main suite does not register these tests. Each gate is explicit, see
 * fixtures/E-swaps-live.ts. A recorded run, from packages/e2e:
 *
 *   EXTENSION_DIST=<the release Chrome zip, unpacked> \
 *   EXTENSION_ZIP=<that zip> E2E_EXPECT_ZIP_SHA256=<its published SHA-256> \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 \
 *   E2E_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *     npx playwright test -c E-swaps.live.config.ts
 *   node scripts/E-swaps-encode.mjs --latest
 *
 * Wallets: tests that spend nothing use the first of E_SWAPS_WALLETS (default
 * alice,bob,carol). A test that needs funds reads the candidates' balances on
 * screen, in order, and uses the first that covers it; the choice and every
 * balance read are in the run's evidence.
 *
 * Money moves only in the last four tests, in the smallest amounts the
 * providers accept (planned from THORChain's own public answers, or from the
 * smallest step of a capped ladder Trocador quotes, before any deposit), and
 * only between a demo wallet's own addresses and the deposit address a
 * provider quoted. The real Trocador swap also needs the owner's
 * V031_TROCADOR_SWAP=yes (fixtures/E-swaps-trocador.mjs). Review must show exactly the quoted
 * coin, amount and deposit address before Send is tapped. A real swap is
 * entered in the in-flight ledger before its Send tap and leaves it only when
 * the provider finishes it; while it is there, no run starts that swap again.
 * Quotes in the other tests are never executed.
 *
 * Every tap and typed field goes through `footage` (scripts/E-swaps-check-live-spec.mjs
 * enforces it): it holds the screen still first, checks the frame guard, and
 * records the hold; the screen each action leads to is held settled before
 * the next. Results are held for the owner's 25 seconds.
 */

import { test, expect, laneGates, liveRefusal, type Lane } from '../../fixtures/E-swaps-live.js';
import { BACKEND_URL } from '../../fixtures/extension.js';
import { getCapabilities } from '../../fixtures/capabilities.js';
import {
  FOREIGN_ADDRESS,
  THOR_ASSET_CODES,
  parseThorMemo,
  thorInbound,
  thorObservedTx,
  thorQuoteProbe,
  type ThorObserved,
} from '../../fixtures/E-swaps-providers.js';
import { swapKey } from '../../fixtures/E-swaps-ledger.mjs';
import {
  TROCADOR_TRADE_ID,
  trocadorAmountRefusal,
  trocadorEvidence,
  trocadorPlan,
  trocadorSwapRefusal,
  type TrocadorStep,
} from '../../fixtures/E-swaps-trocador.mjs';
import {
  COINS,
  TERMINAL,
  backToPair,
  bringIntoView,
  choosePair,
  closeWizard,
  completedAmount,
  confirmError,
  depositAmount,
  followStatus,
  fromAtomic,
  hasPill,
  liveTickers,
  nonlogsCard,
  openNonlogs,
  openThorchain,
  openTrocador,
  readBalance,
  readOwnAddress,
  readQuote,
  requestQuote,
  sendPrefilled,
  statusTradeId,
  swapRoot,
  tabRoot,
  thorchainCard,
  toAtomic,
  type BalanceView,
  type Coin,
  type QuoteView,
} from '../../fixtures/E-swaps-ui.js';
import type { LiveWallet, RequestEntry } from '../../fixtures/E-swaps-wallets.js';

const gates = laneGates();
const BACKEND_HOST = new URL(BACKEND_URL).host;
const THOR_GATEWAY_HOST = 'gateway.liquify.com';
const THIRD_PARTY_SWAP_HOSTS = [THOR_GATEWAY_HOST, 'api.trocador.app', 'neroswap.com', 'nonlogs.io'];

/** BTC to LTC deposit: 15,000 sat unless THORChain's minimum is higher. */
const BTC_SWAP_SAT = BigInt(process.env.E_SWAPS_BTC_SAT ?? '15000');
/** Never spend more than this on the BTC deposit, minimum or not. */
const BTC_CAP_SAT = BigInt(process.env.E_SWAPS_BTC_CAP_SAT ?? '30000');
/** Covers the BTC network fee at a busy-day rate. */
const BTC_FEE_MARGIN_SAT = 8_000n;
/**
 * LTC to BTC amounts, smallest first. THORChain refuses a quote whose fees
 * exceed the wallet's 3% price limit, and BTC's outbound fee is fixed, so
 * small amounts are refused; planning finds the smallest it accepts.
 */
const LTC_LADDER = (process.env.E_SWAPS_LTC_LADDER ?? '0.1,0.25,0.4,0.5,0.6').split(',').map((s) => s.trim());
const LTC_FEE_MARGIN = toAtomic('0.002', 'ltc');
/** NonLogs real swap: 0.02 XMR, raised to the pair minimum up to 0.03 XMR. */
const XMR_SWAP = process.env.E_SWAPS_XMR_AMOUNT ?? '0.02';
const XMR_CAP = toAtomic(process.env.E_SWAPS_XMR_CAP ?? '0.03', 'xmr');
const XMR_FEE_MARGIN = toAtomic('0.001', 'xmr');

/** Budgets. A test's timeout is the sum of what it may wait for. */
const MIN = 60_000;
/** Balances, addresses, quote, confirm and Send, at the owner's holds. */
const SETUP_MS = 60 * MIN;
const THOR_FOLLOW_MS = 150 * MIN;
/** Trocador: LTC confirmations at the exchange, the exchange, and the XMR payout. */
const TROCADOR_FOLLOW_MS = 150 * MIN;
const NONLOGS_DEPOSIT_MS = 75 * MIN;
/** How long NonLogs may take to pay out (matching can take hours). */
const NONLOGS_BUDGET_MS = Number(process.env.E_SWAPS_NONLOGS_BUDGET_MIN ?? '180') * MIN;

/** Known defects of the build under test the owner may accept by name. */
const KNOWN_ISSUES = new Set(['stale-provider-note']);

interface SwapCapabilities {
  swaps?: {
    thorchain?: { enabled?: boolean; assets?: Record<string, string>; affiliate?: { name: string; bps: number } | null };
    nonlogs?: { enabled?: boolean };
  };
}

async function swapCaps(): Promise<NonNullable<SwapCapabilities['swaps']>> {
  return ((await getCapabilities()) as unknown as SwapCapabilities).swaps ?? {};
}

/** A valid address of `coin` that is not the wallet's (see FOREIGN_ADDRESS). */
function foreign(coin: Coin): string {
  if (coin === 'grin') throw new Error('GRIN has no swap address');
  return FOREIGN_ADDRESS[coin];
}

const roundUp = (value: bigint, step: bigint) => ((value + step - 1n) / step) * step;

/** Skip with the gate's reason when a gate is closed. */
function requireGates(lane: Lane, needsMoney: boolean): void {
  const refusal = liveRefusal(gates, needsMoney, lane.build);
  test.skip(refusal !== null, refusal ?? '');
}

/** A guard's refusal: kept with the run's evidence (the reporter withholds error text), then thrown. */
function refuse(lane: Lane, reason: string): never {
  lane.evidence.note(test.info().title, 'refused', reason);
  throw new Error(reason);
}

/** Refuse a real swap while one of the same provider and pair is unfinished. */
function guardInflight(lane: Lane, key: string): void {
  const refusal = lane.ledger.refusal(key);
  if (refusal) refuse(lane, refusal);
}

/** Ledger entries around the Send tap of a real swap. */
function inflightHooks(lane: Lane, key: string, w: LiveWallet): { before: () => void; after: (txid: string) => void } {
  const title = test.info().title;
  return {
    before: () => lane.ledger.begin(key, { wallet: w.name, runId: lane.runId }),
    after: (txid) => {
      lane.ledger.broadcast(key, txid);
      lane.evidence.note(title, 'deposit txid', txid);
    },
  };
}

/** Whether the owner accepted a known defect by name (E_SWAPS_ACCEPT_KNOWN_ISSUES). */
function knownIssueAccepted(name: string): boolean {
  const listed = (process.env.E_SWAPS_ACCEPT_KNOWN_ISSUES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of listed) if (!KNOWN_ISSUES.has(n)) throw new Error('E_SWAPS_ACCEPT_KNOWN_ISSUES names an issue this lane does not know');
  return listed.includes(name);
}

/** The first candidate wallet, for tests that spend nothing. */
function firstWallet(lane: Lane): Promise<LiveWallet> {
  return lane.wallet(lane.candidates[0]!);
}

/**
 * The first candidate wallet whose confirmed `coin` covers `need`. Each
 * candidate's balance is read on screen and held as a result; every read and
 * the choice go into the run's evidence. Null when none can.
 */
async function fundedWallet(lane: Lane, coin: Coin, need: bigint): Promise<{ w: LiveWallet; balance: BalanceView } | null> {
  const title = test.info().title;
  lane.evidence.note(title, `needs ${COINS[coin].ticker}`, need.toString());
  for (const name of lane.candidates) {
    const w = await lane.wallet(name);
    const balance = await readBalance(w, coin);
    lane.evidence.note(title, `${name} confirmed ${COINS[coin].ticker}`, balance.confirmed.toString());
    if (balance.confirmed >= need) {
      lane.evidence.note(title, 'wallet', name);
      return { w, balance };
    }
  }
  return null;
}

/**
 * What every THORChain quote must show: the total fee line (included in the
 * estimate), the liquidity and outbound breakdown that sums to it, a total
 * under the wallet's 3% price limit, the price-limit and gateway notices, and
 * a Smirk fee line exactly when the wallet server names an affiliate.
 */
function assertThorQuote(q: QuoteView, to: Coin, affiliate: { bps: number } | null): { totalBps: number } {
  const t = COINS[to].ticker;
  expect(q.provider).toBe('thorchain');
  expect(q.receiveTicker).toBe(t);
  const receive = toAtomic(q.receive, to);
  expect(receive, 'a positive estimate').toBeGreaterThan(0n);
  const total = q.fee.match(new RegExp(`^≈ ([\\d.]+) ${t}, included in the estimate$`))?.[1];
  expect(total, 'the total fee line, in the destination coin, included in the estimate').toBeTruthy();
  const breakdown = q.notices.find((n) => n.startsWith("THORChain's fees"));
  const parts = breakdown?.match(new RegExp(`liquidity ([\\d.]+) ${t}, outbound ([\\d.]+) ${t}`));
  expect(parts, 'the liquidity and outbound fee lines').toBeTruthy();
  const smirk = q.notices.find((n) => n.startsWith('Smirk fee'));
  let affiliateFee = 0n;
  if (affiliate) {
    expect(smirk, 'a Smirk fee line when the server names an affiliate').toBeTruthy();
    expect(smirk).toContain(`Smirk fee ${affiliate.bps / 100}%`);
    affiliateFee = toAtomic(smirk!.match(new RegExp(`\\(([\\d.]+) ${t}\\)`))?.[1] ?? '0', to);
  } else {
    expect(smirk, 'no affiliate line: the wallet server names no affiliate').toBeUndefined();
  }
  const totalAtomic = toAtomic(total!, to);
  expect(toAtomic(parts![1]!, to) + toAtomic(parts![2]!, to) + affiliateFee, 'liquidity + outbound (+ affiliate) = total').toBe(totalAtomic);
  const totalBps = Number((totalAtomic * 10_000n) / (receive + totalAtomic));
  expect(totalBps, 'total fees in basis points of the fee-free output').toBeGreaterThan(0);
  expect(totalBps, 'a quote THORChain honours keeps fees under the 3% price limit').toBeLessThan(300);
  expect(q.notices.some((n) => n.includes('sets a price limit 3% below the estimate'))).toBe(true);
  expect(q.notices.some((n) => n.includes(THOR_GATEWAY_HOST))).toBe(true);
  expect(q.validForS).toBeGreaterThan(0);
  expect(q.validForS).toBeLessThanOrEqual(600);
  return { totalBps };
}

/**
 * The BTC deposit to quote: 15,000 sat, or THORChain's current minimum for
 * BTC to LTC rounded up to 1,000 sat when that is higher, from THORChain's
 * public quote endpoint. Planned before a wallet is chosen, so the wallet
 * chosen can fund it.
 */
async function planBtcDeposit(lane: Lane, affiliate: { name: string; bps: number } | null): Promise<bigint | null> {
  const probe = await thorQuoteProbe('BTC', 'LTC', BTC_SWAP_SAT, affiliate);
  const title = test.info().title;
  if (!probe.ok) {
    // The wallet's own quote decides; its failure is this test's failure.
    lane.evidence.note(title, 'planning', probe.reason);
    return BTC_SWAP_SAT;
  }
  const min = probe.recommendedMinIn;
  if (min !== null) lane.evidence.note(title, 'THORChain minimum sat', min.toString());
  const amount = min !== null && min > BTC_SWAP_SAT ? roundUp(min, 1_000n) : BTC_SWAP_SAT;
  return amount > BTC_CAP_SAT ? null : amount;
}

/**
 * The smallest LTC_LADDER amount THORChain's public quote accepts for LTC to
 * BTC at the wallet's 3% price limit, as an index into the ladder.
 */
async function planLtcDeposit(lane: Lane, affiliate: { name: string; bps: number } | null): Promise<number | null> {
  const title = test.info().title;
  for (let i = 0; i < LTC_LADDER.length; i++) {
    const amount = toAtomic(LTC_LADDER[i]!, 'ltc');
    const probe = await thorQuoteProbe('LTC', 'BTC', amount, affiliate);
    lane.evidence.note(title, `planning ${LTC_LADDER[i]} LTC`, probe.ok ? 'accepted' : probe.reason);
    if (probe.ok && (probe.recommendedMinIn === null || amount >= probe.recommendedMinIn)) return i;
  }
  return null;
}

type BtcQuote = { ok: true; amount: bigint } | { ok: false; error: string; unfundable: boolean };

/**
 * Quote BTC to LTC at `amount`. When THORChain answers that it needs more
 * ("needs at least N atomic units": its minimum moved since planning), hold
 * that answer and quote again at N rounded up to 1,000 sat, if that is within
 * the cap and what the wallet can fund.
 */
async function quoteBtcToLtc(w: LiveWallet, amount: bigint, fundable: bigint | null): Promise<BtcQuote> {
  const first = await requestQuote(w, fromAtomic(amount, 'btc'));
  if (first.ok) return { ok: true, amount };
  const min = BigInt(first.error.match(/needs at least (\d+) atomic units/)?.[1] ?? '0');
  if (min === 0n) return { ok: false, error: first.error, unfundable: false };
  await w.footage.result('THORChain asked for a larger BTC deposit');
  const raised = roundUp(min, 1_000n);
  if (raised > BTC_CAP_SAT || (fundable !== null && raised > fundable)) return { ok: false, error: first.error, unfundable: true };
  const second = await requestQuote(w, fromAtomic(raised, 'btc'));
  return second.ok ? { ok: true, amount: raised } : { ok: false, error: second.error, unfundable: false };
}

/**
 * Quote LTC to BTC from the planned ladder step upwards, within what the
 * wallet can fund. Each refusal must name THORChain and is held on screen.
 */
async function quoteLtcLadder(w: LiveWallet, from: number, fundable: bigint | null): Promise<string | null> {
  for (const step of LTC_LADDER.slice(from)) {
    if (fundable !== null && toAtomic(step, 'ltc') > fundable) break;
    const attempt = await requestQuote(w, step);
    if (attempt.ok) return step;
    expect(attempt.error).toMatch(/THORChain/);
    await w.footage.result('THORChain refused this amount');
  }
  return null;
}

/**
 * Quote LTC to XMR at Trocador from the smallest ladder step upwards, within
 * what the wallet can fund with its network fee. Trocador answers "amount
 * higher than max or lower than min" below the routed exchange's minimum;
 * each refusal is held on screen.
 */
async function quoteTrocadorLadder(w: LiveWallet, ladder: readonly TrocadorStep[], fundable: bigint | null): Promise<TrocadorStep | null> {
  for (const step of ladder) {
    if (fundable !== null && step.atomic + LTC_FEE_MARGIN > fundable) break;
    const attempt = await requestQuote(w, step.text);
    if (attempt.ok) return step;
    await w.footage.result('Trocador refused this amount');
  }
  return null;
}

/** The public facts of the Trocador swap, shape-checked, into the run's evidence. */
function noteTrocador(lane: Lane, fields: Parameters<typeof trocadorEvidence>[0]): void {
  for (const [key, value] of Object.entries(trocadorEvidence(fields))) lane.evidence.note('trocador ltc-xmr swap', key, value);
}

/** Find the history row of a swap deposit and check its detail sheet. */
async function checkHistoryEntry(w: LiveWallet, from: Coin, to: Coin, txid: string): Promise<void> {
  await tabRoot(w, 'home');
  await w.footage.tap('open the coin detail', w.page.getByTestId(`asset-row-${from}`));
  const row = w.page.getByRole('button').filter({ hasText: new RegExp(`swap → ${COINS[to].ticker}`) }).first();
  await expect(row, 'the deposit appears in history as a swap').toBeVisible({ timeout: 90_000 });
  await w.footage.settled('history with the swap deposit');
  await w.footage.tap('open the history entry', row);
  const sheet = w.page.getByTestId('tx-detail-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(`${COINS[from].ticker} to ${COINS[to].ticker} via`);
  await expect(sheet).toContainText('Trade ID');
  await expect(sheet).toContainText(txid);
  const open = sheet.getByRole('button', { name: 'Open swap status' });
  await expect(open, 'the history entry carries its swap action').toBeVisible();
  await w.footage.result('history entry with its swap action');
  await w.footage.tap('open the swap status from history', open);
  await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('4/4', { timeout: 30_000 });
  await w.footage.settled('swap status opened from history');
}

/** Close and reopen the popup mid-swap: the same swap's status step comes back. */
async function checkResumeAfterReopen(w: LiveWallet, tradeId: string): Promise<void> {
  await w.reopen();
  const step = w.page.getByTestId('swap-wizard-step');
  if (!(await step.isVisible().catch(() => false))) await tabRoot(w, 'swap');
  await expect(step).toHaveText('4/4', { timeout: 60_000 });
  expect(await statusTradeId(w), 'the same swap is back').toBe(tradeId);
  await w.footage.result('swap resumed after the popup reopened');
}

/** Poll a coin's total until it rises by at least `minRise`. */
async function waitForArrival(w: LiveWallet, coin: Coin, before: bigint, minRise: bigint, timeoutMs: number): Promise<bigint> {
  let rise = 0n;
  await expect
    .poll(
      async () => {
        rise = (await readBalance(w, coin)).total - before;
        return rise;
      },
      { timeout: timeoutMs, intervals: [60_000], message: 'the swapped coins never arrived in the wallet' },
    )
    .toBeGreaterThanOrEqual(minRise);
  return rise;
}

/** Follow a THORChain swap to completion while checking the observed memo. */
async function followThorchain(
  w: LiveWallet,
  txid: string,
  budgetMs: number,
): Promise<{ final: Awaited<ReturnType<typeof followStatus>>; observed: ThorObserved | null }> {
  let observed: ThorObserved | null = null;
  const final = await w.footage.wait('THORChain swap in progress', () =>
    followStatus(w, Date.now() + budgetMs, {
      onTick: async () => {
        if (!observed) observed = await thorObservedTx(txid).catch(() => null);
      },
    }),
  );
  if (!observed) observed = await thorObservedTx(txid).catch(() => null);
  return { final, observed };
}

/** NonLogs status polls the page made to the wallet server for this swap. */
function nonlogsStatusPolls(entries: readonly RequestEntry[], tradeId: string): RequestEntry[] {
  return entries.filter((e) => {
    if (e.host !== BACKEND_HOST || e.method !== 'GET' || !e.path.includes('/swaps/nonlogs/')) return false;
    try {
      return decodeURIComponent(e.path.split('/').at(-1) ?? '') === tradeId;
    } catch {
      return false;
    }
  });
}

if (gates.registered) {
  test.describe('E-swaps live: THORChain, NonLogs, Trocador and Where to trade', () => {
    test('opening the Swap tab contacts no provider until a tap', async ({ lane }) => {
      test.setTimeout(40 * MIN);
      requireGates(lane, false);
      const w = await firstWallet(lane);
      await tabRoot(w, 'home');
      await w.footage.settled('Home before the Swap tab');
      const log = w.startRequestLog();
      try {
        await w.footage.tap('open the Swap tab', w.page.getByTestId('nav-tab-swap'));
        const card = w.page.getByTestId('swap-provider-thorchain');
        await expect(card).toBeVisible({ timeout: 30_000 });
        await w.footage.settled('Swap tab open, nothing tapped');
        await w.footage.result('no provider contacted yet');
        expect(log.hosts().filter((h) => h !== BACKEND_HOST), 'only the wallet server before any tap').toEqual([]);
        // The card says whom a tap contacts, and the tap contacts exactly that.
        await expect(card).toContainText(THOR_GATEWAY_HOST);
        const tapAt = Date.now();
        await w.footage.tap('ask THORChain whether it is live', card);
        await expect(card, 'THORChain answered the check').toContainText(/Live now|Tap to check again/, { timeout: 90_000 });
        await w.footage.result('THORChain answered after the tap');
        expect(log.hosts(tapAt).filter((h) => h !== BACKEND_HOST)).toEqual([THOR_GATEWAY_HOST]);
        expect(log.entries.filter((e) => THIRD_PARTY_SWAP_HOSTS.includes(e.host) && e.at < tapAt)).toHaveLength(0);
        lane.evidence.note('swap tab silence', 'requests before the tap', log.entries.filter((e) => e.at < tapAt).length);
      } finally {
        log.stop();
      }
    });

    test('Where to trade lists its venues and asks for prices only after its tap', async ({ lane }) => {
      test.setTimeout(30 * MIN);
      requireGates(lane, false);
      const w = await firstWallet(lane);
      await swapRoot(w);
      const panel = w.page.getByTestId('swap-where-to-trade');
      await panel.scrollIntoViewIfNeeded();
      for (const venue of ['BasicSwap', 'NonLogs', 'CEXSwap']) await expect(panel).toContainText(venue);
      const log = w.startRequestLog();
      try {
        await w.footage.settled('Where to trade panel');
        await w.footage.result('venues listed, no prices asked');
        expect(log.hosts(), 'no price lookup before the tap').not.toContain('neroswap.com');
        const tapAt = Date.now();
        await w.footage.tap('show live DEX prices', w.page.getByTestId('swap-where-to-trade-show-prices'));
        await expect(panel).toContainText(/Best DEX prices right now|Prices unavailable/, { timeout: 90_000 });
        expect(log.entries.some((e) => e.host === 'neroswap.com' && e.at >= tapAt), 'the lookup follows the tap').toBe(true);
        await expect(panel, 'live prices for at least one pair').toContainText(/(WOW-BTC|WOW-XMR|GRIN-BTC): (bid|no bid)/);
        await w.footage.result('live DEX prices after the tap');
      } finally {
        log.stop();
      }
    });

    test('THORChain BTC to LTC quote: fee lines, no affiliate line, XMR not offered', async ({ lane }) => {
      test.setTimeout(60 * MIN);
      requireGates(lane, false);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const affiliate = caps.thorchain?.affiliate ?? null;
      // THORChain's minimum moves; plan the amount from its own answer first.
      const amount = await planBtcDeposit(lane, affiliate);
      test.skip(amount === null, "THORChain's minimum for BTC to LTC is above the BTC cap (E_SWAPS_BTC_CAP_SAT)");
      const funded = await fundedWallet(lane, 'btc', amount!);
      test.skip(funded === null, 'no demo wallet holds the confirmed BTC this quote needs');
      const w = funded!.w;
      await swapRoot(w);
      const open = await openThorchain(w);
      expect(open.live, 'THORChain lists a live pair for this wallet').toBe(true);
      const tickers = liveTickers(open.card);
      expect(tickers).toEqual(expect.arrayContaining(['BTC', 'LTC']));
      if (caps.thorchain?.assets?.xmr !== 'auto') {
        // XMR is closed unless the server opens it in so many words.
        expect(tickers).not.toContain('XMR');
        expect(await hasPill(w, 'from', 'xmr')).toBe(false);
        expect(await hasPill(w, 'to', 'xmr')).toBe(false);
      }
      const available = await choosePair(w, 'btc', 'ltc');
      const quoted = await quoteBtcToLtc(w, amount!, available);
      test.skip(!quoted.ok && quoted.unfundable, "THORChain's minimum rose above the BTC cap or the wallet's balance after planning");
      expect(quoted.ok, 'THORChain quoted BTC to LTC').toBe(true);
      await w.footage.settled('THORChain quote');
      const { totalBps } = assertThorQuote(await readQuote(w), 'ltc', affiliate);
      await bringIntoView(w, 'swap-quote-notices');
      await w.footage.result('THORChain BTC to LTC quote with its fee lines');
      lane.evidence.note('thorchain btc-ltc quote', 'quoted sat', (quoted as { amount: bigint }).amount.toString());
      lane.evidence.note('thorchain btc-ltc quote', 'total fee bps', totalBps);
      await closeWizard(w);
    });

    test('THORChain LTC to BTC quote: fee lines, smallest amount THORChain accepts', async ({ lane }) => {
      test.setTimeout(60 * MIN);
      requireGates(lane, false);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const affiliate = caps.thorchain?.affiliate ?? null;
      const planned = await planLtcDeposit(lane, affiliate);
      test.skip(planned === null, "THORChain refuses every LTC amount on the ladder at the wallet's 3% price limit");
      const funded = await fundedWallet(lane, 'ltc', toAtomic(LTC_LADDER[planned!]!, 'ltc'));
      test.skip(funded === null, 'no demo wallet holds the confirmed LTC this quote needs');
      const w = funded!.w;
      await swapRoot(w);
      expect((await openThorchain(w)).live).toBe(true);
      const available = await choosePair(w, 'ltc', 'btc');
      const quoted = await quoteLtcLadder(w, planned!, available);
      expect(quoted, 'THORChain quoted an LTC amount the wallet holds').not.toBeNull();
      await w.footage.settled('THORChain quote');
      const { totalBps } = assertThorQuote(await readQuote(w), 'btc', affiliate);
      await bringIntoView(w, 'swap-quote-notices');
      await w.footage.result('THORChain LTC to BTC quote with its fee lines');
      lane.evidence.note('thorchain ltc-btc quote', 'smallest quoted LTC', quoted!);
      lane.evidence.note('thorchain ltc-btc quote', 'total fee bps', totalBps);
      await closeWizard(w);
    });

    test('NonLogs: asset list, order-book quote, slippage warning and the own-address check', async ({ lane }) => {
      test.setTimeout(75 * MIN);
      requireGates(lane, false);
      test.skip((await swapCaps()).nonlogs?.enabled !== true, 'NonLogs is not offered by this wallet server');
      // The book walk quotes XMR to WOW when both are listed; a wallet that
      // holds some XMR also gives the large-amount check something to quote.
      const w = (await fundedWallet(lane, 'xmr', toAtomic(XMR_SWAP, 'xmr') * 2n))?.w ?? (await firstWallet(lane));
      await swapRoot(w);
      const log = w.startRequestLog();
      try {
        const open = await openNonlogs(w);
        expect(open.live, 'NonLogs lists at least two coins this wallet holds').toBe(true);
        const listed = liveTickers(open.card);
        expect(listed.length).toBeGreaterThanOrEqual(2);
        for (const t of listed) expect(['BTC', 'LTC', 'XMR', 'WOW']).toContain(t);
        expect(listed, 'GRIN stays in Where to trade').not.toContain('GRIN');
        const coins = (Object.keys(COINS) as Coin[]).filter((c) => listed.includes(COINS[c].ticker));
        for (const c of coins) expect(await hasPill(w, 'from', c)).toBe(true);

        // 1. A small quote, with the order-book walk beside it.
        const [bookFrom, bookTo] = coins.includes('xmr') && coins.includes('wow') ? (['xmr', 'wow'] as const) : [coins[0]!, coins[1]!];
        const available = await choosePair(w, bookFrom, bookTo);
        const small = toAtomic({ btc: '0.0002', ltc: '0.02', xmr: XMR_SWAP, wow: '2', grin: '1' }[bookFrom], bookFrom);
        const smallAtomic = available === null || small <= available / 2n ? small : available / 4n;
        test.skip(smallAtomic === 0n, 'no demo wallet holds the coin the order-book quote sends');
        const smallText = fromAtomic(smallAtomic, bookFrom, 8);
        const first = await requestQuote(w, smallText);
        test.skip(!first.ok, 'NonLogs returned no quote for the order-book pair');
        await w.footage.settled('NonLogs quote');
        const q = await readQuote(w);
        expect(q.provider).toBe('nonlogs');
        expect(q.book, 'the order-book walk is shown beside the quote').not.toBeNull();
        expect(Number(q.book!.expected)).toBeGreaterThan(0);
        expect(q.book!.route).toMatch(/[A-Z]+-[A-Z]+/);
        expect(q.book!.route).toContain(COINS[bookTo].ticker);
        expect(q.book!.fees).toContain('0.15% taker per leg');
        expect(q.notices.some((n) => n.startsWith('Prices float until NonLogs executes'))).toBe(true);
        await bringIntoView(w, 'swap-book-analysis');
        await w.footage.result('NonLogs quote with the order-book walk');
        lane.evidence.note('nonlogs book walk', 'route', q.book!.route);

        // 2. Foreign payout or refund addresses are refused before anything is created.
        await w.footage.fill('type an address that is not this wallet', w.page.getByTestId('swap-quote-to-address'), foreign(bookTo));
        await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
        await expect.poll(() => confirmError(w), { timeout: 30_000 }).toMatch(/pay only to this wallet/);
        await w.footage.result('foreign payout address refused');
        // NonLogs quotes last two minutes; refresh before the second check.
        if ((await readQuote(w)).validForS < 70) {
          await backToPair(w);
          expect((await requestQuote(w, smallText)).ok, 'NonLogs quoted the pair again').toBe(true);
        }
        await w.footage.tap('use my own receive address', w.page.getByTestId('swap-quote-use-my-to-address'));
        await w.footage.fill('type a refund address that is not this wallet', w.page.getByTestId('swap-quote-refund-address'), foreign(bookFrom));
        await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
        await expect.poll(() => confirmError(w), { timeout: 30_000 }).toMatch(/refunds only to this wallet/);
        await w.footage.result('foreign refund address refused');
        await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('2/4');
        await backToPair(w);

        // 3. A deliberately large amount, quoted and never executed.
        const pairs: Array<[Coin, Coin]> = (
          [
            ['xmr', 'wow'],
            ['wow', 'xmr'],
            ['wow', 'btc'],
            ['btc', 'ltc'],
            ['ltc', 'btc'],
            ['ltc', 'xmr'],
          ] as Array<[Coin, Coin]>
        ).filter(([a, b]) => coins.includes(a) && coins.includes(b));
        // Only a depth or high-impact warning counts: a thin market's spread
        // alone shows "Noticeable price impact" even for a tiny order.
        let warned: string | null = null;
        let attempts = 0;
        for (const [from, to] of pairs) {
          if (attempts >= 4 || warned) break;
          const have = (await choosePair(w, from, to)) ?? 0n;
          if (have === 0n) continue; // unknown or empty: no large amount to quote
          attempts++;
          const attempt = await requestQuote(w, fromAtomic((have * 9n) / 10n, from, 8));
          if (!attempt.ok) continue;
          await w.footage.settled('NonLogs quote for a large amount');
          const big = await readQuote(w);
          if (big.book?.headline === 'exceeds_depth' || big.book?.headline === 'strong') {
            warned = big.book.headline;
            await bringIntoView(w, 'swap-book-analysis');
            await w.footage.result('slippage warning for a large amount');
          }
          await backToPair(w);
        }
        const created = log.entries.filter((e) => e.method === 'POST' && /\/swaps\/nonlogs\/?$/.test(e.path));
        expect(created, 'no NonLogs swap was created by any of these quotes').toHaveLength(0);
        await closeWizard(w);
        test.skip(warned === null, "the visible books are deeper than every balance of the chosen wallet, so no amount it can quote moves the price");
        lane.evidence.note('nonlogs slippage warning', 'kind', warned!);
      } finally {
        log.stop();
      }
    });

    test('Trocador live quote reaches the quote step and is never executed', async ({ lane }) => {
      test.setTimeout(45 * MIN);
      requireGates(lane, false);
      const w = (await fundedWallet(lane, 'xmr', toAtomic('0.01', 'xmr')))?.w ?? (await firstWallet(lane));
      await swapRoot(w);
      const log = w.startRequestLog();
      try {
        await openTrocador(w);
        const pairs: Array<[Coin, Coin, string]> = [
          ['xmr', 'btc', '0.05'],
          ['ltc', 'xmr', '0.1'],
          ['btc', 'xmr', '0.0005'],
        ];
        let reached = false;
        let anyPill = false;
        for (const [from, to, amount] of pairs) {
          if (!(await hasPill(w, 'from', from)) || !(await hasPill(w, 'to', to))) continue;
          anyPill = true;
          const have = await choosePair(w, from, to);
          const nominal = toAtomic(amount, from);
          const use = have === null || nominal <= have / 2n ? nominal : have / 2n;
          if (use === 0n) continue;
          if ((await requestQuote(w, fromAtomic(use, from, 8))).ok) {
            reached = true;
            break;
          }
        }
        test.skip(!anyPill, 'this build carries no Trocador key, so Trocador offers no pair');
        expect(reached, 'Trocador returned a live quote for at least one pair the wallet can fund').toBe(true);
        await w.footage.settled('Trocador quote');
        const q = await readQuote(w);
        expect(q.provider, 'the exchange Trocador routed to').toMatch(/\S/);
        expect(['thorchain', 'nonlogs']).not.toContain(q.provider);
        expect(Number(q.receive)).toBeGreaterThan(0);
        expect(q.validForS).toBeGreaterThan(0);
        await expect(w.page.getByTestId('swap-quote-confirm')).toHaveText(/Confirm swap/);
        await w.footage.result('Trocador live quote');
        expect(log.entries.some((e) => e.host === 'api.trocador.app' && e.path.includes('new_rate'))).toBe(true);
        expect(log.entries.filter((e) => e.path.includes('new_trade')), 'the quote was never executed').toHaveLength(0);
        await closeWizard(w);
      } finally {
        log.stop();
      }
    });

    // Build 14a74e10 builds a live card as {...card, status: 'active', blurb}
    // and keeps the card's default note, so a live THORChain card still says
    // "Not checked yet." and a live NonLogs card "Checking NonLogs…". This
    // test fails on that build by design. The owner either fixes the build or
    // accepts it by name (E_SWAPS_ACCEPT_KNOWN_ISSUES=stale-provider-note),
    // which turns this into an expected failure that is itself recorded, and
    // which fails the run again once the defect is fixed.
    test('a live provider card drops its pre-check note (known defect on 14a74e10)', async ({ lane }) => {
      test.setTimeout(30 * MIN);
      requireGates(lane, false);
      if (knownIssueAccepted('stale-provider-note')) {
        test.fail(true, 'the owner accepted the stale provider note on this build (E_SWAPS_ACCEPT_KNOWN_ISSUES)');
        lane.evidence.note(test.info().title, 'known issue accepted', 'stale-provider-note');
      }
      const caps = await swapCaps();
      const w = await firstWallet(lane);
      await swapRoot(w);
      const checked: string[] = [];
      if (caps.thorchain?.enabled !== false) {
        const thor = await thorchainCard(w);
        if (thor.live) {
          checked.push('THORChain');
          await w.footage.result('THORChain card after its check');
          expect.soft(thor.card, 'a live THORChain card no longer says it was not checked').not.toMatch(/Not checked yet/);
        }
      }
      if (caps.nonlogs?.enabled === true) {
        const nl = await nonlogsCard(w);
        if (nl.live) {
          checked.push('NonLogs');
          await bringIntoView(w, 'swap-provider-nonlogs');
          await w.footage.result('NonLogs card after its check');
          expect.soft(nl.card, 'a live NonLogs card no longer says it is checking').not.toMatch(/Checking NonLogs/);
        }
      }
      test.skip(checked.length === 0, 'no swap provider card went live, so there is no live card to check');
      lane.evidence.note(test.info().title, 'cards checked', checked.join(', '));
    });

    test('THORChain BTC to LTC: real swap, history entry, resume after reopen, LTC arrives', async ({ lane }) => {
      const LTC_ARRIVAL_MS = 45 * MIN;
      test.setTimeout(SETUP_MS + THOR_FOLLOW_MS + LTC_ARRIVAL_MS + 15 * MIN);
      requireGates(lane, true);
      const key = swapKey('thorchain', 'btc', 'ltc');
      guardInflight(lane, key);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const affiliate = caps.thorchain?.affiliate ?? null;
      const planned = await planBtcDeposit(lane, affiliate);
      test.skip(planned === null, "THORChain's minimum for BTC to LTC is above the BTC cap (E_SWAPS_BTC_CAP_SAT)");
      const funded = await fundedWallet(lane, 'btc', planned! + BTC_FEE_MARGIN_SAT);
      test.skip(funded === null, 'no demo wallet holds enough confirmed BTC for the deposit and its network fee');
      const w = funded!.w;
      const ltcBefore = await readBalance(w, 'ltc');
      const ownLtc = await readOwnAddress(w, 'ltc');

      await swapRoot(w);
      expect((await openThorchain(w)).live).toBe(true);
      await choosePair(w, 'btc', 'ltc');
      const quoted = await quoteBtcToLtc(w, planned!, funded!.balance.confirmed - BTC_FEE_MARGIN_SAT);
      test.skip(!quoted.ok && quoted.unfundable, "THORChain's minimum rose above the BTC cap or the wallet's balance after planning");
      expect(quoted.ok, 'THORChain quoted the BTC deposit').toBe(true);
      const amount = (quoted as { amount: bigint }).amount;
      await w.footage.settled('THORChain quote');
      assertThorQuote(await readQuote(w), 'ltc', affiliate);
      await bringIntoView(w, 'swap-quote-notices');
      await w.footage.result('THORChain quote before confirming');
      await w.footage.tap('use my own LTC address', w.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(w.page.getByTestId('swap-quote-to-address')).toHaveValue(ownLtc);
      await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
      await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      await expect(w.page.getByTestId('swap-deposit-memo-warning'), 'a memo deposit hides the vault and warns').toBeVisible();
      expect(toAtomic(((await w.page.getByTestId('swap-deposit-receive').textContent()) ?? '').match(/([\d.]+)/)?.[1] ?? '0', 'ltc')).toBeGreaterThan(0n);
      // Confirm re-quoted with the destination; the deposit step shows that
      // binding quote, and Send must carry exactly it.
      const deposit = await depositAmount(w, 'btc');
      expect(deposit, 'the binding quote is for the amount quoted').toBe(amount);
      await w.footage.result('deposit step with the memo warning');
      await w.footage.tap('open Send prefilled', w.page.getByTestId('swap-deposit-open-send'));
      lane.evidence.note('thorchain btc-ltc swap', 'deposit sat', deposit.toString());
      const sent = await sendPrefilled(
        w,
        'btc',
        { amount: fromAtomic(deposit, 'btc'), to: () => thorInbound('BTC') },
        inflightHooks(lane, key, w),
      );
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);

      await checkHistoryEntry(w, 'btc', 'ltc', sent.txid);
      const tradeId = await statusTradeId(w);
      expect(tradeId).toMatch(/^thorchain:/);
      await checkResumeAfterReopen(w, tradeId);

      const { final, observed } = await followThorchain(w, sent.txid, THOR_FOLLOW_MS);
      if (TERMINAL.includes(final.kind)) lane.ledger.finish(key);
      lane.evidence.note('thorchain btc-ltc swap', 'final status', final.kind);
      expect(final.kind, 'THORChain completed the swap').toBe('completed');
      expect(final.seen).not.toContain('refunded');
      expect(observed, 'THORChain observed the deposit').not.toBeNull();
      const memo = parseThorMemo(observed!.memo);
      expect(memo, 'the deposit carried a swap memo').not.toBeNull();
      expect(THOR_ASSET_CODES.ltc).toContain(memo!.asset);
      expect(memo!.destination, "the memo pays the wallet's own LTC address").toBe(ownLtc);
      expect(observed!.toAddress, 'THORChain saw it arrive at the quoted vault').toBe(sent.to);
      const got = completedAmount(final.text, 'ltc');
      expect(got, 'the completed amount').not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('thorchain btc-ltc swap', 'completed litoshi', got!.toString());

      const rise = await waitForArrival(w, 'ltc', ltcBefore.total, (got! * 99n) / 100n, LTC_ARRIVAL_MS);
      lane.evidence.note('thorchain btc-ltc swap', 'LTC rise litoshi', rise.toString());
      await swapRoot(w);
    });

    test('THORChain LTC to BTC: real swap, history entry, resume after reopen, BTC arrives', async ({ lane }) => {
      const BTC_ARRIVAL_MS = 90 * MIN;
      test.setTimeout(SETUP_MS + THOR_FOLLOW_MS + BTC_ARRIVAL_MS + 15 * MIN);
      requireGates(lane, true);
      const key = swapKey('thorchain', 'ltc', 'btc');
      guardInflight(lane, key);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const affiliate = caps.thorchain?.affiliate ?? null;
      const planned = await planLtcDeposit(lane, affiliate);
      test.skip(planned === null, "THORChain refuses every LTC amount on the ladder at the wallet's 3% price limit");
      const funded = await fundedWallet(lane, 'ltc', toAtomic(LTC_LADDER[planned!]!, 'ltc') + LTC_FEE_MARGIN);
      test.skip(funded === null, 'no demo wallet holds enough confirmed LTC for the smallest accepted amount and its network fee');
      const w = funded!.w;
      const btcBefore = await readBalance(w, 'btc');
      const ownBtc = await readOwnAddress(w, 'btc');

      await swapRoot(w);
      expect((await openThorchain(w)).live).toBe(true);
      await choosePair(w, 'ltc', 'btc');
      const amount = await quoteLtcLadder(w, planned!, funded!.balance.confirmed - LTC_FEE_MARGIN);
      test.skip(amount === null, "THORChain refused every LTC amount the chosen wallet can fund at the wallet's 3% price limit");
      await w.footage.settled('THORChain quote');
      assertThorQuote(await readQuote(w), 'btc', affiliate);
      await bringIntoView(w, 'swap-quote-notices');
      await w.footage.result('THORChain quote before confirming');
      await w.footage.tap('use my own BTC address', w.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(w.page.getByTestId('swap-quote-to-address')).toHaveValue(ownBtc);
      await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
      await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      await expect(w.page.getByTestId('swap-deposit-memo-warning')).toBeVisible();
      const deposit = await depositAmount(w, 'ltc');
      expect(deposit, 'the binding quote is for the amount quoted').toBe(toAtomic(amount!, 'ltc'));
      await w.footage.result('deposit step with the memo warning');
      await w.footage.tap('open Send prefilled', w.page.getByTestId('swap-deposit-open-send'));
      lane.evidence.note('thorchain ltc-btc swap', 'deposit LTC', fromAtomic(deposit, 'ltc'));
      const sent = await sendPrefilled(w, 'ltc', { amount: fromAtomic(deposit, 'ltc'), to: () => thorInbound('LTC') }, inflightHooks(lane, key, w));
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);

      await checkHistoryEntry(w, 'ltc', 'btc', sent.txid);
      const tradeId = await statusTradeId(w);
      expect(tradeId).toMatch(/^thorchain:/);
      await checkResumeAfterReopen(w, tradeId);

      const { final, observed } = await followThorchain(w, sent.txid, THOR_FOLLOW_MS);
      if (TERMINAL.includes(final.kind)) lane.ledger.finish(key);
      lane.evidence.note('thorchain ltc-btc swap', 'final status', final.kind);
      expect(final.kind, 'THORChain completed the swap').toBe('completed');
      expect(final.seen).not.toContain('refunded');
      expect(observed, 'THORChain observed the deposit').not.toBeNull();
      const memo = parseThorMemo(observed!.memo);
      expect(memo, 'the deposit carried a swap memo').not.toBeNull();
      expect(THOR_ASSET_CODES.btc).toContain(memo!.asset);
      expect(memo!.destination, "the memo pays the wallet's own BTC address").toBe(ownBtc);
      expect(observed!.toAddress, 'THORChain saw it arrive at the quoted vault').toBe(sent.to);
      const got = completedAmount(final.text, 'btc');
      expect(got).not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('thorchain ltc-btc swap', 'completed sat', got!.toString());
      const rise = await waitForArrival(w, 'btc', btcBefore.total, (got! * 99n) / 100n, BTC_ARRIVAL_MS);
      lane.evidence.note('thorchain ltc-btc swap', 'BTC rise sat', rise.toString());
      await swapRoot(w);
    });

    test('Trocador LTC to XMR: real swap, history entry, resume after reopen, XMR arrives', async ({ lane }) => {
      const XMR_ARRIVAL_MS = 60 * MIN;
      test.setTimeout(SETUP_MS + TROCADOR_FOLLOW_MS + XMR_ARRIVAL_MS + 15 * MIN);
      requireGates(lane, true);
      const decision = trocadorSwapRefusal(process.env);
      test.skip(decision !== null, decision ?? '');
      const key = swapKey('trocador', 'ltc', 'xmr');
      guardInflight(lane, key);
      // A malformed or over-cap plan refuses here, before any wallet is opened.
      const plan = trocadorPlan(process.env);
      const funded = await fundedWallet(lane, 'ltc', plan.ladder[0]!.atomic + LTC_FEE_MARGIN);
      test.skip(funded === null, 'no demo wallet holds enough confirmed LTC for the smallest Trocador step and its network fee');
      const w = funded!.w;
      const xmrBefore = await readBalance(w, 'xmr');
      const ownXmr = await readOwnAddress(w, 'xmr');
      const ownLtc = await readOwnAddress(w, 'ltc');

      await swapRoot(w);
      await openTrocador(w);
      test.skip(!(await hasPill(w, 'from', 'ltc')) || !(await hasPill(w, 'to', 'xmr')), 'Trocador offers no LTC to XMR pair in this build');
      const available = await choosePair(w, 'ltc', 'xmr');
      const step = await quoteTrocadorLadder(w, plan.ladder, available ?? funded!.balance.confirmed);
      test.skip(step === null, 'Trocador quoted no LTC amount on the ladder that the chosen wallet can fund within the cap');
      await w.footage.settled('Trocador quote');
      const q = await readQuote(w);
      expect(q.provider, 'the exchange Trocador routed to').toMatch(/\S/);
      expect(['thorchain', 'nonlogs']).not.toContain(q.provider);
      expect(q.receiveTicker).toBe('XMR');
      expect(toAtomic(q.receive, 'xmr'), 'a positive XMR estimate').toBeGreaterThan(0n);
      await w.footage.result('Trocador quote before confirming');
      noteTrocador(lane, { exchange: q.provider, depositLtc: step!.text });
      await w.footage.tap('use my own XMR address', w.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(w.page.getByTestId('swap-quote-to-address')).toHaveValue(ownXmr);
      await expect(w.page.getByTestId('swap-quote-refund-address'), 'refunds come back to this wallet').toHaveValue(ownLtc);
      await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
      await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      const deposit = ((await w.page.getByTestId('swap-deposit-address').textContent({ timeout: 10_000 })) ?? '').trim();
      expect(deposit, 'Trocador returned an LTC deposit address').toMatch(/^(ltc1[02-9ac-hj-np-z]{20,80}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/);
      expect(deposit, 'the deposit address is the exchange\'s, not this wallet\'s').not.toBe(ownLtc);
      const amount = await depositAmount(w, 'ltc');
      expect(amount, 'the deposit step asks for exactly the amount quoted').toBe(step!.atomic);
      const over = trocadorAmountRefusal(amount, plan.capAtomic);
      if (over) refuse(lane, over);
      await w.footage.result('Trocador deposit address');
      await w.footage.tap('open Send prefilled', w.page.getByTestId('swap-deposit-open-send'));
      const sent = await sendPrefilled(w, 'ltc', { amount: fromAtomic(amount, 'ltc'), to: async () => deposit }, inflightHooks(lane, key, w));
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);
      noteTrocador(lane, { depositTxid: sent.txid });

      await checkHistoryEntry(w, 'ltc', 'xmr', sent.txid);
      const tradeId = await statusTradeId(w);
      expect(tradeId, 'a Trocador trade id').toMatch(TROCADOR_TRADE_ID);
      noteTrocador(lane, { tradeId });
      await checkResumeAfterReopen(w, tradeId);

      const final = await w.footage.wait('Trocador swap in progress', () => followStatus(w, Date.now() + TROCADOR_FOLLOW_MS));
      if (TERMINAL.includes(final.kind)) lane.ledger.finish(key);
      noteTrocador(lane, { finalStatus: final.kind });
      expect(final.kind, 'Trocador completed the swap').toBe('completed');
      expect(final.seen).not.toContain('refunded');
      const got = completedAmount(final.text, 'xmr');
      expect(got, 'the completed amount').not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      noteTrocador(lane, { completedXmrAtomic: got!.toString() });
      const rise = await waitForArrival(w, 'xmr', xmrBefore.total, (got! * 99n) / 100n, XMR_ARRIVAL_MS);
      noteTrocador(lane, { xmrRiseAtomic: rise.toString() });
      await swapRoot(w);
    });

    test('NonLogs XMR to WOW: small real swap, status through the wallet server, resumed after reopen', async ({ lane }) => {
      const WOW_ARRIVAL_MS = 60 * MIN;
      test.setTimeout(SETUP_MS + NONLOGS_DEPOSIT_MS + NONLOGS_BUDGET_MS + WOW_ARRIVAL_MS + 15 * MIN);
      requireGates(lane, true);
      const key = swapKey('nonlogs', 'xmr', 'wow');
      guardInflight(lane, key);
      test.skip((await swapCaps()).nonlogs?.enabled !== true, 'NonLogs is not offered by this wallet server');
      const funded = await fundedWallet(lane, 'xmr', XMR_CAP + XMR_FEE_MARGIN);
      test.skip(funded === null, 'no demo wallet holds enough unlocked XMR for the swap cap and its network fee');
      const w = funded!.w;
      const wowBefore = await readBalance(w, 'wow');
      const ownWow = await readOwnAddress(w, 'wow');
      const ownXmr = await readOwnAddress(w, 'xmr');

      await swapRoot(w);
      const open = await openNonlogs(w);
      const listed = liveTickers(open.card);
      test.skip(!open.live || !listed.includes('XMR') || !listed.includes('WOW'), 'NonLogs does not list both XMR and WOW right now');
      await choosePair(w, 'xmr', 'wow');
      let amount = XMR_SWAP;
      const attempt = await requestQuote(w, amount);
      test.skip(!attempt.ok, 'NonLogs returned no quote for XMR to WOW');
      let q = await readQuote(w);
      const minimum = q.notices.map((n) => n.match(/NonLogs minimum for this pair: ([\d.]+)\./)?.[1]).find(Boolean);
      if (minimum && toAtomic(minimum, 'xmr') > toAtomic(amount, 'xmr')) {
        const min = toAtomic(minimum, 'xmr');
        test.skip(min > XMR_CAP, 'the NonLogs minimum for XMR to WOW is above the XMR cap (E_SWAPS_XMR_CAP)');
        amount = fromAtomic(roundUp(min, 10n ** 8n), 'xmr'); // up to 0.0001 XMR
        await w.footage.result('NonLogs asked for a larger XMR deposit');
        await backToPair(w);
        expect((await requestQuote(w, amount)).ok).toBe(true);
        q = await readQuote(w);
      }
      await w.footage.settled('NonLogs quote');
      expect(q.provider).toBe('nonlogs');
      expect(q.book, 'the order-book walk accompanies the quote').not.toBeNull();
      await bringIntoView(w, 'swap-book-analysis');
      await w.footage.result('NonLogs quote for the real swap');
      await w.footage.tap('use my own WOW address', w.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(w.page.getByTestId('swap-quote-to-address')).toHaveValue(ownWow);
      await expect(w.page.getByTestId('swap-quote-refund-address')).toHaveValue(ownXmr);
      await w.footage.tap('confirm the swap', w.page.getByTestId('swap-quote-confirm'));
      await expect(w.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      const deposit = ((await w.page.getByTestId('swap-deposit-address').textContent()) ?? '').trim();
      expect(deposit, 'NonLogs returned an XMR deposit address').toMatch(/^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/);
      await w.footage.result('NonLogs deposit address');
      await w.footage.tap('open Send prefilled', w.page.getByTestId('swap-deposit-open-send'));
      lane.evidence.note('nonlogs xmr-wow swap', 'deposit XMR', amount);
      const sent = await sendPrefilled(w, 'xmr', { amount, to: async () => deposit }, inflightHooks(lane, key, w));
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);

      await checkHistoryEntry(w, 'xmr', 'wow', sent.txid);
      // The private status link is shown, never opened, and never recorded
      // as text: its address is a bearer secret the canary now watches for.
      const link = w.page.getByTestId('swap-status-private-link');
      await expect(link).toBeVisible({ timeout: 60_000 });
      await expect(link).toHaveText(/Open on NonLogs/);
      const tradeId = await statusTradeId(w);
      expect(tradeId.length).toBeGreaterThan(0);
      const href = (await link.getAttribute('href')) ?? '';
      expect(href.startsWith('https://'), 'the status link is an https link').toBe(true);
      w.watchSecret(href, [tradeId]);
      await w.footage.result('status with the private link shown, not opened');

      // Status is polled through the wallet server (statusFor); the wallet
      // never talks to NonLogs itself.
      const requests: RequestEntry[] = [];
      let log = w.startRequestLog();
      let final: Awaited<ReturnType<typeof followStatus>>;
      try {
        const seen = await w.footage.wait('NonLogs waiting for the deposit', () =>
          followStatus(w, Date.now() + NONLOGS_DEPOSIT_MS, { until: (k) => k !== 'awaiting_deposit' }),
        );
        if (seen.kind === 'refunded' || seen.kind === 'failed') lane.ledger.finish(key);
        expect(seen.kind, 'NonLogs saw the deposit').not.toBe('awaiting_deposit');
        expect(['refunded', 'failed']).not.toContain(seen.kind);
        log.stop();
        requests.push(...log.entries);

        await checkResumeAfterReopen(w, tradeId);
        await expect(w.page.getByTestId('swap-status-private-link')).toBeVisible();
        log = w.startRequestLog();
        final = await w.footage.wait('NonLogs matching the order', () => followStatus(w, Date.now() + NONLOGS_BUDGET_MS));
        if (TERMINAL.includes(final.kind)) lane.ledger.finish(key);
      } finally {
        log.stop();
        requests.push(...log.entries);
      }
      lane.evidence.note('nonlogs xmr-wow swap', 'final status', final.kind);
      expect(nonlogsStatusPolls(requests, tradeId).length, 'the status step polls this swap through the wallet server').toBeGreaterThan(0);
      expect(requests.filter((e) => /(^|\.)nonlogs\.io$/.test(e.host)), 'the wallet never contacts NonLogs directly').toEqual([]);
      expect(final.kind, 'NonLogs paid out within the budget (the swap continues at NonLogs otherwise)').toBe('completed');
      // statusFor reports the payout in WOW's atomic units; status() alone would report 0.
      const got = completedAmount(final.text, 'wow');
      expect(got, 'the completed amount, reported through statusFor').not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('nonlogs xmr-wow swap', 'completed WOW atomic', got!.toString());
      const rise = await waitForArrival(w, 'wow', wowBefore.total, (got! * 99n) / 100n, WOW_ARRIVAL_MS);
      lane.evidence.note('nonlogs xmr-wow swap', 'WOW rise atomic', rise.toString());
      await swapRoot(w);
    });
  });
}
