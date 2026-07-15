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
  shortNpub,
  type IdentityVault,
  type StoredIdentity,
  type UnlockedWallet,
} from '@smirk/core';
import { settingsInputStyle } from '../ui-shared';
import { loadVault, saveVault, vaultCrypto, refreshActiveNostrKeyCache } from '../nostr-vault';

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
  const mnemonic = wallet.mnemonic;
  const [vault, setVault] = useState<IdentityVault | null>(null);
  const [linkedPubkey, setLinkedPubkey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nsec, setNsec] = useState('');
  const [renaming, setRenaming] = useState<{ pubkeyHex: string; label: string } | null>(null);

  useEffect(() => {
    if (!mnemonic) {
      setError('Wallet is locked — unlock to manage your Nostr identities');
      return;
    }
    void loadVault(mnemonic).then(setVault).catch((e) => setError(String(e)));
  }, [mnemonic]);

  useEffect(() => {
    let stale = false;
    void api.getMe().then((r) => {
      const pk = r.data?.nostrPubkey;
      if (!stale && pk) setLinkedPubkey((prev) => prev ?? pk);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Persist a mutated vault + reflect it in state. `op` labels the in-flight
  // action so buttons can show progress; errors surface, never throw.
  const commit = async (op: string, next: IdentityVault) => {
    setBusy(op);
    setError(undefined);
    try {
      await saveVault(mnemonic!, next);
      setVault(next);
      // Keep the session-cached active key in sync so a switched burner/imported
      // identity survives a warm resume too (see nostr-vault.ts).
      void refreshActiveNostrKeyCache(wallet);
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
    void commit('add-burner', addBurnerIdentity(vault, vaultCrypto(mnemonic).encrypt).vault);
  };
  const onImport = () => {
    if (!vault || !mnemonic || !nsec.trim()) return;
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
      if (r.data?.nostrPubkey) setLinkedPubkey(r.data.nostrPubkey);
      else if (r.status === 409) setError('This identity is already linked to a different Smirk account.');
      else if (r.status === 401) setError('Your session expired — unlock and try again.');
      else setError(r.error ?? 'Link failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Link failed');
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
            <div
              key={id.pubkeyHex}
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
                <button data-testid={`nostr-switch-${id.pubkeyHex}`} onClick={() => onSwitch(id.pubkeyHex)} disabled={!!busy} style={smallBtn}>
                  Use
                </button>
              )}
              <button onClick={() => setRenaming({ pubkeyHex: id.pubkeyHex, label: id.label ?? '' })} disabled={!!busy} style={smallBtn} title="Rename">
                ✎
              </button>
              {(vault?.identities.length ?? 0) > 1 ? (
                <button data-testid={`nostr-remove-${id.pubkeyHex}`} onClick={() => onRemove(id)} disabled={!!busy} style={{ ...smallBtn, color: '#ef4444' }} title="Remove">
                  ✕
                </button>
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
        <button data-testid="nostr-add-derived" onClick={onAddDerived} disabled={!!busy} style={actionBtn}>
          + Seed account
        </button>
        <button data-testid="nostr-add-burner" onClick={onAddBurner} disabled={!!busy} style={actionBtn}>
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
        <button data-testid="nostr-import-btn" onClick={onImport} disabled={!!busy || !nsec.trim()} style={actionBtn}>
          Import
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        {linkedPubkey && linkedPubkey === vault?.active ? (
          <div data-testid="nostr-linked-badge" style={linkedBadge}>✓ Active identity linked to this account</div>
        ) : (
          <button data-testid="nostr-link-btn" onClick={() => void onLinkActive()} disabled={busy === 'link' || !vault} style={primaryBtn}>
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
