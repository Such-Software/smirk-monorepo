#!/usr/bin/env node
/**
 * Lint for the E-swaps live spec: every tap and typed field must go through
 * the footage helpers, which hold the screen still, check the frame guard and
 * record the hold. A direct `.click(` or `.fill(` in the spec would act with
 * no dead air and no guard, so it fails here. Footage labels must be string
 * literals: a template or variable could carry a value into the timeline.
 *
 * Run: node packages/e2e/scripts/E-swaps-check-live-spec.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : [join(root, 'tests', 'live', 'e-swaps.live.spec.ts')];

const DIRECT = /\.(click|dblclick|fill|press|pressSequentially|type|check|uncheck|selectOption|tap|setInputFiles|dispatchEvent)\(/;
// A bare timer or page sleep; `test.setTimeout` (the test's budget) is fine.
const SLEEP = /\bwaitForTimeout\(|(?<![.\w])setTimeout\(/;
const LABELLED = /\bfootage\.(tap|fill|settled|result|mark|secret|wait)\(\s*([^\s)])/g;

let problems = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    const where = `${file.replace(`${root}/`, '')}:${i + 1}`;
    // `footage.tap(` is the helper itself; any other `.tap(`/`.click(` is direct.
    const direct = code.replace(/\bfootage\.(tap|fill)\(/g, '');
    if (DIRECT.test(direct)) {
      console.error(`${where}: act through footage.tap or footage.fill, not directly`);
      problems++;
    }
    if (SLEEP.test(code)) {
      console.error(`${where}: hold through footage.settled or footage.result, not a sleep`);
      problems++;
    }
    for (const m of code.matchAll(LABELLED)) {
      if (m[2] !== "'" && m[2] !== '"') {
        console.error(`${where}: footage.${m[1]} needs a string literal label first`);
        problems++;
      }
    }
  });
}
if (problems) {
  console.error(`${problems} problem(s) in the live spec`);
  process.exit(1);
}
console.log(`live spec check passed (${files.length} file${files.length === 1 ? '' : 's'})`);
