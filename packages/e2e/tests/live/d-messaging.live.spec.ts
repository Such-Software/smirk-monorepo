/**
 * LIVE: NIP-17 messaging between the demo wallets on the operator relay, the
 * identity picker and burners, cross-ecosystem delivery both ways, background
 * delivery to the Inbox, and the feed. Area D of the v0.3.1 release run.
 *
 * Every step asserts an outcome on BOTH sides of the wire:
 *   - the wallet's own verdict (sent, or the red error; the reach notice), and
 *   - what the relay actually holds (the recipient's inbox gained a gift wrap,
 *     with the NIP-13 proof-of-work the relay demands), and
 *   - what the recipient's wallet shows (sender npub and exact text).
 *
 * The reach notice ("sent to this server's relay only") must appear exactly
 * when the recipient advertises no NIP-17 inbox (kind 10050) and no NIP-05 relay
 * hints. The specs compute that from the relay, so a notice that lies in either
 * direction fails.
 *
 * Relay evidence is looked up by the ids of the gift wraps this run published
 * (the relay guard records them), never by "whatever is new", so another lane
 * writing to the same wallets cannot satisfy or spoil it.
 *
 * The operator relay (premium-post) admits a gift wrap only when its recipient
 * is a LINKED npub (an account bound to that seed identity). A demo wallet that
 * is not linked therefore cannot receive DMs there. With the owner's approval
 * for this durable account write (`E2E_LIVE_LINK=1` plus `ALLOW_PROD_WRITES=1`)
 * the first test that needs a wallet's link state links it from the identity
 * hub, as a user would (`ensureLinkState`, shared with the federation spec, so
 * file order does not matter). Without that approval a DM to an unlinked
 * wallet is still sent and the wallet's honest refusal is asserted, but the
 * test then FAILS: it has not proven its title, and whether unlinked v0.3.1
 * users may go without DMs is a release question for the owner (recorded in
 * the findings file). A comprehensive run therefore needs the link approval.
 *
 * Running it (owner-approved demo wallets; never `set -a` the custody file):
 *
 *   E2E_LIVE=1 E2E_LIVE_RELAY=1 FOOTAGE=guarded E2E_RUN_LABEL=run-<run> \
 *   E2E_LIVE_LINK=1 ALLOW_PROD_WRITES=1 [E2E_LIVE_CAROL_HANDLE=<name>] [E2E_LIVE_FEED_POST=1] \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 \
 *   EXTENSION_DIST=<unpacked, hash-verified smirk-wallet-chrome-v0.3.1.zip> \
 *   E2E_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   E2E_MIN_EXECUTED=1 npx playwright test -c D-messaging-federation.live.config.ts
 *
 * `E2E_LIVE_FEED_POST=1` lets a wallet that the server lets post publish ONE
 * public note (owner approval for the real feed). `E2E_LIVE_CAROL_HANDLE=<name>`
 * (with `ALLOW_PROD_WRITES=1`) lets the name@domain test claim that handle for
 * carol when no demo wallet has one (owner approval: a durable account write).
 *
 * Run this lane alone: lanes B, C and E use the same wallets (see the config).
 *
 * No funds move in this file. Publishing is limited by the relay guard to the
 * relays the run pinned (the operator relay) and to kinds 1059 and 10050 (plus
 * an approved premium kind-1).
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
  type DWallets,
} from '../../fixtures/D-messaging-federation-live.js';
import {
  addBurner,
  backgroundWrapIds,
  chooseMessagingIdentity,
  claimHandle,
  deliverDm,
  ensureLinkState,
  expectMessage,
  expectMessagingAs,
  goTab,
  hubHandle,
  notifiedWrapIds,
  openIdentityHub,
  openMessages,
  publishedWraps,
  requireDelivered,
  runText,
  sendMessage,
  type DmRecord,
} from '../../fixtures/D-messaging-federation-flows.js';
import {
  closeNostrReader,
  createExternalIdentity,
  externalInboxTexts,
  externalSecretForms,
  feedAuthorLabel,
  feedExpectation,
  findWraps,
  hasDmInbox,
  hexToNpub,
  nip05Expectation,
  readCapabilities,
  sendFromExternal,
  type DCapabilities,
} from '../../fixtures/D-messaging-federation-nostr.js';
import { liveFeedPostApproved, liveRelaySkipReason } from '../../fixtures/relay-guard.js';

const liveSkip = dLiveSkipReason() ?? dRelaySkipReason();
test.skip(liveSkip !== null, liveSkip ?? '');

// Confirmation-free, but paced for review: every tap holds 6 s, every result 25 s.
test.setTimeout(2 * 60 * 60_000);

/** Unique to this run: an old message can never satisfy an assertion. */
const RUN = randomBytes(3).toString('hex');

let caps: DCapabilities;
let relay = '';
let powBits = 0;

test.beforeAll(async () => {
  caps = await readCapabilities(D_BACKEND_URL);
  relay = caps.messaging?.relay_url ?? '';
  powBits = caps.messaging?.inbound_pow_bits ?? 0;
});

test.afterAll(() => closeNostrReader());

/** Skip (with the rule's own reason) unless gift wraps may be published here. */
function requireGiftWrapRelay(dWallets: DWallets): void {
  test.skip(!caps.features?.nostr_relay || !relay, 'the backend advertises no relay, so there is nowhere to deliver a DM');
  const refused = liveRelaySkipReason(relay, 1059, { pinned: dWallets.relayPins });
  test.skip(refused !== null, refused ?? '');
}

/**
 * One DM between demo wallets on the operator relay, with evidence on both
 * sides (see `deliverDm`). A recipient that is not linked is refused, and the
 * refusal is asserted; the caller then fails through `requireDelivered`.
 */
async function deliver(
  from: DWallet,
  to: DWallet,
  fromNpub: string,
  address: string,
  text: string,
  expectInbox: boolean | null = null,
): Promise<DmRecord> {
  const registered = await ensureLinkState(to);
  const outcome = await deliverDm({
    from,
    fromNpub,
    to: { wallet: to, pubkeyHex: to.pubkeyHex },
    address,
    text,
    relayUrl: relay,
    powBits,
    expectInbox,
    recipientRegistered: registered,
  });
  return { direction: `${from.name} to ${to.name}`, outcome };
}

/** Handles the hub shows (null: none claimed), cached per worker. */
const handles = new Map<string, string | null>();

async function handleOf(w: DWallet): Promise<string | null> {
  if (!handles.has(w.name)) {
    await openIdentityHub(w);
    handles.set(w.name, await hubHandle(w));
    await ensureLinkState(w, { hubOpen: true });
  }
  return handles.get(w.name) ?? null;
}

/** A handle the owner approved claiming for carol in this run, or null. */
function approvedCarolHandle(): string | null {
  const name = (process.env.E2E_LIVE_CAROL_HANDLE ?? '').trim().toLowerCase();
  if (!name || process.env.ALLOW_PROD_WRITES !== '1') return null;
  return /^[a-z0-9._-]{1,32}$/.test(name) ? name : null;
}

test('each wallet messages as its seed identity on the operator relay', async ({ dWallets }) => {
  const { alice, bob, carol } = dWallets;
  dWallets.chapter('Identities and Messages');
  for (const w of [alice, bob, carol]) {
    await openIdentityHub(w);
    // The npub the wallet signs with is the seed's account-0 identity, derived
    // here independently from the phrase (public key only).
    await expect(w.page.getByTestId('nostr-npub'), 'the active identity is not the seed account-0 npub').toHaveText(w.npub);
    handles.set(w.name, await hubHandle(w));
    await w.footage.result('seed identity shown');
    // Linked or not decides whether the relay will deliver DMs to this wallet
    // (linked here with the owner's approval; otherwise a release question).
    await ensureLinkState(w, { hubOpen: true });
  }
  for (const w of [alice, bob, carol]) {
    const mark = w.relayGuard.wrapSubscriptions.length;
    const state = await openMessages(w);
    expect(state, 'Messages disagrees with the backend about running a relay').toBe(caps.features?.nostr_relay && relay ? 'on' : 'off');
    if (state === 'on') {
      // The picker names the identity you message as, and the npub to hand out.
      await expect(w.page.getByTestId('messages-identity-picker')).toBeVisible();
      await expect(w.page.getByTestId('messages-copy-npub')).toBeVisible();
      // Messages listens as the seed identity, and the picker selects it.
      await expectMessagingAs(w, w.npub, mark);
    }
    await w.footage.result('Messages ready');
  }
});

test('alice, bob and carol message each other by npub and reply', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice, bob, carol } = dWallets;
  for (const w of [alice, bob, carol]) await ensureLinkState(w);
  dWallets.chapter('DMs by npub on the Smirk relay');
  // Every recipient listens live while the sender types.
  for (const w of [alice, bob, carol]) await openMessages(w);

  // [sender, recipient, message purpose, chapter for the DM, chapter for the reply]
  const pairs: [DWallet, DWallet, string, string, string][] = [
    [alice, bob, 'alice to bob', 'DM alice to bob', 'Reply bob to alice'],
    [bob, carol, 'bob to carol', 'DM bob to carol', 'Reply carol to bob'],
    [carol, alice, 'carol to alice', 'DM carol to alice', 'Reply alice to carol'],
  ];
  const records: DmRecord[] = [];
  for (const [from, to, purpose, dmChapter, replyChapter] of pairs) {
    dWallets.chapter(dmChapter);
    records.push(await deliver(from, to, from.npub, to.npub, runText(purpose, RUN)));
    dWallets.chapter(replyChapter);
    records.push(await deliver(to, from, to.npub, from.npub, runText(`reply to ${purpose}`, RUN)));
  }
  // All six directions, each shown on both sides of the wire.
  requireDelivered(records);
});

test('a DM by name@domain resolves the handle to the seed identity', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice, bob, carol } = dWallets;
  dWallets.chapter('DM by Smirk handle');
  // Prefer carol (bob writes to her), then another demo wallet's handle, and
  // among those a recipient the relay delivers to (a linked one).
  const candidates: [DWallet, DWallet][] = [[bob, carol], [carol, alice], [alice, bob]];
  const routes: { from: DWallet; to: DWallet; handle: string; linked: boolean }[] = [];
  for (const [from, to] of candidates) {
    const handle = await handleOf(to);
    if (handle) routes.push({ from, to, handle, linked: await ensureLinkState(to) });
  }
  let route = routes.find((r) => r.linked) ?? routes[0] ?? null;
  const claim = approvedCarolHandle();
  if (!route && claim) {
    // No demo wallet has a handle: claim the one the owner approved for carol.
    dWallets.chapter('Claim a handle for carol');
    await openIdentityHub(carol);
    const claimed = await claimHandle(carol, claim);
    expect(claimed, 'the claimed handle is not shown in the hub').not.toBeNull();
    handles.set(carol.name, claimed);
    recordFinding('setup', 'no demo wallet had a Smirk handle; the run claimed the owner-approved handle for carol (E2E_LIVE_CAROL_HANDLE)');
    route = { from: bob, to: carol, handle: claimed!, linked: await ensureLinkState(carol) };
  }
  if (!route) {
    recordFinding(
      'not-exercised',
      'none of alice, bob or carol has a Smirk handle, so name@domain delivery was not exercised (E2E_LIVE_CAROL_HANDLE with ALLOW_PROD_WRITES=1 claims one, with owner approval)',
    );
    test.skip(true, 'no demo wallet has a claimed Smirk handle to message by name@domain, and no handle claim was approved');
    return;
  }
  const { from, to, handle } = route;
  // What the wallet must learn from NIP-05: this handle IS the recipient's
  // seed identity, plus whatever relay hints the domain advertises.
  const resolved = await nip05Expectation(handle);
  expect(resolved, 'the handle does not resolve over NIP-05').not.toBeNull();
  expect(resolved!.pubkeyHex, 'the handle resolves to a key that is not the recipient\'s seed identity').toBe(to.pubkeyHex);
  const inbox = resolved!.relays.length > 0 || (await hasDmInbox(relay, to.pubkeyHex));

  await openMessages(to);
  await openMessages(from);
  requireDelivered([await deliver(from, to, from.npub, handle, runText('by handle', RUN), inbox)]);
});

test('background delivery collects a DM while Messages is closed and the Inbox shows it', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice, bob, carol } = dWallets;
  // The recipient must be one the relay delivers to.
  let recipient: DWallet | null = null;
  for (const w of [alice, bob]) if (await ensureLinkState(w)) { recipient = w; break; }
  if (!recipient) {
    recordFinding('not-exercised', 'neither alice nor bob is linked, so background delivery could not be exercised');
    test.skip(true, 'no linked demo wallet to receive a DM in the background');
    return;
  }
  dWallets.chapter('Background delivery to the Inbox');
  // Opening Messages arms the background watch for the recipient's npub; then close it.
  await openMessages(recipient);
  await goTab(recipient, 'home');
  await recipient.footage.settled('Messages closed');

  await openMessages(carol);
  const text = runText('while the screen is closed', RUN);
  const mark = carol.relayGuard.sentWraps.length;
  const outcome = await sendMessage(carol, recipient.npub, text);
  expect(outcome.status, `the wallet reported an error for a DM to a linked recipient: ${outcome.error ?? ''}`).toBe('sent');
  await carol.footage.result('message sent');
  const fresh = await findWraps(relay, recipient.pubkeyHex, publishedWraps(carol, mark, relay));
  expect(fresh.size, 'the relay holds none of the gift wraps carol just published for the recipient').toBeGreaterThan(0);

  // The service worker polls on an alarm (five minutes). It stores the wraps
  // still encrypted; nothing here decrypts them. The recipient's Home stays static.
  const target = recipient;
  await expect
    .poll(async () => {
      const collected = new Set(await backgroundWrapIds(target));
      return [...fresh.keys()].every((id) => collected.has(id));
    }, {
      timeout: 8 * 60_000,
      intervals: [10_000],
      message: 'the background poller never collected the DM while Messages was closed',
    })
    .toBe(true);
  // It raised its notification for exactly these wraps: its seen-set is written
  // right after the notification is created.
  const notified = new Set(await notifiedWrapIds(target));
  expect([...fresh.keys()].every((id) => notified.has(id)), 'the background poller collected the DM but raised no notification for it').toBe(true);
  recordFinding(
    'scope',
    'v0.3.1 shows no unread badge for DMs in the Inbox; background delivery is a system notification plus the decrypted list on the next open of Messages',
  );
  await recipient.footage.result('collected in the background');

  // The Inbox's Messages entry shows it, decrypted, on the next open, from the
  // collected wraps ALONE: the page's live gift-wrap subscription is held at the
  // socket while Messages reopens, so the relay cannot hand the DM over again.
  const heldBefore = recipient.relayGuard.heldWrapReads;
  recipient.relayGuard.holdWrapReads = true;
  try {
    await openMessages(recipient);
    await expectMessage(recipient, carol.npub, text, 60_000);
    expect(
      recipient.relayGuard.heldWrapReads,
      'Messages opened no live subscription to hold, so the display cannot be attributed to the collected wraps',
    ).toBeGreaterThan(heldBefore);
  } finally {
    recipient.relayGuard.holdWrapReads = false;
  }
});

test('a burner identity messages with proof-of-work and is picked to receive', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice, bob, carol } = dWallets;
  // The burner writes to a wallet the relay delivers to.
  let peer: DWallet | null = null;
  for (const w of [carol, alice]) if (await ensureLinkState(w)) { peer = w; break; }
  if (!peer) {
    recordFinding('not-exercised', 'neither carol nor alice is linked, so burner delivery could not be exercised');
    test.skip(true, 'no linked demo wallet to receive the burner\'s message');
    return;
  }
  await ensureLinkState(bob);
  dWallets.chapter('Burner identity');
  await openIdentityHub(bob);
  const burnerHex = await addBurner(bob);
  const burnerNpub = hexToNpub(burnerHex);
  // Adding a burner never switches the active identity behind the user's back.
  await expect(bob.page.getByTestId('nostr-npub')).toHaveText(bob.npub);

  await openMessages(peer);
  await openMessages(bob);
  await chooseMessagingIdentity(bob, burnerNpub);

  // Burner to the peer: the relay knows nothing of this key, so delivery rides
  // on the NIP-13 work the wallet mines. The peer sees the burner, never bob.
  dWallets.chapter('Burner sends with proof-of-work');
  if (powBits === 0) recordFinding('not-exercised', 'the relay advertises no inbound proof-of-work, so PoW mining was not exercised');
  const records: DmRecord[] = [];
  records.push(await deliver(bob, peer, burnerNpub, peer.npub, runText('from a burner', RUN)));

  // The peer replies to the burner. The operator relay admits gift wraps only
  // to linked npubs, so on a premium-post relay this is refused by design; the
  // wallet must say so rather than claim delivery.
  dWallets.chapter('Reply to the burner');
  const reply = runText('reply to a burner', RUN);
  const mark = peer.relayGuard.sentWraps.length;
  const outcome = await sendMessage(peer, burnerNpub, reply);
  const offered = publishedWraps(peer, mark, relay);
  if (outcome.status === 'sent') {
    await peer.footage.result('reply sent');
    expect((await findWraps(relay, burnerHex, offered)).size, 'the wallet reported success but the relay holds none of its wraps for the burner').toBeGreaterThan(0);
    await expectMessage(bob, peer.npub, reply);
    // The reply belongs to the burner's inbox only.
    await chooseMessagingIdentity(bob, bob.npub);
    await expect(bob.page.getByTestId('message-item').filter({ hasText: reply })).toHaveCount(0);
  } else {
    expect(outcome.error ?? '', 'the refusal does not say why').toMatch(/refused|registered|proof-of-work|reach/i);
    await peer.footage.result('relay refused the reply');
    recordFinding(
      'release-question',
      'the operator relay refuses gift wraps addressed to an unregistered key, so a burner can send but cannot receive replies there. The wallet reports the refusal honestly; whether v0.3.1 ships burners that cannot be answered is for the owner.',
    );
    expect((await findWraps(relay, burnerHex, offered, 10_000)).size, 'the relay stored a wrap the wallet said was refused').toBe(0);
    await expect(bob.page.getByTestId('message-item').filter({ hasText: reply })).toHaveCount(0);
    await bob.footage.settled('no reply for the burner');
    await chooseMessagingIdentity(bob, bob.npub);
  }

  // Picking the seed identity again receives as it: the peer writes to bob's npub.
  dWallets.chapter('Receive as the seed identity');
  records.push(await deliver(peer, bob, peer.npub, bob.npub, runText('picker back to the seed identity', RUN)));
  requireDelivered(records);
});

test('an unregistered external identity reaches a linked wallet only with proof-of-work', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice, bob, carol } = dWallets;
  let target: DWallet | null = null;
  for (const w of [alice, bob, carol]) if (await ensureLinkState(w)) { target = w; break; }
  if (!target) {
    recordFinding('not-exercised', 'no demo wallet is linked, so inbound delivery from outside Smirk could not be exercised');
    test.skip(true, 'no linked demo wallet to receive from outside Smirk');
    return;
  }
  dWallets.chapter('Inbound from outside Smirk');
  const external = createExternalIdentity();
  for (const form of externalSecretForms(external)) dWallets.watchSecret(form);
  await openMessages(target);

  // Without work the relay refuses an unknown author outright (Node side).
  const bare = runText('external without proof-of-work', RUN);
  const refused = await sendFromExternal(relay, dWallets.relayPins, external, target.pubkeyHex, bare, 0);
  if (powBits > 0) {
    expect(refused.ok, 'the relay admitted an unknown author without the proof-of-work it advertises').toBe(false);
    if (!refused.ok) expect(refused.refusal).toMatch(/proof-of-work/i);
    expect((await findWraps(relay, target.pubkeyHex, refused.ids, 10_000)).size, 'the relay stored the wrap it refused').toBe(0);
  } else {
    recordFinding('not-exercised', 'the relay advertises no inbound proof-of-work, so the refusal without it was not exercised');
  }

  // With work (at least 8 bits, as other Nostr clients would mine) it arrives.
  const bits = Math.max(8, powBits);
  const text = runText('external with proof-of-work', RUN);
  const sent = await sendFromExternal(relay, dWallets.relayPins, external, target.pubkeyHex, text, bits);
  expect(sent.ok, 'the relay refused a mined gift wrap to a linked user').toBe(true);
  const stored = await findWraps(relay, target.pubkeyHex, sent.ids);
  expect(stored.size, 'the relay holds none of the wraps the external identity sent').toBeGreaterThan(0);
  for (const got of stored.values()) expect(got, 'the stored wrap carries less work than was mined').toBeGreaterThanOrEqual(bits);

  await expectMessage(target, external.npub, text);
  if (powBits > 0) {
    await expect(target.page.getByTestId('message-item').filter({ hasText: bare })).toHaveCount(0);
  }
});

test('messaging an unregistered external npub never claims delivery', async ({ dWallets }) => {
  requireGiftWrapRelay(dWallets);
  const { alice } = dWallets;
  dWallets.chapter('Outbound to outside Smirk');
  const external = createExternalIdentity();
  for (const form of externalSecretForms(external)) dWallets.watchSecret(form);
  expect(await hasDmInbox(relay, external.pubkeyHex), 'a brand new key cannot have an inbox').toBe(false);

  await openMessages(alice);
  const text = runText('to an outside npub', RUN);
  const blockedBefore = alice.relayGuard.blocked.length;
  const outcome = await sendMessage(alice, external.npub, text);
  // Plain success would be a lie: the recipient reads nowhere we know of.
  expect(outcome.status === 'error' || outcome.notice, 'the wallet reported plain success to a recipient it cannot reach').toBe(true);
  if (outcome.status === 'error') {
    expect(outcome.error ?? '', 'the error does not say why').toMatch(/refused|registered|reach/i);
    await alice.footage.result('relay refused delivery');
    expect(await externalInboxTexts(relay, external), 'the relay stored a message the wallet said was refused').not.toContain(text);
    recordFinding(
      'release-question',
      'the operator relay refuses DMs to keys no Smirk account owns, so a v0.3.1 user cannot message an outside Nostr user through it; the wallet reports the refusal honestly',
    );
  } else {
    await alice.footage.result('reach notice shown');
  }
  // The refusal came from the relay, not the test's guard: only a gift wrap left.
  expect(alice.relayGuard.blocked.length, 'the wallet tried to publish a kind the live lane does not admit').toBe(blockedBefore);
});

test('Messages has no payment-request message type in v0.3.1', async ({ dWallets }) => {
  const { alice } = dWallets;
  dWallets.chapter('No in-chat payment requests');
  const state = await openMessages(alice);
  test.skip(state === 'off', 'the backend advertises no relay, so the compose surface is absent');
  const screen = alice.page.getByTestId('messages-screen');
  // The compose surface is exactly recipient, text and send.
  await expect(screen.locator('[data-testid*="pay"], [data-testid*="request"], [data-testid*="invoice"], [data-testid*="tip"]')).toHaveCount(0);
  await expect(screen.locator('input, textarea')).toHaveCount(2);
  await alice.footage.result('compose has no payment request');
  recordFinding('scope', 'in-chat payments in v0.3.1 ride Grin over Nostr (area B) and npub tips (area C); Messages carries text only');
});

test('the feed shows the operator notes with the mute list applied, and posting stays gated', async ({ dWallets }) => {
  const { alice, bob, carol } = dWallets;
  dWallets.chapter('Feed');
  if (!caps.features?.feed || !caps.feed) {
    for (const w of [alice, bob, carol]) {
      await goTab(w, 'home');
      await expect(w.page.getByTestId('nav-tab-feed'), 'a feed-less backend must not show the Feed tab').toHaveCount(0);
    }
    return;
  }
  const feed = caps.feed;
  let blocked = 0;
  let posted = 0;
  for (const w of [alice, bob, carol]) {
    await goTab(w, 'feed');
    await expect(w.page.getByTestId('feed-note').first().or(w.page.getByTestId('feed-empty'))).toBeVisible({ timeout: 90_000 });
    await w.footage.settled('feed loaded');

    // The rendered feed is exactly what the client rules compute from the relay.
    const expected = await feedExpectation(feed);
    const rendered = w.page.getByTestId('feed-note');
    if (expected.notes.length === 0) {
      await expect(w.page.getByTestId('feed-empty')).toBeVisible();
    } else {
      await expect(rendered, 'the feed rendered a different number of notes than the relay serves').toHaveCount(expected.notes.length, { timeout: 30_000 });
      for (const note of expected.notes.slice(0, 10)) {
        await expect(rendered.filter({ hasText: feedAuthorLabel(note) }).filter({ hasText: note.content.slice(0, 40) }).first()).toBeVisible();
      }
    }
    // Muted authors and notes never render.
    for (const hidden of expected.hiddenByMutes) {
      await expect(rendered.filter({ hasText: hidden.content.slice(0, 40) }).filter({ hasText: feedAuthorLabel(hidden) })).toHaveCount(0);
    }
    if (w === alice) {
      if (!expected.muteListPublished) recordFinding('not-exercised', 'the feed owner has published no NIP-51 mute list, so mute filtering was not exercised on this relay');
      else if (!expected.hiddenByMutes.length) recordFinding('not-exercised', 'the owner mute list hides nothing currently on the relay');
    }
    await w.footage.result('feed rendered');

    // Posting rights come from the server: exactly one of composer or notice.
    const composer = w.page.getByTestId('feed-compose');
    const needsPremium = w.page.getByTestId('feed-needs-premium');
    await expect(composer.or(needsPremium)).toBeVisible({ timeout: 30_000 });
    const canPost = await composer.isVisible();
    expect(canPost !== (await needsPremium.isVisible()), 'the feed showed both a composer and the premium notice, or neither').toBe(true);
    if (!canPost) {
      blocked++;
      await expect(needsPremium).toContainText(/premium/i);
      if (await w.page.getByTestId('feed-premium-plans').isVisible().catch(() => false)) {
        await expect(w.page.getByTestId('premium-buy').or(w.page.getByTestId('premium-redeem')).first()).toBeVisible();
      }
      await w.footage.result('posting needs premium');
      continue;
    }
    if (!liveFeedPostApproved() || posted > 0) {
      recordFinding('not-exercised', 'a demo wallet may post to the feed, but no public note was approved for this run');
      continue;
    }
    // One approved public note, from a wallet the server lets post.
    w.relayGuard.notePostingVerified = true;
    const note = runText('approved feed note', RUN);
    await w.footage.type(composer, note, 'write a feed note');
    await w.footage.tap(w.page.getByTestId('feed-post'), 'post the note');
    await expect(rendered.filter({ hasText: note }), 'the posted note never appeared in the feed').toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => (await feedExpectation(feed)).notes.some((n) => n.content === note), {
      timeout: 90_000,
      message: 'the relay does not serve the note the feed showed as posted',
    }).toBe(true);
    posted++;
    w.relayGuard.notePostingVerified = false;
    await w.footage.result('note posted');
  }
  if (blocked === 0) recordFinding('not-exercised', 'every demo wallet may post, so the premium notice for a non-premium author was not shown');
  // No public note left any wallet unless one was approved and posted.
  const notes = [alice, bob, carol].reduce((n, w) => n + (w.relayGuard.forwarded[1] ?? 0), 0);
  if (posted === 0) expect(notes, 'a public note left a wallet without approval').toBe(0);
  else expect(notes, 'the approved note never reached the relay socket').toBeGreaterThanOrEqual(posted);
});
