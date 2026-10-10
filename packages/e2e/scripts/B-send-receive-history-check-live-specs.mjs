#!/usr/bin/env node
/**
 * Static check for the B live lane: the live specs and their flows drive the
 * wallet only through the footage hooks, so every tap gets its 6 s static
 * hold and every wait is a recorded hold rather than an ad hoc sleep.
 *
 *   node packages/e2e/scripts/B-send-receive-history-check-live-specs.mjs
 *
 * Refuses, in the checked files:
 *   - a Playwright action (click, fill, press, type, check, tap, ...) whose
 *     receiver is not a footage object (`footage`, `*Footage`);
 *   - waitForTimeout or setTimeout, unless the line says `lint-allow: poll`
 *     (a short poll interval inside a wait, never a hold);
 *   - a footage label built from a variable other than a ticker or an action
 *     name, which could put a value into a caption.
 * Exits non-zero with file:line for each finding.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'tests/live/b-send-receive.live.spec.ts',
  'tests/live/b-history-detail.live.spec.ts',
  'fixtures/B-send-receive-history-flows.ts',
];
const ACTION = /([A-Za-z_$][\w$]*)\s*\.\s*(click|dblclick|fill|press|pressSequentially|type|check|uncheck|selectOption|setInputFiles|tap|hover|dragTo)\s*\(/g;
const SLEEP = /\b(waitForTimeout|setTimeout)\s*\(/;
const HOOK_LABEL = /\b(?:footage|Footage)\s*\.\s*(?:tap|fill|settled|result|hold|secret|mark)\s*\(([^;]*)/;
// The label is a call's last string argument; only these interpolations are static.
const LITERALS = /'[^']*'|`[^`]*`/g;
const SAFE_TEMPLATE_PARTS = /^\$\{(TICKER\[[\w.]+\]|action|tier)\}$/;

const findings = [];
for (const file of FILES) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(line)) return; // doc comment body
    for (const m of code.matchAll(ACTION)) {
      if (!/footage$/i.test(m[1])) findings.push(`${file}:${i + 1}: ${m[2]}() outside the footage hooks`);
    }
    if (SLEEP.test(code) && !/lint-allow: poll/.test(line)) findings.push(`${file}:${i + 1}: sleep outside the footage hooks`);
    const hook = HOOK_LABEL.exec(code);
    const label = hook ? (hook[1].match(LITERALS) ?? []).at(-1) : undefined;
    if (label) {
      for (const part of label.match(/\$\{[^}]*\}/g) ?? []) {
        if (!SAFE_TEMPLATE_PARTS.test(part)) findings.push(`${file}:${i + 1}: a footage label interpolates ${part}`);
      }
    }
  });
}

if (findings.length) {
  console.error(`B live lane lint: ${findings.length} finding(s)\n${findings.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`B live lane lint: ${FILES.length} files clean`);
