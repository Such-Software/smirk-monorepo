/**
 * SendWizard — asset → amount → address → review wizard for Send.
 *
 * Per UI_DESIGN.md Principle 1, asset selection happens *inside* the
 * action flow rather than being its own entry point. The user clicks
 * "Send" from the action row and the first step here asks which asset.
 *
 * State persists via `@smirk/core`'s `Wizard` primitive (via the
 * `useWizard` hook), so closing the popup mid-flow and reopening
 * picks up exactly where the user left off.
 *
 * Behavior the consumer must inject:
 * - `assetIds`              — which assets the user can actually send
 * - `validateAddress`       — chain-specific address validation
 * - `onSubmit`              — build & broadcast the tx
 * - `parseAmount`           — convert UI string → atomic units (bigint)
 *                             using the asset's decimals
 *
 * Everything else (step navigation, field persistence, focus management,
 * cancel + back) is handled here.
 */

import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { useWizard } from '../state/hooks';
import { AssetIcon } from './AssetIcon';
import { Button } from './Button';
import { formatAmountWithAsset } from '../format';

export interface SendFields extends Record<string, unknown> {
  fromAssetId?: string;
  /** Amount as user-entered string (decimal). Atomic conversion at submit time. */
  amountText?: string;
  /** Target address. */
  toAddress?: string;
}

export type SendSubmitResult =
  | { ok: true; txid: string }
  | { ok: false; error: string };

export interface SendWizardProps {
  /** Asset ids the user is allowed to send from, in display order. */
  assetIds: string[];
  /**
   * Validate an address for the chosen asset. Return `null` if valid,
   * or a short human-readable error if not. Async OK.
   */
  validateAddress: (assetId: string, address: string) => string | null | Promise<string | null>;
  /**
   * Convert the user-entered decimal string into atomic units for the
   * chosen asset. Return `null` if the string isn't parseable / out of
   * range — the wizard surfaces the error.
   */
  parseAmount: (assetId: string, amountText: string) => bigint | null;
  /** Build, sign, and broadcast. Wizard advances to "done" on success. */
  onSubmit: (fields: {
    fromAssetId: string;
    amountAtomic: bigint;
    toAddress: string;
  }) => Promise<SendSubmitResult>;
  /** Called when the user explicitly exits the wizard. */
  onExit: () => void;
  /** Icon resolver passed through to AssetIcon. */
  resolveIcon?: (iconKey: string) => string | undefined;
  class?: string;
}

const WIZARD_ID = 'send';
const TOTAL_STEPS = 4; // 0=asset 1=amount 2=address 3=review (success at step >=4)

export function SendWizard(props: SendWizardProps) {
  const wizard = useWizard<SendFields>(WIZARD_ID, {});
  const fields = wizard.fields;

  // Start the wizard once on mount. Doing it in render (or in an
  // effect that depends on `wizard.active`) would re-create the wizard
  // immediately after cancel — racing with the parent's navigate-away
  // and leaving the user stuck. Empty-deps means: when the route
  // unmounts SendWizard, the next mount re-fires this once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!wizard.active) void wizard.start();
  }, []);

  if (!wizard.active) {
    return <FullPageStatus>Loading…</FullPageStatus>;
  }

  const step = wizard.step;

  if (step >= TOTAL_STEPS) {
    return <DoneStep onClose={() => exit(wizard, props.onExit)} />;
  }

  return (
    <div class={props.class} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Header
        step={step}
        totalSteps={TOTAL_STEPS}
        onCancel={() => void exit(wizard, props.onExit)}
        {...(step > 0 ? { onBack: () => void wizard.back() } : {})}
      />

      {step === 0 && (
        <PickAsset
          assetIds={props.assetIds}
          {...(fields.fromAssetId ? { selected: fields.fromAssetId } : {})}
          {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
          onPick={async (id) => {
            await wizard.setField('fromAssetId', id);
            await wizard.next();
          }}
        />
      )}

      {step === 1 && fields.fromAssetId && (
        <EnterAmount
          assetId={fields.fromAssetId}
          {...(fields.amountText ? { initial: fields.amountText } : {})}
          parseAmount={props.parseAmount}
          onContinue={async (text) => {
            await wizard.setField('amountText', text);
            await wizard.next();
          }}
        />
      )}

      {step === 2 && fields.fromAssetId && (
        <EnterAddress
          assetId={fields.fromAssetId}
          {...(fields.toAddress ? { initial: fields.toAddress } : {})}
          validateAddress={props.validateAddress}
          onContinue={async (addr) => {
            await wizard.setField('toAddress', addr);
            await wizard.next();
          }}
        />
      )}

      {step === 3 && fields.fromAssetId && fields.amountText && fields.toAddress && (
        <Review
          assetId={fields.fromAssetId}
          amountText={fields.amountText}
          toAddress={fields.toAddress}
          parseAmount={props.parseAmount}
          onSubmit={async (atomic) => {
            const result = await props.onSubmit({
              fromAssetId: fields.fromAssetId!,
              amountAtomic: atomic,
              toAddress: fields.toAddress!,
            });
            if (result.ok) {
              // mark wizard complete by going past the last step
              await wizard.goToStep(TOTAL_STEPS);
            }
            return result;
          }}
        />
      )}
    </div>
  );
}

// ----- Step 0 -----

function PickAsset({
  assetIds,
  selected,
  onPick,
  resolveIcon,
}: {
  assetIds: string[];
  selected?: string;
  onPick: (assetId: string) => void;
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  return (
    <div>
      <StepTitle>Send what?</StepTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {assetIds.map((id) => {
          const asset = mustGetAsset(id);
          const active = selected === id;
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              style={rowButtonStyle(active)}
            >
              <AssetIcon assetId={id} size={32} {...(resolveIcon ? { resolveIcon } : {})} />
              <span style={{ marginLeft: 12, flex: 1, textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{asset.ticker}</div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{asset.displayName}</div>
              </span>
              <span style={{ fontSize: 18, opacity: 0.4 }}>›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----- Step 1 -----

function EnterAmount({
  assetId,
  initial,
  parseAmount,
  onContinue,
}: {
  assetId: string;
  initial?: string;
  parseAmount: (assetId: string, text: string) => bigint | null;
  onContinue: (text: string) => void;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initial ?? '');
  const [touched, setTouched] = useState(false);

  const parsed = text ? parseAmount(assetId, text) : null;
  const error = touched && text && parsed === null ? 'Invalid amount' : null;

  return (
    <div>
      <StepTitle>How much {asset.ticker}?</StepTitle>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={() => setTouched(true)}
        placeholder={`0.00 ${asset.ticker}`}
        autoFocus
        style={amountInputStyle}
      />
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton disabled={!parsed} onClick={() => parsed !== null && onContinue(text)}>
        Continue
      </PrimaryButton>
    </div>
  );
}

// ----- Step 2 -----

function EnterAddress({
  assetId,
  initial,
  validateAddress,
  onContinue,
}: {
  assetId: string;
  initial?: string;
  validateAddress: (assetId: string, addr: string) => string | null | Promise<string | null>;
  onContinue: (addr: string) => void;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const handleContinue = async () => {
    setValidating(true);
    setError(null);
    const result = await validateAddress(assetId, text.trim());
    setValidating(false);
    if (result === null) {
      onContinue(text.trim());
    } else {
      setError(result);
    }
  };

  return (
    <div>
      <StepTitle>Where to?</StepTitle>
      <textarea
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setError(null);
        }}
        placeholder={`${asset.displayName} address`}
        rows={3}
        autoFocus
        style={textareaStyle}
      />
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton disabled={!text.trim() || validating} onClick={handleContinue}>
        {validating ? 'Validating…' : 'Continue'}
      </PrimaryButton>
    </div>
  );
}

// ----- Step 3 -----

function Review({
  assetId,
  amountText,
  toAddress,
  parseAmount,
  onSubmit,
}: {
  assetId: string;
  amountText: string;
  toAddress: string;
  parseAmount: (assetId: string, text: string) => bigint | null;
  onSubmit: (atomic: bigint) => Promise<SendSubmitResult>;
}) {
  const asset = mustGetAsset(assetId);
  const atomic = parseAmount(assetId, amountText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (atomic === null) {
    return <FieldError>Amount became invalid — go back and re-enter.</FieldError>;
  }

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(atomic);
    setSubmitting(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <div>
      <StepTitle>Review</StepTitle>
      <ReviewRow label="Asset" value={`${asset.displayName} (${asset.ticker})`} />
      <ReviewRow label="Amount" value={formatAmountWithAsset(atomic, asset, 8)} />
      <ReviewRow label="To" value={toAddress} mono />
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton disabled={submitting} onClick={handleSubmit}>
        {submitting ? 'Sending…' : 'Send'}
      </PrimaryButton>
    </div>
  );
}

// ----- Done -----

function DoneStep({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 16px' }}>
      <div style={{ fontSize: 48 }}>✓</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 12 }}>Sent</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
        Tracking confirmation in History.
      </div>
      <PrimaryButton onClick={onClose}>Done</PrimaryButton>
    </div>
  );
}

// ----- Shared chrome -----

async function exit(wizard: ReturnType<typeof useWizard<SendFields>>, onExit: () => void) {
  await wizard.cancel();
  onExit();
}

function Header({
  step,
  totalSteps,
  onCancel,
  onBack,
}: {
  step: number;
  totalSteps: number;
  onCancel: () => void;
  onBack?: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 12,
      }}
    >
      <button
        onClick={onBack ?? onCancel}
        aria-label={onBack ? 'Back' : 'Cancel'}
        style={iconButtonStyle}
      >
        {onBack ? '‹ Back' : 'Cancel'}
      </button>
      <span style={{ opacity: 0.5 }}>
        Step {Math.min(step + 1, totalSteps)} / {totalSteps}
      </span>
      <span style={{ width: 60 }} />
    </header>
  );
}

function StepTitle({ children }: { children: preact.ComponentChildren }) {
  return (
    <h2 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 14px' }}>{children}</h2>
  );
}

function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 0',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span style={{ fontSize: 11, opacity: 0.5, textTransform: 'uppercase' }}>{label}</span>
      <span style={mono ? { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' } : undefined}>
        {value}
      </span>
    </div>
  );
}

function FieldError({ children }: { children: preact.ComponentChildren }) {
  return (
    <div style={{ color: '#ff6b6b', fontSize: 12, padding: '4px 0' }}>{children}</div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: preact.ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <Button onClick={onClick} {...(disabled ? { disabled: true } : {})}>
        {children}
      </Button>
    </div>
  );
}

function FullPageStatus({ children }: { children: preact.ComponentChildren }) {
  return (
    <div style={{ padding: '40px 16px', textAlign: 'center', opacity: 0.6 }}>{children}</div>
  );
}

// ----- Inline styles (small surface, kept here to avoid CSS plumbing) -----

const iconButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
} as const;

const amountInputStyle = {
  width: '100%',
  fontSize: 28,
  fontWeight: 700,
  padding: '12px 14px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
} as const;

const textareaStyle = {
  width: '100%',
  fontSize: 13,
  fontFamily: 'monospace',
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'inherit',
  outline: 'none',
  resize: 'vertical' as const,
  boxSizing: 'border-box' as const,
};

function rowButtonStyle(active: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    background: active ? 'rgba(127,90,240,0.15)' : 'rgba(255,255,255,0.03)',
    border: `1px solid ${active ? 'rgba(127,90,240,0.5)' : 'rgba(255,255,255,0.08)'}`,
    color: 'inherit',
    cursor: 'pointer',
    padding: '12px 14px',
    borderRadius: 8,
    fontFamily: 'inherit',
    width: '100%',
    textAlign: 'left' as const,
  };
}
