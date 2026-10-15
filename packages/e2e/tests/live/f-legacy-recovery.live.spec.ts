/**
 * F-legacy-recovery: funds at older Smirk addresses, the move flow, and tips
 * still held by the old Smirk server (v0.3.1, smirk-monorepo #21).
 *
 * WHAT THIS PROVES, against the release build and the production backend:
 *   F1  the automatic check ran once after import, read-only (BTC and LTC at
 *       m/44', XMR and WOW at derivations v1 and v2: no registration request
 *       after import, none during the manual check), found nothing, and put no
 *       notice on Home; its setting is kept; with the setting off, unlock does
 *       not check, with it on it checks, and once a result is stored it never
 *       checks again (alice); after a warm session restore the screen asks for
 *       a full unlock and every action is disabled (bob).
 *   F2  "Scan" registers unwatched older XMR/WOW addresses with the light-
 *       wallet server, one registration per unwatched address at most.
 *   F3  "Look for tips" signs in to backend.smirk.cash with the m/44' key and,
 *       for an existing old account, lists its waiting tips; for a seed with
 *       none (the sign-in made a new empty account) it reads nothing. It writes
 *       no claim there.
 *   F4  the move flow, per configured asset (default LTC at alice's m/44'
 *       address, funded by bob, and WOW at bob's v2 address, funded by alice:
 *       homero's case). XMR/WOW addresses the server does not watch are
 *       scanned first. Nothing is movable while coins arrive (observed or
 *       reported); the Home notice appears; Cancel on the confirmation signs and
 *       sends nothing and keeps the coins offered; the confirmation shows amount
 *       and fee; only settled outputs move, in one broadcast; the move lands in
 *       the sealed send journal and in history; a later check finds the older
 *       address empty (XMR/WOW: by key image); the balance rises. A fixture an
 *       earlier run left behind is resumed, not funded again.
 *   F5  "Finish claim" on a stuck old-server claim, F5b "Claim" on a waiting
 *       targeted old-server tip, and F6 claiming an old-server link tip. No
 *       such fixture is known for the demo wallets, so each skips as "no
 *       fixture" until one exists.
 *
 * RUN only through the lane config, which sets E2E_LANE (the spec declares
 * nothing elsewhere, so no other live lane shares the invocation or a wallet
 * profile), runs every cheap refusal first, and sets the skip guard's floor:
 *
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   E2E_WALLET_FILE=<custody file> E2E_RELEASE_ZIP=<staged Chrome zip> \
 *   EXTENSION_DIST=<that zip, unpacked> BACKEND_URL=https://api.smirk.cash/api/v1 \
 *     npx playwright test -c F-legacy-recovery.live.config.ts
 *   node scripts/F-legacy-recovery-encode.mjs   # every session to MP4, 1.0x
 *
 * Gates (fixtures/F-legacy-recovery-lane.mjs): ALLOW_PROD_WRITES=1 for F2, F3 and
 * every broadcast; E2E_LIVE_MONEY=1 as well for F4 to F6. A skip says "opt-in: "
 * (an approval not given) or "no fixture: "; the skip guard excuses only those,
 * so a funder short of coins still fails the run. Wallet phrases come from the
 * owner-only custody file in E2E_WALLET_FILE, read in-process; never source it.
 *
 * VIDEO. With FOOTAGE=guarded every wallet page is recorded through the frame
 * guard, with the owner's dead air: a still pause before every action, a held
 * settled screen after every action, longer holds on results. Phrase import,
 * password entry and claim links run behind redaction cards. Each import is its
 * own footage session, so a restarted worker never overwrites earlier footage.
 */

import type { Locator, Page } from '@playwright/test';
import { BACKEND_URL } from '../../fixtures/extension.js';
import {
  BROADCAST_PATH,
  LIVE,
  WALLET_NAMES,
  assetBalance,
  expect,
  forgetLegacyRecord,
  nextLegacySignIn,
  nextUtxoBroadcastTxid,
  openOlderAddresses,
  readLegacyRecord,
  readOwnerOnlyValue,
  sendJournalState,
  staysAbsent,
  tabRoot,
  test,
  until,
  type LegacyCheckRecord,
  type LegacyFindingRecord,
  type LiveWallet,
  type WalletName,
} from '../../fixtures/F-legacy-recovery-live.js';
import {
  laneGates,
  moneyRefusal,
  moveScenarios,
  noFixture,
  writeRefusal,
  type MoveScenario,
} from '../../fixtures/F-legacy-recovery-lane.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The old Smirk server (v0.2.x). */
const LEGACY_HOST = 'backend.smirk.cash';
const LEGACY_API = `https://${LEGACY_HOST}/api/v1`;

/** How long the automatic check may take after unlock; also the window that proves "off" and "once". */
const AUTO_CHECK_WINDOW_MS = 3 * MINUTE;
/** A read-only check of six older addresses. */
const CHECK_PATIENCE_MS = 5 * MINUTE;

type ClaimAsset = 'btc' | 'ltc' | 'xmr' | 'wow';

function walletFromEnv(name: string, fallback: WalletName): WalletName {
  const value = (process.env[name] ?? fallback) as WalletName;
  if (!WALLET_NAMES.includes(value)) throw new Error(`${name} must be one of ${WALLET_NAMES.join(', ')}`);
  return value;
}

const GATES = laneGates();
const MOVES: MoveScenario[] = moveScenarios();
const SCAN_WALLET = walletFromEnv('E2E_LEGACY_SCAN_WALLET', 'carol');
const LINK_WALLET = walletFromEnv('E2E_LEGACY_LINK_WALLET', 'carol');

const ok = (status: number) => status >= 200 && status < 300;
const HEX64 = /^[0-9a-fA-F]{64}$/;

// ── Record checks ────────────────────────────────────────────────────────────

/** Every older address kind the check must cover. */
function expectCoverage(record: LegacyCheckRecord): void {
  const has = (asset: LegacyFindingRecord['asset'], sources: LegacyFindingRecord['source'][]) =>
    record.findings.some((f) => f.asset === asset && sources.includes(f.source) && f.address.length > 20);
  expect(has('btc', ['m44']), "the check skipped BTC at m/44'").toBe(true);
  expect(has('ltc', ['m44']), "the check skipped LTC at m/44'").toBe(true);
  expect(has('xmr', ['v1', 'v2']), 'the check skipped the older XMR derivations').toBe(true);
  expect(has('wow', ['v1', 'v2']), 'the check skipped the older WOW derivations').toBe(true);
  const addresses = record.findings.map((f) => `${f.asset}:${f.address}`);
  expect(new Set(addresses).size, 'the check listed one older address twice').toBe(addresses.length);
}

/** The older addresses of `name` that receive an F4 fixture: the only place coins may legitimately wait. */
const fixtureSlots = (name: WalletName) => MOVES.filter((m) => m.target === name).map((m) => `${m.asset}/${m.source}`);

/**
 * Nothing found means we looked everywhere and found no coins: no funds, and
 * no failed reads. The one exception is a move fixture an earlier F4 left at
 * its own slot; those findings are returned, and Home must then show the notice.
 */
function expectNothingFound(record: LegacyCheckRecord, name: WalletName): LegacyFindingRecord[] {
  const label = (f: LegacyFindingRecord) => `${f.asset}/${f.source}`;
  const slots = fixtureSlots(name);
  const funds = record.findings.filter((f) => f.state === 'funds');
  expect(
    funds.filter((f) => !slots.includes(label(f))).map(label),
    'coins found at an older address of a demo wallet: an unexpected discovery for the owner to review',
  ).toEqual([]);
  expect(
    record.findings.filter((f) => f.state === 'error').map(label),
    'the check could not read some older addresses; an unread address is not "nothing found"',
  ).toEqual([]);
  return funds;
}

async function storedCheck(w: LiveWallet, timeoutMs: number, message: string): Promise<LegacyCheckRecord> {
  await expect.poll(async () => (await readLegacyRecord(w.page)) !== null, { timeout: timeoutMs, message }).toBe(true);
  return (await readLegacyRecord(w.page)) as LegacyCheckRecord;
}

/** Tap "Check older addresses" (or "Check again", or "Scan") and wait for a newer stored result. */
async function runCheck(
  w: LiveWallet,
  button: 'legacy-check' | 'legacy-scan',
  patienceMs: number,
): Promise<LegacyCheckRecord> {
  const previous = (await readLegacyRecord(w.page))?.checkedAt ?? 0;
  await w.footage.tap(
    w.page.getByTestId(button),
    button === 'legacy-scan' ? 'Scan older Monero and Wownero addresses' : 'Check older addresses',
  );
  await expect
    .poll(async () => (await readLegacyRecord(w.page))?.checkedAt ?? 0, {
      timeout: patienceMs,
      message: 'the older-address check never stored a new result',
    })
    .toBeGreaterThan(previous);
  await expect(w.page.getByTestId('legacy-check')).toBeEnabled({ timeout: MINUTE });
  return (await readLegacyRecord(w.page)) as LegacyCheckRecord;
}

const sameAddress = (a: LegacyFindingRecord) => (b: LegacyFindingRecord) => a.asset === b.asset && a.address === b.address;

/** Registration requests to the light-wallet server since `since` (method, path and status only). */
const registrations = (w: LiveWallet, since: number) =>
  w.responses(since).filter((e) => e.method === 'POST' && e.path.endsWith('/wallet/lws/register'));

/** Broadcasts of any kind since `since`. */
const broadcasts = (w: LiveWallet, since: number) => w.responses(since).filter((e) => e.method === 'POST' && BROADCAST_PATH.test(e.path));

/** The row of one older address (two XMR or WOW derivations can both be listed). */
const findingRow = (page: Page, f: LegacyFindingRecord): Locator =>
  page.getByTestId(`legacy-finding-${f.asset}`).filter({ hasText: f.address.slice(0, 10) });

const stateLabel = (f: LegacyFindingRecord | undefined) =>
  !f ? 'no such address' : f.state === 'funds' ? (BigInt(f.spendableAtomic) > 0n ? 'funds ready' : 'funds arriving') : f.state;

// ── Flows shared by several tests ───────────────────────────────────────────

/** Leave the screen and return through the tab bar, which remounts it from stored state. */
async function revisitOlderAddresses(w: LiveWallet): Promise<void> {
  await w.footage.tap(w.page.getByTestId('nav-tab-home'), 'Back to Home');
  await w.footage.tap(w.page.getByTestId('nav-tab-settings'), 'Open Settings');
  await expect(w.page.getByTestId('legacy-funds-route')).toBeVisible();
}

async function lockAndUnlock(w: LiveWallet): Promise<number> {
  await tabRoot(w, 'settings', 'Open Settings');
  await w.footage.tap(w.page.getByTestId('settings-lock-now-btn'), 'Lock wallet');
  await expect(w.page.getByTestId('lockscreen-root')).toBeVisible({ timeout: MINUTE });
  const unlockedAt = Date.now();
  await w.enterPassword(
    w.page.getByTestId('lockscreen-password-input'),
    w.page.getByTestId('lockscreen-unlock-btn'),
    'Unlock wallet (redacted)',
  );
  await expect(w.page.getByTestId('lockscreen-root'), 'unlock did not open the wallet').toHaveCount(0, { timeout: 2 * MINUTE });
  await w.footage.settled(w.page, 'Home after unlock');
  return unlockedAt;
}

/**
 * "Look for tips": waits for the sign-in and the list. Returns when the lookup
 * began (to filter its requests) and whether the old server made a new account.
 */
async function lookForTips(w: LiveWallet): Promise<{ since: number; isNew: boolean | null }> {
  const since = Date.now();
  const signIn = nextLegacySignIn(w.page, LEGACY_HOST, 3 * MINUTE);
  const button = w.page.getByTestId('legacy-find-tips');
  await w.footage.tap(button, 'Look for tips');
  await expect(button, 'the tip lookup never finished').toBeEnabled({ timeout: 2 * MINUTE });
  const isNew = await signIn.catch(() => null);
  expect(
    w.responses(since).some((e) => e.host === LEGACY_HOST && e.path.endsWith('/auth/extension')),
    'the wallet never asked the old server to sign it in',
  ).toBe(true);
  await w.footage.result('Old-server tips');
  return { since, isNew };
}

/** Send `amount` of `asset` from Home to `address`; returns the broadcast txid. */
async function sendFromHome(w: LiveWallet, asset: ClaimAsset, address: string, amount: string): Promise<string> {
  await tabRoot(w, 'home', 'Back to Home');
  await w.footage.tap(w.page.getByTestId('home-action-send'), 'Send to an older address');
  const pick = w.page.getByTestId(`send-asset-${asset}`);
  await expect(pick, 'the send wizard did not open at asset choice').toBeVisible({ timeout: MINUTE });
  await w.footage.tap(pick, 'Send: choose asset');
  await w.footage.enter(w.page.getByTestId('send-address-input'), address, 'Send: recipient');
  await w.footage.tap(w.page.getByTestId('send-address-continue'), 'Send: recipient');
  await w.footage.enter(w.page.getByTestId('send-amount-input'), amount, 'Send: amount');
  await w.footage.tap(w.page.getByTestId('send-compose-continue'), 'Send: amount');
  await w.footage.settled(w.page, 'Send: review');
  await w.footage.tap(w.page.getByTestId('send-review-submit'), 'Send: broadcast');
  await w.confirmOperationPasswordIfAsked();
  const txid = w.page.getByTestId('send-done-txid');
  await expect(txid, 'the send never reached a txid').toBeVisible({ timeout: 5 * MINUTE });
  const value = (await txid.textContent())?.trim() ?? '';
  await w.footage.result('Send: broadcast');
  await w.footage.tap(w.page.getByTestId('send-done-close'), 'Back to Home');
  return value;
}

/** Open the asset's history and find the row whose detail names `match`. Holds on that detail. */
async function historyShows(w: LiveWallet, asset: ClaimAsset, match: string): Promise<boolean> {
  await tabRoot(w, 'home', 'Back to Home');
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), 'Open asset');
  await expect(w.page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: MINUTE });
  // History rows carry a signed amount and the ticker (or say the amount is not
  // reported); action pills carry neither.
  const rows: Locator = w.page
    .locator('button')
    .filter({ hasText: new RegExp(`[+−-]\\s*[\\d.,]+\\s*${asset.toUpperCase()}|not reported`) });
  const count = Math.min(await rows.count(), 8);
  for (let i = 0; i < count; i++) {
    await w.footage.tap(rows.nth(i), 'Open history detail');
    const sheet = w.page.getByTestId('tx-detail-sheet');
    await expect(sheet).toBeVisible();
    const found = (await sheet.innerText()).includes(match);
    if (found) await w.footage.result('Moved: history detail');
    await w.footage.tap(w.page.getByTestId('tx-detail-close'), 'Close detail');
    if (found) return true;
  }
  return false;
}

/**
 * Tap "Move to my wallet" until the confirmation shows. A Cryptonote output
 * the server reports before its unlock window has passed is refused by the
 * sweep with nothing signed; that refusal is checked (no broadcast, still
 * offered), recorded, and retried after a fresh check. Returns the amount and
 * fee the confirmation states, and the amount exactly as it is printed.
 */
async function openMoveConfirmation(
  w: LiveWallet,
  s: MoveScenario,
  ready: LegacyFindingRecord,
  note: (key: string, value: string) => void,
): Promise<{ amount: number; fee: number; amountText: string; settledAtomic: string }> {
  const ticker = s.asset.toUpperCase();
  const confirm = w.page.getByTestId('legacy-confirm');
  const message = w.page.getByTestId('legacy-message');
  const deadline = Date.now() + HOUR;
  for (;;) {
    const from = Date.now();
    await w.footage.tap(findingRow(w.page, ready).getByTestId(`legacy-move-${s.asset}`), 'Move to my wallet');
    await expect(confirm.or(message), 'the move showed neither a confirmation nor an outcome').toBeVisible({ timeout: 5 * MINUTE });
    if (await confirm.isVisible()) break;
    expect(s.kind, 'the sweep refused settled UTXO coins before showing a confirmation').toBe('cryptonote');
    expect(broadcasts(w, from), 'a refused move broadcast something').toEqual([]);
    note('move-refused-before-confirmation', 'the server reported the output before its unlock window passed; the sweep refused and signed nothing');
    await w.footage.result('Move refused: still unlocking');
    if (Date.now() > deadline) throw new Error('the move never reached its confirmation within an hour of the coins showing as ready');
    await runCheck(w, 'legacy-check', CHECK_PATIENCE_MS);
    await expect(findingRow(w.page, ready).getByTestId(`legacy-move-${s.asset}`), 'the refused coins are no longer offered').toBeEnabled();
  }
  const text = await confirm.innerText();
  const figures = [...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${ticker}`, 'g'))].map((m) => m[1] ?? '');
  expect(figures.length, 'the confirmation should state the amount and the network fee').toBeGreaterThanOrEqual(2);
  const amount = Number(figures[0]);
  const fee = Number(figures[1]);
  expect(amount).toBeGreaterThan(0);
  expect(fee).toBeGreaterThan(0);
  // Against what the stored check counts now (a retry above may have re-read it).
  const settled = (await readLegacyRecord(w.page))?.findings.find(sameAddress(ready))?.spendableAtomic ?? ready.spendableAtomic;
  const unit = 10 ** s.decimals;
  expect(amount + fee, 'the move would spend more than the settled coins').toBeLessThanOrEqual(Number(settled) / unit + 1 / unit);
  await w.footage.result('Move: amount and fee');
  return { amount, fee, amountText: `${figures[0]} ${ticker}`, settledAtomic: settled };
}

/** Old-server tip rows with a button of this name ("Finish claim" or "Claim"). */
const tipRowsWith = (w: LiveWallet, button: RegExp) =>
  w.page.getByTestId('legacy-tip-row').filter({ has: w.page.getByRole('button', { name: button }) });

if (LIVE) {
  // ── F1: the automatic check, its setting, and the read-only manual check ──
  for (const name of WALLET_NAMES) {
    test(`F1 older addresses: automatic check, Home notice, setting and read-only check [${name}]`, async ({ liveWallets }) => {
      test.setTimeout(60 * MINUTE);
      const w = await liveWallets.get(name);

      const auto = await storedCheck(w, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
      expect(auto.mode, 'the automatic check must only read (probe), never register').toBe('probe');
      expectCoverage(auto);
      const leftover = expectNothingFound(auto, name);

      await tabRoot(w, 'home', 'Back to Home');
      await expect(w.page.getByTestId('home-total-balance')).toBeVisible();
      if (leftover.length) {
        // An earlier F4 left its fixture here; F4 resumes it. Home must point at it.
        liveWallets.evidence.note(test.info().title, 'leftover-move-fixture', leftover.map((f) => `${f.asset}/${f.source}`).join(','));
        await expect(w.page.getByTestId('legacy-funds-banner'), 'Home shows no notice for coins at an older address').toBeVisible();
        await w.footage.result('Home: older-address notice');
      } else {
        await expect(w.page.getByTestId('legacy-funds-banner'), 'Home shows an older-address notice with nothing found').toHaveCount(0);
        await w.footage.result('Home: no older-address notice');
      }

      await openOlderAddresses(w);
      await expect(w.page.getByTestId('legacy-needs-unlock'), 'the screen says the phrase is not in memory right after import').toHaveCount(0);
      // The screen shows what the stored check found: one row per address that is not plainly empty.
      const shown = auto.findings.filter((f) => f.state !== 'empty');
      await expect(w.page.locator('[data-testid^="legacy-finding-"]')).toHaveCount(shown.length);
      if (!leftover.length) {
        await expect(w.page.locator('[data-testid^="legacy-move-"]'), 'a move is offered with nothing found').toHaveCount(0);
      }
      const unwatched = auto.findings.filter((f) => f.state === 'not-scanned');
      await expect(w.page.getByTestId('legacy-scan')).toHaveCount(unwatched.length > 0 ? 1 : 0);
      await w.footage.result('Automatic check result');

      // The setting defaults on, and both of its states are kept.
      const toggle = w.page.getByTestId('legacy-auto-check');
      await expect(toggle, 'the automatic check should default on').toBeChecked();
      await w.footage.setChecked(toggle, false, 'Automatic check: turn off');
      await revisitOlderAddresses(w);
      await expect(toggle, 'turning the automatic check off was not kept').not.toBeChecked();
      await w.footage.result('Automatic check setting kept');
      await w.footage.setChecked(toggle, true, 'Automatic check: turn on');
      await revisitOlderAddresses(w);
      await expect(toggle, 'turning the automatic check back on was not kept').toBeChecked();
      await w.footage.result('Automatic check setting kept');

      // The manual check is read-only too: it sends no registration request.
      const manualFrom = Date.now();
      const manual = await runCheck(w, 'legacy-check', CHECK_PATIENCE_MS);
      expect(manual.mode).toBe('probe');
      expectCoverage(manual);
      expectNothingFound(manual, name);
      expect(registrations(w, manualFrom), 'the read-only check sent a registration request').toEqual([]);
      for (const f of unwatched) {
        expect(manual.findings.find(sameAddress(f))?.state, 'a read-only check registered an older address').toBe('not-scanned');
      }
      await w.footage.result('Read-only check result');
      // Nothing registered since the import finished: the wallet registers its
      // own accounts during that first refresh, and the older-address checks
      // never register anything.
      expect(
        registrations(w, w.importedAt),
        'a registration request was sent after import while only read-only checks ran (an older address, or a retry of the wallet\'s own registration that failed at import)',
      ).toEqual([]);

      await tabRoot(w, 'home', 'Back to Home');
      await expect(w.page.getByTestId('legacy-funds-banner')).toHaveCount(leftover.length ? 1 : 0);
      await w.footage.result(leftover.length ? 'Home: older-address notice' : 'Home: no older-address notice');
    });
  }

  test('F1 automatic check off means unlock does not check, on means it checks once [alice]', async ({ liveWallets }) => {
    test.setTimeout(60 * MINUTE);
    const w = await liveWallets.get('alice');
    await storedCheck(w, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');

    await openOlderAddresses(w);
    const toggle = w.page.getByTestId('legacy-auto-check');
    await w.footage.setChecked(toggle, false, 'Automatic check: turn off');
    await expect(toggle).not.toBeChecked();
    // Forget the stored result (display state only) so the next unlock is free to check.
    await forgetLegacyRecord(w.page);
    await lockAndUnlock(w);
    const stayedOff = await staysAbsent(async () => (await readLegacyRecord(w.page)) !== null, AUTO_CHECK_WINDOW_MS);
    expect(stayedOff, 'the older-address check ran after unlock although it was turned off').toBe(true);
    await w.footage.result('After unlock: automatic check off');

    await openOlderAddresses(w);
    await w.footage.setChecked(toggle, true, 'Automatic check: turn on');
    await expect(toggle).toBeChecked();
    const unlockedAt = await lockAndUnlock(w);
    // Same window as above: if the check takes longer than this, "off" above proved nothing.
    const ran = await storedCheck(
      w,
      AUTO_CHECK_WINDOW_MS,
      'the automatic check did not run after unlock within the window used to prove it was off',
    );
    expect(ran.mode).toBe('probe');
    expect(ran.checkedAt).toBeGreaterThanOrEqual(unlockedAt);
    expectCoverage(ran);
    const leftover = expectNothingFound(ran, 'alice');
    // The unlock reuses this window's session, so the wallet's own accounts are
    // not registered again: any registration here would be the check's.
    expect(registrations(w, unlockedAt), 'the automatic check after unlock sent a registration request').toEqual([]);
    await w.footage.result('After unlock: automatic check ran');

    await tabRoot(w, 'home', 'Back to Home');
    await expect(w.page.getByTestId('legacy-funds-banner')).toHaveCount(leftover.length ? 1 : 0);
    await w.footage.result(leftover.length ? 'Home: older-address notice' : 'Home: no older-address notice');
  });

  test('F1 the automatic check runs once per wallet: with a stored result, unlock does not check again [alice]', async ({ liveWallets }) => {
    test.setTimeout(30 * MINUTE);
    const w = await liveWallets.get('alice');
    const before = await storedCheck(w, CHECK_PATIENCE_MS, 'no stored older-address result to start from');
    await openOlderAddresses(w);
    const toggle = w.page.getByTestId('legacy-auto-check');
    if (!(await toggle.isChecked())) await w.footage.setChecked(toggle, true, 'Automatic check: turn on');
    await expect(toggle, 'the automatic check must be on for this test to mean anything').toBeChecked();
    await lockAndUnlock(w);
    const unchanged = await staysAbsent(
      async () => ((await readLegacyRecord(w.page))?.checkedAt ?? 0) !== before.checkedAt,
      AUTO_CHECK_WINDOW_MS,
    );
    expect(unchanged, 'unlock checked the older addresses again although a result was stored').toBe(true);
    await w.footage.result('After unlock: no second check');
  });

  test('F1 after a warm session restore the screen asks for a full unlock and offers no action [bob]', async ({ liveWallets }) => {
    test.setTimeout(30 * MINUTE);
    const w = await liveWallets.get('bob');
    await tabRoot(w, 'settings', 'Open Settings');
    const select = w.page.getByTestId('settings-autolock-select');
    const original = await select.inputValue();
    // A non-zero auto-lock keeps a session cache, which a new window restores without the phrase.
    await w.footage.select(select, '240', 'Settings: auto-lock');
    try {
      w.footage.mark('Reopen the wallet window');
      const restored = await w.openWindow();
      await expect(restored.getByTestId('bottom-nav'), 'the new window did not restore the wallet').toBeVisible({ timeout: 2 * MINUTE });
      await expect(restored.getByTestId('lockscreen-root'), 'the new window asked for the password, so nothing was restored').toHaveCount(0);
      await w.footage.settled(restored, 'Reopen the wallet window');
      await openOlderAddresses(w, restored);
      await expect(restored.getByTestId('legacy-needs-unlock'), 'the restored window does not say it needs a full unlock').toBeVisible();
      await expect(restored.getByTestId('legacy-check'), 'checking is offered without the phrase').toBeDisabled();
      await expect(restored.getByTestId('legacy-find-tips'), 'looking for tips is offered without the phrase').toBeDisabled();
      for (const action of await restored.locator('[data-testid="legacy-scan"], [data-testid^="legacy-move-"]').all()) {
        await expect(action, 'an older-address action is offered without the phrase').toBeDisabled();
      }
      await w.footage.result('Reopened window: unlock needed');
      w.footage.mark('Close the reopened window');
      await restored.close();
    } finally {
      // Windows share one route (SessionStateStore), so the first window
      // followed the restored one to Older addresses (2026-10-15): go back to
      // Settings' root before putting the auto-lock back.
      await tabRoot(w, 'settings', 'Open Settings');
      await w.footage.select(select, original, 'Settings: auto-lock');
    }
  });

  // ── F2: scanning unwatched older XMR/WOW addresses ────────────────────────
  test('F2 scan registers unwatched older Monero and Wownero addresses with the server', async ({ liveWallets }) => {
    const refusal = writeRefusal(GATES);
    test.skip(refusal !== null, refusal ?? '');
    test.setTimeout(2 * HOUR);
    const w = await liveWallets.get(SCAN_WALLET);
    const before = await storedCheck(w, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
    const unwatched = before.findings.filter((f) => (f.asset === 'xmr' || f.asset === 'wow') && f.state === 'not-scanned');
    test.skip(
      unwatched.length === 0,
      noFixture('every older XMR/WOW address of the scan wallet is already watched (an earlier run scanned them)'),
    );

    await openOlderAddresses(w);
    const since = Date.now();
    // Restore proof-of-work, when priced, is solved in the wallet before it registers.
    const scanned = await runCheck(w, 'legacy-scan', HOUR);
    expect(scanned.mode).toBe('scan');
    const regs = registrations(w, since);
    expect(regs.length, 'scanning made no registration request').toBeGreaterThan(0);
    // Re-registering a watched address would rewind its scan: one per unwatched address at most.
    expect(regs.length, 'scanning registered an address the server already watched').toBeLessThanOrEqual(unwatched.length);
    expect(regs.every((e) => ok(e.status)), 'the server refused a registration').toBe(true);
    for (const f of unwatched) {
      const now = scanned.findings.find(sameAddress(f));
      expect(now?.state, 'an older address is still unwatched after scanning').not.toBe('not-scanned');
      expect(now?.state, 'scanning an older address failed').not.toBe('error');
    }
    liveWallets.evidence.note(test.info().title, 'registered', regs.length);
    await w.footage.result('Scan registered with the server');

    // Watched from now on: a plain read-only check sees each one, and registers nothing.
    const rereadFrom = Date.now();
    const reread = await runCheck(w, 'legacy-check', CHECK_PATIENCE_MS);
    for (const f of unwatched) {
      expect(['scanning', 'empty', 'funds'], 'a scanned address dropped back to unwatched').toContain(
        reread.findings.find(sameAddress(f))?.state,
      );
    }
    expect(registrations(w, rereadFrom), 'the read-only check after a scan sent a registration request').toEqual([]);
    await w.footage.result('Read-only check result');
  });

  // ── F3: tips waiting on the old server ─────────────────────────────────────
  for (const name of WALLET_NAMES) {
    test(`F3 look for tips signs in to the old server and lists what waits there [${name}]`, async ({ liveWallets }) => {
      // Signing in to the old server creates an empty account there for a seed it does not know.
      const refusal = writeRefusal(GATES);
      test.skip(refusal !== null, refusal ?? '');
      test.setTimeout(30 * MINUTE);
      const w = await liveWallets.get(name);
      await openOlderAddresses(w);
      const { since, isNew } = await lookForTips(w);
      const legacy = () => w.responses(since).filter((e) => e.host === LEGACY_HOST);

      const signIn = legacy().filter((e) => e.method === 'POST' && e.path.endsWith('/auth/extension'));
      expect(signIn.length).toBeGreaterThan(0);
      expect(signIn.every((e) => ok(e.status)), "the old server refused the m/44' sign-in").toBe(true);
      expect(isNew, 'the old server did not say whether the sign-in matched an existing account').not.toBeNull();
      const listed = legacy().filter((e) => e.method === 'GET' && e.path.endsWith('/tips/social/received'));
      if (isNew) {
        // No v0.2 account existed (this sign-in made an empty one): nothing can wait there, and the wallet must not ask.
        liveWallets.evidence.note(test.info().title, 'old-account', 'none before this run; the sign-in created an empty one');
        expect(listed, 'the wallet read tips for a brand-new old-server account').toEqual([]);
        await expect(w.page.getByTestId('legacy-tip-row')).toHaveCount(0);
      } else {
        liveWallets.evidence.note(test.info().title, 'old-account', 'existing');
        expect(listed.length, 'the wallet did not read the tips of its existing old account').toBeGreaterThan(0);
        expect(listed.every((e) => ok(e.status)), 'the old server refused the tip list').toBe(true);
      }
      expect(
        legacy().filter((e) => /\/(claim|confirm-sweep)$/.test(e.path)),
        'looking for tips wrote a claim to the old server',
      ).toEqual([]);

      await expect(w.page.getByTestId('legacy-message'), 'the tip lookup reported an error').toHaveCount(0);
      const rows = w.page.getByTestId('legacy-tip-row');
      for (let i = 0; i < (await rows.count()); i++) {
        // Each waiting tip shows its amount, and either an action or its confirmations.
        await expect(rows.nth(i)).toContainText(/\d/);
      }
      liveWallets.evidence.note(test.info().title, 'waiting-tips', await rows.count());
      await w.footage.result('Old-server tips');
    });
  }

  // ── F4: the move flow, one test per configured asset ─────────────────────
  for (const s of MOVES) {
    test(`F4 move to my wallet [${s.asset}]: only settled coins move, after amount and fee, and the move is recorded`, async ({ liveWallets }) => {
      const refusal = moneyRefusal(GATES);
      test.skip(refusal !== null, refusal ?? '');
      test.setTimeout(8 * HOUR);
      const title = test.info().title;
      const note = (key: string, value: string | number) => liveWallets.evidence.note(title, key, value);
      const ticker = s.asset.toUpperCase();
      const unit = 10 ** s.decimals;
      const target = await liveWallets.get(s.target);
      const funder = await liveWallets.get(s.funder);

      // The target's own older address, from its stored check (public data).
      const start = await storedCheck(target, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
      const older = start.findings.find((f) => f.asset === s.asset && f.source === s.source);
      expect(older, `the check record has no ${s.source} address for ${ticker}`).toBeTruthy();
      const same = sameAddress(older!);
      const targetBefore = await assetBalance(target, s.asset, 'result');
      const journalBefore = await sendJournalState(target.page);

      // 1. The fixture: resume one an earlier run left behind, else fund the older address.
      await openOlderAddresses(target);
      let current = older!;
      if (current.state === 'scanning') {
        // Registered by an earlier run but not caught up: wait before deciding whether coins are already there.
        await until(
          async () => {
            current = (await runCheck(target, 'legacy-check', CHECK_PATIENCE_MS)).findings.find(same) ?? current;
            return current.state !== 'scanning';
          },
          { timeoutMs: 2 * HOUR, intervalMs: 3 * MINUTE, message: 'the older address never finished scanning' },
        );
      }
      expect(current.state, 'the older address could not be read').not.toBe('error');
      const resumed = current.state === 'funds';
      note('fixture', resumed ? 'resumed: coins an earlier run sent were still at the older address' : 'new');
      let funderBefore: number | null = null;
      if (!resumed) {
        funderBefore = await assetBalance(funder, s.asset, 'result');
        test.skip(funderBefore < 3 * Number(s.amount), `the funder lacks ${ticker} for the fixture (needs about three times ${s.amount}, for fees)`);
        const fundingTxid = await sendFromHome(funder, s.asset, current.address, s.amount);
        expect(fundingTxid, 'the fixture send did not return a txid').toMatch(HEX64);
        note('funding-txid', fundingTxid);
      }

      // 2. Watch until the coins settle; scan first where the server does not watch the address.
      let arriving = false;
      let firstSeen: string | null = null;
      let ready: LegacyFindingRecord | undefined;
      await until(
        async () => {
          const latest = (await readLegacyRecord(target.page))?.findings.find(same);
          let r: LegacyCheckRecord;
          if (latest?.state === 'not-scanned') {
            const scanFrom = Date.now();
            r = await runCheck(target, 'legacy-scan', HOUR);
            const regs = registrations(target, scanFrom);
            expect(regs.length, 'scanning made no registration request').toBeGreaterThan(0);
            expect(regs.every((e) => ok(e.status)), 'the server refused a registration').toBe(true);
            note('scanned', regs.length);
            await target.footage.result('Scan registered with the server');
          } else {
            r = await runCheck(target, 'legacy-check', CHECK_PATIENCE_MS);
          }
          const f = r.findings.find(same);
          expect(f?.state, 'the older address could not be read').not.toBe('error');
          if (firstSeen === null && f?.state !== 'scanning') firstSeen = stateLabel(f);
          if (f?.state === 'funds' && BigInt(f.spendableAtomic) === 0n && BigInt(f.pendingAtomic) > 0n) {
            arriving = true;
            await expect(findingRow(target.page, f)).toBeVisible();
            await expect(
              findingRow(target.page, f).getByTestId(`legacy-move-${s.asset}`),
              'a move was offered for coins that have not settled',
            ).toHaveCount(0);
            await target.footage.result('Funds still arriving at the older address');
          }
          if (f?.state === 'funds' && BigInt(f.spendableAtomic) > 0n) ready = f;
          return ready !== undefined;
        },
        {
          timeoutMs: 4 * HOUR,
          intervalMs: s.kind === 'utxo' ? MINUTE : 2 * MINUTE,
          message: 'the fixture never settled at the older address',
        },
      );
      // The arriving state depends on timing (a fast block, a long scan); report what was seen either way.
      const observed = arriving
        ? 'observed: nothing was movable while the coins arrived'
        : resumed
          ? 'not observed: the fixture was resumed'
          : `not observed: the first readable check found ${firstSeen ?? 'nothing'}`;
      note('arriving-state', observed);
      test.info().annotations.push({ type: 'observation', description: `arriving state ${observed}` });

      // 3. Home points at it.
      await tabRoot(target, 'home', 'Back to Home');
      const banner = target.page.getByTestId('legacy-funds-banner');
      await expect(banner, 'Home shows no notice for coins at an older address').toBeVisible({ timeout: 2 * MINUTE });
      await target.footage.result('Home: older-address notice');
      await target.footage.tap(banner, 'Open the notice');
      await expect(target.page.getByTestId('legacy-funds-route')).toBeVisible();
      await expect(findingRow(target.page, ready!)).toContainText(ticker);
      await target.footage.result('Funds ready to move');

      // 4. Cancel on the confirmation signs and sends nothing, and the coins stay offered.
      const confirm = target.page.getByTestId('legacy-confirm');
      const cancelFrom = Date.now();
      const journalAtCancel = await sendJournalState(target.page);
      const offered = await openMoveConfirmation(target, s, ready!, note);
      await target.footage.tap(confirm.getByRole('button', { name: 'Cancel' }), 'Move: cancel');
      await expect(confirm, 'the confirmation stayed open after Cancel').toHaveCount(0);
      await expect(target.page.getByTestId('legacy-message'), 'Cancel reported an outcome').toHaveCount(0);
      await expect(findingRow(target.page, ready!).getByTestId(`legacy-move-${s.asset}`), 'Cancel withdrew the offer').toBeEnabled();
      expect(broadcasts(target, cancelFrom), 'Cancel broadcast a transaction').toEqual([]);
      expect((await sendJournalState(target.page))?.digest, 'Cancel wrote to the send journal').toBe(journalAtCancel?.digest);
      expect(
        (await readLegacyRecord(target.page))?.findings.find(same)?.spendableAtomic,
        'Cancel changed what the stored check counts',
      ).toBe(offered.settledAtomic);
      await target.footage.result('Move cancelled: nothing sent');

      // 5. Amount and fee before signing; then only settled coins move, in one broadcast.
      const moveFrom = Date.now();
      const utxoTxid = s.kind === 'utxo' ? nextUtxoBroadcastTxid(target.page, 30 * MINUTE) : null;
      const shown = await openMoveConfirmation(target, s, ready!, note);
      await target.footage.tap(confirm.getByTestId('legacy-confirm-move'), 'Move: confirm');
      await target.confirmOperationPasswordIfAsked();
      // The outcome message appears on success and on refusal; the stored check tells them apart.
      await expect(target.page.getByTestId('legacy-message'), 'the move never finished').toBeVisible({ timeout: 15 * MINUTE });
      await expect(findingRow(target.page, ready!).getByTestId(`legacy-move-${s.asset}`), 'the moved coins are still offered').toHaveCount(0);
      const moved = (await readLegacyRecord(target.page))!.findings.find(same);
      expect(moved?.spendableAtomic, 'the move did not complete: the stored check still counts the coins').toBe('0');
      const sent = broadcasts(target, moveFrom);
      expect(sent.length, 'the move did not broadcast exactly one transaction').toBe(1);
      expect(sent.every((e) => ok(e.status)), 'the broadcast was refused').toBe(true);
      let historyMatch = shown.amountText;
      if (utxoTxid) {
        const txid = await utxoTxid;
        expect(txid, 'the move did not broadcast').toMatch(HEX64);
        note('move-txid', txid);
        historyMatch = txid;
      }
      note('moved', shown.amountText);
      await target.footage.result('Moved: result');

      // 6. Recorded: the sealed send journal grew, Home stops pointing at the coins, history shows the move.
      await expect
        .poll(
          async () => {
            const j = await sendJournalState(target.page);
            return !!j && j.sealed && j.digest !== journalBefore?.digest && j.length > (journalBefore?.length ?? 0);
          },
          { timeout: 2 * MINUTE, message: 'the move was not written to the encrypted send journal' },
        )
        .toBe(true);
      if (moved?.state !== 'funds') {
        await tabRoot(target, 'home', 'Back to Home');
        await expect(target.page.getByTestId('legacy-funds-banner'), 'Home still points at moved coins').toHaveCount(0);
        await target.footage.result('Home: no older-address notice');
      }
      await until(() => historyShows(target, s.asset, historyMatch), {
        timeoutMs: HOUR,
        intervalMs: 2 * MINUTE,
        message: 'history never showed the move',
      });

      // 7. A later check finds the older address empty: the spend is seen (for XMR/WOW, proven by key image).
      await openOlderAddresses(target);
      await until(async () => (await runCheck(target, 'legacy-check', CHECK_PATIENCE_MS)).findings.find(same)?.state === 'empty', {
        timeoutMs: 2 * HOUR,
        intervalMs: 3 * MINUTE,
        message: 'a later check still counted coins at the older address after the move',
      });
      await target.footage.result('Older address empty after the move');

      // 8. The balance rises once the network confirms; the funder paid for a new fixture.
      await until(async () => (await assetBalance(target, s.asset, 'settled')) >= targetBefore + shown.amount - 1 / unit, {
        timeoutMs: 2 * HOUR,
        intervalMs: 3 * MINUTE,
        message: 'the moved coins never reached the wallet balance',
      });
      await assetBalance(target, s.asset, 'result');
      await target.footage.result('Moved: balance confirmed');
      if (funderBefore !== null) {
        const paid = funderBefore;
        await until(async () => (await assetBalance(funder, s.asset, 'settled')) <= paid - Number(s.amount) + 1 / unit, {
          timeoutMs: HOUR,
          intervalMs: 3 * MINUTE,
          message: 'the funder balance never reflected the fixture send',
        });
      }
    });
  }

  // ── F5, F5b: claiming tips the old server holds for this seed ─────────────
  const CLAIMS = [
    {
      title: 'F5 finish claim completes a stuck old-server tip',
      button: /^Finish claim$/,
      label: 'Finish claim' as const,
      none: 'no stuck old-server claim exists for alice, bob or carol',
    },
    {
      title: 'F5b claim takes a waiting targeted old-server tip',
      button: /^Claim$/,
      label: 'Claim tip' as const,
      none: 'no claimable targeted tip waits on the old server for alice, bob or carol',
    },
  ];
  for (const c of CLAIMS) {
    test(c.title, async ({ liveWallets }) => {
      const refusal = moneyRefusal(GATES);
      test.skip(refusal !== null, refusal ?? '');
      test.setTimeout(4 * HOUR);
      let holder: LiveWallet | null = null;
      let asset: ClaimAsset | null = null;
      for (const name of WALLET_NAMES) {
        const w = await liveWallets.get(name);
        await openOlderAddresses(w);
        await lookForTips(w);
        const rows = tipRowsWith(w, c.button);
        if ((await rows.count()) > 0) {
          holder = w;
          asset = ((await rows.first().innerText()).match(/\b(BTC|LTC|XMR|WOW)\b/)?.[1]?.toLowerCase() ?? null) as ClaimAsset | null;
          break;
        }
      }
      test.skip(holder === null, noFixture(c.none));
      expect(asset, 'the tip is not in a claimable asset').not.toBeNull();
      const w = holder!;
      const before = await assetBalance(w, asset!, 'result');

      await openOlderAddresses(w);
      const { since } = await lookForTips(w);
      const rows = w.page.getByTestId('legacy-tip-row');
      const rowsBefore = await rows.count();
      await w.footage.tap(tipRowsWith(w, c.button).first().getByRole('button', { name: c.button }), c.label);
      await w.confirmOperationPasswordIfAsked();
      await expect(w.page.getByTestId('legacy-message')).toBeVisible({ timeout: 30 * MINUTE });
      await expect(rows, 'the claimed tip is still listed').toHaveCount(rowsBefore - 1);
      const legacy = () => w.responses(since).filter((e) => e.host === LEGACY_HOST && e.method === 'POST');
      expect(legacy().some((e) => e.path.endsWith('/claim') && ok(e.status)), 'the old server did not accept the claim').toBe(true);
      await until(async () => legacy().some((e) => e.path.endsWith('/confirm-sweep') && ok(e.status)), {
        timeoutMs: 2 * MINUTE,
        intervalMs: 2_000,
        message: 'the sweep was never reported to the old server',
      });
      await w.footage.result('Tip claimed');
      await until(async () => (await assetBalance(w, asset!, 'settled')) > before, {
        timeoutMs: 2 * HOUR,
        intervalMs: 3 * MINUTE,
        message: 'the claimed tip never reached the wallet balance',
      });
      await assetBalance(w, asset!, 'result');
    });
  }

  // ── F6: claiming an old-server link tip ───────────────────────────────────
  test('F6 a link tip only the old server knows is claimed through the fallback', async ({ liveWallets }) => {
    const refusal = moneyRefusal(GATES);
    test.skip(refusal !== null, refusal ?? '');
    const file = process.env.E2E_LEGACY_TIP_LINK_FILE;
    test.skip(
      !file,
      noFixture('no legacy link tip is known. Provide LEGACY_TIP_LINK in an owner-only file named by E2E_LEGACY_TIP_LINK_FILE.'),
    );
    test.setTimeout(4 * HOUR);
    const w = await liveWallets.get(LINK_WALLET);

    let link = readOwnerOnlyValue(file!, 'LEGACY_TIP_LINK');
    const parsed = new URL(link);
    const tipId = parsed.pathname.match(/\/tip\/([^/]+)$/)?.[1] ?? '';
    const fragment = parsed.hash.replace(/^#/, '');
    expect(tipId !== '' && fragment.length >= 8, 'LEGACY_TIP_LINK is not a tip link with a key fragment').toBe(true);
    w.guardSecret(fragment);
    w.guardSecret(link);

    // Public descriptions only (no fragment leaves this process): unknown here, known to the old server.
    const core = await fetch(`${BACKEND_URL}/tips/social/${encodeURIComponent(tipId)}/public`);
    expect(core.status, 'this server knows the tip, so it is not an old-server fixture').toBe(404);
    const old = await fetch(`${LEGACY_API}/tips/social/${encodeURIComponent(tipId)}/public`);
    expect(old.status, 'the old server does not know the tip').toBe(200);
    const info = (await old.json()) as { asset?: string; is_claimable?: boolean };
    test.skip(info.is_claimable !== true, noFixture('the old-server link tip is not claimable (unconfirmed or already claimed)'));
    const asset = (info.asset ?? '') as ClaimAsset;
    expect(['btc', 'ltc', 'xmr', 'wow'], 'the link tip is not in a claimable asset').toContain(asset);
    const before = await assetBalance(w, asset, 'result');

    await tabRoot(w, 'inbox', 'Open Inbox');
    await w.footage.tap(w.page.getByTestId('inbox-paste-tip-link-btn'), 'Paste a tip link');
    const since = Date.now();
    await w.enterSecretText(
      w.page.getByTestId('paste-tip-input'),
      link,
      w.page.getByTestId('paste-tip-claim-btn'),
      w.page.getByTestId('paste-tip-success').or(w.page.getByTestId('paste-tip-error')),
      'Claim link entry (redacted)',
    );
    link = '';
    await expect(w.page.getByTestId('paste-tip-success'), 'the link claim did not succeed').toBeVisible({ timeout: 30 * MINUTE });
    const legacy = () => w.responses(since).filter((e) => e.host === LEGACY_HOST);
    expect(legacy().some((e) => e.method === 'GET' && e.path.endsWith('/public') && ok(e.status)), 'the wallet did not fall back to the old server').toBe(true);
    await until(async () => legacy().some((e) => e.method === 'POST' && e.path.endsWith('/confirm-sweep') && ok(e.status)), {
      timeoutMs: 2 * MINUTE,
      intervalMs: 2_000,
      message: 'the sweep was never reported to the old server',
    });
    await w.footage.result('Legacy link tip claimed');
    await w.footage.tap(w.page.getByTestId('paste-tip-done-btn'), 'Back to Home');
    await until(async () => (await assetBalance(w, asset, 'settled')) > before, {
      timeoutMs: 2 * HOUR,
      intervalMs: 3 * MINUTE,
      message: 'the claimed link tip never reached the wallet balance',
    });
    await assetBalance(w, asset, 'result');
  });
}
