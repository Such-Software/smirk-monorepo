import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const patterns = [
  ['private key block', new RegExp('-----BEGIN ' + '(?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)')],
  ['AWS access key identifier', new RegExp('AK' + 'IA[0-9A-Z]{16}')],
  ['Slack token', new RegExp('xox' + '[baprs]-[0-9A-Za-z-]{10,}')],
  ['credential in URL', new RegExp('https?://[^\\s]*:[^ @/]{16,}@')],
];
const patternsFile = resolve(root, process.env.SECRET_SCAN_PATTERNS_FILE || 'scripts/secret-scan.local.txt');
let projectPatterns = false;
if (existsSync(patternsFile)) {
  projectPatterns = true;
  for (const line of readFileSync(patternsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error('Project secret pattern has no label or tab separator.');
    try { patterns.push(['project-specific pattern', new RegExp(line.slice(tab + 1))]); }
    catch { throw new Error('Project secret pattern is invalid; its value is withheld.'); }
  }
} else {
  console.warn('secret-scan: project-specific patterns unavailable; only generic patterns are checked.');
}
let failed = false;
for (const file of new Set(files)) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  let bytes;
  try { bytes = readFileSync(path); }
  catch { throw new Error(`Cannot read source file: ${file}`); }
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  for (const [label, pattern] of patterns) {
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      console.error(`secret-scan: ${file}:${index + 1}: ${label}; value withheld.`);
      failed = true;
    });
  }
}
if (failed) {
  console.error('secret-scan refused: remove the reported material before committing.');
  process.exitCode = 1;
} else {
  console.log(`secret-scan: ${projectPatterns ? 'generic and project-specific' : 'generic'} checks passed.`);
}
