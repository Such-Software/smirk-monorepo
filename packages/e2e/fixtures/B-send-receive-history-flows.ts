/**
 * Wallet flows for the send, receive and history live specs.
 *
 * Every interaction goes through the footage hooks (`tap`, `fill`, `settled`,
 * `result`, `secret`), never `.click` or `.fill` directly; the lint in
 * scripts/B-send-receive-history-check-live-specs.mjs holds this file and the
 * live specs to that. Every money leg goes through the AddressBook and the
 * SpendLedger (fixtures/live-send.ts), and every Review-only or refusal check
 * runs with broadcasts blocked and asserts that none were attempted.
 *
 * Reading the screen is in process and limited to public values: balances,
 * addresses, amounts, fees, statuses and transaction ids. The history sheet
 * reader skips any field whose label mentions a key, and nothing here ever
 * presses "Show transaction key".
 */

import { expect, type Locator, type Page } from '@playwright/test';
import type { LiveLane, LiveWallet } from './B-send-receive-history-wallets.js';
import {
  ASSET_DECIMALS,
  DUPLICATE_DECOY_REFUSAL,
  SPEND_CAPS,
  TICKER,
  fromAtomic,
  looksLikeReceiveAddress,
  toAtomic,
  type LiveAsset,
  type WalletName,
} from './live-send.js';
import { corrupt, withIdentitySpendKey } from './B-send-receive-history-cryptonote.js';

export const DISPLAY_NAME: Readonly<Record<LiveAsset, string>> = {
  btc: 'Bitcoin',
  ltc: 'Litecoin',
  xmr: 'Monero',
  wow: 'Wownero',
  grin: 'Grin',
};

/** Pause between polls while waiting on the chain. Held static on video. */
export const POLL_MS = 90_000;
/** Ceiling for one wait on confirmations or spendable funds. */
export const CHAIN_WAIT_MS: Readonly<Record<LiveAsset, number>> = {
  btc: 150 * 60_000,
  ltc: 60 * 60_000,
  xmr: 75 * 60_000,
  wow: 75 * 60_000,
  grin: 60 * 60_000,
};

const USD_TEXT = /^(≈ \$[\d,]+\.\d{2} USD|Less than \$0\.01 USD)$/;
const TXID = /^[0-9a-f]{64}$/;
const KERNEL = /^0[89][0-9a-f]{64}$/;

export function truncId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-6)}`;
}

/** Two header readings, each truncated to 8 shown decimals, differ by less than this. */
export function headerTolerance(asset: LiveAsset): bigint {
  const d = ASSET_DECIMALS[asset];
  return d > 8 ? 2n * 10n ** BigInt(d - 8) : 0n;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Prices (public endpoint), so the USD checks know which coins are priced.
// ---------------------------------------------------------------------------

let priced: Set<string> | null = null;

export async function pricedAssets(lane: LiveLane): Promise<Set<string>> {
  if (priced) return priced;
  try {
    const res = await fetch(`${lane.backendUrl.replace(/\/$/, '')}/prices`, { signal: AbortSignal.timeout(20_000) });
    const body = res.ok ? ((await res.json()) as { prices?: Record<string, number> }) : {};
    priced = new Set(
      Object.entries(body.prices ?? {})
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k]) => k.toLowerCase()),
    );
  } catch {
    priced = new Set();
  }
  return priced;
}

// ---------------------------------------------------------------------------
// Navigation and reading
// ---------------------------------------------------------------------------

export async function checkHomeHealth(w: LiveWallet): Promise<void> {
  const total = ((await w.page.getByTestId('home-total-balance').textContent()) ?? '').trim();
  expect(total, 'the Home fiat total resolved to a figure').toMatch(/\d/);
  const cue = w.page.getByTestId('balance-freshness-cue');
  if (await cue.count()) {
    const level = (await cue.first().getAttribute('data-freshness')) ?? 'fresh';
    expect(['fresh', 'updating'], 'the freshness cue stayed fresh').toContain(level);
  }
}

/**
 * Reach a tab's root screen. A tab tap may paint the root first and then
 * restore the tab's last sub-screen, so the root counts only once the route
 * has stayed put; tapping the active tab again returns it to its root.
 */
async function tabRoot(w: LiveWallet, tab: 'home' | 'inbox' | 'settings', root: Locator, label: string): Promise<void> {
  await w.unlockIfLocked();
  const nav = w.page.getByTestId(`nav-tab-${tab}`);
  for (let i = 0; i < 3; i++) {
    await w.footage.tap(nav, i === 0 ? label : 'Same tab again, back to its root');
    await w.page.waitForTimeout(1_500); // lint-allow: poll
    if (await root.isVisible().catch(() => false)) {
      await w.page.waitForTimeout(700); // lint-allow: poll
      if (await root.isVisible().catch(() => false)) return;
    }
  }
  await expect(root, `the ${tab} tab reached its root`).toBeVisible({ timeout: 30_000 });
}

export async function goHome(w: LiveWallet): Promise<void> {
  const total = w.page.getByTestId('home-total-balance');
  await tabRoot(w, 'home', total, 'Home tab');
  await w.footage.settled('Home');
  await checkHomeHealth(w);
}

export interface CoinHeader {
  confirmed: bigint;
  pending: bigint;
  locked: bigint;
  usd: string | null;
}

export function headerTotal(h: CoinHeader): bigint {
  return h.confirmed + h.pending + h.locked;
}

export async function readCoinHeader(w: LiveWallet, asset: LiveAsset): Promise<CoinHeader> {
  const balance = w.page.getByTestId('asset-detail-balance');
  const ticker = TICKER[asset];
  const main = (await balance.innerText()).replace(/\s+/g, ' ').trim();
  const m = new RegExp(`^([\\d.]+) ${ticker}$`).exec(main);
  if (!m) throw new Error(`the ${ticker} balance is not shown as a number (hidden balances must be off)`);
  const block = (await balance.locator('xpath=..').innerText()).replace(/\s+/g, ' ');
  const pending = new RegExp(`Pending: ([\\d.]+) ${ticker}`).exec(block);
  const locked = new RegExp(`Locked: ([\\d.]+) ${ticker}`).exec(block);
  const usd = /(≈ \$[\d,]+\.\d{2} USD|Less than \$0\.01 USD)/.exec(block);
  return {
    confirmed: toAtomic(asset, m[1]!),
    pending: pending ? toAtomic(asset, pending[1]!) : 0n,
    locked: locked ? toAtomic(asset, locked[1]!) : 0n,
    usd: usd ? usd[1]! : null,
  };
}

/** Open a coin's screen from Home, wait for its activity, and check its USD line. */
export async function openCoin(lane: LiveLane, w: LiveWallet, asset: LiveAsset): Promise<CoinHeader> {
  await goHome(w);
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), `${TICKER[asset]} row`);
  await expect(w.page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 60_000 });
  await w.footage.settled('Coin screen with activity');
  const header = await readCoinHeader(w, asset);
  if ((await pricedAssets(lane)).has(asset) && headerTotal(header) > 0n) {
    expect(header.usd, `${TICKER[asset]} header shows its USD value`).toMatch(USD_TEXT);
  }
  return header;
}

/** Back out of the coin screen to Home. */
export async function leaveCoin(w: LiveWallet): Promise<void> {
  await w.footage.tap(w.page.getByTestId('asset-detail-back'), 'Back to Home');
  await expect(w.page.getByTestId('home-total-balance')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Receive and identity
// ---------------------------------------------------------------------------

/**
 * Read a receive address off the wallet's own Receive screen and allowlist it.
 * `via: 'home'` uses Home's asset picker; `via: 'coin'` uses the coin screen's
 * Receive, which must skip the picker.
 */
export async function readReceiveAddress(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  via: 'home' | 'coin',
): Promise<string> {
  const page = w.page;
  if (via === 'home') {
    await goHome(w);
    await w.footage.tap(page.getByTestId('home-action-receive'), 'Receive');
    await expect(page.locator('#root')).toContainText('Choose asset', { timeout: 15_000 });
    await w.footage.settled('Choose asset');
    await w.footage.tap(page.getByTestId(`receive-asset-${asset}`), `Receive ${TICKER[asset]}`);
  } else {
    await openCoin(lane, w, asset);
    await w.footage.tap(page.locator('button', { hasText: /^↙\s*Receive$/ }), 'Receive from the coin screen');
    await expect(page.locator('[data-testid^="receive-asset-"]')).toHaveCount(0);
  }
  const shown = page.getByTestId('receive-address');
  await expect(shown).toBeVisible({ timeout: 60_000 });
  await expect(shown).not.toHaveText('Loading address…', { timeout: 60_000 });
  const address = (await shown.innerText()).trim();
  expect(looksLikeReceiveAddress(asset, address), `${w.name}'s ${TICKER[asset]} receive address has the right shape`).toBe(true);
  await expect(page.getByTestId('receive-copy-btn')).toBeVisible();
  lane.book.register(w.name, asset, address);
  await w.footage.result('Receive address');
  lane.progress(`${w.name}: ${TICKER[asset]} receive address read (${truncId(address)}) via ${via}`);
  return address;
}

/** The wallet's active npub, from Settings, allowlisted as its Grin recipient. */
export async function readNpub(lane: LiveLane, w: LiveWallet): Promise<string> {
  const page = w.page;
  lane.progress(`${w.name}: reading the npub`);
  const navItem = page.getByTestId('settings-nostr-nav');
  // Settings root carries recovery and password controls; the guard blanks it.
  await tabRoot(w, 'settings', navItem, 'Settings tab');
  await w.footage.tap(navItem, 'Nostr identity');
  await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 30_000 });
  const npub = page.getByTestId('nostr-npub');
  await expect(npub).toContainText(/npub1[02-9ac-hj-np-z]{58}/, { timeout: 30_000 });
  const value = (await npub.innerText()).trim();
  lane.book.register(w.name, 'grin', value, 'npub');
  await w.footage.result('Nostr npub');
  lane.progress(`${w.name}: npub read (${truncId(value)})`);
  await goHome(w);
  return value;
}

/** Make sure the book holds what a set of legs needs, reading anything missing. */
export async function ensureDestinations(lane: LiveLane, asset: LiveAsset, wallets: readonly WalletName[]): Promise<void> {
  for (const name of wallets) {
    if (!lane.book.has(name, asset)) await readReceiveAddress(lane, lane.wallets[name], asset, 'home');
  }
}

// ---------------------------------------------------------------------------
// History detail
// ---------------------------------------------------------------------------

export type DetailFields = Record<string, string>;

export interface Detail {
  title: string;
  fields: DetailFields;
  hasExplorer: boolean;
  hasRevealKey: boolean;
  keyShown: boolean;
}

/** Find a history row by its copyable identifier (txid, kernel, slate, or a pending send's recipient). */
function rowFor(page: Page, id: string, label: 'transaction ID' | 'kernel ID' | 'slate ID' | 'recipient address'): Locator {
  return page
    .getByRole('button', { name: `Copy ${label}` })
    .filter({ hasText: new RegExp(`^${escapeRe(truncId(id))}$`) })
    .first()
    .locator('xpath=ancestor::button[1]');
}

async function readDetail(page: Page): Promise<Detail> {
  const sheet = page.getByTestId('tx-detail-sheet');
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  const read = await sheet.evaluate((el) => {
    const fields: Record<string, string> = {};
    for (const pair of Array.from(el.querySelectorAll('dl > div'))) {
      const dt = pair.querySelector('dt')?.textContent?.trim() ?? '';
      // Never read anything a key label names, even if a reveal happened elsewhere.
      if (!dt || /key/i.test(dt)) continue;
      fields[dt] = pair.querySelector('dd > span')?.textContent?.trim() ?? '';
    }
    return { title: el.querySelector('strong')?.textContent?.trim() ?? '', fields };
  });
  return {
    ...read,
    hasExplorer: (await page.getByTestId('tx-detail-explorer').count()) > 0,
    hasRevealKey: (await page.getByTestId('tx-detail-reveal-key').count()) > 0,
    keyShown: (await page.getByTestId('tx-detail-tx-key').count()) > 0,
  };
}

export interface RowRef {
  txid?: string;
  kernel?: string;
  /** A pending send's recipient: its row shows the address, not the txid. */
  recipient?: string;
  /** Grin rows on the receiving side: the newest incoming row with this amount. */
  grinIncomingAmount?: string;
}

/** Locate the row on the open coin screen, or null when it is not listed yet. */
async function findRow(w: LiveWallet, ref: RowRef): Promise<Locator | null> {
  const page = w.page;
  const candidates: Locator[] = [];
  if (ref.txid) candidates.push(rowFor(page, ref.txid, 'transaction ID'));
  if (ref.kernel) candidates.push(rowFor(page, ref.kernel, 'kernel ID'));
  if (ref.recipient) candidates.push(rowFor(page, ref.recipient, 'recipient address'));
  if (ref.grinIncomingAmount) {
    candidates.push(
      page
        .locator('button')
        .filter({ hasText: new RegExp(`^↙\\+ ${escapeRe(ref.grinIncomingAmount)} GRIN`) })
        .first(),
    );
  }
  for (const c of candidates) if (await c.count()) return c;
  return null;
}

/** Open the detail sheet for a row on the open coin screen and read it. */
export async function openDetail(w: LiveWallet, ref: RowRef, label = 'Open the transaction'): Promise<Detail | null> {
  const row = await findRow(w, ref);
  if (!row) return null;
  // Tap the row's arrow, clear of its copy control.
  await w.footage.tap(row, label, { position: { x: 14, y: 14 } });
  await w.footage.settled('Transaction detail');
  const detail = await readDetail(w.page);
  expect(detail.keyShown, 'the transaction key is never shown').toBe(false);
  return detail;
}

export async function closeDetail(w: LiveWallet): Promise<void> {
  await w.footage.tap(w.page.getByTestId('tx-detail-close'), 'Close the detail');
  await expect(w.page.getByTestId('tx-detail-sheet')).toHaveCount(0);
}

/** Confirmations a Status line states: 0 in the mempool, N when counted, null for a bare block. */
export function confirmationsOf(status: string | undefined): number | null {
  if (!status) return 0;
  if (/Unconfirmed|Broadcast, waiting|^pending$|^signed$/i.test(status)) return 0;
  const n = /^(\d+) confirmations? /.exec(status);
  if (n) return Number(n[1]);
  if (/^Block #\d+$/.test(status) || /^(finalized|confirmed)$/i.test(status)) return null;
  return 0;
}

function meetsConfirmations(status: string | undefined, min: number): boolean {
  const c = confirmationsOf(status);
  return c === null ? min <= 1 || /^confirmed$/i.test(status ?? '') : c >= min;
}

/** Check a send's detail on the sender's side. Returns the fee it reports. */
export function expectSenderDetail(
  asset: LiveAsset,
  d: Detail,
  sent: { amountAtomic: bigint; txid?: string; destination?: string },
): bigint | undefined {
  const ticker = TICKER[asset];
  const amountOf = (text: string | undefined): bigint | undefined => {
    const m = text === undefined ? null : new RegExp(`^([\\d.]+) ${ticker}$`).exec(text);
    return m ? toAtomic(asset, m[1]!) : undefined;
  };
  expect(d.fields.Direction, 'sender sees Sent').toBe('Sent');
  expect(d.fields.Time, 'sender sees a time').toBeTruthy();
  expect(d.fields.Status, 'sender sees a status').toBeTruthy();
  if (sent.txid && asset !== 'grin') expect(d.fields['Transaction ID'], 'sender sees the txid').toBe(sent.txid);
  if (sent.destination && asset !== 'grin') expect(d.fields['Sent to'], 'sender sees the recipient').toBe(sent.destination);
  expect(d.hasExplorer, 'the explorer action is offered').toBe(true);
  let fee: bigint | undefined;
  if (d.fields['Network fee'] !== undefined) {
    fee = amountOf(d.fields['Network fee']);
    expect(fee, 'the fee is an amount').toBeDefined();
    expect(fee! > 0n && fee! <= SPEND_CAPS[asset].feeCap, 'the fee is positive and under the cap').toBe(true);
  }
  // A pending send shows what was sent. Once the chain reports it, a UTXO or
  // CryptoNote row is netted against its change, so it reads as what left the
  // wallet: the amount plus the fee. Either is right; anything else is not.
  const shown = amountOf(d.fields.Amount);
  expect(shown, 'sender sees an amount').toBeDefined();
  const ok = shown === sent.amountAtomic || (fee !== undefined && asset !== 'grin' && shown === sent.amountAtomic + fee);
  expect(ok, 'the amount is what was sent, or that plus the fee once netted').toBe(true);
  return fee;
}

/** Check a payment's detail on the recipient's side. */
export function expectRecipientDetail(asset: LiveAsset, d: Detail, sent: { amountAtomic: bigint; txid?: string }): void {
  expect(d.fields.Direction, 'recipient sees Received').toBe('Received');
  expect(d.fields.Amount, 'recipient sees the amount').toBe(`${fromAtomic(asset, sent.amountAtomic, 12)} ${TICKER[asset]}`);
  expect(d.fields['Sent to'], 'a receive names no recipient').toBeUndefined();
  if (sent.txid && asset !== 'grin') expect(d.fields['Transaction ID'], 'recipient sees the txid').toBe(sent.txid);
  expect(d.hasRevealKey, 'a receive offers no transaction key').toBe(false);
}

/** For a chain row of an XMR or WOW send: the key is offered masked, and never revealed. */
export function expectMaskedTxKey(asset: LiveAsset, d: Detail): void {
  if (asset !== 'xmr' && asset !== 'wow') return;
  expect(d.hasRevealKey, 'the Show transaction key action is offered').toBe(true);
  expect(d.keyShown, 'the key itself stays hidden').toBe(false);
}

/**
 * Tap the explorer action and check the opened page names the transaction.
 * The explorer hosts are answered locally (see the wallets fixture), so no
 * identifier leaves the machine.
 */
export async function checkExplorer(w: LiveWallet, id: string): Promise<void> {
  const opened = w.context.waitForEvent('page', { timeout: 30_000 });
  await w.footage.tap(w.page.getByTestId('tx-detail-explorer'), 'View in block explorer');
  const tab = await opened;
  await tab.waitForURL(/^https:\/\//, { timeout: 30_000 });
  expect(tab.url(), 'the explorer link names this transaction').toContain(id);
  const tabFootage = w.footageFor(tab, 'explorer');
  await tabFootage.settled('Explorer link, answered locally');
  await tab.close();
  await w.page.bringToFront();
}

/**
 * Poll a row until its Status meets `min` confirmations, holding the detail on
 * screen for 25 s at every reading so the rise is on video.
 */
export async function waitConfirmations(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  ref: RowRef,
  min: number,
  what: string,
): Promise<Detail> {
  const deadline = Date.now() + CHAIN_WAIT_MS[asset];
  let last: string | undefined;
  for (;;) {
    await openCoin(lane, w, asset);
    const d = await openDetail(w, ref, 'Open the transaction for its status');
    if (d) {
      const status = d.fields.Status;
      if (status !== last) lane.progress(`${w.name}: ${TICKER[asset]} ${what}: status ${status ?? '(none)'}`);
      last = status;
      await w.footage.result('Confirmations');
      await closeDetail(w);
      if (meetsConfirmations(status, min)) return d;
    }
    if (Date.now() > deadline) throw new Error(`${TICKER[asset]} ${what} did not reach ${min} confirmation(s) in time`);
    await w.footage.hold(POLL_MS, 'Waiting for the next block');
  }
}

/** Poll until the wallet can spend `need` of `asset`. */
export async function waitSpendable(lane: LiveLane, w: LiveWallet, asset: LiveAsset, need: bigint): Promise<CoinHeader> {
  const deadline = Date.now() + CHAIN_WAIT_MS[asset];
  for (;;) {
    const h = await openCoin(lane, w, asset);
    if (h.confirmed >= need) return h;
    if (Date.now() > deadline) {
      throw new Error(`${w.name} never had ${fromAtomic(asset, need)} ${TICKER[asset]} spendable`);
    }
    lane.progress(`${w.name}: waiting for ${fromAtomic(asset, need)} ${TICKER[asset]} spendable, have ${fromAtomic(asset, h.confirmed)}`);
    await w.footage.hold(POLL_MS, 'Waiting for spendable funds');
  }
}

// ---------------------------------------------------------------------------
// The Send wizard
// ---------------------------------------------------------------------------

/** Send from the coin screen must open at destination entry, not the asset picker. */
export async function openSendFromCoin(w: LiveWallet): Promise<void> {
  const page = w.page;
  await w.footage.tap(page.locator('button', { hasText: /^↗\s*Send$/ }), 'Send from the coin screen');
  await expect(page.getByTestId('send-address-input')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="send-asset-"]')).toHaveCount(0);
  await expect(page.getByText(/Step 2 \/ 4/)).toBeVisible();
  await w.footage.settled('Send opens at the destination');
}

async function enterDestination(w: LiveWallet, destination: string): Promise<void> {
  await w.footage.fill(w.page.getByTestId('send-address-input'), destination, 'Destination');
  await w.footage.tap(w.page.getByTestId('send-address-continue'), 'Continue');
  await expect(w.page.getByTestId('send-amount-input')).toBeVisible({ timeout: 30_000 });
  await w.footage.settled('Send: compose');
}

/** Leave the Send wizard without sending, from any step. */
export async function exitSendWizard(w: LiveWallet): Promise<void> {
  const back = w.page.getByTestId('send-wizard-header-back');
  for (let i = 0; i < 5 && (await back.isVisible().catch(() => false)); i++) {
    await w.footage.tap(back, 'Back out of Send');
  }
  await expect(back).toHaveCount(0, { timeout: 15_000 });
}

/** Parse the fee-tier rates and check them against each other and the relay floor. */
async function feeTour(w: LiveWallet): Promise<void> {
  const page = w.page;
  const rates: Record<string, number> = {};
  for (const tier of ['fast', 'slow', 'normal'] as const) {
    const row = page.getByTestId(`send-fee-tier-${tier}`);
    await w.footage.tap(row, `Fee tier ${tier}`);
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    const m = /([\d.]+) sat\/vB · (\d+) sat/.exec(await row.innerText());
    expect(m, `the ${tier} tier shows a rate and a fee`).not.toBeNull();
    rates[tier] = Number(m![1]);
    await w.footage.settled('Fee tier selected');
  }
  expect(rates.fast! >= rates.normal! && rates.normal! >= rates.slow!, 'fast >= normal >= slow').toBe(true);
  expect(rates.slow! >= 1.1, 'no tier below the relay floor').toBe(true);
  // A custom rate under the relay floor is raised, and the wallet says so.
  await w.footage.fill(page.getByTestId('send-custom-fee-rate-input'), '0.5', 'Custom fee rate below the floor');
  const floored = page.getByTestId('send-custom-fee-floored');
  await expect(floored).toBeVisible({ timeout: 10_000 });
  await expect(floored).toContainText('1.1 sat/vB');
  await w.footage.result('Custom rate raised to the relay floor');
  await w.footage.tap(page.getByTestId('send-fee-tier-normal'), 'Back to the normal tier');
  await expect(page.getByTestId('send-fee-tier-normal')).toHaveAttribute('aria-pressed', 'true');
  await expect(floored).toHaveCount(0);
}

async function compose(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  amount: string,
  header: CoinHeader,
  opts: { feeTour?: boolean; beforeContinue?: () => void },
): Promise<void> {
  const page = w.page;
  const ticker = TICKER[asset];
  const line = new RegExp(`Balance:\\s*([\\d.]+)\\s*${ticker}`).exec((await page.locator('#root').innerText()).replace(/\s+/g, ' '));
  expect(line, 'Compose shows the balance').not.toBeNull();
  const composeBalance = toAtomic(asset, line![1]!);
  expect(composeBalance >= toAtomic(asset, amount), 'Compose shows enough spendable balance').toBe(true);
  if (composeBalance !== header.confirmed) {
    // A background refresh can land between the two readings; note it rather than fail on timing.
    lane.progress(`${w.name}: ${ticker} Compose balance differs from the coin screen reading taken moments earlier`);
  }
  if (asset === 'btc' || asset === 'ltc') {
    const normal = page.getByTestId('send-fee-tier-normal');
    await expect(normal).toContainText(/sat\/vB/, { timeout: 60_000 });
    if (opts.feeTour) await feeTour(w);
    if ((await normal.getAttribute('aria-pressed')) !== 'true') await w.footage.tap(normal, 'Normal fee tier');
  }
  await w.footage.fill(page.getByTestId('send-amount-input'), amount, 'Amount');
  if ((await pricedAssets(lane)).has(asset)) {
    await expect(page.getByTestId('send-amount-usd'), 'USD on the amount').toHaveText(USD_TEXT, { timeout: 15_000 });
  }
  const cont = page.getByTestId('send-compose-continue');
  await expect(cont).toBeEnabled({ timeout: 60_000 });
  await w.footage.settled('Amount with its USD value');
  opts.beforeContinue?.();
  await w.footage.tap(cont, asset === 'grin' ? 'Continue to slatepack' : 'Continue to review');
}

async function readReviewRows(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const div of Array.from(document.querySelectorAll('#root div'))) {
      const kids = Array.from(div.children);
      if (kids.length !== 2 || kids.some((k) => k.tagName !== 'SPAN')) continue;
      const label = kids[0]!.textContent?.trim() ?? '';
      if (/^(Asset|Amount|To|Fee tier|Network fee)$/.test(label)) out[label] = kids[1]!.textContent?.trim() ?? '';
    }
    return out;
  });
}

async function review(lane: LiveLane, w: LiveWallet, asset: LiveAsset, amountAtomic: bigint, destination: string): Promise<void> {
  const page = w.page;
  const ticker = TICKER[asset];
  await expect(page.getByTestId('send-review-submit')).toBeVisible({ timeout: 30_000 });
  if (asset === 'xmr' || asset === 'wow') {
    await expect(page.locator('#root')).not.toContainText('Estimating…', { timeout: 30_000 });
  }
  const rows = await readReviewRows(page);
  expect(rows.Asset, 'Review names the coin').toBe(`${DISPLAY_NAME[asset]} (${ticker})`);
  expect(rows.Amount, 'Review shows the amount').toBe(fromAtomic(asset, amountAtomic, 8));
  expect(rows.To, 'Review shows the full destination').toBe(destination);
  if (asset === 'btc' || asset === 'ltc') {
    expect(rows['Fee tier'], 'Review shows the tier and its rate').toMatch(/^normal \([\d.]+ sat\/vB\)$/);
  } else {
    const fee = new RegExp(`^~([\\d.]+) ${ticker}$`).exec(rows['Network fee'] ?? '');
    expect(fee, 'Review shows a fee estimate').not.toBeNull();
    const est = toAtomic(asset, fee![1]!);
    expect(est > 0n && est <= SPEND_CAPS[asset].feeCap, 'the fee estimate is under the cap').toBe(true);
  }
  if ((await pricedAssets(lane)).has(asset)) {
    await expect(page.getByTestId('send-review-usd'), 'USD on Review').toHaveText(USD_TEXT);
  }
  await expect(page.getByTestId('send-review-submit')).toHaveText(/^Send 🔓$/);
  await w.footage.result('Review before sending');
}

type SendOutcome = { kind: 'done'; txid: string } | { kind: 'error'; message: string };

/** Wait for the Done step or a refusal on Review, answering a password prompt if the policy asks. */
async function waitSendOutcome(w: LiveWallet, timeoutMs = 240_000): Promise<SendOutcome> {
  const page = w.page;
  const done = page.getByTestId('send-done-txid');
  const submit = page.getByTestId('send-review-submit');
  const error = page.locator('[style*="smirk-negative"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done.isVisible().catch(() => false)) return { kind: 'done', txid: ((await done.textContent()) ?? '').trim() };
    if (await page.getByTestId('operation-password').isVisible().catch(() => false)) {
      await w.answerPasswordPrompt();
      continue;
    }
    const busy = /Sending…|Broadcasting…/.test((await submit.textContent().catch(() => '')) ?? '');
    if (!busy && (await error.count()) > 0 && (await error.last().isVisible().catch(() => false))) {
      return { kind: 'error', message: ((await error.last().textContent()) ?? '').trim() };
    }
    await page.waitForTimeout(1_000); // lint-allow: poll
  }
  throw new Error('the send neither finished nor reported an error in time');
}

/** Hold the Done step (stopping its countdown), then close it. Returns the id it shows. */
async function holdDone(w: LiveWallet, idLabel: 'Transaction ID' | 'Kernel ID'): Promise<string> {
  const page = w.page;
  const id = ((await page.getByTestId('send-done-txid').textContent()) ?? '').trim();
  await expect(page.locator('#root')).toContainText(idLabel);
  const stay = page.getByRole('button', { name: 'Stay on this screen' });
  if (await stay.isVisible().catch(() => false)) await w.footage.tap(stay, 'Stay on the receipt');
  await w.footage.result('Sent: the receipt with its id');
  await w.footage.tap(page.getByTestId('send-done-close'), 'Done');
  return id;
}

export interface SendLeg {
  /** Stable ledger id; a re-run resumes a leg that already broadcast. */
  id: string;
  asset: Exclude<LiveAsset, 'grin'>;
  from: WalletName;
  to: WalletName;
  amount: string;
  /** BTC: walk every fee tier and the custom floor before sending at Normal. */
  feeTour?: boolean;
}

export interface SentLeg {
  id: string;
  asset: LiveAsset;
  from: WalletName;
  to: WalletName;
  amountAtomic: bigint;
  destination: string;
  txid: string;
  feeAtomic?: bigint;
  firstStatus?: string;
  resumed: boolean;
  /** Totals before the leg, for the balance checks once it confirms. */
  senderBefore?: bigint;
  recipientBefore?: bigint;
}

/**
 * One on-chain leg, start to finish: from the coin screen through Review to a
 * broadcast, then the sender's pending row and detail. Allowlist and caps are
 * enforced by the ledger before the Send tap. A duplicate-decoy refusal is
 * retried once, and only when the monitor proves nothing was broadcast.
 */
export async function sendLeg(lane: LiveLane, leg: SendLeg): Promise<SentLeg> {
  const sender = lane.wallets[leg.from];
  const ticker = TICKER[leg.asset];
  const destination = lane.book.get(leg.to, leg.asset);
  const amountAtomic = toAtomic(leg.asset, leg.amount);
  const prior = lane.ledger.completed(leg.id);
  if (prior?.txid) {
    lane.progress(`${leg.id}: resuming, already broadcast as ${prior.txid}`);
    return {
      id: leg.id,
      asset: leg.asset,
      from: leg.from,
      to: leg.to,
      amountAtomic,
      destination,
      txid: prior.txid,
      ...(prior.feeAtomic ? { feeAtomic: BigInt(prior.feeAtomic) } : {}),
      ...(prior.firstStatus ? { firstStatus: prior.firstStatus } : {}),
      resumed: true,
    };
  }

  const recipientBefore = headerTotal(await openCoin(lane, lane.wallets[leg.to], leg.asset));
  const header = await waitSpendable(lane, sender, leg.asset, amountAtomic + SPEND_CAPS[leg.asset].feeCap);
  sender.footage.mark(`${TICKER[leg.asset]} send`);
  await openSendFromCoin(sender);
  await enterDestination(sender, destination);
  await compose(lane, sender, leg.asset, leg.amount, header, { feeTour: leg.feeTour ?? false });
  await review(lane, sender, leg.asset, amountAtomic, destination);

  lane.ledger.reserve({ legId: leg.id, asset: leg.asset, from: leg.from, destination, amountAtomic });
  lane.progress(`${leg.id}: reserved ${leg.amount} ${ticker} ${leg.from} to ${leg.to}`);
  let txid = '';
  for (let attempt = 0; attempt < 2 && !txid; attempt++) {
    const mark = sender.broadcasts.mark();
    await sender.footage.tap(sender.page.getByTestId('send-review-submit'), attempt ? 'Send again after a refused ring' : 'Send');
    const outcome = await waitSendOutcome(sender);
    if (outcome.kind === 'done') {
      txid = outcome.txid;
      break;
    }
    const broadcasted = sender.broadcasts.since(mark);
    const decoyRefusal = (leg.asset === 'xmr' || leg.asset === 'wow') && DUPLICATE_DECOY_REFUSAL.test(outcome.message);
    if (attempt === 0 && broadcasted === 0 && decoyRefusal) {
      lane.progress(`${leg.id}: ring assembly refused before any broadcast; retrying once`);
      await sender.footage.result('Ring refused, nothing broadcast');
      continue;
    }
    if (broadcasted === 0) lane.ledger.refuse(leg.id, decoyRefusal ? 'duplicate decoys twice' : 'refused before broadcast');
    lane.progress(`${leg.id}: send refused (${broadcasted} broadcast attempts)`);
    throw new Error(`${ticker} ${leg.from} to ${leg.to} was refused${broadcasted ? ' after a broadcast attempt; check the chain' : ''}`);
  }
  expect(txid, 'the receipt shows a transaction id').toMatch(TXID);
  lane.ledger.broadcast(leg.id, { txid });
  lane.progress(`${leg.id}: broadcast ${txid}`);
  await holdDone(sender, 'Transaction ID');

  // The sender's own activity shows the payment at once, with its recipient.
  await openCoin(lane, sender, leg.asset);
  const d = (await openDetail(sender, { txid })) ?? (await openDetail(sender, { recipient: destination }));
  expect(d, 'the sender sees the payment in activity right away').not.toBeNull();
  const fee = expectSenderDetail(leg.asset, d!, { amountAtomic, destination, ...(d!.fields['Transaction ID'] ? { txid } : {}) });
  await sender.footage.result('Sent payment in the history sheet');
  await closeDetail(sender);
  lane.ledger.annotate(leg.id, {
    ...(d!.fields.Status ? { firstStatus: d!.fields.Status } : {}),
    ...(fee !== undefined ? { feeAtomic: fee.toString() } : {}),
  });
  return {
    id: leg.id,
    asset: leg.asset,
    from: leg.from,
    to: leg.to,
    amountAtomic,
    destination,
    txid,
    ...(fee !== undefined ? { feeAtomic: fee } : {}),
    ...(d!.fields.Status ? { firstStatus: d!.fields.Status } : {}),
    resumed: false,
    senderBefore: headerTotal(header),
    recipientBefore,
  };
}

/** The recipient sees the payment arrive: a pending or locked amount and an incoming row. */
export async function expectIncoming(lane: LiveLane, sent: SentLeg): Promise<Detail> {
  const w = lane.wallets[sent.to];
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const header = await openCoin(lane, w, sent.asset);
    const d = await openDetail(w, { txid: sent.txid }, 'Open the incoming payment');
    if (d) {
      expectRecipientDetail(sent.asset, d, { amountAtomic: sent.amountAtomic, txid: sent.txid });
      const unconfirmed = confirmationsOf(d.fields.Status) === 0;
      // Balances refresh on their own cadence, so the header may trail the
      // activity list by a cycle: an unconfirmed payment must show as pending
      // or locked once it catches up.
      const shown = header.pending + header.locked >= sent.amountAtomic;
      await w.footage.result('Incoming payment, pending');
      await closeDetail(w);
      if (!unconfirmed || shown) {
        lane.progress(`${sent.id}: ${sent.to} sees the payment (${d.fields.Status ?? 'no status'}${shown ? ', pending in the header' : ''})`);
        return d;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`${sent.to} never saw the ${TICKER[sent.asset]} payment as an incoming row with a pending amount`);
    }
    await w.footage.hold(60_000, 'Waiting for the payment to appear');
  }
}

/**
 * After a leg confirms, both totals moved by the right amounts: the recipient
 * gained exactly the amount, the sender lost the amount plus the fee.
 */
export async function expectSettledBalances(lane: LiveLane, sent: SentLeg): Promise<void> {
  if (sent.senderBefore === undefined || sent.recipientBefore === undefined) return;
  const tol = headerTolerance(sent.asset);
  const deadline = Date.now() + CHAIN_WAIT_MS[sent.asset];
  for (;;) {
    const r = headerTotal(await openCoin(lane, lane.wallets[sent.to], sent.asset));
    const s = headerTotal(await openCoin(lane, lane.wallets[sent.from], sent.asset));
    const gained = r - sent.recipientBefore;
    const spent = sent.senderBefore - s;
    const fee = sent.feeAtomic ?? 0n;
    const recipientOk = gained >= sent.amountAtomic - tol && gained <= sent.amountAtomic + tol;
    const senderOk = spent >= sent.amountAtomic + fee - tol && spent <= sent.amountAtomic + SPEND_CAPS[sent.asset].feeCap + tol;
    if (recipientOk && senderOk) {
      await lane.wallets[sent.from].footage.result('Sender balance after the payment');
      lane.progress(`${sent.id}: balances settled`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${sent.id}: balances did not settle (recipient ${recipientOk ? 'ok' : 'off'}, sender ${senderOk ? 'ok' : 'off'})`);
    }
    await lane.wallets[sent.from].footage.hold(POLL_MS, 'Waiting for balances to settle');
  }
}

/** Every planned leg must be fundable from balances now plus earlier legs' payments. */
export async function fundingShortfall(
  lane: LiveLane,
  asset: LiveAsset,
  legs: ReadonlyArray<{ id: string; from: WalletName; to: WalletName; amount: string }>,
): Promise<string | null> {
  const fee = SPEND_CAPS[asset].feeCap;
  const have = new Map<WalletName, bigint>();
  for (const name of ['alice', 'bob', 'carol'] as const) {
    have.set(name, headerTotal(await openCoin(lane, lane.wallets[name], asset)));
  }
  for (const leg of legs) {
    if (lane.ledger.completed(leg.id)) continue;
    const need = toAtomic(asset, leg.amount) + fee;
    const balance = have.get(leg.from)!;
    if (balance < need) {
      return `${leg.from} holds ${fromAtomic(asset, balance)} ${TICKER[asset]} but leg ${leg.id} needs ${fromAtomic(asset, need)} with the fee cap; fund the demo wallet`;
    }
    have.set(leg.from, balance - need);
    have.set(leg.to, have.get(leg.to)! + toAtomic(asset, leg.amount));
  }
  return null;
}

/** Outgoing chain rows on the open coin screen, by their truncated txid. */
export async function outgoingRowIds(w: LiveWallet): Promise<Set<string>> {
  const ids = await w.page.evaluate(() =>
    Array.from(document.querySelectorAll('button[aria-label="Copy transaction ID"]'))
      .map((b) => ({ id: b.textContent?.trim() ?? '', row: b.parentElement?.closest('button')?.textContent ?? '' }))
      .filter((r) => r.row.includes('−'))
      .map((r) => r.id),
  );
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Review-only and refusal checks (broadcasts blocked)
// ---------------------------------------------------------------------------

/** Max on a small balance: the sweep note, a Review that says Max, and nothing sent. */
export async function maxReviewOnly(lane: LiveLane, w: LiveWallet, asset: Exclude<LiveAsset, 'grin'>, to: WalletName): Promise<void> {
  const page = w.page;
  const destination = lane.book.get(to, asset);
  const header = await openCoin(lane, w, asset);
  expect(header.confirmed > 0n, `${w.name} has spendable ${TICKER[asset]} for the Max check`).toBe(true);
  const { attempted } = await w.broadcasts.blocking(async () => {
    await openSendFromCoin(w);
    await enterDestination(w, destination);
    if (asset === 'btc' || asset === 'ltc') {
      await expect(page.getByTestId('send-fee-tier-normal')).toContainText(/sat\/vB/, { timeout: 60_000 });
    }
    const max = page.getByTestId('send-max-button');
    await w.footage.tap(max, 'Max');
    await expect(max).toHaveAttribute('aria-pressed', 'true');
    const amount = page.getByTestId('send-amount-input');
    await expect(amount).toBeDisabled();
    if (asset === 'btc' || asset === 'ltc') {
      // The shell cannot count the inputs a sweep spends, so Compose says the
      // amount is approximate rather than promising a number.
      await expect(page.getByTestId('send-sweep-approx-note')).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.locator('#root')).toContainText('Network fee (est.)', { timeout: 60_000 });
    }
    await expect(amount).toHaveValue(/^\d+(\.\d+)?$/, { timeout: 30_000 });
    const swept = toAtomic(asset, await amount.inputValue());
    expect(swept > 0n && swept < header.confirmed, 'Max offers the balance less the fee').toBe(true);
    await w.footage.result('Max amount and the sweep note');
    await w.footage.tap(page.getByTestId('send-compose-continue'), 'Continue to review');
    const rows = await readReviewRows(page);
    expect(rows.Amount, 'Review calls it a sweep').toBe('Max (sweeps balance)');
    await expect(page.getByTestId('send-review-submit')).toHaveText(/Send Max/);
    await expect(page.locator('#root')).toContainText('Max estimate; the final network fee may change.');
    await w.footage.result('Max on Review, never sent');
    await exitSendWizard(w);
  });
  expect(attempted, 'a Review-only check broadcasts nothing').toBe(0);
  lane.progress(`${w.name}: ${TICKER[asset]} Max reached Review, nothing broadcast`);
}

/**
 * A destination the wallet must refuse. `malformed` breaks the checksum, so the
 * Address step refuses. `unusable-key` keeps the checksum but swaps in the
 * identity point as the spend key, so only the signer can refuse; Send is
 * pressed with broadcasts blocked and the refusal must come before any
 * broadcast attempt.
 */
export async function refusedDestination(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  kind: 'malformed' | 'unusable-key',
  source: WalletName,
): Promise<void> {
  const page = w.page;
  const good = lane.book.get(source, asset);
  const bad = kind === 'malformed' ? corrupt(good) : withIdentitySpendKey(good);
  await openCoin(lane, w, asset);
  const { attempted } = await w.broadcasts.blocking(async () => {
    await openSendFromCoin(w);
    await w.footage.fill(page.getByTestId('send-address-input'), bad, 'A destination the wallet must refuse');
    await w.footage.tap(page.getByTestId('send-address-continue'), 'Continue');
    if (kind === 'malformed') {
      await expect(page.locator('#root')).toContainText(new RegExp(`Not a valid ${TICKER[asset]} address`), { timeout: 15_000 });
      await expect(page.getByTestId('send-amount-input')).toHaveCount(0);
      await w.footage.result('Malformed address refused');
    } else {
      // Well-formed, so the Address step accepts it; the signer must not.
      await expect(page.getByTestId('send-amount-input')).toBeVisible({ timeout: 30_000 });
      await w.footage.settled('Send: compose');
      const small = asset === 'xmr' ? '0.0001' : '0.01';
      await w.footage.fill(page.getByTestId('send-amount-input'), small, 'A small amount');
      await w.footage.tap(page.getByTestId('send-compose-continue'), 'Continue to review');
      await expect(page.locator('#root')).not.toContainText('Estimating…', { timeout: 30_000 });
      await w.footage.settled('Review');
      await w.footage.tap(page.getByTestId('send-review-submit'), 'Send to an unusable key');
      const outcome = await waitSendOutcome(w);
      expect(outcome.kind, 'the wallet refused the unusable key').toBe('error');
      expect(outcome.kind === 'error' ? outcome.message : '', 'the refusal names the key').toMatch(/invalid public key/i);
      await w.footage.result('Unusable key refused before signing');
    }
    await exitSendWizard(w);
  });
  expect(attempted, 'nothing was broadcast').toBe(0);
  lane.progress(`${w.name}: ${TICKER[asset]} ${kind} destination refused, nothing broadcast`);
}

// ---------------------------------------------------------------------------
// Grin
// ---------------------------------------------------------------------------

/** x-only pubkey hex from an npub (bech32 data part, no checksum check: the input came from the wallet). */
export function npubToHex(npub: string): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = npub.slice(5, -6).split('').map((c) => CHARSET.indexOf(c));
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out.slice(0, 32).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function inboxRows(w: LiveWallet, section: 'To sign' | 'To finalize'): Promise<Locator> {
  return w.page.locator('section').filter({ has: w.page.getByText(section, { exact: true }) });
}

/** Snapshot the slate prefixes listed under an Inbox section. */
async function inboxSlates(w: LiveWallet, section: 'To sign' | 'To finalize'): Promise<Set<string>> {
  const sec = await inboxRows(w, section);
  const text = (await sec.count()) ? await sec.first().innerText() : '';
  return new Set([...text.matchAll(/slate ([0-9a-f]{8})…/g)].map((m) => m[1]!));
}

async function openInbox(w: LiveWallet): Promise<void> {
  await tabRoot(w, 'inbox', w.page.getByTestId('inbox-tab'), 'Inbox tab');
  await w.footage.settled('Inbox');
}

/**
 * Wait for a new row under an Inbox section with this amount, then tap its
 * action (Sign or Finalize). Returns the row's slate prefix.
 */
async function actOnInbox(
  lane: LiveLane,
  w: LiveWallet,
  section: 'To sign' | 'To finalize',
  amount: string,
  before: Set<string>,
): Promise<string> {
  const deadline = Date.now() + 20 * 60_000;
  const action = section === 'To sign' ? 'Sign' : 'Finalize';
  for (;;) {
    await openInbox(w);
    const sec = (await inboxRows(w, section)).first();
    // Each row: [main button][actions: ActionButton(action), cancel]. Walk the
    // action buttons and read their row, two divs up.
    const buttons = sec.getByRole('button', { name: new RegExp(`${action}$`) });
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const button = buttons.nth(i);
      const text = (await button.locator('xpath=ancestor::div[2]').innerText()).replace(/\s+/g, ' ').trim();
      const slate = /slate ([0-9a-f]{8})…/.exec(text)?.[1];
      if (slate && !before.has(slate) && text.startsWith(`${amount} GRIN`)) {
        await w.footage.result(section === 'To sign' ? 'Grin payment waiting to sign' : 'Grin reply waiting to finalize');
        await w.footage.tap(button, action);
        lane.progress(`${w.name}: ${section} row ${slate} acted on`);
        return slate;
      }
    }
    if (Date.now() > deadline) throw new Error(`${w.name} never received the Grin ${section === 'To sign' ? 'payment' : 'reply'} in the Inbox`);
    await w.footage.tap(w.page.getByRole('button', { name: 'Refresh', exact: true }), 'Refresh the Inbox');
    await w.footage.hold(30_000, 'Waiting for the Grin exchange');
  }
}

/** Receiver side of an Inbox-delivered slate: the wallet signs and replies on its own. */
async function signIncoming(w: LiveWallet, amountAtomic: bigint): Promise<void> {
  const page = w.page;
  await expect(page.locator('#root')).toContainText('Reply slatepack ready', { timeout: 120_000 });
  await w.footage.result('Signed reply ready');
  await w.footage.tap(page.getByRole('button', { name: 'Done', exact: true }), 'Done');
  await expect(page.locator('#root')).toContainText('Signed and replied', { timeout: 30_000 });
  await expect(page.locator('#root')).toContainText(`amount: ${amountAtomic} nanogrin`);
  await w.footage.result('Signed and replied');
  await w.footage.tap(page.getByRole('button', { name: 'Done', exact: true }), 'Done');
}

export interface GrinLeg {
  id: string;
  from: WalletName;
  to: WalletName;
  amount: string;
  /** npub: the Nostr gift wrap; address: the recipient's grin1 address; pasted: slatepack by hand. */
  via: 'npub' | 'address' | 'pasted';
}

export interface GrinSent {
  id: string;
  from: WalletName;
  to: WalletName;
  amountAtomic: bigint;
  kernel: string;
  feeAtomic?: bigint;
  resumed: boolean;
  senderBefore?: bigint;
  recipientConfirmedBefore?: bigint;
}

/** Grin targets one block a minute and shows no per-payment confirmation count. */
export const GRIN_BLOCK_MS = 60_000;

/**
 * Compose a Grin send and build its slate. The ledger reservation is made
 * immediately before "Continue to slatepack", the tap that builds the slate,
 * locks its inputs and (over a channel) delivers it.
 */
async function grinCompose(
  lane: LiveLane,
  sender: LiveWallet,
  leg: GrinLeg,
  amountAtomic: bigint,
  destination: string,
): Promise<bigint | undefined> {
  const page = sender.page;
  const header = await waitSpendable(lane, sender, 'grin', amountAtomic + SPEND_CAPS.grin.feeCap);
  sender.footage.mark('GRIN send');
  await openSendFromCoin(sender);
  if (leg.via === 'pasted') {
    await sender.footage.tap(page.getByRole('button', { name: 'Slatepack only', exact: true }), 'Slatepack only');
    await sender.footage.tap(page.getByTestId('send-address-continue'), 'Continue');
    await expect(page.getByTestId('send-amount-input')).toBeVisible({ timeout: 30_000 });
    await sender.footage.settled('Send: compose');
  } else {
    await enterDestination(sender, destination);
  }
  await compose(lane, sender, 'grin', leg.amount, header, {
    beforeContinue: () => {
      lane.ledger.reserve({ legId: leg.id, asset: 'grin', from: leg.from, destination, amountAtomic });
      lane.progress(`${leg.id}: reserved ${leg.amount} GRIN ${leg.from} to ${leg.to} via ${leg.via}`);
    },
  });
  // The slate is built (and, over a channel, delivered) on arrival here.
  const shared = page.locator('#root').getByText('Share slatepack', { exact: true });
  const failed = page.locator('#root').getByText("Couldn't build slate", { exact: true });
  await expect(shared.or(failed)).toBeVisible({ timeout: 180_000 });
  if (await failed.isVisible().catch(() => false)) {
    lane.ledger.refuse(leg.id, 'slate build refused');
    throw new Error(`the ${leg.id} Grin slate could not be built`);
  }
  const summary = (await page.locator('#root').innerText()).replace(/\s+/g, ' ');
  const fee = /Network fee ([\d.]+) Total deducted/.exec(summary);
  const feeAtomic = fee ? toAtomic('grin', fee[1]!) : undefined;
  if (feeAtomic !== undefined) expect(feeAtomic <= SPEND_CAPS.grin.feeCap, 'the Grin fee is under the cap').toBe(true);
  if (leg.via !== 'pasted') {
    await expect(page.locator('#root'), 'the slate went out over a channel').toContainText('relay posted', { timeout: 30_000 });
  }
  await sender.footage.result('Slatepack built and shared');
  return feeAtomic;
}

/** Finalize from the Exchange step (S2 already in the box) and hold the receipt. */
async function grinFinalize(lane: LiveLane, sender: LiveWallet, leg: GrinLeg): Promise<string> {
  const page = sender.page;
  const finalize = page.getByRole('button', { name: 'Finalize & broadcast', exact: true });
  await expect(finalize).toBeEnabled({ timeout: 60_000 });
  const mark = sender.broadcasts.mark();
  await sender.footage.tap(finalize, 'Finalize and broadcast');
  const done = page.getByTestId('send-done-txid');
  await expect(done).toBeVisible({ timeout: 180_000 });
  expect(sender.broadcasts.since(mark), 'finalize reached the broadcast endpoint').toBeGreaterThanOrEqual(1);
  await expect(page.locator('#root')).toContainText('Broadcast');
  const kernel = await holdDone(sender, 'Kernel ID');
  expect(kernel, 'the receipt shows a kernel').toMatch(KERNEL);
  lane.ledger.broadcast(leg.id, { kernel });
  lane.progress(`${leg.id}: finalized, kernel ${kernel}`);
  return kernel;
}

/**
 * A Grin payment end to end. `npub` and `address` legs travel through the
 * recipient's Inbox (To sign) and back to the sender's (To finalize). The
 * `pasted` leg hands the slatepack across by hand: the harness copies it from
 * the sender's screen into the recipient's Paste screen, and the reply back.
 */
export async function grinLeg(lane: LiveLane, leg: GrinLeg): Promise<GrinSent> {
  const sender = lane.wallets[leg.from];
  const recipient = lane.wallets[leg.to];
  const amountAtomic = toAtomic('grin', leg.amount);
  const prior = lane.ledger.completed(leg.id);
  if (prior?.kernel) {
    lane.progress(`${leg.id}: resuming, already finalized`);
    return { id: leg.id, from: leg.from, to: leg.to, amountAtomic, kernel: prior.kernel, resumed: true };
  }
  const recipientConfirmedBefore = (await openCoin(lane, recipient, 'grin')).confirmed;
  const senderBefore = headerTotal(await openCoin(lane, sender, 'grin'));
  let toSignBefore = new Set<string>();
  let toFinalizeBefore = new Set<string>();
  if (leg.via !== 'pasted') {
    await openInbox(recipient);
    toSignBefore = await inboxSlates(recipient, 'To sign');
    await openInbox(sender);
    toFinalizeBefore = await inboxSlates(sender, 'To finalize');
  }

  // The allowlist gate holds for Grin too: the pasted leg names the wallet the
  // harness hands the slatepack to.
  const destination = lane.book.get(leg.to, 'grin', leg.via === 'npub' ? 'npub' : 'address');
  await openCoin(lane, sender, 'grin');
  const feeAtomic = await grinCompose(lane, sender, leg, amountAtomic, destination);

  if (leg.via === 'pasted') {
    // In process only: the S1 is read from the sender's page and typed into the
    // recipient's Paste screen; the reply goes back the same way.
    const s1 = ((await sender.page.locator('details button').first().textContent()) ?? '').trim();
    expect(s1.startsWith('BEGINSLATEPACK'), 'the sender shows a slatepack').toBe(true);
    await openInbox(recipient);
    await recipient.footage.tap(recipient.page.getByTestId('inbox-paste-slatepack-btn'), 'Paste a slatepack');
    await recipient.footage.settled('Paste screen');
    await recipient.footage.fill(recipient.page.getByTestId('paste-dispatch-input'), s1, 'The pasted slatepack');
    await recipient.footage.tap(recipient.page.getByTestId('paste-dispatch-submit'), 'Continue');
    await expect(recipient.page.locator('#root')).toContainText('Reply slatepack ready', { timeout: 120_000 });
    const s2 = ((await recipient.page.locator('button').filter({ hasText: /^BEGINSLATEPACK/ }).first().textContent()) ?? '').trim();
    expect(s2.startsWith('BEGINSLATEPACK') && s2 !== s1, 'the recipient produced a reply').toBe(true);
    await signIncoming(recipient, amountAtomic);
    await sender.footage.fill(sender.page.locator('textarea[placeholder^="BEGINSLATEPACK"]'), s2, 'The pasted reply');
  } else {
    await actOnInbox(lane, recipient, 'To sign', leg.amount, toSignBefore);
    await expect(recipient.page.locator('#root')).toContainText('Reply posted to the Smirk relay', { timeout: 120_000 });
    await signIncoming(recipient, amountAtomic);
    await actOnInbox(lane, sender, 'To finalize', leg.amount, toFinalizeBefore);
    await expect(sender.page.locator('#root')).toContainText('Share slatepack', { timeout: 60_000 });
  }
  const kernel = await grinFinalize(lane, sender, leg);
  if (feeAtomic !== undefined) lane.ledger.annotate(leg.id, { feeAtomic: feeAtomic.toString() });

  // Sender's history: the finalized send by its kernel.
  await openCoin(lane, sender, 'grin');
  const d = await openDetail(sender, { kernel });
  expect(d, 'the sender sees the Grin send').not.toBeNull();
  expectSenderDetail('grin', d!, { amountAtomic });
  expect(d!.fields.Kernel, 'the history names the kernel').toBe(kernel);
  expect(d!.fields['Slate ID'], 'the history names the slate').toBeTruthy();
  await sender.footage.result('Grin send in the history sheet');
  await closeDetail(sender);

  // Recipient: the incoming payment, pending until the kernel confirms.
  const r = await openCoin(lane, recipient, 'grin');
  expect(r.confirmed + r.pending + r.locked >= recipientConfirmedBefore + amountAtomic - headerTolerance('grin'), 'the recipient shows the incoming Grin').toBe(true);
  const rd = await openDetail(recipient, { grinIncomingAmount: fromAtomic('grin', amountAtomic, 8) }, 'Open the incoming Grin');
  expect(rd, 'the recipient sees the incoming Grin').not.toBeNull();
  expect(rd!.fields.Direction).toBe('Received');
  expect(rd!.fields.Amount).toBe(`${fromAtomic('grin', amountAtomic, 12)} GRIN`);
  await recipient.footage.result('Incoming Grin, pending');
  await closeDetail(recipient);

  return {
    id: leg.id,
    from: leg.from,
    to: leg.to,
    amountAtomic,
    kernel,
    ...(feeAtomic !== undefined ? { feeAtomic } : {}),
    resumed: false,
    senderBefore,
    recipientConfirmedBefore,
  };
}

/**
 * Wait until the payment is spendable on the recipient's side (mined, so the
 * scan reports it as confirmed), then ten more Grin blocks, then check the
 * sender paid the amount plus a fee under the cap. Grin shows no per-payment
 * confirmation count, so the ten blocks are ten block intervals.
 */
export async function grinSettled(lane: LiveLane, sent: GrinSent): Promise<void> {
  const recipient = lane.wallets[sent.to];
  const sender = lane.wallets[sent.from];
  const tol = headerTolerance('grin');
  if (sent.recipientConfirmedBefore !== undefined) {
    const deadline = Date.now() + CHAIN_WAIT_MS.grin;
    for (;;) {
      const h = await openCoin(lane, recipient, 'grin');
      if (h.confirmed - sent.recipientConfirmedBefore >= sent.amountAtomic - tol) break;
      if (Date.now() > deadline) throw new Error(`${sent.id}: the Grin payment never became spendable for ${sent.to}`);
      await recipient.footage.hold(POLL_MS, 'Waiting for the kernel to be mined');
    }
    await recipient.footage.result('Grin received and confirmed');
    lane.progress(`${sent.id}: ${sent.to} can spend the payment; waiting ten Grin blocks`);
  }
  await recipient.footage.hold(10 * GRIN_BLOCK_MS, 'Ten Grin blocks');
  if (sent.senderBefore !== undefined) {
    const s = headerTotal(await openCoin(lane, sender, 'grin'));
    const spent = sent.senderBefore - s;
    const fee = sent.feeAtomic ?? 0n;
    expect(spent >= sent.amountAtomic + fee - tol && spent <= sent.amountAtomic + SPEND_CAPS.grin.feeCap + tol, 'the sender paid the amount and a capped fee').toBe(true);
    await sender.footage.result('Sender Grin balance after the payment');
  }
  lane.progress(`${sent.id}: settled`);
}

/** A GoblinPay pay-link pre-fills Send; checked at Compose, never built or broadcast. */
export async function paylinkPrefill(lane: LiveLane, w: LiveWallet, payee: WalletName, amount: string): Promise<void> {
  const page = w.page;
  const npub = lane.book.get(payee, 'grin', 'npub');
  const { attempted } = await w.broadcasts.blocking(async () => {
    await openInbox(w);
    await w.footage.tap(page.getByTestId('inbox-paste-slatepack-btn'), 'Paste a pay-link');
    await w.footage.settled('Paste screen');
    await w.footage.fill(page.getByTestId('paste-dispatch-input'), `goblin:${npub}?amount=${amount}&memo=e2e`, 'A GoblinPay pay-link');
    await w.footage.tap(page.getByTestId('paste-dispatch-submit'), 'Continue');
    const addr = page.getByTestId('send-address-input');
    await expect(addr).toBeVisible({ timeout: 15_000 });
    await expect(addr, 'the recipient is the payee key').toHaveValue(new RegExp(`^${npubToHex(npub)}$`, 'i'));
    await w.footage.result('Pay-link recipient filled in');
    await w.footage.tap(page.getByTestId('send-address-continue'), 'Continue');
    await expect(page.getByTestId('send-amount-input'), 'the amount came from the link').toHaveValue(amount, { timeout: 15_000 });
    if ((await pricedAssets(lane)).has('grin')) {
      await expect(page.getByTestId('send-amount-usd')).toHaveText(USD_TEXT);
    }
    await expect(page.getByTestId('send-compose-continue')).toHaveText('Continue to slatepack');
    await w.footage.result('Pay-link amount filled in, not sent');
    await exitSendWizard(w);
  });
  expect(attempted, 'the pay-link check broadcast nothing').toBe(0);
  lane.progress(`${w.name}: GoblinPay pay-link pre-filled Send; nothing built or broadcast`);
}

// ---------------------------------------------------------------------------
// Dapp payment approval
// ---------------------------------------------------------------------------

const SHOP_ORIGIN = 'http://smirk-dummy-shop.test';

/**
 * The approval popup shows a page's payment request in human units, and Deny
 * reaches the page as a refusal. Broadcasts are blocked throughout.
 */
export async function dappPaymentApproval(lane: LiveLane, w: LiveWallet, to: WalletName): Promise<void> {
  const address = lane.book.get(to, 'wow');
  let [sw] = w.context.serviceWorkers();
  if (!sw) sw = await w.context.waitForEvent('serviceworker');
  await sw.evaluate(
    async ({ key, perm }) => {
      const g = globalThis as unknown as { chrome: { storage: { local: { set(v: Record<string, unknown>): Promise<void> } } } };
      await g.chrome.storage.local.set({ [key]: perm });
    },
    { key: `smirk:dapp:origin:${SHOP_ORIGIN}`, perm: { origin: SHOP_ORIGIN, assets: ['wow'] } },
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Demo shop</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:420px;background:#fff">
<h1 style="font-size:20px">Demo shop checkout</h1>
<button id="pay" style="padding:12px 18px;font-size:16px">Pay 0.5 WOW</button><pre id="out"></pre>
<script>document.getElementById('pay').addEventListener('click', async () => {
  try { const r = await window.smirk.requestPayment({ asset: 'wow', amount: '0.5', address: ${JSON.stringify(address)} });
    document.getElementById('out').textContent = 'ok:' + JSON.stringify(r); }
  catch (e) { document.getElementById('out').textContent = 'err:' + (e && e.message); }
});</script></body></html>`;
  const shop = await w.context.newPage();
  const shopFootage = w.footageFor(shop, 'shop');
  const { attempted } = await w.broadcasts.blocking(async () => {
    await shop.route(`${SHOP_ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await shop.goto(`${SHOP_ORIGIN}/`);
    await shop.waitForFunction(
      () => typeof (window as unknown as { smirk?: { requestPayment?: unknown } }).smirk?.requestPayment === 'function',
      null,
      { timeout: 30_000 },
    );
    await shopFootage.settled('Shop checkout');
    const approvalOpened = w.context.waitForEvent('page', { predicate: (p) => p.url().includes('#approval'), timeout: 60_000 });
    await shopFootage.tap(shop.getByRole('button', { name: 'Pay 0.5 WOW' }), 'Pay on the shop');
    const approval = await approvalOpened;
    const approvalFootage = w.footageFor(approval, 'approval');
    await Promise.race([
      approval.getByTestId('lockscreen-password-input').waitFor({ timeout: 30_000 }).catch(() => {}),
      approval.getByRole('button', { name: 'Deny' }).waitFor({ timeout: 30_000 }).catch(() => {}),
    ]);
    await w.answerPasswordPrompt(approval);
    const body = approval.locator('body');
    await expect(body).toContainText('Send WOW?', { timeout: 30_000 });
    await expect(body).toContainText('0.5 WOW');
    await expect(body).toContainText(address);
    await expect(body).not.toContainText('atomic units');
    await expect(body).not.toContainText('Cannot convert');
    await approvalFootage.result('Payment approval in human units');
    await approvalFootage.tap(approval.getByRole('button', { name: 'Deny' }), 'Deny');
    await expect(shop.locator('#out')).toHaveText(/^err:/, { timeout: 30_000 });
    await shopFootage.result('The shop hears the payment was denied');
  });
  expect(attempted, 'the approval check broadcast nothing').toBe(0);
  await shop.close();
  await w.page.bringToFront();
  lane.progress(`${w.name}: dapp payment approval showed 0.5 WOW to ${to}; denied; nothing broadcast`);
}
