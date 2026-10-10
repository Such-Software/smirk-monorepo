/**
 * C-tips (live): public link tips, claims in another wallet, and clawback,
 * against the real backend with the owner-approved demo wallets.
 *
 *   1. Link tips. Alice tips BTC 3,000 sat, LTC 0.001, XMR 0.001 and WOW 1;
 *      carol makes a GRIN voucher of 0.1. BTC and LTC links are live at once
 *      (masked on screen); XMR, WOW and GRIN hold in "waiting for funding to
 *      confirm" until the backend's gate (10, 4 and about 10 blocks).
 *   2. Claims. Carol claims alice's four links and bob claims carol's voucher,
 *      through Inbox > Paste tip link. The link travels in harness memory (or is
 *      re-read, masked, from the sender's Sent tips) and is typed behind a
 *      redaction card. Each claim shows the swept success screen, the claimer's
 *      balance rises, the sweep report has the coin's txid shape (a GRIN kernel
 *      excess is 33 bytes), XMR and WOW claims report a proven key image, and
 *      every tip settles as claimed on the backend and in the sender's Sent tips.
 *   3. Clawback. Alice makes one BTC and one XMR link tip and reclaims each while
 *      it is pending; the timeline reaches Reclaimed and the funds come back.
 *   4. Rescue and overview. Any link tip of this run that still holds funds
 *      (an earlier step failed) is reclaimed to its sender, then Sent tips must
 *      show every tip of the run, link and npub, in a final state.
 *
 * Every step asserts a real outcome: the backend's public tip record (status,
 * amount, confirmations that only rise), balances on Home, and the wallet's own
 * screens. Funds circulate among alice, bob and carol only. A wallet short of a
 * tip plus fees skips that tip with a top-up reason, which fails the run.
 *
 * Tests are independent: no serial mode. Each reads the tips it needs from the
 * run's ledger, so one failure (which restarts the worker) never strands funds
 * or skips the clawbacks and settles that follow.
 *
 * Run (see C-tips.live.config.ts for every variable):
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 SMOKE_WALLET_FILE=<owner-only demo wallet file> \
 *   npx playwright test -c C-tips.live.config.ts
 */
import { invocationId } from '../../fixtures/C-tips-run.mjs';
import { test, expect, liveGateReason, rescueMode, type TipLane, type WalletName } from '../../fixtures/C-tips-live.js';
import {
  CONFIRMING_ASSETS,
  TICKER,
  claimLink,
  composeTip,
  expectCredited,
  expectDebited,
  expectSentDetail,
  expectSentRow,
  ledgerTip,
  openSentTips,
  pastGate,
  pendingPhase,
  publicTip,
  reclaim,
  rescueTip,
  sentCard,
  showHoldings,
  tipFromLedger,
  waitForLiveLink,
  waitForPublicTip,
  waitForSettled,
  waitForSpendable,
  type CreatedTip,
  type RescueOutcome,
  type TipAsset,
} from '../../fixtures/C-tips-actions.js';
import { SETTLED_STATUSES } from '../../fixtures/C-tips-ledger.js';
import { ASSETS, disabledChains, liveCaps } from '../../fixtures/C-tips-scenario.js';

const GATE = liveGateReason();
test.skip(GATE !== null, GATE ?? 'live lane open');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface LinkPlan {
  key: string;
  sender: WalletName;
  claimer: WalletName;
  asset: TipAsset;
  amount: string;
  expiryDays: 1 | 7 | 30;
  label: string;
}

/** Scenario 1 and 2: who tips what, and who claims it. Amounts are small but well above sweep fees. */
const LINK_TIPS: readonly LinkPlan[] = [
  { key: 'link:alice-btc', sender: 'alice', claimer: 'carol', asset: 'btc', amount: '0.00003', expiryDays: 7, label: 'Alice: BTC 3,000 sat link tip' },
  { key: 'link:alice-ltc', sender: 'alice', claimer: 'carol', asset: 'ltc', amount: '0.001', expiryDays: 1, label: 'Alice: LTC 0.001 link tip' },
  { key: 'link:alice-xmr', sender: 'alice', claimer: 'carol', asset: 'xmr', amount: '0.001', expiryDays: 30, label: 'Alice: XMR 0.001 link tip' },
  { key: 'link:alice-wow', sender: 'alice', claimer: 'carol', asset: 'wow', amount: '1', expiryDays: 7, label: 'Alice: WOW 1 link tip' },
  { key: 'link:carol-grin', sender: 'carol', claimer: 'bob', asset: 'grin', amount: '0.1', expiryDays: 30, label: 'Carol: GRIN 0.1 voucher' },
];

/** Scenario 3: link tips alice takes back while they are pending. */
const RECLAIM_TIPS: readonly Omit<LinkPlan, 'claimer'>[] = [
  { key: 'link:alice-btc-reclaim', sender: 'alice', asset: 'btc', amount: '0.00003', expiryDays: 1, label: 'Alice: BTC tip to reclaim' },
  { key: 'link:alice-xmr-reclaim', sender: 'alice', asset: 'xmr', amount: '0.001', expiryDays: 1, label: 'Alice: XMR tip to reclaim' },
];

const RESCUE_ONLY = 'rescue run: only the rescue and overview tests run';

/** The tip an earlier test created, or a skip naming why it is missing. */
function tipOrSkip(lane: TipLane, key: string): CreatedTip {
  const tip = ledgerTip(lane, key);
  test.skip(!tip, `the ${key} tip was not created in this run (see its create test)`);
  return tip!;
}

/** Create one link tip, prove the sender paid for it, and show its Sent tips row. */
async function createLinkTip(lane: TipLane, plan: Omit<LinkPlan, 'claimer'>): Promise<void> {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.skip((await disabledChains()).has(plan.asset), `${TICKER[plan.asset]} is disabled on this backend`);
  const w = lane.wallet(plan.sender);
  const before = await showHoldings(lane, w, plan.asset, `${TICKER[plan.asset]} balance before the tip`);
  const spendable = await waitForSpendable(lane, w, plan.asset, plan.amount);
  test.skip(
    !spendable,
    `${w.name} holds too little ${TICKER[plan.asset]} for a ${plan.amount} tip plus fees; top up the demo wallet`,
  );
  const tip = await composeTip(lane, w, {
    key: plan.key,
    asset: plan.asset,
    amount: plan.amount,
    expiryDays: plan.expiryDays,
    label: plan.label,
  });
  await expectDebited(lane, w, tip, before);

  const state = (await publicTip(tip.tipId))!;
  // BTC and LTC claim at zero confirmations; the rest wait for the gate.
  if (CONFIRMING_ASSETS.includes(plan.asset)) expect(state.confirmationsRequired).toBeGreaterThan(0);
  await openSentTips(lane, w);
  await expectSentRow(lane, w, tip, state.status);
  await expectSentDetail(lane, w, tip, pendingPhase(state));
}

test('preflight: tips and every chain are advertised, and each wallet shows its balances', async ({ tipLane }) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(45 * MINUTE);
  const caps = await liveCaps();
  expect(caps.features.tips, 'the backend advertises tips').toBe(true);
  const disabled = await disabledChains();
  tipLane.footage.chapter('C-tips: balances before any tip');
  for (const w of [tipLane.alice, tipLane.bob, tipLane.carol]) {
    await showHoldings(tipLane, w, 'btc', `${w.name}: balances on Home`);
    // Every enabled coin has a row with a real figure: a claim must have somewhere to land.
    for (const asset of ASSETS) {
      if (disabled.has(asset)) continue;
      await expect(w.page.getByTestId(`asset-row-${asset}-balance`)).toContainText(/\d/, { timeout: 2 * MINUTE });
    }
  }
});

for (const plan of [...LINK_TIPS, ...RECLAIM_TIPS]) {
  test(`create: ${plan.label}`, async ({ tipLane }) => {
    test.setTimeout(3 * HOUR);
    await createLinkTip(tipLane, plan);
  });
}

test('clawback: alice reclaims the BTC tip while it is pending, and the BTC comes back', async ({ tipLane }) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(2 * HOUR);
  const tip = tipOrSkip(tipLane, 'link:alice-btc-reclaim');
  // Pending once the backend has verified the funding (BTC needs no confirmations).
  await waitForPublicTip(tip.tipId, pastGate, 30 * MINUTE, 'verified funding');
  const before = await showHoldings(tipLane, tipLane.alice, 'btc', 'BTC balance before the reclaim');
  await reclaim(tipLane, tip);
  await expectCredited(tipLane, tipLane.alice, tip, before, 'BTC returned by the reclaim');
});

for (const plan of LINK_TIPS.filter((p) => !CONFIRMING_ASSETS.includes(p.asset))) {
  test(`claim: ${plan.claimer} claims the ${TICKER[plan.asset]} link at once`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(2 * HOUR);
    const tip = tipOrSkip(tipLane, plan.key);
    // BTC and LTC normally claim at zero confirmations; wait out any gate the backend sets.
    await waitForPublicTip(tip.tipId, pastGate, 90 * MINUTE, 'its confirmation gate');
    const claimer = tipLane.wallet(plan.claimer);
    const before = await showHoldings(tipLane, claimer, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    await claimLink(tipLane, claimer, tip);
    await expectCredited(tipLane, claimer, tip, before, `${TICKER[plan.asset]} received from the link`);
    expect(['claiming', 'claimed']).toContain((await publicTip(tip.tipId))?.status);
  });
}

for (const plan of [...LINK_TIPS, ...RECLAIM_TIPS].filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`confirm: the ${plan.label} goes live once funding passes the gate`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(4 * HOUR);
    const tip = tipOrSkip(tipLane, plan.key);
    await waitForLiveLink(tipLane, tip, 150 * MINUTE);
    expect(tipLane.links.has(tip.tipId), 'the confirmed link was read into memory').toBe(true);
  });
}

for (const plan of LINK_TIPS.filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`claim: ${plan.claimer} claims the confirmed ${TICKER[plan.asset]} link`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(tipLane, plan.key);
    const state = await publicTip(tip.tipId);
    test.skip(!state || !pastGate(state), 'the link never went live (see its confirm test)');
    const claimer = tipLane.wallet(plan.claimer);
    const before = await showHoldings(tipLane, claimer, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    await claimLink(tipLane, claimer, tip);
    await expectCredited(tipLane, claimer, tip, before, `${TICKER[plan.asset]} received from the link`);
  });
}

test('clawback: alice reclaims the confirmed XMR tip while it is pending, and the XMR comes back', async ({ tipLane }) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(3 * HOUR);
  const tip = tipOrSkip(tipLane, 'link:alice-xmr-reclaim');
  // A restarted worker may reach this before the gate: an XMR sweep needs the funding confirmed.
  await waitForPublicTip(tip.tipId, pastGate, 150 * MINUTE, 'its confirmation gate');
  const before = await showHoldings(tipLane, tipLane.alice, 'xmr', 'XMR balance before the reclaim');
  await reclaim(tipLane, tip);
  await expectCredited(tipLane, tipLane.alice, tip, before, 'XMR returned by the reclaim');
});

for (const plan of LINK_TIPS) {
  test(`settle: the ${plan.label} reads claimed on the backend and in Sent tips`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(tipLane, plan.key);
    const state = await publicTip(tip.tipId);
    test.skip(state?.status === 'pending' || state?.status === 'pending_confirmation', 'this link was never claimed (see its claim test)');
    // The backend settles once the chain bears the sweep out at depth.
    await waitForSettled(tip, 'claimed', 150 * MINUTE);
    await openSentTips(tipLane, tip.sender);
    await expectSentRow(tipLane, tip.sender, tip, 'claimed');
    await expectSentDetail(tipLane, tip.sender, tip, 'claimed');
  });
}

test('rescue: no link tip of this run still holds funds; any that does goes back to its sender', async ({ tipLane }) => {
  test.setTimeout(8 * HOUR);
  // A rescue run settles every tip the run's earlier invocations left behind.
  const records = rescueMode() ? tipLane.ledger.tips() : tipLane.ledger.tips('link:');
  test.skip(records.length === 0, 'no tip was created in this run');
  const outcomes: RescueOutcome[] = [];
  for (const record of records) outcomes.push(await rescueTip(tipLane, tipFromLedger(tipLane, record)));
  for (const o of outcomes.filter((x) => x.action !== 'already settled')) {
    test.info().annotations.push({ type: 'rescue', description: `${o.key} (${o.asset}, from ${o.sender}): ${o.action}, ${o.status}` });
  }
  expect(
    outcomes.filter((o) => o.action === 'failed').map((o) => `${o.key}: ${o.status}`),
    'tips that still hold funds; RECOVERY.md in the run state directory has the rescue command',
  ).toEqual([]);
});

test('overview: Sent tips shows every tip of this run in a final state', async ({ tipLane }) => {
  test.setTimeout(2 * HOUR);
  const records = tipLane.ledger.tips().filter((t) => rescueMode() || t.invocation === invocationId());
  test.skip(records.length === 0, 'no tip was created in this run');
  for (const sender of [...new Set(records.map((t) => t.sender))]) {
    const w = tipLane.wallet(sender);
    tipLane.footage.chapter(`${sender}: Sent tips overview`);
    await openSentTips(tipLane, w);
    for (const record of records.filter((t) => t.sender === sender)) {
      const tip = tipFromLedger(tipLane, record);
      const state = (await publicTip(tip.tipId))!;
      // Claimed or reclaimed, nothing left pending: the run left no funds behind.
      expect(SETTLED_STATUSES.has(state.status), `${record.key} is settled`).toBe(true);
      await sentCard(w, tip).scrollIntoViewIfNeeded();
      await expectSentRow(tipLane, w, tip, state.status);
    }
  }
});
