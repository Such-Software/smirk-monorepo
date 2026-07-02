import { test, expect } from '../fixtures/extension.js';
import { getCapabilities } from '../fixtures/capabilities.js';

/**
 * create-new-wallet — the full GENERATE → VERIFY → REGISTER path for a brand-new
 * wallet, driving the real MV3 extension against the local smirk-backend-core.
 *
 * Unlike the import specs (which replay an already-registered smoke seed), this
 * exercises the create branch end-to-end: the wizard GENERATES a fresh BIP-39
 * mnemonic, we READ it back out of the reveal screen's DOM, answer the wizard's
 * own re-type VERIFY challenge with those words, set a password, and let the
 * offscreen bootstrap-auth REGISTER the never-seen pubkey against /auth/extension.
 *
 * ONLY runs when the backend's /capabilities reports payment_required === false:
 * a genuinely new pubkey has no settled invoice, so the pay-to-register gate
 * (enforce_payment) would reject /auth/extension and the wizard would never
 * reach Home. We self-skip on that config rather than red/green on it.
 *
 * HOW THE VERIFY CHALLENGE WORKS (this is what the spec has to satisfy):
 *   After the reveal screen, VerifyMnemonic asks the user to RE-TYPE N words
 *   (N = verifyCount, default 3) from the phrase, at RANDOM distinct indices
 *   chosen by pickRandomIndices. Each challenge input renders
 *   data-testid="onboarding-verify-word-<i>" where <i> is the ZERO-BASED index
 *   of the word it wants (the same index used by onboarding-create-seed-word-<i>
 *   on the reveal screen). The input is compared case-insensitively to
 *   words[i]. Since the challenged indices are random, the spec probes ALL 12
 *   possible verify inputs and, for each one that is actually present, fills it
 *   with the word it read at that same index. That answers the challenge no
 *   matter which indices the wizard picked.
 *
 * CRITICAL — do NOT waitForResponse('/auth/extension'): that POST fires from the
 * extension's OFFSCREEN document, whose network is invisible to Playwright's
 * page/context listeners, so any such wait ALWAYS times out. A fresh wallet also
 * has ZERO balance, so there is no balance number to assert on. We assert on the
 * PRESENCE of the Home surface instead: the bottom-nav renders and the onboarding
 * create entry button is gone.
 */

test('create a fresh wallet → verify generated phrase → register → Home renders', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  // A fresh, never-seen pubkey must be able to register unauthenticated for this
  // path to reach Home. Any registration gate that blocks a plain create makes
  // the scenario N/A — skip rather than fail. (pow_required is restore-depth PoW,
  // which a default-birthday create does not trigger, so it is not a blocker.)
  const { payment_required, invite_required } = caps.registration;
  test.skip(
    payment_required || invite_required,
    `create-new-wallet needs an open registration path — blocked by ${
      payment_required ? 'payment_required' : 'invite_required'
    } on this backend`,
  );

  const PASSWORD = 'e2e-test-password-123';

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // welcome → create
  await page.getByTestId('onboarding-create-btn').click();

  // ── Reveal screen: read the freshly generated mnemonic out of the DOM ──────
  // Smirk generates 12-word phrases; each word is exposed at a stable
  // per-index testid so the verify step can be answered deterministically.
  await expect(page.getByTestId('onboarding-create-seed-word-0')).toBeVisible({
    timeout: 15_000,
  });
  const WORD_COUNT = 12;
  const words: string[] = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    const raw = await page.getByTestId(`onboarding-create-seed-word-${i}`).innerText();
    words.push(raw.trim().toLowerCase());
  }
  expect(words.filter(Boolean)).toHaveLength(WORD_COUNT);

  // Acknowledge the backup checkbox, then continue to the verify challenge.
  // The checkbox has no testid (plain label); it's the only checkbox on this
  // step, so target it directly to enable the Continue button.
  await page.locator('input[type="checkbox"]').first().check();
  await page.getByTestId('onboarding-create-backed-up-continue').click();

  // ── Verify step: answer whichever random word indices the wizard asks for ──
  // The challenged indices are random, so probe every possible verify input and
  // fill each present one with the word we read at that same index.
  await expect(page.getByTestId('onboarding-create-continue')).toBeVisible({
    timeout: 15_000,
  });
  let answered = 0;
  for (let i = 0; i < WORD_COUNT; i++) {
    const input = page.getByTestId(`onboarding-verify-word-${i}`);
    if ((await input.count()) > 0) {
      await input.fill(words[i]);
      answered++;
    }
  }
  // Sanity: the wizard should have asked for at least one word (default is 3).
  expect(answered, 'verify step presented at least one word challenge').toBeGreaterThan(0);
  await page.getByTestId('onboarding-create-continue').click();

  // ── Password step (shared testids with the import flow) ────────────────────
  await page.getByTestId('onboarding-password-input').fill(PASSWORD);
  await page.getByTestId('onboarding-password-confirm-input').fill(PASSWORD);
  // Submitting runs onComplete → the offscreen bootstrap-auth registers the new
  // pubkey against /auth/extension. Then either the optional Smirk-setup step or
  // Home. (That POST is invisible to Playwright — we assert on the UI outcome.)
  await page.getByTestId('onboarding-set-password-submit').click();

  // optional Smirk-setup step → finish (absent when the shell wires no setup step)
  await page
    .getByTestId('onboarding-setup-finish-btn')
    .click({ timeout: 30_000 })
    .catch(() => {
      /* hasSetupStep === false → skipped straight to Home */
    });

  // ── Home is up. A FRESH wallet has ZERO balance, so assert on the PRESENCE ──
  // of the Home surface, not a balance number: the bottom nav renders and the
  // onboarding create entry is gone (the wizard unmounted).
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('onboarding-create-btn')).toHaveCount(0);
});
