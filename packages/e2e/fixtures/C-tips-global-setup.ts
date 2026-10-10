/**
 * C-tips live global setup. Cheap refusals first, then the release binding,
 * then the shared preflight (reporters, bundle target, v3 API).
 *
 *   1. Every live gate is open (liveGateReason), or the run refuses with why.
 *   2. ffmpeg and ffprobe exist: the run's video is part of its evidence, and
 *      finding out after a day of holds would waste the day.
 *   3. The run's ledger holds no unsettled tip from an earlier invocation
 *      (unless this is a rescue run), and no completed run under this label.
 *   4. The release zip is the candidate (SHA-256, manifest version); it is
 *      unpacked and EXTENSION_DIST points at it for every worker.
 *   5. global-setup.ts: approved reporters, a bundle that targets BACKEND_URL,
 *      and a backend that serves the v3 API.
 */
import { spawnSync } from 'node:child_process';
import type { FullConfig } from '@playwright/test';
import { liveGateReason, rescueMode } from './C-tips-live.js';
import { invocationId, runLabel, stateDir } from './C-tips-run.mjs';
import { verifyRelease } from './C-tips-release.js';
import { SETTLED_STATUSES, TipLedger } from './C-tips-ledger.js';
import { publicTip } from './C-tips-actions.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function haveTool(name: string): boolean {
  const r = spawnSync(name, ['-hide_banner', '-version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * Refuse with the reason printed: the private reporter withholds raw setup
 * errors (they could carry values), and these reasons are authored text.
 */
function refuse(reason: string): never {
  console.error(`C-tips live lane refused: ${reason}`);
  throw new Error(`C-tips live lane refused: ${reason}`);
}

export default async function cTipsGlobalSetup(config: FullConfig): Promise<void> {
  try {
    await setUp(config);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('C-tips live lane refused')) throw error;
    refuse(error instanceof Error ? error.message.split('\n')[0]! : 'setup failed');
  }
}

async function setUp(config: FullConfig): Promise<void> {
  const gate = liveGateReason();
  if (gate) refuse(gate);
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!haveTool(tool)) refuse(`${tool} is not installed, and the run's video is part of its evidence`);
  }

  if (existsSync(join(stateDir(), 'ledger.json'))) {
    const ledger = new TipLedger(stateDir(), runLabel(), invocationId());
    const inherited = ledger.inheritedTips();
    const open: string[] = [];
    for (const tip of inherited) {
      const state = await publicTip(tip.tipId).catch(() => null);
      if (!state || !SETTLED_STATUSES.has(state.status)) open.push(`${tip.key} (${state?.status ?? 'status unknown'})`);
    }
    if (!rescueMode() && open.length) {
      refuse(
        `run ${runLabel()} has ${open.length} unsettled tip(s) from an earlier invocation: ` +
          `${open.join(', ')}. Settle them first with E2E_LIVE_RESCUE=1 and --grep "rescue|overview" (see RECOVERY.md), ` +
          'or start a new run with another E2E_RUN_LABEL.',
      );
    }
    if (!rescueMode() && inherited.length) {
      refuse(`run ${runLabel()} already holds a completed run; set a new E2E_RUN_LABEL`);
    }
  } else if (rescueMode()) {
    refuse(`a rescue run needs a ledger, and run ${runLabel()} has none`);
  }

  const release = await verifyRelease();
  process.env.EXTENSION_DIST = release.dist;
  console.log(`C-tips live lane: release ${release.version} verified (sha256 ${release.sha256.slice(0, 16)}...), invocation ${invocationId()}`);

  // The shared preflight reads EXTENSION_DIST when it loads, so load it now.
  const { default: baseSetup } = await import('../global-setup.js');
  await baseSetup(config);
}
