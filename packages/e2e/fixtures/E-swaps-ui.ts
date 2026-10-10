/**
 * Swap-area screen operations for the live lane. Every tap and typed field
 * goes through the wallet's footage helpers, so the dead-air holds and the
 * guard apply to each one; nothing here clicks directly.
 *
 * Reading the screen: innerText applies CSS (Send's Review labels are
 * uppercased), so values are read from text nodes or test ids wherever a
 * label decides what is read. Every read is bounded; none waits for an
 * element that may already be gone.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { armQuoteWatch, quoteState, reviewRow } from './E-swaps-page.mjs';
import type { LiveWallet } from './E-swaps-wallets.js';

export const COINS = {
  btc: { ticker: 'BTC', decimals: 8 },
  ltc: { ticker: 'LTC', decimals: 8 },
  xmr: { ticker: 'XMR', decimals: 12 },
  wow: { ticker: 'WOW', decimals: 11 },
  grin: { ticker: 'GRIN', decimals: 9 },
} as const;
export type Coin = keyof typeof COINS;

/** Static footage labels for balance reads, per coin. */
const BALANCE_LABEL: Readonly<Record<Coin, string>> = {
  btc: 'BTC balance',
  ltc: 'LTC balance',
  xmr: 'XMR balance',
  wow: 'WOW balance',
  grin: 'GRIN balance',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reject when `promise` takes longer than `ms`. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the page did not answer in time')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Decimal text to atomic units, truncating extra precision. */
export function toAtomic(decimal: string, coin: Coin): bigint {
  const clean = decimal.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`not a ${COINS[coin].ticker} amount`);
  const [whole = '0', frac = ''] = clean.split('.');
  const d = COINS[coin].decimals;
  return BigInt(whole) * 10n ** BigInt(d) + BigInt((frac + '0'.repeat(d)).slice(0, d) || '0');
}

/** Atomic units to decimal text, trailing zeros trimmed, at most `places` digits. */
export function fromAtomic(atomic: bigint, coin: Coin, places: number = COINS[coin].decimals): string {
  const d = COINS[coin].decimals;
  const whole = atomic / 10n ** BigInt(d);
  const frac = (atomic % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, Math.min(places, d)).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const rootText = (page: Page) => page.locator('#root').innerText({ timeout: 10_000 });

/**
 * Scroll a result into the popup's viewport before it is held on screen: the
 * recorder captures what a user sees, not the whole page.
 */
export async function bringIntoView(w: LiveWallet, testId: string): Promise<void> {
  await w.page.getByTestId(testId).scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
}

/** Two taps on a bottom-nav tab reach its root from anywhere. */
export async function tabRoot(w: LiveWallet, tab: 'home' | 'swap'): Promise<void> {
  const nav = w.page.getByTestId(`nav-tab-${tab}`);
  await w.footage.tap(tab === 'home' ? 'open the Home tab' : 'open the Swap tab', nav);
  await w.footage.tap(tab === 'home' ? 'Home tab root' : 'Swap tab root', nav);
}

export interface BalanceView {
  confirmed: bigint;
  pending: bigint;
  locked: bigint;
  total: bigint;
}

/** Open a coin's detail screen from Home, read its balance, hold it, go back. */
export async function readBalance(w: LiveWallet, coin: Coin, label: string = BALANCE_LABEL[coin]): Promise<BalanceView> {
  await tabRoot(w, 'home');
  await w.footage.tap('open the coin detail', w.page.getByTestId(`asset-row-${coin}`));
  const balance = w.page.getByTestId('asset-detail-balance');
  await expect(balance).toBeVisible({ timeout: 30_000 });
  await w.footage.settled('coin detail loaded', { patienceMs: 90_000 });
  const main = ((await balance.textContent({ timeout: 10_000 })) ?? '').match(/([\d.,]+)/)?.[1];
  if (!main) throw new Error(`no ${COINS[coin].ticker} balance rendered (is it hidden?)`);
  const text = await rootText(w.page);
  const extra = (name: string) => {
    const m = text.match(new RegExp(`${name}:\\s*([\\d.,]+)\\s*${COINS[coin].ticker}`));
    return m?.[1] ? toAtomic(m[1], coin) : 0n;
  };
  const view = { confirmed: toAtomic(main, coin), pending: extra('Pending'), locked: extra('Locked'), total: 0n };
  view.total = view.confirmed + view.pending + view.locked;
  await w.footage.result(label);
  await w.footage.tap('back to Home', w.page.getByTestId('asset-detail-back'));
  return view;
}

/** The wallet's own receive address for a coin (public), from Receive. */
export async function readOwnAddress(w: LiveWallet, coin: Coin): Promise<string> {
  await tabRoot(w, 'home');
  await w.footage.tap('open Receive', w.page.getByTestId('home-action-receive'));
  await w.footage.tap('pick the coin to receive', w.page.getByTestId(`receive-asset-${coin}`));
  const address = w.page.getByTestId('receive-address');
  await expect(address).toBeVisible({ timeout: 60_000 });
  await expect(address).not.toHaveText(/Loading/, { timeout: 60_000 });
  const value = ((await address.textContent({ timeout: 10_000 })) ?? '').trim();
  await w.footage.settled('own receive address shown');
  await tabRoot(w, 'home');
  return value;
}

const wizardStep = (w: LiveWallet) => w.page.getByTestId('swap-wizard-step');

/** The provider list, after closing any finished or unstarted wizard. */
export async function swapRoot(w: LiveWallet): Promise<void> {
  await tabRoot(w, 'swap');
  await w.footage.settled('Swap tab');
  if (await wizardStep(w).isVisible().catch(() => false)) {
    const another = w.page.getByTestId('swap-status-start-another');
    if (await another.isVisible().catch(() => false)) {
      await w.footage.tap('start another swap', another);
    } else {
      // A swap left in flight by an earlier failure keeps running at the
      // provider; closing the view only forgets the screen. Real swaps are
      // guarded against starting again by the in-flight ledger, not by this.
      const release = w.acceptDialogs(/^Close this view\?/);
      try {
        await w.footage.tap('close the swap wizard', w.page.getByTestId('swap-wizard-cancel'));
      } finally {
        release();
      }
    }
  }
  await expect(w.page.getByTestId('swap-provider-thorchain')).toBeVisible({ timeout: 30_000 });
}

/** THORChain's card after its check: the first tap on it asks THORChain. */
export async function thorchainCard(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const card = w.page.getByTestId('swap-provider-thorchain');
  if (!/Live now/.test(await card.innerText({ timeout: 10_000 }))) {
    await w.footage.tap('ask THORChain whether it is live', card);
    // Settled once it is live, or once the check failed ("… Tap to check
    // again."). The note right after the tap still reads "Tap to check
    // whether…", so the absence of "Checking" alone is not an answer.
    await expect
      .poll(async () => /Live now|Tap to check again|available in this app/.test(await card.innerText({ timeout: 5_000 })), { timeout: 90_000 })
      .toBe(true);
  }
  const text = (await card.innerText({ timeout: 10_000 })).replace(/\s+/g, ' ');
  return { live: /Live now/.test(text), card: text };
}

/** THORChain is checked on its first tap; a second tap opens its wizard. */
export async function openThorchain(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const seen = await thorchainCard(w);
  if (!seen.live) return seen;
  await w.footage.result('THORChain live pairs');
  await w.footage.tap('open the THORChain swap', w.page.getByTestId('swap-provider-thorchain'));
  await expect(wizardStep(w)).toHaveText('1/4');
  return seen;
}

/**
 * NonLogs lists its coins from the wallet server on mount. The card is
 * settled once it says "Live now" or gives a reason; v0.3.1 leaves its
 * initial "Checking NonLogs…" note on a live card, so that note alone does
 * not mean it is still loading.
 */
export async function nonlogsCard(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const card = w.page.getByTestId('swap-provider-nonlogs');
  await expect
    .poll(async () => {
      const t = await card.innerText({ timeout: 5_000 });
      return /Live now/.test(t) || !/Checking NonLogs/.test(t);
    }, { timeout: 90_000 })
    .toBe(true);
  const text = (await card.innerText({ timeout: 10_000 })).replace(/\s+/g, ' ');
  return { live: /Live now/.test(text), card: text };
}

export async function openNonlogs(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const seen = await nonlogsCard(w);
  if (!seen.live) return seen;
  await w.footage.result('NonLogs asset list');
  await w.footage.tap('open the NonLogs swap', w.page.getByTestId('swap-provider-nonlogs'));
  await expect(wizardStep(w)).toHaveText('1/4');
  return seen;
}

export async function openTrocador(w: LiveWallet): Promise<void> {
  await w.footage.tap('open the Trocador swap', w.page.getByTestId('swap-provider-trocador'));
  await expect(wizardStep(w)).toHaveText('1/4');
}

/** Tickers a provider card lists as live, e.g. "Live now: BTC, LTC." */
export function liveTickers(card: string): string[] {
  const m = card.match(/Live now:\s*([A-Z, ]+)/);
  return m?.[1] ? m[1].split(',').map((t) => t.trim()).filter(Boolean) : [];
}

export async function hasPill(w: LiveWallet, row: 'from' | 'to', coin: Coin): Promise<boolean> {
  return (await w.page.getByTestId(`swap-pair-${row}-${COINS[coin].ticker}`).count()) > 0;
}

/** Pick the pair; returns the from-coin balance the step shows, if any. */
export async function choosePair(w: LiveWallet, from: Coin, to: Coin): Promise<bigint | null> {
  await w.footage.tap('choose the coin to send', w.page.getByTestId(`swap-pair-from-${COINS[from].ticker}`));
  await w.footage.tap('choose the coin to receive', w.page.getByTestId(`swap-pair-to-${COINS[to].ticker}`));
  await w.footage.settleIfUnheld();
  const text = await rootText(w.page);
  const m = text.match(new RegExp(`(?:Available|Insufficient) — ([\\d.,]+) ${COINS[from].ticker}`));
  return m?.[1] ? toAtomic(m[1], from) : null;
}

export type QuoteAttempt = { ok: true } | { ok: false; error: string };

/**
 * Type the amount and ask for a quote. The outcome is read from what the
 * step did after the tap (armQuoteWatch), with every read bounded: the
 * button unmounts when the quote arrives, so nothing waits on it.
 */
export async function requestQuote(w: LiveWallet, amount: string): Promise<QuoteAttempt> {
  await w.footage.fill('type the amount to swap', w.page.getByTestId('swap-pair-amount'), amount);
  const button = w.page.getByTestId('swap-pair-get-quote');
  // The step re-renders with the typed amount; once it has, the button is
  // disabled only when the amount is above the balance it shows.
  const enabled = await expect(button)
    .toBeEnabled({ timeout: 10_000 })
    .then(() => true, () => false);
  if (!enabled) return { ok: false, error: 'the Get quote button stayed disabled (amount above the balance shown)' };
  await bounded(w.page.evaluate(armQuoteWatch), 10_000);
  await w.footage.tap('get a quote', button);
  const tappedAt = Date.now();
  for (;;) {
    const s = await bounded(w.page.evaluate(quoteState), 5_000).catch(() => null);
    if (s?.step === '2/4') return { ok: true };
    // Refused: the quote started and the button is back, or it never started
    // (a check before any request) and the button stayed as it was.
    if (s && s.button === 'Get quote' && (s.started || Date.now() - tappedAt > 15_000)) {
      return { ok: false, error: s.error ?? 'no quote and no message' };
    }
    if (Date.now() - tappedAt > 120_000) throw new Error('the quote neither arrived nor failed within two minutes');
    await sleep(500);
  }
}

/** The message line rendered just above a button (step error rows). */
export function lineBefore(text: string, buttonText: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.lastIndexOf(buttonText);
  return at > 0 ? lines[at - 1]! : null;
}

export interface BookView {
  expected: string;
  impact: string;
  depth: string;
  depthTicker: string;
  route: string;
  headline: 'exceeds_depth' | 'strong' | 'notice' | 'no_market' | 'none';
  fees: string;
}

export interface QuoteView {
  send: string;
  receive: string;
  receiveTicker: string;
  fee: string;
  provider: string;
  validForS: number;
  notices: string[];
  book: BookView | null;
}

export async function readQuote(w: LiveWallet): Promise<QuoteView> {
  const text = await rootText(w.page);
  const num = (re: RegExp) => text.match(re)?.[1] ?? '';
  const notices = await w.page.getByTestId('swap-quote-notices').locator('li').allTextContents().catch(() => [] as string[]);
  let book: BookView | null = null;
  const panel = w.page.getByTestId('swap-book-analysis');
  if (await panel.isVisible().catch(() => false)) {
    const b = await panel.innerText({ timeout: 10_000 });
    const headline: BookView['headline'] = /larger than the visible order book/.test(b)
      ? 'exceeds_depth'
      : /High price impact/.test(b)
        ? 'strong'
        : /Noticeable price impact/.test(b)
          ? 'notice'
          : /No order book could be read/.test(b)
            ? 'no_market'
            : 'none';
    book = {
      expected: ((await w.page.getByTestId('swap-book-expected').textContent({ timeout: 10_000 })) ?? '').match(/([\d.]+)/)?.[1] ?? '',
      impact: b.match(/Price impact\s+(\S+)/)?.[1] ?? '',
      depth: b.match(/Book depth\s+up to ([\d.]+)/)?.[1] ?? '',
      depthTicker: b.match(/Book depth\s+up to [\d.]+ ([A-Z]+)/)?.[1] ?? '',
      route: b.match(/Route\s+(.+)/)?.[1]?.trim() ?? '',
      headline,
      fees: b.match(/Fees included: (.+)/)?.[1]?.trim() ?? '',
    };
  }
  return {
    send: num(/You send\s+([\d.,]+)/),
    receive: num(/You receive \(est\.\)\s+([\d.,]+)/),
    receiveTicker: num(/You receive \(est\.\)\s+[\d.,]+\s+([A-Z]+)/),
    fee: ((await w.page.getByTestId('swap-quote-fee').textContent({ timeout: 10_000 })) ?? '').replace(/\s+/g, ' ').trim(),
    provider: num(/\nProvider\s+(\S+)/),
    validForS: Number(num(/Quote valid for\s+(\d+)s/) || '0'),
    notices: notices.map((n) => n.replace(/\s+/g, ' ').trim()),
    book,
  };
}

/** Back from the quote to the pair step (the quote is discarded on re-quote). */
export async function backToPair(w: LiveWallet): Promise<void> {
  await w.footage.tap('back to the pair step', w.page.getByTestId('swap-wizard-back'));
  await expect(wizardStep(w)).toHaveText('1/4');
}

export async function closeWizard(w: LiveWallet): Promise<void> {
  await w.footage.tap('close the swap wizard', w.page.getByTestId('swap-wizard-cancel'));
  await expect(w.page.getByTestId('swap-provider-thorchain')).toBeVisible({ timeout: 30_000 });
}

/** The error shown above the Confirm button, after a refused confirm. */
export async function confirmError(w: LiveWallet): Promise<string | null> {
  return lineBefore(await rootText(w.page), 'Confirm swap');
}

/**
 * What Send's Review shows for a row, bounded. The label is uppercased by
 * CSS, so innerText would read "TO"; reviewRow reads text nodes.
 */
export async function reviewValue(page: Page, label: string): Promise<string | null> {
  return bounded(page.evaluate(reviewRow, label), 10_000);
}

/** The deposit the provider quoted, as Send must show it before the tap. */
export interface ExpectedDeposit {
  /** Decimal amount the Send screen must be prefilled with. */
  amount: string;
  /** The address the provider quoted, read at the moment it is compared. */
  to: () => Promise<string>;
}

/**
 * Send's done screen closes itself after 12 s unless "Stay on this screen" is
 * tapped. Tap it after the usual 6 s pre-tap hold (a reviewed auto-close tap:
 * the 12 s settle would outlast the screen). True when the screen was kept;
 * false when it had already closed, which is then the exit.
 */
async function stayOnSendResult(w: LiveWallet, done: Locator): Promise<boolean> {
  const stay = w.page.getByRole('button', { name: 'Stay on this screen', exact: true });
  try {
    await w.footage.tap('stay on the send result', stay, { timeout: 4_000, beforeAutoClose: true });
    return true;
  } catch (error) {
    if (await done.isVisible().catch(() => false)) throw error;
    w.footage.mark('the send result closed itself');
    return false;
  }
}

/**
 * On the Send compose step the swap opened: continue, check that Review shows
 * exactly the quoted deposit (asset, amount, destination) and refuse to tap
 * Send otherwise, send, and return the txid. `onSend.before` runs immediately
 * before the Send click (after every check), `onSend.after` with the txid.
 * The operation password is answered in a secret scope whenever it is asked.
 */
export async function sendPrefilled(
  w: LiveWallet,
  coin: Coin,
  expected: ExpectedDeposit,
  onSend: { before: () => void; after: (txid: string) => void },
): Promise<{ txid: string; to: string }> {
  const amount = w.page.getByTestId('send-amount-input');
  await expect(amount).toBeVisible({ timeout: 60_000 });
  await w.footage.settled('send prefilled with the swap deposit');
  expect(toAtomic(await amount.inputValue({ timeout: 10_000 }), coin), 'the Send amount is the quoted deposit').toBe(toAtomic(expected.amount, coin));
  await w.footage.tap('continue to review', w.page.getByTestId('send-compose-continue'));
  const submit = w.page.getByTestId('send-review-submit');
  await expect(submit).toBeEnabled({ timeout: 120_000 });
  await w.footage.settled('send review');

  // Nothing is broadcast unless Review names exactly what was quoted.
  const asset = await reviewValue(w.page, 'Asset');
  const reviewAmount = await reviewValue(w.page, 'Amount');
  const to = await reviewValue(w.page, 'To');
  const want = await expected.to();
  expect(asset, 'Review sends the quoted coin').toContain(`(${COINS[coin].ticker})`);
  expect(reviewAmount, 'Review shows an amount').not.toBeNull();
  expect(toAtomic(reviewAmount!, coin), 'Review sends exactly the quoted amount').toBe(toAtomic(expected.amount, coin));
  expect(to, 'Review sends to the deposit address the provider quoted').toBe(want);
  await w.footage.result('send review matches the quote');

  await w.footage.tap('send the deposit', submit, { beforeClick: onSend.before });
  const done = w.page.getByTestId('send-done-txid');
  await w.untilShownAnsweringPassword(done, 240_000);
  const txid = ((await done.textContent({ timeout: 5_000 })) ?? '').trim();
  onSend.after(txid);
  if (await stayOnSendResult(w, done)) {
    await w.footage.result('deposit broadcast');
    await w.footage.tap('close the send', w.page.getByTestId('send-done-close'));
  }
  return { txid, to: to! };
}

export type StatusKind = 'awaiting_deposit' | 'confirming' | 'exchanging' | 'completed' | 'refunded' | 'failed' | 'unknown';

/** The status step's state line, classified. */
export async function swapStatus(w: LiveWallet): Promise<{ kind: StatusKind; text: string }> {
  const text = ((await w.page.getByTestId('swap-status-state').textContent({ timeout: 10_000 })) ?? '').trim();
  const kind: StatusKind = /^Waiting for your deposit/.test(text)
    ? 'awaiting_deposit'
    : /^Deposit confirming/.test(text)
      ? 'confirming'
      : /^Provider exchanging/.test(text)
        ? 'exchanging'
        : /^Completed/.test(text)
          ? 'completed'
          : /^Refunded/.test(text)
            ? 'refunded'
            : /^Failed/.test(text)
              ? 'failed'
              : 'unknown';
  return { kind, text };
}

export const TERMINAL: readonly StatusKind[] = ['completed', 'refunded', 'failed'];

/** Static footage labels per status, for the result holds. */
export const STATUS_LABEL: Readonly<Record<StatusKind, string>> = {
  awaiting_deposit: 'swap status: waiting for the deposit',
  confirming: 'swap status: deposit confirming',
  exchanging: 'swap status: provider exchanging',
  completed: 'swap status: completed',
  refunded: 'swap status: refunded',
  failed: 'swap status: failed',
  unknown: 'swap status shown',
};

/** The trade id row on the status step. */
export async function statusTradeId(w: LiveWallet): Promise<string> {
  const text = await rootText(w.page);
  return (text.match(/Trade id\s+(\S+)/)?.[1] ?? '').replace(/↗$/, '').trim();
}

/** The amount in "Completed — 0.19 LTC sent". */
export function completedAmount(text: string, coin: Coin): bigint | null {
  const m = text.match(new RegExp(`Completed — ([\\d.,]+) ${COINS[coin].ticker} sent`));
  return m?.[1] ? toAtomic(m[1], coin) : null;
}

/**
 * Follow the status step until it is terminal or `deadline` passes, holding
 * every new state on screen. Returns the last state seen.
 */
export async function followStatus(
  w: LiveWallet,
  deadline: number,
  options: { until?: (kind: StatusKind) => boolean; onTick?: () => Promise<void> } = {},
): Promise<{ kind: StatusKind; text: string; seen: StatusKind[] }> {
  const until = options.until ?? ((k: StatusKind) => TERMINAL.includes(k));
  const seen: StatusKind[] = [];
  let last: { kind: StatusKind; text: string } = { kind: 'unknown', text: '' };
  while (Date.now() < deadline) {
    last = await swapStatus(w);
    if (seen.at(-1) !== last.kind) {
      seen.push(last.kind);
      await bringIntoView(w, 'swap-status-state');
      await w.footage.result(STATUS_LABEL[last.kind]);
    }
    if (until(last.kind)) break;
    await options.onTick?.();
    // The status step polls the provider every 10 s by itself; this only
    // samples what it shows. The interval is also dead air on screen.
    await w.footage.settled('waiting on the provider');
    if (!w.footage.enabled) await sleep(10_000);
  }
  return { ...last, seen };
}
