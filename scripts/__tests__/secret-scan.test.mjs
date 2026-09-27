import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

test('secret scan refuses untracked credential material without disclosing its value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smirk-secret-scan-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
    const secret = ['AK', 'IA', randomBytes(8).toString('hex').toUpperCase()].join('');
    writeFileSync(join(dir, 'untracked.txt'), secret);
    const scanner = fileURLToPath(new URL('../secret-scan.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [scanner], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('untracked.txt:1'));
    assert.ok(!output.includes(secret), 'matched values must never reach output');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
