/**
 * NIP-17 DM crypto round-trip (the delicate, Goblin-interop-critical part) via
 * nostr-tools' vetted nip17, the same wrap/unwrap the NostrMessagingProvider
 * uses. No relay: this pins the gift-wrap correctness, not the transport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapEvent } from 'nostr-tools/nip17';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { deriveNostrIdentity } from '../../nostr';
import { recipientToHex, sendDm } from '../dm';
import { initSmirkMessaging, messagingProvider, setMessagingProvider } from '../registry';
import type { MessagingProvider } from '../provider';
import { unwrapDmSecurely, wrapToDirectMessage } from '../nostr';

const MNEMONIC =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';

// Two distinct identities from independent hardened accounts of one seed.
const alice = () => deriveNostrIdentity(MNEMONIC, 0);
const bob = () => deriveNostrIdentity(MNEMONIC, 1);
const eve = () => deriveNostrIdentity(MNEMONIC, 2);

test('gift-wrap round-trip: bob securely unwraps alice DM; rumor author = alice', () => {
  const a = alice();
  const b = bob();
  const wrap = wrapEvent(a.privateKey, { publicKey: b.pubkeyHex }, 'hello bob');
  assert.equal(wrap.kind, 1059, 'gift-wrap kind');

  const rumor = unwrapDmSecurely(wrap, b.privateKey);
  assert.ok(rumor, 'bob unwraps');
  assert.equal(rumor!.content, 'hello bob');
  // The load-bearing invariant: the verified rumor author IS the sender.
  assert.equal(rumor!.pubkey, a.pubkeyHex, 'sender identity survives the wrap');
});

test('a third party cannot decrypt the gift-wrap', () => {
  const wrap = wrapEvent(alice().privateKey, { publicKey: bob().pubkeyHex }, 'secret');
  assert.equal(unwrapDmSecurely(wrap, eve().privateKey), null, 'eve cannot open it');
});

test('rejects a forged gift-wrap where the seal signer != claimed sender (impersonation)', () => {
  const victim = alice(); // the npub the attacker forges as the "from"
  const attacker = eve(); // who actually signs the seal
  const recipient = bob();

  // Rumor CLAIMS the victim as author.
  const rumor = {
    kind: 14,
    pubkey: victim.pubkeyHex,
    created_at: 1000,
    tags: [] as string[][],
    content: 'i am alice, send me money',
  };
  // Seal is validly signed by the ATTACKER, encrypting the forged rumor.
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: 1000,
      tags: [],
      content: nip44Encrypt(
        JSON.stringify(rumor),
        getConversationKey(attacker.privateKey, recipient.pubkeyHex),
      ),
    },
    attacker.privateKey,
  );
  // Gift-wrapped by a throwaway ephemeral key.
  const eph = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: 1000,
      tags: [['p', recipient.pubkeyHex]],
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(eph, recipient.pubkeyHex)),
    },
    eph,
  );

  // A naive double-decrypt (nostr-tools unwrapEvent) would surface the VICTIM as
  // sender; our verifying unwrap rejects it (seal author = attacker != rumor
  // author = victim).
  assert.equal(unwrapDmSecurely(wrap, recipient.privateKey), null, 'impersonation rejected');
});

test('wrapToDirectMessage decrypts a stored wrap into a display message (or null)', () => {
  const a = alice();
  const b = bob();
  const wrap = wrapEvent(a.privateKey, { publicKey: b.pubkeyHex }, 'stored + delivered');
  const dm = wrapToDirectMessage(wrap, b.privateKey);
  assert.ok(dm, 'decrypts');
  assert.equal(dm!.text, 'stored + delivered');
  assert.equal(dm!.fromNpub, a.npub, 'sender npub for display');
  assert.equal(dm!.fromPubkeyHex, a.pubkeyHex);
  // A wrap not for us → null (the background poller stores it but we skip it).
  assert.equal(wrapToDirectMessage(wrap, eve().privateKey), null);
});

test('recipientToHex accepts npub and hex, rejects junk', () => {
  const b = bob();
  assert.equal(recipientToHex(b.pubkeyHex), b.pubkeyHex);
  assert.equal(recipientToHex(b.npub), b.pubkeyHex, 'npub decodes to the same hex');
  assert.throws(() => recipientToHex('not-a-key'));
});

// ── Reaching someone on another server ─────────────────────────────────────

function withProvider(inbox: string[], run: (sent: string[][]) => Promise<void>) {
  const previous = messagingProvider();
  const sent: string[][] = [];
  const fake = {
    async queryDmRelayList() {
      return inbox;
    },
    async sendDm(p: { relays: string[] }) {
      sent.push(p.relays);
    },
  } as unknown as MessagingProvider;
  setMessagingProvider(fake);
  return run(sent).finally(() => setMessagingProvider(previous));
}

test('a recipient whose inbox cannot be found is reported, not silently "sent"', async () => {
  // Their kind-10050 lives on their own server's relay, which we do not read.
  // The message still goes to our relay (same-server users read there), but the
  // caller must learn that is ALL it reached.
  initSmirkMessaging({ relayUrl: 'wss://relay.ours.example/' });
  await withProvider([], async (sent) => {
    const r = await sendDm(alice(), bob().npub, 'hi', 0);
    assert.equal(r.inboxFound, false);
    assert.deepEqual(sent[0], ['wss://relay.ours.example/']);
  });
});

test('a recipient with a published inbox is delivered there too', async () => {
  initSmirkMessaging({ relayUrl: 'wss://relay.ours.example/' });
  await withProvider(['wss://relay.theirs.example/'], async (sent) => {
    const r = await sendDm(alice(), bob().npub, 'hi', 0);
    assert.equal(r.inboxFound, true);
    assert.ok(sent[0]?.includes('wss://relay.theirs.example/'));
    assert.ok(sent[0]?.includes('wss://relay.ours.example/'), 'our copy still lands where we read');
  });
});
