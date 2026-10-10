#!/usr/bin/env node
/**
 * Static check for the area D live specs (tests/live/d-*.live.spec.ts).
 *
 * The video policy is enforced by the footage fixture, so a spec that taps,
 * types or pauses on its own silently escapes it: no 6 s pre-tap hold, no
 * redaction scope around a password, a sleep where a hold belongs. This check
 * refuses those patterns, and labels that are not plain string literals.
 *
 *   node packages/e2e/scripts/D-messaging-federation-check-live-specs.mjs
 *
 * Exits 1 and names file:line and the rule for each violation; prints no code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../tests/live/', import.meta.url));

export const RULES = [
  {
    pattern: /(?<!footage)\.(click|dblclick|fill|press|pressSequentially|check|uncheck|selectOption|setInputFiles|tap|type|hover|dragTo)\(/,
    rule: 'interacts directly; use w.footage.tap or w.footage.type so the pre-tap hold and redaction apply',
  },
  {
    pattern: /waitForTimeout\(|(?<!test\.)setTimeout\(|\bsleep\(/,
    rule: 'pauses ad hoc; holds belong to the footage fixture (settled, result)',
  },
  {
    pattern: /\.screenshot\(|\brecordVideo\b|\btracing\./,
    rule: 'captures outside the guarded recorder',
  },
  {
    pattern: /console\.(log|info|debug|warn|error)\(/,
    rule: 'prints; output can carry values (findings go through recordFinding)',
  },
  {
    pattern: /\.(chapter|settled|result|secret|mark)\(\s*`/,
    rule: 'builds a footage label from a template; labels are static string literals',
  },
  {
    pattern: /footage\.(tap|type)\([^)]*,\s*`[^`]*`\s*(,\s*\{[^}]*\})?\)/,
    rule: 'builds a footage label from a template; labels are static string literals',
  },
];

/** Violations in one source text: [{ line, rule }]. */
export function check(source) {
  const out = [];
  source.split('\n').forEach((text, index) => {
    const code = text.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code)) return; // block comment body
    for (const { pattern, rule } of RULES) {
      if (pattern.test(code)) out.push({ line: index + 1, rule });
    }
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(dir).filter((name) => /^d-.*\.live\.spec\.ts$/.test(name));
  if (files.length === 0) {
    console.error('no area D live specs found; refusing to report a clean check of nothing');
    process.exit(1);
  }
  let failures = 0;
  for (const name of files) {
    for (const { line, rule } of check(readFileSync(join(dir, name), 'utf8'))) {
      failures++;
      console.error(`tests/live/${name}:${line}: ${rule}`);
    }
  }
  if (failures) process.exit(1);
  console.log(`area D live specs: ${files.length} files follow the footage policy`);
}
