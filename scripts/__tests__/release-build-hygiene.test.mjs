// Two reproducibility properties of release builds: the wasm must not embed
// where cargo lives, and the build stamp's only exclusion (the release output
// directory) must hold from the directory vite actually runs in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the wasm build remaps the cargo and rustup homes in use, not only the defaults', () => {
  const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
  assert.match(makefile, /WASM_CARGO_HOME := \$\(or \$\(CARGO_HOME\),\$\(HOME\)\/\.cargo\)/);
  assert.match(makefile, /WASM_RUSTUP_HOME := \$\(or \$\(RUSTUP_HOME\),\$\(HOME\)\/\.rustup\)/);
  const flags = makefile.split('\n').find((line) => line.includes('--remap-path-prefix') && line.includes('RUSTFLAGS='));
  assert.ok(flags, 'wasm RUSTFLAGS line not found');
  for (const remap of ['$(CURDIR)=/smirk', '$(WASM_CARGO_HOME)=/cargo', '$(WASM_RUSTUP_HOME)=/rustup']) {
    assert.ok(flags.includes(`--remap-path-prefix=${remap}`), `missing remap ${remap}`);
  }
});

test('the build stamp excludes only release output, from the directory vite runs in', () => {
  const config = readFileSync(join(root, 'packages/extension/vite.config.ts'), 'utf8');
  const command = config.match(/"git status --porcelain -- ([^"]+)"/);
  assert.ok(command, 'build stamp git command not found');
  const pathspecs = command[1].split(/\s+/).map((spec) => spec.replace(/^'|'$/g, ''));
  assert.deepEqual(pathspecs, [':(top,exclude)packages/extension/releases']);

  const repo = mkdtempSync(join(tmpdir(), 'stamp-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(repo, 'packages/extension/releases'), { recursive: true });
    writeFileSync(join(repo, 'packages/extension/releases/SHA256SUMS.txt'), 'old\n');
    writeFileSync(join(repo, 'packages/extension/index.ts'), 'export {};\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
    const status = () => execFileSync('git', ['status', '--porcelain', '--', ...pathspecs],
      { cwd: join(repo, 'packages/extension'), encoding: 'utf8' }).trim();
    appendFileSync(join(repo, 'packages/extension/releases/SHA256SUMS.txt'), 'rewritten by the release\n');
    assert.equal(status(), '', 'a release rewriting its own checksums must not mark the build dirty');
    appendFileSync(join(repo, 'packages/extension/index.ts'), '// changed source\n');
    assert.match(status(), /index\.ts/, 'a real source change must still mark the build dirty');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("vite's temporary config bundle never marks the build dirty", () => {
  const config = readFileSync(join(root, 'packages/extension/vite.config.ts'), 'utf8');
  const pathspecs = config.match(/"git status --porcelain -- ([^"]+)"/)[1]
    .split(/\s+/).map((spec) => spec.replace(/^'|'$/g, ''));
  const repo = mkdtempSync(join(tmpdir(), 'stamp-vite-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, '.gitignore'), readFileSync(join(root, '.gitignore'), 'utf8'));
    mkdirSync(join(repo, 'packages/extension'), { recursive: true });
    writeFileSync(join(repo, 'packages/extension/vite.config.ts'), 'export default {};\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
    const status = () => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'status', '--porcelain', '--', ...pathspecs],
      { cwd: join(repo, 'packages/extension'), encoding: 'utf8' }).trim();
    // The exact name shape Vite wrote in run 11204's extension job.
    writeFileSync(join(repo, 'packages/extension/vite.config.ts.timestamp-1791627745979-1aa597e04e3a8.mjs'), '// temp\n');
    assert.equal(status(), '', "vite's temp config bundle must not mark the build dirty");
    writeFileSync(join(repo, 'packages/extension/new-source.ts'), 'export {};\n');
    assert.match(status(), /new-source\.ts/, 'a real untracked source file must still mark the build dirty');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
