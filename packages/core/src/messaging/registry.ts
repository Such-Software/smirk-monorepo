/**
 * Messaging registry + init seam: parallel to chain/registry.ts + initSmirkApi.
 * `initSmirkMessaging` is called at shell startup with the relay set discovered
 * from `/capabilities` (+ the public interop relays). The provider is a swap
 * point (tests / alternate backends).
 */

import { NostrMessagingProvider } from './nostr';
import type { MessagingProvider } from './provider';

/**
 * Public interop relays that MAY be used alongside the operator's relay so DMs
 * reach non-Smirk (e.g. Goblin) users. A Smirk-only relay would black-hole
 * cross-wallet DMs, which is why they exist.
 *
 * They are NOT a default. Contacting a third party the operator did not choose
 * is a phone-home, and this list previously reached the network unconditionally:
 * `messagingRelays()` fell back to it whenever `activeRelays` was empty, so
 * `publicRelays: []` could not switch it off and any code path that ran before
 * `initSmirkMessaging` leaked the user's npub and gift-wrap traffic to
 * damus/nos.lol. A self-hoster could not prevent it. Callers must now opt in
 * explicitly by passing this (or their own list) to `initSmirkMessaging`.
 */
export const DEFAULT_PUBLIC_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

let provider: MessagingProvider = new NostrMessagingProvider();
let activeRelays: string[] = [];
/** Whether `initSmirkMessaging` has run. Distinguishes "configured to none"
 *  from "not configured yet"; both must stay silent. */
let configured = false;

export interface MessagingInit {
  /** This instance's relay URL (from capabilities.messaging.relay_url). */
  relayUrl?: string | undefined;
  /**
   * Third-party interop relays to ALSO use. Omitted or `[]` means none: the
   * wallet then talks only to the operator's relay. Pass
   * {@link DEFAULT_PUBLIC_RELAYS} to opt into cross-wallet reachability.
   */
  publicRelays?: string[] | undefined;
}

/** Configure the active relay set: the operator's relay plus any opted-in interop. */
export function initSmirkMessaging(config: MessagingInit): void {
  const relays = new Set<string>();
  if (config.relayUrl) relays.add(config.relayUrl);
  // No `?? DEFAULT_PUBLIC_RELAYS`: silence is the safe default, not damus.
  for (const r of config.publicRelays ?? []) relays.add(r);
  activeRelays = [...relays];
  configured = true;
}

/**
 * The active relay set. Empty until configured, and empty is honoured.
 *
 * Returning a hardcoded fallback here is what made `publicRelays: []`
 * unenforceable. A caller that gets `[]` must surface "no relay configured"
 * rather than reach for someone else's.
 */
export function messagingRelays(): string[] {
  return activeRelays;
}

/** Whether a relay set has been configured at all (vs configured to none). */
export function messagingConfigured(): boolean {
  return configured;
}

/** The current messaging provider. */
export function messagingProvider(): MessagingProvider {
  return provider;
}

/** Swap the provider (tests / an alternate backend). */
export function setMessagingProvider(p: MessagingProvider): void {
  provider = p;
}
