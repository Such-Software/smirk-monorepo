/**
 * C-tips live global teardown: funds first, then footage.
 *
 *   1. Every tip in the run's ledger is checked against the backend. Only when
 *      all are settled (claimed or clawed back) are the wallet profiles and the
 *      run salt deleted. Otherwise both stay (0700) and RECOVERY.md names each
 *      unsettled tip and the rescue command; the run fails.
 *   2. The invocation's footage is encoded (scripts/C-tips-encode.mjs) and every
 *      hold is checked in the encoded video; a hold that is not there, or a
 *      policy below the owner's, fails the run.
 *
 * Nothing here prints a secret: tip ids, coins, amounts and statuses only.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { footageMode } from './C-tips-footage.js';
import { SETTLED_STATUSES, TipLedger } from './C-tips-ledger.js';
import { publicTip } from './C-tips-actions.js';
import { invocationId, rawRoot, runLabel, stateDir } from './C-tips-run.mjs';

export default async function cTipsGlobalTeardown(): Promise<void> {
  if (!(process.env.C_TIPS_INVOCATION ?? '').trim() || !existsSync(join(stateDir(), 'ledger.json'))) return;
  const problems: string[] = [];

  const ledger = new TipLedger(stateDir(), runLabel(), invocationId());
  const open: string[] = [];
  for (const tip of ledger.tips()) {
    const state = await publicTip(tip.tipId).catch(() => null);
    if (!state || !SETTLED_STATUSES.has(state.status)) {
      open.push(`- ${tip.key}: tip ${tip.tipId}, ${tip.amount} ${tip.asset.toUpperCase()} from ${tip.sender}, status ${state?.status ?? 'unknown (lookup failed)'}`);
    }
  }
  const recovery = join(stateDir(), 'RECOVERY.md');
  if (open.length === 0) {
    rmSync(join(stateDir(), 'profiles'), { recursive: true, force: true });
    rmSync(join(stateDir(), 'salt'), { force: true });
    rmSync(recovery, { force: true });
    console.log(`C-tips: all ${ledger.tips().length} tip(s) of run ${runLabel()} are settled; wallet profiles deleted`);
  } else {
    writeFileSync(
      recovery,
      [
        `# C-tips run ${runLabel()}: tips that still hold funds`,
        '',
        `Written ${new Date().toISOString()} by the global teardown of invocation ${invocationId()}.`,
        'The wallet profiles beside this file hold the senders\' tip key backups; do not delete them.',
        '',
        ...open,
        '',
        'Rescue (reclaims each to its sender, with the same environment as the run):',
        '',
        '    E2E_LIVE_RESCUE=1 npx playwright test -c C-tips.live.config.ts --grep "rescue|overview"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    problems.push(`${open.length} tip(s) still hold funds; profiles kept, see ${recovery}`);
  }

  // Encode only an invocation that recorded something (a refused setup did not).
  if (footageMode() === 'guarded' && existsSync(join(rawRoot(), invocationId()))) {
    const { encodeInvocation } = await import('../scripts/C-tips-encode.mjs');
    try {
      const report = await encodeInvocation({ log: (m) => console.log(`C-tips video: ${m}`) });
      console.log(
        `C-tips video: ${Object.keys(report.pages).length} page video(s)` +
          `${report.combined ? ` and ${report.combined.file}` : ''}; ${report.holds.length} hold(s) checked`,
      );
      if (report.failures.length) {
        problems.push(`the video check failed:\n${report.failures.slice(0, 40).map((f) => `  - ${f}`).join('\n')}`);
      }
    } catch (error) {
      problems.push(`the footage could not be encoded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (problems.length) throw new Error(`C-tips live lane:\n${problems.join('\n')}`);
}
