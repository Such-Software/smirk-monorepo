/**
 * Swap-area screen operations for the live lane. Every tap and typed field
 * goes through the wallet's footage helpers, so the dead-air holds and the
 * guard apply to each one; nothing here clicks directly.
 */

import { expect, type Page } from '@playwright/test';
import type { LiveWallet } from './E-swaps-wallets.js';

export const COINS = {
  btc: { ticker: 'BTC', decimals: 8 },
  ltc: { ticker: 'LTC', decimals: 8 },
  xmr: { ticker: 'XMR', decimals: 12 },
  wow: { ticker: 'WOW', decimals: 11 },
  grin: { ticker: 'GRIN', decimals: 9 },
} as const;
export type Coin = keyof typeof COINS;

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
export async function readBalance(w: LiveWallet, coin: Coin, label: string): Promise<BalanceView> {
  await tabRoot(w, 'home');
  await w.footage.tap('open the coin detail', w.page.getByTestId(`asset-row-${coin}`));
  const balance = w.page.getByTestId('asset-detail-balance');
  await expect(balance).toBeVisible({ timeout: 30_000 });
  await w.footage.settled('coin detail loaded', { patienceMs: 90_000 });
  const main = (await balance.innerText()).match(/([\d.,]+)/)?.[1];
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
  const value = (await address.innerText()).trim();
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
      // provider; closing the view only forgets the screen.
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

/** THORChain is checked on its first tap; a second tap opens its wizard. */
export async function openThorchain(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const card = w.page.getByTestId('swap-provider-thorchain');
  if (!/Live now/.test(await card.innerText())) {
    await w.footage.tap('ask THORChain whether it is live', card);
    // Settled once it is live, or once the check failed ("… Tap to check
    // again."). The note right after the tap still reads "Tap to check
    // whether…", so the absence of "Checking" alone is not an answer.
    await expect
      .poll(async () => /Live now|Tap to check again|available in this app/.test(await card.innerText()), { timeout: 90_000 })
      .toBe(true);
  }
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  if (!/Live now/.test(text)) return { live: false, card: text };
  await w.footage.result('THORChain live pairs');
  await w.footage.tap('open the THORChain swap', card);
  await expect(wizardStep(w)).toHaveText('1/4');
  return { live: true, card: text };
}

/**
 * NonLogs lists its coins from the wallet server on mount. The card is
 * settled once it says "Live now" or gives a reason; v0.3.1 leaves its
 * initial "Checking NonLogs…" note on a live card, so that note alone does
 * not mean it is still loading.
 */
export async function openNonlogs(w: LiveWallet): Promise<{ live: boolean; card: string }> {
  const card = w.page.getByTestId('swap-provider-nonlogs');
  await expect
    .poll(async () => {
      const t = await card.innerText();
      return /Live now/.test(t) || !/Checking NonLogs/.test(t);
    }, { timeout: 90_000 })
    .toBe(true);
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  if (!/Live now/.test(text)) return { live: false, card: text };
  await w.footage.result('NonLogs asset list');
  await w.footage.tap('open the NonLogs swap', card);
  await expect(wizardStep(w)).toHaveText('1/4');
  return { live: true, card: text };
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
  const text = await rootText(w.page);
  const m = text.match(new RegExp(`(?:Available|Insufficient) — ([\\d.,]+) ${COINS[from].ticker}`));
  return m?.[1] ? toAtomic(m[1], from) : null;
}

export type QuoteAttempt = { ok: true } | { ok: false; error: string };

/** Type the amount and ask for a quote. */
export async function requestQuote(w: LiveWallet, amount: string): Promise<QuoteAttempt> {
  await w.footage.fill('type the amount to swap', w.page.getByTestId('swap-pair-amount'), amount);
  const button = w.page.getByTestId('swap-pair-get-quote');
  if (await button.isDisabled()) return { ok: false, error: 'the Get quote button is disabled (amount above the balance shown)' };
  await w.footage.tap('get a quote', button);
  await expect
    .poll(async () => ((await wizardStep(w).innerText()) === '2/4' || (await button.innerText().catch(() => '')) === 'Get quote'), {
      timeout: 120_000,
    })
    .toBe(true);
  if ((await wizardStep(w).innerText()) === '2/4') return { ok: true };
  return { ok: false, error: lineBefore(await rootText(w.page), 'Get quote') ?? 'no quote and no message' };
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
  const notices = await w.page.getByTestId('swap-quote-notices').locator('li').allInnerTexts().catch(() => [] as string[]);
  let book: BookView | null = null;
  const panel = w.page.getByTestId('swap-book-analysis');
  if (await panel.isVisible().catch(() => false)) {
    const b = await panel.innerText();
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
      expected: ((await w.page.getByTestId('swap-book-expected').innerText()).match(/([\d.]+)/)?.[1]) ?? '',
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
    fee: (await w.page.getByTestId('swap-quote-fee').innerText()).trim(),
    provider: num(/\nProvider\s+(\S+)/),
    validForS: Number(num(/Quote valid for\s+(\d+)s/) || '0'),
    notices,
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
 * On the Send compose step the swap opened: continue, read the Review
 * destination, send, and return the txid. The operation password is
 * answered in a secret scope when the owner requires it.
 */
export async function sendPrefilled(w: LiveWallet, coin: Coin, expectedAmount: string): Promise<{ txid: string; to: string }> {
  const amount = w.page.getByTestId('send-amount-input');
  await expect(amount).toBeVisible({ timeout: 60_000 });
  await w.footage.settled('send prefilled with the swap deposit');
  expect(toAtomic(await amount.inputValue(), coin), 'the Send amount is the quoted deposit').toBe(toAtomic(expectedAmount, coin));
  await w.footage.tap('continue to review', w.page.getByTestId('send-compose-continue'));
  const submit = w.page.getByTestId('send-review-submit');
  await expect(submit).toBeEnabled({ timeout: 120_000 });
  await w.footage.settled('send review');
  const review = await rootText(w.page);
  const to = review.match(/\nTo\s+(\S+)/)?.[1] ?? '';
  await w.footage.tap('send the deposit', submit);
  await w.confirmOperationPasswordIfAsked();
  const txid = w.page.getByTestId('send-done-txid');
  await expect(txid, 'the deposit never reached a txid').toBeVisible({ timeout: 240_000 });
  const value = (await txid.innerText()).trim();
  await w.footage.result('deposit broadcast');
  await w.footage.tap('close the send', w.page.getByTestId('send-done-close'));
  return { txid: value, to };
}

export type StatusKind = 'awaiting_deposit' | 'confirming' | 'exchanging' | 'completed' | 'refunded' | 'failed' | 'unknown';

/** The status step's state line, classified. */
export async function swapStatus(w: LiveWallet): Promise<{ kind: StatusKind; text: string }> {
  const text = (await w.page.getByTestId('swap-status-state').innerText({ timeout: 10_000 })).trim();
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
  const until = options.until ?? ((k: StatusKind) => k === 'completed' || k === 'refunded' || k === 'failed');
  const seen: StatusKind[] = [];
  let last: { kind: StatusKind; text: string } = { kind: 'unknown', text: '' };
  while (Date.now() < deadline) {
    last = await swapStatus(w);
    if (seen.at(-1) !== last.kind) {
      seen.push(last.kind);
      await w.footage.result(STATUS_LABEL[last.kind]);
    }
    if (until(last.kind)) break;
    await options.onTick?.();
    // The status step polls the provider every 10 s by itself; this only
    // samples what it shows. The interval is also dead air on screen.
    await w.footage.settled('waiting on the provider');
    if (!w.footage.enabled) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return { ...last, seen };
}
