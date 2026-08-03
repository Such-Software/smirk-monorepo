/**
 * MigrationWizard: the wallet-side UI for upgrading a v0.2 wallet to v0.3.
 *
 * Shown (instead of onboarding) when the popup detects a legacy `walletState`
 * with no v0.3 keystore yet. The heavy lifting (decrypt the legacy seed,
 * re-seal it under the v0.3 keystore, bootstrap auth, link the Nostr identity)
 * is done by the platform shell via `onMigrate`; this component owns the
 * password prompt, the progress/error surface, and the "upgraded" screen
 * (including the own-backend privacy note).
 *
 * Voice: minimal + technical, a light smirk. Trust posture mirrors
 * ApprovalScreen: everything is inert text, no page input.
 */
import { useState } from 'preact/hooks';
import { Button } from './Button';

type Step = 'intro' | 'password' | 'migrating' | 'done';

export interface MigrationWizardProps {
  /**
   * Decrypt the legacy seed with `password`, re-seal into the v0.3 keystore, and
   * bootstrap (auth + identity link). Rejects on a wrong password (the wizard
   * surfaces it and lets the user retry) or a migration failure.
   */
  /** Runs the migration. The string it resolves with (if any) describes what
   *  actually happened to the legacy BTC/LTC funds, and is shown verbatim on the
   *  done screen. Returning nothing falls back to a claim-free message. */
  onMigrate: (password: string) => Promise<string | void>;
  /** Finish: flip the shell to the unlocked wallet. */
  onDone: () => void;
  /** Optional doge-PoW image shown during the bootstrap `onMigrate` runs. */
  dogeMiningImageUrl?: string;
}

export function MigrationWizard({
  onMigrate,
  onDone,
  dogeMiningImageUrl,
}: MigrationWizardProps) {
  const [step, setStep] = useState<Step>('intro');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** What the shell reported about the legacy BTC/LTC sweep, shown on `done`. */
  const [sweepSummary, setSweepSummary] = useState<string | null>(null);

  const runMigrate = async () => {
    if (!password) return;
    setError(null);
    setStep('migrating');
    try {
      const summary = await onMigrate(password);
      setSweepSummary(typeof summary === 'string' && summary ? summary : null);
      setStep('done');
    } catch (e) {
      setError(
        e instanceof Error && /password|decrypt|aead|tag/i.test(e.message)
          ? 'Wrong password.'
          : e instanceof Error
            ? e.message
            : 'Upgrade failed. Try again.',
      );
      setStep('password');
    }
  };

  return (
    <div
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        minHeight: '100%',
        boxSizing: 'border-box',
        background: 'var(--smirk-bg)',
        color: 'var(--smirk-fg)',
      }}
    >
      {step === 'intro' && (
        <>
          <h1 style={{ margin: 0, fontSize: 21, color: 'var(--smirk-accent)' }}>
            Upgrade your wallet
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--smirk-fg-muted)' }}>
            {/* "Same seed, same funds" was doing a lot of work here. It is true
                of the seed, but a pre-v3 CryptoNote cohort has XMR/WOW at an
                address v0.3 does not watch, and the sweep can fail. Promise what
                is always true; the done screen reports what actually happened. */}
            Found your v0.2 wallet. We'll re-seal your seed under the v0.3
            keystore — same seed, so nothing is re-created. Your BTC/LTC
            addresses change and existing funds sweep across, and you gain a
            Nostr identity. We'll tell you exactly what moved when it's done.
          </p>
          <Button
            variant="primary"
            testid="migrate-begin-btn"
            onClick={() => setStep('password')}
          >
            Upgrade
          </Button>
        </>
      )}

      {step === 'password' && (
        <>
          <h1 style={{ margin: 0, fontSize: 20, color: 'var(--smirk-fg)' }}>
            Enter password to proceed
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
            Your current wallet password. Stays on this device.
          </p>
          <input
            data-testid="migrate-password"
            type="password"
            autoFocus
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runMigrate();
            }}
            placeholder="Password"
            style={{
              padding: 12,
              fontSize: 15,
              borderRadius: 8,
              border: '1px solid var(--smirk-border)',
              background: 'var(--smirk-bg-sunken)',
              color: 'var(--smirk-fg)',
            }}
          />
          {error && (
            <div
              style={{
                background: 'var(--smirk-bg-sunken)',
                color: 'var(--smirk-negative)',
                border: '1px solid var(--smirk-negative)',
                padding: 12,
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          <Button variant="primary" disabled={!password} onClick={() => void runMigrate()}>
            Upgrade
          </Button>
        </>
      )}

      {step === 'migrating' && (
        <div
          style={{
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            alignItems: 'center',
          }}
        >
          {dogeMiningImageUrl ? (
            <img src={dogeMiningImageUrl} alt="" width={120} height={120} style={{ borderRadius: 12 }} />
          ) : null}
          <h1 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
            Upgrading…
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
            Re-sealing your seed into the v0.3 keystore and signing you in.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--smirk-fg-muted)', opacity: 0.75 }}>
            You can now run your own backend for max privacy and control. Find
            out more on the next screen (or the website).
          </p>
        </div>
      )}

      {step === 'done' && (
        <>
          <h1 style={{ margin: 0, fontSize: 21, color: 'var(--smirk-accent)' }}>
            You're on v0.3 😏
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--smirk-fg-muted)' }}>
            {/* Never claim the money moved unless it did. This said "Funds swept
                to your new BTC/LTC addresses" unconditionally, including when the
                broadcast failed and when there was nothing to sweep. */}
            {sweepSummary ?? 'Your wallet is upgraded.'} You've got a Nostr
            identity now (npub), derived from your seed.
          </p>
          <div
            style={{
              background: 'var(--smirk-bg-sunken)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 8,
              padding: 12,
              fontSize: 13,
              color: 'var(--smirk-fg-muted)',
            }}
          >
            <strong style={{ color: 'var(--smirk-fg)' }}>Run your own backend?</strong>{' '}
            For max privacy, point Smirk at a backend you run (or another
            operator's). Best set up as a <strong>fresh wallet</strong>, so this
            one keeps its <code>@handle</code> and history here. Settings →
            Backend, any time.
          </div>
          <Button variant="primary" testid="migrate-done-btn" onClick={onDone}>
            Open wallet
          </Button>
        </>
      )}
    </div>
  );
}
