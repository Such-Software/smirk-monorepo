/**
 * Feed curation: the operator mute config and the owner's NIP-51 mute list keep
 * junk out of the default feed. Properties, not wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent } from 'nostr-tools/pure';

import { deriveNostrIdentity } from '../identity';
import type { NostrClient, NostrFilter, NostrWireEvent } from '../client';
import {
  MUTE_LIST_KIND,
  NostrNotes,
  applyFeedMutes,
  buildNoteEvent,
  feedSourcesFromCapability,
  muteListFrom,
  toDisplayNote,
  type DisplayNote,
} from '../notes';

const MNEMONIC =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';
const owner = deriveNostrIdentity(MNEMONIC, 0);
const spammer = deriveNostrIdentity(MNEMONIC, 1);
const member = deriveNostrIdentity(MNEMONIC, 2);
const RELAY = 'wss://relay.smirk.cash';

const muteList = (
  signer = owner,
  tags: string[][] = [['p', spammer.pubkeyHex]],
  createdAt = Math.floor(Date.now() / 1000),
): NostrWireEvent =>
  finalizeEvent(
    { kind: MUTE_LIST_KIND, created_at: createdAt, tags, content: '' },
    signer.privateKey,
  ) as unknown as NostrWireEvent;

const display = (e: NostrWireEvent): DisplayNote => toDisplayNote(e) as DisplayNote;

/** A relay that answers each filter from a fixed event set. */
function fakeClient(events: NostrWireEvent[]): NostrClient {
  const matches = (e: NostrWireEvent, f: NostrFilter): boolean =>
    (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey));
  return {
    querySync: async (_relays: string[], filters: NostrFilter[]) =>
      events.filter((e) => filters.some((f) => matches(e, f))),
  } as unknown as NostrClient;
}

test('an operator-muted author is hidden even when also allowlisted', () => {
  const { sources } = feedSourcesFromCapability({
    relay_url: RELAY,
    show_owner: true,
    show_premium: true,
    owner_npub: npubEncode(owner.pubkeyHex),
    allowlist_npubs: [npubEncode(spammer.pubkeyHex)],
    extra_relays: [],
    muted_npubs: [npubEncode(spammer.pubkeyHex), 'npub1notvalid'],
  });
  assert.ok(!sources.authors?.includes(spammer.pubkeyHex));
  assert.ok(sources.mutedAuthors?.includes(spammer.pubkeyHex));
  assert.equal(sources.moderator, owner.pubkeyHex);
});

test("only the moderator's own signed mute list counts", () => {
  const forged = muteList(member, [['p', owner.pubkeyHex]]);
  const mutes = muteListFrom([forged], owner.pubkeyHex);
  assert.equal(mutes.authors.size, 0);

  const tampered = { ...muteList(), tags: [['p', member.pubkeyHex]] };
  assert.equal(muteListFrom([tampered], owner.pubkeyHex).authors.size, 0);
});

test('the newest mute list replaces older ones', () => {
  const older = muteList(owner, [['p', member.pubkeyHex]], 1_000);
  const newer = muteList(owner, [['p', spammer.pubkeyHex]], 2_000);
  const mutes = muteListFrom([newer, older], owner.pubkeyHex);
  assert.ok(mutes.authors.has(spammer.pubkeyHex));
  assert.ok(!mutes.authors.has(member.pubkeyHex));
});

test('a mute list can hide a single note without hiding its author', () => {
  const keep = display(buildNoteEvent('real post', member));
  const drop = display(buildNoteEvent('oops', member));
  const mutes = muteListFrom([muteList(owner, [['e', drop.id]])], owner.pubkeyHex);
  const shown = applyFeedMutes([keep, drop], mutes, owner.pubkeyHex);
  assert.deepEqual(
    shown.map((n) => n.id),
    [keep.id],
  );
});

test('the moderator cannot mute their own announcements by mistake', () => {
  const announcement = display(buildNoteEvent('release notes', owner));
  const mutes = muteListFrom([muteList(owner, [['p', owner.pubkeyHex]])], owner.pubkeyHex);
  assert.equal(applyFeedMutes([announcement], mutes, owner.pubkeyHex).length, 1);
});

test('fetchFeed drops relay-general notes by muted authors and keeps the rest', async () => {
  const junk = buildNoteEvent('wdsa', spammer);
  const post = buildNoteEvent('hello', member);
  const news = buildNoteEvent('announcement', owner);
  const notes = new NostrNotes(fakeClient([junk, post, news, muteList()]));
  const { sources } = feedSourcesFromCapability({
    relay_url: RELAY,
    show_owner: true,
    show_premium: true,
    owner_npub: npubEncode(owner.pubkeyHex),
    allowlist_npubs: [],
    extra_relays: [],
  });
  const feed = await notes.fetchFeed(sources, RELAY);
  const ids = new Set(feed.map((n) => n.id));
  assert.ok(!ids.has(junk.id));
  assert.ok(ids.has(post.id) && ids.has(news.id));
});

test('a relay that cannot answer the mute query still shows the feed', async () => {
  const post = buildNoteEvent('hello', member);
  const client = {
    querySync: async (_r: string[], filters: NostrFilter[]) => {
      if (filters.some((f) => f.kinds?.includes(MUTE_LIST_KIND))) throw new Error('down');
      return [post];
    },
  } as unknown as NostrClient;
  const { sources } = feedSourcesFromCapability({
    relay_url: RELAY,
    show_owner: true,
    show_premium: true,
    owner_npub: npubEncode(owner.pubkeyHex),
    allowlist_npubs: [],
    extra_relays: [],
  });
  const feed = await new NostrNotes(client).fetchFeed(sources, RELAY);
  assert.ok(feed.some((n) => n.id === post.id));
});
