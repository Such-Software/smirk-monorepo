import { useEffect, useState } from 'preact/hooks';
import { api, deriveNostrIdentity, type NostrIdentity, type UnlockedWallet } from '@smirk/core';
import { settingsInputStyle } from '../ui-shared';

/**
 * Settings → Nostr identity (Identity Phase 1). Derives the seed's Nostr identity
 * (NIP-06 hardened account), shows the npub, links it to this account via a NIP-98
 * signed action (`api.linkNostr`), and supports account rotation. A linked npub
 * lets the user "Sign in with Nostr" (NIP-98) on any Smirk-compatible backend.
 *
 * The private key never leaves core; this screen only derives the npub for
 * display and hands the identity to `api.linkNostr`, which signs in-memory.
 */
export function NostrIdentityRoute({
  wallet,
  onBack,
}: {
  wallet: UnlockedWallet;
  onBack: () => void;
}) {
  const [account, setAccount] = useState(0);
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [linkedPubkey, setLinkedPubkey] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'linking'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  // Derive the identity for the selected account (client-side, no network).
  useEffect(() => {
    const mnemonic = wallet.mnemonic;
    if (!mnemonic) {
      // Cleared, not stale: if the wallet locks while this screen is open, drop
      // the derived identity so the npub/badge don't linger next to the error.
      setIdentity(null);
      setError('Wallet is locked — unlock to view your Nostr identity');
      return;
    }
    try {
      setIdentity(deriveNostrIdentity(mnemonic, account));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to derive identity');
    }
  }, [wallet.mnemonic, account]);

  // Detect an already-linked npub so the linked badge shows on open. Race-guard:
  // ignore this result if the component unmounted, and never clobber a value a
  // concurrent link() already set (functional update keeps the non-null one).
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

  const isLinked = !!identity && linkedPubkey === identity.pubkeyHex;
  // The backend stores exactly ONE npub per account: a different linked key means
  // linking the selected one REPLACES it (rotation), not accumulates.
  const replacesExisting = !!linkedPubkey && !isLinked;

  const link = async () => {
    if (!identity) return;
    setStatus('linking');
    setError(undefined);
    const r = await api.linkNostr(identity);
    setStatus('idle');
    if (r.data?.nostrPubkey) {
      setLinkedPubkey(r.data.nostrPubkey);
    } else if (r.status === 409) {
      setError('This Nostr identity is already linked to a different Smirk account.');
    } else if (r.status === 401) {
      setError('Your session expired — unlock and try again.');
    } else {
      setError(r.error ?? 'Link failed');
    }
  };

  return (
    <div data-testid="settings-nostr-screen">
      <button
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
          padding: '4px 0',
          opacity: 0.7,
        }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, marginTop: 4 }}>Nostr identity</h2>
      <p style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4, marginTop: 4 }}>
        Your seed-derived Nostr key. Link it to sign in with Nostr (NIP-98) on any
        Smirk-compatible backend.
      </p>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>Your npub</span>
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
          }}
        >
          {identity?.npub ?? '…'}
        </div>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          opacity: 0.85,
          marginTop: 12,
        }}
      >
        Account
        <select
          value={String(account)}
          onChange={(e) => setAccount(Number((e.target as HTMLSelectElement).value))}
          data-testid="nostr-account-select"
          style={settingsInputStyle}
        >
          {[0, 1, 2, 3, 4].map((n) => (
            <option key={n} value={n} data-testid={`nostr-account-option-${n}`}>
              {n}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10, opacity: 0.5 }}>
          one linked identity — changing account replaces it
        </span>
      </label>

      {replacesExisting && (
        <p
          data-testid="nostr-replaces-note"
          style={{ fontSize: 11, color: '#f59e0b', marginTop: 10, lineHeight: 1.4 }}
        >
          A different Nostr identity is already linked to this account. Linking this
          one replaces it — you keep a single linked identity.
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        {isLinked ? (
          <div
            data-testid="nostr-linked-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 6,
              background: 'rgba(34,197,94,0.12)',
              border: '1px solid rgba(34,197,94,0.4)',
              color: '#22c55e',
              fontSize: 13,
            }}
          >
            ✓ Linked to this account
          </div>
        ) : (
          <button
            data-testid="nostr-link-btn"
            onClick={() => void link()}
            disabled={status === 'linking' || !identity}
            style={{
              padding: '8px 14px',
              background: 'var(--smirk-accent, #6366f1)',
              border: 'none',
              borderRadius: 6,
              color: 'var(--smirk-accent-fg, #fff)',
              fontFamily: 'inherit',
              fontSize: 13,
              cursor: status === 'linking' ? 'default' : 'pointer',
              opacity: status === 'linking' ? 0.7 : 1,
            }}
          >
            {status === 'linking'
              ? 'Linking…'
              : replacesExisting
                ? 'Replace linked identity'
                : 'Link this identity'}
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
