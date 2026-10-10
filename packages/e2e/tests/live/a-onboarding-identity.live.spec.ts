/**
 * Live area A: onboarding, lock policy, settings and identity, on the v0.3.1
 * release candidate against production, recorded through guarded footage.
 *
 * Runs only under playwright.live.config.ts (E2E_LIVE=1). Scenarios that write
 * to production (a new user row, a handle, a published profile) also need
 * ALLOW_PROD_WRITES=1 and otherwise skip with that reason. Nothing here moves
 * funds. Secrets never reach a frame: phrase and password entry run inside
 * `footage.secret`, password fields are asserted masked, and the recovery
 * phrase reveal is counted inside the page so its words never cross into this
 * process.
 *
 * Every step asserts an outcome the backend or the wallet had to produce: a user
 * id, an npub, balances, history, a lock screen, a claimed handle. The demo
 * wallets are compared with what they were before v0.3.1 existed
 * (fixtures/A-onboarding-identity-baseline.ts), not only with another v0.3.1
 * import, which would agree with itself. A claim a test cannot check is
 * declared, and the lane's reporter lists it as not proven.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  ASSETS,
  DEMO_WALLETS,
  RELEASE_CANDIDATE,
  SecretValue,
  TICKERS,
  confirmPasswordIfAsked,
  custodyStatus,
  declareUnproven,
  expect,
  expectedSkip,
  finishOnboarding,
  historyAmounts,
  homeBalances,
  isPositive,
  missingReceipts,
  onLiveLane,
  openHome,
  readNpub,
  requireProdWrites,
  sentTipSummaries,
  setPasswordAndSubmit,
  settingsSection,
  tabRoot,
  test,
  unlock,
  wipeWords,
  type AssetId,
  type DemoWallet,
  type LiveWallet,
} from '../../fixtures/live-wallets.js';
import { openCreateTab, recordClipboardWrites, copiedExactly, sessionExpiry, watchForProofOfWork } from '../../fixtures/A-onboarding-identity-helpers.js';
import { baselineFor, loadBaseline, type WalletBaseline } from '../../fixtures/A-onboarding-identity-baseline.js';
import { getCapabilities } from '../../fixtures/capabilities.js';
import { BACKEND_URL } from '../../fixtures/extension.js';
import type { GuardedFootage } from '../../fixtures/guarded-footage.js';

const DEMO: DemoWallet[] = ['alice', 'bob', 'carol'];
/** Long enough to catch a beacon that merely waits a little before firing. */
const OBSERVE_MS = 5_000;

if (onLiveLane()) defineScenarios();

function defineScenarios(): void {
  test('cold launch shows onboarding, contacts nothing, and hands Create to a tab', async ({ wallets, footage }) => {
    // The profile runs behind a refusing proxy that records every host the
    // browser tries from launch on, which Playwright's request events cannot:
    // the service worker before any listener attaches, the offscreen document
    // Playwright detaches from, and WebSocket upgrades. Hosts of Chromium's own
    // services that the extension bundle never names are the browser's and are
    // recorded as a run fact. The setup tab a fresh install opens is closed.
    const profile = await wallets.profile('cold-launch', 'newcomer', { observeNetwork: true });
    try {
      expect(profile.installTabOpened, 'a fresh install did not open its setup tab').toBe(true);
      expect(profile.extensionContacts(), 'installing contacted the network before the user acted').toEqual([]);

      const popup = profile.page;
      await popup.goto(profile.popupUrl());
      await expect(popup.getByTestId('onboarding-create-btn')).toBeVisible({ timeout: 30_000 });
      await expect(popup.getByTestId('onboarding-import-btn')).toBeVisible();
      // An observation window, not dead air: opening the popup is not consent.
      await popup.waitForTimeout(OBSERVE_MS);
      await footage.settled(popup, 'cold launch welcome');
      expect(profile.extensionContacts(), 'a cold launch must contact nothing before the user acts').toEqual([]);

      const tab = await openCreateTab(footage, profile);
      await expect(tab.getByTestId('onboarding-create-seed-word-0'), 'the tab must not mint a phrase on load').toHaveCount(0);
      await tab.waitForTimeout(OBSERVE_MS);
      await footage.result(tab, 'create handed to a tab');
      expect(profile.extensionContacts(), 'the hand-off contacted the network before the user asked for anything').toEqual([]);

      // The control: a request this test makes does reach the observer, so
      // "nothing contacted" above is an observation, not a blind spot.
      expect(await profile.proveObservation(tab), 'the observation proxy saw no traffic at all, so an empty result proves nothing').toBe(true);
      footage.fact('cold launch browser service hosts', profile.browserContacts().join(', ') || 'none');
    } finally {
      await profile.close();
    }
  });

  test('create a new wallet in the tab against production', async ({ wallets, footage }) => {
    requireProdWrites('Creating a wallet registers a new user row');
    test.setTimeout(60 * 60_000);
    const caps = await getCapabilities();
    if (caps.registration.payment_required || caps.registration.invite_required) {
      expectedSkip(`registration on this backend needs ${caps.registration.payment_required ? 'a payment' : 'an invite'}, so a plain create cannot finish`);
    }
    const profile = await wallets.profile('created', 'newcomer');
    const tab = await openCreateTab(footage, profile);
    const password = SecretValue.random();
    footage.canary.addSecret(password.reveal());
    const words: string[] = [];
    try {
      await footage.secret('Recovery phrase', async () => {
        await footage.tap(tab.getByTestId('onboarding-create-btn'), 'generate a recovery phrase');
        await expect(tab.getByTestId('onboarding-create-seed-word-0')).toBeVisible({ timeout: 30_000 });
        const count = await tab.locator('[data-testid^="onboarding-create-seed-word-"]').count();
        expect([12, 24], 'the phrase grid is not a 12 or 24 word phrase').toContain(count);
        for (let i = 0; i < count; i++) {
          words.push(((await tab.getByTestId(`onboarding-create-seed-word-${i}`).textContent()) ?? '').trim().toLowerCase());
        }
        expect(words.every((word) => /^[a-z]+$/.test(word)), 'a generated word is empty or malformed').toBe(true);
        footage.canary.addPhrase(words);
        // The copy control's status line is shown and says something. The copy
        // button itself is not pressed: the phrase must not reach a clipboard.
        const status = tab.getByTestId('onboarding-create-copy-seed-status');
        await expect(status).toBeVisible();
        expect(((await status.textContent()) ?? '').trim().length, 'the copy status line is empty').toBeGreaterThan(0);
        await footage.setChecked(tab.locator('input[type="checkbox"]').first(), true, 'confirm the phrase is written down');
        await footage.tap(tab.getByTestId('onboarding-create-backed-up-continue'), 'continue to verification');
        await expect(tab.getByTestId('onboarding-create-continue')).toBeVisible({ timeout: 30_000 });
        let answered = 0;
        for (let i = 0; i < words.length; i++) {
          const input = tab.getByTestId(`onboarding-verify-word-${i}`);
          if (await input.count()) {
            await footage.secretFill(input, words[i]!, 'verify word');
            answered += 1;
          }
        }
        expect(answered, 'the verify step asked for no words').toBeGreaterThan(0);
        await footage.tap(tab.getByTestId('onboarding-create-continue'), 'verify the phrase');
      });
    } finally {
      wipeWords(words);
    }

    const sawProofOfWork = caps.registration.pow_required ? watchForProofOfWork(tab) : null;
    await setPasswordAndSubmit(footage, tab, password);
    const outcome = await finishOnboarding(footage, tab);
    if (sawProofOfWork) {
      test.info().annotations.push({
        type: 'proof of work',
        description: (await sawProofOfWork) ? 'registration mined proof of work on screen' : 'pow_required, but the work finished before the screen was sampled',
      });
    }
    expect(outcome.welcomeBack, 'a brand-new phrase was greeted as a returning identity').toBe(false);
    expect(outcome.userId, 'registration produced no backend user id').toBeTruthy();
    if (outcome.isNew === null) declareUnproven('create: the bootstrap did not say whether the sign-in created the account');
    else expect(outcome.isNew, 'a brand-new phrase signed in to an account that already existed').toBe(true);
    // The new user row carries no label on the server. This run's facts record
    // its user id, and the handle scenario below gives it a public e2e_a_ handle.
    footage.fact('created wallet user id', outcome.userId!);
    await footage.result(tab, 'new wallet home');

    const npub = await readNpub(footage, tab);
    expect(npub).toMatch(/^npub1[02-9ac-hj-np-z]{58}$/);
    await footage.result(tab, 'new wallet npub');
    wallets.remember('created', { name: 'newcomer', profile, password, ...outcome });
  });

  test('fresh import of alice: returning-user bootstrap and real balances', async ({ wallets, footage }) => {
    test.setTimeout(60 * 60_000);
    const baseline = requireBaseline('alice');
    // The first request for alice in this worker imports her into a clean
    // profile, recorded: warning, words (carded), password (carded, masked).
    const alice = await wallets.reference('alice');
    const page = alice.profile.page;
    await expect(page.getByTestId('bootstrap-error')).toHaveCount(0);
    expectExistingAccount('alice', alice, baseline, 'this import');

    const balances = await expectHeldBalances(footage, 'alice', page, baseline);
    footage.fact('alice user id', alice.userId!);
    await footage.result(page, 'alice balances');
    if (!Object.values(balances).some(isPositive)) declareUnproven('alice: no positive balance on any chain, so no real balance was shown');
  });

  for (const name of DEMO) {
    test(`beta v0.3.0 import of ${name} keeps its account, npub, balances and history`, async ({ wallets, footage }) => {
      test.setTimeout(2 * 60 * 60_000);
      const baseline = requireBaseline(name);
      const reference = await wallets.reference(name);
      expectExistingAccount(name, reference, baseline, 'the first import');
      let referencePage = await openHome(footage, reference);
      const referenceNpub = await readNpub(footage, referencePage);
      referencePage = await openHome(footage, reference);
      const referenceBalances = await homeBalances(referencePage);

      // Import the same phrase into a second clean profile, as a v0.3.0 beta
      // user moving to v0.3.1 would. It must land on the account the seed had
      // before v0.3.1, with that account's balances, history and tips.
      const profile = await wallets.profile(`${name}-reimport`, name);
      try {
        const again = await wallets.importInto(profile, DEMO_WALLETS[name], name);
        expectExistingAccount(name, again, baseline, 'the re-import');
        expect(again.userId, 'the two imports resolved to different accounts').toBe(reference.userId);
        const page = again.profile.page;
        await expect.poll(async () => JSON.stringify(await homeBalances(page)), {
          timeout: 15 * 60_000,
          message: 'the re-imported balances never matched the first import',
        }).toBe(JSON.stringify(referenceBalances));
        await expectHeldBalances(footage, name, page, baseline);
        await footage.result(page, 're-imported balances');

        const npub = await readNpub(footage, page);
        expect(npub, 'the re-import shows a different npub').toBe(referenceNpub);
        footage.fact(`${name} npub`, npub);
        await footage.result(page, 're-imported npub');

        const freshPage = await openHome(footage, again);
        referencePage = await openHome(footage, reference);
        const withHistory = ASSETS.filter((asset) => referenceBalances[asset] || baseline.receipts[asset]?.length);
        for (const asset of withHistory) {
          const expected = await historyAmounts(footage, referencePage, asset);
          const receipts = baseline.receipts[asset] ?? [];
          expect(missingReceipts(expected, TICKERS[asset], receipts), `${name}'s first v0.3.1 import lost ${asset} receipts from before v0.3.1`).toEqual([]);
          await expect.poll(() => historyAmounts(footage, freshPage, asset), {
            timeout: 15 * 60_000,
            message: `${asset} history after re-import never matched the first import`,
          }).toEqual(expected);
        }
        if (!Object.values(baseline.receipts).some((list) => list?.length)) {
          declareUnproven(`${name}: no history before v0.3.1 in the baseline, so the re-import's history is compared only with the first import`);
        }

        if (baseline.sentTips.length) {
          const tips = await sentTipSummaries(footage, freshPage);
          for (const tip of baseline.sentTips) {
            const shape = new RegExp(`\\b${TICKERS[tip.asset]} → ${tip.recipient}\\b`);
            expect(
              tips.some((summary) => shape.test(summary.line) && summary.status.startsWith(tip.status)),
              `${name}'s ${tip.asset} tip to a ${tip.recipient} (${tip.status}) from before v0.3.1 is not on the re-imported account`,
            ).toBe(true);
          }
          await openHome(footage, again);
        } else {
          declareUnproven(`${name}: no sent tips before v0.3.1 in the baseline, so tip carry-over is not compared`);
        }
      } finally {
        await profile.close();
      }
    });
  }

  test('migrated pre-v0.3 import signs in to its existing account', async ({ wallets, footage }) => {
    const variable = process.env.E2E_LEGACY_WALLET_VAR ?? 'SMOKE_LEGACY_MNEMONIC';
    const status = custodyStatus(variable);
    if (!status.ok) expectedSkip(`no owner-supplied pre-v0.3 seed in custody (${variable}): ${status.reason}`);
    const caps = await getCapabilities();
    if ((caps.features as unknown as Record<string, unknown>).legacy_merge_v2 !== true) {
      expectedSkip('the backend does not advertise legacy_merge_v2, so a migrated wallet would not carry its identity over');
    }
    test.setTimeout(60 * 60_000);
    const profile = await wallets.profile('legacy', 'legacy');
    try {
      const legacy = await wallets.importInto(profile, variable, 'legacy');
      expect(legacy.userId, 'the migrated wallet resolved to no account').toBeTruthy();
      expect(legacy.welcomeBack, 'setup did not greet the migrated account, so its handle or socials did not carry over').toBe(true);
      if (legacy.isNew !== null) expect(legacy.isNew, 'the migrated wallet created a new account').toBe(false);
      if (process.env.E2E_LEGACY_USER_ID) {
        expect(legacy.userId, 'the migrated wallet signed in to a different account').toBe(process.env.E2E_LEGACY_USER_ID);
      } else {
        declareUnproven('migrated import: no E2E_LEGACY_USER_ID, so the account is identified by its greeting and handle, not by its id');
      }
      const page = legacy.profile.page;
      await settingsSection(footage, page, 'settings-nostr-nav', 'settings-nostr-screen', 'Nostr identity');
      const handle = page.getByTestId('nostr-handle');
      await expect(handle, 'the migrated account shows no handle').toBeVisible({ timeout: 30_000 });
      if (process.env.E2E_LEGACY_HANDLE) await expect(handle).toContainText(`${process.env.E2E_LEGACY_HANDLE}@`);
      else declareUnproven('migrated import: no E2E_LEGACY_HANDLE, so a handle is shown but not compared with the old one');
      await footage.result(page, 'handle carried over');

      if (process.env.E2E_LEGACY_EXPECT_TIPS === '1') {
        await tabRoot(footage, page, 'settings');
        await footage.tap(page.getByTestId('settings-sent-tips-nav'), 'Sent tips');
        await expect(page.locator('[data-testid^="sent-tip-card-"]').first(), 'the migrated account shows no sent tips').toBeVisible({ timeout: 60_000 });
        await footage.result(page, 'tips carried over');
      } else {
        declareUnproven('migrated import: tips carry-over not checked (set E2E_LEGACY_EXPECT_TIPS=1 when the old account sent tips)');
      }
      if (process.env.E2E_LEGACY_EXPECT_PREMIUM === '1') {
        await tabRoot(footage, page, 'feed');
        await waitForFeed(page);
        await expect(page.getByTestId('feed-needs-premium'), 'the migrated account lost its premium posting').toHaveCount(0);
        await footage.result(page, 'premium carried over');
      } else {
        declareUnproven('migrated import: premium carry-over not checked (set E2E_LEGACY_EXPECT_PREMIUM=1 when the old account had premium)');
      }
    } finally {
      await profile.close();
    }
  });

  test('lock every time, a one-hour session cache, and Lock now across windows', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    let page = await openHome(footage, alice);

    await tabRoot(footage, page, 'settings');
    await footage.choose(page.getByTestId('settings-autolock-select'), '0', 'auto-lock immediately');
    await expect(page.getByTestId('settings-autolock-select')).toHaveValue('0');
    await expect.poll(() => sessionExpiry(page), { message: 'lock every time left a session cache behind' }).toBeUndefined();
    await footage.settled(page, 'lock every time selected');

    await page.close();
    page = await alice.profile.openPage();
    await expect(page.getByTestId('lockscreen-root'), 'reopening under lock every time did not ask for the password').toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('bottom-nav')).toHaveCount(0);
    await expect(page.getByTestId('lockscreen-password-input')).toHaveAttribute('type', 'password');
    await footage.result(page, 'lock screen after reopening');
    await unlock(footage, alice, page);
    await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 60_000 });

    await tabRoot(footage, page, 'settings');
    await footage.choose(page.getByTestId('settings-autolock-select'), '60', 'auto-lock after one hour');
    await expect.poll(() => sessionExpiry(page), { timeout: 15_000 }).toBeGreaterThan(Date.now());
    const expiry = await sessionExpiry(page);
    await footage.settled(page, 'one hour selected');
    await page.close();
    page = await alice.profile.openPage();
    await expect(page.getByTestId('bottom-nav'), 'the one-hour session did not restore on reopen').toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('lockscreen-root')).toHaveCount(0);
    const root = page.locator('#root');
    await expect(root).not.toContainText("Couldn't sign in");
    await expect(root).not.toContainText('private key must be hex string or Uint8Array');
    await expect(root).not.toContainText('Receiving end does not exist');
    expect(await sessionExpiry(page), 'reopening must not extend the session').toBe(expiry);
    await footage.result(page, 'restored from the session cache');

    const other = await alice.profile.context.newPage();
    try {
      await other.goto(alice.profile.popupUrl());
      await expect(other.getByTestId('bottom-nav')).toBeVisible({ timeout: 60_000 });
      await footage.settled(other, 'second window open');
      await tabRoot(footage, page, 'settings');
      await footage.tap(page.getByTestId('settings-lock-now-btn'), 'lock now');
      await expect(page.getByTestId('lockscreen-root')).toBeVisible({ timeout: 30_000 });
      await expect(other.getByTestId('lockscreen-root'), 'Lock now left the second window unlocked').toBeVisible({ timeout: 30_000 });
      // Clearing the cache may trail the lock screen, so this waits for it.
      await expect.poll(() => sessionExpiry(page), { timeout: 15_000, message: 'Lock now left a session cache behind' }).toBeUndefined();
      await footage.result(other, 'second window revoked');
    } finally {
      await other.close();
    }

    await unlock(footage, alice, page);
    await tabRoot(footage, page, 'settings');
    await footage.choose(page.getByTestId('settings-autolock-select'), '0', 'auto-lock immediately');
    await footage.settled(page, 'lock every time restored');
  });

  test('settings tour: confirmation policies, backend, build stamp, connected sites and a carded phrase reveal', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    const page = await openHome(footage, alice);
    await tabRoot(footage, page, 'settings');

    const policies = [
      ['require-password-sends', 'password for every send'],
      ['require-password-signing', 'password for signing'],
    ] as const;
    for (const [id, label] of policies) {
      const box = page.getByTestId(id);
      await expect(box).toBeEnabled({ timeout: 15_000 });
      const initial = await box.isChecked();
      for (const target of [!initial, initial]) {
        await footage.tap(box, `${target ? 'require' : 'stop requiring'} ${label}`);
        expect(await confirmPasswordIfAsked(footage, alice, page, { patience: 30_000 }), 'changing a confirmation policy did not ask for the password').toBe(true);
        if (target) await expect(box).toBeChecked();
        else await expect(box).not.toBeChecked();
        await footage.result(page, target ? 'policy on' : 'policy off');
      }
    }

    await settingsSection(footage, page, 'settings-backend-nav', 'settings-backend-screen', 'Backend screen');
    await expect(page.getByTestId('backend-current')).toContainText(new URL(BACKEND_URL).host);
    await footage.result(page, 'backend in use');

    await tabRoot(footage, page, 'settings');
    const stamp = page.getByTestId('settings-build-identity');
    await stamp.scrollIntoViewIfNeeded();
    await expect(stamp).toContainText(`v${RELEASE_CANDIDATE.version}`);
    const stampText = ((await stamp.textContent()) ?? '').trim();
    const built = stampText.match(/\(([0-9a-f]{7,40})(-dirty)?[,)]/);
    expect(built, 'the build stamp names no commit').not.toBeNull();
    const commit = built![1]!;
    expect(
      RELEASE_CANDIDATE.commits.some((known) => commit.startsWith(known) || known.startsWith(commit)),
      'the build stamp names neither the release commit nor its Builds wrapper',
    ).toBe(true);
    const dirty = Boolean(built![2]);
    footage.fact('build stamp', stampText);
    footage.fact('build stamp dirty', dirty);
    if (dirty) {
      // The release candidate was built from a tree with uncommitted changes,
      // so its commit alone does not say what is in it. That is the owner's
      // call: it fails here unless accepted on purpose, and is listed either way.
      const accepted = process.env.E2E_ACCEPT_DIRTY_BUILD === '1';
      declareUnproven(`build stamp ends in -dirty: the release candidate was built from a modified tree${accepted ? ' (accepted by E2E_ACCEPT_DIRTY_BUILD=1)' : ''}`);
      if (!accepted) {
        expect.soft(dirty, 'the release candidate was built from a modified tree; review the Builds run, then set E2E_ACCEPT_DIRTY_BUILD=1 to accept it').toBe(false);
      }
    }
    await footage.result(page, 'build stamp');

    const sites = page.getByTestId('settings-connected-sites');
    await sites.scrollIntoViewIfNeeded();
    await expect(sites).not.toContainText('Loading…', { timeout: 15_000 });
    await expect(sites).toContainText(/No sites are connected|Revoke|smirk|http/i);
    await footage.result(page, 'connected sites');

    const field = page.getByTestId('settings-reveal-password');
    await field.scrollIntoViewIfNeeded();
    await expect(field).toHaveAttribute('type', 'password');
    await footage.settled(page, 'recovery phrase section');
    const since = Date.now();
    let wordCount = 0;
    await footage.secret('Recovery phrase reveal', async () => {
      await footage.secretFill(field, alice.password.reveal(), 'reveal password');
      await footage.tap(page.getByTestId('settings-reveal-btn'), 'reveal the recovery phrase');
      const phrase = page.getByTestId('settings-revealed-phrase');
      await expect(phrase).toBeVisible({ timeout: 30_000 });
      // Counted inside the page: the words never cross into this process.
      wordCount = await phrase.evaluate((element) => (element.textContent ?? '').trim().split(/\s+/).filter(Boolean).length);
      await footage.tap(page.getByRole('button', { name: 'Hide', exact: true }).first(), 'hide the phrase');
      await expect(phrase).toHaveCount(0);
    });
    expect([12, 24], 'the revealed phrase is not 12 or 24 words').toContain(wordCount);
    if (footage.recording) {
      expect(footage.cardsSince(since), 'the phrase reveal was not carded in the recording').toContain('Recovery phrase reveal hidden');
    }
    await footage.settled(page, 'phrase hidden again');
  });

  test('identity hub: npub, copy npub, handle state, and a burner added, switched and removed', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    const page = await openHome(footage, alice);
    const npub = await readNpub(footage, page);
    await footage.result(page, 'alice npub');

    const rows = page.locator('[data-testid^="nostr-identity-"]');
    const seedRow = rows.filter({ hasText: /\bseed\b/ }).first();
    const seedHex = ((await seedRow.getAttribute('data-testid')) ?? '').replace('nostr-identity-', '');
    expect(seedHex, 'no seed-derived identity row').toMatch(/^[0-9a-f]{64}$/);

    // What the control hands to the clipboard is recorded in the page as it
    // happens; the system clipboard itself is never read.
    await recordClipboardWrites(page);
    await footage.tap(page.getByTestId(`nostr-copy-npub-${seedHex}`), 'copy the npub');
    await expect.poll(() => copiedExactly(page, npub), {
      timeout: 15_000,
      message: 'copy npub did not successfully copy exactly the npub shown',
    }).toBe(true);
    await footage.settled(page, 'npub copied');

    const present = page.getByTestId('nostr-handle');
    const absent = page.getByTestId('nostr-handle-absent');
    await expect(present.or(absent).first(), 'the identity screen shows neither a handle nor its absence').toBeVisible({ timeout: 30_000 });
    if (await present.isVisible()) await expect(present).toContainText('@');
    else await expect(page.getByTestId('nostr-claim-handle-input'), 'no handle and no way to claim one').toBeVisible();
    await footage.result(page, 'handle state');

    const rowIds = async () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid') ?? ''));
    const before = await rowIds();
    page.once('dialog', (dialog) => void dialog.accept());
    await footage.tap(page.getByTestId('nostr-add-burner'), 'add a burner identity');
    await expect(rows).toHaveCount(before.length + 1, { timeout: 30_000 });
    const added = (await rowIds()).filter((id) => !before.includes(id));
    expect(added, 'adding a burner did not add exactly one identity').toHaveLength(1);
    const burnerHex = added[0]!.replace('nostr-identity-', '');
    expect(burnerHex).toMatch(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId(`nostr-identity-${burnerHex}`)).toContainText(/\bburner\b/);
    await footage.result(page, 'burner added');

    const active = page.getByTestId('nostr-npub');
    await footage.tap(page.getByTestId(`nostr-switch-${burnerHex}`), 'switch to the burner');
    await expect.poll(async () => ((await active.textContent()) ?? '').trim(), { timeout: 15_000 }).not.toBe(npub);
    await footage.result(page, 'burner active');
    await footage.tap(page.getByTestId(`nostr-switch-${seedHex}`), 'switch back to the seed identity');
    await expect.poll(async () => ((await active.textContent()) ?? '').trim(), { timeout: 15_000 }).toBe(npub);
    await footage.settled(page, 'seed identity active');

    page.once('dialog', (dialog) => void dialog.accept());
    await footage.tap(page.getByTestId(`nostr-remove-${burnerHex}`), 'remove the burner');
    await expect(rows).toHaveCount(before.length, { timeout: 30_000 });
    await expect(page.getByTestId(`nostr-identity-${burnerHex}`)).toHaveCount(0);
    await footage.result(page, 'burner removed');
    await openHome(footage, alice);
  });

  test('claim a handle on the new wallet, link it and publish the profile', async ({ wallets, footage }) => {
    requireProdWrites('Claiming a handle and publishing a profile');
    const created = wallets.recall('created');
    if (!created) expectedSkip('the create scenario left no new wallet in this worker (it failed or was skipped)');
    const page = await openHome(footage, created);
    await settingsSection(footage, page, 'settings-nostr-nav', 'settings-nostr-screen', 'Nostr identity');
    await expect(page.getByTestId('nostr-handle-absent'), 'a brand-new wallet already has a handle').toBeVisible({ timeout: 30_000 });

    const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const handle = `e2e_a_${stamp}_${randomBytes(2).toString('hex')}`;
    await footage.type(page.getByTestId('nostr-claim-handle-input'), handle, 'type a test handle');
    await footage.tap(page.getByTestId('nostr-claim-handle-btn'), 'claim the handle');
    const shown = page.getByTestId('nostr-handle');
    const refused = page.getByTestId('nostr-claim-handle-error');
    // Whichever comes first: the password prompt, or the claim's own outcome.
    await confirmPasswordIfAsked(footage, created, page, { outcome: shown.or(refused) });
    await expect(shown.or(refused).first()).toBeVisible({ timeout: 60_000 });
    if (await refused.isVisible()) throw new Error(`the handle claim was refused: ${(await refused.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
    await expect(shown).toContainText(`${handle}@`);
    footage.fact('created wallet handle', handle);
    await footage.result(page, 'handle claimed');

    const link = page.getByTestId('nostr-link-btn');
    const linked = page.getByTestId('nostr-linked-badge');
    if (await link.isVisible()) {
      await footage.tap(link, 'link the identity');
      await confirmPasswordIfAsked(footage, created, page, { outcome: linked });
    }
    await expect(linked, 'the identity never reached the linked state').toBeVisible({ timeout: 60_000 });
    await footage.result(page, 'identity linked');

    const result = page.getByTestId('nostr-publish-result');
    await footage.tap(page.getByTestId('nostr-publish-profile'), 'publish the profile');
    await confirmPasswordIfAsked(footage, created, page, { outcome: result });
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result, 'publishing a claimed, linked handle did not succeed').toContainText(`Published ${handle}@`);
    await footage.result(page, 'profile published');
  });

  test('warm resume: the identity link control asks for the password', async ({ wallets, footage }) => {
    const alice = await wallets.reference('alice');
    let page = await openHome(footage, alice);
    await tabRoot(footage, page, 'settings');
    await footage.choose(page.getByTestId('settings-autolock-select'), '60', 'auto-lock after one hour');
    await expect.poll(() => sessionExpiry(page), { timeout: 15_000 }).toBeGreaterThan(Date.now());
    await footage.settled(page, 'one hour selected');

    await page.close();
    page = await alice.profile.openPage();
    await expect(page.getByTestId('bottom-nav'), 'not a warm resume: the wallet came back locked').toBeVisible({ timeout: 60_000 });
    await settingsSection(footage, page, 'settings-nostr-nav', 'settings-nostr-screen', 'Nostr identity');
    await expect(
      page.getByTestId('nostr-unlock-input').or(page.getByTestId('nostr-unlock-manage')).first(),
      'no warm-resume affordance, so the seed may still be in memory',
    ).toBeVisible({ timeout: 30_000 });
    const manage = page.getByTestId('nostr-unlock-manage');
    if (await manage.isVisible()) await footage.tap(manage, 'open the password field');
    await expect(page.getByTestId('nostr-unlock-input')).toHaveAttribute('type', 'password');
    await footage.settled(page, 'warm resume identity');

    const link = page.getByTestId('nostr-link-btn');
    const target = (await link.isVisible()) ? link : page.getByTestId('nostr-publish-profile');
    await expect(target, 'disabled on a warm resume, which reads as broken').toBeEnabled();
    await footage.tap(target, 'press the identity control');
    const prompt = page.getByTestId('nostr-unlock-prompt');
    await expect(prompt, 'the control said nothing on a warm resume').toBeVisible({ timeout: 20_000 });
    expect(((await prompt.textContent()) ?? '').toLowerCase()).toContain('password');
    await footage.result(page, 'control asks for the password');

    await tabRoot(footage, page, 'settings');
    await footage.choose(page.getByTestId('settings-autolock-select'), '0', 'auto-lock immediately');
    await expect.poll(() => sessionExpiry(page)).toBeUndefined();
    await footage.settled(page, 'lock every time restored');
  });

  for (const name of DEMO) {
    test(`GRIN key registered for ${name}`, async ({ wallets, footage }) => {
      const caps = await getCapabilities();
      if (!caps.chains.grin?.enabled) expectedSkip('grin is disabled on this backend (/capabilities chains.grin)');
      const wallet = await wallets.reference(name);
      expect(wallet.userId, `${name} has no backend user id`).toBeTruthy();
      const page = await openHome(footage, wallet);
      // The backend is what smirk.cash GRIN sign-in consults, so this asks it.
      // Registration is deferred behind unlock and wasm, hence the poll.
      await expect.poll(async () => {
        const res = await fetch(`${BACKEND_URL}/users/${wallet.userId}/keys/grin`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!res?.ok) return false;
        return Boolean(await res.json().catch(() => null));
      }, {
        timeout: 3 * 60_000,
        message: `no GRIN key registered for ${name}: GRIN sign-in on smirk.cash would answer "User not found"`,
      }).toBe(true);
      await footage.tap(page.getByTestId('asset-row-grin'), 'open GRIN');
      await expect(page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 30_000 });
      await footage.result(page, 'GRIN registered');
      await footage.tap(page.getByTestId('asset-detail-back'), 'back to Home');
      await expect(page.getByTestId('home-total-balance')).toBeVisible({ timeout: 30_000 });
      await footage.settled(page, 'back on Home');
    });
  }
}

/** The wallet's facts from before v0.3.1, or a declared skip that the lane reports. */
function requireBaseline(name: string): WalletBaseline {
  const baseline = baselineFor(name);
  if (!baseline) {
    expectedSkip(`no baseline for ${name}: without the user id it had before v0.3.1, two v0.3.1 imports could agree on a newly minted account`);
  }
  return baseline;
}

/**
 * The import signed in to the account the seed had before v0.3.1: the same user
 * id, not a new account, and a scan start no later than its first receipt.
 */
function expectExistingAccount(name: string, wallet: LiveWallet, baseline: WalletBaseline, which: string): void {
  expect(wallet.userId, `${which} of ${name} resolved to no backend account`).toBeTruthy();
  expect(wallet.userId, `${which} of ${name} signed in to a different account than the one registered before v0.3.1`).toBe(baseline.userId);
  if (wallet.isNew === null) {
    declareUnproven(`${which} of ${name}: the bootstrap did not say whether it created the account (the user id still ties it to the old one)`);
  } else {
    expect(wallet.isNew, `${which} of ${name} created a new account for a seed registered before v0.3.1`).toBe(false);
  }
  for (const chain of ['xmr', 'wow'] as const) {
    const first = baseline.firstReceiptHeight[chain];
    if (first === undefined) continue;
    const start = wallet.startHeights[chain];
    if (start === undefined) {
      declareUnproven(`${which} of ${name}: the backend echoed no ${chain} scan start, so only the history shows the old receipts are scanned`);
    } else {
      expect(start, `${which} of ${name} scans ${chain} from after its first receipt, so that history is lost`).toBeLessThanOrEqual(first);
    }
  }
}

/**
 * Home balances, once every asset the wallet held before v0.3.1 shows a
 * positive amount. Each balance is recorded beside its baseline amount.
 */
async function expectHeldBalances(
  footage: GuardedFootage,
  name: string,
  page: Page,
  baseline: WalletBaseline,
): Promise<Record<AssetId, string>> {
  let balances = await homeBalances(page);
  if (baseline.holds.length) {
    await expect.poll(async () => {
      balances = await homeBalances(page);
      return baseline.holds.filter((asset) => !isPositive(balances[asset]));
    }, {
      timeout: 15 * 60_000,
      message: `${name} shows no balance on a chain it held before v0.3.1`,
    }).toEqual([]);
  } else {
    declareUnproven(`${name}: held nothing at the ${loadBaseline().asOf} baseline, so no balance is compared with it`);
  }
  for (const asset of ASSETS) {
    if (balances[asset]) footage.fact(`${name} ${asset} balance`, balances[asset]);
    const before = baseline.balancesAtBaseline[asset];
    if (before) footage.fact(`${name} ${asset} balance at baseline`, before);
  }
  return balances;
}

/** The feed tab resolves to its composer or its premium gate. */
async function waitForFeed(page: Page): Promise<void> {
  await expect(page.getByTestId('feed-needs-premium').or(page.getByRole('button', { name: /^Post/ })).first())
    .toBeVisible({ timeout: 60_000 });
}
