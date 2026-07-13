#!/usr/bin/env node
// Derive the workspace build order TOPOLOGICALLY from the actual dependency
// graph, so nobody ever hand-maintains a build list again (which drifted twice:
// a missing @smirk/dapp-browser and @smirk/swap each broke clean-clone builds
// while "working" locally only because stale dist/ happened to be on disk).
//
// Edges come from BOTH declared workspace deps AND real `import ... from '@scope/pkg'`
// statements in each package's src/. Using imports (not just package.json) means
// the order stays correct even when a manifest forgets to declare a workspace dep.
//
// Usage (run from the monorepo root):
//   node scripts/build-workspaces.mjs order     # print the derived order, build nothing
//   node scripts/build-workspaces.mjs libs      # build all shared libs, in order
//   node scripts/build-workspaces.mjs chrome    # libs + build:chrome  @smirk/extension
//   node scripts/build-workspaces.mjs firefox   # libs + build:firefox @smirk/extension
//
// Dependency-free (Node stdlib only) on purpose: AMO reviewers reproducing the
// build must not need extra tooling.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const WS_SCOPES = ['@smirk/', '@such-software/'];

// Apps + test harnesses are build TARGETS / not shared libs, so `libs` excludes them.
const NON_LIB = new Set(['@smirk/extension', '@smirk/desktop', '@smirk/e2e', '@smirk/smoke-tests']);

// --- discover every workspace under packages/* ---
const byName = {};
for (const d of readdirSync(join(ROOT, 'packages'))) {
  const pjPath = join(ROOT, 'packages', d, 'package.json');
  if (!existsSync(pjPath)) continue;
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  byName[pj.name] = { name: pj.name, dir: join('packages', d), pj };
}
const isWs = (n) => Object.prototype.hasOwnProperty.call(byName, n);

// --- edges = declared workspace deps ∪ workspace imports found in src/ ---
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
}
function edgesFor(info) {
  const declared = Object.keys({ ...info.pj.dependencies, ...info.pj.devDependencies })
    .filter((n) => WS_SCOPES.some((s) => n.startsWith(s)) && isWs(n));
  const imported = new Set();
  const src = join(ROOT, info.dir, 'src');
  if (existsSync(src)) {
    const files = [];
    walk(src, files);
    const re = /(?:from|import)\s*\(?\s*['"](@smirk\/[a-z0-9-]+|@such-software\/[a-z0-9-]+)/g;
    for (const f of files) {
      const txt = readFileSync(f, 'utf8');
      for (const m of txt.matchAll(re)) if (isWs(m[1])) imported.add(m[1]);
    }
  }
  return new Set([...declared, ...imported].filter((n) => n !== info.name));
}
const graph = {};
for (const n of Object.keys(byName)) graph[n] = edgesFor(byName[n]);

// --- topological sort (DFS, deterministic by sorting node names) ---
const order = [], done = new Set(), onstack = new Set();
function visit(n) {
  if (done.has(n)) return;
  if (onstack.has(n)) throw new Error(`dependency cycle involving ${n}`);
  onstack.add(n);
  for (const dep of [...graph[n]].sort()) if (isWs(dep)) visit(dep);
  onstack.delete(n);
  done.add(n);
  order.push(n);
}
for (const n of Object.keys(byName).sort()) visit(n);

const buildable = order.filter((n) => byName[n].pj.scripts?.build);
const libs = buildable.filter((n) => !NON_LIB.has(n));

const target = process.argv[2] || 'order';
function run(args) {
  console.log('>', 'npm', args.join(' '));
  // shell: true so Windows resolves `npm` -> `npm.cmd` (execFileSync without a
  // shell can't find the .cmd shim -> spawnSync npm ENOENT). Args are static
  // (no spaces/user input), so shell word-splitting is safe here.
  execFileSync('npm', args, { stdio: 'inherit', cwd: ROOT, shell: true });
}

if (target === 'order') {
  console.log('Derived build order (libs, topological):');
  libs.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
  console.log('then the app (@smirk/extension for chrome/firefox).');
  process.exit(0);
}

console.log(`Building libs in derived order: ${libs.join(' -> ')}`);
for (const n of libs) run(['run', 'build', '--workspace', n]);
if (target === 'libs') process.exit(0);
if (target === 'chrome') run(['run', 'build:chrome', '--workspace', '@smirk/extension']);
else if (target === 'firefox') run(['run', 'build:firefox', '--workspace', '@smirk/extension']);
else {
  console.error(`unknown target '${target}' (expected: order | libs | chrome | firefox)`);
  process.exit(1);
}
