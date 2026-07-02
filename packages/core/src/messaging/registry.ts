/**
 * Messaging registry + init seam — parallel to chain/registry.ts + initSmirkApi.
 * `initSmirkMessaging` is called at shell startup with the relay set discovered
 * from `/capabilities` (+ the public interop relays). The provider is a swap
 * point (tests / alternate backends).
 */

import { NostrMessagingProvider } from './nostr';
import type { MessagingProvider } from './provider';

/** Public interop relays used ALONGSIDE the Smirk relay so DMs reach non-Smirk
 *  (e.g. Goblin) users. A Smirk-only relay would black-hole cross-wallet DMs. */
export const DEFAULT_PUBLIC_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

let provider: MessagingProvider = new NostrMessagingProvider();
let activeRelays: string[] = [];

export interface MessagingInit {
  /** This instance's relay URL (from capabilities.messaging.relay_url). */
  relayUrl?: string | undefined;
  /** Public interop relays; pass `[]` to disable (e.g. a local-only test). */
  publicRelays?: string[] | undefined;
}

/** Configure the active relay set: the Smirk relay (inbox) + public interop. */
export function initSmirkMessaging(config: MessagingInit): void {
  const relays = new Set<string>();
  if (config.relayUrl) relays.add(config.relayUrl);
  for (const r of config.publicRelays ?? DEFAULT_PUBLIC_RELAYS) relays.add(r);
  activeRelays = [...relays];
}

/** The active relay set (Smirk inbox + public interop). */
export function messagingRelays(): string[] {
  return activeRelays.length ? activeRelays : DEFAULT_PUBLIC_RELAYS;
}

/** The current messaging provider. */
export function messagingProvider(): MessagingProvider {
  return provider;
}

/** Swap the provider (tests / an alternate backend). */
export function setMessagingProvider(p: MessagingProvider): void {
  provider = p;
}
