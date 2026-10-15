/**
 * C-tips (live): tips to a person, their Inbox delivery and claims, federated
 * tips, and the Inbox's refusal of forged gift wraps.
 *
 *   1. Person tips, every recipient form the composer accepts. Alice tips bob
 *      XMR 0.001 and WOW 1 by npub, BTC 3,000 sat by bare username (typed as
 *      `@name`, then `name`, both resolving on this instance's NIP-05 domain),
 *      and LTC 0.001 by `name@domain`; carol tips bob GRIN 0.05 by npub. Each
 *      composer shows who can claim, a message, and a 1, 7 or 30 day reclaim
 *      date. Bob needs a verified Smirk handle: there is no silent npub fallback.
 *   2. Federated tips. Alice tips LTC 0.001 to bob through a NIP-05 address on a
 *      foreign domain (E2E_FOREIGN_NIP05), and BTC 3,000 sat to bob on a second,
 *      independent backend (FED_BACKEND_URL: bob's phrase in a fourth profile
 *      switched to that operator). The wrap must reach the second backend's
 *      relay, and bob there must see and claim the tip. Neither prerequisite
 *      exists in production today; without one the test fails unless the
 *      operator acknowledges the gap (E2E_LIVE_ACK_GAPS=federation).
 *   3. Bob's Inbox shows each tip with the sender's short npub, the exact message
 *      and the claim-by date; XMR, WOW and GRIN wait for confirmations first. Bob
 *      claims each; his balance rises and XMR/WOW claims report a proven key
 *      image. The sender's Sent tips row shows recipient, status and reclaim
 *      date, and its detail timeline ends at Claimed.
 *   4. Forged wraps. A Node-side harness (fixtures/nostr-forge.ts) publishes two
 *      kind-1059 gift wraps to bob with PoW from burner keys: one reuses a real
 *      tip id with a wrong claim key, one names an unknown tip id. The relay
 *      must return both for bob's #p (so the check cannot pass vacuously), bob's
 *      Inbox must query the relay again after the publish, and still show
 *      neither; the genuine tip keeps its real sender and message.
 *   5. A blocked delivery (on by default; E2E_LIVE_SKIP_DELIVERY_FAILURE=1 opts
 *      out): a person tip whose relay publish the harness refuses is still
 *      funded, shows the warning and the fallback link (masked), and bob claims
 *      it through that link.
 *   6. Rescue: any person tip of this run that still holds funds goes back to
 *      its sender.
 *
 * The forge publishes only to the first-party relay the backend under test
 * advertises, and only behind the live lane's write gates. Tests read the tips
 * they need from the run's ledger, so one failure never skips the rest.
 *
 * Run with the same environment as c-tips.live.spec.ts.
 */
import { test, expect, liveGateReason, rescueMode, shortNpubFromHex, type LiveWallet, type TipLane, type WalletName } from '../../fixtures/C-tips-live.js';
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
  ledgerTip,
  openInbox,
  openSentTips,
  pastGate,
  pendingPhase,
  publicTip,
  refreshInbox,
  rescueTip,
  showHoldings,
  tipFromLedger,
  waitForPublicTip,
  waitForSettled,
  waitForSpendable,
  type CreatedTip,
  type RecipientEntry,
  type RescueOutcome,
  type TipAsset,
} from '../../fixtures/C-tips-actions.js';
import { isLocalPublishRelay } from '../../fixtures/relay-guard.js';
import { forgeTipWrap, publishWrap, queryWrapIds, wrapPow } from '../../fixtures/nostr-forge.js';
import {
  bobHandle,
  disabledChains,
  federatedBackend,
  federationGapSkip,
  foreignAddress,
  liveCaps,
  relayInfo,
} from '../../fixtures/C-tips-scenario.js';

const GATE = liveGateReason();
test.skip(GATE !== null, GATE ?? 'live lane open');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How the composer addresses bob. */
type RecipientForm = 'npub' | 'username' | 'handle' | 'foreign' | 'second-backend';

interface PersonPlan {
  key: string;
  sender: WalletName;
  asset: TipAsset;
  amount: string;
  expiryDays: 1 | 7 | 30;
  memo: string;
  to: RecipientForm;
  label: string;
}

/** Messages are static strings: the Inbox must show them exactly. */
const PERSON_TIPS: readonly PersonPlan[] = [
  { key: 'npub:xmr', sender: 'alice', asset: 'xmr', amount: '0.001', expiryDays: 1, memo: 'C-tips live: XMR for bob', to: 'npub', label: 'Alice: XMR 0.001 to bob' },
  { key: 'npub:wow', sender: 'alice', asset: 'wow', amount: '1', expiryDays: 7, memo: 'C-tips live: WOW for bob', to: 'npub', label: 'Alice: WOW 1 to bob' },
  { key: 'npub:btc', sender: 'alice', asset: 'btc', amount: '0.00003', expiryDays: 30, memo: 'C-tips live: BTC for bob by username', to: 'username', label: 'Alice: BTC 3,000 sat to bob by username' },
  { key: 'npub:ltc', sender: 'alice', asset: 'ltc', amount: '0.001', expiryDays: 7, memo: 'C-tips live: LTC for bob by handle', to: 'handle', label: 'Alice: LTC 0.001 to bob by handle' },
  { key: 'npub:grin', sender: 'carol', asset: 'grin', amount: '0.05', expiryDays: 30, memo: 'C-tips live: GRIN for bob', to: 'npub', label: 'Carol: GRIN 0.05 to bob' },
];

/** Federated: the same promise across domains and operators. */
const FEDERATED_TIPS: readonly PersonPlan[] = [
  { key: 'npub:foreign-ltc', sender: 'alice', asset: 'ltc', amount: '0.001', expiryDays: 7, memo: 'C-tips live: LTC via a foreign NIP-05', to: 'foreign', label: 'Alice: LTC 0.001 to bob at a foreign domain' },
  { key: 'npub:fed-btc', sender: 'alice', asset: 'btc', amount: '0.00003', expiryDays: 7, memo: 'C-tips live: BTC to bob on a second backend', to: 'second-backend', label: 'Alice: BTC 3,000 sat to bob on a second backend' },
];

const BLOCKED_KEY = 'npub:blocked-btc';

/** Markers only a forged wrap carries; the Inbox must never show them. */
const FORGED_REUSED_MEMO = 'C-tips forged: reused tip id';
const FORGED_UNKNOWN_MEMO = 'C-tips forged: unknown tip id';

const RESCUE_ONLY = 'rescue run: only the rescue and overview tests run';

/**
 * The tip an earlier send created, or a skip naming why it is missing. A
 * federated send that skipped for an acknowledged gap passes that reason on,
 * so its claim and settle skips are as expected as the send's own.
 */
async function tipOrSkip(lane: TipLane, plan: { key: string; to?: RecipientForm }): Promise<CreatedTip> {
  const tip = ledgerTip(lane, plan.key);
  if (!tip) {
    const gap = plan.to ? await federationGapSkip(plan.to) : null;
    test.skip(true, gap ?? `the ${plan.key} person tip was not created in this run (see its send test)`);
  }
  return tip!;
}

/** The wallet a person tip is claimed in: bob, or bob on the second backend. */
async function claimerOf(lane: TipLane, tip: CreatedTip): Promise<LiveWallet> {
  if (tip.recipient) return tip.recipient;
  // A restarted worker has not reopened bob's second-backend profile yet.
  if (lane.ledger.tip(tip.key)?.recipient === 'bob-fed') return lane.openFederated((await federatedBackend()).url);
  return lane.bob;
}

/** What to type for each form, and what the composer must show for it. */
async function recipientFor(
  lane: TipLane,
  plan: PersonPlan,
): Promise<{ wallet: LiveWallet; entry: RecipientEntry; alsoResolve?: RecipientEntry[] }> {
  const bob = lane.bob;
  const byNpub = { text: bob.npub, display: bob.shortNpub };
  switch (plan.to) {
    case 'npub':
      return { wallet: bob, entry: byNpub };
    case 'handle': {
      const handle = await bobHandle(lane);
      return { wallet: bob, entry: { text: handle, display: handle } };
    }
    case 'username': {
      const name = (await bobHandle(lane)).split('@')[0]!;
      return { wallet: bob, entry: { text: name, display: `@${name}` }, alsoResolve: [{ text: `@${name}`, display: `@${name}` }] };
    }
    case 'foreign': {
      const address = await foreignAddress(bob);
      return { wallet: bob, entry: { text: address, display: address } };
    }
    case 'second-backend': {
      const fed = await lane.openFederated((await federatedBackend()).url);
      expect(fed.pubkeyHex, 'bob has the same Nostr identity on both backends').toBe(bob.pubkeyHex);
      return { wallet: fed, entry: byNpub };
    }
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

test('preflight: tips and a first-party relay are advertised, bob is reachable by name, and every wallet shows its balances', async ({
  tipLane,
}) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(45 * MINUTE);
  const caps = await liveCaps();
  expect(caps.features.tips, 'the backend advertises tips').toBe(true);
  // A person tip's claim key travels by gift wrap: without a relay none can be delivered.
  expect((await relayInfo()).url, 'the backend advertises a first-party relay for gift wraps').toMatch(/^wss?:\/\//);
  tipLane.footage.chapter('C-tips: person tips, balances before');
  for (const w of [tipLane.alice, tipLane.bob, tipLane.carol]) {
    await showHoldings(tipLane, w, 'btc', `${w.name}: balances on Home`);
  }
  // The handle and username tips need bob reachable by name: say so here, first.
  await bobHandle(tipLane);
});

for (const plan of [...PERSON_TIPS, ...FEDERATED_TIPS]) {
  test(`send: ${plan.label}, with a message and a reclaim date`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(3 * HOUR);
    test.skip((await disabledChains()).has(plan.asset), `${TICKER[plan.asset]} is disabled on this backend`);
    const recipient = await recipientFor(tipLane, plan);
    const w = tipLane.wallet(plan.sender);
    const fed = plan.to === 'second-backend' ? await federatedBackend() : null;
    const wrapsBefore = fed ? await queryWrapIds(fed.relayUrl, tipLane.bob.pubkeyHex) : null;

    const before = await showHoldings(tipLane, w, plan.asset, `${TICKER[plan.asset]} balance before the tip`);
    const spendable = await waitForSpendable(tipLane, w, plan.asset, plan.amount);
    test.skip(
      !spendable,
      `${w.name} holds too little ${TICKER[plan.asset]} for a ${plan.amount} tip plus fees; top up the demo wallet`,
    );
    const tip = await composeTip(tipLane, w, {
      key: plan.key,
      asset: plan.asset,
      amount: plan.amount,
      recipient,
      memo: plan.memo,
      expiryDays: plan.expiryDays,
      label: plan.label,
    });
    await expectDebited(tipLane, w, tip, before);

    // The sender's row: recipient, status and reclaim date, and the details.
    const state = (await publicTip(tip.tipId))!;
    await openSentTips(tipLane, w);
    await expectSentRow(tipLane, w, tip, state.status);
    await expectSentDetail(tipLane, w, tip, pendingPhase(state));

    if (fed && wrapsBefore) {
      // Delivery across operators: a new wrap for bob reached the second backend's relay.
      const after = await queryWrapIds(fed.relayUrl, tipLane.bob.pubkeyHex);
      expect([...after].some((id) => !wrapsBefore.has(id)), 'the gift wrap reached the second backend\'s relay').toBe(true);
    }
  });
}

test('forge: burner gift wraps reusing a real tip id and naming an unknown one are published to bob', async ({ tipLane }) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(30 * MINUTE);
  const relay = await relayInfo();
  const reason = forgeTargetReason(relay.url);
  test.skip(reason !== null, reason ?? '');
  const real = ledgerTip(tipLane, 'npub:btc') ?? ledgerTip(tipLane, 'npub:ltc') ?? ledgerTip(tipLane, 'npub:xmr');
  test.skip(!real, 'no genuine person tip exists to impersonate (see the send tests)');
  const record = await publicTip(real!.tipId);
  expect(record?.encryptedKey, 'the genuine tip has a sealed key on the backend').toBeTruthy();

  tipLane.footage.chapter('Forged gift wraps published to bob');
  const bob = tipLane.bob;
  const forged = [
    forgeTipWrap({
      recipientPubkeyHex: bob.pubkeyHex,
      kind: 'reused-tip-id',
      tipId: real!.tipId,
      encryptedKeyHex: record!.encryptedKey,
      asset: real!.asset,
      amount: Number(real!.amountAtomic) * 1000,
      memo: FORGED_REUSED_MEMO,
      powBits: relay.powBits,
    }),
    forgeTipWrap({
      recipientPubkeyHex: bob.pubkeyHex,
      kind: 'unknown-tip-id',
      asset: 'xmr',
      amount: 500_000_000_000,
      memo: FORGED_UNKNOWN_MEMO,
      powBits: relay.powBits,
    }),
  ];
  for (const wrap of forged) {
    expect(wrap.event.kind).toBe(1059);
    expect(wrapPow(wrap.event)).toBeGreaterThanOrEqual(relay.powBits);
    const result = await publishWrap(relay.url!, wrap.event);
    // A refusal would make the Inbox check vacuous: report the relay's reason.
    expect(result.accepted, `the relay refused the ${wrap.kind} wrap: ${result.message}`).toBe(true);
  }
  const publishedAtMs = Date.now();
  tipLane.ledger.recordForgeries(
    forged.map((wrap) => ({
      kind: wrap.kind,
      tipId: wrap.tipId,
      burnerPubkeyHex: wrap.burnerPubkeyHex,
      memo: wrap.memo,
      eventId: wrap.event.id,
      publishedAtMs,
    })),
  );
  expect(await publicTip(forged[1]!.tipId), 'the unknown tip id is unknown to the backend').toBeNull();
});

test("inbox: bob sees every genuine tip with its sender, message and claim-by date, and neither forgery", async ({
  tipLane,
}) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(90 * MINUTE);
  const bob = tipLane.bob;
  const created = [...PERSON_TIPS, ...FEDERATED_TIPS]
    .filter((p) => p.to !== 'second-backend')
    .map((p) => ledgerTip(tipLane, p.key))
    .filter((t): t is CreatedTip => t !== null);
  // A tip whose delivery the relay refused never reaches the Inbox (its send
  // test failed for that); its forgery check still runs against the others.
  for (const t of created.filter((x) => x.deliveryRefused)) {
    test.info().annotations.push({ type: 'not in the Inbox', description: `${t.key}: delivery refused (${t.deliveryRefused})` });
  }
  const genuine = created.filter((t) => !t.deliveryRefused);
  test.skip(created.length === 0, 'no person tip to bob was created in this run');
  const forged = tipLane.ledger.forgeries();
  test.skip(forged.length < 2, 'the forge test did not publish both wraps (see it)');

  // Not vacuous: the relay returns both forgeries for bob's #p, the way his Inbox asks.
  const relay = (await relayInfo()).url!;
  const retrievable = await queryWrapIds(relay, bob.pubkeyHex, { ids: forged.map((f) => f.eventId) });
  expect(forged.every((f) => retrievable.has(f.eventId)), 'the relay serves both forged wraps to bob').toBe(true);

  tipLane.footage.chapter("Bob's Inbox");
  const since = Math.max(...forged.map((f) => f.publishedAtMs), tipLane.openedAt);
  await openInbox(tipLane, bob);
  // A fresh read after the forgeries were published, and proof the Inbox made it.
  await refreshInbox(tipLane, bob);
  await expect
    .poll(
      () => tipLane.requestsSince(bob, since).some((r) => r.kinds.includes(1059) && r.p.includes(bob.pubkeyHex)),
      { timeout: 2 * MINUTE, message: 'bob\'s Inbox never queried the relay for his gift wraps after the forge' },
    )
    .toBe(true);
  for (const tip of genuine) {
    const state = (await publicTip(tip.tipId))!;
    if (!['pending', 'pending_confirmation'].includes(state.status)) continue;
    await expectInboxTip(tipLane, bob, tip, { claimable: pastGate(state), timeoutMs: 15 * MINUTE });
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
      const real = genuine.find((t) => t.tipId === wrap.tipId);
      if (!real) continue;
      const note = bob.page.getByTestId(`tip-note-${wrap.tipId}`);
      await expect(note).toHaveCount(1);
      await expect(note).toContainText(real.memo!);
      await expect(note.locator('xpath=..')).toContainText(`from ${real.sender.shortNpub}`);
    }
  }
  await tipLane.footage.result(bob.page, 'Inbox: genuine tips only');
});

for (const plan of PERSON_TIPS.filter((p) => CONFIRMING_ASSETS.includes(p.asset))) {
  test(`confirm: the ${plan.label} tip becomes claimable in bob's Inbox`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(4 * HOUR);
    const tip = await tipOrSkip(tipLane, plan);
    const first = await publicTip(tip.tipId);
    const samples = await waitForPublicTip(tip.tipId, pastGate, 150 * MINUTE, 'its confirmation gate');
    expectConfirmationsRose(first ? [first, ...samples] : samples);
    if (tip.deliveryRefused) {
      // Never delivered (its send test failed for that): the confirmations are
      // proven here, and the claim goes through the fallback link.
      test.info().annotations.push({ type: 'not in the Inbox', description: `delivery refused (${tip.deliveryRefused})` });
      return;
    }
    await expectInboxTip(tipLane, tipLane.bob, tip, { claimable: true, timeoutMs: 15 * MINUTE });
  });
}

for (const plan of [...PERSON_TIPS, ...FEDERATED_TIPS]) {
  test(`claim: bob claims the ${plan.label} tip from his Inbox`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(3 * HOUR);
    const tip = await tipOrSkip(tipLane, plan);
    // BTC and LTC normally claim at zero confirmations; wait out any gate the backend sets.
    await waitForPublicTip(tip.tipId, pastGate, 150 * MINUTE, 'its confirmation gate');
    const claimer = await claimerOf(tipLane, tip);
    const before = await showHoldings(tipLane, claimer, plan.asset, `${TICKER[plan.asset]} balance before the claim`);
    if (tip.deliveryRefused) {
      // The relay refused the private delivery, so the Inbox never shows this
      // tip: bob claims it the way the wallet tells the sender to, by the link.
      test.info().annotations.push({ type: 'claimed by link', description: `delivery refused (${tip.deliveryRefused})` });
      await claimLink(tipLane, claimer, tip);
    } else {
      await claimFromInbox(tipLane, claimer, tip);
    }
    await expectCredited(tipLane, claimer, tip, before, `${TICKER[plan.asset]} received by bob`);
    expect(['claiming', 'claimed']).toContain((await publicTip(tip.tipId))?.status);
  });
}

test('delivery failure: a blocked delivery leaves a funded tip, a warning and the fallback link, which bob claims', async ({
  tipLane,
}) => {
  test.skip(rescueMode(), RESCUE_ONLY);
  test.setTimeout(3 * HOUR);
  test.skip(
    process.env.E2E_LIVE_SKIP_DELIVERY_FAILURE === '1',
    'optional: E2E_LIVE_SKIP_DELIVERY_FAILURE=1 opted out of the blocked-delivery rehearsal',
  );
  const relayUrl = (await relayInfo()).url;
  expect(relayUrl, 'the backend advertises a relay to block').toMatch(/^wss?:\/\//);
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
    test.skip(!spendable, 'alice holds too little BTC for one more tip plus fees; top up the demo wallet');
    const tip = await composeTip(tipLane, blocked, {
      key: BLOCKED_KEY,
      asset: 'btc',
      amount: '0.00003',
      recipient: { wallet: bob, entry: { text: bob.npub, display: bob.shortNpub } },
      memo: 'C-tips live: blocked delivery',
      expiryDays: 1,
      deliveryFails: true,
      label: 'Alice: BTC tip whose delivery is blocked',
    });
    expect(tipLane.links.has(tip.tipId), 'the fallback link was read into memory').toBe(true);
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
  } finally {
    await tab.close().catch(() => undefined);
  }
  const tip = ledgerTip(tipLane, BLOCKED_KEY)!;
  const bobBefore = await showHoldings(tipLane, bob, 'btc', 'BTC balance before the fallback claim');
  await claimLink(tipLane, bob, tip);
  await expectCredited(tipLane, bob, tip, bobBefore, 'BTC received through the fallback link');
});

for (const plan of [...PERSON_TIPS, ...FEDERATED_TIPS, { key: BLOCKED_KEY, label: 'Alice: BTC tip whose delivery is blocked' }]) {
  test(`settle: the ${plan.label} tip reads claimed, and the sender's row agrees`, async ({ tipLane }) => {
    test.skip(rescueMode(), RESCUE_ONLY);
    test.setTimeout(3 * HOUR);
    const tip = await tipOrSkip(tipLane, plan);
    const state = await publicTip(tip.tipId);
    test.skip(state?.status === 'pending' || state?.status === 'pending_confirmation', 'this tip was never claimed (see its claim test)');
    await waitForSettled(tip, 'claimed', 150 * MINUTE);
    await openSentTips(tipLane, tip.sender);
    await expectSentRow(tipLane, tip.sender, tip, 'claimed');
    await expectSentDetail(tipLane, tip.sender, tip, 'claimed');
    // Settled tips leave the recipient's Inbox.
    const claimer = await claimerOf(tipLane, tip);
    await openInbox(tipLane, claimer);
    await expect(claimer.page.getByTestId(`tip-claimable-row-${tip.tipId}`)).toHaveCount(0);
    await tipLane.footage.result(claimer.page, 'Inbox after the claim settled');
  });
}

test('rescue: no person tip of this run still holds funds; any that does goes back to its sender', async ({ tipLane }) => {
  test.skip(rescueMode(), 'rescue run: c-tips.live.spec.ts rescues every tip of the run');
  test.setTimeout(8 * HOUR);
  const records = tipLane.ledger.tips('npub:');
  test.skip(records.length === 0, 'no person tip was created in this run');
  const outcomes: RescueOutcome[] = [];
  for (const record of records) outcomes.push(await rescueTip(tipLane, tipFromLedger(tipLane, record)));
  for (const o of outcomes.filter((x) => x.action !== 'already settled')) {
    test.info().annotations.push({ type: 'rescue', description: `${o.key} (${o.asset}, from ${o.sender}): ${o.action}, ${o.status}${o.note ? `; ${o.note}` : ''}` });
  }
  expect(
    outcomes.filter((o) => o.action === 'failed').map((o) => `${o.key}: ${o.status}`),
    'tips that still hold funds; RECOVERY.md in the run state directory has the rescue command',
  ).toEqual([]);
});
