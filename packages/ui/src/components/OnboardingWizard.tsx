/**
 * OnboardingWizard, first-run flow: create or import a wallet.
 *
 * Steps:
 *   0. Welcome:    Create new | Import existing
 *   1a (create).   Show generated mnemonic: user writes it down
 *   1b (import).   Warning screen: Smirk only restores Smirk-created seeds
 *   1b'.           12 numbered word boxes: paste-fills all at once
 *   2 (create).    Verify by re-entering N random words
 *   3.             Set password (twice)
 *   4.             onComplete(mnemonic, password) seals the keystore
 *   5 (optional).  Set up Smirk: handle reservation + privacy toggle
 *   6.             onFullyDone: caller refreshes wallet state, shows Home
 *
 * The setup step (5) only renders if the caller wires `reserveSmirkName`
 * AND/OR `setInjectEnabled`. Existing callers that don't pass these
 * skip straight from 4 to 6 with no behavior change.
 *
 * In-progress mnemonic state lives in `useState` only. NOT persisted via
 * `useWizard`: that would write the unencrypted mnemonic to
 * `chrome.storage.session`, the legacy pattern flagged in the
 * 2026-05-10 audit. Closing the popup mid-flow drops the half-generated
 * seed; the user re-does onboarding. UX cost we accept.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Button } from './Button';
import { BackendPicker, type BackendProbeInfo } from './BackendPicker';

/**
 * One linked third-party social (Telegram, Discord, Matrix, …).
 * Mirrors `LinkedSocialAccount` from `@smirk/core` so we don't
 * import that here: keeps `@smirk/ui` API-free. Caller projects
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
   * `walletKeystore.createWallet` + `bootstrapAuth`. May throw:
   * the wizard surfaces the error and lets the user retry the password.
   *
   * `gate` carries a registration-gate credential when the backend requires one
   * (the free path passes none). The payment method does NOT use `onComplete`
   * (it drives {@link OnboardingWizardProps.payment} instead).
   */
  onComplete: (
    mnemonic: string,
    password: string,
    gate?: { inviteCode?: string },
  ) => Promise<void>;
  /**
   * Called once the user finishes (or skips) the post-create setup
   * step. Caller refreshes wallet state here to unmount the wizard
   * and reveal the main app. If omitted, the wizard renders the
   * "Wallet ready." status until the parent un-renders it.
   */
  onFullyDone?: () => Promise<void> | void;
  /**
   * Fired once, when the user leaves the welcome screen via Create or Import.
   *
   * This is the consent boundary. Merely opening the popup must not cause any
   * network activity, so the shell defers its `/capabilities` read until this
   * fires. See the `first-launch-exposure` e2e spec, which asserts a cold launch
   * contacts zero endpoints.
   */
  onBegin?: () => void;
  /**
   * Reserve a Smirk @handle. If omitted, the handle row in the
   * setup step doesn't render. The caller is expected to have a
   * valid auth token before the setup step runs (i.e., onComplete
   * also bootstraps). Should throw with a user-friendly message:
   * the wizard surfaces it inline and keeps the field editable.
   */
  reserveSmirkName?: (handle: string) => Promise<void>;
  /**
   * Identity the imported wallet already owns on the backend (Smirk
   * handle + linked third-party socials). Set when the caller's
   * `onComplete` resolves a prior identity, typical on import to a
   * fresh device. The setup step renders a "Welcome back" panel
   * summarising what carries over instead of the reserve-handle
   * prompt. Omit on create or when both lookups returned empty.
   *
   * `linkedSocials` is treated as opaque rows by the wizard: caller
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
   * to a bouncing 🐕 emoji when omitted, for hosts that don't ship
   * the asset (tests, Storybook).
   *
   * Why a URL prop rather than a bundled import: `@smirk/ui` stays
   * asset-free so themes / bundlers don't have to learn about a new
   * non-font asset. Each consumer (the extension, the Tauri desktop,
   * the Capacitor mobile build) maps it to its own runtime path.
   */
  dogeMiningImageUrl?: string;
  /**
   * Optional "run your own backend" opt-in. When provided, the welcome screen
   * shows a subtle link to a backend picker BEFORE create/import, so a
   * self-hoster's very first bootstrap hits their own backend (never the public
   * default). `probe`/`onUse` wrap core `connectBackend` + `writeBackendConfig`;
   * omit the whole prop to hide the affordance (the default one-tap path).
   */
  backendPicker?: {
    probe: (
      url: string,
    ) => Promise<{ ok: boolean; info?: BackendProbeInfo; error?: string }>;
    onUse: (info: BackendProbeInfo) => Promise<void>;
    current?: { url: string; instanceName?: string; isDefault: boolean };
    defaultUrl?: string;
  };
  /**
   * The active backend's registration policy (from `planRegistration` in
   * `@smirk/core`, projected to this plain shape so the wizard stays API-free).
   * Drives the gate router between the password step and register:
   * `free` proceeds straight through; `invite`/`payment` route to that step;
   * `choose` shows method buttons (`registration_mode: any`); `sequential`
   * collects every required gate in turn (`all` with 2+ gates). Absent ⇒ `free`.
   */
  registration?: OnboardingRegistration;
  /**
   * Whether the backend's registration policy has actually been RESOLVED (a
   * successful capabilities read). When explicitly `false`, the wizard refuses to
   * proceed past the password step: it must NOT fall back to the `free` path and
   * commit a durable keystore on a gated backend whose gate it simply hasn't
   * learned yet; that bricks onboarding. Omitted/undefined preserves the
   * legacy behavior for hosts that don't gate on capabilities.
   */
  registrationResolved?: boolean;
  /**
   * Pay-to-register callbacks, required only when `registration` can reach the
   * payment method. `begin` creates the wallet (once) + mints an invoice bound to
   * its BTC key and returns the pay-to target; `poll` makes one register attempt
   * with a FRESH signature (the wizard loops it), resolving `'done'` on
   * settlement or `'pending'` while unpaid. `inviteCode` is threaded only for the
   * rare `sequential` (invite AND payment) config.
   */
  payment?: {
    begin: (
      mnemonic: string,
      password: string,
      inviteCode?: string,
    ) => Promise<
      { payTo: string; amount: string; currency: string } | { alreadyRegistered: true }
    >;
    poll: (attempt: number, inviteCode?: string) => Promise<'pending' | 'done'>;
  };
  /**
   * Whether this seed is ALREADY registered on the active backend. A returning
   * wallet bypasses every gate server-side, so when this resolves true the wizard
   * skips the gate step entirely (a re-import has no invite code and needs no
   * payment). Only consulted when a gate is present. Failures are treated as
   * "new" (the gate applies); the backend is the safety net either way.
   */
  isReturningWallet?: (mnemonic: string) => Promise<boolean>;
  class?: string;
}

/** The active backend's registration branch, projected from `@smirk/core`'s
 *  `RegistrationPlan` (kept local so `@smirk/ui` imports no API types). */
export interface OnboardingRegistration {
  kind: 'free' | 'invite' | 'payment' | 'choose' | 'sequential';
  methods: Array<'invite' | 'payment'>;
  price?: string;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'backend-picker' }
  | { kind: 'show'; mnemonic: string }
  | { kind: 'verify'; mnemonic: string; indices: number[] }
  | { kind: 'import-warning' }
  | { kind: 'import' }
  | { kind: 'password'; mnemonic: string; isImport: boolean }
  | { kind: 'choose-method'; mnemonic: string; password: string; isImport: boolean }
  | {
      kind: 'invite';
      mnemonic: string;
      password: string;
      isImport: boolean;
      /** sequential (`all` + both gates): collect invite, then go to payment. */
      thenPayment: boolean;
    }
  | {
      kind: 'payment';
      mnemonic: string;
      password: string;
      isImport: boolean;
      /** carried only for the sequential invite+payment config. */
      inviteCode?: string;
    }
  | { kind: 'submitting' }
  | { kind: 'setup' }
  | { kind: 'done' };

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const [error, setError] = useState<string | null>(null);

  // `onBegin` fires the moment the user leaves the welcome screen, which is the
  // first point at which they have actually asked for anything. The shell uses
  // it to start work that would otherwise have to happen on mount, notably the
  // /capabilities read. Opening the popup is not consent, so nothing that
  // touches the network may run before this.
  const startCreate = () => {
    props.onBegin?.();
    setStep({ kind: 'show', mnemonic: props.generateMnemonic() });
  };
  const startImport = () => {
    props.onBegin?.();
    setStep({ kind: 'import-warning' });
  };
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
  // skip straight to 'done': no UI change for them.
  const hasSetupStep = Boolean(props.reserveSmirkName ?? props.setInjectEnabled);

  const finishSetup = async () => {
    setStep({ kind: 'done' });
    // Defer to the next tick so the "Wallet ready." status renders
    // briefly before the parent un-renders us: avoids a flash of
    // empty space if the parent refresh is synchronous.
    setTimeout(() => {
      void props.onFullyDone?.();
    }, 250);
  };

  /** Advance past a completed register to the setup step (or straight to done). */
  const finishAfterRegister = async () => {
    if (hasSetupStep) setStep({ kind: 'setup' });
    else await finishSetup();
  };

  /** Create + bootstrap (optionally with an invite gate), then advance. Register
   *  errors drop back to the password step. Not used for the payment method. */
  const runRegister = async (
    mnemonic: string,
    password: string,
    isImport: boolean,
    gate?: { inviteCode?: string },
  ) => {
    setStep({ kind: 'submitting' });
    setError(null);
    try {
      await props.onComplete(mnemonic, password, gate);
      await finishAfterRegister();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create wallet');
      setStep({ kind: 'password', mnemonic, isImport });
    }
  };

  // After the password, route by the backend's registration policy. Free (or an
  // absent policy) registers immediately; a gate routes to its step first.
  const handleSubmit = async (mnemonic: string, password: string, isImport: boolean) => {
    // Fail closed: when the caller gates on a capabilities read that has NOT
    // resolved, do not default to the free path: a gated backend would get a
    // committed keystore that can never finish registering. Make the user retry
    // instead of bricking the wallet. `undefined` keeps the legacy behavior.
    if (props.registrationResolved === false) {
      setError(
        "Couldn't reach the backend to check its sign-up requirements. Check your connection and try again.",
      );
      return;
    }
    const kind = props.registration?.kind ?? 'free';
    // A seed already registered on THIS backend bypasses gates server-side, so
    // skip the gate UI (a re-import has no invite / needs no payment). Only
    // costs a checkRestore round-trip on gated backends; free is unaffected.
    if (kind !== 'free' && props.isReturningWallet) {
      let known = false;
      try {
        known = await props.isReturningWallet(mnemonic);
      } catch {
        known = false;
      }
      if (known) {
        await runRegister(mnemonic, password, isImport);
        return;
      }
    }
    switch (kind) {
      case 'invite':
        setStep({ kind: 'invite', mnemonic, password, isImport, thenPayment: false });
        return;
      case 'payment':
        setStep({ kind: 'payment', mnemonic, password, isImport });
        return;
      case 'choose':
        setStep({ kind: 'choose-method', mnemonic, password, isImport });
        return;
      case 'sequential':
        // `all` with both gates: collect the invite, then pay.
        setStep({ kind: 'invite', mnemonic, password, isImport, thenPayment: true });
        return;
      default:
        await runRegister(mnemonic, password, isImport);
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
      {step.kind === 'welcome' && (
        <Welcome
          onCreate={startCreate}
          onImport={startImport}
          {...(props.backendPicker
            ? { onChooseBackend: () => setStep({ kind: 'backend-picker' }) }
            : {})}
        />
      )}

      {step.kind === 'backend-picker' && props.backendPicker && (
        <BackendPicker
          context="onboarding"
          {...(props.backendPicker.current ? { current: props.backendPicker.current } : {})}
          {...(props.backendPicker.defaultUrl
            ? { defaultUrl: props.backendPicker.defaultUrl }
            : {})}
          probe={props.backendPicker.probe}
          onUse={async (info) => {
            await props.backendPicker!.onUse(info);
            setStep({ kind: 'welcome' });
          }}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

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

      {step.kind === 'choose-method' && (
        <ChooseMethod
          methods={props.registration?.methods ?? []}
          {...(props.registration?.price ? { price: props.registration.price } : {})}
          onInvite={() =>
            setStep({
              kind: 'invite',
              mnemonic: step.mnemonic,
              password: step.password,
              isImport: step.isImport,
              thenPayment: false,
            })
          }
          onPayment={() =>
            setStep({
              kind: 'payment',
              mnemonic: step.mnemonic,
              password: step.password,
              isImport: step.isImport,
            })
          }
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'invite' && (
        <InviteStep
          onSubmit={async (code) => {
            if (step.thenPayment) {
              // sequential: carry the code to the payment step; the register
              // (with both credentials) happens there.
              setStep({
                kind: 'payment',
                mnemonic: step.mnemonic,
                password: step.password,
                isImport: step.isImport,
                inviteCode: code,
              });
              return;
            }
            await runRegister(step.mnemonic, step.password, step.isImport, {
              inviteCode: code,
            });
          }}
          onBack={() => setStep({ kind: 'welcome' })}
        />
      )}

      {step.kind === 'payment' && props.payment && (
        <PaymentStep
          {...(props.registration?.price ? { price: props.registration.price } : {})}
          begin={() =>
            props.payment!.begin(step.mnemonic, step.password, step.inviteCode)
          }
          poll={(attempt) => props.payment!.poll(attempt, step.inviteCode)}
          onDone={() => void finishAfterRegister()}
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

function Welcome({
  onCreate,
  onImport,
  onChooseBackend,
}: {
  onCreate: () => void;
  onImport: () => void;
  onChooseBackend?: () => void;
}) {
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
      {onChooseBackend && (
        <button
          onClick={onChooseBackend}
          data-testid="onboarding-choose-backend"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            opacity: 0.6,
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          Running your own backend? Use it →
        </button>
      )}
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
 * imports: keeping the surface tight on what the wallet actually
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
        Paste your 12-word recovery phrase. Smirk uses standard BIP39
        derivation, so a phrase from most wallets — including Cake — imports
        cleanly and restores the same addresses and balances here.
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
          Good to know before you import
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
            Standard 12-word phrases restore your addresses and
            balances for the chains Smirk supports.
          </li>
          <li>
            A wallet that uses a non-standard derivation path may show
            an empty balance for some assets — your funds are always
            safe and remain visible in that wallet.
          </li>
          <li>
            You can also send funds to a Smirk receive address anytime
            after onboarding.
          </li>
        </ul>
      </div>
      <Button onClick={onContinue} testid="onboarding-import-warning-continue">Continue</Button>
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
  // interop out of the box; see background/dapp/inject-policy.ts).
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
    // still a write: keeps the storage value in sync with what
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
 * platform special-casing: adding a new platform (Matrix, Bluesky,
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
  // verified/pending badge. No platform-specific glyphs: the wallet
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
// Registration gates (invite / pay-to-register / method chooser)
// ============================================================================

const errorBoxStyle = {
  background: 'rgba(239,68,68,0.08)',
  border: '1px solid rgba(239,68,68,0.5)',
  color: 'var(--smirk-negative, #ef4444)',
  padding: '10px 12px',
  borderRadius: 8,
  fontSize: 13,
  margin: '10px 0',
} as const;

/** `any`-mode chooser: the backend accepts more than one registration method. */
function ChooseMethod({
  methods,
  price,
  onInvite,
  onPayment,
  onBack,
}: {
  methods: Array<'invite' | 'payment'>;
  price?: string;
  onInvite: () => void;
  onPayment: () => void;
  onBack: () => void;
}) {
  return (
    <div data-testid="onboarding-choose-method">
      <ScreenHeader title="How do you want to register?" onBack={onBack} />
      <p style={bodyTextStyle}>
        This backend accepts more than one way to register a new wallet. Pick one.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {methods.includes('invite') && (
          <Button
            variant="secondary"
            testid="onboarding-reg-method-invite"
            onClick={onInvite}
          >
            I have an invite code
          </Button>
        )}
        {methods.includes('payment') && (
          <Button
            variant="secondary"
            testid="onboarding-reg-method-payment"
            onClick={onPayment}
          >
            {price ? `Pay to register (${price})` : 'Pay to register'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Invite-code entry. Owns its submit + inline error so a bad code stays here. */
function InviteStep({
  onSubmit,
  onBack,
}: {
  onSubmit: (code: string) => Promise<void>;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Invalid or already-used invite code.');
      setBusy(false);
    }
  };
  return (
    <div data-testid="onboarding-invite-step">
      <ScreenHeader title="Enter your invite code" onBack={onBack} />
      <p style={bodyTextStyle}>
        This backend requires an invite code to register a new wallet. Codes are
        issued by the instance operator.
      </p>
      <input
        data-testid="onboarding-invite-input"
        value={code}
        placeholder="Invite code"
        autoFocus
        autocomplete="off"
        onInput={(e) => setCode((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        style={inputStyle}
      />
      {err && <div style={errorBoxStyle}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        <Button
          variant="primary"
          testid="onboarding-invite-submit"
          disabled={!code.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}

/** Pay-to-register: mint an invoice, show the pay-to target, and poll until the
 *  backend reads it as settled (each poll is a fresh register attempt). */
function PaymentStep({
  price,
  begin,
  poll,
  onDone,
  onBack,
}: {
  price?: string;
  begin: () => Promise<
    { payTo: string; amount: string; currency: string } | { alreadyRegistered: true }
  >;
  poll: (attempt: number) => Promise<'pending' | 'done'>;
  onDone: () => void;
  onBack: () => void;
}) {
  const [invoice, setInvoice] = useState<{
    payTo: string;
    amount: string;
    currency: string;
  } | null>(null);
  const [status, setStatus] = useState<'minting' | 'waiting' | 'settled' | 'error'>(
    'minting',
  );
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Mint once; a remount must not mint a second invoice.
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const inv = await begin();
        if (cancelled) return;
        // Returning wallet: the backend bypassed the gate and `begin` already
        // completed registration; finish without showing a pay screen.
        if ('alreadyRegistered' in inv) {
          setStatus('settled');
          onDone();
          return;
        }
        setInvoice(inv);
        setStatus('waiting');
        let attempt = 0;
        while (!cancelled) {
          const r = await poll(attempt++);
          if (cancelled) return;
          if (r === 'done') {
            setStatus('settled');
            onDone();
            return;
          }
          await new Promise((res) => setTimeout(res, 6000));
        }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'Payment failed. Please try again.');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isUrl = !!invoice && /^https?:\/\//i.test(invoice.payTo);
  const copy = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.payTo);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is selectable regardless */
    }
  };

  return (
    <div data-testid="onboarding-payment-step">
      <ScreenHeader title="Registration payment" onBack={onBack} />
      <p style={bodyTextStyle}>
        Registering a new wallet on this backend costs {price ?? 'a fee'}. Send the
        exact amount to the address below, or open the checkout link. Registration
        completes automatically once payment confirms.
      </p>

      {status === 'minting' && (
        <p data-testid="onboarding-payment-status" style={{ fontSize: 13, opacity: 0.75 }}>
          Preparing your invoice…
        </p>
      )}

      {invoice && (
        <>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Pay to</div>
          <div
            data-testid="onboarding-payment-address"
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              wordBreak: 'break-all',
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 8,
            }}
          >
            {invoice.payTo}
          </div>
          <div
            data-testid="onboarding-payment-amount"
            style={{ fontSize: 13, margin: '8px 0' }}
          >
            {invoice.amount} {invoice.currency}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" testid="onboarding-payment-copy" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {isUrl && (
              <a
                href={invoice.payTo}
                target="_blank"
                rel="noreferrer"
                data-testid="onboarding-payment-open"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.15)',
                  fontSize: 13,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                Open checkout
              </a>
            )}
          </div>
        </>
      )}

      {status === 'waiting' && (
        <p
          data-testid="onboarding-payment-status"
          style={{ fontSize: 13, opacity: 0.75, marginTop: 14 }}
        >
          Waiting for payment to confirm… you can keep this open.
        </p>
      )}
      {status === 'settled' && (
        <p
          data-testid="onboarding-payment-status"
          style={{ fontSize: 13, opacity: 0.85, marginTop: 14 }}
        >
          Payment confirmed. Finishing setup…
        </p>
      )}
      {status === 'error' && err && (
        <div data-testid="onboarding-payment-status" style={errorBoxStyle}>
          {err}
        </div>
      )}
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

/**
 * `PowSubmittingStatus`: what the user stares at while
 * `props.onComplete` does its three things:
 *   1. Encrypts the seed under the user's password
 *   2. Solves the ALTCHA proof-of-work challenge the backend issues
 *      (~1-2s of PBKDF2 on a laptop)
 *   3. Registers the wallet against /auth/extension
 *
 * Renders a bouncing doge with doge-meme phrases cycling underneath.
 * The fact that PBKDF2 is *actually* compute-bound makes the dancing
 * doge legitimate: the page isn't pretending to work; it really is
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

  // Doge-meme palette: these are the canonical comic-sans-rainbow
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
 * `Math.random` is fine here: these positions get shown to the user;
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
