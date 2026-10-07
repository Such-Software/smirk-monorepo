/**
 * TipMaker: single-screen tip composer (v0.3.1).
 *
 * One form, top to bottom: who, what, how much, a message, and how long the
 * recipient has to claim.
 *
 *   - Recipient: an npub, a `name@domain` Nostr address, or a Smirk username.
 *     Leave it empty to make a link tip that anyone holding the link can claim.
 *     A person tip is a link tip whose claim key is delivered to that npub in a
 *     NIP-17 gift wrap instead of a URL, so only they can claim it. The shell
 *     resolves the text through `resolveRecipient` and owns the delivery.
 *   - Amount, with its USD value when the shell supplies prices.
 *   - Message: optional, person tips only. It travels inside the gift wrap;
 *     the backend stores no message for a link tip.
 *   - Expiry: after it the sender may reclaim. The tip stays claimable until a
 *     reclaim actually runs.
 *
 * The v0.2.4 targeted tips (Telegram, Discord or Smirk handle, sealed to the
 * recipient's BTC key and announced by a bot) are retired from this composer.
 * Tips already sent that way stay claimable from the Inbox.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { AssetIcon } from './AssetIcon';
import { formatAmountWithTicker } from '../format';
import { copyText } from '../clipboard';

/** Platforms of the retired v0.2.4 targeted tips. Kept so old tip rows can
 *  still be labelled; the composer no longer creates them. */
export type TipPlatform = 'telegram' | 'discord' | 'smirk';

/** Retained for API compatibility; the v0.3.1 composer shows no recent chips. */
export interface RecentRecipient {
  platform: TipPlatform;
  username: string;
  lastAssetId?: string;
  lastTippedAt?: string;
}

/** A recipient resolved to the npub that will receive the claim key. */
export interface TipRecipient {
  /** x-only hex pubkey: the gift wrap's addressee. */
  pubkeyHex: string;
  /** What the user typed or a short npub, for display only. */
  display: string;
}

export type ResolveTipRecipient = (
  text: string,
) => Promise<{ ok: true; recipient: TipRecipient } | { ok: false; error: string }>;

/** What the shell needs to know to dispatch the actual tip creation. */
export interface TipSubmitFields {
  /** Legacy targeted-tip handle. Always empty from this composer. */
  username: string;
  platform: TipPlatform;
  assetId: string;
  amountAtomic: bigint;
  /** Always true from this composer: every tip is funded as a link tip, and a
   *  person tip differs only in how its claim key is delivered. */
  isPublic: boolean;
  senderAnonymous: boolean;
  /** Set for a person tip: deliver the claim key to this npub. */
  recipient?: TipRecipient;
  memo?: string;
  /** Unix seconds after which the sender may reclaim. */
  expiresAt?: number;
}

export type TipSubmitOutcome =
  | {
      ok: true;
      tipId: string;
      /** The claim link. For a person tip it is a fallback the sender can
       *  forward if delivery could not be confirmed. */
      shareUrl: string | null;
      /** True while funding still needs to confirm before the link works. */
      shareUrlPending: boolean;
      /** Set for a person tip once the gift wrap was published. */
      deliveredTo?: string;
      /** Set when a person tip was funded but its delivery failed or is
       *  uncertain; the UI then offers the share link as a fallback. */
      deliveryWarning?: string;
    }
  | { ok: false; error: string };

export interface TipMakerProps {
  /** Asset ids the user can tip with. */
  assetIds: string[];
  /** Spendable atomic balance for an asset. */
  resolveBalance: (assetId: string) => bigint;
  /** Parse a typed amount in the asset's native unit. Null on bad input. */
  parseAmount: (assetId: string, text: string) => bigint | null;
  /** Resolve the recipient field to an npub. Omitted, the composer offers
   *  link tips only. */
  resolveRecipient?: ResolveTipRecipient;
  /** Format an atomic amount as USD ("$1.23"), or null when no price. */
  formatUsd?: (assetId: string, amountAtomic: bigint) => string | null;
  /** Submit the tip. The shell funds it and, for a person tip, delivers it. */
  onSubmit: (fields: TipSubmitFields) => Promise<TipSubmitOutcome>;
  onExit: () => void;
  resolveIcon?: (iconKey: string) => string | undefined;
  hideAssetIds?: string[];
  /** Pre-select this asset on mount (arriving from a coin's detail screen). */
  prefilledAssetId?: string;
}

const DAY = 24 * 60 * 60;
const EXPIRY_CHOICES: { label: string; seconds: number }[] = [
  { label: '1 day', seconds: DAY },
  { label: '7 days', seconds: 7 * DAY },
  { label: '30 days', seconds: 30 * DAY },
];
const MEMO_MAX = 200;

/** A recipient-field value worth resolving: npub, hex key, name@domain, or a
 *  plain Smirk username (optionally with a leading @). */
export function looksLikeTipRecipient(raw: string): boolean {
  const t = raw.trim().replace(/^@/, '');
  if (!t) return false;
  if (/^npub1[02-9ac-hj-np-z]{58}$/.test(t)) return true;
  if (/^[0-9a-fA-F]{64}$/.test(t)) return true;
  if (/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return true;
  return /^[a-z0-9._-]{2,32}$/i.test(t);
}

type RecipientState =
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'ok'; recipient: TipRecipient }
  | { kind: 'error'; error: string };

export function TipMaker(props: TipMakerProps) {
  const visibleAssetIds = useMemo(
    () => props.assetIds.filter((id) => !(props.hideAssetIds ?? []).includes(id)),
    [props.assetIds, props.hideAssetIds],
  );

  // Default asset: the shell's prefilled one, else the largest balance.
  const defaultAssetId = useMemo(() => {
    if (visibleAssetIds.length === 0) return '';
    if (props.prefilledAssetId && visibleAssetIds.includes(props.prefilledAssetId)) {
      return props.prefilledAssetId;
    }
    let best = visibleAssetIds[0]!;
    let bestBal = props.resolveBalance(best);
    for (const id of visibleAssetIds.slice(1)) {
      const b = props.resolveBalance(id);
      if (b > bestBal) {
        best = id;
        bestBal = b;
      }
    }
    return best;
  }, [visibleAssetIds, props.resolveBalance, props.prefilledAssetId]);

  const [recipientText, setRecipientText] = useState('');
  const [recipientState, setRecipientState] = useState<RecipientState>({ kind: 'empty' });
  const [assetId, setAssetId] = useState<string>(defaultAssetId);
  const [amountText, setAmountText] = useState('');
  const [memo, setMemo] = useState('');
  const [expirySeconds, setExpirySeconds] = useState(7 * DAY);
  const [senderAnonymous, setSenderAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | {
    outcome: Extract<TipSubmitOutcome, { ok: true }>;
    recipient: TipRecipient | null;
  }>(null);

  // Debounced recipient resolution. Empty means a link tip.
  useEffect(() => {
    const text = recipientText.trim();
    if (!text || !props.resolveRecipient) {
      setRecipientState({ kind: 'empty' });
      return;
    }
    if (!looksLikeTipRecipient(text)) {
      setRecipientState({ kind: 'error', error: 'Enter an npub, a name@domain address or a Smirk username' });
      return;
    }
    let cancelled = false;
    setRecipientState({ kind: 'checking' });
    const handle = window.setTimeout(async () => {
      try {
        const r = await props.resolveRecipient!(text);
        if (cancelled) return;
        setRecipientState(r.ok ? { kind: 'ok', recipient: r.recipient } : { kind: 'error', error: r.error });
      } catch (e) {
        if (!cancelled) {
          setRecipientState({ kind: 'error', error: e instanceof Error ? e.message : 'Could not find that recipient' });
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [recipientText, props.resolveRecipient]);

  const balance = useMemo(() => (assetId ? props.resolveBalance(assetId) : 0n), [assetId, props.resolveBalance]);
  const parsedAmount = useMemo(
    () => (amountText && assetId ? props.parseAmount(assetId, amountText) : null),
    [amountText, assetId, props.parseAmount],
  );
  const usd = parsedAmount && parsedAmount > 0n && props.formatUsd ? props.formatUsd(assetId, parsedAmount) : null;

  const insufficientFunds = parsedAmount !== null && parsedAmount > balance;
  const isPersonTip = recipientText.trim().length > 0;
  const recipientReady = !isPersonTip || recipientState.kind === 'ok';
  const canSubmit =
    !submitting &&
    !!assetId &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    !insufficientFunds &&
    recipientReady &&
    memo.length <= MEMO_MAX;

  const submit = async () => {
    setError(null);
    if (!parsedAmount || !assetId) return;
    const recipient = recipientState.kind === 'ok' ? recipientState.recipient : null;
    if (isPersonTip && !recipient) return;
    setSubmitting(true);
    const outcome = await props.onSubmit({
      username: '',
      platform: 'smirk',
      assetId,
      amountAtomic: parsedAmount,
      isPublic: true,
      senderAnonymous,
      ...(recipient ? { recipient } : {}),
      ...(recipient && memo.trim() ? { memo: memo.trim() } : {}),
      expiresAt: Math.floor(Date.now() / 1000) + expirySeconds,
    });
    setSubmitting(false);
    if (outcome.ok) setResult({ outcome, recipient });
    else setError(outcome.error);
  };

  if (result) {
    return (
      <TipSuccess
        outcome={result.outcome}
        recipient={result.recipient}
        amount={amountText}
        ticker={mustGetAsset(assetId).ticker}
        usd={usd}
        onClose={props.onExit}
      />
    );
  }

  const asset = assetId ? mustGetAsset(assetId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button onClick={props.onExit} style={navBtn}>
          Cancel
        </button>
        <span style={{ opacity: 0.6 }}>Tip</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, textAlign: 'center' }}>Send a tip</h2>

      {props.resolveRecipient && (
        <div>
          <Label>To</Label>
          <input
            type="text"
            data-testid="tip-recipient-input"
            value={recipientText}
            onInput={(e) => setRecipientText((e.target as HTMLInputElement).value)}
            placeholder="npub, name@domain or Smirk username"
            autoComplete="off"
            spellcheck={false}
            style={inputStyle}
          />
          <RecipientHint state={recipientState} empty={!isPersonTip} />
        </div>
      )}

      <div>
        <Label>Amount</Label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            inputMode="decimal"
            data-testid="tip-amount-input"
            value={amountText}
            onInput={(e) => setAmountText((e.target as HTMLInputElement).value)}
            placeholder="0.00"
            style={{ ...inputStyle, flex: 1 }}
          />
          {asset && (
            <AssetDropdown
              value={assetId}
              onChange={setAssetId}
              options={visibleAssetIds}
              {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
            />
          )}
        </div>
        {asset && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              marginTop: 4,
              color: insufficientFunds ? 'var(--smirk-negative, #ff6b6b)' : 'var(--smirk-fg-muted)',
            }}
          >
            <span>{insufficientFunds ? 'Insufficient balance' : `Available: ${formatAmountWithTicker(balance, assetId)}`}</span>
            {usd && <span data-testid="tip-amount-usd">≈ {usd}</span>}
          </div>
        )}
      </div>

      {/* A message rides inside the gift wrap, so only a person tip carries
          one: the backend stores no message for a link tip. */}
      {isPersonTip && (
        <div>
          <Label>Message (optional)</Label>
          <input
            type="text"
            data-testid="tip-memo-input"
            value={memo}
            maxLength={MEMO_MAX}
            onInput={(e) => setMemo((e.target as HTMLInputElement).value)}
            placeholder="Only they can read it"
            style={inputStyle}
          />
        </div>
      )}

      <div>
        <Label>Reclaimable after</Label>
        <div style={{ display: 'flex', gap: 6 }}>
          {EXPIRY_CHOICES.map((c) => (
            <button
              key={c.seconds}
              data-testid={`tip-expiry-${c.seconds / DAY}d`}
              onClick={() => setExpirySeconds(c.seconds)}
              style={{
                ...chipStyle,
                ...(expirySeconds === c.seconds
                  ? { borderColor: 'var(--smirk-accent)', color: 'var(--smirk-accent)', fontWeight: 600 }
                  : {}),
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', marginTop: 4 }}>
          Unclaimed after this, you can take the tip back. Until you do, it can still be claimed.
        </div>
      </div>

      {!isPersonTip && (
        <Toggle
          checked={senderAnonymous}
          onChange={setSenderAnonymous}
          label="Send anonymously"
          hint="Hide your Smirk username on the tip page."
          testid="tip-anonymous-toggle"
        />
      )}

      {error && (
        <div
          data-testid="tip-error"
          style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
        >
          {error}
        </div>
      )}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        data-testid="tip-submit-btn"
        style={{ ...primaryBtnStyle, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
      >
        {submitting
          ? 'Sending…'
          : isPersonTip && recipientState.kind === 'ok'
          ? `Send to ${recipientState.recipient.display}`
          : 'Create tip link'}
      </button>
    </div>
  );
}

function RecipientHint({ state, empty }: { state: RecipientState; empty: boolean }) {
  const style = { fontSize: 11, marginTop: 4 };
  if (empty) {
    return (
      <div data-testid="tip-recipient-hint" style={{ ...style, color: 'var(--smirk-fg-muted)' }}>
        Leave empty to make a link anyone can claim.
      </div>
    );
  }
  if (state.kind === 'checking') {
    return <div style={{ ...style, color: 'var(--smirk-fg-muted)' }}>Looking up…</div>;
  }
  if (state.kind === 'ok') {
    return (
      <div data-testid="tip-recipient-hint" style={{ ...style, color: 'var(--smirk-positive)' }}>
        Only {state.recipient.display} can claim this tip.
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div data-testid="tip-recipient-hint" style={{ ...style, color: 'var(--smirk-warning, #d8a14d)' }}>
        {state.error}
      </div>
    );
  }
  return null;
}

// ---- Success view --------------------------------------------------------

function TipSuccess({
  outcome,
  recipient,
  amount,
  ticker,
  usd,
  onClose,
}: {
  outcome: Extract<TipSubmitOutcome, { ok: true }>;
  recipient: TipRecipient | null;
  amount: string;
  ticker: string;
  usd: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void copyText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  const { shareUrl, shareUrlPending, deliveryWarning } = outcome;
  // A person tip shows its link only as a fallback when delivery is in doubt.
  const showLink = !!shareUrl && !shareUrlPending && (!recipient || !!deliveryWarning);

  return (
    <div style={{ textAlign: 'center', padding: '32px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 48 }}>🎁</div>
      <h2 data-testid="tip-success-heading" style={{ margin: 0, fontSize: 18 }}>
        {recipient ? 'Tip sent' : 'Tip link created'}
      </h2>
      <div style={{ fontSize: 14 }}>
        {amount} {ticker}
        {usd ? <span style={{ color: 'var(--smirk-fg-muted)' }}> (≈ {usd})</span> : null}
      </div>
      <div data-testid="tip-success-detail" style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', lineHeight: 1.5 }}>
        {recipient
          ? `Delivered privately to ${recipient.display}. It shows up in their Inbox, ready to claim once funding confirms.`
          : 'Anyone with the link can claim it.'}
      </div>

      {deliveryWarning && (
        <div
          data-testid="tip-delivery-warning"
          style={{ fontSize: 12, color: 'var(--smirk-warning, #d8a14d)', lineHeight: 1.5 }}
        >
          {deliveryWarning}
        </div>
      )}

      {showLink && shareUrl && (
        <div>
          <div
            data-testid="tip-share-url"
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              padding: 10,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 6,
              wordBreak: 'break-all',
            }}
          >
            {shareUrl}
          </div>
          <button onClick={() => copy(shareUrl)} data-testid="tip-copy-link-btn" style={{ ...secondaryBtnStyle, marginTop: 8 }}>
            {copied ? '✓ Copied' : '⧉ Copy link'}
          </button>
        </div>
      )}

      {!recipient && shareUrlPending && (
        <div
          data-testid="tip-share-pending"
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            padding: 12,
            background: 'rgba(255,255,255,0.04)',
            border: '1px dashed var(--smirk-border)',
            borderRadius: 6,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, color: 'inherit' }}>Waiting for funding to confirm</div>
          <div>The link goes live once the funding transaction confirms. Find it under Tips, sent.</div>
        </div>
      )}

      <div data-testid="tip-id-label" style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
        tip id: <code>{outcome.tipId.slice(0, 12)}…</code>
      </div>

      <button onClick={onClose} data-testid="tip-success-done-btn" style={primaryBtnStyle}>
        Done
      </button>
    </div>
  );
}

// ---- Small UI pieces ----------------------------------------------------

function Label({ children }: { children: preact.ComponentChildren }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--smirk-fg-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  testid,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
  testid?: string;
}) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12 }}>
      <input
        type="checkbox"
        {...(testid ? { 'data-testid': testid } : {})}
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        style={{ marginTop: 2 }}
      />
      <span style={{ flex: 1 }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>{hint}</div>
      </span>
    </label>
  );
}

/**
 * Asset picker: a popover anchored under the chip, right-aligned so it stays
 * inside the popup width. Closes on an outside click or a selection.
 */
function AssetDropdown({
  value,
  onChange,
  options,
  resolveIcon,
}: {
  value: string;
  onChange: (id: string) => void;
  options: string[];
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = mustGetAsset(value);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="tip-asset-dropdown"
        style={assetChipStyle}
      >
        <AssetIcon assetId={value} size={18} {...(resolveIcon ? { resolveIcon } : {})} />
        <span style={{ marginLeft: 4 }}>{current.ticker}</span>
        <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 10,
            minWidth: 160,
            background: 'var(--smirk-bg-elevated, rgba(20,20,20,0.95))',
            border: '1px solid var(--smirk-border)',
            borderRadius: 6,
            overflow: 'hidden',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}
        >
          {options.map((id) => {
            const asset = mustGetAsset(id);
            const active = id === value;
            return (
              <button
                key={id}
                role="option"
                aria-selected={active}
                data-testid={`tip-asset-option-${id}`}
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 12px',
                  background: active ? 'color-mix(in srgb, var(--smirk-accent) 18%, transparent)' : 'transparent',
                  border: 'none',
                  color: active ? 'var(--smirk-accent)' : 'inherit',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  textAlign: 'left',
                }}
              >
                <AssetIcon assetId={id} size={18} {...(resolveIcon ? { resolveIcon } : {})} />
                <span style={{ flex: 1 }}>{asset.ticker}</span>
                <span style={{ fontSize: 10, opacity: 0.5 }}>{asset.displayName}</span>
                {active && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const navBtn = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
} as const;

const inputStyle = {
  width: '100%',
  fontSize: 14,
  padding: '10px 12px',
  borderRadius: 6,
  border: '1px solid var(--smirk-border)',
  background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
  color: 'inherit',
  boxSizing: 'border-box' as const,
};

const chipStyle = {
  background: 'transparent',
  border: '1px solid var(--smirk-border)',
  borderRadius: 999,
  padding: '4px 10px',
  fontSize: 11,
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'inherit',
} as const;

const assetChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.05))',
  border: '1px solid var(--smirk-border)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'inherit',
} as const;

const primaryBtnStyle = {
  background: 'var(--smirk-accent)',
  color: 'var(--smirk-accent-fg, #fff)',
  border: 'none',
  borderRadius: 8,
  padding: '12px 16px',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  width: '100%',
} as const;

const secondaryBtnStyle = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid var(--smirk-border)',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
} as const;
