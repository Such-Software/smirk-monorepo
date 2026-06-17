/**
 * Common types for smoke scenarios.
 *
 * Every scenario implements `Scenario`; the runner dispatches them
 * sequentially, collecting per-scenario timing + pass/fail + an
 * optional context string for the Discord summary.
 */

import type { UnlockedWallet } from '@smirk/core';

export interface ScenarioEnv {
  backendUrl: string;
  alice: UnlockedWallet;
  bob: UnlockedWallet;
  /** Optional dry-run flag — scenarios that broadcast on-chain txs
   *  should respect this and short-circuit to a no-op when set.
   *  Useful for local development against production without
   *  burning fees. */
  dryRun: boolean;
}

export interface ScenarioResult {
  /** Free-form text appended to the Discord post; primarily used
   *  by health-check to surface balances. Optional. */
  context?: string;
}

export interface Scenario {
  /** Short stable name used in the Discord post and in logs. */
  name: string;
  /** Run the scenario. Throw to signal failure; return normally
   *  (with optional context) to signal success. */
  run(env: ScenarioEnv): Promise<ScenarioResult | void>;
}
