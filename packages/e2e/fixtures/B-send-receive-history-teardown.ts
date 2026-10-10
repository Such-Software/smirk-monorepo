/**
 * Global teardown for the send, receive and history lane: delete the three
 * wallet profiles once the whole invocation is over.
 *
 * Within one invocation the profiles outlive their worker on purpose: a
 * failed test restarts the worker, and the next one reopens the same
 * profiles (unlock, no restore) instead of importing all three wallets again,
 * so the backend's restore budget is not spent and every send record and
 * Grin history row the wallets wrote stays readable.
 *
 * E2E_LIVE_KEEP_PROFILES=1 keeps them for a later invocation with the same
 * run label (to re-check history without sending again). They hold each
 * wallet encrypted under a password derived in memory from its phrase, in an
 * owner-only directory; delete the run's `profiles` folder when done.
 */

import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { laneDirs, unpackedExtensionVersion } from './B-send-receive-history-dirs.js';

export default async function teardown(): Promise<void> {
  if (process.env.E2E_LIVE !== '1') return;
  const version = unpackedExtensionVersion();
  if (!version) return;
  const { laneDir, profilesRoot } = laneDirs(version);
  if (!existsSync(profilesRoot)) return;
  const keep = process.env.E2E_LIVE_KEEP_PROFILES === '1';
  if (!keep) rmSync(profilesRoot, { recursive: true, force: true });
  const line = keep
    ? 'lane end: wallet profiles kept (E2E_LIVE_KEEP_PROFILES=1); delete the profiles folder when done'
    : 'lane end: wallet profiles deleted';
  appendFileSync(join(laneDir, 'progress.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  console.log(`B lane: ${line.replace(/^lane end: /, '')}`);
}
