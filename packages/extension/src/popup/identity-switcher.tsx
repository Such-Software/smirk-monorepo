import { useEffect, useState } from 'preact/hooks';
import { setActiveIdentity, type UnlockedWallet } from '@smirk/core';
import { IdentityPicker, useRoute, type PickerIdentity } from '@smirk/ui';
import {
  listNostrIdentitiesForPicker,
  getActiveNostrIdentityFromWallet,
  loadVault,
  saveVault,
  refreshActiveNostrKeyCache,
} from './nostr-vault';

/**
 * Always-visible active-identity chip in the app header (flows to both the popup
 * Header and the desktop SidebarNav via AppShell.headerActions). Reuses the
 * accessible IdentityPicker; switching here changes the wallet's GLOBAL active
 * identity — what Feed / Messages default to. Persisting the switch writes the
 * vault, so it needs the unlocked mnemonic; on a warm resume the chip stays a
 * read-only indicator (the optimistic selection reverts on the next load).
 */
export function HeaderIdentitySwitcher({ wallet }: { wallet: UnlockedWallet }) {
  const { navigate } = useRoute();
  const [identities, setIdentities] = useState<PickerIdentity[]>([]);
  const [activePubkey, setActivePubkey] = useState<string>('');

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

  if (!identities.length) return null;
  return (
    <IdentityPicker
      identities={identities}
      selectedPubkey={activePubkey}
      onSelect={onSelect}
      onManage={() => void navigate('settings/nostr')}
      label="Active identity"
      compact
      testid="header-identity-switcher"
    />
  );
}
