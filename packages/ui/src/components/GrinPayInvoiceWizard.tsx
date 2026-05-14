/**
 * GrinPayInvoiceWizard — payer-side flow for an inbound I1 invoice.
 *
 * The receiver (somewhere else) generated an invoice I1 asking us for
 * `amount` GRIN. We pay it: lock our inputs, sign as I2, hand the
 * signed slatepack back to the receiver so they can finalize and
 * broadcast.
 *
 * Four steps because spending money requires an explicit consent gate
 * the receive-flow doesn't need:
 *
 *   step 0: Paste — textarea + optional clipboard auto-fill.
 *   step 1: Confirm — show "You're paying N GRIN" with fee + slate
 *           details. User clicks "Pay" to authorize. This is the
 *           crypto-execute gate.
 *   step 2: Reply — auto-signs on entry; displays I2 with copy /
 *           relay-post affordance.
 *   step 3: Done — confirmation.
 *
 * State persists under `wizards['grin-pay-invoice']`.
 */

import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';

import { useWizard } from '../state/hooks';
import { Button } from './Button';

const WIZARD_ID = 'grin-pay-invoice';
const TOTAL_STEPS = 3;

export interface GrinPayInvoiceFields extends Record<string, unknown> {
  /** I1 slatepack from the receiver. Pasted or pre-seeded by the popup
   *  dispatcher when it parses a clipboard slatepack with sta=I1. */
  armoredIncoming?: string;
  /** Backend relay id when the I1 came from a `pending_to_sign` Inbox
   *  row. The popup posts I2 back via signGrinSlatepack when set. */
  relayId?: string;
  /** Cached inspection of the I1 — amount + fee shown on the confirm
   *  step without re-parsing on every render. */
  inspectedAmount?: number;
  inspectedFee?: number;
  inspectedSlateId?: string;
  /** Persisted I2 to show in step 2. */
  armoredOutgoing?: string;
  /** Last sign / relay-post error. */
  signError?: string;
}

export interface GrinPayInvoiceSignResult {
  ok: true;
  slate_id: string;
  i2_armored: string;
  amount_atomic: string;
}
export type GrinPayInvoiceSignOutcome =
  | GrinPayInvoiceSignResult
  | { ok: false; error: string };

export interface GrinPayInvoiceWizardProps {
  assetId: string;
  /** Inspect the pasted I1 — return amount/fee/slate id for the
   *  confirm step. Implemented in the shell because slate parsing
   *  needs the wasm bundle. */
  onInspect: (i1Armored: string) =>
    | { ok: true; sta: string; amount: number; fee: number; slate_id: string }
    | { ok: false; error: string };
  /** Sign the I1: select inputs, lock outputs server-side, build I2,
   *  optionally post I2 back through the relay. */
  onSign: (args: {
    i1Armored: string;
    relayId?: string;
  }) => Promise<GrinPayInvoiceSignOutcome>;
  onReadClipboard?: () => Promise<string>;
  onCopy?: (text: string) => void;
  onExit: () => void;
}

export function GrinPayInvoiceWizard(props: GrinPayInvoiceWizardProps) {
  const wizard = useWizard<GrinPayInvoiceFields>(WIZARD_ID, {});
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
        {...(fields.inspectedSlateId ? { slateId: fields.inspectedSlateId } : {})}
        {...(fields.inspectedAmount ? { amountAtomic: String(fields.inspectedAmount) } : {})}
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
            await wizard.cancel();
            props.onExit();
          }}
          style={navBtn}
        >
          {step === 0 ? 'Cancel' : '× Cancel'}
        </button>
        <span style={{ opacity: 0.5 }}>
          Step {step + 1} / {TOTAL_STEPS}
        </span>
        <span style={{ width: 60 }} />
      </header>

      {step === 0 && (
        <Paste
          assetId={props.assetId}
          initialValue={fields.armoredIncoming ?? ''}
          {...(props.onReadClipboard ? { onReadClipboard: props.onReadClipboard } : {})}
          onContinue={async (armored) => {
            const inspected = props.onInspect(armored);
            if (!inspected.ok) {
              await wizard.patchFields({ signError: inspected.error });
              return;
            }
            if (inspected.sta !== 'I1') {
              await wizard.patchFields({
                signError: `Expected an invoice (I1), got ${inspected.sta}. Use Inbox → Paste slatepack for other types.`,
              });
              return;
            }
            await wizard.patchFields({
              armoredIncoming: armored,
              inspectedAmount: inspected.amount,
              inspectedFee: inspected.fee,
              inspectedSlateId: inspected.slate_id,
              signError: '',
            });
            await wizard.next();
          }}
          {...(fields.signError ? { error: fields.signError } : {})}
        />
      )}

      {step === 1 && fields.armoredIncoming !== undefined && (
        <Confirm
          assetId={props.assetId}
          amount={fields.inspectedAmount ?? 0}
          fee={fields.inspectedFee ?? 0}
          slateId={fields.inspectedSlateId ?? ''}
          onPay={async () => {
            await wizard.next();
          }}
          onCancel={async () => {
            await wizard.cancel();
            props.onExit();
          }}
        />
      )}

      {step === 2 && fields.armoredIncoming !== undefined && (
        <SignAndReply
          assetId={props.assetId}
          armoredIncoming={fields.armoredIncoming}
          {...(fields.relayId ? { relayId: fields.relayId } : {})}
          {...(fields.armoredOutgoing ? { armoredOutgoing: fields.armoredOutgoing } : {})}
          {...(fields.signError ? { error: fields.signError } : {})}
          onSign={async () => {
            const result = await props.onSign({
              i1Armored: fields.armoredIncoming!,
              ...(fields.relayId ? { relayId: fields.relayId } : {}),
            });
            if (result.ok) {
              await wizard.patchFields({
                armoredOutgoing: result.i2_armored,
                signError: '',
              });
            } else {
              await wizard.patchFields({ signError: result.error });
            }
            return result;
          }}
          {...(props.onCopy ? { onCopy: props.onCopy } : {})}
          onDone={async () => {
            await wizard.goToStep(TOTAL_STEPS);
          }}
        />
      )}
    </div>
  );
}

// ---- Paste step ----------------------------------------------------------

function Paste({
  assetId,
  initialValue,
  onReadClipboard,
  onContinue,
  error,
}: {
  assetId: string;
  initialValue: string;
  onReadClipboard?: () => Promise<string>;
  onContinue: (armored: string) => void;
  error?: string;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initialValue);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const looksLikeSlatepack = (s: string): boolean =>
    s.trimStart().startsWith('BEGINSLATEPACK');

  const handleContinue = () => {
    const trimmed = text.trim();
    if (!looksLikeSlatepack(trimmed)) {
      setLocalErr("Doesn't look like a slatepack — expected BEGINSLATEPACK…");
      return;
    }
    setLocalErr(null);
    onContinue(trimmed);
  };

  const handlePasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      if (looksLikeSlatepack(clip)) {
        setText(clip);
        setLocalErr(null);
      } else {
        setLocalErr("Clipboard doesn't contain a slatepack.");
      }
    } catch {
      setLocalErr('Could not read clipboard. Paste manually below.');
    }
  };

  return (
    <div>
      <h2 style={titleStyle}>Incoming {asset.ticker} invoice</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        Someone sent you a payment request. Paste their invoice slatepack
        below — we'll show you the amount and you can authorize the
        payment.
      </div>

      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK.&#10;…&#10;ENDSLATEPACK."
        rows={6}
        autoFocus
        style={textareaStyle}
      />

      {(localErr || error) && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)', marginTop: 6 }}>
          {localErr ?? error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {onReadClipboard && (
          <button onClick={handlePasteFromClipboard} style={secondaryBtn}>
            📋 Paste from clipboard
          </button>
        )}
        <Button
          onClick={handleContinue}
          {...(!text.trim() ? { disabled: true } : {})}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---- Confirm step --------------------------------------------------------

function Confirm({
  assetId,
  amount,
  fee,
  slateId,
  onPay,
  onCancel,
}: {
  assetId: string;
  amount: number;
  fee: number;
  slateId: string;
  onPay: () => void;
  onCancel: () => void;
}) {
  const asset = mustGetAsset(assetId);
  const formatGrin = (atomic: number) => (atomic / 1e9).toFixed(9).replace(/\.?0+$/, '');
  return (
    <div>
      <h2 style={titleStyle}>Pay invoice</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 14 }}>
        Confirm you want to pay this invoice. After signing, the slatepack
        goes back to the requester to finalize and broadcast. Your funds
        are locked until they finalize or the relay row expires (~7 days).
      </div>

      <div
        style={{
          padding: 14,
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          border: '1px solid var(--smirk-border)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <Row label="Amount" value={`${formatGrin(amount)} ${asset.ticker}`} bold />
        <Row label="Fee" value={`${formatGrin(fee)} ${asset.ticker}`} />
        <Row label="Total" value={`${formatGrin(amount + fee)} ${asset.ticker}`} bold />
        <div style={{ marginTop: 10, fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
          slate <code>{slateId.slice(0, 12)}…</code>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} style={secondaryBtn}>
          Cancel
        </button>
        <Button onClick={onPay}>Pay 🔓</Button>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 0',
        fontSize: bold ? 14 : 12,
        fontWeight: bold ? 600 : 400,
      }}
    >
      <span style={{ color: 'var(--smirk-fg-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// ---- Sign-and-Reply step -------------------------------------------------

function SignAndReply({
  assetId,
  armoredIncoming,
  relayId,
  armoredOutgoing,
  error,
  onSign,
  onCopy,
  onDone,
}: {
  assetId: string;
  armoredIncoming: string;
  relayId?: string;
  armoredOutgoing?: string;
  error?: string;
  onSign: () => Promise<GrinPayInvoiceSignOutcome>;
  onCopy?: (text: string) => void;
  onDone: () => Promise<void>;
}) {
  const asset = mustGetAsset(assetId);
  const [signing, setSigning] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (armoredOutgoing || signing) return;
    let alive = true;
    setSigning(true);
    onSign().finally(() => {
      if (alive) setSigning(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armoredOutgoing]);

  if (signing && !armoredOutgoing) {
    return (
      <div>
        <h2 style={titleStyle}>Signing payment…</h2>
        <FullPage>
          Selecting inputs, locking outputs, signing your half of the
          kernel.
        </FullPage>
      </div>
    );
  }

  if (!armoredOutgoing && error) {
    return (
      <div>
        <h2 style={titleStyle}>Couldn't pay invoice</h2>
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)', marginBottom: 12 }}>
          {error}
        </div>
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
          Invoice source (truncated): {armoredIncoming.slice(0, 60)}…
        </div>
      </div>
    );
  }

  if (!armoredOutgoing) {
    return <FullPage>Preparing…</FullPage>;
  }

  const copy = () => {
    if (!onCopy) return;
    onCopy(armoredOutgoing);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div>
      <h2 style={titleStyle}>Payment slatepack ready</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        Hand this back to the recipient. They finalize and broadcast;
        your {asset.ticker} balance reflects the spend once the kernel
        confirms on chain.
      </div>

      <div
        style={{
          fontSize: 10,
          color: 'var(--smirk-fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 4,
        }}
      >
        I2 slatepack
      </div>
      <button onClick={copy} style={slatepackBox}>
        {armoredOutgoing}
      </button>
      {onCopy && (
        <button onClick={copy} style={{ ...secondaryBtn, marginTop: 6 }}>
          {copied ? '✓ Copied' : '⧉ Copy slatepack'}
        </button>
      )}

      {relayId && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-positive)',
            marginTop: 6,
          }}
        >
          Reply posted to the Smirk relay — the requester will see it in
          their "To finalize" inbox.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

// ---- Done step -----------------------------------------------------------

function Done({
  slateId,
  amountAtomic,
  ticker,
  onClose,
}: {
  slateId?: string;
  amountAtomic?: string;
  ticker: string;
  onClose: () => void | Promise<void>;
}) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      <div style={{ fontSize: 32 }}>✓</div>
      <h2 style={{ fontSize: 16, margin: '8px 0 4px' }}>Payment signed</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 16 }}>
        Recipient will finalize and broadcast. Your {ticker} balance
        reflects the spend once the kernel confirms on chain.
      </div>
      {slateId && (
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
          slate id <code>{slateId.slice(0, 12)}…</code>
        </div>
      )}
      {amountAtomic && (
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginBottom: 16 }}>
          paid: {amountAtomic} nano{ticker.toLowerCase()}
        </div>
      )}
      <Button onClick={() => void onClose()}>Back to Inbox</Button>
    </div>
  );
}

// ---- Styles --------------------------------------------------------------

const navBtn = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
} as const;

const titleStyle = {
  fontSize: 15,
  margin: '0 0 8px 0',
} as const;

const textareaStyle = {
  width: '100%',
  fontFamily: 'monospace',
  fontSize: 11,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--smirk-border)',
  background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
  color: 'inherit',
  resize: 'vertical' as const,
  boxSizing: 'border-box' as const,
};

const slatepackBox = {
  display: 'block',
  width: '100%',
  fontFamily: 'monospace',
  fontSize: 10,
  textAlign: 'left' as const,
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'inherit',
  wordBreak: 'break-all' as const,
  whiteSpace: 'pre-wrap' as const,
  maxHeight: 180,
  overflowY: 'auto' as const,
  boxSizing: 'border-box' as const,
};

const secondaryBtn = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid var(--smirk-border)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '6px 12px',
  borderRadius: 6,
} as const;

function FullPage({ children }: { children: preact.ComponentChildren }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '32px 0',
        fontSize: 12,
        color: 'var(--smirk-fg-muted)',
      }}
    >
      {children}
    </div>
  );
}
