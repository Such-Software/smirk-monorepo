/**
 * F-legacy-recovery: funds at older Smirk addresses, the move flow, and tips
 * still held by the old Smirk server (v0.3.1, smirk-monorepo #21).
 *
 * WHAT THIS PROVES, against the release build and the production backend:
 *   F1  the automatic check ran once after import, read-only (BTC and LTC at
 *       m/44', XMR and WOW at derivations v1 and v2), found nothing, and put
 *       no notice on Home; its setting is kept; "Check older addresses" stays
 *       read-only (an address the server did not watch is still not watched);
 *       and with the setting off, unlock does not check (alice).
 *   F2  "Scan" registers unwatched older XMR/WOW addresses with the light-
 *       wallet server (owner approval only: it shares those view keys and may
 *       pay restore proof-of-work).
 *   F3  "Look for tips" signs in to backend.smirk.cash with the m/44' key, finds
 *       each demo wallet's existing old account, lists its waiting tips and
 *       writes nothing there.
 *   F4  the move flow on an approved fixture: one demo wallet sends a small
 *       amount to another demo wallet's own m/44' address; the target sees it
 *       arriving with nothing movable, the Home notice appears once it settles,
 *       the confirm step shows amount and fee, only settled outputs move, the
 *       move lands in the encrypted send journal and in history, and the
 *       balance rises. Coins stay among alice, bob and carol.
 *   F5  "Finish claim" on a stuck old-server claim, and
 *   F6  claiming an old-server link tip. No such fixture is known for the demo
 *       wallets, so both are expected skips until one exists.
 *
 * GATES. Nothing is declared unless E2E_LIVE=1, so fundless runs are untouched.
 * Moving coins needs E2E_LIVE_MONEY=1, and writing to a shared backend needs
 * ALLOW_PROD_WRITES=1. F2 also needs E2E_LEGACY_SCAN=1 and F4 needs
 * E2E_LEGACY_MOVE_FIXTURE=1 (owner approvals). Wallet phrases come from the
 * owner-only custody file in E2E_WALLET_FILE, read in-process; never source it.
 *
 * VIDEO. With FOOTAGE=guarded every wallet page is recorded through the frame
 * guard, with the owner's dead air (a pause before each tap, holds on settled
 * screens and on results). Phrase import, password entry and claim links run
 * behind redaction cards. All of it lives in fixtures/F-legacy-recovery-*.
 *
 *   E2E_LIVE=1 FOOTAGE=guarded E2E_WALLET_FILE=<custody file> \
 *   EXTENSION_DIST=<unpacked release zip> BACKEND_URL=https://api.smirk.cash/api/v1 \
 *     npx playwright test tests/live/f-legacy-recovery.live.spec.ts
 *   node scripts/F-legacy-recovery-encode.mjs   # frames and timeline to MP4, 1.0x
 *
 * Under the shared skip guard, F2, F4, F5 and F6 skip by design until their
 * approval or fixture exists; a live lane config must list them as expected.
 */

import type { Locator } from '@playwright/test';
import { BACKEND_URL, skipDestructiveOnShared } from '../../fixtures/extension.js';
import {
  LIVE,
  LIVE_MONEY,
  WALLET_NAMES,
  assetBalance,
  expect,
  forgetLegacyRecord,
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The old Smirk server (v0.2.x). */
const LEGACY_HOST = 'backend.smirk.cash';
const LEGACY_API = `https://${LEGACY_HOST}/api/v1`;

/** How long the automatic check may take after unlock; also the window that proves "off". */
const AUTO_CHECK_WINDOW_MS = 3 * MINUTE;
/** A read-only check of six older addresses. */
const CHECK_PATIENCE_MS = 5 * MINUTE;

type UtxoAsset = 'btc' | 'ltc';
type ClaimAsset = 'btc' | 'ltc' | 'xmr' | 'wow';

function walletFromEnv(name: string, fallback: WalletName): WalletName {
  const value = (process.env[name] ?? fallback) as WalletName;
  if (!WALLET_NAMES.includes(value)) throw new Error(`${name} must be one of ${WALLET_NAMES.join(', ')}`);
  return value;
}

const SCAN_WALLET = walletFromEnv('E2E_LEGACY_SCAN_WALLET', 'carol');
const MOVE_TARGET = walletFromEnv('E2E_LEGACY_MOVE_TARGET', 'alice');
const MOVE_FUNDER = walletFromEnv('E2E_LEGACY_MOVE_FUNDER', 'bob');
const LINK_WALLET = walletFromEnv('E2E_LEGACY_LINK_WALLET', 'carol');
const MOVE_ASSET = (process.env.E2E_LEGACY_MOVE_ASSET ?? 'ltc') as UtxoAsset;
if (!['btc', 'ltc'].includes(MOVE_ASSET)) throw new Error('E2E_LEGACY_MOVE_ASSET must be btc or ltc (an m/44\' address)');
/** About a cent of LTC: clear of dust (546) and of the sweep fee even at the fallback fee rate. */
const MOVE_AMOUNT = process.env.E2E_LEGACY_MOVE_AMOUNT ?? '0.0002';

const ok = (status: number) => status >= 200 && status < 300;

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

/** Nothing found means we looked everywhere and found no coins: no funds, and no failed reads. */
function expectNothingFound(record: LegacyCheckRecord): void {
  const label = (f: LegacyFindingRecord) => `${f.asset}/${f.source}`;
  expect(
    record.findings.filter((f) => f.state === 'funds').map(label),
    'coins found at an older address of a demo wallet: an unexpected discovery for the owner to review',
  ).toEqual([]);
  expect(
    record.findings.filter((f) => f.state === 'error').map(label),
    'the check could not read some older addresses; an unread address is not "nothing found"',
  ).toEqual([]);
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

// ── Flows shared by several tests ───────────────────────────────────────────

/** Leave the screen and return through the tab bar, which remounts it from stored state. */
async function revisitOlderAddresses(w: LiveWallet): Promise<void> {
  await w.footage.tap(w.page.getByTestId('nav-tab-home'), 'Back to Home');
  await w.footage.tap(w.page.getByTestId('nav-tab-settings'), 'Open Settings');
  await expect(w.page.getByTestId('legacy-funds-route')).toBeVisible();
  await w.footage.settled(w.page, 'Settings: Older addresses and tips');
}

async function lockAndUnlock(w: LiveWallet): Promise<number> {
  await tabRoot(w, 'settings', 'Open Settings');
  await w.footage.tap(w.page.getByTestId('settings-lock-now-btn'), 'Lock wallet');
  await expect(w.page.getByTestId('lockscreen-root')).toBeVisible({ timeout: MINUTE });
  await w.footage.settled(w.page, 'Lock wallet');
  const unlockedAt = Date.now();
  await w.enterPassword(
    w.page.getByTestId('lockscreen-password-input'),
    w.page.getByTestId('lockscreen-unlock-btn'),
    'Unlock wallet (redacted)',
  );
  await expect(w.page.getByTestId('lockscreen-root'), 'unlock did not open the wallet').toHaveCount(0, { timeout: 2 * MINUTE });
  return unlockedAt;
}

/** "Look for tips": waits for the sign-in and the list; returns when the lookup began, to filter its requests. */
async function lookForTips(w: LiveWallet): Promise<{ since: number }> {
  const since = Date.now();
  const button = w.page.getByTestId('legacy-find-tips');
  await w.footage.tap(button, 'Look for tips');
  await until(async () => w.responses(since).some((e) => e.host === LEGACY_HOST && e.path.endsWith('/auth/extension')), {
    timeoutMs: 2 * MINUTE,
    intervalMs: 1_000,
    message: 'the wallet never asked the old server to sign it in',
  });
  await expect(button, 'the tip lookup never finished').toBeEnabled({ timeout: 2 * MINUTE });
  return { since };
}

/** Send `amount` of `asset` from Home to `address`; returns the broadcast txid. */
async function sendFromHome(w: LiveWallet, asset: UtxoAsset, address: string, amount: string): Promise<string> {
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

/** Open the asset's history and find the row whose detail names `txid`. Holds on that detail. */
async function historyShows(w: LiveWallet, asset: ClaimAsset, txid: string): Promise<boolean> {
  await tabRoot(w, 'home', 'Back to Home');
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), 'Open asset');
  await expect(w.page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: MINUTE });
  await w.footage.settled(w.page, 'Asset balance');
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
    const found = (await sheet.innerText()).includes(txid);
    if (found) await w.footage.result('Moved: history detail');
    await w.footage.tap(w.page.getByTestId('tx-detail-close'), 'Close detail');
    if (found) return true;
  }
  return false;
}

if (LIVE) {
  // ── F1: the automatic check, its setting, and the read-only manual check ──
  for (const name of WALLET_NAMES) {
    test(`F1 older addresses: automatic check, Home notice, setting and read-only check [${name}]`, async ({ liveWallets }) => {
      test.setTimeout(60 * MINUTE);
      const w = await liveWallets.get(name);

      const auto = await storedCheck(w, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
      expect(auto.mode, 'the automatic check must only read (probe), never register').toBe('probe');
      expectCoverage(auto);
      expectNothingFound(auto);

      await tabRoot(w, 'home', 'Back to Home');
      await expect(w.page.getByTestId('home-total-balance')).toBeVisible();
      await expect(w.page.getByTestId('legacy-funds-banner'), 'Home shows an older-address notice with nothing found').toHaveCount(0);
      await w.footage.result('Home: no older-address notice');

      await openOlderAddresses(w);
      await expect(w.page.getByTestId('legacy-needs-unlock'), 'the screen says the phrase is not in memory right after import').toHaveCount(0);
      // The screen shows what the stored check found: one row per address that is not plainly empty.
      const shown = auto.findings.filter((f) => f.state !== 'empty');
      await expect(w.page.locator('[data-testid^="legacy-finding-"]')).toHaveCount(shown.length);
      await expect(w.page.locator('[data-testid^="legacy-move-"]'), 'a move is offered with nothing found').toHaveCount(0);
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

      // The manual check is read-only too: an address the server did not watch is still not watched.
      const manual = await runCheck(w, 'legacy-check', CHECK_PATIENCE_MS);
      expect(manual.mode).toBe('probe');
      expectCoverage(manual);
      expectNothingFound(manual);
      for (const f of unwatched) {
        expect(manual.findings.find(sameAddress(f))?.state, 'a read-only check registered an older address').toBe('not-scanned');
      }
      await expect(w.page.locator('[data-testid^="legacy-move-"]')).toHaveCount(0);
      await w.footage.result('Read-only check result');

      await tabRoot(w, 'home', 'Back to Home');
      await expect(w.page.getByTestId('legacy-funds-banner')).toHaveCount(0);
      await w.footage.result('Home: no older-address notice');
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
    expectNothingFound(ran);
    await w.footage.result('After unlock: automatic check ran');

    await tabRoot(w, 'home', 'Back to Home');
    await expect(w.page.getByTestId('legacy-funds-banner')).toHaveCount(0);
    await w.footage.result('Home: no older-address notice');
  });

  // ── F2: scanning unwatched older XMR/WOW addresses (owner approval) ────────
  test('F2 scan registers unwatched older Monero and Wownero addresses with the server', async ({ liveWallets }) => {
    test.skip(
      process.env.E2E_LEGACY_SCAN !== '1',
      'shares older XMR/WOW view keys with the production LWS and may pay restore PoW: needs the owner approval E2E_LEGACY_SCAN=1',
    );
    test.skip(skipDestructiveOnShared(), 'registers accounts on a shared backend: set ALLOW_PROD_WRITES=1');
    test.setTimeout(2 * HOUR);
    const w = await liveWallets.get(SCAN_WALLET);
    const before = await storedCheck(w, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
    const unwatched = before.findings.filter((f) => (f.asset === 'xmr' || f.asset === 'wow') && f.state === 'not-scanned');
    test.skip(unwatched.length === 0, 'every older XMR/WOW address of this wallet is already watched; nothing to scan');

    await openOlderAddresses(w);
    const since = Date.now();
    // Restore proof-of-work, when priced, is solved in the wallet before it registers.
    const scanned = await runCheck(w, 'legacy-scan', HOUR);
    expect(scanned.mode).toBe('scan');
    const registrations = w.responses(since).filter((e) => e.method === 'POST' && e.path.endsWith('/wallet/lws/register'));
    expect(registrations.length, 'scanning made no registration request').toBeGreaterThan(0);
    expect(registrations.every((e) => ok(e.status)), 'the server refused a registration').toBe(true);
    for (const f of unwatched) {
      const now = scanned.findings.find(sameAddress(f));
      expect(now?.state, 'an older address is still unwatched after scanning').not.toBe('not-scanned');
      expect(now?.state, 'scanning an older address failed').not.toBe('error');
    }
    await w.footage.result('Scan registered with the server');

    // Watched from now on: a plain read-only check sees each one.
    const reread = await runCheck(w, 'legacy-check', CHECK_PATIENCE_MS);
    for (const f of unwatched) {
      expect(['scanning', 'empty', 'funds'], 'a scanned address dropped back to unwatched').toContain(
        reread.findings.find(sameAddress(f))?.state,
      );
    }
    await w.footage.result('Read-only check result');
  });

  // ── F3: tips waiting on the old server ─────────────────────────────────────
  for (const name of WALLET_NAMES) {
    test(`F3 look for tips signs in to the old server and lists what waits there [${name}]`, async ({ liveWallets }) => {
      test.setTimeout(30 * MINUTE);
      const w = await liveWallets.get(name);
      await openOlderAddresses(w);
      const { since } = await lookForTips(w);
      const legacy = () => w.responses(since).filter((e) => e.host === LEGACY_HOST);

      const signIn = legacy().filter((e) => e.method === 'POST' && e.path.endsWith('/auth/extension'));
      expect(signIn.length).toBeGreaterThan(0);
      expect(signIn.every((e) => ok(e.status)), 'the old server refused the m/44\' sign-in').toBe(true);
      // The wallet reads received tips only when the sign-in matched an EXISTING old account.
      const listed = legacy().filter((e) => e.method === 'GET' && e.path.endsWith('/tips/social/received'));
      expect(
        listed.length,
        "the old server had no account for this wallet's m/44' key, so no tips were read (expected a legacy v2 identity)",
      ).toBeGreaterThan(0);
      expect(listed.every((e) => ok(e.status)), 'the old server refused the tip list').toBe(true);
      expect(
        legacy().filter((e) => /\/(claim|confirm-sweep)$/.test(e.path)),
        'looking for tips wrote to the old server',
      ).toEqual([]);

      await expect(w.page.getByTestId('legacy-message'), 'the tip lookup reported an error').toHaveCount(0);
      const rows = w.page.getByTestId('legacy-tip-row');
      for (let i = 0; i < (await rows.count()); i++) {
        // Each waiting tip shows its amount, and either an action or its confirmations.
        await expect(rows.nth(i)).toContainText(/\d/);
      }
      await w.footage.result('Old-server tips');
    });
  }

  // ── F4: the move flow on an approved fixture ──────────────────────────────
  test('F4 move to my wallet moves only settled funds and records the move', async ({ liveWallets }) => {
    test.skip(
      process.env.E2E_LEGACY_MOVE_FIXTURE !== '1',
      "no approved older-address fixture: E2E_LEGACY_MOVE_FIXTURE=1 lets the funder send a small amount to the target's own m/44' address",
    );
    test.skip(!LIVE_MONEY, 'moves real coins: set E2E_LIVE_MONEY=1');
    test.skip(skipDestructiveOnShared(), 'broadcasts through a shared backend: set ALLOW_PROD_WRITES=1');
    test.skip(MOVE_TARGET === MOVE_FUNDER, 'the funder and the target must be different demo wallets');
    test.setTimeout(5 * HOUR);
    const ticker = MOVE_ASSET.toUpperCase();
    const target = await liveWallets.get(MOVE_TARGET);
    const funder = await liveWallets.get(MOVE_FUNDER);

    // The target's own older address, from its stored check (public data).
    const start = await storedCheck(target, CHECK_PATIENCE_MS, 'the automatic older-address check never ran after import');
    const older = start.findings.find((f) => f.asset === MOVE_ASSET && f.source === 'm44');
    expect(older, "the check record has no m/44' address for the fixture asset").toBeTruthy();
    expect(older!.state, 'the older address already holds coins; settle those before creating a fixture').toBe('empty');

    const funderBefore = await assetBalance(funder, MOVE_ASSET, 'result');
    test.skip(funderBefore < Number(MOVE_AMOUNT) * 3, `the funder lacks ${ticker} for the fixture (needs about three times the amount, for fees)`);
    const targetBefore = await assetBalance(target, MOVE_ASSET, 'result');
    const journalBefore = await sendJournalState(target.page);

    // 1. Create the fixture: the funder pays the target's older address.
    const fundingTxid = await sendFromHome(funder, MOVE_ASSET, older!.address, MOVE_AMOUNT);
    expect(fundingTxid, 'the fixture send did not return a txid').toMatch(/^[0-9a-fA-F]{64}$/);

    // 2. The target checks until the coins settle. While they are only arriving, nothing is movable.
    await openOlderAddresses(target);
    let ready: LegacyFindingRecord | undefined;
    await until(
      async () => {
        const r = await runCheck(target, 'legacy-check', CHECK_PATIENCE_MS);
        const f = r.findings.find(sameAddress(older!));
        expect(f?.state, 'the older address could not be read').not.toBe('error');
        if (f?.state === 'funds' && BigInt(f.spendableAtomic) === 0n && BigInt(f.pendingAtomic) > 0n) {
          await expect(target.page.getByTestId(`legacy-finding-${MOVE_ASSET}`)).toBeVisible();
          await expect(
            target.page.getByTestId(`legacy-move-${MOVE_ASSET}`),
            'a move was offered for coins that have not settled',
          ).toHaveCount(0);
          await target.footage.result('Funds still arriving at the older address');
        }
        if (f?.state === 'funds' && BigInt(f.spendableAtomic) > 0n) ready = f;
        return ready !== undefined;
      },
      { timeoutMs: 2 * HOUR, intervalMs: 3 * MINUTE, message: 'the fixture never settled at the older address' },
    );

    // 3. Home points at it.
    await tabRoot(target, 'home', 'Back to Home');
    const banner = target.page.getByTestId('legacy-funds-banner');
    await expect(banner, 'Home shows no notice for coins at an older address').toBeVisible({ timeout: 2 * MINUTE });
    await target.footage.result('Home: older-address notice');
    await target.footage.tap(banner, 'Open the notice');
    await expect(target.page.getByTestId('legacy-funds-route')).toBeVisible();
    await expect(target.page.getByTestId(`legacy-finding-${MOVE_ASSET}`)).toContainText(ticker);
    await target.footage.result('Funds ready to move');

    // 4. Amount and fee before signing; then move.
    const broadcast = nextUtxoBroadcastTxid(target.page, 30 * MINUTE);
    await target.footage.tap(target.page.getByTestId(`legacy-move-${MOVE_ASSET}`), 'Move to my wallet');
    const confirm = target.page.getByTestId('legacy-confirm');
    await expect(confirm, 'no amount and fee were shown before signing').toBeVisible({ timeout: 5 * MINUTE });
    const figures = [...(await confirm.innerText()).matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${ticker}`, 'g'))].map((m) =>
      Number(m[1]),
    );
    expect(figures.length, 'the confirmation should state the amount and the network fee').toBeGreaterThanOrEqual(2);
    const [amount = 0, fee = 0] = figures;
    expect(amount).toBeGreaterThan(0);
    expect(fee).toBeGreaterThan(0);
    expect(amount + fee, 'the move would spend more than the settled coins').toBeLessThanOrEqual(Number(ready!.spendableAtomic) / 1e8 + 1e-8);
    await target.footage.result('Move: amount and fee');
    await target.footage.tap(target.page.getByTestId('legacy-confirm-move'), 'Move: confirm');
    await target.confirmOperationPasswordIfAsked();
    // The outcome message appears on success and on refusal; the stored check tells them apart.
    await expect(target.page.getByTestId('legacy-message'), 'the move never finished').toBeVisible({ timeout: 15 * MINUTE });
    await expect(target.page.getByTestId(`legacy-move-${MOVE_ASSET}`), 'the moved coins are still offered').toHaveCount(0);
    const moved = (await readLegacyRecord(target.page))!.findings.find(sameAddress(older!));
    expect(moved?.spendableAtomic, 'the move did not complete: the stored check still counts the coins').toBe('0');
    const moveTxid = await broadcast;
    expect(moveTxid, 'the move did not broadcast').toMatch(/^[0-9a-fA-F]{64}$/);
    await target.footage.result('Moved: result');

    // 5. Recorded: the encrypted send journal grew, and history names the transaction.
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
    }
    await until(() => historyShows(target, MOVE_ASSET, moveTxid), {
      timeoutMs: HOUR,
      intervalMs: 2 * MINUTE,
      message: 'history never showed the move',
    });

    // 6. The balance rises once the network confirms; the funder paid for the fixture.
    await until(async () => (await assetBalance(target, MOVE_ASSET, 'settled')) >= targetBefore + amount - 1e-8, {
      timeoutMs: 2 * HOUR,
      intervalMs: 3 * MINUTE,
      message: 'the moved coins never reached the wallet balance',
    });
    await assetBalance(target, MOVE_ASSET, 'result');
    await target.footage.result('Moved: balance confirmed');
    await until(async () => (await assetBalance(funder, MOVE_ASSET, 'settled')) <= funderBefore - Number(MOVE_AMOUNT) + 1e-8, {
      timeoutMs: HOUR,
      intervalMs: 3 * MINUTE,
      message: 'the funder balance never reflected the fixture send',
    });
  });

  // ── F5: finishing a stuck old-server claim ─────────────────────────────────
  test('F5 finish claim completes a stuck old-server tip', async ({ liveWallets }) => {
    test.skip(!LIVE_MONEY, 'claims real coins: set E2E_LIVE_MONEY=1');
    test.skip(skipDestructiveOnShared(), 'writes to the old server: set ALLOW_PROD_WRITES=1');
    test.setTimeout(4 * HOUR);
    let holder: LiveWallet | null = null;
    let asset: ClaimAsset | null = null;
    for (const name of WALLET_NAMES) {
      const w = await liveWallets.get(name);
      await openOlderAddresses(w);
      await lookForTips(w);
      const stuck = w.page.getByTestId('legacy-tip-row').filter({ has: w.page.getByRole('button', { name: /finish/i }) });
      if ((await stuck.count()) > 0) {
        holder = w;
        asset = ((await stuck.first().innerText()).match(/\b(BTC|LTC|XMR|WOW)\b/)?.[1]?.toLowerCase() ?? null) as ClaimAsset | null;
        break;
      }
    }
    test.skip(holder === null, 'no stuck old-server claim exists for alice, bob or carol (expected: no legacy tip fixture is known)');
    expect(asset, 'the stuck tip is not in a claimable asset').not.toBeNull();
    const w = holder!;
    const before = await assetBalance(w, asset!, 'result');

    await openOlderAddresses(w);
    const { since } = await lookForTips(w);
    const stuck = w.page.getByTestId('legacy-tip-row').filter({ has: w.page.getByRole('button', { name: /finish/i }) });
    const rowsBefore = await w.page.getByTestId('legacy-tip-row').count();
    await w.footage.tap(stuck.first().getByRole('button'), 'Finish claim');
    await w.confirmOperationPasswordIfAsked();
    await expect(w.page.getByTestId('legacy-message')).toBeVisible({ timeout: 30 * MINUTE });
    await expect(w.page.getByTestId('legacy-tip-row'), 'the claimed tip is still listed').toHaveCount(rowsBefore - 1);
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

  // ── F6: claiming an old-server link tip ───────────────────────────────────
  test('F6 a link tip only the old server knows is claimed through the fallback', async ({ liveWallets }) => {
    const file = process.env.E2E_LEGACY_TIP_LINK_FILE;
    test.skip(
      !file,
      'no legacy link-tip fixture (expected: none is known). Provide LEGACY_TIP_LINK in an owner-only file named by E2E_LEGACY_TIP_LINK_FILE.',
    );
    test.skip(!LIVE_MONEY, 'claims real coins: set E2E_LIVE_MONEY=1');
    test.skip(skipDestructiveOnShared(), 'writes to the old server: set ALLOW_PROD_WRITES=1');
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
    test.skip(info.is_claimable !== true, 'the old-server link tip is not claimable (unconfirmed or already claimed)');
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
