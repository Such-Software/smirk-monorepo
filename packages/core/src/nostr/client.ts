/**
 * `NostrClient`: the shared Nostr transport.
 *
 * A thin wrapper over nostr-tools' `SimplePool` (browser global WebSocket) that
 * owns relay connections and offers generic publish / subscribe / query. DMs
 * (NIP-17) and the notes/feed plane both ride this one client so there is a single
 * relay-management and event-I/O path. No fork. The DM provider can migrate onto
 * it later as a behavior-zero refactor.
 *
 * This layer is transport-only: it does not know about kinds, identities, or
 * policy. Higher modules (`notes.ts`, the DM provider) build events and decide
 * relays; the client just moves bytes.
 */

import { SimplePool } from 'nostr-tools/pool';

/** A signed Nostr event as it travels on the wire (the shape both nostr-tools and
 *  our higher modules produce/consume). Kept minimal + structural on purpose. */
export interface NostrWireEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A relay subscription filter (NIP-01). `#t` etc. are hashtag/tag filters. */
export type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | undefined;
};

export interface NostrSubscription {
  close(): void;
}

export class NostrClient {
  private pool = new SimplePool();
  /** Relays we've touched, so `close()` releases exactly them. */
  private relaysSeen = new Set<string>();

  /** Publish a signed event to every relay; resolves once at least one accepts,
   *  throws only if ALL fail (the same tolerance the DM path uses). */
  async publish(relays: string[], event: NostrWireEvent): Promise<void> {
    relays.forEach((r) => this.relaysSeen.add(r));
    const results = await Promise.allSettled(
      this.pool.publish(relays, event as Parameters<SimplePool['publish']>[1]),
    );
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw new Error('failed to publish to any relay');
    }
  }

  /** Live subscription across relays for a single filter. */
  subscribe(
    relays: string[],
    filter: NostrFilter,
    onEvent: (event: NostrWireEvent) => void,
  ): NostrSubscription {
    relays.forEach((r) => this.relaysSeen.add(r));
    const sub = this.pool.subscribeMany(relays, filter as never, {
      onevent: (evt: unknown) => onEvent(evt as NostrWireEvent),
    });
    return { close: () => sub.close() };
  }

  /** One-shot query (REQ→EOSE) across relays for one or more filters, merged and
   *  de-duplicated by event id. Survives SW eviction better than a live sub. */
  async querySync(relays: string[], filters: NostrFilter[]): Promise<NostrWireEvent[]> {
    relays.forEach((r) => this.relaysSeen.add(r));
    const batches = await Promise.all(
      filters.map((f) => this.pool.querySync(relays, f as never)),
    );
    const byId = new Map<string, NostrWireEvent>();
    for (const batch of batches) {
      for (const evt of batch as unknown as NostrWireEvent[]) {
        if (evt?.id && !byId.has(evt.id)) byId.set(evt.id, evt);
      }
    }
    return [...byId.values()];
  }

  /** Release every relay this client opened. */
  close(): void {
    this.pool.close([...this.relaysSeen]);
    this.relaysSeen.clear();
  }
}
