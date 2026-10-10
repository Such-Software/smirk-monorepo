/**
 * C-tips (live): tips to an npub, their Inbox delivery and claims, and the
 * Inbox's refusal of forged gift wraps.
 *
 *   1. Npub tips. Alice tips bob's npub XMR 0.005, WOW 1, BTC 3,000 sat and
 *      LTC 0.01; carol tips bob GRIN 0.5. When bob has a verified handle, the
 *      LTC tip goes to name@domain instead. Each composer shows the submit
 *      button naming the recipient, a message, and a 1, 7 or 30 day reclaim date.
 *   2. Bob's Inbox shows each tip with the sender's short npub, the exact message
 *      and the claim-by date; XMR, WOW and GRIN wait for confirmations first. Bob
 *      claims each; his balance rises and XMR/WOW claims report a proven key
 *      image. The sender's Sent tips row shows recipient, status and reclaim
 *      date, and its detail timeline ends at Claimed.
 *   3. Forged wraps. A Node-side harness (fixtures/nostr-forge.ts) publishes two
 *      kind-1059 gift wraps to bob with PoW from burner keys: one reuses a real
 *      tip id with a wrong claim key, one names an unknown tip id. Bob's Inbox
 *      shows neither, and the genuine tip keeps its real sender and message.
 *   4. Optional (E2E_LIVE_DELIVERY_FAILURE=1): a person tip whose delivery the
 *      harness blocks is still funded, shows the warning and the fallback link
 *      (masked), and bob claims it through that link.
 *
 * The forge publishes only to the first-party relay the backend under test
 * advertises, and only behind the live lane's write gates.
 *
 * Run with the same environment as c-tips.live.spec.ts. Budget about two hours.
 */
import {
  test,
  expect,
  liveGateReason,
  shortNpubFromHex,
  type LiveWallet,
  type WalletName,
} from '../../fixtures/C-tips-live.js';
import {
  CONFIRMING_ASSETS,
  TICKER,
  claimFromInbox,
  claimLink,
  composeTip,
  expectConfirmationsRose,
  expectCredited,
  expectDebited,
  expectInboxTip,
  expectSentDetail,
  expectSentRow,
  openInbox,
  openSentTips,
  pendingPhase,
  publicTip,
  refreshInbox,
  showHoldings,
  waitForPublicTip,
  waitForSettled,
  waitForSpendable,
  type CreatedTip,
  type TipAsset,
} from '../../fixtures/C-tips-actions.js';
import { getCapabilities } from '../../fixtures/capabilities.js';
import { isLocalPublishRelay } from '../../fixtures/relay-guard.js';
import { FORGE_POW_BITS, forgeTipWrap, publishWrap, wrapPow, type ForgedTipWrap } from '../../fixtures/nostr-forge.js';

const GATE = liveGateReason();
test.skip(GATE !== null, GATE ?? 'live lane open');
test.describe.configure({ mode: 'serial' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface NpubPlan {
  key: string;
  sender: WalletName;
  asset: TipAsset;
  amount: string;
  expiryDays: 1 | 7 | 30;
  memo: string;
  /** Address this one to bob's handle when he has a verified one. */
  viaHandle?: boolean;
  label: string;
}

/** Messages are static strings: the Inbox must show them exactly. */
const NPUB_TIPS: readonly NpubPlan[] = [
  { key: 'xmr', sender: 'alice', asset: 'xmr', amount: '0.005', expiryDays: 1, memo: 'C-tips live: XMR for bob', label: 'Alice: XMR 0.005 to bob' },
  { key: 'wow', sender: 'alice', asset: 'wow', amount: '1', expiryDays: 7, memo: 'C-tips live: WOW for bob', label: 'Alice: WOW 1 to bob' },
  { key: 'btc', sender: 'alice', asset: 'btc', amount: '0.00003', expiryDays: 30, memo: 'C-tips live: BTC for bob', label: 'Alice: BTC 3,000 sat to bob' },
  { key: 'ltc', sender: 'alice', asset: 'ltc', amount: '0.01', expiryDays: 7, memo: 'C-tips live: LTC for bob', viaHandle: true, label: 'Alice: LTC 0.01 to bob' },
  { key: 'grin', sender: 'carol', asset: 'grin', amount: '0.5', expiryDays: 30, memo: 'C-tips live: GRIN for bob', label: 'Carol: GRIN 0.5 to bob' },
];

/** Markers only a forged wrap carries; the Inbox must never show them. */
const FORGED_REUSED_MEMO = 'C-tips forged: reused tip id';
const FORGED_UNKNOWN_MEMO = 'C-tips forged: unknown tip id';

const created = new Map<string, CreatedTip>();
const forged: ForgedTipWrap[] = [];
let relayUrl: string | null = null;
let relayPowBits = FORGE_POW_BITS;
let disabledChains = new Set<TipAsset>();
/** Bob's handle, when NIP-05 resolves it to his active key. */
let bobHandle: string | null = null;

function tipOrSkip(key: string): CreatedTip {
  const tip = created.get(key);
  test.skip(!tip, `the ${key} npub tip was not created earlier in this run (see its skip reason)`);
  return tip!;
}

/** NIP-05 must resolve the handle to bob's active key, or the tip would go elsewhere. */
async function verifiedHandle(bob: LiveWallet): Promise<string | null> {
  if (!bob.handle) return null;
  const [name, domain] = bob.handle.split('@');
  try {
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name!)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { names?: Record<string, string> };
    return body.names?.[name!]?.toLowerCase() === bob.pubkeyHex ? bob.handle : null;
  } catch {
    return null;
  }
}

/** The forge may write only to the backend's own relay, and a shared one only behind the gates. */
function forgeTargetReason(relay: string | null): string | null {
  if (!relay) return 'the backend advertises no first-party relay';
  if (!isLocalPublishRelay(relay) && (process.env.E2E_LIVE !== '1' || process.env.ALLOW_PROD_WRITES !== '1')) {
    return `relay ${relay} is shared: publishing forged wraps needs E2E_LIVE=1 and ALLOW_PROD_WRITES=1`;
  }
  return null;
}

test('preflight: tips and a first-party relay are advertised; every wallet shows its balances', async ({ tipLane }) => {
  test.setTimeout(30 * MINUTE);
  const caps = await getCapabilities();
  expect(caps.features.tips, 'the backend advertises tips').toBe(true);
  const messaging = (caps as unknown as { messaging?: { relay_url?: string; inbound_pow_bits?: number } }).messaging;
  relayUrl = messaging?.relay_url ?? null;
  relayPowBits = Math.max(FORGE_POW_BITS, messaging?.inbound_pow_bits ?? 0);
  // An npub tip's claim key travels by gift wrap: without a relay none can be delivered.
  expect(relayUrl, 'the backend advertises a first-party relay for gift wraps').toMatch(/^wss?:\/\//);
  disabledChains = new Set((['btc', 'ltc', 'xmr', 'wow', 'grin'] as const).filter((a) => !caps.chains[a]?.enabled));
  bobHandle = await verifiedHandle(tipLane.bob);
  tipLane.footage.chapter('C-tips: npub tips, balances before');
  for (const w of [tipLane.alice, tipLane.bob, tipLane.carol]) {
    await showHoldings(tipLane, w, 'btc', `${w.name}: balances on Home`);
  }
});

for (const plan of NPUB_TIPS) {
  test(`send: ${plan.label}, with a message and a reclaim date`, async ({ tipLane }) => {
    test.setTimeout(90 * MINUTE);
    test.skip(disabledChains.has(plan.asset), `${TICKER[plan.asset]} is disabled on this backend`);
    const w = tipLane.wallet(plan.sender);
    const bob = tipLane.bob;
    const handle = plan.viaHandle ? bobHandle : null;
    if (plan.viaHandle && !handle) {
      test.info().annotations.push({
        type: 'handle',
        description: 'bob has no verified handle resolving to his key; this tip goes to his npub',
      });
    }
    const before = await showHoldings(tipLane, w, plan.asset, `${TICKER[plan.asset]} balance before the tip`);
    const spendable = await waitForSpendable(tipLane, w, plan.asset, plan.amount);
    test.skip(
      !spendable,
      `${w.name} holds too little ${TICKER[plan.asset]} for a ${plan.amount} tip plus fees; top up the demo wallet`,
    );
    const tip = await composeTip(tipLane, w, {
      asset: plan.asset,
      amount: plan.amount,
      recipient: { wallet: bob, text: handle ?? bob.npub, display: handle ?? bob.shortNpub },
      memo: plan.memo,
      expiryDays: plan.expiryDays,
      label: plan.label,
    });
    created.set(plan.key, tip);
    await expectDebited(tipLane, w, tip, before);

    // The sender's row: recipient, status and reclaim date, and the details.
    const state = (await publicTip(tip.tipId))!;
    await openSentTips(tipLane, w);
    await expectSentRow(tipLane, w, tip, state.status);
    await expectSentDetail(tipLane, w, tip, pendingPhase(state));
  });
}

test('forge: burner gift wraps reusing a real tip id and naming an unknown one are published to bob', async ({
  tipLane,
}) => {
  test.setTimeout(20 * MINUTE);
  const reason = forgeTargetReason(relayUrl);
  test.skip(reason !== null, reason ?? '');
  const real = created.get('btc') ?? created.get('ltc') ?? [...created.values()][0];
  test.skip(!real, 'no genuine npub tip exists to impersonate');
  const record = await publicTip(real!.tipId);
  expect(record?.encryptedKey, 'the genuine tip has a sealed key on the backend').toBeTruthy();

  tipLane.footage.chapter('Forged gift wraps published to bob');
  const bob = tipLane.bob;
  forged.push(
    forgeTipWrap({
      recipientPubkeyHex: bob.pubkeyHex,
      kind: 'reused-tip-id',
      tipId: real!.tipId,
      encryptedKeyHex: record!.encryptedKey,
      asset: real!.asset,
      amount: Number(real!.amountAtomic) * 1000,
      memo: FORGED_REUSED_MEMO,
      powBits: relayPowBits,
    }),
    forgeTipWrap({
      recipientPubkeyHex: bob.pubkeyHex,
      kind: 'unknown-tip-id',
      asset: 'xmr',
      amount: 500_000_000_000,
      memo: FORGED_UNKNOWN_MEMO,
      powBits: relayPowBits,
    }),
  );
  for (const wrap of forged) {
    expect(wrap.event.kind).toBe(1059);
    expect(wrapPow(wrap.event)).toBeGreaterThanOrEqual(relayPowBits);
    const result = await publishWrap(relayUrl!, wrap.event);
    // A refusal would make the Inbox check vacuous: report the relay's reason.
    expect(result.accepted, `the relay refused the ${wrap.kind} wrap: ${result.message}`).toBe(true);
  }
  expect(await publicTip(forged[1]!.tipId), 'the unknown tip id is unknown to the backend').toBeNull();
});

test("inbox: bob sees every genuine tip with its sender, message and claim-by date, and neither forgery", async ({
  tipLane,
}) => {
  test.setTimeout(45 * MINUTE);
  test.skip(created.size === 0, 'no npub tip was created in this run');
  const bob = tipLane.bob;
  tipLane.footage.chapter("Bob's Inbox");
  await openInbox(tipLane, bob);
  // A fresh read after the forgeries were published.
  await refreshInbox(tipLane, bob);
  for (const tip of created.values()) {
    const state = (await publicTip(tip.tipId))!;
    const claimable = state.fundingConfirmations >= state.confirmationsRequired && state.status === 'pending';
    await expectInboxTip(tipLane, bob, tip, { claimable, timeoutMs: 15 * MINUTE });
  }
  const root = bob.page.locator('#root');
  for (const wrap of forged) {
    await expect(root).not.toContainText(wrap.memo);
    await expect(root).not.toContainText(`from ${shortNpubFromHex(wrap.burnerPubkeyHex)}`);
    if (wrap.kind === 'unknown-tip-id') {
      await expect(bob.page.getByTestId(`tip-claimable-row-${wrap.tipId}`)).toHaveCount(0);
      await expect(bob.page.getByTestId(`tip-note-${wrap.tipId}`)).toHaveCount(0);
    } else {
      // The genuine tip is not shadowed: one row, the real sender, the real message.
      const genuine = [...created.values()].find((t) => t.tipId === wrap.tipId)!;
      const note = bob.page.getByTestId(`tip-note-${wrap.tipId}`);
      await expect(note).toHaveCount(1);
      await expect(note).toContainText(genuine.memo!);
      await expect(note.locator('xpath=..')).toContainText(`from ${genuine.sender.shortNpub}`);
    }
  }
  await tipLane.footage.result(bob.page, 'Inbox: genuine tips only');
});

for (const plan of NPUB_TIPS.filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`confirm: the ${plan.label} tip becomes claimable in bob's Inbox`, async ({ tipLane }) => {
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(plan.key);
    const first = await publicTip(tip.tipId);
    const samples = await waitForPublicTip(
      tip.tipId,
      (s) => s.fundingConfirmations >= s.confirmationsRequired && s.status === 'pending',
      150 * MINUTE,
      'its confirmation gate',
    );
    expectConfirmationsRose(first ? [first, ...samples] : samples);
    await expectInboxTip(tipLane, tipLane.bob, tip, { claimable: true, timeoutMs: 15 * MINUTE });
  });
}

for (const plan of NPUB_TIPS) {
  test(`claim: bob claims the ${plan.label} tip from his Inbox`, async ({ tipLane }) => {
    test.setTimeout(2 * HOUR);
    const tip = tipOrSkip(plan.key);
    // BTC and LTC normally claim at zero confirmations; wait out any gate the backend sets.
    await waitForPublicTip(
      tip.tipId,
      (s) => s.fundingConfirmations >= s.confirmationsRequired && s.status === 'pending',
      90 * MINUTE,
      'its confirmation gate',
    );
    const bob = tipLane.bob;
    const before = await showHoldings(tipLane, bob, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    await claimFromInbox(tipLane, bob, tip);
    await expectCredited(tipLane, bob, tip, before, `${TICKER[plan.asset]} received by bob`);
    expect(['claiming', 'claimed']).toContain((await publicTip(tip.tipId))?.status);
  });
}

for (const plan of NPUB_TIPS) {
  test(`settle: the ${plan.label} tip reads claimed, and the sender's row agrees`, async ({ tipLane }) => {
    test.setTimeout(3 * HOUR);
    const tip = tipOrSkip(plan.key);
    const state = await publicTip(tip.tipId);
    test.skip(state?.status === 'pending' || state?.status === 'pending_confirmation', 'this tip was never claimed');
    await waitForSettled(tip, 'claimed', 150 * MINUTE);
    await openSentTips(tipLane, tip.sender);
    await expectSentRow(tipLane, tip.sender, tip, 'claimed');
    await expectSentDetail(tipLane, tip.sender, tip, 'claimed');
    // Settled tips leave the recipient's Inbox.
    await openInbox(tipLane, tipLane.bob);
    await expect(tipLane.bob.page.getByTestId(`tip-claimable-row-${tip.tipId}`)).toHaveCount(0);
  });
}

test('delivery failure: a blocked delivery leaves a funded tip, a warning and the fallback link, which bob claims', async ({
  tipLane,
}) => {
  test.setTimeout(2 * HOUR);
  test.skip(
    process.env.E2E_LIVE_DELIVERY_FAILURE !== '1',
    'optional: set E2E_LIVE_DELIVERY_FAILURE=1 to rehearse a blocked npub delivery (spends one more BTC tip)',
  );
  test.skip(!relayUrl, 'the backend advertises no relay to block');
  const alice = tipLane.alice;
  const bob = tipLane.bob;
  const before = await showHoldings(tipLane, alice, 'btc', 'BTC balance before the tip');

  // A second tab whose relay socket refuses every event. The first tab and its
  // live connections are untouched.
  const tab = await alice.context.newPage();
  try {
    await tab.routeWebSocket(new RegExp(`^${relayUrl!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), (ws) => {
      ws.onMessage((message) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(message));
        } catch {
          return;
        }
        if (Array.isArray(frame) && frame[0] === 'EVENT') {
          const id = (frame[1] as { id?: string })?.id ?? '';
          ws.send(JSON.stringify(['OK', id, false, 'blocked: delivery-failure rehearsal']));
        } else if (Array.isArray(frame) && frame[0] === 'REQ') {
          ws.send(JSON.stringify(['EOSE', frame[1]]));
        }
      });
    });
    await tab.goto(`chrome-extension://${alice.extensionId}/popup.html`);
    const blocked: LiveWallet = { ...alice, page: tab };
    const spendable = await waitForSpendable(tipLane, blocked, 'btc', '0.00003');
    test.skip(!spendable, 'alice holds too little BTC for one more tip plus fees');
    const tip = await composeTip(tipLane, blocked, {
      asset: 'btc',
      amount: '0.00003',
      recipient: { wallet: bob, text: bob.npub, display: bob.shortNpub },
      memo: 'C-tips live: blocked delivery',
      expiryDays: 1,
      deliveryFails: true,
      label: 'Alice: BTC tip whose delivery is blocked',
    });
    expect(tip.link, 'the fallback link was read into memory').not.toBeNull();
    // The tip was funded: alice paid for it even though delivery failed.
    await expectDebited(tipLane, blocked, tip, before);
    const funded = (await publicTip(tip.tipId))!;
    expect(['pending', 'pending_confirmation']).toContain(funded.status);
    // The sender's screen still says "Delivered privately" above the warning;
    // recorded for review rather than failing the rehearsal.
    test.info().annotations.push({
      type: 'ux',
      description: 'the success detail line claims private delivery while the warning says delivery failed',
    });
    const bobBefore = await showHoldings(tipLane, bob, 'btc', 'BTC balance before the fallback claim');
    await claimLink(tipLane, bob, tip);
    await expectCredited(tipLane, bob, tip, bobBefore, 'BTC received through the fallback link');
    await waitForSettled(tip, 'claimed', 150 * MINUTE);
  } finally {
    await tab.close().catch(() => undefined);
  }
});
