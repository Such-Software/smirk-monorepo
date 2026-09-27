import { useEffect, useState } from 'preact/hooks';
import type { UnlockedWallet } from '@smirk/core';
import { readOperationPolicy, writeOperationPolicy } from './operation-auth';
import type { OperationPolicy } from './operation-auth-policy';

export function OperationAuthSettings({ wallet }: { wallet: UnlockedWallet }) {
  const [policy, setPolicy] = useState<OperationPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readOperationPolicy().then(
      (value) => { if (alive) setPolicy(value); },
      (failure) => { if (alive) setError(failure instanceof Error ? failure.message : 'Could not load password confirmation settings.'); },
    );
    return () => { alive = false; };
  }, []);
  const change = async (key: keyof OperationPolicy, enabled: boolean) => {
    if (!policy || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await writeOperationPolicy(key, enabled, wallet);
      setPolicy(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save password confirmation settings.');
    } finally { setBusy(false); }
  };
  return <div style={{ padding: '8px 0', fontSize: 12 }}>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
      <input type="checkbox" data-testid="require-password-sends" checked={policy?.requirePasswordForSends ?? false}
        disabled={!policy || busy} onChange={(event) => void change('requirePasswordForSends', event.currentTarget.checked)} />
      Require password for every send
    </label>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" data-testid="require-password-signing" checked={policy?.requirePasswordForSigning ?? false}
        disabled={!policy || busy} onChange={(event) => void change('requirePasswordForSigning', event.currentTarget.checked)} />
      Require password for signing and private-key requests
    </label>
    <p style={{ opacity: 0.7, lineHeight: 1.5 }}>Send confirmation covers transfers, tips, and swap deposits. Signing confirmation also covers messages and app signing, encryption, and decryption requests. Background sign-in and incoming message checks continue normally. These settings do not change your auto-lock deadline.</p>
    {error && <p role="alert" style={{ color: 'var(--smirk-danger, #ef4444)' }}>{error}</p>}
  </div>;
}
