/**
 * Where the send, receive and history lane keeps one run's state, shared by
 * the worker fixture (fixtures/B-send-receive-history-wallets.ts) and the
 * lane's global teardown (fixtures/B-send-receive-history-teardown.ts).
 *
 *   <run>/                         E2E_LIVE_RUN_DIR, or ~/Build/smirk-e2e/v<version>-<label>
 *     B-send-receive-history/      address book, spend ledger, progress log
 *       profiles/<wallet>/         the wallet's Chromium profile (0700)
 *       profiles/<wallet>.json     which import that profile holds (no secret)
 *     footage/B-send-receive-history/
 *
 * Node built-ins only, so the teardown can load it without a browser.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANE = 'B-send-receive-history';

export interface LaneDirs {
  runDir: string;
  laneDir: string;
  profilesRoot: string;
}

export function laneDirs(extensionVersion: string): LaneDirs {
  const label = (process.env.E2E_LIVE_RUN_LABEL ?? 'run-local').replace(/[^a-z0-9-]/gi, '-');
  const runDir = resolve(
    process.env.E2E_LIVE_RUN_DIR ?? join(homedir(), 'Build', 'smirk-e2e', `v${extensionVersion}-${label}`),
  );
  const laneDir = join(runDir, LANE);
  return { runDir, laneDir, profilesRoot: join(laneDir, 'profiles') };
}

/** The workspace build, used when neither EXTENSION_DIST nor a staged zip is given. */
export function workspaceDist(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'dist');
}

/**
 * The version of the unpacked extension the lane ran (EXTENSION_DIST, which
 * the lane config sets to the staged zip it verified, else the workspace
 * build), or null when there is none to read.
 */
export function unpackedExtensionVersion(): string | null {
  const manifest = join(resolve(process.env.EXTENSION_DIST ?? workspaceDist()), 'manifest.json');
  if (!existsSync(manifest)) return null;
  try {
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}
