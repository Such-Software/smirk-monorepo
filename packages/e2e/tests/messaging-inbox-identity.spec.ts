import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * Nostr identity overhaul (v0.3.0) nav smoke: daemon-free.
 *
 * Guards the Phase 4-6 wiring of the identity feature without touching the
 * chain daemon or a live Nostr relay:
 *
 *   - Phase 6 (messaging → Inbox): the Inbox tab exposes a "Messages" entry
 *     (`inbox-messages-btn`) that opens the encrypted-DM surface
 *     (`messages-screen`) as an `inbox/messages` drill-down. Before the
 *     merge this surface lived under Settings; the entry + drill-down are the
 *     merge. The surface renders its `messages-screen` root unconditionally
 *     (past any wallet-lock); this is also the regression guard for the
 *     original "Unlock the wallet to use messaging" warm-resume bug: the DM
 *     surface must render its shell, not a blanket lock screen.
 *   - Phase 6 (retirement): the old Settings → Messages nav row is gone
 *     (`settings-messages-nav` must not exist).
 *   - Phase 5 (header switcher): the always-visible active-identity chip
 *     (`header-identity-switcher`) renders on an unlocked Home.
 *
 * Auth: import alice (already-registered) via the shared `importAndUnlock`
 * helper, which returns once a REAL backend balance renders on Home. See
 * settings-and-inbox.spec.ts / fixtures/onboard.ts for the full rationale on
 * why we never wait on the offscreen `/auth/extension` POST.
 *
 * Requires the extension built with VITE_SMIRK_BACKEND_URL → local backend
 * (dist already is) and the seeds sourced:
 *
 *   set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Inbox → Messages opens the DM surface (Phase 6 merge)', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // Inbox tab → the merged "Messages" entry.
  await page.getByTestId('nav-tab-inbox').click();
  await expect(page.getByTestId('inbox-tab')).toBeVisible({ timeout: 30_000 });
  const messagesEntry = page.getByTestId('inbox-messages-btn');
  await expect(messagesEntry).toBeVisible();

  // Opening it lands on the DM surface: the shell renders regardless of
  // whether this backend runs a relay, and crucially NOT a wallet-lock. This
  // is the regression guard for the warm-resume "Unlock the wallet" bug.
  await messagesEntry.click();
  await expect(page.getByTestId('messages-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('Unlock the wallet to use messaging');

  // Nav-highlight regression: the inbox/messages drill-down keeps the Inbox tab
  // active (it was mis-highlighting Home when the route was home/inbox/messages).
  await expect(page.getByTestId('nav-tab-inbox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('nav-tab-home')).toHaveAttribute('aria-selected', 'false');
});

test('Header identity chip → Manage identities opens the hub (single identity)', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  const chip = page.getByTestId('header-identity-switcher');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  // Interactive even with a single identity, because the Manage action is present.
  await expect(chip).toBeEnabled();
  await chip.click();

  // The dropdown carries a "Manage identities…" listbox option that routes to
  // the Nostr identities hub: the fix for the previously-dead single-identity chip.
  await page.getByRole('option', { name: /Manage identities/ }).click();
  await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 30_000 });

  // The encrypted vault backup affordance (burner/imported recovery path) renders
  // in the hub and is enabled on a fresh (seed-in-memory) unlock.
  await expect(page.getByTestId('nostr-export-backup')).toBeVisible();
  await expect(page.getByTestId('nostr-export-backup')).toBeEnabled();
});

test('Settings → Messages nav row is retired (Phase 6)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  await page.getByTestId('nav-tab-settings').click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });

  // The standalone Settings → Messages entry moved into the Inbox; it must be gone.
  await expect(page.getByTestId('settings-messages-nav')).toHaveCount(0);
});

test('Header shows the active-identity switcher on unlocked Home (Phase 5)', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // The always-visible active-identity chip lives in the app header
  // (AppShell.headerActions). It loads its identity list asynchronously.
  await expect(page.getByTestId('header-identity-switcher')).toBeVisible({ timeout: 30_000 });
});
