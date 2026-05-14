/**
 * TipMaker — single-screen social tip composer.
 *
 * Replaces the 4-step wizard from smirk-extension v0.2.4 (platform →
 * username → amount → success). The v0.2.4 flow buried the interesting
 * decision ("who and how much") behind a platform-first gate and made
 * public tips a separate "platform" rather than a property of any tip.
 *
 * v0.3 design (UI_DESIGN.md Principle 5 refinement):
 *
 *   - One screen: To, Amount, asset toggle, public/anonymous flags.
 *   - Autocomplete recipient from recent tips.
 *   - Asset defaults to last-used-per-recipient, fallback to largest
 *     balance. Tap the asset chip to cycle.
 *   - Quick-amount chips ($1 / $5 / $20) when fiat denomination set.
 *   - "Anyone with the link can claim" is a checkbox, not a platform.
 *   - "Send anonymously" is a checkbox per Q6 of the design pass.
 *
 * Submission goes through the shell's onSubmit callback which talks to
 * grin-flows (for Grin via voucher) / send-handler (for BTC/LTC/XMR/WOW)
 * + posts to /api/v1/social/tip via @smirk/core.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { mustGetAsset, listAssets } from '@smirk/assets';
import { AssetIcon } from './AssetIcon';
import { formatAmountWithTicker } from '../format';

/** Platforms users can address. "smirk" means the recipient is a known
 *  Smirk user looked up by their Smirk username. */
export type TipPlatform = 'telegram' | 'discord' | 'smirk';

/** Recent recipient surfaced as a chip + autocomplete suggestion. */
export interface RecentRecipient {
  platform: TipPlatform;
  username: string;
  /** Asset used last time this user tipped this recipient — drives the
   *  default asset for the new tip. */
  lastAssetId?: string;
  /** ISO timestamp of last tip. Used to sort the chips. */
  lastTippedAt?: string;
}

/** What the shell needs to know to dispatch the actual tip-creation. */
export interface TipSubmitFields {
  /** Empty string ⇒ public tip (no recipient lookup). */
  username: string;
  platform: TipPlatform;
  assetId: string;
  amountAtomic: bigint;
  isPublic: boolean;
  senderAnonymous: boolean;
}

export type TipSubmitOutcome =
  | {
      ok: true;
      tipId: string;
      /** Set for public tips once the funding tx hits the confirmation
       *  threshold. Targeted tips don't need a share URL (the recipient
       *  is notified by the bot directly). */
      shareUrl: string | null;
      /** True iff the share URL isn't ready yet because funding still
       *  needs to confirm. Targeted tips also set false. */
      shareUrlPending: boolean;
    }
  | { ok: false; error: string };

export interface TipMakerProps {
  /** Asset ids the user can tip with (ordered as on the asset registry).
   *  Filter out assets where the user has zero balance via
   *  `resolveBalance` upstream if desired. */
  assetIds: string[];
  /** Spendable atomic balance for an asset (drives the "Insufficient
   *  funds" check + the default-asset auto-pick). */
  resolveBalance: (assetId: string) => bigint;
  /** Parse user-typed amount in the asset's native unit (e.g. "0.005"
   *  → 500000 satoshis). Returns null on bad input. */
  parseAmount: (assetId: string, text: string) => bigint | null;
  /** Recent recipients surfaced as chips + autocomplete. Shell pulls
   *  these from getSentSocialTips / local cache. Newest first. */
  recentRecipients?: RecentRecipient[];
  /** Look up a username on a platform to see if they're a registered
   *  Smirk user (drives the encryption-to-known-pubkey path). The shell
   *  wraps `api.lookupSocial` / `api.lookupSmirkName`. */
  lookupRecipient?: (
    platform: TipPlatform,
    username: string,
  ) => Promise<{ registered: boolean; hasAssetWallet: boolean }>;
  /** Submit the tip. Shell handles per-asset tx-construction +
   *  posting to /social/tip + Telegram/Discord bot notification. */
  onSubmit: (fields: TipSubmitFields) => Promise<TipSubmitOutcome>;
  /** Back to Home. */
  onExit: () => void;
  /** Optional: icon resolver for AssetIcon. */
  resolveIcon?: (iconKey: string) => string | undefined;
  /** Optional: hide an asset id (e.g. while Grin tipping is gated on
   *  user feature flag). Pass to filter the asset chip cycle. */
  hideAssetIds?: string[];
}

const PLATFORM_LABEL: Record<TipPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  smirk: 'Smirk',
};

const PLATFORM_ICON: Record<TipPlatform, string> = {
  telegram: '✈',
  discord: '🎮',
  smirk: 'S',
};

const PLATFORM_PLACEHOLDER: Record<TipPlatform, string> = {
  telegram: '@username',
  discord: 'username',
  smirk: '@username',
};

function normalizeUsername(platform: TipPlatform, raw: string): string {
  const trimmed = raw.trim();
  if (platform === 'telegram' || platform === 'smirk') {
    return trimmed.replace(/^@/, '').toLowerCase();
  }
  return trimmed;
}

export function TipMaker(props: TipMakerProps) {
  const visibleAssetIds = useMemo(
    () =>
      props.assetIds.filter(
        (id) => !(props.hideAssetIds ?? []).includes(id),
      ),
    [props.assetIds, props.hideAssetIds],
  );

  // Pick a default asset: caller's last-tipped asset for known recipient,
  // else the asset with the largest balance.
  const defaultAssetId = useMemo(() => {
    if (visibleAssetIds.length === 0) return '';
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
  }, [visibleAssetIds, props.resolveBalance]);

  const [platform, setPlatform] = useState<TipPlatform>('smirk');
  const [username, setUsername] = useState('');
  const [assetId, setAssetId] = useState<string>(defaultAssetId);
  const [amountText, setAmountText] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [senderAnonymous, setSenderAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lookupStatus, setLookupStatus] = useState<
    null | 'checking' | 'registered' | 'unregistered' | 'no-asset-wallet'
  >(null);
  const [result, setResult] = useState<
    null | { tipId: string; shareUrl: string | null; shareUrlPending: boolean }
  >(null);

  // Re-default asset when recipient changes (uses lastAssetId if known).
  useEffect(() => {
    if (!username.trim()) return;
    const normalized = normalizeUsername(platform, username);
    const recent = props.recentRecipients?.find(
      (r) => r.platform === platform && r.username === normalized,
    );
    if (recent?.lastAssetId && visibleAssetIds.includes(recent.lastAssetId)) {
      setAssetId(recent.lastAssetId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, platform]);

  // Debounced recipient lookup. Skipped for public tips.
  useEffect(() => {
    if (isPublic) {
      setLookupStatus(null);
      return;
    }
    if (!username.trim() || !props.lookupRecipient) {
      setLookupStatus(null);
      return;
    }
    const normalized = normalizeUsername(platform, username);
    if (normalized.length < 2) {
      setLookupStatus(null);
      return;
    }
    let cancelled = false;
    setLookupStatus('checking');
    const handle = window.setTimeout(async () => {
      try {
        const r = await props.lookupRecipient!(platform, normalized);
        if (cancelled) return;
        if (!r.registered) setLookupStatus('unregistered');
        else if (!r.hasAssetWallet) setLookupStatus('no-asset-wallet');
        else setLookupStatus('registered');
      } catch {
        if (!cancelled) setLookupStatus(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [username, platform, isPublic, assetId]);

  const balance = useMemo(
    () => (assetId ? props.resolveBalance(assetId) : 0n),
    [assetId, props.resolveBalance],
  );

  const parsedAmount = useMemo(
    () => (amountText && assetId ? props.parseAmount(assetId, amountText) : null),
    [amountText, assetId, props.parseAmount],
  );

  const insufficientFunds = parsedAmount !== null && parsedAmount > balance;
  const validRecipient =
    isPublic || normalizeUsername(platform, username).length >= 2;
  const canSubmit =
    !submitting &&
    !!assetId &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    !insufficientFunds &&
    validRecipient;

  const submit = async () => {
    setError(null);
    if (!parsedAmount || !assetId) return;
    setSubmitting(true);
    const outcome = await props.onSubmit({
      username: isPublic ? '' : normalizeUsername(platform, username),
      platform,
      assetId,
      amountAtomic: parsedAmount,
      isPublic,
      senderAnonymous,
    });
    setSubmitting(false);
    if (outcome.ok) {
      setResult({
        tipId: outcome.tipId,
        shareUrl: outcome.shareUrl,
        shareUrlPending: outcome.shareUrlPending,
      });
    } else {
      setError(outcome.error);
    }
  };

  if (result) {
    return (
      <TipSuccess
        tipId={result.tipId}
        shareUrl={result.shareUrl}
        shareUrlPending={result.shareUrlPending}
        platform={platform}
        username={username}
        isPublic={isPublic}
        amount={amountText}
        ticker={mustGetAsset(assetId).ticker}
        onClose={props.onExit}
      />
    );
  }

  const asset = assetId ? mustGetAsset(assetId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button onClick={props.onExit} style={navBtn}>
          Cancel
        </button>
        <span style={{ opacity: 0.6 }}>Tip</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, textAlign: 'center' }}>
        Send a Tip 🎁
      </h2>

      {/* --- Recipient --- */}
      {!isPublic && (
        <div>
          <Label>To</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            <PlatformPicker value={platform} onChange={setPlatform} />
            <input
              type="text"
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              placeholder={PLATFORM_PLACEHOLDER[platform]}
              autoFocus
              style={inputStyle}
            />
          </div>
          {lookupStatus && (
            <div
              style={{
                fontSize: 11,
                color:
                  lookupStatus === 'registered'
                    ? 'var(--smirk-positive)'
                    : lookupStatus === 'checking'
                    ? 'var(--smirk-fg-muted)'
                    : 'var(--smirk-warning, #d8a14d)',
                marginTop: 4,
              }}
            >
              {lookupStatus === 'checking' && 'Checking…'}
              {lookupStatus === 'registered' &&
                '✓ Smirk user found — they\'ll get an in-app notification'}
              {lookupStatus === 'unregistered' &&
                "Not yet a Smirk user — we'll notify them via " + PLATFORM_LABEL[platform]}
              {lookupStatus === 'no-asset-wallet' &&
                'Recipient doesn\'t have a wallet for this asset yet'}
            </div>
          )}
        </div>
      )}

      {/* --- Recent recipients chip row --- */}
      {!isPublic &&
        props.recentRecipients &&
        props.recentRecipients.length > 0 && (
          <div>
            <Label>Recent</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {props.recentRecipients.slice(0, 6).map((r) => (
                <button
                  key={`${r.platform}:${r.username}`}
                  onClick={() => {
                    setPlatform(r.platform);
                    setUsername(r.username);
                  }}
                  style={chipStyle}
                >
                  {PLATFORM_ICON[r.platform]} {r.username}
                </button>
              ))}
            </div>
          </div>
        )}

      {/* --- Amount + asset --- */}
      <div>
        <Label>Amount</Label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onInput={(e) => setAmountText((e.target as HTMLInputElement).value)}
            placeholder="0.00"
            style={{ ...inputStyle, flex: 1 }}
          />
          {asset && (
            <button onClick={() => cycleAsset(setAssetId, visibleAssetIds, assetId)} style={assetChipStyle}>
              <AssetIcon
                assetId={assetId}
                size={18}
                {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
              />
              <span style={{ marginLeft: 4 }}>{asset.ticker}</span>
              <span style={{ marginLeft: 4, opacity: 0.5 }}>▼</span>
            </button>
          )}
        </div>
        {asset && (
          <div
            style={{
              fontSize: 11,
              color: insufficientFunds
                ? 'var(--smirk-negative, #ff6b6b)'
                : 'var(--smirk-fg-muted)',
              marginTop: 4,
            }}
          >
            {insufficientFunds
              ? 'Insufficient balance'
              : `Available: ${formatAmountWithTicker(balance, assetId)}`}
          </div>
        )}
      </div>

      {/* --- Toggles --- */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 12px',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          border: '1px solid var(--smirk-border)',
          borderRadius: 8,
        }}
      >
        <Toggle
          checked={isPublic}
          onChange={setIsPublic}
          label="Anyone with the link can claim"
          hint="Generates a share URL; anyone who opens it first claims the tip."
        />
        <Toggle
          checked={senderAnonymous}
          onChange={setSenderAnonymous}
          label="Send anonymously"
          hint="Hide your Smirk username from the recipient."
        />
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>
          {error}
        </div>
      )}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        style={{
          ...primaryBtnStyle,
          opacity: canSubmit ? 1 : 0.5,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {submitting ? 'Sending…' : 'Send Tip 🎁'}
      </button>
    </div>
  );
}

// ---- Success view --------------------------------------------------------

function TipSuccess({
  tipId,
  shareUrl,
  shareUrlPending,
  platform,
  username,
  isPublic,
  amount,
  ticker,
  onClose,
}: {
  tipId: string;
  shareUrl: string | null;
  shareUrlPending: boolean;
  platform: TipPlatform;
  username: string;
  isPublic: boolean;
  amount: string;
  ticker: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ textAlign: 'center', padding: '32px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 48 }}>🎁</div>
      <h2 style={{ margin: 0, fontSize: 18 }}>Tip sent!</h2>
      <div style={{ fontSize: 14 }}>
        {amount} {ticker}
      </div>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
        {isPublic
          ? 'Public tip — anyone with the link can claim'
          : `We notified @${normalizeUsername(platform, username)} on ${PLATFORM_LABEL[platform]} 🎉`}
      </div>

      {isPublic && shareUrl && (
        <div>
          <div
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
          <button onClick={() => copy(shareUrl)} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
            {copied ? '✓ Copied' : '⧉ Copy link'}
          </button>
        </div>
      )}

      {isPublic && shareUrlPending && (
        <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
          Share link ready after the funding tx confirms.
          <br />
          Find it in this tip's detail page from Home.
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
        tip id: <code>{tipId.slice(0, 12)}…</code>
      </div>

      <button onClick={onClose} style={primaryBtnStyle}>
        Done
      </button>
    </div>
  );
}

// ---- Small UI pieces ----------------------------------------------------

function Label({ children }: { children: string }) {
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

function PlatformPicker({
  value,
  onChange,
}: {
  value: TipPlatform;
  onChange: (p: TipPlatform) => void;
}) {
  const order: TipPlatform[] = ['smirk', 'telegram', 'discord'];
  const cycle = () => {
    const idx = order.indexOf(value);
    onChange(order[(idx + 1) % order.length]!);
  };
  return (
    <button
      onClick={cycle}
      title={`Platform: ${PLATFORM_LABEL[value]} — tap to cycle`}
      style={{
        ...assetChipStyle,
        minWidth: 50,
        justifyContent: 'center',
      }}
    >
      <span style={{ fontSize: 14 }}>{PLATFORM_ICON[value]}</span>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      <input
        type="checkbox"
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

function cycleAsset(
  setAssetId: (id: string) => void,
  visibleIds: string[],
  current: string,
) {
  if (visibleIds.length === 0) return;
  const idx = visibleIds.indexOf(current);
  setAssetId(visibleIds[(idx + 1) % visibleIds.length]!);
}

// suppress unused-import warning if listAssets isn't called above —
// retain reference so the import survives tree-shake refactors.
void listAssets;

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
