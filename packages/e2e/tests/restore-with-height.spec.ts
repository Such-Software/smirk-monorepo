import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * restore-with-height: how the wallet surfaces the operator's RESTORE POLICY.
 *
 * Whether an early restore/birthday height is allowed is an OPERATOR policy the
 * backend advertises at `GET /capabilities` (`restore.policy`) and enforces at
 * the scan-registration seam (`POST /wallet/lws/register`): a `create-only`
 * instance refuses a deeper restore, while `bounded`/`unlimited` accept one.
 * See:
 *   - backend  smirk-backend-core/src/config.rs        RestoreConfig::enforce
 *   - backend  smirk-backend-core/src/api/wallet/xmr_wow.rs::register
 *   - core     packages/core/src/api/capabilities.ts   earliestRestoreDate()
 *
 * The local backend under test is `create-only`. Per the GOAL, that policy is
 * satisfiable two ways; this spec asserts the way the product actually surfaces
 * it today:
 *
 *   (A) `GET /capabilities` reports `restore.policy === "create-only"` (asserted
 *       via `page.request.get`, which originates from the POPUP page and IS
 *       capturable, unlike the offscreen bootstrap-auth traffic), AND
 *   (B) the import onboarding wizard offers NO restore-height / birthday PICKER
 *       (the field is absent). As of v0.3.0 there is deliberately no per-shell
 *       restore-date picker: the import flow always stamps the birthday to
 *       "now" (create), which is exactly what create-only wants. Asserting the
 *       absence of that control is the client-side expression of create-only.
 *
 * WHY NOT wait on bootstrap-auth: the extension's `POST /auth/extension` fires
 * from the OFFSCREEN document, which is invisible to Playwright's
 * page/context response listeners and `waitForResponse`; any such wait ALWAYS
 * times out. Auth setup therefore goes through `importAndUnlock`, which detects
 * a valid token via a REAL backend balance rendering on Home (alice's WOW), not
 * by sniffing the offscreen request.
 *
 * Source the seeds first:
 *   set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 */

interface Capabilities {
  restore?: { policy?: string; max_depth_days?: number | null };
}

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:8080/api/v1';

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

/**
 * This spec asserts the CLIENT expression of a `create-only` operator policy,
 * so it is only meaningful against a create-only backend. Run it against a
 * `bounded` instance (api.smirk.cash advertises bounded with a 365 day window)
 * and it fails on the policy assertion while proving nothing: the wallet is
 * behaving correctly for the policy it was actually handed.
 *
 * Skip instead, the way every other backend-shaped spec here does with
 * `/capabilities`. A failure should mean the wallet disagrees with its backend,
 * not that the backend is configured differently from the author's laptop.
 */
const capsPolicy = await fetch(`${BACKEND}/capabilities`)
  .then((r) => (r.ok ? (r.json() as Promise<Capabilities>) : null))
  .then((c) => c?.restore?.policy ?? null)
  .catch(() => null);
test.skip(
  capsPolicy !== 'create-only',
  `backend restore.policy is ${capsPolicy ?? 'unreadable'}, not create-only; ` +
    'this spec asserts create-only client behaviour',
);

test('create-only backend: /capabilities reports create-only and onboarding offers no restore-height picker', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();

  // ── 1. Assert the import wizard offers NO restore-height / birthday field ──
  // Do this on the FIRST import step (the mnemonic entry screen) before we
  // complete onboarding, so we observe the actual restore surface a user sees.
  // A create-only instance greys/hides the control entirely: the seed-word
  // grid, password, and continue affordances are the ONLY inputs; there is no
  // restore-date picker testid anywhere in the shell (verified in source).
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();
  await expect(page.getByTestId('onboarding-import-word-0')).toBeVisible({ timeout: 15_000 });

  // No restore-height / birthday / restore-date control is presented.
  for (const missing of [
    'onboarding-restore-height',
    'onboarding-restore-date',
    'onboarding-restore-height-input',
    'restore-height-input',
    'restore-date-input',
    'onboarding-birthday-input',
  ]) {
    await expect(
      page.getByTestId(missing),
      `create-only onboarding must not offer a restore-height picker (${missing})`,
    ).toHaveCount(0);
  }
  // Belt-and-braces: no visible "restore height"/"restore date"/"birthday"
  // labelled field on the import step either.
  await expect(
    page.getByText(/restore height|restore date|wallet birthday|scan from height/i),
  ).toHaveCount(0);

  // ── 2. Complete onboarding via the helper (offscreen-safe auth setup) ─────
  // importAndUnlock drives the same wizard to completion and returns only once
  // a REAL backend balance renders on Home (auth proven without touching the
  // offscreen bootstrap-auth request). alice's WOW balance 19.79 is the marker.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // ── 3. Assert the advertised restore policy is create-only ────────────────
  // page.request.get runs from the popup page's network stack → capturable and
  // deterministic (NOT the invisible offscreen path).
  const capsResp = await page.request.get(`${BACKEND}/capabilities`);
  expect(capsResp.ok(), 'GET /capabilities succeeds').toBeTruthy();
  const caps = (await capsResp.json()) as Capabilities;
  const policy = caps.restore?.policy;
  console.log('RESTORE_POLICY', policy, 'max_depth_days=', caps.restore?.max_depth_days);

  expect(policy, 'this instance is configured create-only').toBe('create-only');
  // create-only advertises no bounded depth window.
  expect(
    caps.restore?.max_depth_days ?? null,
    'create-only carries no bounded max_depth_days',
  ).toBeNull();
});
