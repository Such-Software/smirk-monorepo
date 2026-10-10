/**
 * Live lane skip guard. A skip is not a pass: a live test may skip only for a
 * reason it declared in advance with `expectedSkip(...)` (fixtures/live-wallets.ts),
 * which records an `expected-skip` annotation. Any other skip, or a run where
 * nothing executed, fails. Declared reasons are static strings and are printed
 * so the owner sees what the run did not prove.
 *
 * Kept in an area-prefixed file so the per-area branches merge cleanly; it is
 * the lane's shared reporter, not area A's alone.
 */
import { basename } from 'node:path';
import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

type Annotation = { type: string; description?: string };

function declaredReason(test: TestCase, result: TestResult): string | null {
  const fromResult = (result as TestResult & { annotations?: Annotation[] }).annotations ?? [];
  const found = [...fromResult, ...(test.annotations as Annotation[])].find((annotation) => annotation.type === 'expected-skip');
  return found?.description?.trim() || null;
}

export default class LiveSkipGuardReporter implements Reporter {
  private executed = 0;
  private readonly declared: string[] = [];
  private readonly undeclared: string[] = [];

  printsToStdio(): boolean { return true; }

  /** Preflight refusals are written to carry no secret, so their cause is shown. */
  onError(error: TestError): void {
    const first = (error.message ?? '').split('\n')[0] ?? '';
    if (first.startsWith('[live preflight] ')) console.error(first);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const where = `${basename(test.location.file)}:${test.location.line}`;
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
