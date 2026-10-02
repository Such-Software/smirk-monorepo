// Release builds record provenance only from a clean checkout. These checks keep
// the two causes of run 10002's refusal from returning: a dependency install
// that rewrites the lockfile, and lockfile entries for workspaces that are not
// in the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the release workflow installs dependencies without rewriting the lockfile', () => {
  const workflow = readFileSync(join(root, '.gitea/workflows/desktop-build.yml'), 'utf8');
  const installs = workflow.split('\n').filter((line) => /^\s*run:\s*npm (install|i|ci)\b/.test(line));
  assert.ok(installs.length > 0, 'expected the release workflow to install dependencies');
  for (const line of installs) assert.match(line, /npm ci\b/, `release install may rewrite source: ${line.trim()}`);
});

test('every workspace in the lockfile exists in the tree', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const workspaces = Object.keys(lock.packages ?? {}).filter((key) => key && !key.startsWith('node_modules/'));
  assert.ok(workspaces.length > 0, 'expected workspace entries in the lockfile');
  for (const path of workspaces) {
    assert.ok(existsSync(join(root, path, 'package.json')), `lockfile names a workspace absent from the tree: ${path}`);
  }
});
