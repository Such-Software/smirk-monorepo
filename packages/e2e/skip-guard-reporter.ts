/**
 * Skip guard: a skip is not a pass.
 *
 * A bare `npx playwright test` with no smoke mnemonics reports
 * "2 passed, 23 skipped" and EXITS 0. Eighteen of those skips are one line:
 * `test.skip(!MNEMONIC, ...)`. So the suite can silently decline to test 92% of
 * itself and still look green. A release shipped on the back of exactly that.
 *
 * A green badge that means "we didn't check" is worse than no badge, because it
 * manufactures confidence. This reporter fails the run when specs skip for a
 * reason that is not explicitly expected, and when overall coverage collapses.
 *
 * Legitimately-conditional specs go in EXPECTED_SKIPS with a reason. Adding an
 * entry is a deliberate, reviewable decision, not a default.
 */

import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

/**
 * Specs allowed to skip, and why. Keyed by a substring of the test file path.
 * These are environment-conditional by design, not by neglect.
 */
const EXPECTED_SKIPS: { match: string; reason: string }[] = [
  {
    match: 'feed.spec',
    reason: 'requires a backend advertising the Nostr feed capability',
  },
  {
    match: 'pay-to-register.spec',
    reason: 'requires a payment-gated backend (registration.payment_required)',
  },
  {
    match: 'nostr-identity.spec',
    reason: 'requires FEATURE_NOSTR_IDENTITY=true on the backend under test',
  },
];

/**
 * NOTE ON COVERAGE: these three skip on backend CONFIG, not on code health, so
 * how much this suite actually proves depends on the backend it runs against.
 * A dev backend with `FEATURE_NOSTR_IDENTITY`, `FEATURE_FEED` and payment
 * gating disabled quietly tests less than one with them on. CI tier B should
 * run against a maximal-feature backend so these three execute rather than
 * being permanently excused, and this list should shrink as that lands.
 */

/**
 * Floor on how many tests must actually RUN. Catches the catastrophic case
 * where the whole suite opts out (bad env, missing secrets) and still exits 0.
 * Deliberately not the full count, so adding a conditional spec is not a
 * tripwire, but high enough that a broken environment cannot slip through.
 */
const MIN_EXECUTED = Number(process.env.E2E_MIN_EXECUTED ?? 18);

export default class SkipGuardReporter implements Reporter {
  private skipped: { title: string; file: string }[] = [];
  private executed = 0;

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') {
      this.skipped.push({ title: test.title, file: test.location.file });
    } else {
      this.executed += 1;
    }
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | void> {
    const unexpected = this.skipped.filter(
      (s) => !EXPECTED_SKIPS.some((e) => s.file.includes(e.match)),
    );

    const problems: string[] = [];

    if (unexpected.length) {
      problems.push(
        `${unexpected.length} spec(s) skipped without an expected reason:\n` +
          unexpected.map((s) => `    - ${s.title}`).join('\n') +
          `\n  A skip is not a pass. Either fix the environment (see\n` +
          `  docs/private/E2E_ENV.md, usually missing smoke mnemonics or an\n` +
          `  unreachable node) or add the spec to EXPECTED_SKIPS with a reason.`,
      );
    }

    if (this.executed < MIN_EXECUTED) {
      problems.push(
        `only ${this.executed} test(s) actually ran, expected at least ${MIN_EXECUTED}.\n` +
          `  The suite opted out of most of itself, which usually means the\n` +
          `  environment is not set up rather than that the code is healthy.`,
      );
    }

    if (!problems.length) return;

    console.error(
      `\n[skip-guard] FAILING the run:\n\n` +
        problems.map((p) => `  ${p}`).join('\n\n') +
        `\n`,
    );
    // Override an otherwise-green run. This is the whole point of the reporter.
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}
