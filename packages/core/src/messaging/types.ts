/**
 * Messaging-plane types — backend-agnostic (independent of Nostr specifics), so a
 * future MessagingProvider (or another protocol) can implement the same shapes.
 */

/** A decrypted direct message ready for the UI. */
export interface DirectMessage {
  /** The inner (kind-14) rumor event id — stable per message. */
  id: string;
  /** Sender's x-only pubkey hex (the rumor author; verified against the seal). */
  fromPubkeyHex: string;
  /** Sender's npub (bech32), for display. */
  fromNpub: string;
  /** Plaintext message body. */
  text: string;
  /** Unix seconds (rumor created_at). */
  createdAt: number;
}

/** A live subscription; call `close()` to stop it. */
export interface DmSubscription {
  close(): void;
}

/**
 * A raw NIP-59 gift-wrap event (kind 1059), still ENCRYPTED. The background
 * poller stores these (no key needed to collect them); the popup decrypts them
 * with the in-memory identity. Plain-object shape so it survives JSON storage.
 */
export interface GiftWrapEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
