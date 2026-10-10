/**
 * C-tips live actions: composing, claiming, reclaiming and inspecting tips in
 * the real wallet UI, plus Node-side reads of the backend's public tip record.
 *
 * Every tap goes through the guarded footage helpers (tap, fill, secretFill,
 * settled, result), so the dead-air policy and the capture guard apply to each
 * step. Claim links are carried in memory as SecretLink values: they are typed
 * only inside a secret scope, never printed, and their fragments are registered
 * with the canary the moment they are read.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { BACKEND_URL } from './extension.js';
import type { LiveWallet, TipLane } from './C-tips-live.js';
import { walletPassword } from './C-tips-live.js';
import { TIP_LINK_SOURCE } from './C-tips-guard.mjs';

export type TipAsset = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';

export const DECIMALS: Record<TipAsset, number> = { btc: 8, ltc: 8, xmr: 12, wow: 11, grin: 9 };
/** Home row precision (assets' displayDecimals): rows truncate to this. */
export const DISPLAY_DECIMALS: Record<TipAsset, number> = { btc: 8, ltc: 4, xmr: 4, wow: 2, grin: 2 };
export const TICKER: Record<TipAsset, string> = { btc: 'BTC', ltc: 'LTC', xmr: 'XMR', wow: 'WOW', grin: 'GRIN' };
/**
 * Headroom over the tip amount a sender needs for network fees. A wallet short
 * of amount + margin skips that tip with a reason instead of failing.
 */
export const FEE_MARGIN: Record<TipAsset, string> = {
  btc: '0.00005',
  ltc: '0.001',
  xmr: '0.001',
  wow: '0.5',
  grin: '0.1',
};
/** The backend's confirmation gate before a link goes live (XMR 10, WOW 4, GRIN about 10). */
export const CONFIRMING_ASSETS: readonly TipAsset[] = ['xmr', 'wow', 'grin'];

const MINUTE = 60_000;

/** A decimal amount in an asset's atomic units. */
export function toAtomic(asset: TipAsset, decimal: string): bigint {
  const text = decimal.trim();
  const match = text.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new Error(`not a decimal amount for ${asset}`);
  const decimals = DECIMALS[asset];
  const fraction = (match[3] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const value = BigInt(match[2] || '0') * 10n ** BigInt(decimals) + BigInt(fraction || '0');
  return match[1] === '-' ? -value : value;
}

/** One unit of the Home row's last displayed digit. */
export function displayUnit(asset: TipAsset): bigint {
  return 10n ** BigInt(DECIMALS[asset] - DISPLAY_DECIMALS[asset]);
}

/**
 * A claim link held in memory. It renders as a placeholder everywhere (string
 * conversion, JSON, inspection), so an assertion message or log cannot carry it.
 */
export class SecretLink {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  get fragment(): string {
    return this.#value.split('#')[1] ?? '';
  }
  toString(): string {
    return '[tip claim link withheld]';
  }
  toJSON(): string {
    return '[tip claim link withheld]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[tip claim link withheld]';
  }
}

export interface CreatedTip {
  readonly tipId: string;
  readonly asset: TipAsset;
  readonly amount: string;
  readonly amountAtomic: bigint;
  readonly sender: LiveWallet;
  /** Recipient for a person tip (bob), absent for a link tip. */
  readonly recipient?: LiveWallet;
  /** What the composer showed as the recipient ("npub1…" or "bob@smirk.cash"). */
  readonly recipientDisplay?: string;
  readonly memo?: string;
  readonly expiryDays: 1 | 7 | 30;
  readonly submittedAtMs: number;
  /** The live link (BTC/LTC link tips at once; XMR/WOW/GRIN once confirmed; a failed delivery's fallback). */
  link: SecretLink | null;
}

export interface Holdings {
  /**
   * Available + incoming pending + locked, in atomic units, as the Home row
   * shows them. A BTC/LTC row's pending is signed: a mempool spend reads
   * negative while the available figure already nets it out, so a negative
   * pending is left out instead of counting the spend twice.
   */
  total: bigint;
  available: bigint;
  pending: bigint;
  locked: bigint;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** If the wallet locked, unlock it behind a redaction card. */
export async function ensureUnlocked(lane: TipLane, w: LiveWallet): Promise<void> {
  const lock = w.page.getByTestId('lockscreen-password-input');
  if (!(await lock.isVisible().catch(() => false))) return;
  await lane.footage.secret(w.page, 'Unlock with the wallet password', async () => {
    await lock.fill(walletPassword(w), { timeout: 60_000 });
    await w.page.getByTestId('lockscreen-unlock-btn').click({ timeout: 60_000 });
    await expect(lock).toHaveCount(0, { timeout: 60_000 });
  });
}

/** Confirm an operation password prompt, if the wallet policy asks for one. */
export async function confirmIfAsked(lane: TipLane, w: LiveWallet): Promise<void> {
  const prompt = w.page.getByTestId('operation-password');
  const asked = await prompt.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!asked) return;
  await lane.footage.secret(w.page, 'Confirm with the wallet password', async () => {
    await prompt.fill(walletPassword(w), { timeout: 60_000 });
    await w.page.getByTestId('operation-password-confirm').click({ timeout: 60_000 });
    await expect(prompt).toHaveCount(0, { timeout: 60_000 });
  });
}

export async function tabRoot(lane: TipLane, w: LiveWallet, tab: 'home' | 'inbox' | 'settings'): Promise<void> {
  await ensureUnlocked(lane, w);
  const nav = w.page.getByTestId(`nav-tab-${tab}`);
  await lane.footage.tap(nav, `Open the ${tab} tab`);
  // A second tap on the active tab returns to its root.
  await lane.footage.tap(nav, `Back to the ${tab} root`);
}

export async function openInbox(lane: TipLane, w: LiveWallet): Promise<void> {
  await tabRoot(lane, w, 'inbox');
  await expect(w.page.getByTestId('inbox-tab')).toBeVisible({ timeout: 30_000 });
  await lane.footage.settled(w.page, 'Inbox');
}

/** Settings > Sent tips. Settings' root is carded by the strict guard while passing through. */
export async function openSentTips(lane: TipLane, w: LiveWallet): Promise<void> {
  await tabRoot(lane, w, 'settings');
  await lane.footage.tap(w.page.getByTestId('settings-sent-tips-nav'), 'Open Sent tips');
  // The Sent tips header's refresh control: Settings' root has none.
  await expect(w.page.getByRole('button', { name: '⟳' })).toBeVisible({ timeout: 30_000 });
  await expect(w.page.getByTestId('settings-sent-tips-nav')).toHaveCount(0);
  await lane.footage.settled(w.page, 'Sent tips list');
}

export async function refreshSentTips(lane: TipLane, w: LiveWallet): Promise<void> {
  await lane.footage.tap(w.page.getByRole('button', { name: '⟳' }), 'Refresh Sent tips');
  await lane.footage.settled(w.page, 'Sent tips refreshed');
}

export async function refreshInbox(lane: TipLane, w: LiveWallet): Promise<void> {
  await lane.footage.tap(w.page.getByTestId('inbox-tab').getByRole('button', { name: 'Refresh' }), 'Refresh the Inbox');
  await lane.footage.settled(w.page, 'Inbox refreshed');
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

function parseDisplayed(asset: TipAsset, text: string | undefined): bigint {
  if (!text) return 0n;
  const number = text.replace(/[^\d.\-]/g, '');
  return number ? toAtomic(asset, number) : 0n;
}

/** Read one Home asset row (the Home tab must be showing). */
export async function readHoldings(w: LiveWallet, asset: TipAsset): Promise<Holdings> {
  const row = w.page.getByTestId(`asset-row-${asset}`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  const balance = w.page.getByTestId(`asset-row-${asset}-balance`);
  await expect
    .poll(async () => /\d/.test((await balance.textContent()) ?? ''), { timeout: 2 * MINUTE })
    .toBe(true);
  const main = (await balance.textContent()) ?? '';
  const whole = (await row.textContent()) ?? '';
  const available = parseDisplayed(asset, main.match(/-?[\d.]+/)?.[0]);
  const pending = parseDisplayed(asset, whole.match(/\+\s*(-?[\d.]+)[^\d]*?pending/)?.[1]);
  const locked = parseDisplayed(asset, whole.match(/🔒\s*(-?[\d.]+)[^\d]*?locked/)?.[1]);
  return { available, pending, locked, total: available + (pending > 0n ? pending : 0n) + locked };
}

/** Show Home, let it settle, read a row, and hold the balances on screen. */
export async function showHoldings(lane: TipLane, w: LiveWallet, asset: TipAsset, label: string): Promise<Holdings> {
  await tabRoot(lane, w, 'home');
  await lane.footage.settled(w.page, 'Home balances');
  const holdings = await readHoldings(w, asset);
  await lane.footage.result(w.page, label);
  return holdings;
}

/**
 * Wait until the Home row for `asset` satisfies `ok`, re-opening Home every
 * minute so the wallet refreshes. Returns the holdings that satisfied it.
 */
export async function waitForHoldings(
  lane: TipLane,
  w: LiveWallet,
  asset: TipAsset,
  ok: (h: Holdings) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Holdings> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await tabRoot(lane, w, 'home');
    await lane.footage.settled(w.page, 'Home balances');
    const holdings = await readHoldings(w, asset);
    if (ok(holdings)) {
      await lane.footage.result(w.page, label);
      return holdings;
    }
    if (Date.now() > deadline) {
      throw new Error(`${w.name}'s ${TICKER[asset]} balance did not reach the expected state: ${label}`);
    }
    await w.page.waitForTimeout(MINUTE);
  }
}

// ---------------------------------------------------------------------------
// Backend public tip record (Node side, unauthenticated)
// ---------------------------------------------------------------------------

export interface PublicTipState {
  status: string;
  asset: string;
  amount: number;
  isPublic: boolean;
  fundingConfirmations: number;
  confirmationsRequired: number;
  isClaimable: boolean;
  /** The sealed key's ciphertext, kept only to check a forged key against it. */
  encryptedKey: string | null;
}

/** GET /tips/social/:id/public. Null for an unknown tip. Values are never logged. */
export async function publicTip(tipId: string): Promise<PublicTipState | null> {
  const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/tips/social/${encodeURIComponent(tipId)}/public`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`public tip lookup answered HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: String(body.status ?? ''),
    asset: String(body.asset ?? ''),
    amount: Number(body.amount ?? NaN),
    isPublic: body.is_public === true,
    fundingConfirmations: Number(body.funding_confirmations ?? 0),
    confirmationsRequired: Number(body.confirmations_required ?? 0),
    isClaimable: body.is_claimable === true,
    encryptedKey: typeof body.encrypted_key === 'string' ? body.encrypted_key : null,
  };
}

/**
 * Poll the public record until `done`. Returns every sample, so callers can
 * assert that confirmations only rise. A lookup error is retried; it never
 * counts as progress.
 */
export async function waitForPublicTip(
  tipId: string,
  done: (s: PublicTipState) => boolean,
  timeoutMs: number,
  what: string,
): Promise<PublicTipState[]> {
  const samples: PublicTipState[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await publicTip(tipId).catch(() => undefined);
    if (state) {
      samples.push(state);
      if (done(state)) return samples;
    }
    if (Date.now() > deadline) {
      const last = samples.at(-1);
      throw new Error(
        `tip did not reach ${what} in time; last status ${last?.status ?? 'unknown'}, ` +
          `confirmations ${last ? `${last.fundingConfirmations}/${last.confirmationsRequired}` : 'unknown'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

/** The TipDetailSheet phase a pending tip's public record implies (tipTimeline's rule). */
export function pendingPhase(state: PublicTipState): 'confirming' | 'claimable' {
  return state.fundingConfirmations >= Math.max(1, state.confirmationsRequired) ? 'claimable' : 'confirming';
}

/** Confirmations never go backwards, and they end at or past the gate. */
export function expectConfirmationsRose(samples: PublicTipState[]): void {
  const counts = samples.map((s) => s.fundingConfirmations);
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i]!, 'funding confirmations went backwards').toBeGreaterThanOrEqual(counts[i - 1]!);
  }
  const last = samples.at(-1)!;
  expect(last.fundingConfirmations).toBeGreaterThanOrEqual(last.confirmationsRequired);
  if (counts[0]! < last.confirmationsRequired) expect(counts.at(-1)!).toBeGreaterThan(counts[0]!);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface TipPlan {
  asset: TipAsset;
  /** Decimal amount in the asset's unit. */
  amount: string;
  /** For a person tip: the recipient wallet and what to type (npub or handle). */
  recipient?: { wallet: LiveWallet; text: string; display: string };
  memo?: string;
  expiryDays?: 1 | 7 | 30;
  /** A person tip whose delivery the harness blocks: expect the warning and fallback link. */
  deliveryFails?: boolean;
  /** Static caption for the footage. */
  label: string;
}

async function readAvailable(page: Page, asset: TipAsset): Promise<bigint | null> {
  const text = await page.locator('#root').innerText();
  const match = text.match(new RegExp(`Available:\\s*([\\d.]+)\\s*${TICKER[asset]}`));
  return match ? toAtomic(asset, match[1]!) : null;
}

/** Open the composer with `asset` selected. */
async function openComposer(lane: TipLane, w: LiveWallet, asset: TipAsset): Promise<void> {
  await tabRoot(lane, w, 'home');
  await lane.footage.tap(w.page.getByTestId('home-action-tip'), 'Open the tip composer');
  await expect(w.page.getByTestId('tip-submit-btn')).toBeVisible({ timeout: 30_000 });
  await lane.footage.tap(w.page.getByTestId('tip-asset-dropdown'), 'Choose the coin');
  await lane.footage.tap(w.page.getByTestId(`tip-asset-option-${asset}`), `Pick ${TICKER[asset]}`);
  await expect(w.page.getByTestId('tip-asset-dropdown')).toContainText(TICKER[asset]);
}

/**
 * Wait until the composer's spendable balance covers amount + fee headroom:
 * CryptoNote and Grin change stays locked for blocks after each send. Returns
 * false when the wallet's whole holding is short, so the caller can skip.
 */
export async function waitForSpendable(
  lane: TipLane,
  w: LiveWallet,
  asset: TipAsset,
  amount: string,
  timeoutMs = 45 * MINUTE,
): Promise<boolean> {
  const need = toAtomic(asset, amount) + toAtomic(asset, FEE_MARGIN[asset]);
  await tabRoot(lane, w, 'home');
  await lane.footage.settled(w.page, 'Home balances');
  const holdings = await readHoldings(w, asset);
  if (holdings.total < need) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await openComposer(lane, w, asset);
    const available = await readAvailable(w.page, asset);
    if (available !== null && available >= need) return true;
    await lane.footage.tap(w.page.getByRole('button', { name: 'Cancel' }), 'Leave the composer while change unlocks');
    if (Date.now() > deadline) {
      throw new Error(`${w.name}'s ${TICKER[asset]} never became spendable for this tip (locked change did not unlock)`);
    }
    await w.page.waitForTimeout(2 * MINUTE);
  }
}

/** The date string the wallet renders for `ms` (browser locale). */
export async function browserDate(page: Page, ms: number): Promise<string> {
  return page.evaluate((t) => new Date(t).toLocaleDateString(), ms);
}

/**
 * Compose and submit a tip from `w`. Asserts the composer's affordances, the
 * success screen, the masked link or its pending state, and the backend's
 * public record. The composer must already be open on the right asset
 * (waitForSpendable leaves it there).
 */
export async function composeTip(lane: TipLane, w: LiveWallet, plan: TipPlan): Promise<CreatedTip> {
  const page = w.page;
  const person = plan.recipient;
  lane.footage.chapter(plan.label);

  if (person) {
    await lane.footage.fill(page.getByTestId('tip-recipient-input'), person.text, 'Type the recipient');
    await expect(page.getByTestId('tip-recipient-hint')).toContainText(`Only ${person.display} can claim`, {
      timeout: 60_000,
    });
    const memo = page.getByTestId('tip-memo-input');
    await expect(memo).toBeVisible();
    if (plan.memo) await lane.footage.fill(memo, plan.memo, 'Write a message for the recipient');
  } else {
    await expect(page.getByTestId('tip-recipient-hint')).toContainText('link anyone can claim');
    // A link tip carries no message: the backend stores none for it.
    await expect(page.getByTestId('tip-memo-input')).toHaveCount(0);
  }

  await lane.footage.fill(page.getByTestId('tip-amount-input'), plan.amount, 'Enter the amount');
  await expect(page.locator('#root')).not.toContainText('Insufficient balance');
  const expiryDays = plan.expiryDays ?? 7;
  await expect(page.getByTestId(`tip-expiry-${expiryDays}d`)).toBeVisible();
  if (expiryDays !== 7) {
    await lane.footage.tap(page.getByTestId(`tip-expiry-${expiryDays}d`), 'Choose when it becomes reclaimable');
  }

  const submit = page.getByTestId('tip-submit-btn');
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  // The submit button names who the tip goes to.
  await expect(submit).toHaveText(person ? `Send to ${person.display}` : 'Create tip link');
  await lane.footage.settled(page, 'Composer filled in');

  // The create call's response names the tip id; the success screen shows a prefix.
  const created = w.context
    .waitForEvent('response', {
      predicate: (r) => r.request().method() === 'POST' && /\/tips\/social$/.test(new URL(r.url()).pathname),
      timeout: 10 * MINUTE,
    })
    .then((r) => r.json() as Promise<{ tip_id?: string }>)
    .then((body) => (typeof body.tip_id === 'string' ? body.tip_id : null), () => null);
  const submittedAtMs = Date.now();
  await lane.footage.tap(submit, person ? 'Send the tip' : 'Create the tip link');
  await confirmIfAsked(lane, w);

  const heading = page.getByTestId('tip-success-heading');
  await expect(heading.or(page.getByTestId('tip-error'))).toBeVisible({ timeout: 10 * MINUTE });
  await expect(page.getByTestId('tip-error'), 'the tip was refused').toHaveCount(0);
  await expect(heading).toHaveText(person ? 'Tip sent' : 'Tip link created');
  await expect(page.locator('#root')).toContainText(`${plan.amount} ${TICKER[plan.asset]}`);
  const prefix = ((await page.getByTestId('tip-id-label').textContent()) ?? '').match(/[0-9a-f-]{12}/i)?.[0] ?? '';
  expect(prefix, 'the success screen names the tip id').toMatch(/^[0-9a-f-]{12}$/i);

  let link: SecretLink | null = null;
  const pendingLink = CONFIRMING_ASSETS.includes(plan.asset);
  if (person && plan.deliveryFails) {
    // Funds left the wallet before delivery ran: a funded tip, a warning, and
    // the share link (masked) as the fallback to forward by hand.
    await expect(page.getByTestId('tip-delivery-warning')).toContainText(/could not be delivered|delivery to .* failed/);
    await expect(page.getByTestId('tip-delivery-warning')).toContainText('Tips, sent');
    const shareUrl = page.getByTestId('tip-share-url');
    await expect(shareUrl).toBeVisible();
    link = await readLink(lane, shareUrl, prefix);
  } else if (person) {
    await expect(page.getByTestId('tip-success-detail')).toContainText(`Delivered privately to ${person.display}`);
    await expect(page.getByTestId('tip-delivery-warning')).toHaveCount(0);
    // A delivered person tip never shows its link.
    await expect(page.getByTestId('tip-share-url')).toHaveCount(0);
  } else if (pendingLink) {
    // XMR, WOW and GRIN: the link stays hidden until funding confirms.
    await expect(page.getByTestId('tip-share-pending')).toContainText('Waiting for funding to confirm');
    await expect(page.getByTestId('tip-share-url')).toHaveCount(0);
    await expect(page.getByTestId('tip-copy-link-btn')).toHaveCount(0);
  } else {
    const shareUrl = page.getByTestId('tip-share-url');
    await expect(shareUrl).toBeVisible();
    link = await readLink(lane, shareUrl, prefix);
    await expect(page.getByTestId('tip-share-pending')).toHaveCount(0);
    await expect(page.getByTestId('tip-copy-link-btn')).toBeVisible();
  }
  await lane.footage.result(page, person ? 'Tip sent' : 'Tip link created');
  await lane.footage.tap(page.getByTestId('tip-success-done-btn'), 'Done');

  const tipId = (await created) ?? (await findTipIdByPrefix(lane, w, prefix));
  expect(tipId.startsWith(prefix), 'the created tip is the one on the success screen').toBe(true);
  if (link) expect(link.reveal().includes(`/tip/${tipId}#`), 'the link names this tip').toBe(true);

  const record = await waitForPublicTip(
    tipId,
    (s) => s.status === 'pending' || s.status === 'pending_confirmation',
    5 * MINUTE,
    'funded',
  );
  const state = record.at(-1)!;
  expect(state.asset).toBe(plan.asset);
  expect(BigInt(state.amount)).toBe(toAtomic(plan.asset, plan.amount));
  expect(state.isPublic, 'every tip is funded as a link tip').toBe(true);

  return {
    tipId,
    asset: plan.asset,
    amount: plan.amount,
    amountAtomic: toAtomic(plan.asset, plan.amount),
    sender: w,
    ...(person ? { recipient: person.wallet, recipientDisplay: person.display } : {}),
    ...(plan.memo && person ? { memo: plan.memo } : {}),
    expiryDays,
    submittedAtMs,
    link,
  };
}

/** Read a claim link out of an element into memory; the frame masks it meanwhile. */
export async function readLink(lane: TipLane, element: Locator, tipIdPrefix: string): Promise<SecretLink> {
  const text = ((await element.textContent()) ?? '').trim();
  const match = text.match(new RegExp(`https?://\\S*${TIP_LINK_SOURCE}`));
  if (!match) throw new Error('the element does not hold a tip claim link');
  const link = new SecretLink(match[0]);
  lane.footage.registerSecret(link.fragment);
  expect(link.reveal().includes(`/tip/${tipIdPrefix}`), 'the link names this tip').toBe(true);
  return link;
}

async function findTipIdByPrefix(lane: TipLane, w: LiveWallet, prefix: string): Promise<string> {
  await openSentTips(lane, w);
  const card = w.page.locator(`[data-testid^="sent-tip-card-${prefix}"]`).first();
  await expect(card).toBeVisible({ timeout: 2 * MINUTE });
  return ((await card.getAttribute('data-testid')) ?? '').replace('sent-tip-card-', '');
}

// ---------------------------------------------------------------------------
// Sent tips rows and the detail sheet
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Who a Sent tips row names: the recipient's short npub from the sender's own
 * gift-wrap copy, else the label the composer showed; "link" for a link tip.
 */
export function recipientPattern(tip: CreatedTip): RegExp {
  if (!tip.recipient) return /→ link/;
  const options = [tip.recipient.shortNpub, tip.recipientDisplay ?? tip.recipient.shortNpub].map(escapeRegExp);
  return new RegExp(`(${options.join('|')})`);
}

function reclaimDate(page: Page, tip: CreatedTip): Promise<string> {
  return browserDate(page, tip.submittedAtMs + tip.expiryDays * 86_400_000);
}

export function sentCard(w: LiveWallet, tip: CreatedTip): Locator {
  return w.page.getByTestId(`sent-tip-card-${tip.tipId}`);
}

/** Open a Sent tips row into its TipDetailSheet (Sent tips must be showing). */
export async function openSentDetail(lane: TipLane, w: LiveWallet, tip: CreatedTip): Promise<Locator> {
  const card = sentCard(w, tip);
  await expect(card).toBeVisible({ timeout: 2 * MINUTE });
  const detail = w.page.getByTestId(`tip-detail-${tip.tipId}`);
  if (!(await detail.isVisible().catch(() => false))) {
    await lane.footage.tap(card.getByTestId('sent-tip-toggle'), 'Open the tip details');
  }
  await expect(detail).toBeVisible();
  return detail;
}

export async function closeSentDetail(lane: TipLane, w: LiveWallet, tip: CreatedTip): Promise<void> {
  const detail = w.page.getByTestId(`tip-detail-${tip.tipId}`);
  if (await detail.isVisible().catch(() => false)) {
    await lane.footage.tap(detail.getByTestId('tip-detail-close'), 'Close the tip details');
  }
}

/**
 * The detail sheet for a tip in `phase`: the status timeline, counterparty,
 * message, dates and tip id, held on screen as a key result.
 */
export async function expectSentDetail(
  lane: TipLane,
  w: LiveWallet,
  tip: CreatedTip,
  phase: 'confirming' | 'claimable' | 'claimed' | 'reclaimed',
): Promise<void> {
  const detail = await openSentDetail(lane, w, tip);
  const timeline = detail.getByTestId('tip-detail-timeline');
  await expect(timeline).toContainText('Funded');
  await expect(timeline).toContainText('Confirmed');
  if (phase === 'confirming') await expect(timeline).toContainText(/\d+\/\d+/);
  if (phase === 'claimable') await expect(timeline).toContainText('ready to claim');
  if (phase === 'claimed') await expect(timeline).toContainText('Claimed');
  if (phase === 'reclaimed') await expect(timeline).toContainText(/Reclaimed\s*returned to the sender/);
  await expect(detail).toContainText(TICKER[tip.asset]);
  await expect(detail).toContainText(tip.recipient ? recipientPattern(tip) : /to link/);
  if (tip.memo) await expect(detail.getByTestId('tip-detail-memo')).toContainText(tip.memo);
  await expect(detail).toContainText('Created');
  await expect(detail).toContainText('Tip id');
  await expect(detail).toContainText(tip.tipId);
  // A link tip's reclaim date lives in the local key backup, which a reclaim
  // deletes; a person tip's lives in the sender's own gift-wrap copy.
  if (phase !== 'reclaimed' || tip.recipient) {
    await expect(detail).toContainText('Reclaimable');
    await expect(detail).toContainText(await reclaimDate(w.page, tip));
  }
  await lane.footage.result(w.page, `Tip details: ${phase}`);
  await closeSentDetail(lane, w, tip);
}

const BADGE: Record<string, RegExp> = {
  pending_confirmation: /Confirming/i,
  pending: /Pending claim/i,
  claiming: /Claiming/i,
  claimed: /Claimed/i,
  clawed_back: /Clawed back/i,
};

/** A Sent tips row: ticker, recipient, status badge and, while reclaimable, the date. */
export async function expectSentRow(lane: TipLane, w: LiveWallet, tip: CreatedTip, status: string): Promise<void> {
  const card = sentCard(w, tip);
  await expect(card).toBeVisible({ timeout: 2 * MINUTE });
  await expect(card).toContainText(`${TICKER[tip.asset]} →`);
  await expect(card).toContainText(recipientPattern(tip));
  await expect(card.getByTestId('sent-tip-status-badge')).toHaveText(BADGE[status] ?? new RegExp(status));
  if (status === 'pending' || status === 'pending_confirmation') {
    await expect(card).toContainText(`reclaimable ${await reclaimDate(w.page, tip)}`);
  }
  await lane.footage.result(w.page, 'Sent tips row');
}

/**
 * Watch a confirming link tip go live: the row counts confirmations, the
 * backend's count only rises, and once past the gate the masked link panel
 * appears. Reads the link into memory.
 */
export async function waitForLiveLink(lane: TipLane, tip: CreatedTip, timeoutMs: number): Promise<void> {
  const w = tip.sender;
  lane.footage.chapter(`${TICKER[tip.asset]} link confirming`);
  await openSentTips(lane, w);
  const card = sentCard(w, tip);
  await expect(card).toBeVisible({ timeout: 2 * MINUTE });
  const first = await publicTip(tip.tipId);
  if (first && first.fundingConfirmations < first.confirmationsRequired) {
    // The row counts confirmations while it waits, and offers no link yet.
    if (first.status === 'pending_confirmation') await expect(card).toContainText(/Confirming on chain: \d+\/\d+/);
    await expect(card.getByTestId('sent-tip-copy-link-btn')).toHaveCount(0);
    await expectSentRow(lane, w, tip, first.status);
    await expectSentDetail(lane, w, tip, 'confirming');
  }
  const samples = await waitForPublicTip(
    tip.tipId,
    (s) => s.fundingConfirmations >= s.confirmationsRequired && s.status === 'pending',
    timeoutMs,
    'its confirmation gate',
  );
  expectConfirmationsRose(first ? [first, ...samples] : samples);
  await refreshSentTips(lane, w);
  await expect(card.getByTestId('sent-tip-status-badge')).toHaveText(/Pending claim/i, { timeout: 5 * MINUTE });
  await openSentDetail(lane, w, tip);
  await expect(card.getByTestId('sent-tip-copy-link-btn')).toBeVisible({ timeout: 2 * MINUTE });
  // The link panel has no test id: the deepest element holding the link.
  const holder = card.locator('div').filter({ hasText: new RegExp(TIP_LINK_SOURCE) }).last();
  tip.link = await readLink(lane, holder, tip.tipId);
  await lane.footage.result(w.page, 'The link is live (masked)');
  await closeSentDetail(lane, w, tip);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface SweepReport {
  sweepTxid: boolean;
  keyImages: number;
}

/**
 * Watch for the claimer's /confirm-sweep report and check its shape, never
 * printing a value. The returned promise never rejects unobserved.
 */
function watchSweepReport(w: LiveWallet, tip: CreatedTip): Promise<SweepReport | null> {
  return w.context
    .waitForEvent('request', {
      predicate: (r) =>
        r.method() === 'POST' && new URL(r.url()).pathname.endsWith(`/tips/social/${tip.tipId}/confirm-sweep`),
      timeout: 20 * MINUTE,
    })
    .then(
      (request) => {
        const body = request.postDataJSON() as { sweep_txid?: unknown; key_images?: unknown };
        const images = Array.isArray(body.key_images) ? (body.key_images as Record<string, unknown>[]) : [];
        const wellFormed = images.every(
          (image) =>
            /^[0-9a-f]{64}$/.test(String(image.key_image)) &&
            /^[0-9a-f]{64}$/.test(String(image.output_key)) &&
            /^[0-9a-f]{128}$/.test(String(image.proof)),
        );
        return {
          sweepTxid: /^[0-9a-f]{64}$/i.test(String(body.sweep_txid)),
          keyImages: wellFormed ? images.length : -1,
        };
      },
      () => null,
    );
}

function expectSweepReport(tip: CreatedTip, report: SweepReport | null): void {
  expect(report, 'the claim reported its sweep to the backend').not.toBeNull();
  expect(report!.sweepTxid, 'the sweep report carries a txid').toBe(true);
  expect(report!.keyImages, 'every reported key image is well formed').toBeGreaterThanOrEqual(0);
  if (tip.asset === 'xmr' || tip.asset === 'wow') {
    expect(report!.keyImages, 'an XMR/WOW claim reports the key image it spends').toBeGreaterThan(0);
  }
}

/**
 * Claim a link tip in `w` through Inbox > Paste tip link. The link is typed
 * behind a redaction card and stays masked in the box.
 */
export async function claimLink(lane: TipLane, w: LiveWallet, tip: CreatedTip): Promise<void> {
  if (!tip.link) throw new Error('this tip has no live link to claim yet');
  lane.footage.chapter(`Claim a ${TICKER[tip.asset]} link`);
  await openInbox(lane, w);
  await lane.footage.tap(w.page.getByTestId('inbox-paste-tip-link-btn'), 'Paste a tip link');
  await lane.footage.secretFill(w.page.getByTestId('paste-tip-input'), tip.link.reveal(), 'Paste the tip link');
  await lane.footage.settled(w.page, 'Link pasted (masked)');
  const report = watchSweepReport(w, tip);
  const success = w.page.getByTestId('paste-tip-success');
  const error = w.page.getByTestId('paste-tip-error');
  // A light-wallet server can trail the chain by a block: retry the documented
  // way (the backend's claim is idempotent for the same claimer).
  for (let attempt = 1; ; attempt++) {
    await lane.footage.tap(w.page.getByTestId('paste-tip-claim-btn'), 'Claim');
    await confirmIfAsked(lane, w);
    await expect(success.or(error)).toBeVisible({ timeout: 10 * MINUTE });
    if (await success.isVisible()) break;
    if (attempt >= 5) throw new Error(`the ${TICKER[tip.asset]} link claim kept failing`);
    await lane.footage.result(w.page, 'Claim not ready yet, retrying');
    await w.page.waitForTimeout(2 * MINUTE);
  }
  const title = ((await w.page.getByTestId('paste-tip-success-title').textContent()) ?? '').trim();
  if (/^Received/.test(title)) {
    // "Received <amount> <ticker>": the full tip amount, in this coin.
    expect(title.endsWith(` ${TICKER[tip.asset]}`)).toBe(true);
    expect(toAtomic(tip.asset, title.replace(/[^\d.]/g, ''))).toBe(tip.amountAtomic);
  } else {
    expect(title).toMatch(/Claim sent, confirming/);
  }
  expectSweepReport(tip, await report);
  await lane.footage.result(w.page, 'Tip claimed');
  await lane.footage.tap(w.page.getByTestId('paste-tip-done-btn'), 'Back to the Inbox');
}

/**
 * The recipient's Inbox row for a person tip: amount, sender npub, the exact
 * message and the claim-by date. Waits for it to arrive (and to become
 * claimable when `claimable` is set).
 */
export async function expectInboxTip(
  lane: TipLane,
  w: LiveWallet,
  tip: CreatedTip,
  opts: { claimable: boolean; timeoutMs: number },
): Promise<Locator> {
  const note = w.page.getByTestId(`tip-note-${tip.tipId}`);
  const row = w.page.getByTestId(`tip-claimable-row-${tip.tipId}`);
  const target = opts.claimable ? row : note;
  const deadline = Date.now() + opts.timeoutMs;
  await openInbox(lane, w);
  while (!(await target.isVisible().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`the ${TICKER[tip.asset]} tip never reached ${w.name}'s Inbox`);
    await w.page.waitForTimeout(MINUTE);
    await refreshInbox(lane, w);
  }
  // A waiting tip may cross its gate while we look: read the row it is in now.
  // A pending row has no test id of its own: it is the note's parent.
  const claimableNow = await row.isVisible().catch(() => false);
  const holder = claimableNow ? row : note.locator('xpath=..');
  await expect(holder).toContainText(TICKER[tip.asset]);
  await expect(holder).toContainText(`from ${tip.sender.shortNpub}`);
  if (tip.memo) await expect(note).toContainText(`“${tip.memo}”`);
  await expect(note).toContainText(`Claim by ${await reclaimDate(w.page, tip)}`);
  if (!claimableNow) await expect(holder).toContainText(/\d+ \/ \d+ confs/);
  await lane.footage.result(w.page, claimableNow ? 'Tip ready to claim' : 'Tip waiting for confirmations');
  return holder;
}

async function claimOutcome(row: Locator, timeoutMs: number): Promise<'gone' | 'confirming' | 'error'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await row.isVisible().catch(() => false))) return 'gone';
    if (await row.getByTestId('tip-claim-confirming').isVisible().catch(() => false)) return 'confirming';
    if (await row.getByTestId('tip-claim-error').isVisible().catch(() => false)) return 'error';
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return 'error';
}

/** Claim a person tip from the recipient's Inbox. */
export async function claimFromInbox(lane: TipLane, w: LiveWallet, tip: CreatedTip): Promise<void> {
  lane.footage.chapter(`Claim a ${TICKER[tip.asset]} tip from the Inbox`);
  const row = await expectInboxTip(lane, w, tip, { claimable: true, timeoutMs: 10 * MINUTE });
  const report = watchSweepReport(w, tip);
  for (let attempt = 1; ; attempt++) {
    await lane.footage.tap(row.getByTestId('tip-claim-btn'), 'Claim');
    await confirmIfAsked(lane, w);
    if ((await claimOutcome(row, 10 * MINUTE)) !== 'error') break;
    if (attempt >= 5) throw new Error(`the ${TICKER[tip.asset]} Inbox claim kept failing`);
    await lane.footage.result(w.page, 'Claim not ready yet, retrying');
    await w.page.waitForTimeout(2 * MINUTE);
  }
  expectSweepReport(tip, await report);
  await lane.footage.result(w.page, 'Tip claimed');
}

/** `w`'s holdings rise, by at most the tip (a sweep pays its own fee). */
export async function expectCredited(
  lane: TipLane,
  w: LiveWallet,
  tip: CreatedTip,
  before: Holdings,
  label: string,
): Promise<Holdings> {
  const unit = displayUnit(tip.asset);
  return waitForHoldings(
    lane,
    w,
    tip.asset,
    (h) => h.total >= before.total + unit && h.total <= before.total + tip.amountAtomic + unit,
    40 * MINUTE,
    label,
  );
}

/** The sender's holdings fall by at least the tip amount. */
export async function expectDebited(
  lane: TipLane,
  w: LiveWallet,
  tip: CreatedTip,
  before: Holdings,
): Promise<Holdings> {
  const unit = displayUnit(tip.asset);
  return waitForHoldings(
    lane,
    w,
    tip.asset,
    (h) => h.total + tip.amountAtomic <= before.total + unit,
    20 * MINUTE,
    `${TICKER[tip.asset]} balance after funding the tip`,
  );
}

/** Settled on the backend: claimed (the sweep is borne out on chain). */
export async function waitForSettled(tip: CreatedTip, status: 'claimed' | 'clawed_back', timeoutMs: number): Promise<void> {
  await waitForPublicTip(tip.tipId, (s) => s.status === status, timeoutMs, status);
}

// ---------------------------------------------------------------------------
// Clawback
// ---------------------------------------------------------------------------

/** Reclaim an unclaimed tip from Sent tips, then watch the backend settle it. */
export async function reclaim(lane: TipLane, tip: CreatedTip): Promise<void> {
  const w = tip.sender;
  lane.footage.chapter(`Reclaim a ${TICKER[tip.asset]} tip`);
  const state = await publicTip(tip.tipId);
  expect(state?.status, 'only a pending, unclaimed tip is reclaimed here').toBe('pending');
  await openSentTips(lane, w);
  await expectSentRow(lane, w, tip, 'pending');
  await expectSentDetail(lane, w, tip, pendingPhase(state!));
  const detail = await openSentDetail(lane, w, tip);
  await lane.footage.tap(detail.getByTestId('sent-tip-clawback-btn'), 'Cancel and reclaim');
  await confirmIfAsked(lane, w);
  const message = sentCard(w, tip).getByTestId('sent-tip-row-message');
  await expect(message).toContainText(/Reclaimed|Error/, { timeout: 15 * MINUTE });
  await expect(message, 'the reclaim sweep failed').not.toContainText('Error');
  await lane.footage.result(w.page, 'Tip reclaimed');
  await waitForSettled(tip, 'clawed_back', 30 * MINUTE);
  await refreshSentTips(lane, w);
  await expectSentRow(lane, w, tip, 'clawed_back');
  await expectSentDetail(lane, w, tip, 'reclaimed');
}
