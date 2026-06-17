/**
 * Scenario: auth health check.
 *
 * The cheapest meaningful signal — runs on every cron tick. Catches:
 *   - Backend down / unreachable
 *   - Auth flow regression (bootstrapAuth throws or returns no token)
 *   - Wallet derivation regression (UnlockedWallet shape changed,
 *     fingerprint mismatch, etc.)
 *   - User-id round-trip broken
 *
 * Doesn't cost gas. Surfaces both wallets' user_ids in the Discord
 * post so you can sanity-check they're stable across runs.
 */

import type { Scenario } from './types.js';
import { authedApi } from '../lib/api.js';

export const healthCheckScenario: Scenario = {
  name: 'health-check',
  async run(env) {
    const [alice, bob] = await Promise.all([
      authedApi(env.backendUrl, env.alice),
      authedApi(env.backendUrl, env.bob),
    ]);

    const aliceUserId = alice.bootstrap.userId;
    const bobUserId = bob.bootstrap.userId;
    if (!aliceUserId) throw new Error('Alice bootstrap returned no userId');
    if (!bobUserId) throw new Error('Bob bootstrap returned no userId');
    if (aliceUserId === bobUserId) {
      throw new Error(
        `Alice and Bob have the same userId (${aliceUserId}) — wallet derivation collision?`,
      );
    }

    // Surface both userIds in the Discord post (truncated to first 8
    // chars — full UUID isn't useful in a chat alert and adds noise).
    const aliceShort = aliceUserId.slice(0, 8);
    const bobShort = bobUserId.slice(0, 8);
    return {
      context: `alice=${aliceShort}…  bob=${bobShort}…`,
    };
  },
};
