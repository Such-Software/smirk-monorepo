/**
 * C-tips run layout: where one live run keeps its state, footage and video.
 * Plain JavaScript so the encoder (scripts/C-tips-encode.mjs) loads it without
 * a TypeScript loader.
 *
 *   ~/Build/smirk-e2e/<run>/                       E2E_RUN_DIR overrides
 *     C-tips-state/                                0700
 *       ledger.json                                every tip this run created (ids, never links)
 *       salt                                       per-run salt for the derived wallet passwords
 *       profiles/<wallet>/                         browser profiles, kept while any tip is unsettled
 *       release/                                   the verified, unpacked release zip
 *       RECOVERY.md                                written when profiles are kept
 *     footage/raw/C-tips/<invocation>/<session>/   FOOTAGE_DIR overrides footage/
 *     footage/video/C-tips/<invocation>/           encoded video and the hold check
 *
 * One invocation is one `playwright test` run (C-tips.live.config.ts sets
 * C_TIPS_INVOCATION); a session is one worker's lane inside it. A failed test
 * restarts the worker, so one invocation can hold several sessions.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_RUN_LABEL = 'v0.3.1-run-11204';

/** The owner's dead-air policy: a still screen before each tap, on every settled screen, on key results. */
export const OWNER_POLICY = Object.freeze({ tap: 6_000, settled: 12_000, result: 25_000 });

export function runLabel(env = process.env) {
  const run = (env.E2E_RUN_LABEL ?? DEFAULT_RUN_LABEL).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(run)) throw new Error('E2E_RUN_LABEL must be a short file-name-safe label.');
  return run;
}

export function runRoot(env = process.env) {
  const configured = (env.E2E_RUN_DIR ?? '').trim();
  return configured ? resolve(configured) : join(homedir(), 'Build', 'smirk-e2e', runLabel(env));
}

export function footageRoot(env = process.env) {
  const configured = (env.FOOTAGE_DIR ?? '').trim();
  return configured ? resolve(configured) : join(runRoot(env), 'footage');
}

export function stateDir(env = process.env) {
  return join(runRoot(env), 'C-tips-state');
}

/** This invocation's id, or 'adhoc' outside the live config (offline tests). */
export function invocationId(env = process.env) {
  const id = (env.C_TIPS_INVOCATION ?? '').trim();
  if (!id) return 'adhoc';
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) throw new Error('C_TIPS_INVOCATION must be a short id.');
  return id;
}

export function rawRoot(env = process.env) {
  return join(footageRoot(env), 'raw', 'C-tips');
}

export function videoRoot(env = process.env) {
  return join(footageRoot(env), 'video', 'C-tips');
}

/** Create (or tighten) an owner-only directory, parents included. */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
