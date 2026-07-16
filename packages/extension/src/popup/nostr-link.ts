/**
 * Nostr account linking + NIP-05 profile publishing.
 *
 * Linking binds the wallet's PRIMARY (account-0) identity to the backend account via
 * the authenticated `POST /auth/nostr/link` — the backend sets `nostr_pubkey` ONLY
 * from a NIP-98 signature, so this is the single path that makes
 * `<username>@<domain>` resolve. After a successful link we publish an account-0
 * kind-0 profile so external Nostr clients render the handle as verified.
 *
 * Shared by the explicit Settings "Link" action and by onboarding's name claim, so
 * claiming a handle makes it usable on Nostr immediately.
 */
import {
  api,
  deriveNostrIdentity,
  buildProfileEvent,
  resolvePublishRelays,
  loadCapabilities,
  NostrClient,
  PROFILE_KIND,
  type NostrProfile,
  type NostrIdentity,
} from '@smirk/core';

import { nip05HomeDomain } from './nip05';

/**
 * Publish an account-0 kind-0 profile advertising `nip05 = <username>@<homeDomain>`.
 * Fetches any existing kind-0 on our relays and MERGES (never clobbers a user's
 * about/picture set elsewhere). Only the PRIMARY identity carries the handle — never
 * a burner/imported. Fire-and-forget: swallows every error so it can't break linking.
 */
export async function publishNip05Profile(identity: NostrIdentity): Promise<void> {
  try {
    const username = (await api.getMySmirkUsername()).data;
    if (!username) return; // no handle claimed → nothing to advertise
    const caps = await loadCapabilities(api);
    const relays = resolvePublishRelays(
      caps?.messaging?.relay_url,
      caps?.feed?.extra_relays ? { publicFallback: caps.feed.extra_relays } : {},
    );
    if (!relays.length) return;
    const nip05 = `${username}@${nip05HomeDomain()}`;
    const client = new NostrClient();
    try {
      let base: NostrProfile = {};
      const existing = await client.querySync(relays, [
        { kinds: [PROFILE_KIND], authors: [identity.pubkeyHex], limit: 1 },
      ]);
      const prev = existing[0];
      if (prev?.content) {
        try {
          base = JSON.parse(prev.content) as NostrProfile;
        } catch {
          /* unparseable prior profile → start clean */
        }
      }
      const event = buildProfileEvent(identity, { ...base, name: base.name ?? username, nip05 });
      await client.publish(relays, event);
    } finally {
      client.close();
    }
  } catch {
    /* fire-and-forget — never surface / block on a profile publish */
  }
}

/**
 * Link the wallet's PRIMARY (account-0) identity to the backend account, then
 * publish its verified profile. Fire-and-forget for the onboarding path: a link
 * hiccup must never fail the name claim (the user can always Link later in Settings).
 */
export async function linkPrimaryNostrIdentity(mnemonic: string): Promise<void> {
  try {
    const primary = deriveNostrIdentity(mnemonic, 0);
    const r = await api.linkNostr(primary);
    if (r.data?.nostrPubkey) void publishNip05Profile(primary);
  } catch {
    /* non-fatal — claiming the handle already succeeded */
  }
}
