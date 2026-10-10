/**
 * UI flows for the live messaging and federation specs (area D). Every tap,
 * field entry and hold goes through the wallet's `DFootage`, so the pacing and
 * redaction policy is applied in one place. Labels are static prose.
 *
 * Every screen a flow reaches is held: a settled hold once it has stopped
 * changing (tab roots and menus included), a result hold for an outcome. A hold
 * that is never taken cannot be measured, so it belongs here, not in a spec.
 */

import { expect, type Locator } from '@playwright/test';
import { recipientToHex } from '@smirk/core';
import { BACKEND_CONFIG_KEY, dLinkApproved, recordFinding, type DWallet } from './D-messaging-federation-live.js';
import { findWraps, hasDmInbox } from './D-messaging-federation-nostr.js';

export { BACKEND_CONFIG_KEY };

export type DTab = 'home' | 'inbox' | 'feed' | 'settings';

/** Whether `locator` becomes visible within `ms` (`isVisible` does not wait). */
export async function appears(locator: Locator, ms: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout: ms }).then(
    () => true,
    () => false,
  );
}

/** The element that only a tab's ROOT screen shows. */
function tabRoot(w: DWallet, tab: DTab): Locator {
  const page = w.page;
  switch (tab) {
    case 'home':
      return page.getByTestId('home-total-balance');
    case 'inbox':
      return page.getByTestId('inbox-messages-btn');
    case 'feed':
      return page.getByTestId('feed-screen');
    case 'settings':
      return page.getByTestId('settings-backend-nav');
  }
}

/**
 * Reach a tab's root and hold it. A tab tap restores that tab's last
 * sub-screen; tapping the active tab again returns to its root, so at most two
 * taps are needed.
 */
export async function goTab(w: DWallet, tab: DTab): Promise<void> {
  await w.unlock();
  const nav = w.page.getByTestId(`nav-tab-${tab}`);
  const root = tabRoot(w, tab);
  await w.footage.tap(nav, `open the ${tab} tab`);
  // A tab can flash its root and then restore its last sub-screen, so judge
  // the root only once the screen has stopped changing.
  if (!(await stableVisibility(root))) {
    await w.footage.tap(nav, `back to the ${tab} root`);
    await stableVisibility(root);
  }
  await expect(root, `the ${tab} tab root never rendered`).toBeVisible({ timeout: 60_000 });
  await w.footage.settled(`the ${tab} tab`);
}

/** Visibility of `locator` once it has held steady for `steadyMs` (bounded). */
async function stableVisibility(locator: Locator, steadyMs = 1_500, limitMs = 15_000): Promise<boolean> {
  let last = await locator.isVisible();
  let since = Date.now();
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await locator.isVisible();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= steadyMs) {
      return now;
    }
  }
  return last;
}

/** Inbox, then Messages. Returns whether the relay compose surface is up. */
export async function openMessages(w: DWallet): Promise<'on' | 'off'> {
  await goTab(w, 'inbox');
  await w.footage.tap(w.page.getByTestId('inbox-messages-btn'), 'open Messages');
  await expect(w.page.getByTestId('messages-screen')).toBeVisible({ timeout: 60_000 });
  const compose = w.page.getByTestId('dm-recipient-input');
  const off = w.page.getByTestId('messages-relay-off');
  await expect(compose.or(off), 'Messages showed neither its compose surface nor its relay-off notice').toBeVisible({
    timeout: 90_000,
  });
  // While loading, the screen renders the compose branch; the relay-off notice
  // replaces it only once /capabilities answers. Give that answer time to land.
  await appears(off, 8_000);
  await w.footage.settled('Messages is ready');
  return (await off.isVisible()) ? 'off' : 'on';
}

/** Outcome of a send as the wallet reports it. */
export interface DmOutcome {
  status: 'sent' | 'error';
  /** The reach notice (sent only to this server's relay) is showing. */
  notice: boolean;
  /** The red error text, for an error (static rule text from the relay). */
  error?: string;
}

/**
 * Compose and send a DM from the Messages screen and wait for the wallet's own
 * verdict: the text box clears on success, or the error line appears.
 */
export async function sendMessage(w: DWallet, recipient: string, text: string): Promise<DmOutcome> {
  const page = w.page;
  await w.footage.type(page.getByTestId('dm-recipient-input'), recipient, 'enter the recipient');
  await w.footage.type(page.getByTestId('dm-text-input'), text, 'write the message');
  const error = page.getByTestId('messages-error');
  const body = page.getByTestId('dm-text-input');
  const button = page.getByTestId('dm-send-btn');
  // Enabled only once the relay subscription is up and both fields are filled.
  await expect(button, 'Send never enabled: the relay never came up for this identity').toBeEnabled({ timeout: 90_000 });
  await w.footage.tap(button, 'send the message');
  type Verdict = 'sent' | 'error' | 'password' | 'pending';
  const readVerdict = async (): Promise<Verdict> => {
    if (await error.isVisible().catch(() => false)) return 'error';
    if (await page.getByTestId('operation-password').isVisible().catch(() => false)) return 'password';
    const sending = /Sending/.test((await button.textContent().catch(() => '')) ?? '');
    if (!sending && (await body.inputValue().catch(() => text)) === '') return 'sent';
    return 'pending';
  };
  let verdict: Verdict = 'pending';
  for (let round = 0; round < 2; round++) {
    await expect
      .poll(readVerdict, { timeout: 180_000, intervals: [500, 1_000, 2_000] })
      .not.toBe('pending');
    verdict = await readVerdict();
    if (verdict !== 'password') break;
    await w.confirmOperationPassword();
  }
  expect(['sent', 'error'], 'the send never resolved to success or an error').toContain(verdict);
  // The notice renders in the same update as the cleared box; allow a beat.
  const notice = verdict === 'sent' ? await appears(page.getByTestId('messages-reach-notice'), 3_000) : false;
  if (verdict === 'error') {
    return { status: 'error', notice, error: ((await error.textContent()) ?? '').trim() };
  }
  return { status: 'sent', notice };
}

/**
 * Assert the open Messages screen shows `text` from `fromNpub`, then hold the
 * result on screen.
 */
export async function expectMessage(w: DWallet, fromNpub: string, text: string, timeoutMs = 180_000): Promise<void> {
  const item = w.page.getByTestId('message-item').filter({ hasText: text });
  await expect(item, 'the message never arrived decrypted in the recipient\'s Messages').toBeVisible({
    timeout: timeoutMs,
  });
  await expect(item.getByTestId('message-from'), 'the message shows the wrong sender').toHaveText(fromNpub);
  await expect(item.getByTestId('message-text'), 'the message text was altered').toHaveText(text);
  await item.scrollIntoViewIfNeeded();
  await w.footage.result('message received');
}

/**
 * The gift wraps `w`'s page published to `relayUrl` since `mark` (an index into
 * its relay guard's `sentWraps`), by public event id. This is what ties relay
 * evidence to THIS send: another lane writing to the same demo wallet at the
 * same time never shows up here.
 */
export function publishedWraps(w: DWallet, mark: number, relayUrl: string): string[] {
  const host = new URL(relayUrl).host;
  return w.relayGuard.sentWraps.slice(mark).filter((wrap) => wrap.host === host).map((wrap) => wrap.id);
}

/**
 * One DM with evidence on both sides of the wire:
 *   - the sender's verdict is success, and its reach notice shows exactly when
 *     the recipient advertises no inbox (`expectInbox`, else read from the relay);
 *   - `relayUrl` holds the gift wrap the sender's page just published (found by
 *     its id), mined to `powBits`;
 *   - the recipient (when its Messages is open) shows the sender and exact text.
 * `address` is what the sender types: an npub or name@domain.
 */
export async function deliverDm(opts: {
  from: DWallet;
  fromNpub: string;
  to: { wallet?: DWallet; pubkeyHex: string };
  address: string;
  text: string;
  relayUrl: string;
  powBits: number;
  expectInbox?: boolean | null;
  /**
   * Whether the relay admits gift wraps to this recipient (its npub is linked
   * to a Smirk account). False: the honest outcome is the relay's refusal,
   * shown as the wallet's error, with nothing stored and nothing received.
   */
  recipientRegistered?: boolean;
}): Promise<'delivered' | 'refused'> {
  const { from, to, relayUrl } = opts;
  const inbox = opts.expectInbox ?? (await hasDmInbox(relayUrl, to.pubkeyHex));
  const mark = from.relayGuard.sentWraps.length;
  const outcome = await sendMessage(from, opts.address, opts.text);
  const sent = publishedWraps(from, mark, relayUrl);
  if (opts.recipientRegistered === false) {
    expect(outcome.status, 'the wallet claimed delivery to a recipient the relay does not admit').toBe('error');
    expect(outcome.error ?? '', 'the refusal does not say why').toMatch(/registered|refused/i);
    expect(sent.length, 'the wallet reported a refusal without offering the relay a gift wrap').toBeGreaterThan(0);
    await from.footage.result('relay refused delivery');
    expect((await findWraps(relayUrl, to.pubkeyHex, sent, 10_000)).size, 'the relay stored a wrap it refused').toBe(0);
    if (to.wallet) {
      await expect(to.wallet.page.getByTestId('message-item').filter({ hasText: opts.text })).toHaveCount(0);
      await to.wallet.footage.settled('nothing received');
    }
    return 'refused';
  }
  // The error line is the relay's own static refusal rule (or the guard's),
  // never message content, so it is named in the failure.
  expect(outcome.status, `the wallet reported an error for a DM the relay should admit: ${outcome.error ?? ''}`).toBe('sent');
  expect(
    outcome.notice,
    inbox
      ? 'the wallet warned it could not find the recipient\'s inbox, but the recipient advertises one'
      : 'the recipient advertises no inbox, so the wallet must say it only reached this server\'s relay',
  ).toBe(!inbox);
  // The sender's confirmation is a key result either way.
  await from.footage.result(outcome.notice ? 'reach notice shown' : 'message sent');

  expect(sent.length, 'the wallet reported success but published no gift wrap to the relay').toBeGreaterThan(0);
  const stored = await findWraps(relayUrl, to.pubkeyHex, sent);
  expect(stored.size, 'the relay holds none of the gift wraps the wallet just published for the recipient').toBeGreaterThan(0);
  for (const bits of stored.values()) {
    expect(bits, 'a delivered gift wrap carries less proof-of-work than the relay advertises').toBeGreaterThanOrEqual(
      opts.powBits,
    );
  }
  if (to.wallet) await expectMessage(to.wallet, opts.fromNpub, opts.text);
  return 'delivered';
}

/** One DM's outcome, by direction ("alice to bob"; wallet names only). */
export interface DmRecord {
  direction: string;
  outcome: 'delivered' | 'refused';
}

/**
 * A test whose title promises delivery fails when any DM was refused, after
 * each refusal has been shown and asserted honestly. With default flags the
 * unlinked demo wallets are refused by design of the operator relay, which is a
 * release question for the owner (recorded by `ensureLinkState`), not a pass.
 */
export function requireDelivered(records: readonly DmRecord[]): void {
  const refused = records.filter((r) => r.outcome === 'refused').map((r) => r.direction);
  expect(
    refused,
    'DMs were refused because the recipient is not linked, so this test proves less than its title: a comprehensive run needs E2E_LIVE_LINK=1 with ALLOW_PROD_WRITES=1 (owner approval), and whether unlinked v0.3.1 users may go without DMs is a release question',
  ).toEqual([]);
}

/** Static finding text for a wallet the operator relay will not deliver to. */
function unlinkedQuestion(name: string): string {
  return (
    `${name} is not linked to its seed npub, and the operator relay admits gift wraps only to linked npubs, ` +
    `so DMs to ${name} are refused. Release question for the owner: a v0.3.1 user who has not linked cannot ` +
    'receive DMs on the operator relay. Full coverage needs E2E_LIVE_LINK=1 with ALLOW_PROD_WRITES=1.'
  );
}

/**
 * Read whether the account is linked to the seed npub (the hub must be open).
 * The hub answers from /auth/me; the handle line appears once it has. Reads
 * only: `ensureLinkState` is the one place that records or acts on it.
 */
export async function readLinked(w: DWallet): Promise<boolean> {
  await expect(w.page.getByTestId('nostr-handle').or(w.page.getByTestId('nostr-handle-absent'))).toBeVisible({
    timeout: 60_000,
  });
  const badge = w.page.getByTestId('nostr-linked-badge');
  const button = w.page.getByTestId('nostr-link-btn');
  await expect(badge.or(button)).toBeVisible({ timeout: 30_000 });
  return badge.isVisible();
}

/**
 * Link the seed npub to the account from the hub (an owner-approved write).
 * The hub may ask for the password first, in its own field or in the operation
 * prompt; both are answered inside a redaction scope.
 */
export async function linkIdentity(w: DWallet): Promise<void> {
  const badge = w.page.getByTestId('nostr-linked-badge');
  const link = w.page.getByTestId('nostr-link-btn');
  const hubLock = w.page.getByTestId('nostr-unlock-input');
  const prompt = w.page.getByTestId('operation-password');
  const blockedBefore = w.relayGuard.blocked.length;
  await w.footage.tap(link, 'link the identity');
  for (let round = 0; round < 3 && !(await badge.isVisible()); round++) {
    await expect(badge.or(hubLock).or(prompt), 'linking neither took nor asked for the password').toBeVisible({
      timeout: 90_000,
    });
    if (await badge.isVisible()) break;
    if (await prompt.isVisible()) {
      await w.confirmOperationPassword();
      continue;
    }
    await w.unlockHub();
    await w.footage.tap(link, 'link the identity');
  }
  await expect(badge, 'linking the identity did not take').toBeVisible({ timeout: 90_000 });
  w.linked = true;
  await w.footage.result('identity linked');
  // Linking also publishes the account's kind-0 profile. The live lane admits
  // no kind 0, so the guard refuses it; the link itself is a backend write.
  if (w.relayGuard.blocked.slice(blockedBefore).some((b) => b.kind === 0)) {
    recordFinding(
      'not-exercised',
      `linking ${w.name} also publishes a public kind-0 profile; the live lane admits no kind 0, so the relay guard refused it (the link took effect)`,
    );
  }
}

/**
 * The wallet's link state for this worker, read from the identity hub. When
 * the account is not linked and the owner approved linking (`E2E_LIVE_LINK=1`
 * with `ALLOW_PROD_WRITES=1`), it is linked here, as a user would; otherwise
 * the release question is recorded. Every test that needs delivery to a wallet
 * goes through this, so the order the spec files run in does not matter.
 */
export async function ensureLinkState(w: DWallet, opts: { hubOpen?: boolean } = {}): Promise<boolean> {
  if (w.linked !== null) return w.linked;
  if (!opts.hubOpen) await openIdentityHub(w);
  let linked = await readLinked(w);
  if (!linked && dLinkApproved()) {
    await linkIdentity(w);
    recordFinding(
      'setup',
      `${w.name} was not linked to its seed npub; the run linked it with the owner's approval (E2E_LIVE_LINK=1, ALLOW_PROD_WRITES=1)`,
    );
    linked = true;
  } else if (!linked) {
    recordFinding('release-question', unlinkedQuestion(w.name));
  }
  w.linked = linked;
  return linked;
}

/** Header identity chip, then Manage identities: the hub without Settings' root. */
export async function openIdentityHub(w: DWallet): Promise<void> {
  await goTab(w, 'home');
  await w.footage.tap(w.page.getByTestId('header-identity-switcher'), 'open the identity menu');
  const manage = w.page.getByRole('option', { name: /Manage identities/ });
  await expect(manage, 'the identity menu did not open').toBeVisible({ timeout: 30_000 });
  await w.footage.settled('identity menu');
  await w.footage.tap(manage, 'manage identities');
  await expect(w.page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 60_000 });
  await w.footage.settled('identity hub');
}

/** Pubkeys of the identities the hub lists. */
export async function hubIdentityHexes(w: DWallet): Promise<string[]> {
  const ids = await w.page
    .locator('[data-testid^="nostr-identity-"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid ?? ''));
  return ids.map((id) => id.replace(/^nostr-identity-/, '')).filter((hex) => /^[0-9a-f]{64}$/.test(hex));
}

/** The claimed handle (`name@domain`) the hub shows, or null when none is claimed. */
export async function hubHandle(w: DWallet): Promise<string | null> {
  const handle = w.page.getByTestId('nostr-handle');
  const absent = w.page.getByTestId('nostr-handle-absent');
  await expect(handle.or(absent)).toBeVisible({ timeout: 60_000 });
  if (!(await handle.isVisible())) return null;
  const text = (await handle.innerText()).replace(/\s+/g, ' ');
  const match = text.match(/([a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Claim `name` as the account's handle from the hub (the hub must be open and
 * show no handle). A durable account write: callers pass only a name the owner
 * approved for the run. Returns the handle the hub then shows.
 */
export async function claimHandle(w: DWallet, name: string): Promise<string | null> {
  const shown = w.page.getByTestId('nostr-handle');
  const failed = w.page.getByTestId('nostr-claim-handle-error');
  const prompt = w.page.getByTestId('operation-password');
  await w.footage.type(w.page.getByTestId('nostr-claim-handle-input'), name, 'enter a handle');
  await w.footage.tap(w.page.getByTestId('nostr-claim-handle-btn'), 'claim the handle');
  await expect(shown.or(failed).or(prompt), 'claiming the handle produced no outcome').toBeVisible({ timeout: 90_000 });
  if (await prompt.isVisible()) await w.confirmOperationPassword();
  await expect(shown.or(failed)).toBeVisible({ timeout: 90_000 });
  // The server's refusal (taken, invalid) is static rule text; name it.
  expect(await failed.isVisible(), `claiming the handle was refused: ${(await failed.textContent().catch(() => '')) ?? ''}`).toBe(false);
  await w.footage.result('handle claimed');
  return hubHandle(w);
}

/** Add a burner from the hub (accepting its confirm) and return its pubkey. */
export async function addBurner(w: DWallet): Promise<string> {
  const before = new Set(await hubIdentityHexes(w));
  w.page.once('dialog', (dialog) => void dialog.accept());
  await w.footage.tap(w.page.getByTestId('nostr-add-burner'), 'create a burner identity');
  let added = '';
  await expect
    .poll(async () => {
      added = (await hubIdentityHexes(w)).find((hex) => !before.has(hex)) ?? '';
      return added;
    }, { timeout: 60_000, message: 'the burner identity never appeared in the hub' })
    .not.toBe('');
  await expect(w.page.getByTestId(`nostr-identity-${added}`)).toContainText(/burner/i);
  await w.footage.result('burner identity created');
  return added;
}

/** The short npub the identity picker lists (`shortNpubDisplay`). */
export function shortNpub(npub: string): string {
  return npub.length > 18 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub;
}

/** Whether, since `mark`, the page subscribed to gift wraps addressed to `pubkeyHex` (a public key). */
export function subscribedAs(w: DWallet, pubkeyHex: string, mark: number): boolean {
  return w.relayGuard.wrapSubscriptions.slice(mark).some((s) => s.p.includes(pubkeyHex));
}

/**
 * Messages listens (and so sends) as `npub`: since `mark` (an index into the
 * relay guard's `wrapSubscriptions`, taken before Messages opened) the screen
 * subscribed to that key's inbox, and the picker's selected entry is that npub.
 */
export async function expectMessagingAs(w: DWallet, npub: string, mark: number): Promise<void> {
  const hex = recipientToHex(npub);
  await expect
    .poll(() => subscribedAs(w, hex, mark), {
      timeout: 60_000,
      message: 'Messages never subscribed to the inbox of the identity it should message as',
    })
    .toBe(true);
  const picker = w.page.getByTestId('messages-identity-picker');
  await w.footage.tap(picker, 'open the identity picker');
  await expect(
    w.page.getByRole('option', { selected: true }),
    'the identity picker selects a different identity',
  ).toContainText(shortNpub(npub));
  await w.footage.settled('identity picker open');
  await w.footage.tap(picker, 'close the identity picker');
  await expect(w.page.getByRole('listbox')).toHaveCount(0);
}

/**
 * Choose who to message as, by the short npub the picker lists. The picker
 * updates at once, but the screen resolves the chosen identity's key and
 * re-subscribes asynchronously, and a send before that would still go out as
 * the previous identity. The screen sets the identity and THEN opens its
 * gift-wrap subscription for that key, so the subscription reaching the relay
 * guard is the signal that sends now go out as the chosen identity.
 */
export async function chooseMessagingIdentity(w: DWallet, npub: string): Promise<void> {
  const hex = recipientToHex(npub);
  const short = shortNpub(npub);
  const mark = w.relayGuard.wrapSubscriptions.length;
  await w.footage.tap(w.page.getByTestId('messages-identity-picker'), 'open the identity picker');
  const option = w.page.getByRole('option').filter({ hasText: short });
  const already = (await option.getAttribute('aria-selected')) === 'true';
  await w.footage.settled('identity picker open');
  await w.footage.tap(option, 'choose the identity');
  await expect(w.page.getByRole('listbox')).toHaveCount(0);
  await expect(w.page.getByTestId('dm-recipient-input')).toBeVisible({ timeout: 60_000 });
  if (!already) {
    await expect
      .poll(() => subscribedAs(w, hex, mark), {
        timeout: 60_000,
        message: 'Messages never re-subscribed as the chosen identity',
      })
      .toBe(true);
  }
  await w.footage.settled('messaging identity chosen');
}

/** Home balance text per asset row (only the rows the wallet renders). */
export async function homeBalances(w: DWallet): Promise<Record<string, string>> {
  const rows = await w.page
    .locator('[data-testid^="asset-row-"][data-testid$="-balance"]')
    .evaluateAll((els) =>
      els.map((el) => [(el as HTMLElement).dataset.testid ?? '', (el.textContent ?? '').replace(/\s+/g, ' ').trim()]),
    );
  return Object.fromEntries(rows.map(([id, text]) => [id!.replace(/^asset-row-|-balance$/g, ''), text!]));
}

/** Wait until every rendered asset row shows a number (no loading dash). */
export async function waitForBalances(w: DWallet, timeoutMs = 180_000): Promise<Record<string, string>> {
  let last: Record<string, string> = {};
  await expect
    .poll(async () => {
      last = await homeBalances(w);
      const values = Object.values(last);
      return values.length > 0 && values.every((v) => /\d/.test(v));
    }, { timeout: timeoutMs, message: 'the Home balances never resolved to numbers' })
    .toBe(true);
  return last;
}

/** Settings, then Backend: the operator picker. */
export async function openBackendPicker(w: DWallet): Promise<void> {
  await goTab(w, 'settings');
  await w.footage.tap(w.page.getByTestId('settings-backend-nav'), 'open Backend settings');
  await expect(w.page.getByTestId('backend-picker'), 'Settings has no backend picker').toBeVisible({ timeout: 60_000 });
  await w.footage.settled('backend picker');
}

/** After a switch the shell re-bootstraps: wait for the wallet, or name the refusal. */
export async function waitForRebootstrap(w: DWallet): Promise<void> {
  const nav = w.page.getByTestId('bottom-nav');
  const failed = w.page.getByTestId('bootstrap-error');
  const lock = w.page.getByTestId('lockscreen-password-input');
  await expect(nav.or(failed).or(lock), 'the wallet never came back after the backend switch').toBeVisible({
    timeout: 180_000,
  });
  if (await lock.isVisible()) {
    await w.unlock();
    await expect(nav.or(failed), 'the wallet never came back after the unlock').toBeVisible({ timeout: 180_000 });
  }
  expect(await failed.isVisible(), 'the wallet could not sign in to the selected backend').toBe(false);
  await w.footage.settled('wallet signed in');
}

/**
 * Put the wallet back on the default backend, from wherever it is: the lock
 * screen, the bootstrap-error screen (which has no bottom nav, only its own
 * escape to Backend settings), or any tab. A storage read that fails is not
 * taken as "nothing to restore": the restore is attempted and fails loudly.
 */
export async function restoreDefaultBackend(w: DWallet): Promise<void> {
  const stored = await storageValue(w, BACKEND_CONFIG_KEY).catch(() => 'unknown');
  if (stored === undefined || stored === null) return;
  await w.unlock();
  const failed = w.page.getByTestId('bootstrap-error');
  const reset = w.page.getByTestId('backend-reset-default');
  if (await failed.isVisible().catch(() => false)) {
    await w.footage.tap(w.page.getByTestId('bootstrap-error-backend'), 'open Backend settings');
    await expect(reset, 'the error screen\'s escape did not reach Backend settings').toBeVisible({ timeout: 60_000 });
    await w.footage.settled('backend picker');
  } else {
    await openBackendPicker(w);
  }
  await w.footage.tap(reset, 'back to the default backend');
  await waitForRebootstrap(w);
  expect(await storageValue(w, BACKEND_CONFIG_KEY), 'the default backend should leave no stored override').toBeFalsy();
}

/**
 * Probe a backend from the picker and assert the probe card reports what the
 * backend's own /capabilities says (relay yes or no, enabled chains).
 */
export async function probeBackend(
  w: DWallet,
  url: string,
  expected: { relay: boolean; chains: string[] },
): Promise<void> {
  await w.footage.type(w.page.getByTestId('backend-url-input'), url, 'enter the backend address');
  await w.footage.tap(w.page.getByTestId('backend-connect-btn'), 'probe the backend');
  const result = w.page.getByTestId('backend-probe-result');
  const error = w.page.getByTestId('backend-error');
  await expect(result.or(error), 'the probe produced neither a result nor an error').toBeVisible({ timeout: 60_000 });
  expect(await error.isVisible(), 'the wallet could not probe a backend that is up').toBe(false);
  await expect(result).toContainText(`Messaging relay: ${expected.relay ? 'yes' : 'no'}`);
  for (const chain of expected.chains) await expect(result).toContainText(chain.toUpperCase());
  await w.footage.result('backend probed');
}

/** `page.evaluate` has no timeout of its own; bound it. */
async function boundedEvaluate<T>(work: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the wallet page did not answer in time')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read a durable extension storage key from the wallet page (public data only). */
export async function storageValue(w: DWallet, key: string): Promise<unknown> {
  return boundedEvaluate(
    w.page.evaluate(async (k) => {
      const api = (globalThis as unknown as {
        chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } };
      }).chrome;
      return (await api.storage.local.get(k))[k];
    }, key),
  );
}

/** Ids of the still-encrypted gift wraps the background poller has collected. */
export async function backgroundWrapIds(w: DWallet): Promise<string[]> {
  const wraps = await storageValue(w, 'dm.wraps');
  return Array.isArray(wraps) ? wraps.map((wrap) => String((wrap as { id?: unknown }).id ?? '')) : [];
}

/**
 * Ids of the gift wraps the background poller raised a notification for (its
 * bounded seen-set, written right after it creates the notification).
 */
export async function notifiedWrapIds(w: DWallet): Promise<string[]> {
  const seen = await storageValue(w, 'dm.seenNotified');
  return Array.isArray(seen) ? seen.map(String) : [];
}

/** A text unique to this run, so an old message can never satisfy an assertion. */
export function runText(purpose: string, tag: string): string {
  return `Smirk e2e ${purpose}, run ${tag}`;
}
