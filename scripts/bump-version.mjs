#!/usr/bin/env node
/**
 * bump-version.mjs — set every shipped artifact's version to a single
 * semver. Lockstep across the workspace: root + every `packages/*` +
 * the extension's `manifest.json` (the file Chrome/Firefox actually
 * read, which `npm version` ignores).
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.3.0          # write
 *   node scripts/bump-version.mjs 0.3.0 --check  # verify-only, no writes
 *   node scripts/bump-version.mjs --print        # print current versions
 *
 * Cargo crates are deliberately left alone — they aren't published from
 * here, and the smirk-wasm crate's npm package picks up the version
 * via its own `package.json` once that file exists. If we later need
 * Cargo crates in lockstep, add them to CARGO_TARGETS below.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Targets carry the file path + the JSON path to the version string.
// Keep the manifest target last — it's the file Chrome reads, and we
// want it confirmed-written after every npm package has been touched.
const NPM_TARGETS = [
  'package.json',
  'packages/assets/package.json',
  'packages/core/package.json',
  'packages/extension/package.json',
  'packages/swap/package.json',
  'packages/ui/package.json',
  'packages/wasm/package.json',
];
const MANIFEST_TARGETS = ['packages/extension/manifest.json'];

// Rust crates intentionally skipped — they're never published. If
// a future release needs Cargo in lockstep, add their Cargo.toml here
// and extend bumpCargoToml.
const CARGO_TARGETS = [];

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function readJson(rel) {
  const p = resolve(ROOT, rel);
  return { path: p, json: JSON.parse(readFileSync(p, 'utf8')) };
}

function writeJson(path, json) {
  // Preserve the workspace convention: two-space indent + trailing newline.
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
}

function bumpJsonTargets(targets, newVersion, check) {
  const changes = [];
  for (const rel of targets) {
    const { path, json } = readJson(rel);
    const prev = json.version;
    if (prev === newVersion) continue;
    changes.push({ rel, prev, next: newVersion });
    if (!check) {
      json.version = newVersion;
      writeJson(path, json);
    }
  }
  return changes;
}

function printAll() {
  const all = [...NPM_TARGETS, ...MANIFEST_TARGETS];
  const width = Math.max(...all.map((p) => p.length));
  for (const rel of all) {
    const { json } = readJson(rel);
    console.log(`${rel.padEnd(width)}  ${json.version}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(
      'usage: bump-version.mjs <semver> [--check]\n' +
        '       bump-version.mjs --print',
    );
    process.exit(args.length === 0 ? 1 : 0);
  }
  if (args[0] === '--print') {
    printAll();
    return;
  }

  const version = args[0];
  const check = args.includes('--check');
  if (!SEMVER_RE.test(version)) {
    console.error(`error: "${version}" is not a valid semver (X.Y.Z[-tag])`);
    process.exit(2);
  }

  const changes = [
    ...bumpJsonTargets(NPM_TARGETS, version, check),
    ...bumpJsonTargets(MANIFEST_TARGETS, version, check),
  ];

  if (changes.length === 0) {
    console.log(`all targets already at ${version} — nothing to do`);
    return;
  }

  const verb = check ? 'would update' : 'updated';
  for (const c of changes) {
    console.log(`${verb}: ${c.rel}  ${c.prev} → ${c.next}`);
  }

  if (check && changes.length > 0) {
    process.exit(1);
  }
}

main();
