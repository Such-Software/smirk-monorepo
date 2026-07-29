/**
 * Preflight: prove the built extension actually targets the backend under test.
 *
 * The wallet's backend URL is baked in at BUILD time from
 * `VITE_SMIRK_BACKEND_URL`, while the specs read `BACKEND_URL` at RUN time.
 * Nothing previously connected the two, so `make ext-chrome` with no env var
 * produced a bundle pointed at PRODUCTION while the specs talked to localhost.
 *
 * That failure is silent and expensive: every spec hangs solving prod's
 * proof-of-work, tests fail for reasons that look like application bugs, and a
 * run can even appear to pass while exercising the wrong server entirely. It
 * cost a full debugging session once; this makes it a one-line error instead.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIST =
  process.env.EXTENSION_DIST ?? join(__dirname, '..', 'extension', 'dist');
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8080/api/v1';

/** Every JS file in the bundle, including chunks (the URL usually lands there). */
function bundleSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export default function globalSetup(): void {
  if (!existsSync(DIST)) {
    throw new Error(
      `[e2e preflight] No extension build at ${DIST}.\n` +
        `Build it first, pointed at the backend under test:\n` +
        `  VITE_SMIRK_BACKEND_URL=${BACKEND_URL} make ext-chrome`,
    );
  }

  const haystack = bundleSources(DIST)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  if (haystack.includes(BACKEND_URL)) return; // built against the right target

  // Not found. Work out what it WAS built against so the error is actionable.
  const found = [
    ...new Set(
      (haystack.match(/https?:\/\/[a-zA-Z0-9.\-:]+\/api\/v1/g) ?? []).filter(
        // the trocador webhook base is a different thing; don't report it as the API
        (u) => !u.includes('webhook'),
      ),
    ),
  ];

  throw new Error(
    `[e2e preflight] The built extension does NOT target the backend under test.\n\n` +
      `  BACKEND_URL (specs talk to): ${BACKEND_URL}\n` +
      `  baked into the bundle:       ${found.length ? found.join(', ') : '(none found)'}\n\n` +
      `The specs and the wallet would be talking to different servers, which fails\n` +
      `in ways that look like application bugs. Rebuild against the same target:\n\n` +
      `  VITE_SMIRK_BACKEND_URL=${BACKEND_URL} make ext-chrome\n`,
  );
}
