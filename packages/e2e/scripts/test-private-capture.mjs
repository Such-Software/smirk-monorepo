import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PRIVATE_USE, assertPrivateCapture, sanitizeTestErrors } from '../capture-policy.mjs';

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

test('a real failing browser test does not write or print its generated secret', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'smirk-private-capture-'));
  const secret = randomBytes(32).toString('hex');
  try {
    const config = join(temporary, 'playwright.config.ts');
    writeFileSync(config, `export default {
      testDir: ${JSON.stringify(temporary)}, timeout: 15000, workers: 1,
      outputDir: ${JSON.stringify(join(temporary, 'results'))},
      preserveOutput: 'always', quiet: true,
      reporter: [[${JSON.stringify(join(root, 'private-reporter.ts'))}]],
      use: { trace: 'off', screenshot: 'off', video: 'off', headless: true }
    };`);
    writeFileSync(join(temporary, 'failure.spec.ts'), `
      import { test } from ${JSON.stringify(join(root, 'fixtures/private-test.ts'))};
      import { writeFileSync } from 'node:fs';
      test('controlled secret-bearing failure', async ({ page }) => {
        const value = process.env.PRIVATE_CAPTURE_SENTINEL!;
        await page.setContent('<input /><p>' + value + '</p>');
        await page.locator('input').fill(value);
        writeFileSync(process.env.PRIVATE_CAPTURE_PROGRESS!, 'input reached');
        console.log(value);
        await test.expect(page.locator('input')).toHaveValue('forced-mismatch', { timeout: 1 });
      });
    `);
    const result = spawnSync(process.execPath, [join(root, '../../node_modules/playwright/cli.js'), 'test', '-c', config], {
      encoding: 'utf8', timeout: 45000,
      env: { ...process.env, DEBUG: '', PWDEBUG: '', PRIVATE_CAPTURE_SENTINEL: secret, PRIVATE_CAPTURE_PROGRESS: join(temporary, 'progress') },
    });
    assert.equal(existsSync(join(temporary, 'progress')), true, 'the browser reached the secret input');
    assert.equal(result.status, 1, 'the intentional browser failure must execute');
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.equal(output.includes('failed: failure.spec.ts'), true, 'the scenario reached its failure');
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
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
