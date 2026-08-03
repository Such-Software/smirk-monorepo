/**
 * Relay reference codec (P3b). The Inbox normalizes both transports into one
 * InboxItem whose opaque `relayId` string is the only routing token that flows
 * from the item → wizard fields → the sign/cancel handlers. Backend items keep
 * their bare slate_id; Nostr items pack the slate_id + counterparty pubkey into
 * the same field so respond/cancel can address the gift-wrap back to the sender,
 * WITHOUT threading a new `channel` field through InboxItem, the @smirk/ui types,
 * and the wizard-state schema. `relayId` is opaque everywhere except the API call
 * sites (and a React key), so encoding structured data in it is safe.
 */

const NOSTR_PREFIX = 'nostr:';

/** Pack a Nostr inbox item's routing into a relayId string. */
export function encodeNostrRelayRef(slateId: string, counterpartyPubkeyHex: string): string {
  return `${NOSTR_PREFIX}${slateId}:${counterpartyPubkeyHex}`;
}

export type RelayRef =
  | { channel: 'nostr'; slateId: string; counterparty: string }
  | { channel: 'backend'; relayId: string };

/** Decode a relayId back to its transport + routing. A backend relayId is a bare
 *  slate_id UUID (never starts with `nostr:`), so the prefix disambiguates. */
export function parseRelayRef(relayId: string): RelayRef {
  if (relayId.startsWith(NOSTR_PREFIX)) {
    const rest = relayId.slice(NOSTR_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      return { channel: 'nostr', slateId: rest.slice(0, sep), counterparty: rest.slice(sep + 1) };
    }
  }
  return { channel: 'backend', relayId };
}
