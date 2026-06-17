/**
 * Scenario: tip-draft-cycle.
 *
 * Phase 1 of the wallet-to-wallet harness — exercises the tip
 * state machine WITHOUT broadcasting an on-chain funding tx. This
 * is the cheapest possible end-to-end signal that catches:
 *
 *   - Auth flow regressions (extensionRegister, is_returning_user
 *     bypass).
 *   - createSocialTip + the `encrypted_key` size cap shipped in
 *     the 2026-06-13 audit.
 *   - The draft → cancelled state transition + the lifecycle CHECK
 *     constraint.
 *   - getSentSocialTips status reflection (would catch the kind of
 *     "UI says X, backend says Y" drift that surfaced as ship-
 *     blocker T1 / T2 in the tip audit).
 *
 * Phase 2 (later session) adds the funded variant: actually broadcast
 * BTC to the tip_address + attachSocialTipFunding + verifier path +
 * Bob claims. That exercises the audit's full ship-blocker matrix
 * but burns chain fees on every run.
 *
 * Idempotency: every run creates a NEW tip and immediately cancels
 * it. Stale drafts get GC'd to `cancelled` by `tip_draft_gc` after
 * 7 days (audit T4) even if a smoke run dies mid-flight.
 */

import type { Scenario } from './types.js';
import { authedApi } from '../lib/api.js';

/** Cap is 4096 hex chars (= 2048 binary bytes) on the backend post
 *  audit deferred #12. Sending well under so a CHECK regression
 *  (extension shrinks vs backend tightens) doesn't tip us over by
 *  accident. */
const DUMMY_ENCRYPTED_KEY_HEX = 'a'.repeat(64); // 32 bytes — typical AES-GCM blob size

/** Smoke amount: 1000 sat. Never broadcast, never claimable; serves
 *  only as a non-zero amount the backend can persist. */
const SMOKE_AMOUNT_SATS = 1000;

export const tipDraftCycleScenario: Scenario = {
  name: 'tip-draft-cycle',
  async run(env) {
    const alice = await authedApi(env.backendUrl, env.alice);
    const aliceApi = alice.api;

    // Alice's own BTC address — plausible tip_address (we never
    // actually broadcast to it, but the backend's
    // validate_tip_address gate runs on create).
    const tipAddress = env.alice.addresses.btc;
    if (!tipAddress) {
      throw new Error('Alice has no BTC address — wallet derivation regression?');
    }

    // 1. Create a public-tip draft.
    const created = await aliceApi.createSocialTip({
      asset: 'btc',
      amount: SMOKE_AMOUNT_SATS,
      is_public: true,
      encrypted_key: DUMMY_ENCRYPTED_KEY_HEX,
      tip_address: tipAddress,
      // claim_key_hash is required for public tips so the backend
      // can verify the URL-fragment-derived key on claim. Some
      // 32-byte sentinel works for a draft we'll immediately
      // cancel — the value is never consumed because no claimer
      // will ever present it.
      claim_key_hash: 'b'.repeat(64),
      sender_anonymous: true,
    });
    if (created.error || !created.data) {
      throw new Error(`createSocialTip: ${created.error ?? 'no data'}`);
    }
    const tipId = created.data.tip_id;
    if (!tipId) {
      throw new Error('createSocialTip returned no tip_id');
    }
    if (created.data.status !== 'draft') {
      throw new Error(
        `createSocialTip status was ${created.data.status}, expected 'draft' (TipStatus drift?)`,
      );
    }

    // 2. Confirm it surfaces in getSentSocialTips as a draft.
    const sentAfterCreate = await aliceApi.getSentSocialTips();
    if (sentAfterCreate.error || !sentAfterCreate.data) {
      throw new Error(`getSentSocialTips after create: ${sentAfterCreate.error ?? 'no data'}`);
    }
    const found = sentAfterCreate.data.tips.find((t: { id: string }) => t.id === tipId);
    if (!found) {
      throw new Error(`Just-created tip ${tipId} not present in getSentSocialTips`);
    }
    if (found.status !== 'draft') {
      throw new Error(
        `Sent-tip list reports status=${found.status}, expected 'draft' (T1/T2 drift signal)`,
      );
    }
    if (found.amount !== SMOKE_AMOUNT_SATS) {
      throw new Error(
        `Sent-tip list reports amount=${found.amount}, expected ${SMOKE_AMOUNT_SATS} (Number-precision regression?)`,
      );
    }

    // 3. Cancel the draft.
    const cancelled = await aliceApi.cancelSocialTip(tipId);
    if (cancelled.error || !cancelled.data?.ok) {
      throw new Error(`cancelSocialTip: ${cancelled.error ?? 'ok=false'}`);
    }

    // 4. Confirm the row transitions to 'cancelled' in the sent-tips
    //    list. This is the audit-T-deferred-#26 (status CHECK
    //    constraint) tripwire — if the migration didn't apply, the
    //    cancel UPDATE either fails or the status string drifts.
    const sentAfterCancel = await aliceApi.getSentSocialTips();
    if (sentAfterCancel.error || !sentAfterCancel.data) {
      throw new Error(
        `getSentSocialTips after cancel: ${sentAfterCancel.error ?? 'no data'}`,
      );
    }
    const post = sentAfterCancel.data.tips.find((t: { id: string }) => t.id === tipId);
    if (!post) {
      throw new Error(
        `Cancelled tip ${tipId} disappeared from getSentSocialTips (should still be visible until pruned)`,
      );
    }
    if (post.status !== 'cancelled') {
      throw new Error(
        `Post-cancel status=${post.status}, expected 'cancelled' (TipStatus.Cancelled drift)`,
      );
    }
  },
};
