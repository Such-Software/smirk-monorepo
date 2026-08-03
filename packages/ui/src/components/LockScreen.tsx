/**
 * LockScreen: password prompt shown when a wallet exists but is locked.
 *
 * Rendered by the popup gate when `WalletKeystore.getState().kind === 'locked'`.
 * On submit, calls `onUnlock(password)`; the caller wires that to
 * `walletKeystore.unlock(password)` and surfaces the resulting
 * `InvalidPasswordError` via the `error` prop on the next render.
 *
 * Auto-focuses the password field. Submit on Enter.
 */

import { useState } from 'preact/hooks';
import { Button } from './Button';

export interface LockScreenProps {
  /**
   * Called when the user submits a password. Caller wires this to
   * `walletKeystore.unlock(password)`. May throw; the wizard will
   * surface the error.
   */
  onUnlock: (password: string) => Promise<void>;
  /** Optional brand mark URL: extension passes the favicon. */
  iconUrl?: string;
  class?: string;
}

export function LockScreen({ onUnlock, iconUrl, class: className }: LockScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
      // Successful unlock removes this screen from the tree; nothing
      // more to do here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unlock');
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div
      class={className}
      data-testid="lockscreen-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 16px',
        gap: 14,
      }}
    >
      {iconUrl && <img src={iconUrl} alt="" width={72} height={72} style={{ imageRendering: 'auto' }} />}
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Unlock Smirk</h2>

      <input
        type="password"
        autoFocus
        placeholder="Password"
        value={password}
        disabled={busy}
        data-testid="lockscreen-password-input"
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if ((e as KeyboardEvent).key === 'Enter') void handleSubmit();
        }}
        style={inputStyle}
      />

      {error && (
        <div data-testid="lockscreen-error" style={{ color: '#ff6b6b', fontSize: 12, textAlign: 'center' }}>{error}</div>
      )}

      <div style={{ width: '100%', maxWidth: 280 }}>
        <Button
          onClick={() => void handleSubmit()}
          testid="lockscreen-unlock-btn"
          {...(!password || busy ? { disabled: true } : {})}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </div>

    </div>
  );
}

const inputStyle = {
  width: '100%',
  maxWidth: 280,
  fontSize: 14,
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box' as const,
} as const;

