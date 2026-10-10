/**
 * Wallet flows for the send, receive and history live spec.
 *
 * Every interaction goes through the footage hooks (`tap`, `fill`, `settled`,
 * `result`, `secret`, `pollWait`), never `.click` or `.fill` directly; the
 * lint in scripts/B-send-receive-history-check-live-specs.mjs holds this file
 * and the live spec to that. Every money leg goes through the AddressBook and
 * the SpendLedger (fixtures/live-send.ts), and every Review-only or refusal
 * check runs with broadcasts blocked and asserts that none were attempted.
 *
 * Reading the screen is in process and limited to public values: balances,
 * addresses, amounts, fees, statuses and transaction ids. The history sheet
 * reader skips any field whose label mentions a key, and nothing here ever
 * presses "Show transaction key": its presence is asserted, and the key
 * stays in its masked state on camera.
 *
 * Health cues (the Home fiat total, the freshness cue, a coin's USD line) are
 * asserted only where they are the subject (`strict`); while a flow polls the
 * chain for an hour, a short price-feed or backend blip is logged, not fatal.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LiveLane, LiveWallet } from './B-send-receive-history-wallets.js';
import {
  ASSET_DECIMALS,
  DUPLICATE_DECOY_REFUSAL,
  FEE_RESERVE,
  SPEND_CAPS,
  TICKER,
  WALLET_NAMES,
  fromAtomic,
  looksLikeReceiveAddress,
  planRing,
  toAtomic,
  type GrinVia,
  type LiveAsset,
  type RingEdge,
  type RingPlan,
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

/** Pause between polls while waiting on the chain. Always applied; static on video. */
export const POLL_MS = 90_000;
/** Ceiling for one wait on confirmations or spendable funds. */
export const CHAIN_WAIT_MS: Readonly<Record<LiveAsset, number>> = {
  btc: 150 * 60_000,
  ltc: 60 * 60_000,
  xmr: 75 * 60_000,
  wow: 75 * 60_000,
  grin: 60 * 60_000,
};
/**
 * Confirmations a receive needs before the next leg may spend it: Bitcoin and
 * Litecoin one, Monero outputs unlock after ten, Wownero after four.
 */
export const RECEIVE_CONFIRMATIONS: Readonly<Record<Exclude<LiveAsset, 'grin'>, number>> = {
  btc: 1,
  ltc: 1,
  xmr: 10,
  wow: 4,
};
/** "After 10 confirmations" for Grin: ten blocks past the height at which the payment became spendable. */
export const GRIN_SETTLE_BLOCKS = 10;
/** A Grin tip reading older than this is stale; a wait that needs the tip refuses it. */
const GRIN_TIP_FRESH_MS = 5 * 60_000;
/** A recipient that first looks this long after a broadcast cannot blame the chain for missing the pending state. */
const PENDING_LOOK_WINDOW_MS = 5 * 60_000;

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

function isCryptonote(asset: LiveAsset): asset is 'xmr' | 'wow' {
  return asset === 'xmr' || asset === 'wow';
}

/**
 * A Monero ('8') or Wownero ('WW') subaddress. Payments to one use per-output
 * keys, which the wallet does not keep, so their history offers no transaction
 * key and says why. Receive shows primary addresses unless the subaddress
 * flag is on.
 */
function isSubaddress(asset: LiveAsset, address: string): boolean {
  return (asset === 'xmr' && address.startsWith('8')) || (asset === 'wow' && address.startsWith('WW'));
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

/** What is wrong with Home's health cues, or null when the total and the freshness cue are fine. */
async function homeProblem(w: LiveWallet): Promise<string | null> {
  const total = ((await w.page.getByTestId('home-total-balance').textContent()) ?? '').trim();
  if (!/\d/.test(total)) return 'the Home fiat total shows no figure';
  const cue = w.page.getByTestId('balance-freshness-cue');
  if (await cue.count()) {
    const level = ((await cue.first().getAttribute('data-freshness')) ?? 'fresh').replace(/[^a-z]/g, '');
    if (!['fresh', 'updating'].includes(level)) return `the freshness cue reads ${level}`;
  }
  return null;
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
    if (i > 0) await w.footage.settled('Not the tab root yet');
    await w.footage.tap(nav, i === 0 ? label : 'Same tab again, back to its root');
    await w.page.waitForTimeout(1_500); // lint-allow: poll
    if (await root.isVisible().catch(() => false)) {
      await w.page.waitForTimeout(700); // lint-allow: poll
      if (await root.isVisible().catch(() => false)) return;
    }
  }
  await expect(root, `the ${tab} tab reached its root`).toBeVisible({ timeout: 30_000 });
}

/**
 * Home, held. `strict` asserts the fiat total and a fresh (or updating)
 * freshness cue; otherwise a problem with either is logged and the flow goes
 * on, because a poll loop must not fail on a thirty-second backend blip.
 */
export async function goHome(w: LiveWallet, opts: { strict?: boolean } = {}): Promise<void> {
  const total = w.page.getByTestId('home-total-balance');
  await tabRoot(w, 'home', total, 'Home tab');
  await w.footage.settled('Home');
  const problem = await homeProblem(w);
  if (opts.strict) expect(problem, 'Home shows a fiat total and a fresh freshness cue').toBeNull();
  else if (problem) w.log(`noted while polling: ${problem} (asserted only by the USD and freshness test)`);
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

/**
 * Open a coin's screen from Home and read its header. `strict` asserts the
 * USD line for a priced coin with a balance (and Home's cues on the way);
 * otherwise a missing USD line is logged.
 */
export async function openCoin(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  opts: { strict?: boolean } = {},
): Promise<CoinHeader> {
  await goHome(w, opts);
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), `${TICKER[asset]} row`);
  await expect(w.page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 60_000 });
  await w.footage.settled('Coin screen with activity');
  const header = await readCoinHeader(w, asset);
  if ((await pricedAssets(lane)).has(asset) && headerTotal(header) > 0n) {
    if (opts.strict) expect(header.usd, `${TICKER[asset]} header shows its USD value`).toMatch(USD_TEXT);
    else if (!USD_TEXT.test(header.usd ?? '')) w.log(`noted while polling: the ${TICKER[asset]} header shows no USD value`);
  }
  return header;
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
  await w.footage.settled('Settings');
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
// Funding plan
// ---------------------------------------------------------------------------

/**
 * Read every wallet's balance of a coin (on camera) and plan its ring. With
 * `show`, each balance is held as a key result: the funding check's evidence.
 */
export async function planCoin(
  lane: LiveLane,
  asset: LiveAsset,
  ring: readonly RingEdge[],
  opts: { show?: boolean } = {},
): Promise<RingPlan> {
  const balances = new Map<WalletName, bigint>();
  for (const name of WALLET_NAMES) {
    const w = lane.wallets[name];
    balances.set(name, headerTotal(await openCoin(lane, w, asset)));
    if (opts.show) await w.footage.result('Balance before the payments');
  }
  const plan = planRing(asset, ring, balances, lane.ledger.entries(asset));
  const held = WALLET_NAMES.map((n) => `${n} ${fromAtomic(asset, balances.get(n)!)}`).join(', ');
  if (plan.ok) {
    lane.progress(
      `${TICKER[asset]} plan: ${plan.legs.map((l) => `${l.from} pays ${l.to} ${l.amount}`).join(', then ')}` +
        `${plan.resumed ? ' (order kept from this run\'s ledger)' : ''}; balances ${held}`,
    );
  } else {
    lane.progress(`${TICKER[asset]} plan refused: ${plan.reason}; balances ${held}`);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// History detail
// ---------------------------------------------------------------------------

export type DetailFields = Record<string, string>;

export interface Detail {
  title: string;
  fields: DetailFields;
  note: string;
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
    const box = el.firstElementChild;
    const note = box
      ? Array.from(box.children)
          .filter((c) => c.tagName === 'DIV' && !c.querySelector('button, dl'))
          .map((c) => c.textContent?.trim() ?? '')
          .join(' ')
      : '';
    return { title: el.querySelector('strong')?.textContent?.trim() ?? '', fields, note };
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

/** Close the sheet and hold the coin screen it leaves. */
export async function closeDetail(w: LiveWallet): Promise<void> {
  await w.footage.tap(w.page.getByTestId('tx-detail-close'), 'Close the detail');
  await expect(w.page.getByTestId('tx-detail-sheet')).toHaveCount(0);
  await w.footage.settled('Coin screen');
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

/**
 * Check a send's detail on the sender's side. Returns the fee it reports.
 * `journal` says whether this profile signed the payment: the recipient, the
 * fee and (XMR/WOW) the transaction key come from the wallet's own send
 * record, which only that profile holds. Without it the wallet must say it
 * has no record rather than invent a recipient.
 */
export function expectSenderDetail(
  asset: LiveAsset,
  d: Detail,
  sent: { amountAtomic: bigint; txid?: string; destination?: string; journal: boolean },
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
  if (asset !== 'grin') {
    if (sent.journal) {
      expect(d.fields['Sent to'], 'sender sees the full recipient, from its send record').toBe(sent.destination);
      expect(d.fields['Network fee'], 'sender sees the fee, from its send record').toBeTruthy();
    } else {
      expect(d.fields['Sent to'], 'without a send record the wallet names no recipient').toBeUndefined();
      expect(d.note, 'without a send record the wallet says so').toMatch(/no send record/);
    }
  }
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

/**
 * For an XMR or WOW send to a primary address, signed by this profile: the
 * "Show transaction key" action is offered, and the key itself is not shown.
 * Nothing here presses it, so the key appears on video only masked.
 */
export function expectMaskedTxKey(asset: LiveAsset, d: Detail): void {
  if (!isCryptonote(asset)) return;
  expect(d.hasRevealKey, 'the Show transaction key action is offered (send record with a verified key)').toBe(true);
  expect(d.keyShown, 'the key itself stays masked').toBe(false);
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
    await w.footage.pollWait(POLL_MS, 'Waiting for the next block');
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
    await w.footage.pollWait(POLL_MS, 'Waiting for spendable funds');
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
  await w.footage.settled('Destination entered');
  await w.footage.tap(w.page.getByTestId('send-address-continue'), 'Continue');
  await expect(w.page.getByTestId('send-amount-input')).toBeVisible({ timeout: 30_000 });
  await w.footage.settled('Send: compose');
}

/** Leave the Send wizard without sending, from any step, holding each step it passes. */
export async function exitSendWizard(w: LiveWallet): Promise<void> {
  const back = w.page.getByTestId('send-wizard-header-back');
  for (let i = 0; i < 5 && (await back.isVisible().catch(() => false)); i++) {
    await w.footage.tap(back, 'Back out of Send');
    await w.footage.settled('Previous step');
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
  await w.footage.settled('Normal tier again');
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
  const amountAtomic = toAtomic(asset, amount);
  const line = new RegExp(`Balance:\\s*([\\d.]+)\\s*${ticker}`).exec((await page.locator('#root').innerText()).replace(/\s+/g, ' '));
  expect(line, 'Compose shows the balance').not.toBeNull();
  const composeBalance = toAtomic(asset, line![1]!);
  expect(composeBalance >= amountAtomic, 'Compose shows enough spendable balance').toBe(true);
  if (composeBalance !== header.confirmed) {
    // A background refresh can land between the two readings; note it rather than fail on timing.
    lane.progress(`${w.name}: ${ticker} Compose balance differs from the coin screen reading taken moments earlier`);
  }
  if (asset === 'btc' || asset === 'ltc') {
    const normal = page.getByTestId('send-fee-tier-normal');
    await expect(normal).toContainText(/sat\/vB/, { timeout: 60_000 });
    if (opts.feeTour) await feeTour(w);
    if ((await normal.getAttribute('aria-pressed')) !== 'true') {
      await w.footage.tap(normal, 'Normal fee tier');
      await w.footage.settled('Normal fee tier selected');
    }
    // The wallet's own estimate, not the plan's reserve, decides whether this
    // leg is payable. The tier reads "<rate> sat/vB · <fee>", the fee in sat
    // or lits, or in coin units once it passes 0.001.
    const tier = (await normal.innerText()).replace(/\s+/g, ' ');
    const inAtomic = /· (\d+) (?:sat|lits)\b/.exec(tier);
    const inCoin = new RegExp(`· ([\\d.]+) ${ticker}\\b`).exec(tier);
    const fee = inAtomic ? BigInt(inAtomic[1]!) : inCoin ? toAtomic(asset, inCoin[1]!) : undefined;
    if (fee === undefined) {
      lane.progress(`${w.name}: ${ticker} normal-tier fee estimate unreadable; the wallet's own Continue gate decides`);
    } else {
      expect(
        composeBalance >= amountAtomic + fee,
        `${w.name} can pay ${amount} ${ticker} plus the wallet's own fee estimate`,
      ).toBe(true);
      lane.progress(`${w.name}: ${ticker} normal-tier fee estimate ${fromAtomic(asset, fee)} ${ticker}`);
    }
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

async function review(
  lane: LiveLane,
  w: LiveWallet,
  asset: LiveAsset,
  amountAtomic: bigint,
  destination: string,
  header: CoinHeader,
): Promise<void> {
  const page = w.page;
  const ticker = TICKER[asset];
  await expect(page.getByTestId('send-review-submit')).toBeVisible({ timeout: 30_000 });
  if (isCryptonote(asset)) {
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
    expect(
      header.confirmed >= amountAtomic + est,
      `${w.name} can pay the amount plus the wallet's own ${ticker} fee estimate`,
    ).toBe(true);
    lane.progress(`${w.name}: ${ticker} fee estimate ${fromAtomic(asset, est)}`);
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

/**
 * Hold the receipt, then close it and hold the screen it leaves. The receipt
 * counts itself down ("Done (12)"), so "Stay on this screen" is tapped at
 * once (an urgent tap, the only one) and the stopped receipt is then held.
 */
async function holdDone(w: LiveWallet, idLabel: 'Transaction ID' | 'Kernel ID'): Promise<string> {
  const page = w.page;
  const id = ((await page.getByTestId('send-done-txid').textContent()) ?? '').trim();
  await expect(page.locator('#root')).toContainText(idLabel);
  const stay = page.getByRole('button', { name: 'Stay on this screen' });
  await stay.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  if (await stay.isVisible().catch(() => false)) {
    await w.footage.tap(stay, 'Stay on the receipt', { urgent: 'countdown' });
    await expect(stay).toHaveCount(0);
  }
  await w.footage.settled('Receipt, countdown stopped');
  await w.footage.result('Sent: the receipt with its id');
  await w.footage.tap(page.getByTestId('send-done-close'), 'Done');
  await w.footage.settled('Back from the receipt');
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
  asset: Exclude<LiveAsset, 'grin'>;
  from: WalletName;
  to: WalletName;
  amountAtomic: bigint;
  destination: string;
  txid: string;
  feeAtomic?: bigint;
  firstStatus?: string;
  resumed: boolean;
  /** When this attempt broadcast it (absent on a resumed leg). */
  broadcastAt?: number;
  /** Totals before the leg, for the balance checks once it confirms. */
  senderBefore?: bigint;
  recipientBefore?: CoinHeader;
}

/** The sender, right after the broadcast: hold the receipt, then its own activity shows the payment. */
async function senderAfterBroadcast(lane: LiveLane, sent: SentLeg): Promise<{ feeAtomic?: bigint; firstStatus?: string }> {
  const sender = lane.wallets[sent.from];
  await holdDone(sender, 'Transaction ID');
  await openCoin(lane, sender, sent.asset);
  const d = (await openDetail(sender, { txid: sent.txid })) ?? (await openDetail(sender, { recipient: sent.destination }));
  expect(d, 'the sender sees the payment in activity right away').not.toBeNull();
  const fee = expectSenderDetail(sent.asset, d!, {
    amountAtomic: sent.amountAtomic,
    destination: sent.destination,
    journal: true,
    ...(d!.fields['Transaction ID'] ? { txid: sent.txid } : {}),
  });
  await sender.footage.result('Sent payment in the history sheet');
  await closeDetail(sender);
  lane.ledger.annotate(sent.id, {
    ...(d!.fields.Status ? { firstStatus: d!.fields.Status } : {}),
    ...(fee !== undefined ? { feeAtomic: fee.toString() } : {}),
  });
  return {
    ...(fee !== undefined ? { feeAtomic: fee } : {}),
    ...(d!.fields.Status ? { firstStatus: d!.fields.Status } : {}),
  };
}

/**
 * One on-chain leg, start to finish: from the coin screen through Review to a
 * broadcast. Allowlist and caps are enforced by the ledger before the Send
 * tap. A duplicate-decoy refusal is retried once, and only when the monitor
 * proves nothing was broadcast. Once broadcast, the sender holds its receipt
 * and reads its own activity while, at the same time, the recipient watches
 * for the payment to arrive, so the pending state is caught early.
 */
export async function sendLeg(lane: LiveLane, leg: SendLeg): Promise<SentLeg> {
  const sender = lane.wallets[leg.from];
  const recipient = lane.wallets[leg.to];
  const ticker = TICKER[leg.asset];
  const destination = lane.book.get(leg.to, leg.asset);
  const amountAtomic = toAtomic(leg.asset, leg.amount);
  const prior = lane.ledger.completed(leg.id);
  if (prior?.txid) {
    lane.progress(`${leg.id}: resuming, already broadcast as ${prior.txid}; this attempt checks only what follows the broadcast`);
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

  const recipientBefore = await openCoin(lane, recipient, leg.asset);
  const header = await waitSpendable(lane, sender, leg.asset, amountAtomic + FEE_RESERVE[leg.asset]);
  sender.footage.mark(`${TICKER[leg.asset]} send`);
  await openSendFromCoin(sender);
  await enterDestination(sender, destination);
  await compose(lane, sender, leg.asset, leg.amount, header, { feeTour: leg.feeTour ?? false });
  await review(lane, sender, leg.asset, amountAtomic, destination, header);

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
    const decoyRefusal = isCryptonote(leg.asset) && DUPLICATE_DECOY_REFUSAL.test(outcome.message);
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
  lane.ledger.broadcast(leg.id, { txid, senderProfile: sender.profileId });
  const broadcastAt = Date.now();
  lane.progress(`${leg.id}: broadcast ${txid}`);

  const sent: SentLeg = {
    id: leg.id,
    asset: leg.asset,
    from: leg.from,
    to: leg.to,
    amountAtomic,
    destination,
    txid,
    resumed: false,
    broadcastAt,
    senderBefore: headerTotal(header),
    recipientBefore,
  };
  // Both wallets at once: neither branch is abandoned mid-step if the other fails.
  const [own, arrival] = await Promise.allSettled([senderAfterBroadcast(lane, sent), expectIncoming(lane, sent)]);
  if (own.status === 'rejected') throw own.reason;
  if (arrival.status === 'rejected') throw arrival.reason;
  return { ...sent, ...own.value };
}

/**
 * The recipient sees the payment arrive while it is still pending: an
 * incoming row with the amount, and the header's pending (or, for Monero and
 * Wownero, locked) amount grown by it.
 *
 * Monero and Wownero hold a received output locked for ten (four) blocks, so
 * the pending state is always there to see, and the check insists on the
 * header showing it. For Bitcoin and Litecoin the pending state is the row
 * listed unconfirmed or the header's pending amount grown by the payment
 * (the header may show it before the list does), and the row must be listed
 * either way. Both chains can mine the payment before the recipient's first
 * look (a Litecoin block every two and a half minutes): if the first look,
 * within five minutes of the broadcast, already finds it mined, that is
 * recorded as an annotation and in the progress log, never passed off as an
 * observed pending state. A first look later than that fails: the harness
 * was too slow to claim the chain beat it.
 */
export async function expectIncoming(lane: LiveLane, sent: SentLeg): Promise<void> {
  const w = lane.wallets[sent.to];
  const before = sent.recipientBefore;
  if (!before || sent.broadcastAt === undefined) throw new Error('expectIncoming needs the recipient header before the leg');
  const tol = headerTolerance(sent.asset);
  const deadline = Date.now() + 30 * 60_000;
  let pendingRow = false;
  let pendingHeader = false;
  let firstLook: number | null = null;
  for (;;) {
    const header = await openCoin(lane, w, sent.asset);
    const grown = header.pending + header.locked - (before.pending + before.locked) >= sent.amountAtomic - tol;
    if (grown) pendingHeader = true;
    const d = await openDetail(w, { txid: sent.txid }, 'Open the incoming payment');
    if (!d && grown) {
      // The header shows it pending before the activity list does.
      await w.footage.result('Incoming amount pending in the header');
    }
    if (d) {
      firstLook ??= Date.now();
      expectRecipientDetail(sent.asset, d, { amountAtomic: sent.amountAtomic, txid: sent.txid });
      const unconfirmed = confirmationsOf(d.fields.Status) === 0;
      if (unconfirmed) pendingRow = true;
      await w.footage.result(unconfirmed || grown ? 'Incoming payment, pending' : 'Incoming payment');
      await closeDetail(w);
      if (isCryptonote(sent.asset)) {
        if (pendingHeader) {
          lane.progress(`${sent.id}: ${sent.to} sees the payment (${d.fields.Status ?? 'no status'}), ${pendingRow ? 'unconfirmed and ' : ''}pending or locked in the header`);
          return;
        }
        // Listed, but the header has not caught up yet; the output stays locked for blocks.
      } else if (pendingHeader || (pendingRow && !unconfirmed)) {
        lane.progress(
          `${sent.id}: ${sent.to} saw the payment pending (${[pendingRow ? 'unconfirmed row' : '', pendingHeader ? 'pending amount in the header' : ''].filter(Boolean).join(', ')})`,
        );
        return;
      } else if (!pendingRow && !unconfirmed) {
        const after = Math.round((firstLook - sent.broadcastAt) / 1000);
        if (firstLook - sent.broadcastAt > PENDING_LOOK_WINDOW_MS) {
          throw new Error(`${sent.to} first found the ${TICKER[sent.asset]} payment ${after} s after the broadcast, already mined: the pending state was never observed`);
        }
        const note = `${sent.id}: pending state not observable: mined before ${sent.to}'s first look, ${after} s after the broadcast`;
        lane.progress(note);
        test.info().annotations.push({ type: 'pending-not-observed', description: note });
        return;
      }
      // An unconfirmed row with the header not caught up yet: look again.
    }
    if (Date.now() > deadline) {
      throw new Error(`${sent.to} never saw the ${TICKER[sent.asset]} payment as an incoming row with a pending amount`);
    }
    await w.footage.pollWait(60_000, 'Waiting for the payment to appear');
  }
}

/**
 * After a leg confirms, both totals moved by the right amounts: the recipient
 * gained exactly the amount, the sender lost the amount plus the fee.
 */
export async function expectSettledBalances(lane: LiveLane, sent: SentLeg): Promise<void> {
  if (sent.senderBefore === undefined || sent.recipientBefore === undefined) {
    lane.progress(`${sent.id}: resumed leg: no balances from before it in this attempt, so the balance movement is not checked`);
    return;
  }
  const tol = headerTolerance(sent.asset);
  const recipientBefore = headerTotal(sent.recipientBefore);
  const deadline = Date.now() + CHAIN_WAIT_MS[sent.asset];
  for (;;) {
    const r = headerTotal(await openCoin(lane, lane.wallets[sent.to], sent.asset));
    const s = headerTotal(await openCoin(lane, lane.wallets[sent.from], sent.asset));
    const gained = r - recipientBefore;
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
    await lane.wallets[sent.from].footage.pollWait(POLL_MS, 'Waiting for balances to settle');
  }
}

/** Re-open a send until its confirmation count rises past `from`, holding each reading. */
async function watchOneMoreBlock(lane: LiveLane, sent: SentLeg, from: number): Promise<number> {
  const w = lane.wallets[sent.from];
  const deadline = Date.now() + CHAIN_WAIT_MS[sent.asset];
  for (;;) {
    await w.footage.pollWait(POLL_MS, 'Waiting for the next block');
    await openCoin(lane, w, sent.asset);
    const d = await openDetail(w, { txid: sent.txid }, 'Open the send again');
    expect(d, 'the send is still listed').not.toBeNull();
    const now = confirmationsOf(d!.fields.Status) ?? 0;
    await w.footage.result('Confirmations after another block');
    await closeDetail(w);
    if (now > from) return now;
    if (Date.now() > deadline) throw new Error(`${TICKER[sent.asset]} confirmations never rose`);
  }
}

/**
 * The history sheet for one confirmed on-chain payment, on both sides, in the
 * worker (and browser profiles) that made it.
 *
 * Sender: Sent, the amount, a fee under the cap, a time, the txid, the full
 * recipient from the send record, the explorer action (answered locally),
 * and on XMR/WOW the "Show transaction key" action, never pressed.
 * Confirmations: Monero and Wownero show a count, which must have risen
 * since the broadcast, and on the first leg of each the sheet is held open
 * while one more block lands. Bitcoin and Litecoin history shows the block a
 * payment was mined in, not a count (the wallet reads no tip height for UTXO
 * chains), so the check there is honest about what it proves: the payment
 * moved from the mempool into a block.
 * Recipient: Received, the amount, the txid, a time, a status at the
 * confirmations the spec waited for, no recipient line and no key action.
 */
export async function historyDetail(lane: LiveLane, sent: SentLeg, opts: { watchRise: boolean }): Promise<void> {
  const asset = sent.asset;
  const ticker = TICKER[asset];
  const sender = lane.wallets[sent.from];
  const recipient = lane.wallets[sent.to];
  const entry = lane.ledger.get(sent.id);
  const journal = entry?.senderProfile !== undefined && entry.senderProfile === sender.profileId;
  if (!journal) {
    lane.progress(`${sent.id}: the send record is not in ${sent.from}'s current profile, so the sheet must show no recipient and no key`);
  }

  await openCoin(lane, sender, asset);
  const d = await openDetail(sender, { txid: sent.txid }, 'Open the send');
  expect(d, `${sent.from} lists the ${ticker} send by its txid`).not.toBeNull();
  expectSenderDetail(asset, d!, { amountAtomic: sent.amountAtomic, txid: sent.txid, destination: sent.destination, journal });
  if (isCryptonote(asset)) {
    if (!journal) {
      expect(d!.hasRevealKey, 'no send record, so no transaction key to offer').toBe(false);
    } else if (isSubaddress(asset, sent.destination)) {
      expect(d!.hasRevealKey, 'a subaddress payment keeps no transaction key').toBe(false);
      expect(d!.note, 'the sheet says why there is no key').toMatch(/No transaction key on file/);
      lane.progress(`${sent.id}: paid to a subaddress, so the sheet offers no transaction key, as it documents`);
    } else {
      expectMaskedTxKey(asset, d!);
    }
  }
  // What the sender's sheet said right after the broadcast; absent when an
  // earlier attempt broadcast the leg and stopped before reading it.
  const firstStatus = entry?.firstStatus ?? sent.firstStatus;
  const first = firstStatus === undefined ? undefined : confirmationsOf(firstStatus);
  const now = confirmationsOf(d!.fields.Status);
  if (first === undefined) lane.progress(`${sent.id}: no reading right after the broadcast in this run, so the rise is checked from here on`);
  if (isCryptonote(asset)) {
    expect(now, `${ticker}: the sender sees a confirmation count`).not.toBeNull();
    expect(now! >= RECEIVE_CONFIRMATIONS[asset], `${ticker}: the sender counts at least the confirmations the recipient waited for`).toBe(true);
    if (typeof first === 'number') expect(now! > first, `${ticker}: confirmations rose since the broadcast`).toBe(true);
  } else {
    expect(d!.fields.Status, `${ticker}: the send is in a block (UTXO history names the block, not a count)`).toMatch(/^Block #\d+$/);
    if (first === 0) lane.progress(`${sent.id}: ${sent.from} saw the send unconfirmed, now mined (${d!.fields.Status})`);
    else if (first === null) lane.progress(`${sent.id}: ${sent.from} first saw the send already mined; the mempool state was not observed on the sender`);
  }
  await sender.footage.result('Send detail: amount, fee, time, confirmations, txid, recipient');
  await checkExplorer(sender, sent.txid);
  await sender.footage.result('Back on the send detail');
  await closeDetail(sender);
  if (opts.watchRise && isCryptonote(asset) && now !== null) {
    const later = await watchOneMoreBlock(lane, sent, now);
    lane.progress(`${sent.id}: confirmations rose from ${now} to ${later} on camera`);
  }

  await openCoin(lane, recipient, asset);
  const r = await openDetail(recipient, { txid: sent.txid }, 'Open the receive');
  expect(r, `${sent.to} lists the ${ticker} receive`).not.toBeNull();
  expectRecipientDetail(asset, r!, { amountAtomic: sent.amountAtomic, txid: sent.txid });
  expect(r!.fields.Time, 'the receive has a time').toBeTruthy();
  if (isCryptonote(asset)) {
    expect(confirmationsOf(r!.fields.Status) ?? 0, 'the receive shows its confirmations').toBeGreaterThanOrEqual(RECEIVE_CONFIRMATIONS[asset]);
  } else {
    expect(r!.fields.Status, 'the receive is in a block').toMatch(/^Block #\d+$/);
  }
  await recipient.footage.result('Receive detail: amount, time, confirmations, txid');
  if (r!.hasExplorer) {
    await checkExplorer(recipient, sent.txid);
    await recipient.footage.result('Back on the receive detail');
  }
  await closeDetail(recipient);
  lane.progress(`${sent.id}: history detail checked on both sides`);
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
    await w.footage.settled('Destination entered');
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
      await w.footage.settled('Amount entered');
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
    await w.footage.settled('Inbox refreshed');
    await w.footage.pollWait(30_000, 'Waiting for the Grin exchange');
  }
}

/** Receiver side of a delivered slate: the wallet signs and replies on its own; each screen is held. */
async function signIncoming(w: LiveWallet, amountAtomic: bigint): Promise<void> {
  const page = w.page;
  await expect(page.locator('#root')).toContainText('Reply slatepack ready', { timeout: 120_000 });
  await w.footage.result('Signed reply ready');
  await w.footage.tap(page.getByRole('button', { name: 'Done', exact: true }), 'Done');
  await expect(page.locator('#root')).toContainText('Signed and replied', { timeout: 30_000 });
  await expect(page.locator('#root')).toContainText(`amount: ${amountAtomic} nanogrin`);
  await w.footage.result('Signed and replied');
  await w.footage.tap(page.getByRole('button', { name: 'Done', exact: true }), 'Done');
  await w.footage.settled('Back from the signed reply');
}

export interface GrinLeg {
  id: string;
  from: WalletName;
  to: WalletName;
  amount: string;
  /** npub: the Nostr gift wrap; address: the recipient's grin1 address; pasted: slatepack by hand. */
  via: GrinVia;
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
  recipientBefore?: CoinHeader;
}

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
  const header = await waitSpendable(lane, sender, 'grin', amountAtomic + FEE_RESERVE.grin);
  sender.footage.mark('GRIN send');
  await openSendFromCoin(sender);
  if (leg.via === 'pasted') {
    await sender.footage.tap(page.getByRole('button', { name: 'Slatepack only', exact: true }), 'Slatepack only');
    await sender.footage.settled('Slatepack only, no recipient');
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

/**
 * Finalize from the Exchange step (S2 already in the box). The kernel is
 * written to the ledger the moment the receipt shows it, before any hold, so
 * a failure while the receipt is on screen can never leave a broadcast leg
 * marked only "reserved". The receipt is left on screen for the caller.
 */
async function grinFinalize(lane: LiveLane, sender: LiveWallet, leg: GrinLeg): Promise<string> {
  const page = sender.page;
  const finalize = page.getByRole('button', { name: 'Finalize & broadcast', exact: true });
  await expect(finalize).toBeEnabled({ timeout: 60_000 });
  const mark = sender.broadcasts.mark();
  await sender.footage.tap(finalize, 'Finalize and broadcast');
  const done = page.getByTestId('send-done-txid');
  await expect(done).toBeVisible({ timeout: 180_000 });
  expect(sender.broadcasts.since(mark), 'finalize reached the broadcast endpoint').toBeGreaterThanOrEqual(1);
  const kernel = ((await done.textContent()) ?? '').trim();
  expect(kernel, 'the receipt shows a kernel').toMatch(KERNEL);
  lane.ledger.broadcast(leg.id, {
    kernel,
    senderProfile: sender.profileId,
    recipientProfile: lane.wallets[leg.to].profileId,
  });
  lane.progress(`${leg.id}: finalized, kernel ${kernel}`);
  await expect(page.locator('#root')).toContainText('Broadcast');
  return kernel;
}

/** The sender, right after finalizing: hold the receipt, then its history lists the send by its kernel. */
async function grinSenderAfterFinalize(lane: LiveLane, sent: GrinSent): Promise<void> {
  const sender = lane.wallets[sent.from];
  await holdDone(sender, 'Kernel ID');
  await openCoin(lane, sender, 'grin');
  const d = await openDetail(sender, { kernel: sent.kernel });
  expect(d, 'the sender sees the Grin send').not.toBeNull();
  expectSenderDetail('grin', d!, { amountAtomic: sent.amountAtomic, journal: true });
  expect(d!.fields.Kernel, 'the history names the kernel').toBe(sent.kernel);
  expect(d!.fields['Slate ID'], 'the history names the slate').toBeTruthy();
  await sender.footage.result('Grin send in the history sheet');
  await closeDetail(sender);
}

/**
 * A Grin payment up to its broadcast. `npub` and `address` legs travel
 * through the recipient's Inbox (To sign) and back to the sender's (To
 * finalize). The `pasted` leg hands the slatepack across by hand: the harness
 * copies it from the sender's screen into the recipient's Paste screen, and
 * the reply back. Then the sender's history lists the kernel while the
 * recipient's total grows by the amount.
 */
export async function grinLeg(lane: LiveLane, leg: GrinLeg): Promise<GrinSent> {
  const sender = lane.wallets[leg.from];
  const recipient = lane.wallets[leg.to];
  const amountAtomic = toAtomic('grin', leg.amount);
  const prior = lane.ledger.completed(leg.id);
  if (prior?.kernel) {
    lane.progress(`${leg.id}: resuming, already finalized; this attempt checks only what follows the broadcast`);
    return {
      id: leg.id,
      from: leg.from,
      to: leg.to,
      amountAtomic,
      kernel: prior.kernel,
      ...(prior.feeAtomic ? { feeAtomic: BigInt(prior.feeAtomic) } : {}),
      resumed: true,
    };
  }
  const recipientBefore = await openCoin(lane, recipient, 'grin');
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
    await recipient.footage.settled('Slatepack pasted');
    await recipient.footage.tap(recipient.page.getByTestId('paste-dispatch-submit'), 'Continue');
    await expect(recipient.page.locator('#root')).toContainText('Reply slatepack ready', { timeout: 120_000 });
    const s2 = ((await recipient.page.locator('button').filter({ hasText: /^BEGINSLATEPACK/ }).first().textContent()) ?? '').trim();
    expect(s2.startsWith('BEGINSLATEPACK') && s2 !== s1, 'the recipient produced a reply').toBe(true);
    await signIncoming(recipient, amountAtomic);
    await sender.footage.fill(sender.page.locator('textarea[placeholder^="BEGINSLATEPACK"]'), s2, 'The pasted reply');
    await sender.footage.settled('Reply pasted, ready to finalize');
  } else {
    await actOnInbox(lane, recipient, 'To sign', leg.amount, toSignBefore);
    await expect(recipient.page.locator('#root')).toContainText('Reply posted to the Smirk relay', { timeout: 120_000 });
    await signIncoming(recipient, amountAtomic);
    await actOnInbox(lane, sender, 'To finalize', leg.amount, toFinalizeBefore);
    await expect(sender.page.locator('#root')).toContainText('Share slatepack', { timeout: 60_000 });
    await sender.footage.settled('Reply received, ready to finalize');
  }
  const kernel = await grinFinalize(lane, sender, leg);
  if (feeAtomic !== undefined) lane.ledger.annotate(leg.id, { feeAtomic: feeAtomic.toString() });

  const sent: GrinSent = {
    id: leg.id,
    from: leg.from,
    to: leg.to,
    amountAtomic,
    kernel,
    ...(feeAtomic !== undefined ? { feeAtomic } : {}),
    resumed: false,
    senderBefore,
    recipientBefore,
  };
  // Both wallets at once, as for the on-chain coins: the sender holds its
  // receipt and reads its history while the recipient watches the payment
  // arrive, so a pending state has the best chance of being seen.
  const [own, arrival] = await Promise.allSettled([grinSenderAfterFinalize(lane, sent), grinIncoming(lane, sent)]);
  if (own.status === 'rejected') throw own.reason;
  if (arrival.status === 'rejected') throw arrival.reason;
  return sent;
}

/**
 * The recipient's Grin total grows by exactly the amount (pending until the
 * kernel is mined, then spendable), and its history lists the incoming
 * payment. A total that already held other pending coins cannot pass this:
 * the comparison is with the recipient's own total from before the leg.
 */
async function grinIncoming(lane: LiveLane, sent: GrinSent): Promise<void> {
  const recipient = lane.wallets[sent.to];
  if (!sent.recipientBefore) {
    lane.progress(`${sent.id}: resumed leg: no recipient balance from before it in this attempt, so its arrival is not measured`);
    return;
  }
  const tol = headerTolerance('grin');
  const before = sent.recipientBefore;
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const r = await openCoin(lane, recipient, 'grin');
    const gained = headerTotal(r) - headerTotal(before);
    if (gained >= sent.amountAtomic - tol && gained <= sent.amountAtomic + tol) {
      const waiting = r.pending + r.locked - (before.pending + before.locked) >= sent.amountAtomic - tol;
      lane.progress(`${sent.id}: ${sent.to}'s Grin total grew by the amount, ${waiting ? 'still pending' : 'already spendable'}`);
      await recipient.footage.result(waiting ? 'Incoming Grin, pending' : 'Incoming Grin, spendable');
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`${sent.id}: ${sent.to}'s Grin total never grew by exactly the payment (last change ${gained > sent.amountAtomic ? 'over' : 'under'} it)`);
    }
    await recipient.footage.pollWait(60_000, 'Waiting for the Grin payment to show');
  }
  const rd = await openDetail(recipient, { grinIncomingAmount: fromAtomic('grin', sent.amountAtomic, 8) }, 'Open the incoming Grin');
  expect(rd, 'the recipient lists the incoming Grin').not.toBeNull();
  expect(rd!.fields.Direction).toBe('Received');
  expect(rd!.fields.Amount).toBe(`${fromAtomic('grin', sent.amountAtomic, 12)} GRIN`);
  await recipient.footage.result('Incoming Grin in the history sheet');
  await closeDetail(recipient);
}

/** The freshest Grin tip the wallets reported, or a refusal when none is recent. */
function freshGrinTip(lane: LiveLane, what: string): number {
  const tip = lane.grinTip.latest();
  if (!tip) throw new Error(`no Grin tip height observed ${what}: the wallets' height requests never answered`);
  if (Date.now() - tip.at > GRIN_TIP_FRESH_MS) {
    throw new Error(`the newest Grin tip height is ${Math.round((Date.now() - tip.at) / 60_000)} min old ${what}; refusing a stale tip`);
  }
  return tip.height;
}

/**
 * "After 10 confirmations", measured on the chain: wait until the payment is
 * spendable on the recipient's side (the scan reports it mined and mature),
 * take the Grin tip at that moment as the height it became spendable, then
 * wait until the tip is ten blocks past it. The tip comes from the wallets'
 * own height requests (lane.grinTip); a stalled chain or a silent endpoint
 * fails the wait rather than passing it on a timer. Then the sender paid
 * the amount plus a capped fee.
 */
export async function grinSettled(lane: LiveLane, sent: GrinSent): Promise<void> {
  const recipient = lane.wallets[sent.to];
  const sender = lane.wallets[sent.from];
  const tol = headerTolerance('grin');
  const deadline = Date.now() + CHAIN_WAIT_MS.grin;
  let spendableAt: number;
  if (sent.recipientBefore) {
    const confirmedBefore = sent.recipientBefore.confirmed;
    for (;;) {
      const h = await openCoin(lane, recipient, 'grin');
      if (h.confirmed - confirmedBefore >= sent.amountAtomic - tol) break;
      if (Date.now() > deadline) throw new Error(`${sent.id}: the Grin payment never became spendable for ${sent.to}`);
      await recipient.footage.pollWait(POLL_MS, 'Waiting for the kernel to be mined');
    }
    spendableAt = freshGrinTip(lane, 'when the payment became spendable');
    await recipient.footage.result('Grin received and spendable');
  } else {
    // Resumed: the leg was finalized by an earlier attempt, so it is at least
    // as deep as the tip now; ten more blocks from here is conservative.
    spendableAt = freshGrinTip(lane, 'for the resumed payment');
  }
  const target = spendableAt + GRIN_SETTLE_BLOCKS;
  lane.progress(`${sent.id}: spendable for ${sent.to} at Grin height ${spendableAt}; waiting for height ${target}`);
  for (;;) {
    await recipient.footage.pollWait(POLL_MS, 'Waiting for ten more Grin blocks');
    // Looking at the coin keeps the wallet refreshing, which is what asks for the tip.
    await openCoin(lane, recipient, 'grin');
    const tip = freshGrinTip(lane, 'while waiting for ten blocks');
    if (tip >= target) {
      lane.progress(`${sent.id}: Grin tip ${tip}, ${tip - spendableAt} blocks past spendable`);
      await recipient.footage.result('Ten Grin blocks past spendable');
      break;
    }
    if (Date.now() > deadline) throw new Error(`${sent.id}: the Grin tip reached only ${tip} of ${target} in time`);
  }
  if (sent.senderBefore !== undefined) {
    const s = headerTotal(await openCoin(lane, sender, 'grin'));
    const spent = sent.senderBefore - s;
    const fee = sent.feeAtomic ?? 0n;
    expect(spent >= sent.amountAtomic + fee - tol && spent <= sent.amountAtomic + SPEND_CAPS.grin.feeCap + tol, 'the sender paid the amount and a capped fee').toBe(true);
    await sender.footage.result('Sender Grin balance after the payment');
  } else {
    lane.progress(`${sent.id}: resumed leg: the sender's balance movement is not checked in this attempt`);
  }
  lane.progress(`${sent.id}: settled`);
}

/**
 * The Grin history sheets once the payment is ten blocks deep. Grin history
 * is the wallet's own journal, kept per profile; a side whose current profile
 * did not take part says so in the progress log instead of failing on a row
 * it cannot have. The sender's "finalized" is the wallet's own label, set when
 * it broadcast: the chain evidence is the recipient's spendable balance and
 * the tip height checked by grinSettled.
 */
export async function grinHistoryDetail(lane: LiveLane, sent: GrinSent): Promise<void> {
  const sender = lane.wallets[sent.from];
  const recipient = lane.wallets[sent.to];
  const entry = lane.ledger.get(sent.id);
  if (entry?.senderProfile === sender.profileId) {
    await openCoin(lane, sender, 'grin');
    const d = await openDetail(sender, { kernel: sent.kernel }, 'Open the send');
    expect(d, `${sent.from} lists the Grin send by its kernel`).not.toBeNull();
    expectSenderDetail('grin', d!, { amountAtomic: sent.amountAtomic, journal: true });
    expect(d!.fields.Kernel, 'the sheet names the kernel').toBe(sent.kernel);
    expect(d!.fields['Slate ID'], 'the sheet names the slate').toBeTruthy();
    expect(d!.fields['Network fee'], 'the sheet shows the fee').toBeTruthy();
    expect(d!.fields.Status, 'the wallet marks the send finalized').toBe('finalized');
    await sender.footage.result('Grin send detail: amount, fee, time, kernel, slate');
    await checkExplorer(sender, sent.kernel);
    await sender.footage.result('Back on the send detail');
    await closeDetail(sender);
  } else {
    lane.progress(`${sent.id}: ${sent.from}'s current profile did not send it, so its Grin history row cannot exist here`);
  }
  if (entry?.recipientProfile === recipient.profileId) {
    await openCoin(lane, recipient, 'grin');
    const r = await openDetail(recipient, { grinIncomingAmount: fromAtomic('grin', sent.amountAtomic, 8) }, 'Open the receive');
    expect(r, `${sent.to} lists the Grin receive`).not.toBeNull();
    expect(r!.fields.Direction, 'recipient sees Received').toBe('Received');
    expect(r!.fields.Amount, 'recipient sees the amount').toBe(`${fromAtomic('grin', sent.amountAtomic, 12)} GRIN`);
    expect(r!.fields.Time, 'the receive has a time').toBeTruthy();
    expect(['pending', 'finalized'], 'the receive has a status').toContain(r!.fields.Status ?? '');
    await recipient.footage.result('Grin receive detail: amount, time, status');
    if (r!.hasExplorer && r!.fields.Kernel) {
      await checkExplorer(recipient, r!.fields.Kernel);
      await recipient.footage.result('Back on the receive detail');
    }
    await closeDetail(recipient);
  } else {
    lane.progress(`${sent.id}: ${sent.to}'s current profile did not receive it, so its Grin history row cannot exist here`);
  }
  lane.progress(`${sent.id}: Grin history detail checked`);
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
    await w.footage.settled('Pay-link pasted');
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
// Dapp approvals
// ---------------------------------------------------------------------------

const SHOP_ORIGIN = 'http://smirk-dummy-shop.test';

/** Answer the approval window's lock screen, if it shows one, and wait for its prompt. */
async function readyApproval(w: LiveWallet, approval: Page, prompt: string): Promise<void> {
  await Promise.race([
    approval.getByTestId('lockscreen-password-input').waitFor({ timeout: 30_000 }).catch(() => {}),
    approval.getByRole('button', { name: 'Deny' }).waitFor({ timeout: 30_000 }).catch(() => {}),
  ]);
  await w.answerPasswordPrompt(approval);
  await expect(approval.locator('body')).toContainText(prompt, { timeout: 30_000 });
}

/**
 * A shop page, on camera from start to finish: it connects through the
 * wallet's connect approval (Approve), asks for a payment that the approval
 * popup must show in human units (Deny, so the shop hears a refusal), then
 * disconnects. Broadcasts are blocked throughout. The shop first disconnects
 * so the connect prompt always appears, whatever an earlier attempt left.
 */
export async function dappApprovals(lane: LiveLane, w: LiveWallet, to: WalletName): Promise<void> {
  const address = lane.book.get(to, 'wow');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Demo shop</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:420px;background:#fff">
<h1 style="font-size:20px">Demo shop checkout</h1>
<p><button id="disconnect" style="padding:10px 14px;font-size:15px">Disconnect wallet</button></p>
<p><button id="connect" style="padding:10px 14px;font-size:15px">Connect wallet</button></p>
<p><button id="pay" style="padding:12px 18px;font-size:16px">Pay 0.5 WOW</button></p>
<pre id="out"></pre>
<script>
const out = document.getElementById('out');
document.getElementById('disconnect').addEventListener('click', async () => {
  try { await window.smirk.disconnect(); out.textContent = (await window.smirk.isConnected()) ? 'still connected' : 'disconnected'; }
  catch (e) { out.textContent = 'err:' + (e && e.message); }
});
document.getElementById('connect').addEventListener('click', async () => {
  try { await window.smirk.connect(['wow']); out.textContent = (await window.smirk.isConnected()) ? 'connected' : 'not connected'; }
  catch (e) { out.textContent = 'err:' + (e && e.message); }
});
document.getElementById('pay').addEventListener('click', async () => {
  try { const r = await window.smirk.requestPayment({ asset: 'wow', amount: '0.5', address: ${JSON.stringify(address)} });
    out.textContent = 'paid'; }
  catch (e) { out.textContent = 'err:' + (e && e.message); }
});
</script></body></html>`;
  const shop = await w.context.newPage();
  const shopFootage = w.footageFor(shop, 'shop');
  const out = shop.locator('#out');
  const nextApproval = () =>
    w.context.waitForEvent('page', { predicate: (p) => p.url().includes('#approval'), timeout: 60_000 });
  const { attempted } = await w.broadcasts.blocking(async () => {
    await shop.route(`${SHOP_ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await shop.goto(`${SHOP_ORIGIN}/`);
    await shop.waitForFunction(
      () => typeof (window as unknown as { smirk?: { connect?: unknown } }).smirk?.connect === 'function',
      null,
      { timeout: 30_000 },
    );
    await shopFootage.settled('Shop checkout');

    await shopFootage.tap(shop.locator('#disconnect'), 'Disconnect first, so Connect must ask');
    await expect(out).toHaveText('disconnected', { timeout: 30_000 });
    await shopFootage.result('Shop not connected');

    const connectOpened = nextApproval();
    await shopFootage.tap(shop.locator('#connect'), 'Connect the wallet');
    const connect = await connectOpened;
    const connectFootage = w.footageFor(connect, 'approval');
    await readyApproval(w, connect, 'Connect this site?');
    await expect(connect.locator('body')).toContainText(/wow/i);
    await connectFootage.result('Connect request for WOW');
    await connectFootage.tap(connect.getByRole('button', { name: 'Approve' }), 'Approve the connection');
    await expect(out).toHaveText('connected', { timeout: 30_000 });
    await shopFootage.result('The shop is connected');

    const payOpened = nextApproval();
    await shopFootage.tap(shop.locator('#pay'), 'Pay on the shop');
    const pay = await payOpened;
    const payFootage = w.footageFor(pay, 'approval');
    await readyApproval(w, pay, 'Send WOW?');
    const body = pay.locator('body');
    await expect(body).toContainText('0.5 WOW');
    await expect(body).toContainText(address);
    await expect(body).not.toContainText('atomic units');
    await expect(body).not.toContainText('Cannot convert');
    await payFootage.result('Payment approval in human units');
    await payFootage.tap(pay.getByRole('button', { name: 'Deny' }), 'Deny');
    await expect(out).toHaveText(/^err:/, { timeout: 30_000 });
    await shopFootage.result('The shop hears the payment was denied');

    await shopFootage.tap(shop.locator('#disconnect'), 'Disconnect the wallet');
    await expect(out).toHaveText('disconnected', { timeout: 30_000 });
    await shopFootage.result('Shop disconnected again');
  });
  expect(attempted, 'the approval checks broadcast nothing').toBe(0);
  await shop.close();
  await w.page.bringToFront();
  lane.progress(`${w.name}: dapp connect approved, payment of 0.5 WOW to ${to} shown in human units and denied, disconnected; nothing broadcast`);
}
