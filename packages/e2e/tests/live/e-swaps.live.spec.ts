/**
 * E-swaps, live: THORChain, NonLogs and Trocador swaps and the Where to trade
 * panel, driven in the release build against the configured backend with the
 * owner-approved demo wallet alice.
 *
 * Run only through its own lane (E-swaps.live.config.ts sets E2E_LANE=live);
 * the main suite does not register these tests. Each gate is explicit, see
 * fixtures/E-swaps-live.ts. A recorded run, from packages/e2e:
 *
 *   EXTENSION_DIST=<unpacked release Chrome zip> \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 \
 *   E2E_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *     npx playwright test -c E-swaps.live.config.ts
 *
 * Money moves only in the last three tests, in the smallest amounts the
 * providers accept, and only between alice's own addresses and the deposit
 * address a provider quoted. Quotes in the other tests are never executed.
 *
 * Every tap and typed field goes through `footage` (scripts/E-swaps-check-live-spec.mjs
 * enforces it): it holds the screen still first, checks the frame guard, and
 * records the hold. Results are held for the owner's 25 seconds.
 */

import { test, expect, laneGates, liveRefusal } from '../../fixtures/E-swaps-live.js';
import { BACKEND_URL } from '../../fixtures/extension.js';
import { getCapabilities } from '../../fixtures/capabilities.js';
import { FOREIGN_ADDRESS, THOR_ASSET_CODES, parseThorMemo, thorInbound, thorObservedTx, type ThorObserved } from '../../fixtures/E-swaps-providers.js';
import {
  COINS,
  backToPair,
  bringIntoView,
  choosePair,
  closeWizard,
  completedAmount,
  confirmError,
  followStatus,
  fromAtomic,
  hasPill,
  liveTickers,
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
  toAtomic,
  type Coin,
  type QuoteView,
} from '../../fixtures/E-swaps-ui.js';
import type { LiveWallet } from '../../fixtures/E-swaps-wallets.js';

const gates = laneGates();
const BACKEND_HOST = new URL(BACKEND_URL).host;
const THOR_GATEWAY_HOST = 'gateway.liquify.com';
const THIRD_PARTY_SWAP_HOSTS = [THOR_GATEWAY_HOST, 'api.trocador.app', 'neroswap.com', 'nonlogs.io'];

/** BTC to LTC deposit: 15,000 sat unless the provider minimum is higher. */
const BTC_SWAP_SAT = BigInt(process.env.E_SWAPS_BTC_SAT ?? '15000');
/** Never spend more than this on the BTC deposit, minimum or not. */
const BTC_CAP_SAT = BigInt(process.env.E_SWAPS_BTC_CAP_SAT ?? '30000');
/** Covers the BTC network fee at a busy-day rate. */
const BTC_FEE_MARGIN_SAT = 8_000n;
/**
 * LTC to BTC amounts, smallest first. THORChain refuses a quote whose fees
 * exceed the wallet's 3% price limit, and BTC's outbound fee is fixed, so
 * 0.1 LTC is often refused; the ladder finds the smallest amount it accepts.
 */
const LTC_LADDER = (process.env.E_SWAPS_LTC_LADDER ?? '0.1,0.25,0.4,0.5,0.6').split(',').map((s) => s.trim());
const LTC_FEE_MARGIN = toAtomic('0.002', 'ltc');
/** NonLogs real swap: 0.02 XMR, raised to the pair minimum up to 0.03 XMR. */
const XMR_SWAP = process.env.E_SWAPS_XMR_AMOUNT ?? '0.02';
const XMR_CAP = toAtomic(process.env.E_SWAPS_XMR_CAP ?? '0.03', 'xmr');
const XMR_FEE_MARGIN = toAtomic('0.001', 'xmr');
/** How long NonLogs may take to pay out (matching can take hours). */
const NONLOGS_BUDGET_MS = Number(process.env.E_SWAPS_NONLOGS_BUDGET_MIN ?? '180') * 60_000;

interface SwapCapabilities {
  swaps?: {
    thorchain?: { enabled?: boolean; assets?: Record<string, string>; affiliate?: { name: string; bps: number } | null };
    nonlogs?: { enabled?: boolean };
  };
}

async function swapCaps(): Promise<NonNullable<SwapCapabilities['swaps']>> {
  return ((await getCapabilities()) as unknown as SwapCapabilities).swaps ?? {};
}

/** A valid address of `coin` that is not alice's (see FOREIGN_ADDRESS). */
function foreign(coin: Coin): string {
  if (coin === 'grin') throw new Error('GRIN has no swap address');
  return FOREIGN_ADDRESS[coin];
}

/** Skip with the gate's reason when a gate is closed. */
function requireGates(needsMoney: boolean): void {
  const refusal = liveRefusal(gates, needsMoney);
  test.skip(refusal !== null, refusal ?? '');
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

/** Poll a coin's total until it rises by at least `minRise`. */
async function waitForArrival(w: LiveWallet, coin: Coin, before: bigint, minRise: bigint, timeoutMs: number): Promise<bigint> {
  let rise = 0n;
  await expect
    .poll(
      async () => {
        rise = (await readBalance(w, coin, 'balance after the swap')).total - before;
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

if (gates.registered) {
  test.describe('E-swaps live: THORChain, NonLogs, Trocador and Where to trade', () => {
    test('opening the Swap tab contacts no provider until a tap', async ({ lane }) => {
      test.setTimeout(40 * 60_000);
      requireGates(false);
      const alice = await lane.wallet('alice');
      await tabRoot(alice, 'home');
      await alice.footage.settled('Home before the Swap tab');
      const log = alice.startRequestLog();
      try {
        await alice.footage.tap('open the Swap tab', alice.page.getByTestId('nav-tab-swap'));
        const card = alice.page.getByTestId('swap-provider-thorchain');
        await expect(card).toBeVisible({ timeout: 30_000 });
        await alice.footage.settled('Swap tab open, nothing tapped');
        await alice.footage.result('no provider contacted yet');
        expect(log.hosts().filter((h) => h !== BACKEND_HOST), 'only the wallet server before any tap').toEqual([]);
        // The card says whom a tap contacts, and the tap contacts exactly that.
        await expect(card).toContainText(THOR_GATEWAY_HOST);
        const tapAt = Date.now();
        await alice.footage.tap('ask THORChain whether it is live', card);
        await expect(card, 'THORChain answered the check').toContainText(/Live now|Tap to check again/, { timeout: 90_000 });
        await alice.footage.result('THORChain answered after the tap');
        expect(log.hosts(tapAt).filter((h) => h !== BACKEND_HOST)).toEqual([THOR_GATEWAY_HOST]);
        expect(log.entries.filter((e) => THIRD_PARTY_SWAP_HOSTS.includes(e.host) && e.at < tapAt)).toHaveLength(0);
        lane.evidence.note('swap tab silence', 'requests before the tap', log.entries.filter((e) => e.at < tapAt).length);
      } finally {
        log.stop();
      }
    });

    test('Where to trade lists its venues and asks for prices only after its tap', async ({ lane }) => {
      test.setTimeout(30 * 60_000);
      requireGates(false);
      const alice = await lane.wallet('alice');
      await swapRoot(alice);
      const panel = alice.page.getByTestId('swap-where-to-trade');
      await panel.scrollIntoViewIfNeeded();
      for (const venue of ['BasicSwap', 'NonLogs', 'CEXSwap']) await expect(panel).toContainText(venue);
      const log = alice.startRequestLog();
      try {
        await alice.footage.settled('Where to trade panel');
        await alice.footage.result('venues listed, no prices asked');
        expect(log.hosts(), 'no price lookup before the tap').not.toContain('neroswap.com');
        const tapAt = Date.now();
        await alice.footage.tap('show live DEX prices', alice.page.getByTestId('swap-where-to-trade-show-prices'));
        await expect(panel).toContainText(/Best DEX prices right now|Prices unavailable/, { timeout: 90_000 });
        expect(log.entries.some((e) => e.host === 'neroswap.com' && e.at >= tapAt), 'the lookup follows the tap').toBe(true);
        await expect(panel, 'live prices for at least one pair').toContainText(/(WOW-BTC|WOW-XMR|GRIN-BTC): (bid|no bid)/);
        await alice.footage.result('live DEX prices after the tap');
      } finally {
        log.stop();
      }
    });

    test('THORChain BTC to LTC quote: fee lines, no affiliate line, XMR not offered', async ({ lane }) => {
      test.setTimeout(40 * 60_000);
      requireGates(false);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const affiliate = caps.thorchain?.affiliate ?? null;
      const alice = await lane.wallet('alice');
      await swapRoot(alice);
      const open = await openThorchain(alice);
      expect(open.live, 'THORChain lists a live pair for this wallet').toBe(true);
      // v0.3.1 keeps the card's first note under "Live now". Soft: the swap
      // checks continue, and the run still reports it.
      expect.soft(open.card, 'a live THORChain card no longer says it was not checked').not.toMatch(/Not checked yet/);
      const tickers = liveTickers(open.card);
      expect(tickers).toEqual(expect.arrayContaining(['BTC', 'LTC']));
      if (caps.thorchain?.assets?.xmr !== 'auto') {
        // XMR is closed unless the server opens it in so many words.
        expect(tickers).not.toContain('XMR');
        expect(await hasPill(alice, 'from', 'xmr')).toBe(false);
        expect(await hasPill(alice, 'to', 'xmr')).toBe(false);
      }
      // The pair step shows the balance when the wallet knows it; unknown
      // means the step does not cap the amount, so quote the nominal one.
      const available = await choosePair(alice, 'btc', 'ltc');
      test.skip(available !== null && available < 10_000n, 'alice holds under 10,000 sat of BTC, below what a THORChain quote needs');
      const amount = available === null || available >= BTC_SWAP_SAT ? BTC_SWAP_SAT : 10_000n;
      expect(await requestQuote(alice, fromAtomic(amount, 'btc')), 'THORChain quoted BTC to LTC').toEqual({ ok: true });
      await alice.footage.settled('THORChain quote');
      const { totalBps } = assertThorQuote(await readQuote(alice), 'ltc', affiliate);
      await bringIntoView(alice, 'swap-quote-notices');
      await alice.footage.result('THORChain BTC to LTC quote with its fee lines');
      lane.evidence.note('thorchain btc-ltc quote', 'total fee bps', totalBps);
      await closeWizard(alice);
    });

    test('THORChain LTC to BTC quote: fee lines, smallest amount THORChain accepts', async ({ lane }) => {
      test.setTimeout(40 * 60_000);
      requireGates(false);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const alice = await lane.wallet('alice');
      await swapRoot(alice);
      expect((await openThorchain(alice)).live).toBe(true);
      const available = await choosePair(alice, 'ltc', 'btc');
      let quoted: string | null = null;
      for (const step of LTC_LADDER) {
        if (available !== null && toAtomic(step, 'ltc') > available) break;
        const attempt = await requestQuote(alice, step);
        if (attempt.ok) {
          quoted = step;
          break;
        }
        // THORChain's refusal is shown to the user; it must name THORChain.
        expect(attempt.error).toMatch(/THORChain/);
        await alice.footage.result('THORChain refused this amount');
      }
      test.skip(quoted === null, "THORChain refused every LTC amount alice holds at the wallet's 3% price limit");
      await alice.footage.settled('THORChain quote');
      const { totalBps } = assertThorQuote(await readQuote(alice), 'btc', caps.thorchain?.affiliate ?? null);
      await bringIntoView(alice, 'swap-quote-notices');
      await alice.footage.result('THORChain LTC to BTC quote with its fee lines');
      lane.evidence.note('thorchain ltc-btc quote', 'smallest quoted LTC', quoted!);
      lane.evidence.note('thorchain ltc-btc quote', 'total fee bps', totalBps);
      await closeWizard(alice);
    });

    test('NonLogs: asset list, order-book quote, slippage warning and the own-address check', async ({ lane }) => {
      test.setTimeout(60 * 60_000);
      requireGates(false);
      test.skip((await swapCaps()).nonlogs?.enabled !== true, 'NonLogs is not offered by this wallet server');
      const alice = await lane.wallet('alice');
      await swapRoot(alice);
      const log = alice.startRequestLog();
      try {
        const open = await openNonlogs(alice);
        expect(open.live, 'NonLogs lists at least two coins this wallet holds').toBe(true);
        expect.soft(open.card, 'a live NonLogs card no longer says it is checking').not.toMatch(/Checking NonLogs/);
        const listed = liveTickers(open.card);
        expect(listed.length).toBeGreaterThanOrEqual(2);
        for (const t of listed) expect(['BTC', 'LTC', 'XMR', 'WOW']).toContain(t);
        expect(listed, 'GRIN stays in Where to trade').not.toContain('GRIN');
        const coins = (Object.keys(COINS) as Coin[]).filter((c) => listed.includes(COINS[c].ticker));
        for (const c of coins) expect(await hasPill(alice, 'from', c)).toBe(true);

        // 1. A small quote, with the order-book walk beside it.
        const [bookFrom, bookTo] = coins.includes('xmr') && coins.includes('wow') ? (['xmr', 'wow'] as const) : [coins[0]!, coins[1]!];
        const available = await choosePair(alice, bookFrom, bookTo);
        const small = toAtomic({ btc: '0.0002', ltc: '0.02', xmr: XMR_SWAP, wow: '2', grin: '1' }[bookFrom], bookFrom);
        const smallAtomic = available === null || small <= available / 2n ? small : available / 4n;
        test.skip(smallAtomic === 0n, 'alice holds none of the coin the order-book quote sends');
        const smallText = fromAtomic(smallAtomic, bookFrom, 8);
        const first = await requestQuote(alice, smallText);
        test.skip(!first.ok, 'NonLogs returned no quote for the order-book pair');
        await alice.footage.settled('NonLogs quote');
        const q = await readQuote(alice);
        expect(q.provider).toBe('nonlogs');
        expect(q.book, 'the order-book walk is shown beside the quote').not.toBeNull();
        expect(Number(q.book!.expected)).toBeGreaterThan(0);
        expect(q.book!.route).toMatch(/[A-Z]+-[A-Z]+/);
        expect(q.book!.route).toContain(COINS[bookTo].ticker);
        expect(q.book!.fees).toContain('0.15% taker per leg');
        expect(q.notices.some((n) => n.startsWith('Prices float until NonLogs executes'))).toBe(true);
        await bringIntoView(alice, 'swap-book-analysis');
        await alice.footage.result('NonLogs quote with the order-book walk');
        lane.evidence.note('nonlogs book walk', 'route', q.book!.route);

        // 2. Foreign payout or refund addresses are refused before anything is created.
        await alice.footage.fill('type an address that is not this wallet', alice.page.getByTestId('swap-quote-to-address'), foreign(bookTo));
        await alice.footage.tap('confirm the swap', alice.page.getByTestId('swap-quote-confirm'));
        await expect.poll(() => confirmError(alice), { timeout: 30_000 }).toMatch(/pay only to this wallet/);
        await alice.footage.result('foreign payout address refused');
        // NonLogs quotes last two minutes; refresh before the second check.
        if ((await readQuote(alice)).validForS < 70) {
          await backToPair(alice);
          expect((await requestQuote(alice, smallText)).ok, 'NonLogs quoted the pair again').toBe(true);
        }
        await alice.footage.tap('use my own receive address', alice.page.getByTestId('swap-quote-use-my-to-address'));
        await alice.footage.fill('type a refund address that is not this wallet', alice.page.getByTestId('swap-quote-refund-address'), foreign(bookFrom));
        await alice.footage.tap('confirm the swap', alice.page.getByTestId('swap-quote-confirm'));
        await expect.poll(() => confirmError(alice), { timeout: 30_000 }).toMatch(/refunds only to this wallet/);
        await alice.footage.result('foreign refund address refused');
        await expect(alice.page.getByTestId('swap-wizard-step')).toHaveText('2/4');
        await backToPair(alice);

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
          const have = (await choosePair(alice, from, to)) ?? 0n;
          if (have === 0n) continue; // unknown or empty: no large amount to quote
          attempts++;
          const attempt = await requestQuote(alice, fromAtomic((have * 9n) / 10n, from, 8));
          if (!attempt.ok) continue;
          await alice.footage.settled('NonLogs quote for a large amount');
          const big = await readQuote(alice);
          if (big.book?.headline === 'exceeds_depth' || big.book?.headline === 'strong') {
            warned = big.book.headline;
            await bringIntoView(alice, 'swap-book-analysis');
            await alice.footage.result('slippage warning for a large amount');
          }
          await backToPair(alice);
        }
        const created = log.entries.filter((e) => e.method === 'POST' && /\/swaps\/nonlogs\/?$/.test(e.path));
        expect(created, 'no NonLogs swap was created by any of these quotes').toHaveLength(0);
        await closeWizard(alice);
        test.skip(warned === null, 'the visible books are deeper than every balance alice holds, so no amount she can quote moves the price');
        lane.evidence.note('nonlogs slippage warning', 'kind', warned!);
      } finally {
        log.stop();
      }
    });

    test('Trocador live quote reaches the quote step and is never executed', async ({ lane }) => {
      test.setTimeout(30 * 60_000);
      requireGates(false);
      const alice = await lane.wallet('alice');
      await swapRoot(alice);
      const log = alice.startRequestLog();
      try {
        await openTrocador(alice);
        const pairs: Array<[Coin, Coin, string]> = [
          ['xmr', 'btc', '0.05'],
          ['ltc', 'xmr', '0.1'],
          ['btc', 'xmr', '0.0005'],
        ];
        let reached = false;
        let anyPill = false;
        for (const [from, to, amount] of pairs) {
          if (!(await hasPill(alice, 'from', from)) || !(await hasPill(alice, 'to', to))) continue;
          anyPill = true;
          const have = await choosePair(alice, from, to);
          const nominal = toAtomic(amount, from);
          const use = have === null || nominal <= have / 2n ? nominal : have / 2n;
          if (use === 0n) continue;
          if ((await requestQuote(alice, fromAtomic(use, from, 8))).ok) {
            reached = true;
            break;
          }
        }
        test.skip(!anyPill, 'this build carries no Trocador key, so Trocador offers no pair');
        expect(reached, 'Trocador returned a live quote for at least one pair alice can fund').toBe(true);
        await alice.footage.settled('Trocador quote');
        const q = await readQuote(alice);
        expect(q.provider, 'the exchange Trocador routed to').toMatch(/\S/);
        expect(['thorchain', 'nonlogs']).not.toContain(q.provider);
        expect(Number(q.receive)).toBeGreaterThan(0);
        expect(q.validForS).toBeGreaterThan(0);
        await expect(alice.page.getByTestId('swap-quote-confirm')).toHaveText(/Confirm swap/);
        await alice.footage.result('Trocador live quote');
        expect(log.entries.some((e) => e.host === 'api.trocador.app' && e.path.includes('new_rate'))).toBe(true);
        expect(log.entries.filter((e) => e.path.includes('new_trade')), 'the quote was never executed').toHaveLength(0);
        await closeWizard(alice);
      } finally {
        log.stop();
      }
    });

    test('THORChain BTC to LTC: real swap, history entry, resume after reopen, LTC arrives', async ({ lane }) => {
      test.setTimeout(3 * 60 * 60_000);
      requireGates(true);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const alice = await lane.wallet('alice');
      const btcBefore = await readBalance(alice, 'btc', 'BTC balance before the swap');
      test.skip(btcBefore.confirmed < BTC_SWAP_SAT + BTC_FEE_MARGIN_SAT, 'alice holds too little confirmed BTC for a 15,000 sat swap plus the network fee');
      const ltcBefore = await readBalance(alice, 'ltc', 'LTC balance before the swap');
      const ownLtc = await readOwnAddress(alice, 'ltc');

      await swapRoot(alice);
      expect((await openThorchain(alice)).live).toBe(true);
      await choosePair(alice, 'btc', 'ltc');
      let amount = BTC_SWAP_SAT;
      let attempt = await requestQuote(alice, fromAtomic(amount, 'btc'));
      if (!attempt.ok) {
        // "THORChain needs at least N atomic units of BTC for this swap."
        const min = BigInt(attempt.error.match(/needs at least (\d+) atomic units/)?.[1] ?? '0');
        test.skip(min === 0n || min > BTC_CAP_SAT || min + BTC_FEE_MARGIN_SAT > btcBefore.confirmed, 'THORChain refused the BTC deposit and its minimum is above the cap or the balance');
        amount = ((min + 999n) / 1_000n) * 1_000n;
        attempt = await requestQuote(alice, fromAtomic(amount, 'btc'));
      }
      expect(attempt, 'THORChain quoted the BTC deposit').toEqual({ ok: true });
      await alice.footage.settled('THORChain quote');
      assertThorQuote(await readQuote(alice), 'ltc', caps.thorchain?.affiliate ?? null);
      await bringIntoView(alice, 'swap-quote-notices');
      await alice.footage.result('THORChain quote before confirming');
      await alice.footage.tap('use my own LTC address', alice.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(alice.page.getByTestId('swap-quote-to-address')).toHaveValue(ownLtc);
      await alice.footage.tap('confirm the swap', alice.page.getByTestId('swap-quote-confirm'));
      await expect(alice.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      await expect(alice.page.getByTestId('swap-deposit-memo-warning'), 'a memo deposit hides the vault and warns').toBeVisible();
      expect(toAtomic((await alice.page.getByTestId('swap-deposit-receive').innerText()).match(/([\d.]+)/)?.[1] ?? '0', 'ltc')).toBeGreaterThan(0n);
      await alice.footage.result('deposit step with the memo warning');
      await alice.footage.tap('open Send prefilled', alice.page.getByTestId('swap-deposit-open-send'));
      const sent = await sendPrefilled(alice, 'btc', fromAtomic(amount, 'btc'));
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);
      expect(sent.to, "the deposit goes to THORChain's current BTC vault").toBe(await thorInbound('BTC'));
      lane.evidence.note('thorchain btc-ltc swap', 'deposit sat', amount.toString());
      lane.evidence.note('thorchain btc-ltc swap', 'deposit txid', sent.txid);

      await checkHistoryEntry(alice, 'btc', 'ltc', sent.txid);
      const tradeId = await statusTradeId(alice);
      expect(tradeId).toMatch(/^thorchain:/);

      // The popup closes and reopens mid-swap: the status step comes back.
      await alice.reopen();
      const step = alice.page.getByTestId('swap-wizard-step');
      if (!(await step.isVisible().catch(() => false))) await tabRoot(alice, 'swap');
      await expect(step).toHaveText('4/4', { timeout: 60_000 });
      expect(await statusTradeId(alice)).toBe(tradeId);
      await alice.footage.result('swap resumed after the popup reopened');

      const { final, observed } = await followThorchain(alice, sent.txid, 150 * 60_000);
      expect(final.kind, 'THORChain completed the swap').toBe('completed');
      expect(final.seen).not.toContain('refunded');
      expect(observed, 'THORChain observed the deposit').not.toBeNull();
      const memo = parseThorMemo(observed!.memo);
      expect(memo, 'the deposit carried a swap memo').not.toBeNull();
      expect(THOR_ASSET_CODES.ltc).toContain(memo!.asset);
      expect(memo!.destination, "the memo pays alice's own LTC address").toBe(ownLtc);
      expect(observed!.toAddress, 'THORChain saw it arrive at the quoted vault').toBe(sent.to);
      const got = completedAmount(final.text, 'ltc');
      expect(got, 'the completed amount').not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('thorchain btc-ltc swap', 'completed litoshi', got!.toString());

      const rise = await waitForArrival(alice, 'ltc', ltcBefore.total, (got! * 99n) / 100n, 45 * 60_000);
      lane.evidence.note('thorchain btc-ltc swap', 'LTC rise litoshi', rise.toString());
      await swapRoot(alice);
    });

    test('THORChain LTC to BTC: real swap tracked to completion', async ({ lane }) => {
      test.setTimeout(3 * 60 * 60_000);
      requireGates(true);
      const caps = await swapCaps();
      test.skip(caps.thorchain?.enabled === false, 'THORChain is turned off by this wallet server');
      const alice = await lane.wallet('alice');
      const ltcBefore = await readBalance(alice, 'ltc', 'LTC balance before the swap');
      const btcBefore = await readBalance(alice, 'btc', 'BTC balance before the swap');
      const ownBtc = await readOwnAddress(alice, 'btc');

      await swapRoot(alice);
      expect((await openThorchain(alice)).live).toBe(true);
      await choosePair(alice, 'ltc', 'btc');
      let amount: string | null = null;
      for (const step of LTC_LADDER) {
        if (toAtomic(step, 'ltc') + LTC_FEE_MARGIN > ltcBefore.confirmed) break;
        const attempt = await requestQuote(alice, step);
        if (attempt.ok) {
          amount = step;
          break;
        }
        expect(attempt.error).toMatch(/THORChain/);
        await alice.footage.result('THORChain refused this amount');
      }
      test.skip(amount === null, "THORChain refused every LTC amount alice can fund at the wallet's 3% price limit");
      await alice.footage.settled('THORChain quote');
      assertThorQuote(await readQuote(alice), 'btc', caps.thorchain?.affiliate ?? null);
      await bringIntoView(alice, 'swap-quote-notices');
      await alice.footage.result('THORChain quote before confirming');
      await alice.footage.tap('use my own BTC address', alice.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(alice.page.getByTestId('swap-quote-to-address')).toHaveValue(ownBtc);
      await alice.footage.tap('confirm the swap', alice.page.getByTestId('swap-quote-confirm'));
      await expect(alice.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      await expect(alice.page.getByTestId('swap-deposit-memo-warning')).toBeVisible();
      await alice.footage.result('deposit step with the memo warning');
      await alice.footage.tap('open Send prefilled', alice.page.getByTestId('swap-deposit-open-send'));
      const sent = await sendPrefilled(alice, 'ltc', amount!);
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);
      expect(sent.to, "the deposit goes to THORChain's current LTC vault").toBe(await thorInbound('LTC'));
      lane.evidence.note('thorchain ltc-btc swap', 'deposit LTC', amount!);
      lane.evidence.note('thorchain ltc-btc swap', 'deposit txid', sent.txid);

      await checkHistoryEntry(alice, 'ltc', 'btc', sent.txid);
      const { final, observed } = await followThorchain(alice, sent.txid, 150 * 60_000);
      expect(final.kind, 'THORChain completed the swap').toBe('completed');
      expect(observed, 'THORChain observed the deposit').not.toBeNull();
      const memo = parseThorMemo(observed!.memo);
      expect(THOR_ASSET_CODES.btc).toContain(memo?.asset);
      expect(memo?.destination, "the memo pays alice's own BTC address").toBe(ownBtc);
      expect(observed!.toAddress).toBe(sent.to);
      const got = completedAmount(final.text, 'btc');
      expect(got).not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('thorchain ltc-btc swap', 'completed sat', got!.toString());
      const rise = await waitForArrival(alice, 'btc', btcBefore.total, (got! * 99n) / 100n, 90 * 60_000);
      lane.evidence.note('thorchain ltc-btc swap', 'BTC rise sat', rise.toString());
      await swapRoot(alice);
    });

    test('NonLogs XMR to WOW: small real swap, status via statusFor, resumed after reopen', async ({ lane }) => {
      test.setTimeout(NONLOGS_BUDGET_MS + 150 * 60_000);
      requireGates(true);
      test.skip((await swapCaps()).nonlogs?.enabled !== true, 'NonLogs is not offered by this wallet server');
      const alice = await lane.wallet('alice');
      const xmrBefore = await readBalance(alice, 'xmr', 'XMR balance before the swap');
      test.skip(xmrBefore.confirmed < XMR_CAP + XMR_FEE_MARGIN, 'alice holds too little unlocked XMR for a 0.03 XMR swap plus the network fee');
      const wowBefore = await readBalance(alice, 'wow', 'WOW balance before the swap');
      const ownWow = await readOwnAddress(alice, 'wow');
      const ownXmr = await readOwnAddress(alice, 'xmr');

      await swapRoot(alice);
      const open = await openNonlogs(alice);
      const listed = liveTickers(open.card);
      test.skip(!open.live || !listed.includes('XMR') || !listed.includes('WOW'), 'NonLogs does not list both XMR and WOW right now');
      await choosePair(alice, 'xmr', 'wow');
      let amount = XMR_SWAP;
      const attempt = await requestQuote(alice, amount);
      test.skip(!attempt.ok, 'NonLogs returned no quote for XMR to WOW');
      let q = await readQuote(alice);
      const minimum = q.notices.map((n) => n.match(/NonLogs minimum for this pair: ([\d.]+)\./)?.[1]).find(Boolean);
      if (minimum && toAtomic(minimum, 'xmr') > toAtomic(amount, 'xmr')) {
        const min = toAtomic(minimum, 'xmr');
        test.skip(min > XMR_CAP, 'the NonLogs minimum for XMR to WOW is above the 0.03 XMR cap');
        const step = 10n ** 8n; // round up to 0.0001 XMR
        amount = fromAtomic(((min + step - 1n) / step) * step, 'xmr');
        await backToPair(alice);
        expect((await requestQuote(alice, amount)).ok).toBe(true);
        q = await readQuote(alice);
      }
      await alice.footage.settled('NonLogs quote');
      expect(q.provider).toBe('nonlogs');
      expect(q.book, 'the order-book walk accompanies the quote').not.toBeNull();
      await bringIntoView(alice, 'swap-book-analysis');
      await alice.footage.result('NonLogs quote for the real swap');
      await alice.footage.tap('use my own WOW address', alice.page.getByTestId('swap-quote-use-my-to-address'));
      await expect(alice.page.getByTestId('swap-quote-to-address')).toHaveValue(ownWow);
      await expect(alice.page.getByTestId('swap-quote-refund-address')).toHaveValue(ownXmr);
      await alice.footage.tap('confirm the swap', alice.page.getByTestId('swap-quote-confirm'));
      await expect(alice.page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 120_000 });
      const deposit = (await alice.page.getByTestId('swap-deposit-address').innerText()).trim();
      expect(deposit, 'NonLogs returned an XMR deposit address').toMatch(/^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/);
      await alice.footage.result('NonLogs deposit address');
      await alice.footage.tap('open Send prefilled', alice.page.getByTestId('swap-deposit-open-send'));
      const sent = await sendPrefilled(alice, 'xmr', amount);
      expect(sent.txid).toMatch(/^[0-9a-f]{64}$/i);
      expect(sent.to, 'the deposit goes to the address NonLogs quoted').toBe(deposit);
      lane.evidence.note('nonlogs xmr-wow swap', 'deposit XMR', amount);
      lane.evidence.note('nonlogs xmr-wow swap', 'deposit txid', sent.txid);

      await checkHistoryEntry(alice, 'xmr', 'wow', sent.txid);
      // The private status link is shown, never opened, and never recorded
      // as text: its address is a bearer secret the canary now watches for.
      const link = alice.page.getByTestId('swap-status-private-link');
      await expect(link).toBeVisible({ timeout: 60_000 });
      await expect(link).toHaveText(/Open on NonLogs/);
      const tradeId = await statusTradeId(alice);
      expect(tradeId.length).toBeGreaterThan(0);
      const href = (await link.getAttribute('href')) ?? '';
      expect(href.startsWith('https://'), 'the status link is an https link').toBe(true);
      alice.watchSecret(href, [tradeId]);
      await alice.footage.result('status with the private link shown, not opened');

      const seen = await alice.footage.wait('NonLogs waiting for the deposit', () =>
        followStatus(alice, Date.now() + 75 * 60_000, { until: (k) => k !== 'awaiting_deposit' }),
      );
      expect(seen.kind, 'NonLogs saw the deposit').not.toBe('awaiting_deposit');
      expect(['refunded', 'failed']).not.toContain(seen.kind);

      await alice.reopen();
      const step = alice.page.getByTestId('swap-wizard-step');
      if (!(await step.isVisible().catch(() => false))) await tabRoot(alice, 'swap');
      await expect(step).toHaveText('4/4', { timeout: 60_000 });
      expect(await statusTradeId(alice)).toBe(tradeId);
      await expect(alice.page.getByTestId('swap-status-private-link')).toBeVisible();
      await alice.footage.result('swap resumed after the popup reopened');

      const final = await alice.footage.wait('NonLogs matching the order', () => followStatus(alice, Date.now() + NONLOGS_BUDGET_MS));
      expect(final.kind, 'NonLogs paid out within the budget (the swap continues at NonLogs otherwise)').toBe('completed');
      const got = completedAmount(final.text, 'wow');
      expect(got).not.toBeNull();
      expect(got!).toBeGreaterThan(0n);
      lane.evidence.note('nonlogs xmr-wow swap', 'completed WOW atomic', got!.toString());
      const rise = await waitForArrival(alice, 'wow', wowBefore.total, (got! * 99n) / 100n, 60 * 60_000);
      lane.evidence.note('nonlogs xmr-wow swap', 'WOW rise atomic', rise.toString());
      await swapRoot(alice);
    });
  });
}
