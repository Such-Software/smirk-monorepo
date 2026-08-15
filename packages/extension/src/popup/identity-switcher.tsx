import { useEffect, useState } from 'preact/hooks';
import { api, setActiveIdentity, type UnlockedWallet } from '@smirk/core';
import { IdentityPicker, useRoute, type PickerIdentity } from '@smirk/ui';
import { bytesToHex } from './format';
import { nip05HomeDomain } from './nip05';
import { storage } from './singletons';
import {
  listNostrIdentitiesForPicker,
  getActiveNostrIdentityFromWallet,
  loadVault,
  saveVault,
  refreshActiveNostrKeyCache,
} from './nostr-vault';

/**
 * The account's Smirk handle plus the identity it belongs to, or the answer "this
 * account has no handle" (both fields null).
 *
 * A handle is a property of the BACKEND ACCOUNT, not of a key, and it resolves
 * (NIP-05) to exactly ONE npub: the one linked to the account, which `/auth/me`
 * reports as `nostrPubkey`. Linking only ever binds the primary account-0 identity
 * (see nostr-link.ts), so a reserved-but-not-yet-linked handle can only ever land
 * there. Every other identity (burner, imported, derived-N) owns no handle.
 */
interface HandleAnswer {
  /** `name@domain`, exactly as it is published and paid. Null: no handle claimed. */
  handle: string | null;
  /** x-only pubkey hex (lowercase) of the identity that owns it. */
  ownerPubkeyHex: string | null;
}

/**
 * Per-wallet cache of that answer, keyed by seed fingerprint. The popup is torn
 * down on every close, so without it the chip would spend a `/auth/me` round trip
 * with no name to show on every single open. Public data only: the handle is
 * published to Nostr and the owner pubkey is the npub it resolves to.
 */
const HANDLE_CACHE_PREFIX = 'smirk_handle_owner_v1_';

/**
 * The only identity a handle can be attributed to before the account is linked:
 * account-0, as lowercase x-only hex. Read from the cached nostr key rather than
 * re-derived from the seed, so it also answers on a warm resume where
 * `wallet.mnemonic` is gone.
 */
function account0PubkeyHex(wallet: UnlockedWallet): string | null {
  return wallet.keys?.nostr ? bytesToHex(wallet.keys.nostr.publicKey) : null;
}

/**
 * Always-visible active-identity chip in the app header (flows to both the popup
 * Header and the desktop SidebarNav via AppShell.headerActions). Reuses the
 * accessible IdentityPicker; switching here changes the wallet's GLOBAL active
 * identity: what Feed / Messages default to. Persisting the switch writes the
 * vault, so it needs the unlocked mnemonic; on a warm resume the chip stays a
 * read-only indicator (the optimistic selection reverts on the next load).
 *
 * The chip also names the identity by its Smirk handle when it owns one. This is
 * the app's only always-on identity surface, so with the handle confined to Receive
 * and Settings, reserving a name and then reading `npub1…` in the header looked
 * exactly like the reservation had not stuck.
 */
export function HeaderIdentitySwitcher({ wallet }: { wallet: UnlockedWallet }) {
  const { navigate, route } = useRoute();
  const [identities, setIdentities] = useState<PickerIdentity[]>([]);
  const [activePubkey, setActivePubkey] = useState<string>('');
  // Null until we have an answer (cached or fresh). That is NOT the same as "no
  // handle", and only the latter may fall back to showing an npub. Tagged with the
  // wallet it was resolved for, so a wallet swap cannot show the previous account's
  // name even for a frame.
  const [answer, setAnswer] = useState<{ fingerprint: string; value: HandleAnswer } | null>(null);
  const resolved = answer && answer.fingerprint === wallet.fingerprint ? answer.value : null;
  // The identity hub is the only place a handle can be claimed after onboarding, and
  // this chip outlives it (the desktop shell keeps the header mounted for the life
  // of the window). Re-read on entering/leaving it so a name claimed there appears
  // without a restart; every other navigation leaves the answer alone.
  const onIdentityHub = route.current === 'settings/nostr';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [list, active] = await Promise.all([
        listNostrIdentitiesForPicker(wallet),
        getActiveNostrIdentityFromWallet(wallet),
      ]);
      if (cancelled) return;
      setIdentities(list);
      setActivePubkey(active.identity?.pubkeyHex ?? list[0]?.pubkeyHex ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.mnemonic, wallet.fingerprint]);

  // Resolve the handle + the identity that owns it. A backend read, independent of
  // the seed, so it populates on a warm resume too.
  useEffect(() => {
    let cancelled = false;
    const fingerprint = wallet.fingerprint;
    const cacheKey = HANDLE_CACHE_PREFIX + fingerprint;
    void (async () => {
      // Start the authoritative read first; the cached answer only decides what is
      // on screen while it is in flight.
      const mePromise = api.getMe().catch(() => null);
      const cached = await storage.get<HandleAnswer>(cacheKey);
      if (cancelled) return;
      if (cached) setAnswer({ fingerprint, value: cached });

      const me = await mePromise;
      if (cancelled) return;
      const username = me?.data?.username;
      // No `nostrPubkey` yet means the handle is reserved but the user has not
      // agreed to link an identity to it. Attribute it to account-0 anyway: that is
      // the only identity the link can ever bind, and it is the account's own
      // primary, so naming it discloses nothing a burner is protected from.
      const ownerRaw = me?.data?.nostrPubkey ?? account0PubkeyHex(wallet);
      if (username && ownerRaw) {
        const next: HandleAnswer = {
          handle: `${username}@${nip05HomeDomain()}`,
          ownerPubkeyHex: ownerRaw.toLowerCase(),
        };
        setAnswer({ fingerprint, value: next });
        await storage.set(cacheKey, next);
        return;
      }
      const noHandle: HandleAnswer = { handle: null, ownerPubkeyHex: null };
      if (me?.data && !me.error && !username) {
        // A definite "this account claimed no name". Persist it so a handle-less
        // wallet does not wait on the network to be told so on every open either.
        setAnswer({ fingerprint, value: noHandle });
        await storage.set(cacheKey, noHandle);
        return;
      }
      // Read failed or was unauthenticated (offline, expired token). Keep any
      // cached name rather than erasing one the user really owns, but stop waiting
      // so the chip falls back to the npub instead of holding a placeholder.
      setAnswer((prev) =>
        prev && prev.fingerprint === fingerprint ? prev : { fingerprint, value: noHandle },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.fingerprint, onIdentityHub]);

  const onSelect = (pubkey: string) => {
    const mnemonic = wallet.mnemonic;
    setActivePubkey(pubkey); // optimistic
    if (!mnemonic) return; // can't persist a switch without the seed
    void (async () => {
      const vault = await loadVault(mnemonic);
      await saveVault(mnemonic, setActiveIdentity(vault, pubkey));
      await refreshActiveNostrKeyCache(wallet);
    })();
  };

  // Hand the handle to the ONE identity that owns it; every other row keeps its
  // npub. A burner wearing the main identity's name would tie the two together for
  // anyone reading the screen, and would name it something no payment can reach.
  const handle = resolved?.handle ?? null;
  const ownerHex = resolved?.ownerPubkeyHex ?? null;
  const candidateHex = account0PubkeyHex(wallet);
  const pickerIdentities: PickerIdentity[] = identities.map((id) => {
    const hex = id.pubkeyHex.toLowerCase();
    if (handle && hex === ownerHex) return { ...id, handle };
    // No answer yet, and this is the identity a handle would land on: hold the
    // picker's placeholder rather than an npub we may be about to replace.
    if (!resolved && hex === candidateHex) return { ...id, handleLoading: true };
    return id;
  });

  if (!identities.length) return null;
  return (
    <IdentityPicker
      identities={pickerIdentities}
      selectedPubkey={activePubkey}
      onSelect={onSelect}
      onManage={() => void navigate('settings/nostr')}
      label="Active identity"
      compact
      testid="header-identity-switcher"
    />
  );
}
