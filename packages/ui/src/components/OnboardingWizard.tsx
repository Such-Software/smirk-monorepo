/**
 * OnboardingWizard — first-run flow: create or import a wallet.
 *
 * Steps:
 *   0. Welcome:   Create new | Import existing
 *   1a (create). Show generated mnemonic — user writes it down
 *   1b (import). 12 / 24 numbered word boxes — paste-fills all at once
 *   2 (create only). Verify by re-entering N random words
 *   3. Set password (twice)
 *   4. Done — calls `onComplete(mnemonic, password)` to seal the keystore
 *
 * In-progress mnemonic state lives in `useState` only. NOT persisted via
 * `useWizard` — that would write the unencrypted mnemonic to
 * `chrome.storage.session`, the legacy pattern flagged in the
 * 2026-05-10 audit. Closing the popup mid-flow drops the half-generated
 * seed; the user re-does onboarding. UX cost we accept.
 */

import { useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Button } from './Button';

export interface OnboardingWizardProps {
  /** Generate a fresh BIP39 mnemonic. Caller wires `generateMnemonicPhrase` from `@smirk/core`. */
  generateMnemonic: () => string;
  /** Validate a user-supplied mnemonic. Caller wires `isValidMnemonic` from `@smirk/core`. */
  isValidMnemonic: (mnemonic: string) => boolean;
  /**
   * Persist the wallet. Caller wires this to
   * `walletKeystore.createWallet({ mnemonic, password })`. May throw —
   * the wizard surfaces the error and lets the user retry the password.
   */
  onComplete: (mnemonic: string, password: string) => Promise<void>;
  /** Number of words to require during the verification step (create flow). Default 3. */
  verifyCount?: number;
  class?: string;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'show'; mnemonic: string }
  | { kind: 'verify'; mnemonic: string; indices: number[] }
  | { kind: 'import' }
  | { kind: 'password'; mnemonic: string }
  | { kind: 'submitting' }
  | { kind: 'done' };

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => setStep({ kind: 'show', mnemonic: props.generateMnemonic() });
  const startImport = () => setStep({ kind: 'import' });
  const proceedToVerify = (mnemonic: string) => {
    const wordCount = mnemonic.trim().split(/\s+/).length;
    const indices = pickRandomIndices(wordCount, props.verifyCount ?? 3);
    setStep({ kind: 'verify', mnemonic, indices });
  };
  const proceedToPassword = (mnemonic: string) => setStep({ kind: 'password', mnemonic });

  const handleSubmit = async (mnemonic: string, password: string) => {
    setStep({ kind: 'submitting' });
    setError(null);
    try {
      await props.onComplete(mnemonic, password);
      setStep({ kind: 'done' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create wallet');
      setStep({ kind: 'password', mnemonic });
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
          onSuccess={() => proceedToPassword(step.mnemonic)}
          onBack={() => setStep({ kind: 'show', mnemonic: step.mnemonic })}
        />
      )}

      {step.kind === 'import' && (
        <ImportMnemonic
          isValidMnemonic={props.isValidMnemonic}
          onContinue={proceedToPassword}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'password' && (
        <SetPassword
          {...(error ? { error } : {})}
          onSubmit={(pw) => void handleSubmit(step.mnemonic, pw)}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'submitting' && <FullPageStatus>Encrypting wallet…</FullPageStatus>}

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
          Multi-currency tip wallet.
          <br />
          Non-custodial — you hold the keys.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
        <Button onClick={onCreate}>Create new wallet</Button>
        <Button variant="secondary" onClick={onImport}>
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
            <span>{w}</span>
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
      <Button disabled={!acknowledged} onClick={onContinue}>
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
              onInput={(e) =>
                setEntries({ ...entries, [i]: (e.target as HTMLInputElement).value })
              }
              style={inputStyle}
            />
          </label>
        ))}
      </div>
      {error && <FieldError>{error}</FieldError>}
      <Button onClick={handleSubmit}>Continue</Button>
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
      <p style={bodyTextStyle}>
        Type or paste your 12-word Smirk recovery phrase. Pasting a full
        phrase into any box auto-fills the rest.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 6,
          marginBottom: 16,
        }}
      >
        {words.map((w, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              padding: '4px 8px',
            }}
          >
            <span
              style={{
                opacity: 0.45,
                fontSize: 11,
                width: 18,
                textAlign: 'right',
                fontFamily: 'monospace',
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
                fontSize: 13,
                padding: '4px 0',
                width: '100%',
                minWidth: 0,
              }}
            />
          </div>
        ))}
      </div>

      {error && <FieldError>{error}</FieldError>}
      <Button onClick={handleSubmit}>Continue</Button>
    </div>
  );
}

function SetPassword({
  onSubmit,
  onBack,
  error,
}: {
  onSubmit: (password: string) => void;
  onBack: () => void;
  error?: string;
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
          onInput={(e) => setPw1((e.target as HTMLInputElement).value)}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Confirm password"
          value={pw2}
          onInput={(e) => setPw2((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if ((e as KeyboardEvent).key === 'Enter') handleSubmit();
          }}
          style={inputStyle}
        />
      </div>
      {(localError || error) && <FieldError>{localError ?? error}</FieldError>}
      <Button onClick={handleSubmit}>Create wallet</Button>
    </div>
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
