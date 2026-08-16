/**
 * GrinRequestWizard: receiver-initiated Grin invoice flow.
 *
 * Three steps, mirroring SendWizard's shape but with the I1→I2→I3
 * ceremony instead of S1→S2→S3:
 *
 *   step 0: Compose, amount + (optional memo). Caller picks the fee.
 *   step 1: Exchange, display I1 slatepack, await paste of payer's I2.
 *   step 2: Done, kernel_excess + explorer link.
 *
 * State persists in `wizard.fields` under the `'grin-request'` id so
 * popup-close mid-invoice resumes here on reopen. Cancel triggers
 * server-side cleanup of the receiver's reserved output.
 */

import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';

import { useWizard } from '../state/hooks';
import { Button } from './Button';
import { copyText } from '../clipboard';

const WIZARD_ID = 'grin-request';
const TOTAL_STEPS = 2;

export interface GrinRequestFields extends Record<string, unknown> {
  amountText?: string;
  /** Persisted I1 slatepack to display + paste box state. */
  armoredOutgoing?: string;
  /** Opaque JSON the wizard hands back to onFinalize. */
  receiverContextJson?: string;
  slateId?: string;
  /** Filled on finalize-success: kernel excess shown on Done. */
  lastKernelExcessHex?: string;
  /** Last build/finalize error to surface in the Exchange step. */
  exchangeError?: string;
  /** I2 slatepack pre-filled by the Inbox dispatcher (when the user
   *  pastes an I2 in Inbox we route here with the textarea ready). */
  pastedI2?: string;
}

export interface GrinRequestBuildResult {
  ok: true;
  slate_id: string;
  armored: string;
  receiver_context_json: string;
  amount: number;
  fee: number;
}
export type GrinRequestBuildOutcome =
  | GrinRequestBuildResult
  | { ok: false; error: string };

export interface GrinRequestFinalizeResult {
  ok: true;
  slate_id: string;
  kernel_excess_hex: string;
}
export type GrinRequestFinalizeOutcome =
  | GrinRequestFinalizeResult
  | { ok: false; error: string };

export interface GrinRequestWizardProps {
  /** "grin": passed for asset-lookup convenience; could theoretically
   *  support other interactive-invoice chains later. */
  assetId: string;
  parseAmount: (assetId: string, text: string) => bigint | null;

  /**
   * Build the I1 slate: derive a fresh receiver output, lock-reserve
   * it on the backend, return the armored slatepack + receiver
   * context. The receiver decides the amount + fee in the invoice;
   * sender accepts or rejects.
   */
  onBuild: (args: {
    amountAtomic: bigint;
    feeAtomic: bigint;
  }) => Promise<GrinRequestBuildOutcome>;

  /**
   * Payer returned I2; finalize → I3 + broadcast.
   */
  onFinalize: (args: {
    i2: string;
    receiverContextJson: string;
  }) => Promise<GrinRequestFinalizeOutcome>;

  /**
   * User-cancel. Server-side should unlock the reserved output and
   * mark the invoice cancelled.
   */
  onCancel: (args: { slateId: string | undefined }) => Promise<void>;

  onExit: () => void;
}

export function GrinRequestWizard(props: GrinRequestWizardProps) {
  const wizard = useWizard<GrinRequestFields>(WIZARD_ID, {});
  const fields = wizard.fields;

  useEffect(() => {
    if (!wizard.active) void wizard.start();
  }, [wizard]);

  if (!wizard.active) {
    return <FullPage>Loading…</FullPage>;
  }

  const step = wizard.step;
  const asset = mustGetAsset(props.assetId);

  if (step >= TOTAL_STEPS) {
    return (
      <Done
        {...(fields.lastKernelExcessHex
          ? { kernelExcess: fields.lastKernelExcessHex }
          : {})}
        {...(fields.amountText ? { amountText: fields.amountText } : {})}
        ticker={asset.ticker}
        onClose={async () => {
          await wizard.cancel();
          props.onExit();
        }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button
          onClick={async () => {
            // Step 0 = back to Receive root. Step 1 = cancel the in-flight
            // invoice (unlocks reserved output server-side).
            if (step === 0) {
              await wizard.cancel();
              props.onExit();
            } else {
              await props.onCancel({ slateId: fields.slateId });
              await wizard.cancel();
              props.onExit();
            }
          }}
          style={navBtn}
        >
          {step === 0 ? 'Cancel' : '× Cancel invoice'}
        </button>
        <span style={{ opacity: 0.5 }}>
          Step {step + 1} / {TOTAL_STEPS}
        </span>
        <span style={{ width: 60 }} />
      </header>

      {step === 0 && (
        <Compose
          assetId={props.assetId}
          initialAmountText={fields.amountText ?? ''}
          parseAmount={props.parseAmount}
          onContinue={async (amountText) => {
            await wizard.patchFields({ amountText });
            await wizard.next();
          }}
        />
      )}

      {step === 1 && fields.amountText !== undefined && (
        <Exchange
          assetId={props.assetId}
          amountText={fields.amountText}
          parseAmount={props.parseAmount}
          {...(fields.armoredOutgoing ? { armoredOutgoing: fields.armoredOutgoing } : {})}
          {...(fields.receiverContextJson
            ? { receiverContextJson: fields.receiverContextJson }
            : {})}
          {...(fields.slateId ? { slateId: fields.slateId } : {})}
          {...(fields.exchangeError ? { error: fields.exchangeError } : {})}
          {...(fields.pastedI2 ? { pastedI2: fields.pastedI2 } : {})}
          onBuild={async (args) => {
            const result = await props.onBuild(args);
            if (result.ok) {
              await wizard.patchFields({
                armoredOutgoing: result.armored,
                receiverContextJson: result.receiver_context_json,
                slateId: result.slate_id,
                exchangeError: '',
              });
            } else {
              await wizard.patchFields({ exchangeError: result.error });
            }
            return result;
          }}
          onFinalize={async ({ i2 }) => {
            if (!fields.receiverContextJson) {
              return {
                ok: false,
                error: 'Missing receiver state — reset and try again',
              };
            }
            const result = await props.onFinalize({
              i2,
              receiverContextJson: fields.receiverContextJson,
            });
            if (result.ok) {
              await wizard.patchFields({
                lastKernelExcessHex: result.kernel_excess_hex,
                exchangeError: '',
              });
              await wizard.goToStep(TOTAL_STEPS);
            } else {
              await wizard.patchFields({ exchangeError: result.error });
            }
            return result;
          }}
        />
      )}
    </div>
  );
}

// ---- Compose: amount entry ------------------------------------------------

function Compose({
  assetId,
  initialAmountText,
  parseAmount,
  onContinue,
}: {
  assetId: string;
  initialAmountText: string;
  parseAmount: (assetId: string, text: string) => bigint | null;
  onContinue: (amountText: string) => void;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initialAmountText);
  const parsed = parseAmount(assetId, text);
  const valid = parsed !== null && parsed > 0n;

  return (
    <div>
      <h2 style={titleStyle}>How much {asset.ticker}?</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        The payer sees this amount in the slatepack. They accept by
        signing; the fee is computed when you generate the invoice.
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        placeholder={`0.00 ${asset.ticker}`}
        autoFocus
        style={amountInput}
      />
      <div style={{ marginTop: 14 }}>
        <Button
          onClick={() => onContinue(text)}
          {...(!valid ? { disabled: true } : {})}
        >
          Generate invoice
        </Button>
      </div>
    </div>
  );
}

// ---- Exchange: display I1, await I2 paste ---------------------------------

function Exchange({
  assetId,
  amountText,
  parseAmount,
  armoredOutgoing,
  receiverContextJson: _receiverContextJson,
  slateId: _slateId,
  error,
  pastedI2,
  onBuild,
  onFinalize,
}: {
  assetId: string;
  amountText: string;
  parseAmount: (assetId: string, text: string) => bigint | null;
  armoredOutgoing?: string;
  receiverContextJson?: string;
  slateId?: string;
  error?: string;
  /** I2 slatepack pre-filled by the Inbox dispatcher. */
  pastedI2?: string;
  onBuild: (args: {
    amountAtomic: bigint;
    feeAtomic: bigint;
  }) => Promise<GrinRequestBuildOutcome>;
  onFinalize: (args: { i2: string }) => Promise<GrinRequestFinalizeOutcome>;
}) {
  const [building, setBuilding] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [i2Text, setI2Text] = useState(pastedI2 ?? '');
  const [copied, setCopied] = useState(false);

  // Pick up Inbox-dispatched I2 if it arrives after first mount.
  useEffect(() => {
    if (pastedI2 && !i2Text) setI2Text(pastedI2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedI2]);

  // First-mount: auto-build the I1 if not already persisted.
  useEffect(() => {
    if (armoredOutgoing) return;
    const amountAtomic = parseAmount(assetId, amountText);
    if (amountAtomic === null || amountAtomic <= 0n) return;
    let alive = true;
    setBuilding(true);
    // Grin fee = (inputs * 1 + outputs * 21 + kernels * 3) * 500_000
    // per grin_core::core::transaction::TransactionBody::weight.
    // Typical 1-input 2-output 1-kernel: 46 weight units * 500k = 23M
    // nanogrin (0.023 GRIN). The payer's actual fee depends on their
    // input count; this is what we declare as expectation in the invoice.
    const feeAtomic = 23_000_000n;
    onBuild({ amountAtomic, feeAtomic }).finally(() => {
      if (alive) setBuilding(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armoredOutgoing]);

  const copy = (text: string) => {
    void copyText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => undefined);
  };

  const submit = async () => {
    if (!i2Text.trim()) return;
    setFinalizing(true);
    await onFinalize({ i2: i2Text.trim() });
    setFinalizing(false);
  };

  if (building && !armoredOutgoing) {
    return (
      <div>
        <h2 style={titleStyle}>Building invoice…</h2>
        <FullPage>
          Deriving your output and signing your half of the kernel.
        </FullPage>
      </div>
    );
  }

  if (!armoredOutgoing && error) {
    return (
      <div>
        <h2 style={titleStyle}>Couldn't build invoice</h2>
        <FieldError>{error}</FieldError>
      </div>
    );
  }

  return (
    <div>
      <h2 style={titleStyle}>Share invoice, wait for payment</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        Send this slatepack to your payer. They sign it with their
        wallet and return the signed slatepack — paste it below to
        broadcast.
      </div>

      <div style={subLabel}>Invoice slatepack to share</div>
      <button
        onClick={() => copy(armoredOutgoing ?? '')}
        data-no-uppercase
        title="Click to copy"
        style={slatepackBox}
      >
        {armoredOutgoing}
      </button>
      <button onClick={() => copy(armoredOutgoing ?? '')} style={copyBtn}>
        {copied ? '✓ Copied' : '⧉ Copy invoice'}
      </button>

      <div style={{ ...subLabel, marginTop: 16 }}>Paste payer's signed response</div>
      <textarea
        value={i2Text}
        onInput={(e) => setI2Text((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK…"
        rows={5}
        style={textareaStyle}
      />
      {error && <FieldError>{error}</FieldError>}

      <div style={{ marginTop: 12 }}>
        <Button
          onClick={submit}
          {...(!i2Text.trim() || finalizing ? { disabled: true } : {})}
        >
          {finalizing ? 'Broadcasting…' : 'Finalize & broadcast'}
        </Button>
      </div>
    </div>
  );
}

// ---- Done ----------------------------------------------------------------

function Done({
  kernelExcess,
  amountText,
  ticker,
  onClose,
}: {
  kernelExcess?: string;
  amountText?: string;
  ticker: string;
  onClose: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  // `kernelExcess` is the canonical commitment form (08/09 prefix) emitted
  // by WASM `finalize_*`: same form grincoin.org indexes by.
  const explorerUrl =
    kernelExcess && kernelExcess.length === 66
      ? `https://grincoin.org/kernel/${kernelExcess}`
      : null;
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
      <div style={{ fontSize: 40 }}>✓</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>
        {amountText ?? ''} {ticker} received
      </div>
      {kernelExcess && (
        <div style={{ marginTop: 14 }}>
          <div style={subLabel}>Kernel commitment</div>
          <button
            data-no-uppercase
            onClick={() => {
              void copyText(kernelExcess).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }).catch(() => undefined);
            }}
            style={slatepackBox}
          >
            {kernelExcess}
          </button>
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => {
                void copyText(kernelExcess).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                }).catch(() => undefined);
              }}
              style={copyBtn}
            >
              {copied ? '✓ Copied' : '⧉ Copy'}
            </button>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={explorerLink}
              >
                Open in Explorer ↗
              </a>
            )}
          </div>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => void onClose()}>Done</Button>
      </div>
    </div>
  );
}

// ---- Inline styles --------------------------------------------------------

const titleStyle = { fontSize: 18, fontWeight: 700, margin: '4px 0 14px' } as const;

const subLabel = {
  fontSize: 10,
  color: 'var(--smirk-fg-muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.06em',
  marginBottom: 4,
};

const slatepackBox = {
  fontFamily: 'var(--smirk-font-family-mono)',
  fontSize: 10,
  wordBreak: 'break-all' as const,
  padding: '8px 10px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  cursor: 'pointer',
  width: '100%',
  textAlign: 'center' as const,
  maxHeight: 110,
  overflowY: 'auto' as const,
  lineHeight: 1.2,
};

const copyBtn = {
  fontSize: 11,
  padding: '4px 10px',
  marginTop: 6,
  background: 'var(--smirk-bg-elevated)',
  border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const explorerLink = {
  fontSize: 12,
  padding: '6px 12px',
  background: 'var(--smirk-accent)',
  color: 'var(--smirk-accent-fg)',
  borderRadius: 'var(--smirk-radius, 8px)',
  textDecoration: 'none',
  display: 'inline-flex' as const,
  alignItems: 'center',
  fontFamily: 'inherit',
  fontWeight: 600,
};

const navBtn = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
};

const amountInput = {
  fontSize: 24,
  fontWeight: 700,
  padding: '12px 14px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box' as const,
  width: '100%',
};

const textareaStyle = {
  width: '100%',
  fontSize: 13,
  fontFamily: 'var(--smirk-font-family-mono)',
  padding: '10px 12px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  outline: 'none',
  resize: 'vertical' as const,
  boxSizing: 'border-box' as const,
};

function FullPage({ children }: { children: preact.ComponentChildren }) {
  return (
    <div style={{ padding: '40px 16px', textAlign: 'center', opacity: 0.6 }}>
      {children}
    </div>
  );
}

function FieldError({ children }: { children: preact.ComponentChildren }) {
  return (
    <div
      role="alert"
      style={{ color: '#ff6b6b', fontSize: 11, marginTop: 4 }}
    >
      {children}
    </div>
  );
}

