/**
 * BackendPicker: choose which smirk-backend the wallet talks to.
 *
 * The wallet is backend-agnostic: the default public instance, a self-hosted
 * smirk-backend-core, or another operator's. This one presentational component
 * is reused in two places:
 *   - onboarding (a subtle "run your own backend" opt-in before first bootstrap)
 *   - Settings -> Backend (switch later)
 *
 * It stays platform-free: the caller injects `probe` (wraps core `connectBackend`,
 * which validates https + fetches `/capabilities`) and `onUse` (writes the durable
 * config + re-points the api singleton + re-bootstraps auth). The component owns
 * only the URL input, the probe-result card, and the switch/privacy copy.
 */
import { useState } from 'preact/hooks';
import { Button } from './Button';

/** Display-ready summary of a probed backend (mapped by the caller from the
 *  backend's `/capabilities`). */
export interface BackendProbeInfo {
  /** Normalized absolute API base, e.g. `https://api.smirk.cash/api/v1`. */
  url: string;
  /** UTXO route dialect the backend speaks (`namespaced` | `flat`). */
  apiStyle: string;
  /** Operator-advertised instance name, if any. */
  instanceName?: string;
  /** Enabled chain ids, e.g. `['btc','ltc','xmr','wow','grin']`. */
  chains: string[];
  /** `create-only` | `bounded` | `unlimited`. */
  restorePolicy?: string;
  /** Whether the instance runs a first-party Nostr relay (DM inbox). */
  relay: boolean;
}

export interface BackendPickerProps {
  /** The currently-active backend (Settings passes this; onboarding omits it). */
  current?: { url: string; instanceName?: string; isDefault: boolean };
  /** The built-in default backend URL, for the "reset to default" affordance. */
  defaultUrl?: string;
  /** Validate + probe a candidate URL. Never commits: pure read. */
  probe: (url: string) => Promise<{ ok: boolean; info?: BackendProbeInfo; error?: string }>;
  /** Commit the probed backend (write config + re-point + re-bootstrap). */
  onUse: (info: BackendProbeInfo) => Promise<void>;
  /** Reset to the built-in default backend (Settings only). */
  onResetDefault?: () => Promise<void>;
  /** Back out without changing anything. */
  onBack?: () => void;
  /** Copy framing. Defaults to `settings`. */
  context?: 'onboarding' | 'settings';
}

const muted = 'var(--smirk-fg-muted)';

export function BackendPicker({
  current,
  defaultUrl,
  probe,
  onUse,
  onResetDefault,
  onBack,
  context = 'settings',
}: BackendPickerProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<false | 'probe' | 'use' | 'reset'>(false);
  const [info, setInfo] = useState<BackendProbeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runProbe = async () => {
    if (!url.trim() || busy) return;
    setBusy('probe');
    setError(null);
    setInfo(null);
    try {
      const r = await probe(url);
      if (r.ok && r.info) setInfo(r.info);
      else setError(r.error ?? 'Could not reach that backend.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach that backend.');
    } finally {
      setBusy(false);
    }
  };

  const runUse = async () => {
    if (!info || busy) return;
    setBusy('use');
    setError(null);
    try {
      await onUse(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch backend.');
      setBusy(false);
    }
  };

  const runReset = async () => {
    if (!onResetDefault || busy) return;
    setBusy('reset');
    setError(null);
    try {
      await onResetDefault();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset backend.');
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="backend-picker"
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      {onBack && (
        <button
          onClick={onBack}
          style={{
            alignSelf: 'flex-start',
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
      )}

      <div>
        <h2 style={{ fontSize: 16, margin: 0 }}>Backend</h2>
        <p style={{ fontSize: 12, color: muted, lineHeight: 1.45, margin: '4px 0 0' }}>
          Smirk talks to a backend for chain data and tipping. Your seed and funds
          never leave this device.
          {context === 'onboarding'
            ? ' For max privacy, point it at a backend you run (or another operator you trust).'
            : ''}
        </p>
      </div>

      {current && (
        <div
          data-testid="backend-current"
          style={{
            border: '1px solid var(--smirk-border)',
            background: 'var(--smirk-bg-sunken)',
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          <div style={{ fontSize: 11, color: muted }}>
            Connected{current.isDefault ? ' (default)' : ''}
          </div>
          <div style={{ fontSize: 13, wordBreak: 'break-all', marginTop: 2 }}>
            {current.instanceName ? (
              <>
                <strong>{current.instanceName}</strong>{' '}
                <span style={{ color: muted }}>· {current.url}</span>
              </>
            ) : (
              current.url
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, color: muted }}>
          {context === 'onboarding' ? 'Backend URL' : 'Switch backend'}
        </span>
        <input
          data-testid="backend-url-input"
          type="url"
          inputMode="url"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          value={url}
          placeholder="https://backend.example.com"
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runProbe();
          }}
          style={{
            fontSize: 13,
            padding: '9px 11px',
            borderRadius: 8,
            border: '1px solid var(--smirk-border)',
            background: 'var(--smirk-bg-sunken)',
            color: 'var(--smirk-fg)',
            outline: 'none',
          }}
        />
        <Button
          variant="secondary"
          testid="backend-connect-btn"
          disabled={!url.trim() || busy !== false}
          onClick={() => void runProbe()}
        >
          {busy === 'probe' ? 'Connecting…' : 'Connect'}
        </Button>
      </div>

      {error && (
        <div
          data-testid="backend-error"
          style={{
            background: 'var(--smirk-bg-sunken)',
            color: 'var(--smirk-negative)',
            border: '1px solid var(--smirk-negative)',
            padding: '10px 12px',
            borderRadius: 8,
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {info && (
        <div
          data-testid="backend-probe-result"
          style={{
            border: '1px solid var(--smirk-border)',
            borderRadius: 8,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {info.instanceName ?? 'Smirk backend'}
          </div>
          <div style={{ fontSize: 11.5, color: muted, wordBreak: 'break-all' }}>
            {info.url}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 2 }}>
            <span style={{ color: muted }}>Chains: </span>
            {info.chains.length ? info.chains.join(', ').toUpperCase() : 'none'}
          </div>
          {info.restorePolicy && (
            <div style={{ fontSize: 12.5 }}>
              <span style={{ color: muted }}>Restore: </span>
              {restoreLabel(info.restorePolicy)}
            </div>
          )}
          <div style={{ fontSize: 12.5 }}>
            <span style={{ color: muted }}>Messaging relay: </span>
            {info.relay ? 'yes' : 'no'}
          </div>

          {context === 'settings' && (
            <p
              style={{
                fontSize: 12,
                color: muted,
                lineHeight: 1.45,
                margin: '6px 0 2px',
              }}
            >
              Switching signs you out and reconnects here. Your @handle and history
              live on each backend separately, so a fresh backend starts clean.
              Seed and funds stay on this device.
            </p>
          )}

          <Button
            variant="primary"
            testid="backend-use-btn"
            disabled={busy !== false}
            onClick={() => void runUse()}
          >
            {busy === 'use' ? 'Switching…' : 'Use this backend'}
          </Button>
        </div>
      )}

      {onResetDefault && current && !current.isDefault && (
        <button
          data-testid="backend-reset-default"
          title={defaultUrl}
          onClick={() => void runReset()}
          disabled={busy !== false}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            border: 'none',
            color: muted,
            cursor: busy ? 'default' : 'pointer',
            fontSize: 12,
            padding: '2px 0',
            textDecoration: 'underline',
          }}
        >
          {busy === 'reset' ? 'Resetting…' : 'Reset to the default Smirk backend'}
        </button>
      )}
    </div>
  );
}

function restoreLabel(policy: string): string {
  switch (policy) {
    case 'unlimited':
      return 'any date';
    case 'create-only':
      return 'new wallets only';
    case 'bounded':
      return 'recent history';
    default:
      return policy;
  }
}
