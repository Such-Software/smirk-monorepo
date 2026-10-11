import { basename } from 'node:path';
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

/**
 * Where a failed result points, as `file:line`. sanitizeTestErrors
 * (capture-policy.mjs) keeps only an error's location and records the source
 * position of its failing frame as a `failed-at` annotation before dropping
 * the stack. A source position is never a value, so a long unattended run says
 * which check failed without a call log, an assertion value or a snapshot.
 */
export function failureLocations(test: Pick<TestCase, 'annotations'>, result: Pick<TestResult, 'errors'> & { annotations?: TestCase['annotations'] }): string[] {
  const seen = new Set<string>();
  for (const error of result.errors ?? []) {
    const location = error.location;
    if (location?.file && Number.isInteger(location.line)) seen.add(`${basename(location.file)}:${location.line}`);
  }
  for (const annotation of [...(result.annotations ?? []), ...(test.annotations ?? [])]) {
    if (annotation.type !== 'failed-at' || !annotation.description) continue;
    for (const site of annotation.description.split(', ')) {
      if (/^[\w.-]+:\d+$/.test(site)) seen.add(site);
    }
  }
  return [...seen];
}

/** Do not serialize browser stdout, error values, steps, attachments or HTML. */
export default class PrivateReporter implements Reporter {
  printsToStdio(): boolean { return true; }

  onTestEnd(test: TestCase, result: TestResult): void {
    console.log(`${result.status}: ${basename(test.location.file)}:${test.location.line}`);
    if (result.status === 'failed' || result.status === 'timedOut') {
      const at = failureLocations(test, result);
      if (at.length) console.error(`failed at: ${at.join(', ')}`);
      console.error('Failure details withheld: browser call logs and assertion values may contain wallet secrets.');
    }
  }

  onError(): void {
    console.error('Wallet E2E setup or runner failed; raw error details are withheld. Check capture policy, build and backend prerequisites.');
  }

  onEnd(result: FullResult): void { console.log(`Wallet E2E result: ${result.status}`); }
}
