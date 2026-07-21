import { useEffect, useState } from 'preact/hooks';
import {
  api,
  deriveNostrIdentity,
  addDerivedIdentity,
  addBurnerIdentity,
  importIdentity,
  setActiveIdentity,
  renameIdentity,
  removeIdentity,
  resolveIdentity,
  encodeNsec,
  shortNpub,
  type IdentityVault,
  type StoredIdentity,
  type UnlockedWallet,
} from '@smirk/core';
import { IdentityAvatar } from '@smirk/ui';
import { settingsInputStyle } from '../ui-shared';
import {
  loadVault,
  loadVaultByFingerprint,
  saveVault,
  vaultCrypto,
  refreshActiveNostrKeyCache,
  exportVaultBackup,
  restoreVaultBackup,
  isForeignVaultBackup,
} from '../nostr-vault';
import { publishNip05Profile } from '../nostr-link';
import { nip05HomeDomain } from '../nip05';
import { walletKeystore, store } from '../singletons';
import { writeSessionCache } from '../session-cache';

/**
 * Settings → Nostr identities (P2 multi-identity switcher). One wallet, many
 * identities: seed-derived (recoverable), random "burner" (seed-independent
 * compartmentalization), and `nsec`-imported (carried in from Goblin/another
 * wallet). Switch the active one, rename, remove, and link your PRIMARY (account-0)
 * identity to the backend for "Sign in with Nostr" (NIP-98) — the backend account is
 * bound to the stable primary, not the switchable active identity. Burner/imported private keys are
 * encrypted at rest under a mnemonic-derived key; the plaintext never leaves an
 * unlocked context. See nostr-vault.ts + @smirk/core identity-store.
 */
export function NostrIdentityRoute({
  wallet,
  onBack,
}: {
  wallet: UnlockedWallet;
  onBack: () => void;
}) {
  // On a warm resume the seed isn't in memory (wallet.mnemonic is undefined). We
  // keep the hub VIEWABLE read-only and let the user re-enter their password
  // inline to unlock management; that fresh unlock lives here for the session.
  const [reunlocked, setReunlocked] = useState<UnlockedWallet | null>(null);
  const activeWallet = reunlocked ?? wallet;
  const mnemonic = activeWallet.mnemonic;
  const [vault, setVault] = useState<IdentityVault | null>(null);
  const [linkedPubkey, setLinkedPubkey] = useState<string | null>(null);
  // The account's claimed Smirk username, so we can lead with the human handle
  // (`<username>@<domain>`) instead of a raw npub. Null = no handle claimed.
  const [handle, setHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nsec, setNsec] = useState('');
  const [renaming, setRenaming] = useState<{ pubkeyHex: string; label: string } | null>(null);
  const [revealedNsec, setRevealedNsec] = useState<{ pubkeyHex: string; nsec: string } | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockPw, setUnlockPw] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockErr, setUnlockErr] = useState<string | undefined>(undefined);
  const [backupText, setBackupText] = useState('');
  const [showRestore, setShowRestore] = useState(false);
  const [publishingProfile, setPublishingProfile] = useState(false);

  useEffect(() => {
    if (mnemonic) {
      void loadVault(mnemonic).then(setVault).catch((e) => setError(String(e)));
      return;
    }
    // Warm resume: no seed in memory, but the roster (labels + active pointer)
    // is readable by fingerprint. Show it read-only instead of a "locked" wall;
    // writes prompt for the password inline (doInlineUnlock).
    setError(undefined);
    void loadVaultByFingerprint(activeWallet.fingerprint)
      .then((v) => {
        if (v) setVault(v);
      })
      .catch(() => {});
  }, [mnemonic]);

  // Re-derive the seed for this session by re-entering the password, without
  // leaving the hub. Mirrors the whole-app unlock (index.tsx): keystore.unlock
  // then re-warm the (mnemonic-less) session cache. Setting reunlocked flips
  // `mnemonic` on, so the effect above reloads the full vault.
  const doInlineUnlock = async () => {
    if (!unlockPw) return;
    setUnlocking(true);
    setUnlockErr(undefined);
    try {
      const w = await walletKeystore.unlock(unlockPw);
      const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
      await writeSessionCache(w, minutes);
      setReunlocked(w);
      setUnlockPw('');
      setShowUnlock(false);
    } catch {
      setUnlockErr('Incorrect password');
    } finally {
      setUnlocking(false);
    }
  };

  useEffect(() => {
    let stale = false;
    void api.getMe().then((r) => {
      if (stale) return;
      const pk = r.data?.nostrPubkey;
      if (pk) setLinkedPubkey((prev) => prev ?? pk);
      if (r.data?.username) setHandle(r.data.username);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Persist a mutated vault + reflect it in state. `op` labels the in-flight
  // action so buttons can show progress; errors surface, never throw.
  const commit = async (op: string, next: IdentityVault) => {
    if (!mnemonic) {
      // Warm resume: a write needs the seed — surface the inline unlock instead
      // of throwing on the saveVault non-null assertion.
      setShowUnlock(true);
      return;
    }
    setBusy(op);
    setError(undefined);
    try {
      await saveVault(mnemonic, next);
      setVault(next);
      // Keep the session-cached active key in sync so a switched burner/imported
      // identity survives a warm resume too (see nostr-vault.ts).
      void refreshActiveNostrKeyCache(activeWallet);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(null);
    }
  };

  const onSwitch = (pubkeyHex: string) => {
    if (!vault) return;
    void commit('switch', setActiveIdentity(vault, pubkeyHex));
  };
  const onAddDerived = () => {
    if (!vault || !mnemonic) return;
    void commit('add-derived', addDerivedIdentity(vault, mnemonic).vault);
  };
  const onAddBurner = () => {
    if (!vault || !mnemonic) return;
    // Burner keys are random, NOT seed-derived — restoring the seed on a new
    // device will not bring them back. Make that explicit at creation time.
    const ok = window.confirm(
      'Create a new burner identity?\n\n' +
        'A burner has a fresh random key that is NOT part of your seed phrase. ' +
        'Restoring your seed on a new device will NOT recover it — back up its nsec ' +
        '(🔑 Reveal) if you want to keep it.',
    );
    if (!ok) return;
    void commit('add-burner', addBurnerIdentity(vault, vaultCrypto(mnemonic).encrypt).vault);
  };
  const onImport = () => {
    if (!vault || !mnemonic || !nsec.trim()) return;
    // Imported keys are external — stored encrypted here but outside your seed.
    const ok = window.confirm(
      'Import this nsec?\n\n' +
        'Imported keys are stored encrypted in this wallet but are NOT part of your ' +
        'seed phrase. Keep your own backup of the nsec — restoring your seed elsewhere ' +
        'will not recover it.',
    );
    if (!ok) return;
    try {
      const next = importIdentity(vault, nsec.trim(), vaultCrypto(mnemonic).encrypt).vault;
      setNsec('');
      void commit('import', next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid nsec');
    }
  };
  const onRename = () => {
    if (!vault || !renaming) return;
    const next = renameIdentity(vault, renaming.pubkeyHex, renaming.label.trim());
    setRenaming(null);
    void commit('rename', next);
  };
  const onRemove = (id: StoredIdentity) => {
    if (!vault) return;
    const backupNote =
      id.source === 'derived'
        ? 'It can be re-derived from your seed.'
        : 'Its key is NOT in your seed — back up the nsec first or it is gone.';
    if (!window.confirm(`Remove "${id.label ?? shortNpub(id.npub)}"?\n\n${backupNote}`)) return;
    try {
      void commit('remove', removeIdentity(vault, id.pubkeyHex));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot remove');
    }
  };

  const onLinkActive = async () => {
    if (!vault || !mnemonic) return;
    setBusy('link');
    setError(undefined);
    try {
      // Backend "Sign in with Nostr" binds the STABLE primary (account-0) — the same
      // key the auth bootstrap signs with — NOT the switchable active identity, so
      // compartmentalizing with a burner never changes or breaks your Smirk account.
      const primary = deriveNostrIdentity(mnemonic, 0);
      const r = await api.linkNostr(primary);
      if (r.data?.nostrPubkey) {
        setLinkedPubkey(r.data.nostrPubkey);
        // Advertise the now-linked handle on Nostr so external clients verify it.
        void publishNip05Profile(primary);
      }
      else if (r.status === 409) setError('This identity is already linked to a different Smirk account.');
      else if (r.status === 401) setError('Your session expired — unlock and try again.');
      else setError(r.error ?? 'Link failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Link failed');
    } finally {
      setBusy(null);
    }
  };

  // Reveal/export the nsec for backup (esp. burner/imported keys, which live ONLY in
  // the encrypted vault). Gated behind an explicit confirm; toggles off on re-tap.
  const onReveal = (id: StoredIdentity) => {
    if (!vault || !mnemonic) return;
    if (revealedNsec?.pubkeyHex === id.pubkeyHex) {
      setRevealedNsec(null);
      return;
    }
    const ok = window.confirm(
      `Reveal the secret key (nsec) for "${id.label ?? shortNpub(id.npub)}"?\n\n` +
        'Anyone with this nsec fully controls this identity. Only reveal it to back it ' +
        'up somewhere safe — never paste it into a website.',
    );
    if (!ok) return;
    try {
      const resolved = resolveIdentity(vault, id.pubkeyHex, mnemonic, vaultCrypto(mnemonic).decrypt);
      setRevealedNsec({ pubkeyHex: id.pubkeyHex, nsec: encodeNsec(resolved.privateKey) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reveal the key');
    }
  };

  const onPublishProfile = () => {
    if (!mnemonic) {
      setShowUnlock(true);
      return;
    }
    setPublishingProfile(true);
    void publishNip05Profile(deriveNostrIdentity(mnemonic, 0)).finally(() =>
      setPublishingProfile(false),
    );
  };

  // Download an encrypted backup of the whole identity vault so burner/imported keys
  // survive a reinstall. Sealed under the mnemonic-derived key (same trust boundary
  // as the seed) — only THIS wallet's seed can restore it.
  const onExportBackup = async () => {
    if (!mnemonic) {
      setShowUnlock(true);
      return;
    }
    try {
      const blob = await exportVaultBackup(mnemonic);
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'smirk-identities-backup.json';
      a.click();
      URL.revokeObjectURL(url);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const onRestoreBackup = async () => {
    if (!mnemonic) {
      setShowUnlock(true);
      return;
    }
    const text = backupText.trim();
    if (!text) return;
    if (
      isForeignVaultBackup(mnemonic, text) &&
      !window.confirm(
        'This backup was made with a DIFFERENT wallet seed, so its keys cannot be ' +
          'decrypted here. Continue anyway?',
      )
    ) {
      return;
    }
    setBusy('restore');
    setError(undefined);
    try {
      const merged = await restoreVaultBackup(mnemonic, text);
      setVault(merged);
      void refreshActiveNostrKeyCache(activeWallet);
      setBackupText('');
      setShowRestore(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusy(null);
    }
  };

  const sourceBadge: Record<StoredIdentity['source'], { text: string; color: string }> = {
    derived: { text: 'seed', color: '#6366f1' },
    burner: { text: 'burner', color: '#f59e0b' },
    imported: { text: 'imported', color: '#22c55e' },
  };
  const activeIdentity = vault?.identities.find((i) => i.pubkeyHex === vault.active);

  return (
    <div data-testid="settings-nostr-screen">
      <button onClick={onBack} style={backBtn}>
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, marginTop: 4 }}>Nostr identities</h2>
      <p style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4, marginTop: 4 }}>
        Switch which identity signs, pays, and receives. Burner + imported keys are
        encrypted with your wallet — back up an nsec before removing it.
      </p>

      {!mnemonic && (
        <div
          data-testid="nostr-locked-notice"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.35)',
            fontSize: 12,
            lineHeight: 1.4,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span style={{ opacity: 0.9 }}>
            🔓 You can view your identities. Enter your password to add, switch, rename,
            reveal, or import.
          </span>
          {!showUnlock ? (
            <button
              data-testid="nostr-unlock-manage"
              onClick={() => setShowUnlock(true)}
              style={{ ...actionBtn, alignSelf: 'flex-start' }}
            >
              Unlock to manage
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password"
                  autoFocus
                  data-testid="nostr-unlock-input"
                  value={unlockPw}
                  placeholder="Password"
                  disabled={unlocking}
                  onInput={(e) => setUnlockPw((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if ((e as KeyboardEvent).key === 'Enter') void doInlineUnlock();
                  }}
                  style={{ ...settingsInputStyle, flex: 1 }}
                />
                <button
                  data-testid="nostr-unlock-submit"
                  onClick={() => void doInlineUnlock()}
                  disabled={unlocking || !unlockPw}
                  style={actionBtn}
                >
                  {unlocking ? '…' : 'Unlock'}
                </button>
              </div>
              {unlockErr && <span style={{ color: '#ef4444' }}>{unlockErr}</span>}
            </div>
          )}
        </div>
      )}

      {handle && (
        <div
          data-testid="nostr-handle"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(245,197,66,0.10)',
            border: '1px solid rgba(245,197,66,0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ fontSize: 11, opacity: 0.6 }}>Your Smirk handle</span>
          <span style={{ fontSize: 15, fontWeight: 700, wordBreak: 'break-all' }}>
            {handle}@{nip05HomeDomain()}
          </span>
          <span style={{ fontSize: 11, opacity: 0.75 }}>
            {linkedPubkey
              ? '✓ verified — people can find and pay you by this name'
              : 'Reserved. Link your identity below to activate it.'}
          </span>
        </div>
      )}

      {activeIdentity ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Active npub</span>
          <div
            data-testid="nostr-npub"
            style={{
              fontFamily: 'monospace',
              fontSize: 11,
              wordBreak: 'break-all',
              padding: '8px 10px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
            title="Click to copy"
            onClick={() => void navigator.clipboard.writeText(activeIdentity.npub).catch(() => {})}
          >
            {activeIdentity.npub}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(vault?.identities ?? []).map((id) => {
          const active = id.pubkeyHex === vault?.active;
          const linked = linkedPubkey === id.pubkeyHex;
          const badge = sourceBadge[id.source];
          return (
            <div key={id.pubkeyHex} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                data-testid={`nostr-identity-${id.pubkeyHex}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: active ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${active ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.10)'}`,
                }}
              >
                <IdentityAvatar pubkeyHex={id.pubkeyHex} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>
                      {id.label ?? shortNpub(id.npub)}
                    </span>
                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: `${badge.color}22`, color: badge.color }}>
                      {badge.text}
                    </span>
                    {linked ? <span style={{ fontSize: 10, color: '#22c55e' }}>✓ linked</span> : null}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.55, wordBreak: 'break-all' }}>
                    {shortNpub(id.npub)}
                  </div>
                </div>
                {active ? (
                  <span style={{ fontSize: 11, color: '#6366f1' }}>active</span>
                ) : (
                  <button data-testid={`nostr-switch-${id.pubkeyHex}`} onClick={() => onSwitch(id.pubkeyHex)} disabled={!!busy || !mnemonic} style={smallBtn}>
                    Use
                  </button>
                )}
                <button onClick={() => setRenaming({ pubkeyHex: id.pubkeyHex, label: id.label ?? '' })} disabled={!!busy || !mnemonic} style={smallBtn} title="Rename">
                  ✎
                </button>
                <button
                  data-testid={`nostr-reveal-${id.pubkeyHex}`}
                  onClick={() => onReveal(id)}
                  disabled={!!busy || !mnemonic}
                  style={smallBtn}
                  title="Reveal / export secret key (nsec)"
                >
                  🔑
                </button>
                {(vault?.identities.length ?? 0) > 1 ? (
                  <button data-testid={`nostr-remove-${id.pubkeyHex}`} onClick={() => onRemove(id)} disabled={!!busy} style={{ ...smallBtn, color: '#ef4444' }} title="Remove">
                    ✕
                  </button>
                ) : null}
              </div>
              {revealedNsec?.pubkeyHex === id.pubkeyHex ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.4)',
                  }}
                >
                  <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 600 }}>
                    Secret key — back this up, never share it
                  </span>
                  <div
                    data-testid={`nostr-nsec-${id.pubkeyHex}`}
                    onClick={() => void navigator.clipboard.writeText(revealedNsec.nsec).catch(() => {})}
                    title="Click to copy"
                    style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', cursor: 'pointer' }}
                  >
                    {revealedNsec.nsec}
                  </div>
                  <button onClick={() => setRevealedNsec(null)} style={{ ...smallBtn, alignSelf: 'flex-start' }}>
                    Hide
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {renaming ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={renaming.label}
            placeholder="Private label (e.g. market seller)"
            onInput={(e) => setRenaming({ ...renaming, label: (e.target as HTMLInputElement).value })}
            style={{ ...settingsInputStyle, flex: 1 }}
          />
          <button onClick={onRename} style={smallBtn}>Save</button>
          <button onClick={() => setRenaming(null)} style={smallBtn}>Cancel</button>
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button data-testid="nostr-add-derived" onClick={onAddDerived} disabled={!!busy || !mnemonic} style={actionBtn}>
          + Seed account
        </button>
        <button data-testid="nostr-add-burner" onClick={onAddBurner} disabled={!!busy || !mnemonic} style={actionBtn}>
          + Burner
        </button>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
        <input
          data-testid="nostr-import-nsec"
          value={nsec}
          placeholder="Import nsec1…"
          onInput={(e) => setNsec((e.target as HTMLInputElement).value)}
          style={{ ...settingsInputStyle, flex: 1 }}
        />
        <button data-testid="nostr-import-btn" onClick={onImport} disabled={!!busy || !nsec.trim() || !mnemonic} style={actionBtn}>
          Import
        </button>
      </div>

      {/* Encrypted backup of the whole vault — the recovery path for burner +
          imported keys, which are NOT re-derivable from the seed. */}
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button data-testid="nostr-export-backup" onClick={() => void onExportBackup()} disabled={!!busy || !mnemonic} style={actionBtn}>
            ⬇ Export identities backup
          </button>
          <button data-testid="nostr-restore-toggle" onClick={() => setShowRestore((s) => !s)} disabled={!!busy || !mnemonic} style={actionBtn}>
            Restore…
          </button>
        </div>
        <p style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.4, margin: 0 }}>
          Encrypted with your seed — only THIS wallet can restore it. It's how burner
          and imported keys survive a reinstall.
        </p>
        {showRestore && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              data-testid="nostr-restore-input"
              value={backupText}
              placeholder="Paste an identities backup (JSON)…"
              onInput={(e) => setBackupText((e.target as HTMLTextAreaElement).value)}
              style={{ ...settingsInputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
            />
            <button data-testid="nostr-restore-btn" onClick={() => void onRestoreBackup()} disabled={busy === 'restore' || !backupText.trim()} style={{ ...actionBtn, alignSelf: 'flex-start' }}>
              {busy === 'restore' ? 'Restoring…' : 'Restore identities'}
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {linkedPubkey && linkedPubkey === vault?.active ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div data-testid="nostr-linked-badge" style={linkedBadge}>✓ Active identity linked to this account</div>
            {mnemonic && (
              <button data-testid="nostr-publish-profile" onClick={onPublishProfile} disabled={publishingProfile} style={{ ...smallBtn, alignSelf: 'flex-start' }}>
                {publishingProfile ? 'Publishing…' : 'Publish handle to Nostr'}
              </button>
            )}
          </div>
        ) : (
          <button data-testid="nostr-link-btn" onClick={() => void onLinkActive()} disabled={busy === 'link' || !vault || !mnemonic} style={primaryBtn}>
            {busy === 'link' ? 'Linking…' : 'Link active identity for sign-in'}
          </button>
        )}
      </div>

      {error && (
        <div data-testid="nostr-error" style={{ color: '#ef4444', fontSize: 12, marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

const backBtn = { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '4px 0', opacity: 0.7 } as const;
const smallBtn = { padding: '4px 8px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'inherit', fontSize: 12, cursor: 'pointer' } as const;
const actionBtn = { padding: '6px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'inherit', fontSize: 12, cursor: 'pointer' } as const;
const primaryBtn = { padding: '8px 14px', background: 'var(--smirk-accent, #6366f1)', border: 'none', borderRadius: 6, color: 'var(--smirk-accent-fg, #fff)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' } as const;
const linkedBadge = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: 13 } as const;
