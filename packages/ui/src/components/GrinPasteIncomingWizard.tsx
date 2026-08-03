/**
 * GrinPasteIncomingWizard: receiver-side flow for an inbound S1 slate.
 *
 * Counterpart to SendWizard's Grin Exchange step. The sender's wallet
 * (external grin-wallet, Grim, or another Smirk user) handed us an S1
 * slatepack. We sign it as S2 and hand it back. The sender then
 * finalizes + broadcasts; we just record the incoming output so our
 * balance updates once the kernel confirms on chain.
 *
 * Three steps:
 *
 *   step 0: Paste. Textarea + optional clipboard auto-fill. Tap an
 *           Inbox row for pending_to_sign and the popup pre-fills the
 *           field; manual paste also works for external-wallet handoff.
 *   step 1: Sign. Auto-runs `onSign` on first mount; displays the S2
 *           armored slatepack with copy/post-to-relay affordances.
 *   step 2: Done. Confirmation; recorded output will reflect in
 *           balance once the sender broadcasts.
 *
 * State persists via `useWizard<GrinPasteIncomingFields>` under the
 * `'grin-paste-incoming'` id so popup-close mid-flow resumes cleanly.
 */

import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';

import { useWizard } from '../state/hooks';
import { Button } from './Button';

const WIZARD_ID = 'grin-paste-incoming';
const TOTAL_STEPS = 2;

export interface GrinPasteIncomingFields extends Record<string, unknown> {
  /** S1 slatepack from the sender. Set by the popup before navigation
   *  (Inbox tap) or by the user pasting into the textarea. */
  armoredIncoming?: string;
  /** Backend relay id when the S1 came from a `pending_to_sign` Inbox
   *  row. When set, the wizard posts S2 back via the relay's sign
   *  endpoint so the sender's queue advances automatically. */
  relayId?: string;
  /** Persisted S2 to show in step 1. */
  armoredOutgoing?: string;
  /** Persisted slate id / amount for the Done screen. */
  slateId?: string;
  amountAtomic?: string;
  /** Last sign / relay-post error. */
  signError?: string;
}

export interface GrinPasteIncomingSignResult {
  ok: true;
  slate_id: string;
  s2_armored: string;
  amount_atomic: string;
}
export type GrinPasteIncomingSignOutcome =
  | GrinPasteIncomingSignResult
  | { ok: false; error: string };

export interface GrinPasteIncomingWizardProps {
  /** Always "grin" today; future MW chains might reuse the wizard. */
  assetId: string;
  /** Sign the S1: derive a fresh receive output, build S2, record the
   *  incoming-tx + output on the backend, optionally POST the S2 back
   *  through the relay. */
  onSign: (args: {
    s1Armored: string;
    relayId?: string;
  }) => Promise<GrinPasteIncomingSignOutcome>;
  /** Clipboard read for the paste step's auto-fill button. */
  onReadClipboard?: () => Promise<string>;
  /** Clipboard write for the copy-S2 button. */
  onCopy?: (text: string) => void;
  onExit: () => void;
}

export function GrinPasteIncomingWizard(props: GrinPasteIncomingWizardProps) {
  const wizard = useWizard<GrinPasteIncomingFields>(WIZARD_ID, {});
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
        {...(fields.slateId ? { slateId: fields.slateId } : {})}
        {...(fields.amountAtomic ? { amountAtomic: fields.amountAtomic } : {})}
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
            await wizard.patchFields({ armoredIncoming: armored });
            await wizard.next();
          }}
        />
      )}

      {step === 1 && fields.armoredIncoming !== undefined && (
        <SignAndReply
          assetId={props.assetId}
          armoredIncoming={fields.armoredIncoming}
          {...(fields.relayId ? { relayId: fields.relayId } : {})}
          {...(fields.armoredOutgoing ? { armoredOutgoing: fields.armoredOutgoing } : {})}
          {...(fields.signError ? { error: fields.signError } : {})}
          onSign={async () => {
            const result = await props.onSign({
              s1Armored: fields.armoredIncoming!,
              ...(fields.relayId ? { relayId: fields.relayId } : {}),
            });
            if (result.ok) {
              await wizard.patchFields({
                armoredOutgoing: result.s2_armored,
                slateId: result.slate_id,
                amountAtomic: result.amount_atomic,
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
}: {
  assetId: string;
  initialValue: string;
  onReadClipboard?: () => Promise<string>;
  onContinue: (armored: string) => void;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const looksLikeSlatepack = (s: string): boolean =>
    s.trimStart().startsWith('BEGINSLATEPACK');

  const handleContinue = () => {
    const trimmed = text.trim();
    if (!looksLikeSlatepack(trimmed)) {
      setError('Doesn\'t look like a slatepack — expected BEGINSLATEPACK…');
      return;
    }
    setError(null);
    onContinue(trimmed);
  };

  const handlePasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      if (looksLikeSlatepack(clip)) {
        setText(clip);
        setError(null);
      } else {
        setError('Clipboard doesn\'t contain a slatepack.');
      }
    } catch {
      setError('Could not read clipboard. Paste manually below.');
    }
  };

  return (
    <div>
      <h2 style={titleStyle}>Incoming {asset.ticker} slatepack</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        Paste the sender's slatepack below. We'll sign our half and hand
        you back a response — give it to the sender to finalize.
      </div>

      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK.&#10;…&#10;ENDSLATEPACK."
        rows={6}
        autoFocus
        style={textareaStyle}
      />

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)', marginTop: 6 }}>
          {error}
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
  onSign: () => Promise<GrinPasteIncomingSignOutcome>;
  onCopy?: (text: string) => void;
  onDone: () => Promise<void>;
}) {
  const asset = mustGetAsset(assetId);
  const [signing, setSigning] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-sign on first mount if we don't already have S2 persisted.
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
        <h2 style={titleStyle}>Signing…</h2>
        <FullPage>
          Deriving a fresh output, building the receiver-side range proof,
          signing your half of the kernel.
        </FullPage>
      </div>
    );
  }

  if (!armoredOutgoing && error) {
    return (
      <div>
        <h2 style={titleStyle}>Couldn't sign</h2>
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)', marginBottom: 12 }}>
          {error}
        </div>
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
          Slatepack source (truncated): {armoredIncoming.slice(0, 60)}…
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
      <h2 style={titleStyle}>Reply slatepack ready</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 10 }}>
        Hand this back to the sender. They'll finalize and broadcast;
        your balance updates once the kernel confirms on chain (typically
        ~1 min for {asset.ticker}).
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
        S2 slatepack
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
          Reply posted to the Smirk relay — sender will see it in their
          "To finalize" inbox.
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
      <h2 style={{ fontSize: 16, margin: '8px 0 4px' }}>Signed and replied</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 16 }}>
        Sender will finalize and broadcast. Your {ticker} balance updates
        once the kernel confirms on chain.
      </div>
      {slateId && (
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
          slate id <code>{slateId.slice(0, 12)}…</code>
        </div>
      )}
      {amountAtomic && (
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginBottom: 16 }}>
          amount: {amountAtomic} nano{ticker.toLowerCase()}
        </div>
      )}
      <Button onClick={() => void onClose()}>Done</Button>
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
