/**
 * Node-side gift-wrap forge for the forged-tip refusal scenario.
 *
 * Anyone can gift-wrap a "tip" to any npub, so the recipient's Inbox must never
 * trust wrap content: it rebuilds each row from the backend's public tip record
 * and keeps a candidate only when its claim key opens that record's sealed key.
 * This forge produces the two attacks that check covers:
 *
 *   - reused tip id: a real tip's id with a well-formed claim key that does not
 *     open it (must not appear, and must not shadow the genuine wrap);
 *   - unknown tip id: an id the backend has never seen (must not appear).
 *
 * Each wrap is a real NIP-59 envelope: a kind-14 payment rumor, sealed (kind 13)
 * by a fresh burner identity, wrapped (kind 1059) under a separate ephemeral
 * key with NIP-13 proof of work on the wrap, as the relay requires from an
 * unknown author. Burner and ephemeral keys live only in memory and are zeroed
 * after use; the forged claim key is random and opens nothing.
 *
 * This file imports only packages (no local modules), so its offline test can
 * load it outside Playwright: `node --import tsx --test fixtures/C-tips-forge.test.mjs`.
 */
import { randomUUID } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { getPow } from 'nostr-tools/nip13';
import {
  GIFT_WRAP_KIND,
  buildPaymentRumor,
  generateBurnerIdentity,
  generateUrlFragmentKey,
  sealNpubTipClaimKey,
  verifyNpubTipKey,
  type TipPayload,
} from '@smirk/core';

/** The relay's admission floor for a gift wrap from an unknown author. */
export const FORGE_POW_BITS = 8;

export type ForgeKind = 'reused-tip-id' | 'unknown-tip-id';

export interface SignedWrap {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface ForgedTipWrap {
  kind: ForgeKind;
  tipId: string;
  /** The burner that signed the seal: the sender a forged row would claim. */
  burnerPubkeyHex: string;
  memo: string;
  event: SignedWrap;
}

export interface ForgeOptions {
  /** x-only hex pubkey of the target (bob). */
  recipientPubkeyHex: string;
  kind: ForgeKind;
  /** For `reused-tip-id`: the real tip's id. */
  tipId?: string;
  /** For `reused-tip-id`: the backend's sealed key, to prove the forged key cannot open it. */
  encryptedKeyHex?: string | null;
  asset: string;
  /** Atomic units the forged wrap claims (attacker-controlled, never trusted). */
  amount: number;
  /** A static marker the Inbox must never show. */
  memo: string;
  powBits?: number;
  /** Unix seconds; defaults to a week from now. */
  expiresAt?: number;
}

/**
 * Wrap a sealed event under a fresh ephemeral key, mining the NIP-13 nonce over
 * the wrap only. The NIP-59 backdated timestamp is kept (only the nonce varies),
 * matching the wallet's own wrapWithPow.
 */
export function mineWrap(seal: object, recipientPubkeyHex: string, bits: number): SignedWrap {
  const ephemeral = generateSecretKey();
  try {
    const base = {
      kind: GIFT_WRAP_KIND,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(ephemeral, recipientPubkeyHex)),
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172_800),
      pubkey: getPublicKey(ephemeral),
    };
    const tags: string[][] = [['p', recipientPubkeyHex]];
    if (bits > 0) {
      const nonce = ['nonce', '0', String(bits)];
      tags.push(nonce);
      for (let count = 1; ; count++) {
        nonce[1] = String(count);
        if (getPow(getEventHash({ ...base, tags })) >= bits) break;
      }
    }
    const { pubkey: _ephemeralPubkey, ...unsigned } = base;
    return finalizeEvent({ ...unsigned, tags }, ephemeral) as SignedWrap;
  } finally {
    ephemeral.fill(0);
  }
}

/** Forge one tip gift wrap addressed to the recipient. */
export function forgeTipWrap(options: ForgeOptions): ForgedTipWrap {
  const recipient = options.recipientPubkeyHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recipient)) throw new Error('the recipient must be an x-only hex pubkey');
  const tipId = options.kind === 'unknown-tip-id' ? randomUUID() : options.tipId;
  if (!tipId) throw new Error('a reused-tip-id forgery needs the real tip id');
  const burner = generateBurnerIdentity();
  try {
    // A well-formed claim key that is not the tip's: it opens nothing.
    const wrongClaimKey = generateUrlFragmentKey().encoded;
    if (options.encryptedKeyHex && verifyNpubTipKey(options.encryptedKeyHex, wrongClaimKey)) {
      throw new Error('the forged claim key unexpectedly opens the real tip');
    }
    const payload: TipPayload = {
      type: 'tip',
      v: 1,
      asset: options.asset,
      amount: options.amount,
      tipId,
      sealedClaimKey: sealNpubTipClaimKey(burner.privateKey, recipient, tipId, wrongClaimKey),
      memo: options.memo,
      expiresAt: options.expiresAt ?? Math.floor(Date.now() / 1000) + 7 * 86_400,
    };
    const rumor = createRumor(
      buildPaymentRumor(payload, recipient) as unknown as Parameters<typeof createRumor>[0],
      burner.privateKey,
    );
    const seal = createSeal(rumor, burner.privateKey, recipient);
    const event = mineWrap(seal, recipient, options.powBits ?? FORGE_POW_BITS);
    return { kind: options.kind, tipId, burnerPubkeyHex: burner.pubkeyHex, memo: options.memo, event };
  } finally {
    burner.privateKey.fill(0);
  }
}

/** Leading zero bits of a wrap's id (NIP-13). */
export function wrapPow(event: SignedWrap): number {
  return getPow(event.id);
}

export interface PublishResult {
  accepted: boolean;
  /** The relay's own reason, verbatim (it never contains wrap content). */
  message: string;
}

/**
 * The ids of every kind-1059 wrap `relayUrl` returns for `#p` = the recipient,
 * read until EOSE. Read only: proves a published wrap is retrievable the way
 * the recipient's Inbox asks for it, and (compared before and after a send)
 * that a delivery reached that relay. NIP-59 backdates `created_at`, so ids,
 * not timestamps, identify new wraps.
 */
export async function queryWrapIds(
  relayUrl: string,
  recipientPubkeyHex: string,
  options: { ids?: string[]; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  // With `ids` the relay answers for exactly those wraps, AND-ed with the #p
  // filter, so a busy inbox past the relay's result limit cannot hide them.
  const filter: Record<string, unknown> = { kinds: [1059], '#p': [recipientPubkeyHex] };
  if (options.ids?.length) filter.ids = options.ids;
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error('the forge reads only over ws:// or wss://');
  if (!/^[0-9a-f]{64}$/.test(recipientPubkeyHex)) throw new Error('the recipient must be an x-only hex pubkey');
  const sub = `c-tips-${randomUUID().slice(0, 8)}`;
  return new Promise<Set<string>>((resolve, reject) => {
    const ids = new Set<string>();
    const socket = new WebSocket(relayUrl);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify(['CLOSE', sub]));
        socket.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`relay ${relayUrl} did not finish the query in time`))), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', sub, filter]));
    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame) || frame[1] !== sub) return;
      if (frame[0] === 'EVENT' && typeof (frame[2] as { id?: unknown })?.id === 'string') ids.add((frame[2] as { id: string }).id);
      else if (frame[0] === 'EOSE') finish(() => resolve(ids));
      else if (frame[0] === 'CLOSED') finish(() => reject(new Error(`relay ${relayUrl} closed the query: ${String(frame[2] ?? '')}`)));
    };
    socket.onerror = () => finish(() => reject(new Error(`could not connect to relay ${relayUrl}`)));
    socket.onclose = () => finish(() => reject(new Error(`relay ${relayUrl} closed before EOSE`)));
  });
}

/**
 * Publish one wrap to `relayUrl` and wait for the relay's OK. The caller decides
 * the target: only the first-party relay the backend under test advertises,
 * and a non-local relay only behind the live lane's explicit write gates.
 */
export async function publishWrap(relayUrl: string, event: SignedWrap, timeoutMs = 30_000): Promise<PublishResult> {
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error('the forge publishes only over ws:// or wss://');
  return new Promise<PublishResult>((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`relay ${relayUrl} did not answer the publish in time`))),
      timeoutMs,
    );
    socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]));
    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (Array.isArray(frame) && frame[0] === 'OK' && frame[1] === event.id) {
        finish(() => resolve({ accepted: frame[2] === true, message: String(frame[3] ?? '') }));
      }
    };
    socket.onerror = () => finish(() => reject(new Error(`could not connect to relay ${relayUrl}`)));
    socket.onclose = () => finish(() => reject(new Error(`relay ${relayUrl} closed before answering`)));
  });
}
