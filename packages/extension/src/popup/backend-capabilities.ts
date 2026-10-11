/**
 * Read this backend's capabilities and configure the relay set from them,
 * unless the window has moved to another backend in the meantime.
 *
 * The wallet shell used to apply whatever the read returned. When another
 * window reset or switched the backend while this window's read was in
 * flight, `bootBackendSelection` cleared the relay set, and then the read
 * resolved and put the previous operator's relay back: messaging, Grin Nostr
 * payments and the DM watch carried on at an operator the user had left.
 */
import {
  initSmirkMessaging,
  loadCapabilities,
  type BackendCapabilities,
  type CapabilitiesApi,
} from '@smirk/core';

import { backendScope } from './backend-generation';

export type AdoptedCapabilities =
  | { stale: false; caps: BackendCapabilities | null }
  /** The window moved while the read was in flight; nothing was applied. */
  | { stale: true };

export async function adoptBackendCapabilities(api: CapabilitiesApi): Promise<AdoptedCapabilities> {
  const scope = backendScope(api);
  const caps = await loadCapabilities(api);
  if (!scope.current()) return { stale: true };
  // Configure the relay set for EVERY surface, not just Messages.
  // `messagingRelays()` used to fall back to hardcoded third-party relays when
  // nothing had configured it, so the Grin Nostr payment path (which never
  // called this) published gift-wraps to damus/nos.lol on an instance whose
  // operator may run neither. The fallback is gone, so this init is
  // load-bearing: without it those paths correctly have no relay.
  initSmirkMessaging({
    ...(caps?.messaging?.relay_url ? { relayUrl: caps.messaging.relay_url } : {}),
    publicRelays: [],
  });
  return { stale: false, caps };
}
