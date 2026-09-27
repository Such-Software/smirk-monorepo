import type { PlatformStorage, WalletKeystore } from '@smirk/core';

/** Non-secret invalidation event shared by every wallet window. */
export const SESSION_LOCK_KEY = 'smirk.session.lock.v1';
let unpublishedLocalLock = false;

/** If lock publication failed, this window must not trust an older cache. */
export const canRestoreLocalSession = (): boolean => !unpublishedLocalLock;

/** Called only after this window has obtained a fresh password-unlocked wallet. */
export function acknowledgePasswordUnlock(): void {
  unpublishedLocalLock = false;
}

/** Revoke local keys before publishing the lock to other open contexts. */
export async function lockWalletContexts(
  keystore: WalletKeystore,
  sessionStorage: PlatformStorage,
): Promise<void> {
  unpublishedLocalLock = true;
  await keystore.lock();
  await sessionStorage.set(SESSION_LOCK_KEY, crypto.randomUUID());
  unpublishedLocalLock = false;
}

/** The storage event survives service-worker eviction and carries no keys. */
export function subscribeWalletLock(
  keystore: WalletKeystore,
  sessionStorage: PlatformStorage,
  onLocked: () => Promise<void>,
): () => void {
  return sessionStorage.subscribe((key) => {
    if (key !== SESSION_LOCK_KEY) return;
    void keystore.lock().then(onLocked).catch(() => {
      // Keys were revoked before the UI refresh; the next refresh stays locked.
      console.warn('[smirk] Could not refresh the locked wallet view.');
    });
  });
}
