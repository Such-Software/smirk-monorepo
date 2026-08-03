/**
 * TipMaker: single-screen social tip composer.
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

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  /** Asset used last time this user tipped this recipient: drives the
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
  /** Optional: pre-select this asset on mount, overriding the
   *  largest-balance default. Shell wires this when the user arrives
   *  via the per-asset detail screen's Tip button: entering the Tip
   *  flow with the *intent* already attached to a coin is much less
   *  surprising than landing on whatever asset has the biggest
   *  balance. The recent-recipient lookup still overrides this once
   *  the user types a known handle (their last-tipped asset wins
   *  there; that's the stronger signal). */
  prefilledAssetId?: string;
  /**
   * Whether this backend can serve TARGETED (@username / platform) tips.
   *
   * There is currently NO targeted-tips capability on `BackendCapabilities`, and
   * the shipped backend is PUBLIC-ONLY: it rejects a targeted tip with a 400 at
   * submit time. So this defaults to `false`, and the composer:
   *   - opens as a PUBLIC share-URL tip (the out-of-box tip the backend accepts),
   *     rather than the old default of a targeted @username tip that 400s, and
   *   - hides the "anyone with the link can claim" toggle, so a user can't flip
   *     the composer into a targeted tip the backend can't fulfil.
   *
   * A future backend that advertises targeted-tip support can pass
   * `allowTargeted` (wired from that capability) to restore the recipient
   * composer + public/targeted toggle. Keep this capability-driven: do NOT
   * hardcode it true, or a public-only instance regresses to the 400 trap.
   */
  allowTargeted?: boolean;
}

const PLATFORM_LABEL: Record<TipPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  smirk: 'Smirk',
};

/** Brand-correct platform icons rendered inline as SVG (telegram,
 *  discord) or unicode emoji (smirk). v0.3 doesn't bundle a Nerd
 *  Font or icon-font, so SVGs go inline: they're tiny and avoid the
 *  extra HTTP fetch. */
function PlatformIcon({ platform, size = 14 }: { platform: TipPlatform; size?: number }) {
  if (platform === 'smirk') {
    // The Smirk emoji, used in the wallet's header brand mark and
    // throughout. Matches the wallet's identity character.
    return <span style={{ fontSize: size }}>😏</span>;
  }
  if (platform === 'telegram') {
    // Telegram brand: simpleicons.org path, public domain.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
      >
        <path d="M12 0C5.374 0 0 5.372 0 12s5.374 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.022c.24-.213-.054-.334-.373-.121l-6.869 4.326-2.96-.924c-.64-.203-.658-.643.135-.953l11.566-4.458c.538-.196 1.006.128.832.939z" />
      </svg>
    );
  }
  if (platform === 'discord') {
    // Discord brand: simpleicons.org path, public domain.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
      >
        <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.003-3.03.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.42 0-1.332.956-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.955 2.42-2.157 2.42zm7.974 0c-1.182 0-2.157-1.085-2.157-2.42 0-1.332.955-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.946 2.42-2.157 2.42z" />
      </svg>
    );
  }
  return null;
}

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

  // Pick a default asset:
  //   1. `prefilledAssetId` (shell-supplied: "I came from the Grin
  //      screen, I want to tip Grin"). Highest-priority signal.
  //   2. Recent recipient's `lastAssetId`: applied in the useEffect
  //      below once a known username is typed.
  //   3. Asset with the largest balance: final fallback when neither
  //      hint is available.
  const defaultAssetId = useMemo(() => {
    if (visibleAssetIds.length === 0) return '';
    if (
      props.prefilledAssetId &&
      visibleAssetIds.includes(props.prefilledAssetId)
    ) {
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

  const [platform, setPlatform] = useState<TipPlatform>('smirk');
  const [username, setUsername] = useState('');
  const [assetId, setAssetId] = useState<string>(defaultAssetId);
  const [amountText, setAmountText] = useState('');
  // Default to a PUBLIC share-URL tip unless this backend can serve targeted
  // tips (see `allowTargeted`). The shipped backend is public-only, so the
  // out-of-box tip must be one it accepts: a targeted default would 400 on
  // submit the moment the user filled the composer and pressed Send.
  const [isPublic, setIsPublic] = useState(!props.allowTargeted);
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
          <Label>Platform</Label>
          <PlatformDropdown value={platform} onChange={setPlatform} />
          <div style={{ marginTop: 8 }}>
            <Label>{PLATFORM_LABEL[platform]} username</Label>
            <input
              type="text"
              data-testid="tip-username-input"
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              placeholder={PLATFORM_PLACEHOLDER[platform]}
              autoFocus
              style={inputStyle}
            />
          </div>
          {lookupStatus && (
            <div
              data-testid="tip-lookup-status"
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
                  style={{
                    ...chipStyle,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <PlatformIcon platform={r.platform} size={12} />
                  <span>{r.username}</span>
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
        {/* Public/targeted toggle: only when this backend can actually serve a
            targeted tip. On a public-only backend the tip is ALWAYS a public
            share-URL tip, so surfacing this toggle would just let the user
            compose a targeted tip the backend 400s. See `allowTargeted`. */}
        {props.allowTargeted && (
          <Toggle
            checked={isPublic}
            onChange={setIsPublic}
            label="Anyone with the link can claim"
            hint="Generates a share URL; anyone who opens it first claims the tip."
            testid="tip-public-toggle"
          />
        )}
        <Toggle
          checked={senderAnonymous}
          onChange={setSenderAnonymous}
          label="Send anonymously"
          hint="Hide your Smirk username from the recipient."
          testid="tip-anonymous-toggle"
        />
      </div>

      {error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--smirk-negative, #ff6b6b)',
            // wrap long error strings (e.g., "Funded WOW at <95-char
            // address> but backend POST failed: …") instead of letting
            // them blow out the popup width with a horizontal
            // scrollbar.
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            maxWidth: '100%',
          }}
        >
          {error}
        </div>
      )}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        data-testid="tip-submit-btn"
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
      <h2 data-testid="tip-success-heading" style={{ margin: 0, fontSize: 18 }}>Tip sent!</h2>
      <div style={{ fontSize: 14 }}>
        {amount} {ticker}
      </div>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
        {isPublic
          ? 'Public tip — anyone with the link can claim'
          : `We notified @${normalizeUsername(platform, username)} on ${PLATFORM_LABEL[platform]} 🎉`}
      </div>

      {/* Two states for public tips:
          (a) confirmation-gated chains (XMR/WOW/GRIN) right after
              create: link exists but recipients would just see "0
              confs" if we surfaced it now. Hide the URL + button
              entirely; point the user at the Home banner that lights
              up when funding confirms.
          (b) instant chains (BTC/LTC) or any tip that's already
              past the confirmation gate: show URL + Copy link. */}
      {isPublic && shareUrl && !shareUrlPending && (
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

      {isPublic && shareUrlPending && (
        <div
          data-testid="tip-share-pending"
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            padding: 12,
            background: 'rgba(255,255,255,0.04)',
            border: '1px dashed var(--smirk-border)',
            borderRadius: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, color: 'inherit' }}>
            ⏳ Waiting for funding to confirm
          </div>
          <div>
            Share link goes live once the funding tx has enough
            confirmations. Home will show a banner the moment it's
            ready to share.
          </div>
        </div>
      )}

      <div data-testid="tip-id-label" style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
        tip id: <code>{tipId.slice(0, 12)}…</code>
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

/**
 * Inline-expanding dropdown: single row when closed, vertical list
 * when open. Scales to N platforms without crowding the popup
 * (popup is ~360px wide, so 3-button-row blew out horizontally as
 * brand names grew; future Matrix/Signal/Nostr/etc. would have made
 * it worse).
 */
function PlatformDropdown({
  value,
  onChange,
}: {
  value: TipPlatform;
  onChange: (p: TipPlatform) => void;
}) {
  const [open, setOpen] = useState(false);
  // Single source of platform ordering. Extend this when adding
  // Matrix / Signal / Nostr / etc.; Label + Icon already keyed by
  // TipPlatform union elsewhere in this file.
  const order: TipPlatform[] = ['smirk', 'telegram', 'discord'];

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="tip-platform-dropdown"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 12px',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          border: '1px solid var(--smirk-border)',
          borderRadius: 6,
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 500,
          boxSizing: 'border-box',
          textAlign: 'left',
        }}
      >
        <PlatformIcon platform={value} size={16} />
        <span style={{ flex: 1 }}>{PLATFORM_LABEL[value]}</span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            marginTop: 4,
            background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.04))',
            border: '1px solid var(--smirk-border)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          {order.map((p) => {
            const active = p === value;
            return (
              <button
                key={p}
                role="option"
                aria-selected={active}
                data-testid={`tip-platform-option-${p}`}
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 12px',
                  background: active
                    ? 'color-mix(in srgb, var(--smirk-accent) 18%, transparent)'
                    : 'transparent',
                  border: 'none',
                  color: active ? 'var(--smirk-accent)' : 'inherit',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  textAlign: 'left',
                }}
              >
                <PlatformIcon platform={p} size={16} />
                <span style={{ flex: 1 }}>{PLATFORM_LABEL[p]}</span>
                {active && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
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
 * Asset picker: popover anchored under the chip. Sits next to the
 * amount input, so we can't expand inline like the platform
 * dropdown (would shove the input out of place). Instead the option
 * list renders absolutely-positioned below the chip, right-aligned
 * to the chip's right edge so it stays within the popup width.
 *
 * Closes when user clicks outside (via a click-listener installed on
 * `document` while the popover is open) or selects an option.
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

  // Click-outside to close. Re-bound each time `open` flips on.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
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
        <AssetIcon
          assetId={value}
          size={18}
          {...(resolveIcon ? { resolveIcon } : {})}
        />
        <span style={{ marginLeft: 4 }}>{current.ticker}</span>
        <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>
          {open ? '▲' : '▼'}
        </span>
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
                  background: active
                    ? 'color-mix(in srgb, var(--smirk-accent) 18%, transparent)'
                    : 'transparent',
                  border: 'none',
                  color: active ? 'var(--smirk-accent)' : 'inherit',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  textAlign: 'left',
                }}
              >
                <AssetIcon
                  assetId={id}
                  size={18}
                  {...(resolveIcon ? { resolveIcon } : {})}
                />
                <span style={{ flex: 1 }}>{asset.ticker}</span>
                <span style={{ fontSize: 10, opacity: 0.5 }}>
                  {asset.displayName}
                </span>
                {active && <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// suppress unused-import warning if listAssets isn't called above;
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
