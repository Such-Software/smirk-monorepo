import { basename } from 'node:path';
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

/** Do not serialize browser stdout, error values, steps, attachments or HTML. */
export default class PrivateReporter implements Reporter {
  printsToStdio(): boolean { return true; }

  onTestEnd(test: TestCase, result: TestResult): void {
    console.log(`${result.status}: ${basename(test.location.file)}:${test.location.line}`);
    if (result.status === 'failed' || result.status === 'timedOut') {
      console.error('Failure details withheld: browser call logs and assertion values may contain wallet secrets.');
    }
  }

  onError(): void {
    console.error('Wallet E2E setup or runner failed; raw error details are withheld. Check capture policy, build and backend prerequisites.');
  }

  onEnd(result: FullResult): void { console.log(`Wallet E2E result: ${result.status}`); }
}
