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
 *   - https://api.moon.vote, which registers carol there and hands its light
 *     wallet servers her view keys: the owner must approve that run
 *     (`FED_BACKEND_APPROVED=1`).
 *
 * True cross-server delivery by name@domain needs B to serve HTTPS NIP-05 AND a
 * relay. With moon.vote today (no relay) or a loopback B (no HTTPS NIP-05) that
 * test is an expected skip and says which requirement is missing.
 *
 * Run with the same environment as d-messaging.live.spec.ts plus:
 *   FED_BACKEND_URL=<B>  [FED_BACKEND_APPROVED=1]  [FED_CAROL_HANDLE=<name on B>]
 *
 * No funds move. Carol's balances are compared before and after the round trip.
 */

import { randomBytes } from 'node:crypto';
import {
  test,
  expect,
  dLiveSkipReason,
  dRelaySkipReason,
  recordFinding,
  D_BACKEND_URL,
  type DWallet,
} from '../../fixtures/D-messaging-federation-live.js';
import {
  BACKEND_CONFIG_KEY,
  deliverDm,
  expectMessage,
  goTab,
  hubHandle,
  linkedState,
  openBackendPicker,
  openIdentityHub,
  openMessages,
  probeBackend,
  runText,
  storageValue,
  waitForBalances,
  waitForRebootstrap,
} from '../../fixtures/D-messaging-federation-flows.js';
import {
  closeNostrReader,
  hasDmInbox,
  nip05Expectation,
  readCapabilities,
  type DCapabilities,
} from '../../fixtures/D-messaging-federation-nostr.js';
import { liveRelaySkipReason } from '../../fixtures/relay-guard.js';

const FED_URL = (process.env.FED_BACKEND_URL ?? '').trim();

/** The API base the wallet derives from what the user types (core `connectBackend`). */
function fedApiBase(): string {
  let url = FED_URL.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  return url;
}

function fedSkipReason(): string | null {
  if (!FED_URL) {
    return 'federation: FED_BACKEND_URL must name an independent backend B (a disposable local smirk-backend-core with a local relay, or https://api.moon.vote with owner approval)';
  }
  let host = '';
  try {
    host = new URL(fedApiBase()).hostname;
  } catch {
    return 'federation: FED_BACKEND_URL is not a URL';
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (!loopback && process.env.FED_BACKEND_APPROVED !== '1') {
    return `federation: switching carol to ${host} registers her there and hands it her view keys; set FED_BACKEND_APPROVED=1 once the owner approves`;
  }
  if (new URL(fedApiBase()).host === new URL(D_BACKEND_URL).host) {
    return 'federation: FED_BACKEND_URL names the default backend; B must be an independent instance';
  }
  return null;
}

const skip = dLiveSkipReason() ?? dRelaySkipReason() ?? fedSkipReason();
test.skip(skip !== null, skip ?? '');

test.setTimeout(2 * 60 * 60_000);

const RUN = randomBytes(3).toString('hex');
let capsA: DCapabilities;
let capsB: DCapabilities;

test.beforeAll(async () => {
  capsA = await readCapabilities(D_BACKEND_URL);
  capsB = await readCapabilities(fedApiBase());
});

test.afterAll(() => closeNostrReader());

/** Whatever happened, carol ends on the default backend. */
test.afterEach(async ({ dWallets }) => {
  const { carol } = dWallets;
  const stored = await storageValue(carol, BACKEND_CONFIG_KEY).catch(() => undefined);
  if (stored === undefined || stored === null) return;
  await openBackendPicker(carol);
  await carol.footage.tap(carol.page.getByTestId('backend-reset-default'), 'back to the default backend');
  await waitForRebootstrap(carol);
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
  await probeBackend(carol, FED_URL, { relay: !!capsB.features?.nostr_relay, chains: enabledChains(capsB) });
  await carol.footage.tap(carol.page.getByTestId('backend-use-btn'), 'use this backend');
  await waitForRebootstrap(carol);
  const stored = JSON.stringify((await storageValue(carol, BACKEND_CONFIG_KEY)) ?? null);
  expect(stored, 'the wallet did not persist the chosen operator: it silently fell back to the default').toContain(
    new URL(fedApiBase()).host,
  );
  await carol.footage.result('backend B adopted');
}

test('carol federates to backend B and back: honest Messages, reach notice, balances return', async ({ dWallets }) => {
  const { alice, carol } = dWallets;
  const relayA = capsA.messaging?.relay_url ?? '';
  const powBits = capsA.messaging?.inbound_pow_bits ?? 0;
  const hostB = new URL(fedApiBase()).host;

  dWallets.chapter('Federation: carol on the default backend');
  // Whether the default relay will deliver to carol at all (a linked npub).
  const carolLinked = await linkedState(carol);
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
  const relaySkip = relayA ? liveRelaySkipReason(relayA, 1059) : 'the default backend advertises no relay';
  let delivered = false;
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
    delivered = outcome === 'delivered';
    if (!delivered) {
      recordFinding('policy', 'carol is not linked to her seed npub, so the default relay refused the cross-backend DM; the wallet showed the refusal');
    }
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
      message: 'carol\'s balances did not return to what the default backend showed before the switch',
    })
    .toBe(JSON.stringify(baseline));
  await carol.footage.result('balances returned');

  if (delivered) {
    // It waited on carol's home relay the whole time.
    await openMessages(carol);
    await expectMessage(carol, alice.npub, text);
  }
});

test('true cross-server delivery by name@domain', async ({ dWallets }) => {
  const relayB = capsB.messaging?.relay_url ?? '';
  test.skip(
    !capsB.features?.nostr_relay || !relayB,
    'backend B advertises no relay (Messages shows messages-relay-off there), so cross-server delivery by name@domain cannot be exercised',
  );
  test.skip(
    !fedApiBase().startsWith('https://'),
    'backend B is not served over HTTPS, so it cannot answer NIP-05 for name@domain',
  );
  const refused = liveRelaySkipReason(relayB, 1059);
  test.skip(refused !== null, refused ?? '');

  const { alice, carol } = dWallets;
  dWallets.chapter('Cross-server: carol on backend B');
  await switchToB(carol);

  // Carol's handle on B: her own, or one the owner named for this run.
  await openIdentityHub(carol);
  let handle = await hubHandle(carol);
  const wanted = (process.env.FED_CAROL_HANDLE ?? '').trim().toLowerCase();
  if (!handle && wanted) {
    await carol.footage.type(carol.page.getByTestId('nostr-claim-handle-input'), wanted, 'enter a handle');
    await carol.footage.tap(carol.page.getByTestId('nostr-claim-handle-btn'), 'claim the handle');
    await expect(carol.page.getByTestId('nostr-handle'), 'claiming the handle on B failed').toBeVisible({ timeout: 60_000 });
    handle = await hubHandle(carol);
  }
  test.skip(!handle, 'carol has no handle on backend B (set FED_CAROL_HANDLE to claim one for this run)');
  await carol.footage.result('carol handle on backend B');

  // NIP-05 on B names carol's seed identity and B's relay.
  const resolved = await nip05Expectation(handle!);
  expect(resolved, 'the handle does not resolve over NIP-05 on backend B').not.toBeNull();
  expect(resolved!.pubkeyHex, 'B\'s NIP-05 names a key that is not carol\'s seed identity').toBe(carol.pubkeyHex);
  expect(resolved!.relays.map((r) => new URL(r).host), 'B\'s NIP-05 gives no hint of its relay').toContain(new URL(relayB).host);

  await openMessages(carol);
  await openMessages(alice);
  dWallets.chapter('Cross-server: alice writes to carol by handle');
  // The relay hint is the inbox: no reach notice, and B's relay holds the wrap.
  await deliverDm({
    from: alice,
    fromNpub: alice.npub,
    to: { wallet: carol, pubkeyHex: carol.pubkeyHex },
    address: handle!,
    text: runText('across servers by handle', RUN),
    relayUrl: relayB,
    powBits: capsB.messaging?.inbound_pow_bits ?? 0,
    expectInbox: true,
  });
});
