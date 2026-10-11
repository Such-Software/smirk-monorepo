// The private reporter explains failures in its owner-only log and on the
// console without a single value: fed raw errors, call titles and a crafted
// attachment that all carry secrets, nothing secret comes out. The secrets are
// every probe in fixtures/leak-probes.mjs (a phrase in any case or separator,
// passwords, keys, links), and a leak is any piece of one in any case.
// Run: node --import tsx --test packages/e2e/scripts/private-reporter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PrivateReporter from '../private-reporter.ts';
import { CONTEXT_ATTACHMENT } from '../fixtures/failure-record.mjs';
import { TEST_PHRASE, leaked, probes } from '../fixtures/leak-probes.mjs';

/** Run `fn` with console output captured. */
function captured(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

function withLog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'smirk-private-reporter-'));
  const path = join(dir, 'logs', 'run.jsonl');
  const saved = process.env.E2E_PRIVATE_LOG;
  process.env.E2E_PRIVATE_LOG = path;
  try {
    return fn(path);
  } finally {
    if (saved === undefined) delete process.env.E2E_PRIVATE_LOG;
    else process.env.E2E_PRIVATE_LOG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const testCase = (title) => ({ title, location: { file: '/x/tests/live/c-tips.live.spec.ts', line: 154, column: 3 } });

test('a failure is explained by shapes only, in the log and on the console', () => {
  const secret = randomBytes(32).toString('hex');
  const phrase = TEST_PHRASE.join(' ');
  withLog((path) => {
    const reporter = new PrivateReporter();
    const output = captured(() => {
      reporter.onBegin({ configFile: '/x/C-tips.live.config.ts' });
      reporter.onTestEnd(testCase(`claims ${secret}`), {
        status: 'failed',
        retry: 0,
        duration: 1234,
        // An error the worker never withheld (a crashed worker), raw.
        errors: [{ message: `locator.fill: Timeout 60000ms exceeded.\n  - fill("${phrase}")`, stack: `TimeoutError: locator.fill: ${secret}\n    at f (/x/fixtures/C-tips-actions.ts:470:9)` }],
        steps: [{
          title: `Fill "${secret}" getByTestId('tip-amount-input')`, category: 'pw:api', error: { message: secret },
          location: { file: '/x/fixtures/C-tips-actions.ts', line: 470, column: 9 }, steps: [],
        }],
        attachments: [{
          name: CONTEXT_ATTACHMENT,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({
            steps: [{ label: 'Enter the amount', ago: 20 }, { label: phrase }],
            screens: [{ wallet: 'alice', page: 'wallet', testIds: ['tip-amount-input', `tip-detail-${secret}`], text: secret }],
            network: [{ method: 'POST', scheme: 'https', host: 'api.smirk.cash', path: '/api/v1/tips/social', status: 502, ms: 40, ago: 900, body: secret }],
            recoveries: [{ wallet: 'alice', reached: 'home', from: ['tip-success-heading'], moves: ['close the tip result', `type ${secret}`], ms: 2100 }],
            claimLink: `https://smirk.cash/tip/x#k=${secret}`,
          })),
        }],
      });
      reporter.onError({ message: `global setup: ${phrase}`, stack: `Error: ${secret}\n    at setup (/x/global-setup.ts:12:3)` });
      reporter.onEnd({ status: 'failed' });
    });

    assert.equal(leaked(output, [secret, ...TEST_PHRASE]), false, 'console');
    assert.match(output, /failed: c-tips\.live\.spec\.ts:154/);
    assert.match(output, /Class: TimeoutError locator\.fill \(action timeout\) at C-tips-actions\.ts:470; step: "Enter the amount"/);
    assert.match(output, /alice reopened on tip-success-heading; moves: close the tip result; now home/);

    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const text = readFileSync(path, 'utf8');
    assert.equal(leaked(text, [secret, ...TEST_PHRASE]), false, 'log');
    const [failure, runner] = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(failure.type, 'failure');
    assert.equal(failure.test, 'c-tips.live.spec.ts:154');
    assert.equal(failure.title, undefined, 'a title with a value is left out');
    assert.equal(failure.errors[0].api, 'locator.fill');
    assert.deepEqual(failure.failedCall, { category: 'pw:api', at: 'C-tips-actions.ts:470' }, 'the failed call by place, never by its title');
    assert.equal(failure.step, 'Enter the amount');
    assert.deepEqual(failure.screens[0].testIds, ['tip-amount-input', 'tip-detail-*']);
    assert.deepEqual(failure.network[0], { method: 'POST', scheme: 'https', host: 'api.smirk.cash', path: '/api/v1/tips/social', status: 502, ms: 40, ago: 900 });
    assert.deepEqual(failure.recoveries[0].moves, ['close the tip result']);
    assert.equal(failure.claimLink, undefined);
    assert.equal(runner.type, 'runner-error');
    assert.equal(runner.errors[0].at, 'global-setup.ts:12');
  });
});

test('no probe reaches the log or the console, wherever a test, lane or error carries it', () => {
  for (const probe of probes()) {
    const value = probe.value;
    withLog((path) => {
      const reporter = new PrivateReporter();
      const output = captured(() => {
        reporter.onBegin({ configFile: '/x/C-tips.live.config.ts' });
        reporter.onTestEnd(testCase(`unlock with ${value}`), {
          status: 'failed',
          retry: 0,
          duration: 10,
          // A raw error whose call log ends like a frame, before the real one.
          errors: [{
            message: `locator.fill: Timeout 1ms exceeded.\nCall log:\n  - fill("${value}")\n  - waiting for /tmp/${value}:12:3`,
            stack: `TimeoutError: locator.fill: Timeout 1ms exceeded.\nCall log:\n  - navigated to "https://wallet.test/${value}:1:2"\n  - waiting for /tmp/${value}:12:3\nReceived: (/x/${value}:7:1)\n    at f (/x/fixtures/C-tips-actions.ts:470:9)`,
          }],
          steps: [{
            title: `Confirm ${value}`, category: 'test.step', error: { message: value },
            location: { file: '/x/tests/live/c-tips.live.spec.ts', line: 160, column: 5 }, steps: [],
          }],
          attachments: [{
            name: CONTEXT_ATTACHMENT,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({
              errors: [{ name: 'TimeoutError', api: 'locator.fill', at: `${value}:12` }],
              steps: [{ label: 'Enter the amount', ago: 20 }, { label: `Confirm ${value}`, ago: 5 }, { label: value, ago: 1 }],
              recoveries: [{ wallet: 'alice', reached: 'home', moves: ['close the tip result', `type ${value}`], kept: value, ms: 10 }],
            })),
          }],
        });
        reporter.onError({ message: value, stack: `Error: ${value}\nCall log:\n  - waiting for /tmp/${value}:3:4\n    at setup (/x/global-setup.ts:12:3)` });
        reporter.onEnd({ status: 'failed' });
      });
      assert.equal(leaked(output, probe.parts), false, `${probe.name} on the console`);
      const text = readFileSync(path, 'utf8');
      assert.equal(leaked(text, probe.parts), false, `${probe.name} in the log`);
      const [failure, runner] = text.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(failure.title, undefined, `${probe.name}: the title is withheld`);
      assert.deepEqual(failure.steps.map((s) => s.label), ['Enter the amount'], `${probe.name}: only static steps are kept`);
      assert.equal(failure.step, 'Enter the amount', `${probe.name}: the step named is the last one kept`);
      assert.equal(failure.failedCall?.title, undefined, `${probe.name}: the test.step title is withheld`);
      assert.equal(failure.errors[0].at, undefined, `${probe.name}: a place that is not a source file is dropped`);
      assert.equal(runner.errors[0].at, 'global-setup.ts:12', `${probe.name}: the runner error names its frame`);
    });
  }
});

test('an unshaped error names the frame that threw, never a message line that ends like one', () => {
  const token = randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');
  withLog((path) => {
    const reporter = new PrivateReporter();
    const output = captured(() => {
      reporter.onBegin({ configFile: '/x/E-swaps.live.config.ts' });
      reporter.onTestEnd(testCase('swap resumes'), {
        status: 'failed', retry: 0, duration: 1, steps: [], attachments: [],
        errors: [{ message: 'x', stack: `TimeoutError: locator.click: Timeout 1ms exceeded.\nCall log:\n  - waiting for /tmp/${token.slice(0, 20)}/${token.slice(20)}:12:3\n    at tap (/x/fixtures/E-swaps-ui.ts:389:7)` }],
      });
    });
    assert.equal(leaked(output + readFileSync(path, 'utf8'), [token]), false);
    assert.match(output, /Class: TimeoutError locator\.click \(action timeout\) at E-swaps-ui\.ts:389\./);
  });
});

test('a passing test that recovered a wallet is logged as a recovery, and a clean pass writes nothing', () => {
  withLog((path) => {
    const reporter = new PrivateReporter();
    captured(() => {
      reporter.onBegin({ configFile: '/x/B-send-receive-history.live.config.ts' });
      reporter.onTestEnd(testCase('clean'), { status: 'passed', retry: 0, duration: 1, errors: [], steps: [], attachments: [] });
    });
    assert.equal(existsSync(path), false, 'nothing to explain, no log');
    const output = captured(() => {
      reporter.onTestEnd(testCase('reopened'), {
        status: 'passed', retry: 0, duration: 1, errors: [], steps: [],
        attachments: [{ name: CONTEXT_ATTACHMENT, contentType: 'application/json', body: Buffer.from(JSON.stringify({ recoveries: [{ wallet: 'bob', reached: 'home', from: ['send-review-submit', 'send-wizard-header-back'], moves: ['step back out of the send draft'], ms: 800 }] })) }],
      });
      reporter.onEnd({ status: 'passed' });
    });
    const [record] = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(record.type, 'recovery');
    assert.equal(record.recoveries[0].wallet, 'bob');
    assert.match(output, /bob reopened on send-review-submit, send-wizard-header-back; moves: step back out of the send draft; now home/);
    assert.match(output, /Private failure log \(1 record, owner-only\)/);
  });
});
