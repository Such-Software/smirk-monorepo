/**
 * OnboardingWizard — first-run flow: create or import a wallet.
 *
 * Steps:
 *   0. Welcome:    Create new | Import existing
 *   1a (create).   Show generated mnemonic — user writes it down
 *   1b (import).   Warning screen — Smirk only restores Smirk-created seeds
 *   1b'.           12 numbered word boxes — paste-fills all at once
 *   2 (create).    Verify by re-entering N random words
 *   3.             Set password (twice)
 *   4.             onComplete(mnemonic, password) seals the keystore
 *   5 (optional).  Set up Smirk — handle reservation + privacy toggle
 *   6.             onFullyDone — caller refreshes wallet state, shows Home
 *
 * The setup step (5) only renders if the caller wires `reserveSmirkName`
 * AND/OR `setInjectEnabled`. Existing callers that don't pass these
 * skip straight from 4 to 6 with no behavior change.
 *
 * In-progress mnemonic state lives in `useState` only. NOT persisted via
 * `useWizard` — that would write the unencrypted mnemonic to
 * `chrome.storage.session`, the legacy pattern flagged in the
 * 2026-05-10 audit. Closing the popup mid-flow drops the half-generated
 * seed; the user re-does onboarding. UX cost we accept.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Button } from './Button';

/**
 * One linked third-party social (Telegram, Discord, Matrix, …).
 * Mirrors `LinkedSocialAccount` from `@smirk/core` so we don't
 * import that here — keeps `@smirk/ui` API-free. Caller projects
 * the backend response into this shape.
 */
export interface ExistingSocial {
  /** Lowercase machine name: `'telegram'`, `'discord'`, `'matrix'`, … */
  readonly platform: string;
  /** Display handle to show next to the platform. */
  readonly username: string;
  /** Already-verified via the platform's bot/OAuth flow. */
  readonly verified: boolean;
}

/**
 * Backend-derived identity that survives a wallet import. Either
 * field may be empty; a non-empty `smirkName` OR non-empty
 * `linkedSocials` is enough to render the "Welcome back" panel.
 */
export interface ExistingIdentity {
  /** Reserved Smirk @handle, or omitted if none. */
  readonly smirkName?: string;
  /** Linked third-party socials, in display order. */
  readonly linkedSocials: readonly ExistingSocial[];
}

export interface OnboardingWizardProps {
  /** Generate a fresh BIP39 mnemonic. Caller wires `generateMnemonicPhrase` from `@smirk/core`. */
  generateMnemonic: () => string;
  /** Validate a user-supplied mnemonic. Caller wires `isValidMnemonic` from `@smirk/core`. */
  isValidMnemonic: (mnemonic: string) => boolean;
  /**
   * Persist the wallet AND bootstrap (auth + token) so the optional
   * setup step has a JWT for backend calls. Caller wires this to
   * `walletKeystore.createWallet` + `bootstrapAuth`. May throw —
   * the wizard surfaces the error and lets the user retry the password.
   */
  onComplete: (mnemonic: string, password: string) => Promise<void>;
  /**
   * Called once the user finishes (or skips) the post-create setup
   * step. Caller refreshes wallet state here to unmount the wizard
   * and reveal the main app. If omitted, the wizard renders the
   * "Wallet ready." status until the parent un-renders it.
   */
  onFullyDone?: () => Promise<void> | void;
  /**
   * Reserve a Smirk @handle. If omitted, the handle row in the
   * setup step doesn't render. The caller is expected to have a
   * valid auth token before the setup step runs (i.e., onComplete
   * also bootstraps). Should throw with a user-friendly message
   * — the wizard surfaces it inline and keeps the field editable.
   */
  reserveSmirkName?: (handle: string) => Promise<void>;
  /**
   * Identity the imported wallet already owns on the backend (Smirk
   * handle + linked third-party socials). Set when the caller's
   * `onComplete` resolves a prior identity — typical on import to a
   * fresh device. The setup step renders a "Welcome back" panel
   * summarising what carries over instead of the reserve-handle
   * prompt. Omit on create or when both lookups returned empty.
   *
   * `linkedSocials` is treated as opaque rows by the wizard — caller
   * passes whatever platforms the backend reports, including future
   * ones (Matrix, Bluesky, etc.) without a wizard update.
   */
  existingIdentity?: ExistingIdentity;
  /**
   * Persist the user's choice for `window.smirk` injection on
   * websites. If omitted, the privacy toggle in the setup step
   * doesn't render. Defaults to enabled when shown.
   */
  setInjectEnabled?: (enabled: boolean) => Promise<void>;
  /** Number of words to require during the verification step (create flow). Default 3. */
  verifyCount?: number;
  /**
   * URL the consumer serves the "doge mining" animated WebP from.
   * Drawn during the PoW solve in the submitting step. Falls back
   * to a bouncing 🐕 emoji when omitted — for hosts that don't ship
   * the asset (tests, Storybook).
   *
   * Why a URL prop rather than a bundled import: `@smirk/ui` stays
   * asset-free so themes / bundlers don't have to learn about a new
   * non-font asset. Each consumer (the extension, the Tauri desktop,
   * the Capacitor mobile build) maps it to its own runtime path.
   */
  dogeMiningImageUrl?: string;
  class?: string;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'show'; mnemonic: string }
  | { kind: 'verify'; mnemonic: string; indices: number[] }
  | { kind: 'import-warning' }
  | { kind: 'import' }
  | { kind: 'password'; mnemonic: string; isImport: boolean }
  | { kind: 'submitting' }
  | { kind: 'setup' }
  | { kind: 'done' };

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => setStep({ kind: 'show', mnemonic: props.generateMnemonic() });
  const startImport = () => setStep({ kind: 'import-warning' });
  const proceedToVerify = (mnemonic: string) => {
    const wordCount = mnemonic.trim().split(/\s+/).length;
    // 3/12 matches the industry middle of the road: Stack Wallet
    // does 1-2, Cake Wallet does 2-3, BlueWallet does 3-4. Going
    // higher catches a few more transposition mistakes but costs
    // real onboarding-completion rate, especially on mobile.
    // Override via the `verifyCount` prop if a wallet variant
    // genuinely needs a different number.
    const indices = pickRandomIndices(wordCount, props.verifyCount ?? 3);
    setStep({ kind: 'verify', mnemonic, indices });
  };
  const proceedToPassword = (mnemonic: string, isImport: boolean) =>
    setStep({ kind: 'password', mnemonic, isImport });

  // The setup step renders only when the caller wired at least one
  // post-create action. Old callers that didn't pass either callback
  // skip straight to 'done' — no UI change for them.
  const hasSetupStep = Boolean(props.reserveSmirkName ?? props.setInjectEnabled);

  const finishSetup = async () => {
    setStep({ kind: 'done' });
    // Defer to the next tick so the "Wallet ready." status renders
    // briefly before the parent un-renders us — avoids a flash of
    // empty space if the parent refresh is synchronous.
    setTimeout(() => {
      void props.onFullyDone?.();
    }, 250);
  };

  const handleSubmit = async (mnemonic: string, password: string, isImport: boolean) => {
    setStep({ kind: 'submitting' });
    setError(null);
    try {
      await props.onComplete(mnemonic, password);
      if (hasSetupStep) {
        setStep({ kind: 'setup' });
      } else {
        await finishSetup();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create wallet');
      setStep({ kind: 'password', mnemonic, isImport });
    }
  };

  return (
    <div
      class={props.class}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '8px 4px 16px',
        minHeight: 0,
      }}
    >
      {step.kind === 'welcome' && <Welcome onCreate={startCreate} onImport={startImport} />}

      {step.kind === 'show' && (
        <ShowMnemonic
          mnemonic={step.mnemonic}
          onContinue={() => proceedToVerify(step.mnemonic)}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'verify' && (
        <VerifyMnemonic
          mnemonic={step.mnemonic}
          indices={step.indices}
          onSuccess={() => proceedToPassword(step.mnemonic, false)}
          onBack={() => setStep({ kind: 'show', mnemonic: step.mnemonic })}
        />
      )}

      {step.kind === 'import-warning' && (
        <ImportWarning
          onContinue={() => setStep({ kind: 'import' })}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'import' && (
        <ImportMnemonic
          isValidMnemonic={props.isValidMnemonic}
          onContinue={(mnemonic) => proceedToPassword(mnemonic, true)}
          onBack={() => setStep({ kind: 'import-warning' })}
        />
      )}

      {step.kind === 'password' && (
        <SetPassword
          {...(error ? { error } : {})}
          isImport={step.isImport}
          onSubmit={(pw) => void handleSubmit(step.mnemonic, pw, step.isImport)}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'submitting' && (
        <PowSubmittingStatus
          {...(props.dogeMiningImageUrl
            ? { dogeImageUrl: props.dogeMiningImageUrl }
            : {})}
        />
      )}

      {step.kind === 'setup' && (
        <SmirkSetup
          {...(props.reserveSmirkName ? { reserveSmirkName: props.reserveSmirkName } : {})}
          {...(props.setInjectEnabled ? { setInjectEnabled: props.setInjectEnabled } : {})}
          {...(props.existingIdentity ? { existingIdentity: props.existingIdentity } : {})}
          onContinue={finishSetup}
        />
      )}

      {step.kind === 'done' && <FullPageStatus>Wallet ready.</FullPageStatus>}
    </div>
  );
}

// ============================================================================
// Step components
// ============================================================================

function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '40px 12px 16px',
        gap: 24,
      }}
    >
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 10px' }}>
          Welcome to Smirk
        </h1>
        <p style={{ fontSize: 13, opacity: 0.65, margin: 0, lineHeight: 1.45 }}>
          Five chains. Tip by username.
          <br />
          Non-custodial — you hold the keys.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
        <Button onClick={onCreate} testid="onboarding-create-btn">Create new wallet</Button>
        <Button variant="secondary" onClick={onImport} testid="onboarding-import-btn">
          Import existing
        </Button>
      </div>
    </div>
  );
}

function ShowMnemonic({
  mnemonic,
  onContinue,
  onBack,
}: {
  mnemonic: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  const words = mnemonic.trim().split(/\s+/);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div>
      <ScreenHeader title="Your recovery phrase" onBack={onBack} />
      <p style={bodyTextStyle}>
        Write these {words.length} words down in order. Anyone with this phrase
        can spend your funds. Smirk does not store it.
      </p>
      <p style={{ ...bodyTextStyle, margin: '0 0 16px', opacity: 0.55 }}>
        This is a standard BIP39 seed. It also restores in Cake Wallet (XMR /
        WOW), grin-wallet (Grin), and any BIP84 wallet like Sparrow or
        Electrum (BTC / LTC) — you're not locked in to Smirk.
      </p>
      <ol
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 6,
          padding: '14px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          fontSize: 14,
          fontFamily: 'monospace',
          margin: '0 0 16px',
          listStyle: 'none',
          counterReset: 'word',
        }}
      >
        {words.map((w, i) => (
          <li
            key={i}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              padding: '4px 6px',
            }}
          >
            <span
              style={{
                opacity: 0.45,
                fontSize: 11,
                width: 22,
                textAlign: 'right',
              }}
            >
              {(i + 1).toString().padStart(2, '0')}
            </span>
            <span data-testid={`onboarding-create-seed-word-${i}`}>{w}</span>
          </li>
        ))}
      </ol>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          fontSize: 12,
          padding: '8px 0 16px',
          opacity: 0.85,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged((e.target as HTMLInputElement).checked)}
          style={{ marginTop: 2 }}
        />
        <span>I have written it down somewhere safe.</span>
      </label>
      <Button
        disabled={!acknowledged}
        onClick={onContinue}
        testid="onboarding-create-backed-up-continue"
      >
        Continue
      </Button>
    </div>
  );
}

function VerifyMnemonic({
  mnemonic,
  indices,
  onSuccess,
  onBack,
}: {
  mnemonic: string;
  indices: number[];
  onSuccess: () => void;
  onBack: () => void;
}) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [entries, setEntries] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    for (const i of indices) {
      const expected = words[i];
      const got = (entries[i] ?? '').trim().toLowerCase();
      if (got !== expected) {
        setError(`Word #${i + 1} doesn't match.`);
        return;
      }
    }
    setError(null);
    onSuccess();
  };

  return (
    <div>
      <ScreenHeader title="Verify your phrase" onBack={onBack} />
      <p style={bodyTextStyle}>
        Type the requested words from your recovery phrase to confirm you wrote
        them down.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {indices.map((i, idx) => (
          <label
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}
          >
            <span style={{ width: 72, opacity: 0.6 }}>Word #{i + 1}</span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoFocus={idx === 0}
              spellcheck={false}
              value={entries[i] ?? ''}
              data-testid={`onboarding-verify-word-${i}`}
              onInput={(e) =>
                setEntries({ ...entries, [i]: (e.target as HTMLInputElement).value })
              }
              style={inputStyle}
            />
          </label>
        ))}
      </div>
      {error && <FieldError>{error}</FieldError>}
      <Button onClick={handleSubmit} testid="onboarding-create-continue">Continue</Button>
    </div>
  );
}

/**
 * Import screen with a 12-box grid. Pasting a 12-word phrase into any
 * box distributes the words across all boxes; pasting a single word
 * fills only that box.
 *
 * Smirk only generates 12-word phrases, so we don't accept 24-word
 * imports — keeping the surface tight on what the wallet actually
 * produces.
 */
const IMPORT_WORD_COUNT = 12;

function ImportMnemonic({
  isValidMnemonic,
  onContinue,
  onBack,
}: {
  isValidMnemonic: (m: string) => boolean;
  onContinue: (m: string) => void;
  onBack: () => void;
}) {
  const [words, setWords] = useState<string[]>(() => Array(IMPORT_WORD_COUNT).fill(''));
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const setWordAt = (idx: number, value: string) => {
    setWords((prev) => {
      const next = prev.slice();
      next[idx] = value;
      return next;
    });
    setError(null);
  };

  // Detect a paste of 12 whitespace-separated words and distribute them
  // across all boxes, instead of dumping into the focused one.
  const handlePaste = (idx: number, e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') ?? '';
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === IMPORT_WORD_COUNT) {
      e.preventDefault();
      setWords(tokens.map((t) => t.toLowerCase()));
      setError(null);
      // Focus the last box for keyboard continuity.
      setTimeout(() => inputRefs.current[IMPORT_WORD_COUNT - 1]?.focus(), 0);
    } else if (tokens.length > 1 && tokens.length <= IMPORT_WORD_COUNT - idx) {
      // Pasting a partial run: fill from idx onward.
      e.preventDefault();
      setWords((prev) => {
        const next = prev.slice();
        for (let i = 0; i < tokens.length; i++) next[idx + i] = tokens[i]!.toLowerCase();
        return next;
      });
      setTimeout(() => inputRefs.current[idx + tokens.length - 1]?.focus(), 0);
    }
    // Single-word or odd-length paste falls through to default behavior.
  };

  const handleKey = (idx: number, e: KeyboardEvent) => {
    if (e.key === ' ' && (e.target as HTMLInputElement).value.trim() !== '') {
      e.preventDefault();
      inputRefs.current[idx + 1]?.focus();
    }
  };

  const handleSubmit = () => {
    const phrase = words.map((w) => w.trim().toLowerCase()).filter(Boolean).join(' ');
    if (words.some((w) => !w.trim())) {
      setError(`All ${IMPORT_WORD_COUNT} words required.`);
      return;
    }
    if (!isValidMnemonic(phrase)) {
      setError('Not a valid BIP39 phrase. Check spelling and word order.');
      return;
    }
    setError(null);
    onContinue(phrase);
  };

  return (
    <div>
      <ScreenHeader title="Import recovery phrase" onBack={onBack} />
      <p style={{ ...bodyTextStyle, margin: '4px 0 6px' }}>
        Type or paste your 12-word Smirk recovery phrase.
      </p>
      <p style={{ ...bodyTextStyle, margin: '0 0 18px', opacity: 0.55, fontSize: 12 }}>
        Tip: paste the full phrase into any box — it auto-fills the rest.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 10,
          marginBottom: 20,
        }}
      >
        {words.map((w, i) => (
          <div
            key={i}
            class="smirk-mnemonic-cell"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 8,
              padding: '8px 10px',
              transition: 'border-color 120ms ease, background 120ms ease',
            }}
          >
            <span
              style={{
                opacity: 0.4,
                fontSize: 11,
                minWidth: 18,
                textAlign: 'right',
                fontFamily: 'monospace',
                userSelect: 'none',
              }}
            >
              {(i + 1).toString().padStart(2, '0')}
            </span>
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="text"
              value={w}
              data-testid={`onboarding-import-word-${i}`}
              onInput={(e) => setWordAt(i, (e.target as HTMLInputElement).value)}
              onPaste={(e) => handlePaste(i, e as ClipboardEvent)}
              onKeyDown={(e) => handleKey(i, e as KeyboardEvent)}
              autoComplete="off"
              autoCapitalize="off"
              spellcheck={false}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'inherit',
                fontFamily: 'monospace',
                fontSize: 14,
                padding: '2px 0',
                width: '100%',
                minWidth: 0,
              }}
            />
          </div>
        ))}
      </div>

      {error && <FieldError>{error}</FieldError>}
      <Button onClick={handleSubmit} testid="onboarding-import-continue">Continue</Button>
    </div>
  );
}

function SetPassword({
  onSubmit,
  onBack,
  error,
  isImport,
}: {
  onSubmit: (password: string) => void;
  onBack: () => void;
  error?: string;
  isImport: boolean;
}) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const minLen = 8;
  const handleSubmit = () => {
    if (pw1.length < minLen) {
      setLocalError(`Password must be at least ${minLen} characters.`);
      return;
    }
    if (pw1 !== pw2) {
      setLocalError("Passwords don't match.");
      return;
    }
    setLocalError(null);
    onSubmit(pw1);
  };

  return (
    <div>
      <ScreenHeader title="Set a password" onBack={onBack} />
      <p style={bodyTextStyle}>
        Encrypts your wallet on this device. There is no recovery — losing it
        means re-importing from your phrase.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <input
          type="password"
          placeholder="Password"
          autoFocus
          value={pw1}
          data-testid="onboarding-password-input"
          onInput={(e) => setPw1((e.target as HTMLInputElement).value)}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Confirm password"
          value={pw2}
          data-testid="onboarding-password-confirm-input"
          onInput={(e) => setPw2((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if ((e as KeyboardEvent).key === 'Enter') handleSubmit();
          }}
          style={inputStyle}
        />
      </div>
      {(localError || error) && <FieldError>{localError ?? error}</FieldError>}
      <Button onClick={handleSubmit} testid="onboarding-set-password-submit">{isImport ? 'Import wallet' : 'Create wallet'}</Button>
    </div>
  );
}

function ImportWarning({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <ScreenHeader title="Before you import" onBack={onBack} />
      <p style={{ ...bodyTextStyle, margin: '4px 0 14px' }}>
        Only paste a phrase that was originally generated in Smirk.
      </p>
      <div
        style={{
          borderLeft: '3px solid var(--smirk-warning, #f59e0b)',
          background: 'rgba(245, 158, 11, 0.06)',
          padding: '12px 14px',
          borderRadius: 8,
          marginBottom: 18,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          A seed from another wallet won't work as you expect
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            opacity: 0.85,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <li>
            MetaMask, Cake, Electrum, Trezor, etc. use different
            derivation paths.
          </li>
          <li>
            You'll see empty balances — funds are safe, but visible in
            the wallet that generated the seed.
          </li>
          <li>
            To move funds into Smirk, send to a Smirk receive address
            after onboarding.
          </li>
        </ul>
      </div>
      <Button onClick={onContinue} testid="onboarding-import-warning-continue">Continue with Smirk seed</Button>
    </div>
  );
}

function SmirkSetup({
  reserveSmirkName,
  setInjectEnabled,
  existingIdentity,
  onContinue,
}: {
  reserveSmirkName?: (handle: string) => Promise<void>;
  setInjectEnabled?: (enabled: boolean) => Promise<void>;
  existingIdentity?: ExistingIdentity;
  onContinue: () => Promise<void> | void;
}) {
  const hasExistingIdentity = Boolean(
    existingIdentity?.smirkName || (existingIdentity?.linkedSocials?.length ?? 0) > 0,
  );
  const [handle, setHandle] = useState('');
  const [handleStatus, setHandleStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'submitting' }
    | { kind: 'reserved'; handle: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  // Default ON to match the inject-policy default (closes the
  // fingerprinting issue's short-term ask while preserving dapp
  // interop out of the box — see background/dapp/inject-policy.ts).
  const [injectEnabled, setInjectEnabledState] = useState(true);

  // Client-side handle validation mirrors the backend rules
  // (3-32 chars, lowercase alphanumerics + underscores) so the user
  // gets immediate feedback before the network round-trip.
  const handleNormalized = handle.trim().toLowerCase().replace(/^@/, '');
  const handleValid =
    handleNormalized.length >= 3 &&
    handleNormalized.length <= 32 &&
    /^[a-z0-9_]+$/.test(handleNormalized);
  const showHandleHint =
    handle.length > 0 && !handleValid && handleStatus.kind !== 'submitting';

  const submitHandle = async () => {
    if (!reserveSmirkName || !handleValid) return;
    setHandleStatus({ kind: 'submitting' });
    try {
      await reserveSmirkName(handleNormalized);
      setHandleStatus({ kind: 'reserved', handle: handleNormalized });
    } catch (e) {
      setHandleStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not reserve that name',
      });
    }
  };

  const submitAndContinue = async () => {
    // Always persist the inject choice (default ON unchanged is
    // still a write — keeps the storage value in sync with what
    // the user just saw).
    if (setInjectEnabled) {
      try {
        await setInjectEnabled(injectEnabled);
      } catch (e) {
        console.warn('[onboarding] setInjectEnabled failed', e);
      }
    }
    await onContinue();
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 6px' }}>
        Set up Smirk
      </h2>
      <p style={bodyTextStyle}>
        Two quick choices. Both are optional and changeable in
        Settings later.
      </p>

      {hasExistingIdentity ? (
        <WelcomeBackPanel identity={existingIdentity!} />
      ) : reserveSmirkName && (
        <section
          style={{
            background: 'var(--smirk-bg-sunken, rgba(255,255,255,0.03))',
            border: '1px solid var(--smirk-border, rgba(255,255,255,0.08))',
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>
            Reserve your @handle
          </h3>
          <p style={{ ...bodyTextStyle, margin: '0 0 10px', fontSize: 12 }}>
            Let people tip you by name from smirk.cash and (soon)
            Telegram + Discord. Skip and pick one later if you're
            not ready.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flex: 1,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: 8,
                padding: '0 10px',
                minWidth: 0,
              }}
            >
              <span style={{ opacity: 0.45, fontSize: 14 }}>@</span>
              <input
                type="text"
                placeholder="your_handle"
                value={handle}
                disabled={
                  handleStatus.kind === 'submitting' ||
                  handleStatus.kind === 'reserved'
                }
                autoComplete="off"
                autoCapitalize="off"
                spellcheck={false}
                onInput={(e) => {
                  setHandle((e.target as HTMLInputElement).value);
                  if (handleStatus.kind === 'error') {
                    setHandleStatus({ kind: 'idle' });
                  }
                }}
                onKeyDown={(e) => {
                  if ((e as KeyboardEvent).key === 'Enter') void submitHandle();
                }}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'inherit',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  padding: '10px 6px',
                  minWidth: 0,
                }}
              />
            </div>
            <Button
              fullWidth={false}
              disabled={
                !handleValid ||
                handleStatus.kind === 'submitting' ||
                handleStatus.kind === 'reserved'
              }
              onClick={() => void submitHandle()}
            >
              {handleStatus.kind === 'submitting'
                ? 'Reserving…'
                : handleStatus.kind === 'reserved'
                  ? 'Reserved'
                  : 'Reserve'}
            </Button>
          </div>
          {showHandleHint && (
            <FieldError>
              3-32 characters, lowercase letters / digits / underscore only.
            </FieldError>
          )}
          {handleStatus.kind === 'error' && (
            <FieldError>{handleStatus.message}</FieldError>
          )}
          {handleStatus.kind === 'reserved' && (
            <p
              style={{
                fontSize: 12,
                color: 'var(--smirk-positive, #4ade80)',
                margin: '8px 0 0',
              }}
            >
              ✓ @{handleStatus.handle} reserved.
            </p>
          )}
        </section>
      )}

      {setInjectEnabled && (
        <section
          style={{
            background: 'var(--smirk-bg-sunken, rgba(255,255,255,0.03))',
            border: '1px solid var(--smirk-border, rgba(255,255,255,0.08))',
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={injectEnabled}
              onChange={(e) =>
                setInjectEnabledState((e.target as HTMLInputElement).checked)
              }
              style={{ marginTop: 2 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Enable Smirk on websites
              </div>
              <p
                style={{
                  fontSize: 12,
                  opacity: 0.65,
                  margin: '4px 0 0',
                  lineHeight: 1.4,
                }}
              >
                Lets sites like smirk.cash detect the wallet so you
                can connect, sign in, and tip. Trade-off: every page
                can detect Smirk is installed. Reversible in Settings.
              </p>
            </div>
          </label>
        </section>
      )}

      <Button onClick={() => void submitAndContinue()} testid="onboarding-setup-finish-btn">
        {handleStatus.kind === 'reserved' || hasExistingIdentity
          ? 'Continue'
          : 'Skip for now'}
      </Button>
    </div>
  );
}

/**
 * "Welcome back" panel shown on import when the backend reports the
 * wallet already owns a Smirk handle and/or has linked socials. Three
 * shapes:
 *  - Smirk handle only
 *  - Linked socials only (no Smirk handle reserved)
 *  - Both
 *
 * The linked-socials list is rendered generically: one row per
 * platform with a small platform-tag and the username. No per-
 * platform special-casing — adding a new platform (Matrix, Bluesky,
 * etc.) is a backend ship with zero UI changes here.
 */
function WelcomeBackPanel({ identity }: { identity: ExistingIdentity }) {
  const { smirkName, linkedSocials } = identity;
  const hasSmirk = Boolean(smirkName);
  const hasSocials = linkedSocials.length > 0;

  const headline = hasSmirk
    ? `Welcome back, @${smirkName}`
    : 'Welcome back';
  const subhead = hasSmirk
    ? 'Your handle is already reserved. You can rename it any time from Settings.'
    : 'These platforms are linked to this wallet. Manage them any time from Settings.';

  return (
    <section
      style={{
        background: 'var(--smirk-bg-sunken, rgba(255,255,255,0.03))',
        border: '1px solid var(--smirk-border, rgba(255,255,255,0.08))',
        borderRadius: 10,
        padding: 14,
        marginBottom: 12,
      }}
    >
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>
        {headline}
      </h3>
      <p style={{ ...bodyTextStyle, margin: 0, fontSize: 12 }}>
        {subhead}
      </p>

      {hasSocials && (
        <ul
          style={{
            margin: '10px 0 0',
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {linkedSocials.map((s) => (
            <LinkedSocialRow
              key={`${s.platform}:${s.username}`}
              social={s}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LinkedSocialRow({ social }: { social: ExistingSocial }) {
  // Show the platform name in title-case, the username, and a small
  // verified/pending badge. No platform-specific glyphs — the wallet
  // doesn't bundle social-network logos and the row stays compact.
  const label =
    social.platform.length > 0
      ? social.platform[0]!.toUpperCase() + social.platform.slice(1)
      : 'Platform';
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        padding: '6px 8px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          opacity: 0.6,
          minWidth: 56,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {social.username}
      </span>
      <span
        style={{
          fontSize: 10,
          padding: '2px 6px',
          borderRadius: 4,
          background: social.verified
            ? 'rgba(34, 197, 94, 0.12)'
            : 'rgba(245, 158, 11, 0.12)',
          color: social.verified
            ? 'var(--smirk-positive, #22c55e)'
            : 'var(--smirk-warning, #f59e0b)',
          fontWeight: 600,
        }}
      >
        {social.verified ? 'Verified' : 'Pending'}
      </span>
    </li>
  );
}

// ============================================================================
// Shared chrome
// ============================================================================

function ScreenHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}
    >
      <button
        onClick={onBack}
        aria-label="Back"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 13,
          padding: '6px 8px',
          opacity: 0.75,
        }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
      <span style={{ width: 60 }} />
    </div>
  );
}

function FieldError({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        color: '#ff6b6b',
        fontSize: 12,
        padding: '6px 0 12px',
      }}
    >
      {children}
    </div>
  );
}

function FullPageStatus({ children }: { children: ComponentChildren }) {
  return (
    <div style={{ padding: '60px 16px', textAlign: 'center', opacity: 0.7, fontSize: 14 }}>
      {children}
    </div>
  );
}

/**
 * `PowSubmittingStatus` — what the user stares at while
 * `props.onComplete` does its three things:
 *   1. Encrypts the seed under the user's password
 *   2. Solves the ALTCHA proof-of-work challenge the backend issues
 *      (~1-2s of PBKDF2 on a laptop)
 *   3. Registers the wallet against /auth/extension
 *
 * Renders a bouncing doge with doge-meme phrases cycling underneath.
 * The fact that PBKDF2 is *actually* compute-bound makes the dancing
 * doge legitimate — the page isn't pretending to work; it really is
 * grinding hashes. Better than a static "Loading…" both for honesty
 * and for telling people what proof-of-work even is.
 *
 * The phrase cycle deliberately includes the word "proof-of-work" so
 * users who don't get the joke still get the meaning.
 */
function PowSubmittingStatus({ dogeImageUrl }: { dogeImageUrl?: string }) {
  const phrases = [
    'wow',
    'much PoW',
    'such proof',
    'very work',
    'so hash',
    'many bits',
    'much crypto',
    'wow so secure',
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % phrases.length);
    }, 700);
    return () => clearInterval(t);
    // phrases is a stable literal; ESLint dep-list would complain
    // unnecessarily, hence the inline disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Doge-meme palette — these are the canonical comic-sans-rainbow
  // colours the meme uses. One per phrase, cycling with the same
  // index so each new phrase gets its own colour.
  const palette = [
    '#ff6b9d', // pink
    '#ffd93d', // yellow
    '#6bcb77', // green
    '#4d96ff', // blue
    '#ff9f43', // orange
    '#9d5cff', // purple
    '#ff5e57', // red
    '#1dd1a1', // teal
  ];

  return (
    <div
      style={{
        padding: '48px 16px 16px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
      }}
    >
      {dogeImageUrl ? (
        // Honest-to-god animated doge mining WebP. Loops on its own.
        // Wrap so the surrounding bounce animation applies to the
        // whole graphic, not the img's internal frames.
        <div
          aria-hidden="true"
          style={{
            animation: 'smirk-doge-bounce 0.9s ease-in-out infinite',
          }}
        >
          <img
            src={dogeImageUrl}
            alt=""
            style={{
              width: 140,
              height: 'auto',
              display: 'block',
              imageRendering: 'auto',
            }}
          />
        </div>
      ) : (
        // Fallback for hosts that don't ship the doge asset (tests,
        // Storybook, dev environments without the file copied).
        <div
          aria-hidden="true"
          style={{
            fontSize: 64,
            lineHeight: 1,
            animation: 'smirk-doge-bounce 0.9s ease-in-out infinite',
          }}
        >
          🐕
        </div>
      )}

      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          opacity: 0.9,
        }}
      >
        Setting up wallet…
      </div>

      <div
        role="status"
        aria-live="polite"
        style={{
          fontFamily: 'Comic Sans MS, Comic Sans, cursive',
          fontSize: 22,
          fontWeight: 700,
          color: palette[idx],
          transition: 'color 0.3s ease',
          minHeight: 30,
          letterSpacing: '0.02em',
          textShadow: '0 1px 2px rgba(0,0,0,0.25)',
        }}
      >
        {phrases[idx]}
      </div>

      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          maxWidth: 280,
          lineHeight: 1.4,
        }}
      >
        Solving a proof-of-work puzzle to prove you&rsquo;re probably
        human. Takes a second or two — bots hate it; you won&rsquo;t
        notice it.
      </div>

      <style>{`
        @keyframes smirk-doge-bounce {
          0%, 100% { transform: translateY(0) rotate(-3deg); }
          50%      { transform: translateY(-14px) rotate(3deg); }
        }
      `}</style>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  fontSize: 14,
  padding: '12px 14px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8,
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box' as const,
} as const;

const bodyTextStyle = {
  fontSize: 13,
  opacity: 0.7,
  margin: '0 0 16px',
  lineHeight: 1.5,
} as const;

/**
 * Pick `count` distinct random indices in `[0, total)`. Used to choose
 * which words to ask the user to retype during seed verification.
 *
 * `Math.random` is fine here — these positions get shown to the user;
 * they are *not* key material.
 */
function pickRandomIndices(total: number, count: number): number[] {
  const result: number[] = [];
  while (result.length < Math.min(count, total)) {
    const i = Math.floor(Math.random() * total);
    if (!result.includes(i)) result.push(i);
  }
  return result.sort((a, b) => a - b);
}
