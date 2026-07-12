/**
 * SlatepackChannel — the transport seam for interactive Grin value transfer
 * (P3, the Goblin convergence). One logical operation ("deliver a slatepack to a
 * counterparty, collect their response, settle or cancel") behind two transports:
 *
 *   - {@link BackendRelayChannel}  — the backend's `/wallet/grin/relay/*` store-
 *     and-forward (same-backend recipients; the server sees amount + counterparties
 *     in the clear). The legacy path, kept as a fallback.
 *   - {@link NostrGiftwrapChannel} — NIP-59 gift-wraps over Nostr relays
 *     (recipients addressed by npub; the relay sees only ciphertext). The default
 *     when the recipient is Nostr-addressable, and the rail Goblin already speaks,
 *     so Smirk↔Goblin Grin payments interoperate by construction.
 *
 * Grin send/receive flows + the Inbox consume this interface, so which wire a
 * payment rides is a routing decision, not a code fork. Relay I/O for the Nostr
 * channel is injected ({@link NostrChannelIO}) so this module stays pure + unit-
 * testable without a live relay.
 */

import type { GrinMethods } from '../api/grin';
import type { NostrIdentity } from '../nostr/identity';
import type { NostrWireEvent, NostrFilter } from '../nostr/client';
import { wrapPayment, unwrapPayment } from '../nostr/giftwrap';
import { GIFT_WRAP_KIND, type GrinSlatepackPayload, type TipPayload } from '../nostr/payments';

export type ChannelKind = 'nostr' | 'backend';

/** A slatepack to hand to a counterparty. Addressing is per-transport: the Nostr
 *  channel uses `recipientPubkeyHex`, the backend channel uses `recipientUserId`. */
export interface OutboundSlatepack {
  slateId: string;
  slatepack: string;
  amountNanogrin: number;
  memo?: string;
  recipientPubkeyHex?: string;
  recipientUserId?: string;
}

/** Where an inbound slatepack sits in the exchange: the recipient must respond
 *  (`to-sign`), or the original sender must finalize the response (`to-finalize`). */
export type InboundStage = 'to-sign' | 'to-finalize';

/** A pending slatepack, normalized across transports for a unified Inbox. */
export interface InboundSlatepack {
  channel: ChannelKind;
  /** Stable id = slateId (both transports key on it). */
  id: string;
  slateId: string;
  /** The counterparty: their npub-hex (nostr) or user_id (backend). Needed to
   *  address a `respond`/`cancel` back to them on the Nostr channel. */
  counterpartyRef: string;
  slatepack: string;
  amountNanogrin: number;
  /** Unix seconds. */
  createdAt: number;
  expiresAt?: number;
  stage: InboundStage;
}

/**
 * A transport for interactive Grin slatepack exchange. `respond`/`cancel` take an
 * optional `counterpartyRef` (an npub-hex): REQUIRED by the Nostr channel to
 * address the reply, IGNORED by the backend channel (which routes by slate_id +
 * bearer token).
 */
export interface SlatepackChannel {
  readonly kind: ChannelKind;
  deliver(msg: OutboundSlatepack): Promise<{ id: string }>;
  inbox(): Promise<InboundSlatepack[]>;
  respond(slateId: string, responseSlatepack: string, counterpartyRef?: string): Promise<void>;
  cancel(slateId: string, counterpartyRef?: string): Promise<void>;
  /**
   * Notify the counterparty that the exchange is settled (the sender broadcast
   * the final tx). Called after a SUCCESSFUL broadcast so the exchange retires
   * on the wire rather than only optimistically in the UI:
   *   - Nostr: publishes the `finalize` settlement gift-wrap to `counterpartyRef`
   *     AND to ourselves (was never sent → both sides only retired inbox items
   *     optimistically; the self-addressed copy retires the sender's own inbox).
   *   - Backend relay: flips the relay row via `relay/finalize` (`counterpartyRef`
   *     ignored; routed by slate_id + bearer token).
   * Best-effort — a settle failure must not undo an on-chain broadcast, so
   * callers should not throw on failure.
   *
   * `txHash` is the broadcast tx reference (the finalized kernel excess hex). The
   * backend relay records it on `relay/finalize`, whose handler REJECTS an empty
   * tx_hash (400); pass the real value so the row finalizes. The Nostr channel
   * ignores it (its finalize gift-wrap carries no tx hash).
   */
  settle(slateId: string, counterpartyRef?: string, txHash?: string): Promise<void>;
}

// ── Backend relay transport ─────────────────────────────────────────────────

/** Wraps the v3 `/wallet/grin/relay/*` API (see api/grin.ts) as a channel. */
export class BackendRelayChannel implements SlatepackChannel {
  readonly kind = 'backend' as const;

  constructor(private readonly deps: { grin: GrinMethods; userId: string }) {}

  async deliver(msg: OutboundSlatepack): Promise<{ id: string }> {
    if (!msg.recipientUserId) {
      throw new Error('backend relay requires a recipientUserId');
    }
    const res = await this.deps.grin.createGrinRelay({
      senderUserId: this.deps.userId,
      slatepack: msg.slatepack,
      slateId: msg.slateId,
      amount: msg.amountNanogrin,
      recipientUserId: msg.recipientUserId,
    });
    if (res.error || !res.data) throw new Error(res.error ?? 'relay create failed');
    return { id: res.data.id };
  }

  async inbox(): Promise<InboundSlatepack[]> {
    const res = await this.deps.grin.getGrinPendingSlatepacks(this.deps.userId);
    if (res.error || !res.data) return [];
    const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000) || 0;
    const map = (
      e: { id: string; slate_id: string; sender_user_id: string; amount: number; slatepack: string; created_at: string; expires_at: string },
      stage: InboundStage,
    ): InboundSlatepack => ({
      channel: 'backend',
      id: e.id,
      slateId: e.slate_id,
      counterpartyRef: e.sender_user_id,
      slatepack: e.slatepack,
      amountNanogrin: e.amount,
      createdAt: secs(e.created_at),
      expiresAt: secs(e.expires_at),
      stage,
    });
    return [
      ...res.data.pending_to_sign.map((e) => map(e, 'to-sign')),
      ...res.data.pending_to_finalize.map((e) => map(e, 'to-finalize')),
    ];
  }

  async respond(slateId: string, responseSlatepack: string): Promise<void> {
    const res = await this.deps.grin.signGrinSlatepack({
      relayId: slateId,
      userId: this.deps.userId,
      signedSlatepack: responseSlatepack,
    });
    if (res.error) throw new Error(res.error);
  }

  async cancel(slateId: string): Promise<void> {
    const res = await this.deps.grin.cancelGrinSlatepack({
      relayId: slateId,
      userId: this.deps.userId,
    });
    if (res.error) throw new Error(res.error);
  }

  /** Flip the relay row to finalized after the sender broadcast. Best-effort:
   *  a relay finalize failure must never undo the on-chain broadcast. */
  async settle(slateId: string, _counterpartyRef?: string, txHash?: string): Promise<void> {
    await this.deps.grin
      .finalizeGrinSlatepack({
        relayId: slateId,
        userId: this.deps.userId,
        // relay/finalize records a tx reference and REJECTS an empty tx_hash (400).
        // Prefer the real broadcast reference (finalized kernel excess hex); fall
        // back to the slate_id (a non-empty UUID) so the row still finalizes when a
        // caller has no hash to hand.
        finalizedSlatepack: txHash && txHash.length > 0 ? txHash : slateId,
      })
      .catch(() => undefined);
  }
}

// ── Nostr gift-wrap transport ───────────────────────────────────────────────

/** Injected relay I/O for the Nostr channel (real impl wraps the NostrClient). */
export interface NostrChannelIO {
  /** The active identity — signs seals, and is the `p`-tag we read our inbox by. */
  identity: NostrIdentity;
  publish(relays: string[], event: NostrWireEvent): Promise<void>;
  query(relays: string[], filters: NostrFilter[]): Promise<NostrWireEvent[]>;
  /** Relays to publish to for a recipient (their NIP-17 list ∪ the backend relay). */
  outboundRelays(recipientPubkeyHex: string): Promise<string[]>;
  /** Relays to read our own inbox from (the backend relay ∪ our NIP-17 list). */
  inboxRelays(): Promise<string[]>;
}

function grinPayload(
  role: GrinSlatepackPayload['role'],
  slateId: string,
  extra: Partial<Pick<GrinSlatepackPayload, 'slatepack' | 'amount' | 'memo'>> = {},
): GrinSlatepackPayload {
  return { type: 'grin-slatepack', v: 1, role, slateId, ...extra };
}

/**
 * Interactive Grin exchange over NIP-59 gift-wraps. There is no server-side
 * "pending" state: {@link inbox} reconstructs it from the stream of kind-1059
 * events addressed to us — the latest role per slateId wins, and a
 * `finalize`/`cancel` retires that slateId.
 */
export class NostrGiftwrapChannel implements SlatepackChannel {
  readonly kind = 'nostr' as const;

  constructor(private readonly io: NostrChannelIO) {}

  async deliver(msg: OutboundSlatepack): Promise<{ id: string }> {
    if (!msg.recipientPubkeyHex) {
      throw new Error('nostr channel requires a recipientPubkeyHex');
    }
    const payload = grinPayload('offer', msg.slateId, {
      slatepack: msg.slatepack,
      amount: msg.amountNanogrin,
      ...(msg.memo ? { memo: msg.memo } : {}),
    });
    await this.publishTo(msg.recipientPubkeyHex, payload);
    return { id: msg.slateId };
  }

  async inbox(): Promise<InboundSlatepack[]> {
    const relays = await this.io.inboxRelays();
    const wraps = await this.io.query(relays, [
      { kinds: [GIFT_WRAP_KIND], '#p': [this.io.identity.pubkeyHex] },
    ]);

    // Reconstruct per-slateId state: keep the newest role we've seen. Rumor
    // created_at is the true time (only seal/wrap timestamps are decoy-randomized).
    type Entry = { role: GrinSlatepackPayload['role']; sender: string; payload: GrinSlatepackPayload; at: number };
    const latest = new Map<string, Entry>();
    for (const wrap of wraps) {
      let opened;
      try {
        opened = unwrapPayment(this.io.identity, wrap);
      } catch {
        continue; // not for us, or not a payment
      }
      if (opened.payload.type !== 'grin-slatepack') continue;
      const p = opened.payload;
      const prev = latest.get(p.slateId);
      if (!prev || opened.rumorCreatedAt >= prev.at) {
        latest.set(p.slateId, {
          role: p.role,
          sender: opened.senderPubkeyHex,
          payload: p,
          at: opened.rumorCreatedAt,
        });
      }
    }

    const out: InboundSlatepack[] = [];
    for (const e of latest.values()) {
      // `offer` → we're the recipient and must respond; `response` → we're the
      // original sender and must finalize. finalize/cancel are terminal.
      const stage: InboundStage | null =
        e.role === 'offer' ? 'to-sign' : e.role === 'response' ? 'to-finalize' : null;
      if (!stage || !e.payload.slatepack) continue;
      out.push({
        channel: 'nostr',
        id: e.payload.slateId,
        slateId: e.payload.slateId,
        counterpartyRef: e.sender,
        slatepack: e.payload.slatepack,
        amountNanogrin: e.payload.amount ?? 0,
        createdAt: e.at,
        stage,
      });
    }
    return out;
  }

  async respond(slateId: string, responseSlatepack: string, counterpartyRef?: string): Promise<void> {
    if (!counterpartyRef) throw new Error('nostr respond requires the counterparty pubkey');
    await this.publishTo(counterpartyRef, grinPayload('response', slateId, { slatepack: responseSlatepack }));
  }

  async cancel(slateId: string, counterpartyRef?: string): Promise<void> {
    if (!counterpartyRef) throw new Error('nostr cancel requires the counterparty pubkey');
    await this.publishTo(counterpartyRef, grinPayload('cancel', slateId));
  }

  /** Push a settlement notice closing an exchange (S3 broadcast). */
  async finalizeNotice(slateId: string, counterpartyRef: string): Promise<void> {
    await this.publishTo(counterpartyRef, grinPayload('finalize', slateId));
  }

  /** Settlement notice after a successful broadcast — the wire-level S3 that was
   *  previously never sent (inbox items only retired optimistically). Requires
   *  `counterpartyRef` (the recipient's pubkey) to address the gift-wrap; a
   *  no-op without it so a manual/clipboard send never throws here.
   *
   *  Publishes the `finalize` to BOTH the counterparty AND ourselves: the sender
   *  broadcast the tx, but its own inbox still holds the counterparty's
   *  `response` gift-wrap, so without a self-addressed terminal marker inbox()
   *  would keep reconstructing that slateId as `to-finalize` forever. The
   *  self-addressed `finalize` (newest role wins) retires it on the sender side
   *  too — the whole exchange stays wire-driven, no local terminal state. */
  async settle(slateId: string, counterpartyRef?: string): Promise<void> {
    if (!counterpartyRef) return;
    await this.finalizeNotice(slateId, counterpartyRef);
    // Retire the exchange in our OWN inbox by self-addressing the finalize.
    await this.finalizeNotice(slateId, this.io.identity.pubkeyHex);
  }

  /** Send a tip to an npub over the same rail. Not part of the slatepack
   *  lifecycle, but the identical kind-1059 envelope. */
  async deliverTip(recipientPubkeyHex: string, tip: Omit<TipPayload, 'type' | 'v'>): Promise<void> {
    await this.publishTo(recipientPubkeyHex, { type: 'tip', v: 1, ...tip });
  }

  private async publishTo(
    recipientPubkeyHex: string,
    payload: GrinSlatepackPayload | TipPayload,
  ): Promise<void> {
    const wrap = wrapPayment(this.io.identity, recipientPubkeyHex, payload);
    const relays = await this.io.outboundRelays(recipientPubkeyHex);
    await this.io.publish(relays, wrap);
  }
}

/**
 * Pick the transport for a send. Prefer Nostr (private + Goblin-interoperable)
 * whenever the recipient is npub-addressable; fall back to the backend relay for
 * a same-backend recipient known only by user_id.
 */
export function selectSendChannel(
  recipient: { pubkeyHex?: string; userId?: string },
  channels: { nostr?: SlatepackChannel; backend?: SlatepackChannel },
): SlatepackChannel {
  if (recipient.pubkeyHex && channels.nostr) return channels.nostr;
  if (recipient.userId && channels.backend) return channels.backend;
  throw new Error('no channel available for this recipient');
}
