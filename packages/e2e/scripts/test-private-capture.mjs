import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PRIVATE_USE, assertPrivateCapture, failureSite, sanitizeTestErrors } from '../capture-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('capture and debug overrides refuse before a wallet context is launched', () => {
  assert.doesNotThrow(() => assertPrivateCapture(PRIVATE_USE, {}));
  for (const option of ['trace', 'screenshot', 'video']) {
    for (const value of ['on', 'retain-on-failure', { mode: 'on' }]) {
      assert.throws(() => assertPrivateCapture({ ...PRIVATE_USE, [option]: value }, {}));
    }
  }
  for (const name of ['CAPTURE_VIDEO', 'MARKETING_SHOTS', 'DEBUG', 'PWDEBUG']) {
    assert.throws(() => assertPrivateCapture(PRIVATE_USE, { [name]: '1' }));
  }
});

test('failure sanitization preserves location without assertion values or snapshots', () => {
  const value = randomBytes(32).toString('hex');
  const location = { file: 'fixture.spec.ts', line: 10, column: 2 };
  const info = { errors: [{ message: value, stack: value, errorContext: value, location }] };
  sanitizeTestErrors(info);
  assert.equal(JSON.stringify(info).includes(value), false);
  assert.deepEqual(info.errors[0].location, location);
});

test('a failure keeps its source position as an annotation and nothing of its message', () => {
  const value = randomBytes(32).toString('hex');
  const stack = [
    `Error: expected ${value}`,
    `    at ${value} (/x/node_modules/playwright-core/lib/a.js:1:2)`,
    '    at helper (/repo/packages/e2e/fixtures/lane-helper.ts:42:7)',
    '    at /repo/packages/e2e/tests/live/lane.live.spec.ts:9:3',
  ].join('\n');
  const info = { errors: [{ message: value, stack }], annotations: [] };
  sanitizeTestErrors(info);
  assert.equal(JSON.stringify(info).includes(value), false);
  const site = info.annotations.find((a) => a.type === 'failed-at')?.description ?? '';
  assert.match(site, /^lane-helper\.ts:\d+$/, 'the first frame in the suite names the failing check');
  assert.equal(failureSite({ message: value, stack: `Error: ${value}` }), null, 'a message alone yields no position');
});

test('a real failing browser test does not write or print its generated secret, and its private log explains it', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'smirk-private-capture-'));
  const secret = randomBytes(32).toString('hex');
  const privateLog = join(temporary, 'logs', 'private.jsonl');
  try {
    // ESM like packages/e2e itself, so the specs, fixtures and reporter load
    // the shared .mjs modules the way the lanes do.
    writeFileSync(join(temporary, 'package.json'), '{ "type": "module" }\n');
    const config = join(temporary, 'playwright.config.ts');
    writeFileSync(config, `export default {
      testDir: ${JSON.stringify(temporary)}, timeout: 15000, workers: 1,
      outputDir: ${JSON.stringify(join(temporary, 'results'))},
      preserveOutput: 'always', quiet: true,
      reporter: [[${JSON.stringify(join(root, 'private-reporter.ts'))}]],
      use: { trace: 'off', screenshot: 'off', video: 'off', headless: true }
    };`);
    // The secret is everywhere a careless log could look: the page text, an
    // input value, a test id, a request path and query, a step label, a
    // test.step title, the console, and the assertion's received value.
    writeFileSync(join(temporary, 'failure.spec.ts'), `
      import { test as privateTest } from ${JSON.stringify(join(root, 'fixtures/private-test.ts'))};
      import { attachPrivateContext, noteStep, watchContext } from ${JSON.stringify(join(root, 'fixtures/failure-context.ts'))};
      import { writeFileSync } from 'node:fs';
      import type { Page } from '@playwright/test';
      // A wallet context as the lanes hold one: watched from launch, and
      // explained before it closes (fixtures/extension.ts does the same).
      const test = privateTest.extend<{ page: Page }>({
        page: async ({ browser }, use, testInfo) => {
          const context = await browser.newContext();
          watchContext('alice', context);
          await use(await context.newPage());
          await attachPrivateContext(testInfo);
          await context.close();
        },
      });
      test('controlled secret-bearing failure', async ({ page }) => {
        const value = process.env.PRIVATE_CAPTURE_SENTINEL!;
        await page.route('https://wallet.test/**', (route) => route.fulfill({ body: 'ok' }));
        await page.setContent('<input data-testid="probe-field" /><p data-testid="secret-' + value + '">' + value + '</p>');
        noteStep('Type ' + value);
        await page.locator('input').fill(value);
        await page.evaluate((v) => fetch('https://wallet.test/api/v1/users/by-username/' + v + '?key=' + v, { mode: 'no-cors' }).then(() => {}, () => {}), value);
        await test.expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').length)).toBeGreaterThan(0);
        writeFileSync(process.env.PRIVATE_CAPTURE_PROGRESS!, 'input reached');
        console.log(value);
        noteStep('Check the probe field');
        await test.step('Probe ' + value, async () => {
          await test.expect(page.locator('input')).toHaveValue('forced-mismatch', { timeout: 1 });
        });
      });
    `);
    const result = spawnSync(process.execPath, [join(root, '../../node_modules/playwright/cli.js'), 'test', '-c', config], {
      encoding: 'utf8', timeout: 45000,
      env: {
        ...process.env, DEBUG: '', PWDEBUG: '', PRIVATE_CAPTURE_SENTINEL: secret,
        PRIVATE_CAPTURE_PROGRESS: join(temporary, 'progress'), E2E_PRIVATE_LOG: privateLog,
      },
    });
    assert.equal(existsSync(join(temporary, 'progress')), true, 'the browser reached the secret input');
    assert.equal(result.status, 1, 'the intentional browser failure must execute');
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.equal(output.includes('failed: failure.spec.ts'), true, 'the scenario reached its failure');
    // Besides the test's own line, the output names the line of the failing
    // check (a source position, never a value).
    const positions = new Set([...output.matchAll(/failure\.spec\.ts:(\d+)/g)].map((m) => m[1]));
    assert.ok(positions.size >= 2, 'the failure names the line of the failing check, not only the test');
    assert.equal(output.includes(secret), false, 'generated secret reached command output');
    const files = [];
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    }
    walk(temporary);
    for (const file of files) {
      assert.equal(readFileSync(file).includes(Buffer.from(secret)), false, 'generated secret reached a file');
      assert.equal(/\.(png|webm|zip)$/.test(file), false, 'unexpected media or trace artifact');
    }

    // The private log explains the failure without the secret (checked above
    // with every other file): owner-only, and built from shapes only.
    assert.equal(existsSync(privateLog), true, 'the reporter wrote its private log');
    assert.equal(statSync(privateLog).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(privateLog)).mode & 0o777, 0o700);
    const records = readFileSync(privateLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = records.find((record) => record.type === 'failure');
    assert.ok(failure, 'a failure record');
    assert.match(failure.test, /^failure\.spec\.ts:\d+$/);
    assert.equal(failure.errors[0].matcher, 'toHaveValue', 'the error class names the failed matcher');
    assert.equal(failure.step, 'Check the probe field', 'the step that was running');
    assert.ok(failure.steps.some((step) => step.label === 'label withheld'), 'a value-like step label is withheld, not dropped silently');
    assert.equal(failure.failedCall?.title, undefined, 'a test.step title with a value is withheld');
    const ids = failure.screens.flatMap((screen) => screen.testIds);
    assert.ok(ids.includes('probe-field'), 'screen test ids are listed');
    assert.ok(ids.includes('secret-*'), 'an id-like part of a test id is replaced');
    assert.ok(
      failure.network.some((entry) => entry.host === 'wallet.test' && entry.path === '/api/v1/users/by-username/:x'),
      'request shapes are listed, with the value segment replaced and the query dropped',
    );
    assert.match(output, /Class: Error toHaveValue/, 'the console names the class, not the message');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

/** Every file of a Playwright trace zip, as text (the trace and network logs are JSON lines). */
function traceText(zip) {
  const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  assert.equal(listing.status, 0, 'unzip lists the trace');
  return listing.stdout.split('\n').filter(Boolean)
    .map((name) => spawnSync('unzip', ['-p', zip, name], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 }).stdout)
    .join('\n');
}

// Why the lanes keep Playwright traces off, proved against the installed
// version rather than asserted in a comment: with screenshots and snapshots
// off a trace still keeps what a test typed, what it read and what the page
// logged, and its network log, which exists only with snapshots on, keeps
// request headers. If a later Playwright stops doing this, this test fails
// and the decision in fixtures/failure-record.mjs can be revisited.
test('a Playwright trace keeps typed values, read values and console text even with screenshots and snapshots off', async () => {
  const { chromium } = await import('playwright-core');
  const temporary = mkdtempSync(join(tmpdir(), 'smirk-trace-probe-'));
  const typed = randomBytes(16).toString('hex');
  const shown = randomBytes(16).toString('hex');
  const logged = randomBytes(16).toString('hex');
  const header = randomBytes(16).toString('hex');
  const browser = await chromium.launch({ headless: true });
  try {
    const quiet = await browser.newContext();
    await quiet.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const page = await quiet.newPage();
    await page.setContent(`<input data-testid="field"><p data-testid="shown">${shown}</p>`);
    await page.getByTestId('field').fill(typed);
    assert.equal(await page.getByTestId('shown').textContent(), shown);
    await page.evaluate((text) => console.log(text), logged);
    await quiet.tracing.stop({ path: join(temporary, 'quiet.zip') });
    const quietTrace = traceText(join(temporary, 'quiet.zip'));
    assert.ok(quietTrace.includes(typed), 'the trace keeps a value that fill typed');
    assert.ok(quietTrace.includes(shown), 'the trace keeps a value that textContent read');
    assert.ok(quietTrace.includes(logged), 'the trace keeps console text');
    assert.equal(/"type":"resource-snapshot"/.test(quietTrace), false, 'and it has no network log without snapshots');

    const networked = await browser.newContext();
    await networked.route('https://wallet.test/**', (route) => route.fulfill({ body: 'ok' }));
    await networked.tracing.start({ screenshots: false, snapshots: true });
    const other = await networked.newPage();
    await other.goto('https://wallet.test/');
    await other.evaluate((value) => fetch('/api', { headers: { authorization: `Bearer ${value}` } }).then(() => {}), header);
    await networked.tracing.stop({ path: join(temporary, 'networked.zip') });
    assert.ok(traceText(join(temporary, 'networked.zip')).includes(header), 'the network log keeps request headers');
  } finally {
    await browser.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
