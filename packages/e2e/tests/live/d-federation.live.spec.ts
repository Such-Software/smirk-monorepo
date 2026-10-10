/**
 * LIVE: federation. Carol points her wallet at an independent backend B, the
 * wallet stays honest about what B offers, alice's DM to her keeps its promise
 * (the reach notice), and carol comes back to the default backend with her
 * balances and the message waiting. Area D of the v0.3.1 release run.
 *
 * Backend B (`FED_BACKEND_URL`) must be a SEPARATE instance with its own
 * database, so "it works against B" cannot be satisfied by shared state:
 *
 *   - a disposable local smirk-backend-core plus a local nostr-rs-relay on the
 *     test host (loopback; no approval needed), or
 *   - a shared host such as https://api.moon.vote, which registers carol there
 *     and hands its light wallet servers her view keys: the owner must approve
 *     that run (`FED_BACKEND_APPROVED=1`).
 *
 * TRUE CROSS-SERVER DELIVERY (alice on the default backend writes to carol on B
 * by name@domain, and it lands on B's relay) needs a B that serves BOTH a relay
 * and HTTPS NIP-05: the wallet resolves name@domain only over https://, and it
 * learns where carol reads only from those NIP-05 relay hints (v0.3.1 never
 * publishes a kind-10050 inbox list). No B available on 2026-10-10 has both:
 * api.moon.vote advertises no relay, and a loopback B cannot answer HTTPS
 * NIP-05. That test therefore skips (which fails the run under the skip guard)
 * and records a release question; proving it needs a relay on moon.vote or an
 * HTTPS staging B, or the owner's explicit decision to ship without it.
 *
 * Carol's link state is settled by the shared `ensureLinkState` (linked here
 * with `E2E_LIVE_LINK=1 ALLOW_PROD_WRITES=1`), so this file does not depend on
 * running after d-messaging.
 *
 * Run with the same environment as d-messaging.live.spec.ts plus:
 *   FED_BACKEND_URL=<B>  [FED_BACKEND_APPROVED=1]  [FED_CAROL_HANDLE=<name on B>]
 *
 * No funds move. Carol's balances are compared before and after the round trip
 * exactly, which is why this lane must run alone (lanes B, C and E move funds
 * between the same wallets).
 */

import { randomBytes } from 'node:crypto';
import {
  test,
  expect,
  dFedApiBase,
  dFedSkipReason,
  dLinkApproved,
  dLiveSkipReason,
  dRelaySkipReason,
  recordFinding,
  BACKEND_CONFIG_KEY,
  D_BACKEND_URL,
  D_FED_URL,
  type DWallet,
} from '../../fixtures/D-messaging-federation-live.js';
import {
  claimHandle,
  deliverDm,
  ensureLinkState,
  expectMessage,
  goTab,
  hubHandle,
  linkIdentity,
  openBackendPicker,
  openIdentityHub,
  openMessages,
  probeBackend,
  readLinked,
  requireDelivered,
  restoreDefaultBackend,
  runText,
  storageValue,
  waitForBalances,
  waitForRebootstrap,
  type DmRecord,
} from '../../fixtures/D-messaging-federation-flows.js';
import {
  closeNostrReader,
  hasDmInbox,
  nip05Expectation,
  readCapabilities,
  type DCapabilities,
} from '../../fixtures/D-messaging-federation-nostr.js';
import { liveRelaySkipReason } from '../../fixtures/relay-guard.js';

const skip = dLiveSkipReason() ?? dRelaySkipReason() ?? dFedSkipReason();
test.skip(skip !== null, skip ?? '');

test.setTimeout(2 * 60 * 60_000);

const RUN = randomBytes(3).toString('hex');
let capsA: DCapabilities;
let capsB: DCapabilities;

test.beforeAll(async () => {
  capsA = await readCapabilities(D_BACKEND_URL);
  capsB = await readCapabilities(dFedApiBase());
});

test.afterAll(() => closeNostrReader());

/**
 * Whatever happened, carol ends on the default backend: from the lock screen,
 * from the bootstrap-error screen (no bottom nav there; its own escape leads to
 * Backend settings), or from any tab. If this fails too, the next worker resets
 * the leftover override before any test sees carol (worker fixture).
 */
test.afterEach(async ({ dWallets }) => {
  await restoreDefaultBackend(dWallets.carol);
});

function enabledChains(caps: DCapabilities): string[] {
  return Object.entries(caps.chains ?? {})
    .filter(([, chain]) => chain?.enabled)
    .map(([id]) => id);
}

/** Probe B from Settings, adopt it, and prove the choice is durable. */
async function switchToB(carol: DWallet): Promise<void> {
  await openBackendPicker(carol);
  await expect(carol.page.getByTestId('backend-current')).toContainText(new URL(D_BACKEND_URL).host);
  await probeBackend(carol, D_FED_URL, { relay: !!capsB.features?.nostr_relay, chains: enabledChains(capsB) });
  await carol.footage.tap(carol.page.getByTestId('backend-use-btn'), 'use this backend');
  await waitForRebootstrap(carol);
  const stored = JSON.stringify((await storageValue(carol, BACKEND_CONFIG_KEY)) ?? null);
  expect(stored, 'the wallet did not persist the chosen operator: it silently fell back to the default').toContain(
    new URL(dFedApiBase()).host,
  );
  await carol.footage.result('backend B adopted');
}

test('carol federates to backend B and back: honest Messages, reach notice, balances return', async ({ dWallets }) => {
  const { alice, carol } = dWallets;
  const relayA = capsA.messaging?.relay_url ?? '';
  const powBits = capsA.messaging?.inbound_pow_bits ?? 0;
  const hostB = new URL(dFedApiBase()).host;

  dWallets.chapter('Federation: carol on the default backend');
  // Whether the default relay will deliver to carol at all (a linked npub);
  // linked here with the owner's approval, whatever file ran first.
  const carolLinked = await ensureLinkState(carol);
  await goTab(carol, 'home');
  const baseline = await waitForBalances(carol);
  await carol.footage.result('balances on the default backend');

  dWallets.chapter('Federation: probe and adopt backend B');
  await switchToB(carol);

  // Durable across a full reload: the popup restarts locked, and after the
  // unlock it is still talking to B.
  dWallets.chapter('Federation: B survives a reload');
  await carol.page.reload();
  await waitForRebootstrap(carol);
  expect(JSON.stringify((await storageValue(carol, BACKEND_CONFIG_KEY)) ?? null), 'the chosen operator did not survive a reload').toContain(hostB);
  await openBackendPicker(carol);
  await expect(carol.page.getByTestId('backend-current'), 'Settings does not show backend B as connected').toContainText(hostB);
  await carol.footage.result('backend B after reload');

  // Messages is honest about B's relay.
  dWallets.chapter('Federation: Messages on backend B');
  const opensBefore = carol.relayGuard.opened.length;
  const state = await openMessages(carol);
  const relayB = capsB.messaging?.relay_url ?? '';
  if (capsB.features?.nostr_relay && relayB) {
    expect(state, 'B advertises a relay but Messages says it has none').toBe('on');
    const hosts = carol.relayGuard.opened.slice(opensBefore).map((o) => o.host);
    expect(hosts, 'Messages on B did not connect to B\'s relay').toContain(new URL(relayB).host);
    if (relayA) expect(hosts, 'Messages on B still talks to the previous operator\'s relay').not.toContain(new URL(relayA).host);
  } else {
    expect(state, 'B runs no relay but Messages offers to send').toBe('off');
    await expect(carol.page.getByTestId('messages-relay-off')).toContainText(/does not run a Nostr relay/);
  }
  await carol.footage.result('Messages on backend B');

  // Alice, still on the default backend, writes to carol by npub. Carol
  // advertises no inbox, so the wallet must warn that it only reached this
  // server's relay, which is exactly where carol is not looking right now.
  dWallets.chapter('Federation: alice writes to carol by npub');
  const text = runText('to carol while she is on backend B', RUN);
  const relaySkip = relayA ? liveRelaySkipReason(relayA, 1059, { pinned: dWallets.relayPins }) : 'the default backend advertises no relay';
  const records: DmRecord[] = [];
  if (relaySkip === null) {
    const inbox = await hasDmInbox(relayA, carol.pubkeyHex);
    if (inbox) recordFinding('note', 'carol advertises a NIP-17 inbox, so no reach notice was expected for the cross-backend DM');
    await openMessages(alice);
    const outcome = await deliverDm({
      from: alice,
      fromNpub: alice.npub,
      to: { pubkeyHex: carol.pubkeyHex },
      address: carol.npub,
      text,
      relayUrl: relayA,
      powBits,
      expectInbox: inbox,
      recipientRegistered: carolLinked,
    });
    records.push({ direction: 'alice to carol while carol is on backend B', outcome });
    if (state === 'on') {
      // It went to the default relay; carol on B must not pretend to have it.
      await carol.footage.settled('carol on backend B');
      await expect(carol.page.getByTestId('message-item').filter({ hasText: text })).toHaveCount(0);
    }
  } else {
    recordFinding('not-exercised', `the cross-backend DM was not sent: ${relaySkip}`);
  }

  // Back to the default backend: balances return, and the message is there.
  dWallets.chapter('Federation: carol returns to the default backend');
  await openBackendPicker(carol);
  await expect(carol.page.getByTestId('backend-current')).toContainText(hostB);
  await carol.footage.tap(carol.page.getByTestId('backend-reset-default'), 'back to the default backend');
  await waitForRebootstrap(carol);
  expect(await storageValue(carol, BACKEND_CONFIG_KEY), 'the default backend should leave no stored override').toBeFalsy();
  await goTab(carol, 'home');
  await expect
    .poll(async () => JSON.stringify(await waitForBalances(carol)), {
      timeout: 5 * 60_000,
      intervals: [5_000],
      message:
        'carol\'s balances did not return to what the default backend showed before the switch (if another lane moved funds for carol meanwhile, this lane was not run alone)',
    })
    .toBe(JSON.stringify(baseline));
  await carol.footage.result('balances returned');

  if (records.some((r) => r.outcome === 'delivered')) {
    // It waited on carol's home relay the whole time.
    await openMessages(carol);
    await expectMessage(carol, alice.npub, text);
  }
  // A refused DM (carol not linked, no approval) means the reach notice and the
  // waiting message were not proven: fail after the round trip has finished.
  requireDelivered(records);
});

test('true cross-server delivery by name@domain', async ({ dWallets }) => {
  const relayB = capsB.messaging?.relay_url ?? '';
  const missing = !capsB.features?.nostr_relay || !relayB
    ? 'backend B advertises no relay (Messages shows messages-relay-off there)'
    : !dFedApiBase().startsWith('https://')
      ? 'backend B is not served over HTTPS, so it cannot answer NIP-05 for name@domain'
      : null;
  if (missing) {
    recordFinding(
      'release-question',
      `federated message sending across servers was NOT proven: ${missing}. It needs a backend B with both a relay and HTTPS NIP-05 (a relay on moon.vote or an HTTPS staging host), or the owner's explicit decision to ship without this proof.`,
    );
    test.skip(true, `cross-server delivery by name@domain cannot be exercised: ${missing}`);
    return;
  }
  const refused = liveRelaySkipReason(relayB, 1059, { pinned: dWallets.relayPins });
  test.skip(refused !== null, refused ?? '');

  const { alice, carol } = dWallets;
  dWallets.chapter('Cross-server: carol on backend B');
  await switchToB(carol);

  // Carol's handle on B: her own, or one the owner named for this run.
  await openIdentityHub(carol);
  let handle = await hubHandle(carol);
  const wanted = (process.env.FED_CAROL_HANDLE ?? '').trim().toLowerCase();
  if (!handle && wanted) handle = await claimHandle(carol, wanted);
  if (!handle) {
    recordFinding('release-question', 'federated message sending across servers was NOT proven: carol has no handle on backend B (FED_CAROL_HANDLE claims one for the run)');
    test.skip(true, 'carol has no handle on backend B (set FED_CAROL_HANDLE to claim one for this run)');
    return;
  }
  await carol.footage.result('carol handle on backend B');
  // B's relay, like the default one, may admit gift wraps only to linked
  // npubs. Link carol's account on B with the same owner approval; the cached
  // link state stays the default backend's.
  if (!(await readLinked(carol))) {
    if (!dLinkApproved()) {
      recordFinding('release-question', 'federated message sending across servers was NOT proven: carol is not linked on backend B, and linking needs E2E_LIVE_LINK=1 with ALLOW_PROD_WRITES=1');
      test.skip(true, 'carol is not linked on backend B and linking was not approved for this run');
      return;
    }
    const linkedOnDefault = carol.linked;
    await linkIdentity(carol);
    carol.linked = linkedOnDefault;
  }

  // NIP-05 on B names carol's seed identity and B's relay.
  const resolved = await nip05Expectation(handle);
  expect(resolved, 'the handle does not resolve over NIP-05 on backend B').not.toBeNull();
  expect(resolved!.pubkeyHex, 'B\'s NIP-05 names a key that is not carol\'s seed identity').toBe(carol.pubkeyHex);
  expect(resolved!.relays.map((r) => new URL(r).host), 'B\'s NIP-05 gives no hint of its relay').toContain(new URL(relayB).host);

  await openMessages(carol);
  await openMessages(alice);
  dWallets.chapter('Cross-server: alice writes to carol by handle');
  // The relay hint is the inbox: no reach notice, and B's relay holds the
  // wrap alice's wallet published there (found by its id).
  const outcome = await deliverDm({
    from: alice,
    fromNpub: alice.npub,
    to: { wallet: carol, pubkeyHex: carol.pubkeyHex },
    address: handle,
    text: runText('across servers by handle', RUN),
    relayUrl: relayB,
    powBits: capsB.messaging?.inbound_pow_bits ?? 0,
    expectInbox: true,
  });
  requireDelivered([{ direction: 'alice to carol across servers', outcome }]);
});
