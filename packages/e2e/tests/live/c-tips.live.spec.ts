/**
 * C-tips (live): public link tips, claims in another wallet, and clawback,
 * against the real backend with the owner-approved demo wallets.
 *
 *   1. Link tips. Alice tips BTC 3,000 sat, LTC 0.01, XMR 0.005 and WOW 1;
 *      carol makes a GRIN voucher of 1. BTC and LTC links are live at once
 *      (masked on screen); XMR, WOW and GRIN hold in "waiting for funding to
 *      confirm" until the backend's gate (10, 4 and about 10 blocks).
 *   2. Claims. Carol claims alice's four links and bob claims carol's voucher,
 *      through Inbox > Paste tip link. The link travels in harness memory and is
 *      typed behind a redaction card. Each claim shows the swept success screen,
 *      the claimer's balance rises, XMR and WOW claims report a proven key image,
 *      and every tip settles as claimed on the backend and in the sender's
 *      Sent tips (row and detail timeline).
 *   3. Clawback. Alice makes one BTC and one XMR link tip and reclaims each while
 *      it is pending; the timeline reaches Reclaimed and the funds come back.
 *
 * Every step asserts a real outcome: the backend's public tip record (status,
 * amount, confirmations that only rise), balances on Home, and the wallet's own
 * screens. Funds circulate among alice, bob and carol only. A wallet short of a
 * tip plus fees skips that tip with the reason, never fails it.
 *
 * Run (one worker; the lane imports the three wallets once per worker):
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked release Chrome zip> \
 *   SMOKE_WALLET_FILE=<owner-only demo wallet file> \
 *   npx playwright test tests/live/c-tips.live.spec.ts
 * Budget about two hours; the confirmation waits dominate.
 */
import { test, expect, liveGateReason, type TipLane, type WalletName } from '../../fixtures/C-tips-live.js';
import {
  CONFIRMING_ASSETS,
  TICKER,
  composeTip,
  expectCredited,
  expectDebited,
  expectSentDetail,
  expectSentRow,
  openSentTips,
  publicTip,
  reclaim,
  sentCard,
  showHoldings,
  waitForLiveLink,
  waitForPublicTip,
  waitForSettled,
  waitForSpendable,
  claimLink,
  pendingPhase,
  type CreatedTip,
  type TipAsset,
} from '../../fixtures/C-tips-actions.js';
import { getCapabilities } from '../../fixtures/capabilities.js';

const GATE = liveGateReason();
test.skip(GATE !== null, GATE ?? 'live lane open');
test.describe.configure({ mode: 'serial' });

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

/** Scenario 1 and 2: who tips what, and who claims it. */
const LINK_TIPS: readonly LinkPlan[] = [
  { key: 'alice-btc', sender: 'alice', claimer: 'carol', asset: 'btc', amount: '0.00003', expiryDays: 7, label: 'Alice: BTC 3,000 sat link tip' },
  { key: 'alice-ltc', sender: 'alice', claimer: 'carol', asset: 'ltc', amount: '0.01', expiryDays: 1, label: 'Alice: LTC 0.01 link tip' },
  { key: 'alice-xmr', sender: 'alice', claimer: 'carol', asset: 'xmr', amount: '0.005', expiryDays: 30, label: 'Alice: XMR 0.005 link tip' },
  { key: 'alice-wow', sender: 'alice', claimer: 'carol', asset: 'wow', amount: '1', expiryDays: 7, label: 'Alice: WOW 1 link tip' },
  { key: 'carol-grin', sender: 'carol', claimer: 'bob', asset: 'grin', amount: '1', expiryDays: 30, label: 'Carol: GRIN 1 voucher' },
];

/** Scenario 3: link tips alice takes back while they are pending. */
const RECLAIM_TIPS: readonly Omit<LinkPlan, 'claimer'>[] = [
  { key: 'alice-btc-reclaim', sender: 'alice', asset: 'btc', amount: '0.00003', expiryDays: 1, label: 'Alice: BTC tip to reclaim' },
  { key: 'alice-xmr-reclaim', sender: 'alice', asset: 'xmr', amount: '0.005', expiryDays: 1, label: 'Alice: XMR tip to reclaim' },
];

const created = new Map<string, CreatedTip>();
const disabledChains = new Set<TipAsset>();

function tipOrSkip(key: string): CreatedTip {
  const tip = created.get(key);
  test.skip(!tip, `the ${key} tip was not created earlier in this run (see its skip reason)`);
  return tip!;
}

/** Create one link tip, prove the sender paid for it, and show its Sent tips row. */
async function createLinkTip(lane: TipLane, plan: Omit<LinkPlan, 'claimer'>): Promise<void> {
  test.skip(disabledChains.has(plan.asset), `${TICKER[plan.asset]} is disabled on this backend`);
  const w = lane.wallet(plan.sender);
  const before = await showHoldings(lane, w, plan.asset, `${TICKER[plan.asset]} balance before the tip`);
  const spendable = await waitForSpendable(lane, w, plan.asset, plan.amount);
  test.skip(
    !spendable,
    `${w.name} holds too little ${TICKER[plan.asset]} for a ${plan.amount} tip plus fees; top up the demo wallet`,
  );
  const tip = await composeTip(lane, w, {
    asset: plan.asset,
    amount: plan.amount,
    expiryDays: plan.expiryDays,
    label: plan.label,
  });
  created.set(plan.key, tip);
  await expectDebited(lane, w, tip, before);

  const state = (await publicTip(tip.tipId))!;
  // BTC and LTC claim at zero confirmations; the rest wait for the gate.
  if (CONFIRMING_ASSETS.includes(plan.asset)) expect(state.confirmationsRequired).toBeGreaterThan(0);
  await openSentTips(lane, w);
  await expectSentRow(lane, w, tip, state.status);
  await expectSentDetail(lane, w, tip, pendingPhase(state));
}

test('preflight: tips and every chain are advertised, and each wallet shows its balances', async ({ tipLane }) => {
  test.setTimeout(30 * MINUTE);
  const caps = await getCapabilities();
  expect(caps.features.tips, 'the backend advertises tips').toBe(true);
  for (const asset of ['btc', 'ltc', 'xmr', 'wow', 'grin'] as const) {
    if (!caps.chains[asset]?.enabled) disabledChains.add(asset);
  }
  tipLane.footage.chapter('C-tips: balances before any tip');
  for (const w of [tipLane.alice, tipLane.bob, tipLane.carol]) {
    await showHoldings(tipLane, w, 'btc', `${w.name}: balances on Home`);
    // Every enabled coin has a row with a real figure: a claim must have somewhere to land.
    for (const asset of ['btc', 'ltc', 'xmr', 'wow', 'grin'] as const) {
      if (disabledChains.has(asset)) continue;
      await expect(w.page.getByTestId(`asset-row-${asset}-balance`)).toContainText(/\d/, { timeout: 2 * MINUTE });
    }
  }
});

for (const plan of LINK_TIPS) {
  test(`create: ${plan.label}`, async ({ tipLane }) => {
    test.setTimeout(90 * MINUTE);
    await createLinkTip(tipLane, plan);
  });
}

for (const plan of RECLAIM_TIPS) {
  test(`create: ${plan.label}`, async ({ tipLane }) => {
    test.setTimeout(90 * MINUTE);
    await createLinkTip(tipLane, plan);
  });
}

test('clawback: alice reclaims the BTC tip while it is pending, and the BTC comes back', async ({ tipLane }) => {
  test.setTimeout(90 * MINUTE);
  const tip = tipOrSkip('alice-btc-reclaim');
  const before = await showHoldings(tipLane, tipLane.alice, 'btc', 'BTC balance before the reclaim');
  await reclaim(tipLane, tip);
  await expectCredited(tipLane, tipLane.alice, tip, before, 'BTC returned by the reclaim');
});

for (const plan of LINK_TIPS.filter((p) => !CONFIRMING_ASSETS.includes(p.asset))) {
  test(`claim: ${plan.claimer} claims the ${TICKER[plan.asset]} link at once`, async ({ tipLane }) => {
    test.setTimeout(90 * MINUTE);
    const tip = tipOrSkip(plan.key);
    // BTC and LTC normally claim at zero confirmations; wait out any gate the backend sets.
    await waitForPublicTip(
      tip.tipId,
      (s) => s.fundingConfirmations >= s.confirmationsRequired && s.status === 'pending',
      90 * MINUTE,
      'its confirmation gate',
    );
    const claimer = tipLane.wallet(plan.claimer);
    const before = await showHoldings(tipLane, claimer, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    await claimLink(tipLane, claimer, tip);
    await expectCredited(tipLane, claimer, tip, before, `${TICKER[plan.asset]} received from the link`);
    const state = await publicTip(tip.tipId);
    expect(['claiming', 'claimed']).toContain(state?.status);
  });
}

for (const plan of [...LINK_TIPS, ...RECLAIM_TIPS].filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`confirm: the ${plan.label} goes live once funding passes the gate`, async ({ tipLane }) => {
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(plan.key);
    await waitForLiveLink(tipLane, tip, 150 * MINUTE);
    expect(tip.link, 'the confirmed link was read into memory').not.toBeNull();
  });
}

for (const plan of LINK_TIPS.filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`claim: ${plan.claimer} claims the confirmed ${TICKER[plan.asset]} link`, async ({ tipLane }) => {
    test.setTimeout(2 * HOUR);
    const tip = tipOrSkip(plan.key);
    test.skip(!tip.link, 'the link never went live (see the confirm step)');
    const claimer = tipLane.wallet(plan.claimer);
    const before = await showHoldings(tipLane, claimer, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    await claimLink(tipLane, claimer, tip);
    await expectCredited(tipLane, claimer, tip, before, `${TICKER[plan.asset]} received from the link`);
  });
}

test('clawback: alice reclaims the confirmed XMR tip while it is pending, and the XMR comes back', async ({ tipLane }) => {
  test.setTimeout(2 * HOUR);
  const tip = tipOrSkip('alice-xmr-reclaim');
  const state = await publicTip(tip.tipId);
  test.skip(state?.status !== 'pending', 'the XMR tip never reached its confirmation gate (see the confirm step)');
  const before = await showHoldings(tipLane, tipLane.alice, 'xmr', 'XMR balance before the reclaim');
  await reclaim(tipLane, tip);
  await expectCredited(tipLane, tipLane.alice, tip, before, 'XMR returned by the reclaim');
});

for (const plan of LINK_TIPS) {
  test(`settle: the ${plan.label} reads claimed on the backend and in Sent tips`, async ({ tipLane }) => {
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(plan.key);
    const state = await publicTip(tip.tipId);
    test.skip(state?.status === 'pending' || state?.status === 'pending_confirmation', 'this link was never claimed');
    // The backend settles once the chain bears the sweep out at depth.
    await waitForSettled(tip, 'claimed', 150 * MINUTE);
    const sender = tip.sender;
    await openSentTips(tipLane, sender);
    await expectSentRow(tipLane, sender, tip, 'claimed');
    await expectSentDetail(tipLane, sender, tip, 'claimed');
  });
}

test('overview: Settings > Sent tips lists every tip from this run with its final status', async ({ tipLane }) => {
  test.setTimeout(60 * MINUTE);
  test.skip(created.size === 0, 'no tip was created in this run');
  for (const name of ['alice', 'carol'] as const) {
    const w = tipLane.wallet(name);
    const mine = [...created.values()].filter((t) => t.sender.name === name);
    if (mine.length === 0) continue;
    tipLane.footage.chapter(`${name}: Sent tips overview`);
    await openSentTips(tipLane, w);
    for (const tip of mine) {
      const state = (await publicTip(tip.tipId))!;
      expect(['claimed', 'clawed_back', 'claiming', 'pending', 'pending_confirmation']).toContain(state.status);
      await sentCard(w, tip).scrollIntoViewIfNeeded();
      await expectSentRow(tipLane, w, tip, state.status);
    }
  }
});
