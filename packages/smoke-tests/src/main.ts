/**
 * Smoke runner entrypoint.
 *
 * Reads config from env, boots the two test wallets, dispatches each
 * registered scenario in order, posts a single Discord summary.
 *
 * Exit code: 0 if every scenario passed, 1 if any failed. Cron
 * captures exit codes for the systemd timer's `OnFailure=` hook (if
 * the user wires one), but the primary alert signal is the Discord
 * post — the runner never throws past the top-level catch so the
 * post always lands even when scenarios blow up unexpectedly.
 */

import { unlockedWalletFromMnemonic } from './lib/wallet.js';
import { notifyDiscord, type NotifyResult } from './lib/notify.js';
import type { Scenario, ScenarioEnv, ScenarioResult } from './scenarios/types.js';

import { healthCheckScenario } from './scenarios/health-check.js';
import { tipDraftCycleScenario } from './scenarios/tip-draft-cycle.js';

const SCENARIOS: ReadonlyArray<Scenario> = [
  healthCheckScenario,
  tipDraftCycleScenario,
];

interface Config {
  backendUrl: string;
  aliceMnemonic: string;
  bobMnemonic: string;
  discordWebhookUrl: string | undefined;
  dryRun: boolean;
}

function readConfig(): Config {
  const backendUrl = process.env.SMOKE_BACKEND_URL;
  const aliceMnemonic = process.env.SMOKE_ALICE_MNEMONIC;
  const bobMnemonic = process.env.SMOKE_BOB_MNEMONIC;
  if (!backendUrl) throw new Error('SMOKE_BACKEND_URL is required');
  if (!aliceMnemonic) throw new Error('SMOKE_ALICE_MNEMONIC is required');
  if (!bobMnemonic) throw new Error('SMOKE_BOB_MNEMONIC is required');
  return {
    backendUrl,
    aliceMnemonic,
    bobMnemonic,
    discordWebhookUrl: process.env.SMOKE_DISCORD_WEBHOOK_URL,
    dryRun: process.env.SMOKE_DRY_RUN === '1' || process.env.SMOKE_DRY_RUN === 'true',
  };
}

async function main(): Promise<number> {
  const config = readConfig();
  const env: ScenarioEnv = {
    backendUrl: config.backendUrl,
    alice: unlockedWalletFromMnemonic(config.aliceMnemonic),
    bob: unlockedWalletFromMnemonic(config.bobMnemonic),
    dryRun: config.dryRun,
  };

  const rows: NotifyResult['scenarios'][number][] = [];
  let lastContext: string | undefined;

  for (const scenario of SCENARIOS) {
    const started = Date.now();
    try {
      const out: ScenarioResult | void = await scenario.run(env);
      const durationMs = Date.now() - started;
      rows.push({ name: scenario.name, ok: true, durationMs });
      if (out && out.context) {
        // Surface the last context string in the summary (health-check
        // sets balances; future scenarios may surface tip ids etc).
        lastContext = out.context;
      }
      console.log(`[smoke] ✓ ${scenario.name} (${(durationMs / 1000).toFixed(1)}s)`);
    } catch (e) {
      const durationMs = Date.now() - started;
      const error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      rows.push({ name: scenario.name, ok: false, durationMs, error });
      console.error(`[smoke] ✗ ${scenario.name} (${(durationMs / 1000).toFixed(1)}s):`, e);
    }
  }

  const result: NotifyResult = {
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    scenarios: rows,
    ...(lastContext ? { context: lastContext } : {}),
  };
  await notifyDiscord(config.discordWebhookUrl, result);

  return result.passed === result.total ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    // Last-resort guard. Should never fire because the per-scenario
    // try/catch swallows everything; if it does, the Discord post
    // didn't happen so log loudly + exit 1.
    console.error('[smoke] runner crashed:', e);
    process.exit(1);
  });
