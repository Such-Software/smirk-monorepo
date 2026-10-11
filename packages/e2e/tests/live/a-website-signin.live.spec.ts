/**
 * Live area A: website sign-in. alice signs in on smirk.cash under "lock every
 * time" with one approval window and one password, and the wallet's own Home
 * still asks for the password afterwards. A local dummy origin then asks for
 * what the wallet must refuse: a smirk.cash challenge (#27) and a signature over
 * an empty or non-string value (#29). Neither refusal may open a prompt.
 *
 * Runs only under playwright.live.config.ts (E2E_LIVE=1). The approval window
 * and the site are recorded by the guarded recorder because they open in
 * alice's browser context; the password is typed inside a secret scope.
 */
import type { BrowserContext, Page } from '@playwright/test';
import {
  WEBSITE_URL,
  declareUnproven,
  expect,
  onLiveLane,
  openHome,
  tabRoot,
  test,
  unlock,
} from '../../fixtures/live-wallets.js';
import { sessionExpiry, startDummySite, websiteChallenge } from '../../fixtures/A-onboarding-identity-helpers.js';
import { BACKEND_URL } from '../../fixtures/extension.js';

/** Collect every approval window the context opens from now on. */
function watchApprovals(context: BrowserContext): { windows: Page[]; stop(): void } {
  const windows: Page[] = [];
  const onPage = (page: Page) => {
    void page.waitForURL(/#approval\//, { timeout: 15_000 }).then(() => windows.push(page), () => {});
  };
  context.on('page', onPage);
  return { windows, stop: () => context.off('page', onPage) };
}

if (onLiveLane()) defineScenarios();

function defineScenarios(): void {
  test('sign in on smirk.cash with one approval and one password; Home still asks for the password', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    expect(alice.userId, 'alice has no backend user id to compare the website session with').toBeTruthy();
    const walletPage = await openHome(footage, alice);
    await tabRoot(footage, walletPage, 'settings');
    await footage.choose(walletPage.getByTestId('settings-autolock-select'), '0', 'auto-lock immediately');
    await expect.poll(() => sessionExpiry(walletPage)).toBeUndefined();
    await footage.settled(walletPage, 'lock every time');
    // A popup closes when the user moves to another window; start from there.
    await walletPage.close();

    const context = alice.profile.context;
    const approvals = watchApprovals(context);
    const site = await context.newPage();
    try {
      await site.goto(WEBSITE_URL);
      const connect = site.getByRole('button', { name: 'Connect with Smirk' });
      await expect(connect, 'smirk.cash never detected the wallet').toBeEnabled({ timeout: 30_000 });
      await footage.settled(site, 'smirk.cash');
      // v0.3.1's wallet offers signIn: connect and sign in one approval. A site
      // still on connect() then signMessage() opens a connect approval first.
      // Follow whichever flow the live site runs, count the approval windows and
      // the passwords, and fail (softly, after the whole flow is recorded) when
      // the sign-in needed more than one of either.
      let passwords = 0;
      const answer = async (approval: Page, label: string): Promise<void> => {
        await approval.waitForURL(/#approval\//, { timeout: 30_000 });
        const lock = approval.getByTestId('lockscreen-password-input');
        const approve = approval.getByRole('button', { name: 'Approve', exact: true });
        await lock.or(approve).first().waitFor({ timeout: 30_000 });
        if (await lock.isVisible()) {
          // Lock every time: the approval window opens on the lock screen.
          await unlock(footage, alice, approval);
          passwords += 1;
        }
        await expect(approve).toBeVisible({ timeout: 30_000 });
        await expect(approval.locator('body')).toContainText(new URL(WEBSITE_URL).host);
        await footage.result(approval, label);
        await footage.tap(approve, `approve the ${label}`);
        await expect.poll(() => approval.isClosed(), { timeout: 30_000, message: 'the approval window stayed open' }).toBe(true);
      };
      const choose = site.getByText('Choose your coin to sign in');
      const firstWindow = context.waitForEvent('page', { timeout: 30_000 });
      await footage.tap(connect, 'connect with Smirk');
      const first = await Promise.race([
        choose.waitFor({ timeout: 30_000 }).then(() => null),
        firstWindow,
      ]);
      firstWindow.catch(() => undefined);
      if (first) await answer(first, 'connect approval');
      await expect(choose).toBeVisible({ timeout: 30_000 });
      await footage.settled(site, 'choose a coin');

      const opened = context.waitForEvent('page', { timeout: 60_000 });
      await footage.tap(site.locator('button.coin-btn').filter({ hasText: /^\s*btc\s*$/i }), 'sign in with BTC');
      await answer(await opened, 'sign-in approval');

      await expect(site.getByText('Logged in!'), 'smirk.cash did not reach its signed-in state').toBeVisible({ timeout: 60_000 });
      await expect(site.getByText(/Signed in with BTC/i)).toBeVisible();
      await expect(site.locator('body'), 'smirk.cash signed in to a different account than the wallet').toContainText(alice.userId!);
      await footage.result(site, 'signed in on smirk.cash');
      footage.fact('sign-in approval windows', approvals.windows.length);
      footage.fact('sign-in passwords', passwords);
      expect.soft(passwords, 'the sign-in asked for the password more than once').toBe(1);
      expect.soft(
        approvals.windows.length,
        'the sign-in needed more than one approval window (the site does not use the wallet\'s one-approval signIn)',
      ).toBe(1);
      await expect(site.getByText('Choose your coin to sign in'), 'the site asked again after signing in').toHaveCount(0);

      // The sign-in grace serves only that site and tab: the wallet itself is still locked.
      const home = await alice.profile.openPage();
      await expect(home.getByTestId('lockscreen-root'), 'the website sign-in unlocked the wallet Home').toBeVisible({ timeout: 30_000 });
      await expect(home.getByTestId('bottom-nav')).toHaveCount(0);
      await footage.result(home, 'wallet home still locked');
      await unlock(footage, alice, home);

      await tabRoot(footage, home, 'settings');
      const sites = home.getByTestId('settings-connected-sites');
      await sites.scrollIntoViewIfNeeded();
      await expect(sites, 'smirk.cash is not listed under connected sites').toContainText(new URL(WEBSITE_URL).host, { timeout: 15_000 });
      await footage.result(home, 'smirk.cash connected');
    } finally {
      approvals.stop();
      await site.close().catch(() => {});
    }
  });

  test('a local dummy origin cannot get a smirk.cash challenge signed (#27)', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    const server = await startDummySite();
    const context = alice.profile.context;
    const approvals = watchApprovals(context);
    const page = await context.newPage();
    try {
      // A backend-issued challenge only with ALLOW_PROD_WRITES=1: asking for one
      // stores a nonce on production. The wallet's check reads the text alone.
      const challenge = await websiteChallenge(BACKEND_URL);
      if (challenge.live) {
        test.info().annotations.push({ type: 'challenge', description: 'a real challenge issued by the backend for https://smirk.cash' });
      } else {
        declareUnproven(process.env.ALLOW_PROD_WRITES === '1'
          ? '#27 used the documented challenge format: the backend refused to issue one'
          : '#27 used the documented challenge format, not one the backend issued (set ALLOW_PROD_WRITES=1 to ask production for one)');
      }
      await page.goto(server.url);
      await expect.poll(() => page.evaluate(() => typeof (window as unknown as { smirk?: { signIn?: unknown } }).smirk?.signIn === 'function'), {
        timeout: 30_000, message: 'window.smirk was not injected on the dummy origin',
      }).toBe(true);
      await page.evaluate((text) => { (window as unknown as { smirkChallenge: string }).smirkChallenge = text; }, challenge.text);
      await footage.settled(page, 'dummy origin');

      await footage.tap(page.getByTestId('try-foreign-signin'), 'ask to sign the smirk.cash challenge');
      const result = page.getByTestId('result-foreign-signin');
      await expect(result).toHaveAttribute('data-outcome', 'refused', { timeout: 30_000 });
      await expect(result).toContainText(/sign in to Smirk as itself/);
      await footage.result(page, 'foreign challenge refused');
      expect(approvals.windows.length, 'the refused challenge still opened an approval window').toBe(0);
    } finally {
      approvals.stop();
      await page.close().catch(() => {});
      await server.close();
    }
  });

  test('signing refuses an empty or non-string message before any prompt (#29)', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    const server = await startDummySite();
    const context = alice.profile.context;
    const approvals = watchApprovals(context);
    const page = await context.newPage();
    try {
      await page.goto(server.url);
      await expect.poll(() => page.evaluate(() => typeof (window as unknown as { smirk?: { signMessage?: unknown } }).smirk?.signMessage === 'function'), {
        timeout: 30_000, message: 'window.smirk was not injected on the dummy origin',
      }).toBe(true);
      await footage.settled(page, 'dummy origin');

      const cases = [
        ['empty-sign', 'sign an empty message', /empty message/],
        ['number-sign', 'sign a number', /must be text/],
        ['array-sign', 'sign an array', /must be text/],
        ['object-sign', 'sign an object', /must be text/],
        ['empty-signin', 'sign in with an empty message', /empty message/],
      ] as const;
      for (const [id, label, reason] of cases) {
        await footage.tap(page.getByTestId(`try-${id}`), label);
        const result = page.getByTestId(`result-${id}`);
        await expect(result, `${label} was not refused`).toHaveAttribute('data-outcome', 'refused', { timeout: 30_000 });
        await expect(result).toContainText(reason);
        await footage.settled(page, 'refused');
      }
      await footage.result(page, 'every malformed request refused');
      expect(approvals.windows.length, 'a refused request still opened an approval window').toBe(0);

      // Control: an ordinary sign-in from the same origin does reach the user,
      // so the refusals above are the checks working, not a dead bridge.
      const opened = context.waitForEvent('page', { timeout: 60_000 });
      await footage.tap(page.getByTestId('try-plain-signin'), 'sign in with an ordinary message');
      const approval = await opened;
      await approval.waitForURL(/#approval\//, { timeout: 30_000 });
      await footage.settled(approval, 'ordinary request prompts');
      await approval.close();
      const control = page.getByTestId('result-plain-signin');
      await expect(control, 'closing the prompt did not reject the request').toHaveAttribute('data-outcome', 'rejected', { timeout: 30_000 });
      await footage.result(page, 'ordinary request reached the user');
      expect(approvals.windows.length).toBe(1);
    } finally {
      approvals.stop();
      await page.close().catch(() => {});
      await server.close();
    }
  });
}
