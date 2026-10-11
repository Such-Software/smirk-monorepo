import { basename } from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import {
  CONTEXT_ATTACHMENT,
  appendPrivateLog,
  describeErrorClass,
  errorClassOf,
  locationLabel,
  privateLogPath,
  safeErrorClass,
  safeLabel,
  shapeContext,
  type ShapedContext,
} from './fixtures/failure-record.mjs';

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

/**
 * Do not serialize browser stdout, error values, steps, attachments or HTML.
 *
 * Every failure is explained in a private log instead (fixtures/failure-record.mjs
 * defines what that may hold): its error class, the lane step that was running,
 * the test ids on each wallet screen, the shape of recent requests, and any
 * wallet that had to be brought back Home. All of it is built from fixed shapes,
 * never from messages or page text, and re-shaped here before it is written.
 * Playwright traces stay off: see failure-record.mjs for why.
 */
export default class PrivateReporter implements Reporter {
  private config = '';
  private logPath = '';
  private logged = 0;
  private logFailed = false;

  printsToStdio(): boolean { return true; }

  onBegin(config: FullConfig): void {
    this.logPath = privateLogPath(process.env, config.configFile ?? '');
    this.config = basename(config.configFile ?? 'playwright.config.ts');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    console.log(`${result.status}: ${basename(test.location.file)}:${test.location.line}`);
    const { errors: classified, ...context } = readContext(result);
    const failed = result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted';
    if (failed) {
      // The worker classified the errors before withholding them; an error it
      // never saw (a crashed worker) is classified here, by shape only.
      const errors = classified?.length ? classified : result.errors.map((error) => safeErrorClass(errorClassOf(error)));
      const call = failingCall(result.steps);
      const step = context.steps?.at(-1)?.label;
      const at = failureLocations(test, result);
      this.write({
        type: 'failure',
        test: `${basename(test.location.file)}:${test.location.line}`,
        ...optional('title', safeLabel(test.title)),
        status: result.status,
        retry: result.retry,
        durationMs: result.duration,
        errors,
        ...(at.length ? { failedAt: at } : {}),
        ...optional('failedCall', call),
        ...optional('step', step),
        ...context,
        errorsSeen: result.errors.length,
      });
      const why = errors[0] ? describeErrorClass(errors[0]) : 'unknown';
      if (at.length) console.error(`failed at: ${at.join(', ')}`);
      console.error(
        `  Failure details withheld (values may be secrets). Class: ${why}${step ? `; step: "${step}"` : ''}.`,
      );
    } else if (context.recoveries?.length) {
      this.write({ type: 'recovery', test: `${basename(test.location.file)}:${test.location.line}`, status: result.status, recoveries: context.recoveries });
    }
    for (const recovery of context.recoveries ?? []) {
      const from = recovery.from?.length ? recovery.from.slice(0, 6).join(', ') : 'Home';
      const moves = recovery.moves.length ? recovery.moves.join(', ') : 'none';
      console.log(`  ${recovery.wallet} reopened on ${from}; moves: ${moves}; ${recovery.failed ? 'not recovered' : `now ${recovery.reached ?? 'unknown'}`}${recovery.kept ? ` (${recovery.kept})` : ''}`);
    }
  }

  onError(error: TestError): void {
    const shape = safeErrorClass(errorClassOf(error));
    this.write({ type: 'runner-error', errors: [shape] });
    console.error(`Wallet E2E setup or runner failed; raw error details are withheld. Class: ${describeErrorClass(shape)}. Check capture policy, build and backend prerequisites.`);
  }

  onEnd(result: FullResult): void {
    console.log(`Wallet E2E result: ${result.status}`);
    if (this.logged) console.log(`Private failure log (${this.logged} record${this.logged === 1 ? '' : 's'}, owner-only): ${this.logPath}`);
    if (this.logFailed) console.error('The private failure log could not be written; failures are unexplained this run.');
  }

  private write(record: Record<string, unknown>): void {
    if (!this.logPath) this.logPath = privateLogPath(process.env, this.config);
    try {
      appendPrivateLog(this.logPath, { at: new Date().toISOString(), config: this.config, ...record });
      this.logged++;
    } catch {
      this.logFailed = true;
    }
  }
}

function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** The worker's attachment, shaped again: nothing outside failure-record's shapes survives. */
function readContext(result: TestResult): ShapedContext {
  const attachment = result.attachments.find((a) => a.name === CONTEXT_ATTACHMENT && a.body);
  if (!attachment?.body) return {};
  try {
    return shapeContext(JSON.parse(attachment.body.toString('utf8')));
  } catch {
    return {};
  }
}

/** The deepest step that failed: its kind and where it was called, never its title (a `fill` title can quote the value). */
function failingCall(steps: readonly TestStep[]): { category: string; at?: string; title?: string } | null {
  for (const step of [...steps].reverse()) {
    if (!step.error) continue;
    const deeper = failingCall(step.steps);
    if (deeper) return deeper;
    const category = /^[a-z][a-z.:]{0,23}$/.test(step.category) ? step.category : 'other';
    const at = locationLabel(step.location);
    // Only a spec's own test.step titles are labels a person wrote; still re-checked.
    const title = step.category === 'test.step' ? safeLabel(step.title) : null;
    return { category, ...(at ? { at } : {}), ...(title ? { title } : {}) };
  }
  return null;
}
