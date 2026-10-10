/**
 * Live lane skip guard. A skip is not a pass: a live test may skip only for a
 * reason it declared in advance with `expectedSkip(...)` (fixtures/live-wallets.ts),
 * which records an `expected-skip` annotation. Any other skip, or a run where
 * nothing executed, fails. Declared reasons are static strings and are printed
 * so the owner sees what the run did not prove.
 *
 * A test that runs but cannot check one of its claims says so with
 * `declareUnproven(...)` (an `unproven` annotation); an older `unverified`
 * annotation means the same. Those lines are printed beside the declared skips,
 * whatever the test's status, so an unchecked claim never reads as a pass.
 *
 * Kept in an area-prefixed file so the per-area branches merge cleanly; it is
 * the lane's shared reporter, not area A's alone.
 */
import { basename } from 'node:path';
import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

type Annotation = { type: string; description?: string };

/** Errors written to carry no secret, tagged so they can be shown despite the private reporter. */
const SHOWN_ERROR = /\[(live preflight|guarded footage)\] .*/;
const UNPROVEN = new Set(['unproven', 'unverified']);

function annotationsOf(test: TestCase, result: TestResult): Annotation[] {
  const fromResult = (result as TestResult & { annotations?: Annotation[] }).annotations ?? [];
  return [...fromResult, ...(test.annotations as Annotation[])];
}

function declaredReason(test: TestCase, result: TestResult): string | null {
  const found = annotationsOf(test, result).find((annotation) => annotation.type === 'expected-skip');
  return found?.description?.trim() || null;
}

export default class LiveSkipGuardReporter implements Reporter {
  private executed = 0;
  private readonly declared: string[] = [];
  private readonly undeclared: string[] = [];
  private readonly unproven: string[] = [];

  printsToStdio(): boolean { return true; }

  /** Preflight refusals and footage policy failures carry no secret, so their cause is shown. */
  onError(error: TestError): void {
    const first = (error.message ?? '').split('\n')[0] ?? '';
    const shown = first.match(SHOWN_ERROR);
    if (shown) console.error(shown[0]);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const where = `${basename(test.location.file)}:${test.location.line}`;
    const claims = new Set(annotationsOf(test, result)
      .filter((annotation) => UNPROVEN.has(annotation.type) && annotation.description?.trim())
      .map((annotation) => annotation.description!.trim()));
    for (const claim of claims) this.unproven.push(`${where} ${test.title} [${result.status}]: ${claim}`);
    if (result.status !== 'skipped') {
      this.executed += 1;
      return;
    }
    const reason = declaredReason(test, result);
    if (reason) this.declared.push(`${where} ${test.title}: ${reason}`);
    else this.undeclared.push(`${where} ${test.title}`);
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | void> {
    if (this.declared.length) {
      console.log(`[live skip guard] ${this.declared.length} declared skip(s), not proven by this run:\n${this.declared.map((line) => `  - ${line}`).join('\n')}`);
    }
    if (this.unproven.length) {
      console.log(`[live skip guard] ${this.unproven.length} claim(s) a test ran without checking, not proven by this run:\n${this.unproven.map((line) => `  - ${line}`).join('\n')}`);
    }
    const problems: string[] = [];
    if (this.undeclared.length) {
      problems.push(`${this.undeclared.length} test(s) skipped without a declared reason:\n${this.undeclared.map((line) => `  - ${line}`).join('\n')}`);
    }
    if (this.executed === 0) problems.push('no live test executed, so this run proves nothing');
    if (!problems.length) return;
    console.error(`[live skip guard] failing the run:\n${problems.join('\n')}`);
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}
