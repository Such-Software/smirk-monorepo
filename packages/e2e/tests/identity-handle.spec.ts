/**
 * The identity screen must never present a control that silently does nothing.
 *
 * Written after a real report: "I do NOT see jwinterm@smirk.cash anywhere in the
 * identity section and that link to nostr button doesn't seem to do anything."
 * Both halves were real, and both were invisible to the suite:
 *
 *   1. On a WARM RESUME (popup reopened while the session is still valid, without
 *      retyping the password) the seed is deliberately dropped. `onLinkActive`
 *      opened with `if (!vault || !mnemonic) return;` and the button itself was
 *      rendered `disabled`, so the single control that activates a handle did
 *      nothing at all and said nothing about why. The sibling handlers (`commit`,
 *      `onPublishProfile`) already did the right thing and prompted for the
 *      password, which is what made this a one-line divergence nobody noticed.
 *
 *   2. `publishNip05Profile` returned early when the account had no username and
 *      swallowed every error, so "Publish handle to Nostr" spun and stopped with
 *      no output whether it worked, had nothing to publish, or failed outright.
 *
 * The property under test is deliberately weak and therefore durable: after
 * clicking, SOMETHING must change on screen. It does not assert which remedy is
 * offered, so it keeps passing if the UX is reworked, and fails the moment a
 * control goes back to being a no-op.
 */

import { test, expect } from '../fixtures/extension.js';
import type { Page } from '@playwright/test';
import { importAndUnlock } from '../fixtures/onboard.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

async function openIdentity(page: Page) {
  await page.getByTestId('nav-tab-settings').click();
  const nav = page.getByTestId('settings-nostr-nav');
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await nav.click();
  await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 20_000 });
}

test('the identity screen states whether a handle exists, rather than rendering nothing', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  await openIdentity(page);
  footage.mark('identity-open', 'Nostr identity screen');

  // Exactly one of these must be shown once /auth/me resolves. Previously a
  // handle-less (or unauthenticated) account rendered NEITHER: a blank gap that
  // gave the user nothing to act on, which is the reported bug.
  const present = page.getByTestId('nostr-handle');
  const absent = page.getByTestId('nostr-handle-absent');
  await expect
    .poll(
      async () =>
        (await present.isVisible().catch(() => false)) ||
        (await absent.isVisible().catch(() => false)),
      {
        timeout: 30_000,
        message:
          'the identity screen showed neither a handle nor an explanation of why ' +
          'there is none, so a user cannot tell a missing handle from a broken session',
      },
    )
    .toBe(true);

  if (await present.isVisible().catch(() => false)) {
    // A displayed handle must be a real `name@domain`, not a bare placeholder.
    await expect(present).toContainText('@');
    footage.mark('identity-handle-shown', 'account handle rendered');
  } else {
    // The no-handle path has to offer a way OUT of having no handle. Before this
    // change `setMySmirkUsername` had a single call site in the onboarding
    // wizard, so anyone who skipped or failed that step could never get one.
    await expect(
      page.getByTestId('nostr-claim-handle-input'),
      'no handle and no way to claim one: the only claim path was onboarding',
    ).toBeVisible({ timeout: 15_000 });
    footage.mark('identity-claim-offered', 'handle claim offered post-onboarding');
  }
});

test('the identity action reports an outcome instead of failing silently', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  await openIdentity(page);
  footage.mark('identity-action-before', 'identity screen before pressing the action');

  // Reach the linked state, since "Publish handle to Nostr" only exists there.
  const link = page.getByTestId('nostr-link-btn');
  if (await link.isVisible().catch(() => false)) {
    await expect(
      link,
      'the link control is disabled, which to a user is indistinguishable from broken',
    ).toBeEnabled();
    await link.click();
    footage.mark('identity-linked', 'primary identity linked to the account');
  }

  const publish = page.getByTestId('nostr-publish-profile');
  await expect(
    publish,
    'the publish control never appeared, so the linked state was never reached',
  ).toBeVisible({ timeout: 30_000 });
  await expect(publish).toBeEnabled();

  await publish.click();

  // The whole point. `publishNip05Profile` used to `return` on the most common
  // case (this account claimed no username) and swallow every error, so the button
  // spun and stopped identically whether it published, had nothing to publish, or
  // failed. It must now say which of those happened.
  const result = page.getByTestId('nostr-publish-result');
  await expect(
    result,
    'pressing "Publish handle to Nostr" reported nothing at all: success, ' +
      'nothing-to-publish, and outright failure were indistinguishable. This is ' +
      'the exact "button does nothing" report that prompted this spec.',
  ).toBeVisible({ timeout: 30_000 });

  const said = (await result.textContent())?.trim() ?? '';
  expect(said.length, 'the publish result rendered empty').toBeGreaterThan(0);
  console.log(`[identity] publish reported: ${said}`);
  footage.mark('identity-publish-reports', 'publish reports an outcome instead of silence');
});

/**
 * WARM RESUME: the state where the wallet is unlocked but the seed is gone.
 *
 * This is where both "button does nothing" reports actually lived, and it took
 * two attempts to reach it. A plain popup reopen is NOT a warm resume: the auto
 * lock default is 0 minutes, and `writeSessionCache` DELETES the cache outright
 * when the value is 0 (`session-cache.ts:91`). So with stock settings every
 * reopen is a cold start and the interesting state is unreachable. It only
 * exists once the user has set an auto-lock window, which is exactly the
 * configuration the bug was reported from.
 *
 * The sequence below is therefore deliberate: set an auto-lock window, then lock
 * and unlock so `writeSessionCache` runs with a non-zero value and actually
 * persists, and only then reopen.
 *
 * The failure being guarded is subtle. `onLinkActive` called
 * `setShowUnlock(true)`, but when the password field is ALREADY open that is a
 * no-op: no state changes, nothing scrolls, and `autoFocus` does not re-fire
 * because the input never remounts. The control therefore stayed visibly inert
 * even after being "fixed" once. So this asserts on feedback AT the control, not
 * merely that the password field exists somewhere on the page.
 */
test('warm resume: the link control asks for the password instead of going inert', async ({
  context,
  extensionId,
  footage,
}) => {
  const PASSWORD = 'e2e-test-password-123';
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });

  // Auto-lock must be non-zero or no session cache is ever written.
  await page.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: {
        get: (k: string) => Promise<Record<string, unknown>>;
        set: (o: Record<string, unknown>) => Promise<void>;
      } } };
    }).chrome;
    const key = 'smirk:popup-state';
    const cur = (await chromeApi.storage.local.get(key))[key] as
      | { ui?: Record<string, unknown> }
      | undefined;
    await chromeApi.storage.local.set({
      [key]: { ...(cur ?? {}), ui: { ...(cur?.ui ?? {}), autoLockMinutes: 15 } },
    });
  });

  // Lock, then unlock through the real lock screen so writeSessionCache runs
  // with the new window and the cache actually persists.
  await page.getByTestId('nav-tab-settings').click();
  const lockNow = page.getByTestId('settings-lock-now-btn');
  await expect(lockNow).toBeVisible({ timeout: 20_000 });
  await lockNow.click();

  const pw = page.getByTestId('lockscreen-password-input');
  await expect(pw).toBeVisible({ timeout: 20_000 });
  await pw.fill(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('nav-tab-settings')).toBeVisible({ timeout: 40_000 });
  await page.close();

  // Reopen: unlocked from the session cache, but WITHOUT the seed.
  const warm = await context.newPage();
  await warm.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    warm.getByTestId('nav-tab-settings'),
    'not a warm resume: the wallet came back locked, so the session cache did not persist',
  ).toBeVisible({ timeout: 40_000 });
  await openIdentity(warm);
  footage.mark('warm-resume', 'unlocked from session cache, seed not in memory');

  // Confirm the premise: the seed really is absent. The read-only banner and the
  // inline password field are the app's own signal for that state.
  await expect(
    warm.getByTestId('nostr-unlock-input').or(warm.getByTestId('nostr-unlock-manage')),
    'no warm-resume affordance, so the seed may still be in memory and this ' +
      'test would not be exercising the state it claims to',
  ).toBeVisible({ timeout: 20_000 });

  // Open the password field FIRST, so the control's handler hits the exact
  // no-op case: asking for an unlock that is already on screen.
  const manage = warm.getByTestId('nostr-unlock-manage');
  if (await manage.isVisible().catch(() => false)) await manage.click();
  await expect(warm.getByTestId('nostr-unlock-input')).toBeVisible({ timeout: 15_000 });

  const link = warm.getByTestId('nostr-link-btn');
  const publish = warm.getByTestId('nostr-publish-profile');
  const target = (await link.isVisible().catch(() => false)) ? link : publish;
  await expect(target).toBeVisible({ timeout: 20_000 });
  await expect(
    target,
    'disabled on a warm resume, which is indistinguishable from broken',
  ).toBeEnabled();

  await target.click();

  // Feedback must appear AT the control. Asserting the password field is visible
  // would pass vacuously here, since it was already open before the click.
  await expect(
    warm.getByTestId('nostr-unlock-prompt'),
    'the control was pressed and said nothing: the password field was already ' +
      'open, so setShowUnlock(true) changed nothing and the button read as dead',
  ).toBeVisible({ timeout: 20_000 });

  const said = (await warm.getByTestId('nostr-unlock-prompt').textContent())?.trim() ?? '';
  expect(said.toLowerCase()).toContain('password');
  console.log(`[identity] warm-resume control reported: ${said}`);
  footage.mark('warm-resume-prompts', 'control asks for the password instead of no-opping');
});
