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

/**
 * Prove the target is a v3 API, not merely something that answers.
 *
 * `/health` is useless for this: `backend.smirk.cash` (the v2 tipbot) and
 * `api.smirk.cash` (v3) BOTH return 200 there, while only the latter serves
 * `/api/v1/capabilities`. A build was shipped against the v2 host on the strength
 * of a green `/health`, so this probes the thing that actually distinguishes them.
 */
async function assertServesV3Api(base: string): Promise<void> {
  const url = `${base.replace(/\/$/, '')}/capabilities`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(
      `[e2e preflight] Cannot reach ${url}\n` +
        `  ${e instanceof Error ? e.message : String(e)}\n\n` +
        `Is the backend up, and does BACKEND_URL include /api/v1?\n`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[e2e preflight] ${url} returned HTTP ${res.status}.\n\n` +
        `That host is reachable but is not serving the v3 API. A 404 here with a\n` +
        `healthy /health is the signature of pointing at the OLD v2 backend\n` +
        `(backend.smirk.cash) instead of v3 (api.smirk.cash).\n`,
    );
  }
  try {
    await res.json();
  } catch {
    throw new Error(`[e2e preflight] ${url} did not return JSON, so it is not the v3 API.\n`);
  }
}

export default async function globalSetup(): Promise<void> {
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

  if (haystack.includes(BACKEND_URL)) {
    // Built against the right target. Now prove that target is really a v3 API.
    await assertServesV3Api(BACKEND_URL);
    return;
  }

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
