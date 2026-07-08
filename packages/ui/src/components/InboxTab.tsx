/**
 * InboxTab — unified surface for everything that needs the user's
 * attention (UI_DESIGN.md Principle 3).
 *
 * Two row families today:
 *   - **Grin slatepacks**: incoming S1s awaiting our receiver-side
 *     sign (`pending_to_sign`), outgoing S2s ready for our finalize
 *     (`pending_to_finalize`). Relay-backed (Smirk-to-Smirk traffic).
 *   - **Incoming social tips**: tips someone sent to our handle.
 *     Bucketed into "Waiting for confirmations" (still maturing
 *     on-chain) and "Ready to claim" (the sender's broadcast has
 *     enough confirmations; one tap sweeps funds to our wallet).
 *
 * v0.4+ adds atomic-swap rounds and e2ee DMs — each ride the same
 * envelope pattern, just different `kind` tags or a new prop array.
 *
 * Presentation-only: data + handlers are injected by the shell. The
 * shell owns the 30s poll cadence (Grin relay + claimable/received
 * tips), routes Grin actions into the appropriate wizard, and runs
 * the per-asset sweep when the user taps Claim on a ready tip.
 */

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ActionButton } from './ActionButton';
import { formatAmountWithTicker } from '../format';

// Grin's asset id in the registry. Used for the Grin-relay rows
// (always Grin). Tip rows look up their own asset per-item since
// they can be any of the five.
const GRIN_ASSET_ID = 'grin';

export interface InboxItemBase {
  /** Unique relay-side id, used by the shell to ack actions. */
  relayId: string;
  /** Grin slate id — for cross-reference with the user's tx history. */
  slateId: string;
  /** Counterparty user id (when known) or null for external wallets. */
  counterpartyUserId: string | null;
  /** Atomic amount (Grin nano units). */
  amountAtomic: bigint;
  /** Armored slatepack content. The shell uses this to populate
   *  the destination wizard's paste box on tap. */
  slatepack: string;
  /** ISO timestamp when the relay item was created. */
  createdAt: string;
  /** ISO timestamp when the relay item expires + is dropped. */
  expiresAt: string;
}

export interface InboxItemPendingToSign extends InboxItemBase {
  kind: 'pending_to_sign';
}
export interface InboxItemPendingToFinalize extends InboxItemBase {
  kind: 'pending_to_finalize';
}
export type InboxItem = InboxItemPendingToSign | InboxItemPendingToFinalize;

/**
 * A social tip the user has received and may need to act on.
 *
 * Two surfaces, distinguished by whether `fundingConfirmations`
 * has reached `confirmationsRequired`:
 *
 *   - **Pending** — sender broadcast funding, chain is still
 *     maturing. Renders with a confirmation progress strip.
 *   - **Claimable** — funding is buried, primary "Claim" action.
 *
 * `senderDisplay` is best-effort cosmetic — backend hides it if the
 * sender opted into anonymity. `assetId` is the canonical Smirk
 * asset id (`btc` / `ltc` / `xmr` / `wow` / `grin`), used to look
 * up display formatting + icons.
 */
export interface InboxTipItem {
  /** Backend tip id (UUID). Used by Claim handler. */
  tipId: string;
  assetId: 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
  amountAtomic: bigint;
  /** "@bob (Telegram)" / "@alice (Discord)" / "smirker" / null. */
  senderDisplay: string | null;
  fundingConfirmations: number;
  confirmationsRequired: number;
  createdAt: string;
}

export interface InboxTabProps {
  /** Items the shell pulled from the slatepack relay. */
  items: InboxItem[];
  /** Incoming social tips. Shell pulls via api.getReceivedTips on the
   *  same 30s poll cadence as the Grin relay. Optional so platform
   *  shells that don't speak the social tips API can omit. */
  tips?: InboxTipItem[];
  /** True while a fetch is in flight. Renders a subtle loading hint. */
  loading?: boolean;
  /** Error string from the last fetch — surfaced if `items` is empty. */
  error?: string | null;
  /** Manual refresh handler. The shell already polls on a 30s cadence;
   *  this lets the user trigger an immediate fetch. */
  onRefresh?: () => void;
  /** Tapping a pending_to_sign item: shell routes to the paste-incoming
   *  wizard (Phase 3.4) pre-populated with the item's slatepack. */
  onOpenIncomingSign: (item: InboxItemPendingToSign) => void;
  /** Tapping a pending_to_finalize item: shell routes back into the
   *  SendWizard Exchange step with the relay's S2 ready to paste. */
  onOpenIncomingFinalize: (item: InboxItemPendingToFinalize) => void;
  /**
   * Cancel a row from the relay. Shell calls
   * `api.cancelGrinSlatepack(item.relayId, …)` and refreshes the list.
   * For pending_to_finalize, also unlocks the sender's reserved outputs.
   */
  onCancel?: (item: InboxItem) => void | Promise<void>;
  /**
   * Tapping Claim on a ready tip: shell runs the per-asset sweep
   * (decrypt encrypted_key with the wallet's BTC private key, then
   * sweep tip_address → user's receive address, then
   * confirmTipSweep). Optional — omitted shells render tips as
   * informational rows with no claim button.
   */
  onClaimTip?: (item: InboxTipItem) => Promise<void> | void;
  /**
   * "+ Paste a slatepack" affordance at the top of the Inbox. The shell
   * routes to a paste screen which inspects the slate's `sta` field and
   * dispatches to the appropriate wizard (S1 → sign-as-receiver,
   * I1 → pay-invoice, S2 → finalize-send, I2 → finalize-invoice).
   * Required entry point for slatepacks that didn't arrive via the
   * Smirk relay — i.e. external grin-wallet, Grim, or clipboard handoff.
   */
  onPasteSlatepack?: () => void;
  /**
   * "+ Paste tip link" affordance for public tips shared as a URL
   * (`https://smirk.cash/tip/<id>#<fragment>`). The shell routes to a
   * paste screen that parses the URL via `parseShareUrl`, then runs
   * `claimPublicTip` to sweep the funds. Public tips never appear in
   * the received-tips list (they're not addressed to a specific
   * username), so this is the only way for the URL holder to claim.
   */
  onPasteTipLink?: () => void;
}

export function InboxTab(props: InboxTabProps) {
  const toSign = props.items.filter(
    (i): i is InboxItemPendingToSign => i.kind === 'pending_to_sign',
  );
  const toFinalize = props.items.filter(
    (i): i is InboxItemPendingToFinalize => i.kind === 'pending_to_finalize',
  );

  const tips = props.tips ?? [];
  const tipsPending = tips.filter(
    (t) => t.fundingConfirmations < t.confirmationsRequired,
  );
  const tipsClaimable = tips.filter(
    (t) => t.fundingConfirmations >= t.confirmationsRequired,
  );

  const allEmpty =
    toSign.length === 0 &&
    toFinalize.length === 0 &&
    tipsPending.length === 0 &&
    tipsClaimable.length === 0;

  return (
    <div data-testid="inbox-tab" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Header
        loading={props.loading ?? false}
        {...(props.onRefresh ? { onRefresh: props.onRefresh } : {})}
      />

      {(props.onPasteSlatepack || props.onPasteTipLink) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {props.onPasteSlatepack && (
            <button
              data-testid="inbox-paste-slatepack-btn"
              onClick={props.onPasteSlatepack}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '12px 14px',
                background: 'var(--smirk-accent)',
                color: 'var(--smirk-accent-fg, #fff)',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Paste a slatepack
            </button>
          )}
          {props.onPasteTipLink && (
            <button
              data-testid="inbox-paste-tip-link-btn"
              onClick={props.onPasteTipLink}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '12px 14px',
                background: 'transparent',
                color: 'var(--smirk-accent)',
                border: '1px solid var(--smirk-accent)',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Paste tip link
            </button>
          )}
        </div>
      )}

      {props.error && allEmpty && (
        <div
          style={{
            padding: 12,
            background: 'rgba(255, 107, 107, 0.08)',
            border: '1px solid rgba(255, 107, 107, 0.4)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--smirk-negative, #ff6b6b)',
          }}
        >
          {props.error}
        </div>
      )}

      {/* Tip sections render only when there's something to show OR
          the prop is wired but the lists are empty AND there's no
          Grin activity. Avoids showing two empty stubs to users who
          only ever do Grin and never receive tips. */}
      {(tipsClaimable.length > 0 ||
        (props.tips !== undefined && tipsClaimable.length === 0 && tipsPending.length === 0 && toSign.length === 0 && toFinalize.length === 0)) &&
        tipsClaimable.length > 0 && (
        <div data-testid="inbox-claimable-section">
          <Section
            title="Tips ready to claim"
            subtitle="Confirmed on-chain — one tap to sweep into your wallet."
            count={tipsClaimable.length}
          >
            {tipsClaimable.map((tip) => (
              <TipClaimableRow
                key={tip.tipId}
                tip={tip}
                {...(props.onClaimTip ? { onClaim: () => props.onClaimTip!(tip) } : {})}
              />
            ))}
          </Section>
        </div>
      )}

      {tipsPending.length > 0 && (
        <Section
          title="Tips waiting for confirmations"
          subtitle="Sender broadcast — funds appear once the chain matures."
          count={tipsPending.length}
        >
          {tipsPending.map((tip) => (
            <TipPendingRow key={tip.tipId} tip={tip} />
          ))}
        </Section>
      )}

      <Section
        title="To sign"
        subtitle="Senders are waiting for your receiver-side signature."
        count={toSign.length}
      >
        {toSign.length === 0 ? (
          <EmptyHint>Nothing waiting.</EmptyHint>
        ) : (
          toSign.map((item) => (
            <InboxRow
              key={item.relayId}
              item={item}
              actionLabel="Sign"
              onOpen={() => props.onOpenIncomingSign(item)}
              {...(props.onCancel ? { onCancel: () => props.onCancel!(item) } : {})}
            />
          ))
        )}
      </Section>

      <Section
        title="To finalize"
        subtitle="Receivers responded — finalize to broadcast."
        count={toFinalize.length}
      >
        {toFinalize.length === 0 ? (
          <EmptyHint>Nothing waiting.</EmptyHint>
        ) : (
          toFinalize.map((item) => (
            <InboxRow
              key={item.relayId}
              item={item}
              actionLabel="Finalize"
              onOpen={() => props.onOpenIncomingFinalize(item)}
              {...(props.onCancel ? { onCancel: () => props.onCancel!(item) } : {})}
            />
          ))
        )}
      </Section>
    </div>
  );
}

// ----- Internal pieces ----------------------------------------------------

function Header({ loading, onRefresh }: { loading: boolean; onRefresh?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 16 }}>Inbox</h2>
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginTop: 2 }}>
          Pending slatepack exchanges. Smirk-to-Smirk traffic shows up
          automatically; for everything else, use Paste.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {loading && (
          <span style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>Refreshing…</span>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            aria-label="Refresh"
            title="Refresh"
            style={{
              background: 'transparent',
              border: '1px solid var(--smirk-border)',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 6,
            }}
          >
            ↻
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: ComponentChildren;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
          {count} pending
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
        {subtitle}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

function InboxRow({
  item,
  actionLabel,
  onOpen,
  onCancel,
}: {
  item: InboxItem;
  actionLabel: string;
  onOpen: () => void;
  onCancel?: () => void;
}) {
  const age = ageBucket(item.createdAt);
  const borderColor =
    age === 'expiring'
      ? 'var(--smirk-negative, #ff6b6b)'
      : age === 'stale'
      ? 'var(--smirk-warning, #d8a14d)'
      : 'var(--smirk-border)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        opacity: age === 'expiring' ? 0.75 : 1,
      }}
    >
      <button
        onClick={onOpen}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          flex: 1,
          minWidth: 0,
          padding: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {formatAmountWithTicker(item.amountAtomic, GRIN_ASSET_ID)}
          </span>
          {age === 'stale' && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                padding: '1px 6px',
                borderRadius: 6,
                background: 'var(--smirk-warning, #d8a14d)',
                color: 'var(--smirk-bg, #000)',
              }}
            >
              Stale
            </span>
          )}
          {age === 'expiring' && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                padding: '1px 6px',
                borderRadius: 6,
                background: 'var(--smirk-negative, #ff6b6b)',
                color: 'var(--smirk-bg, #000)',
              }}
            >
              Expiring
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {timeAgo(item.createdAt)} · slate {item.slateId.slice(0, 8)}…
          {item.counterpartyUserId ? ` · from ${item.counterpartyUserId.slice(0, 6)}…` : ' · external'}
        </div>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <ActionButton label={actionLabel} icon="›" onClick={onOpen} />
        {onCancel && (
          <button
            onClick={onCancel}
            aria-label="Cancel"
            data-testid="inbox-grin-cancel-btn"
            title="Cancel — drop this slatepack from the relay"
            style={{
              background: 'transparent',
              border: '1px solid var(--smirk-border)',
              color: 'var(--smirk-fg-muted)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function TipClaimableRow({
  tip,
  onClaim,
}: {
  tip: InboxTipItem;
  onClaim?: () => Promise<void> | void;
}) {
  // Track in-flight claim per-row so the user gets feedback while
  // the sweep + broadcast + confirm round-trip is happening (often
  // 1-3 seconds for UTXO, longer for CryptoNote). Independent per
  // tip so multiple claims can be queued without UI confusion.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleClaim = async () => {
    if (!onClaim || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onClaim();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-testid={`tip-claimable-row-${tip.tipId}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid var(--smirk-accent)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {formatAmountWithTicker(tip.amountAtomic, tip.assetId)}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tip.senderDisplay ? `from ${tip.senderDisplay}` : 'from anonymous'} ·{' '}
            {timeAgo(tip.createdAt)}
          </div>
        </div>
        <ActionButton
          label={busy ? 'Claiming…' : 'Claim'}
          icon={busy ? '⋯' : '✓'}
          onClick={() => void handleClaim()}
          disabled={busy || !onClaim}
          testid="tip-claim-btn"
        />
      </div>
      {/* CryptoNote (XMR/WOW) sweep involves WASM ring-sig + key-image
          computation; total wall time is typically 5-10s on first
          claim. Without this hint, the static "Claiming…" label looks
          stuck and users start closing the popup mid-sweep. UTXO + Grin
          claims finish in 1-2s so the hint is asset-gated. */}
      {busy && (tip.assetId === 'xmr' || tip.assetId === 'wow') && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          Building on-chain sweep — this can take ~5–10s for{' '}
          {tip.assetId.toUpperCase()}. Safe to leave the popup open.
        </div>
      )}
      {error && (
        <div
          data-testid="tip-claim-error"
          style={{
            fontSize: 11,
            color: 'var(--smirk-negative, #ff6b6b)',
            marginTop: 2,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function TipPendingRow({ tip }: { tip: InboxTipItem }) {
  const progress = Math.min(
    1,
    tip.fundingConfirmations / Math.max(1, tip.confirmationsRequired),
  );
  return (
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {formatAmountWithTicker(tip.amountAtomic, tip.assetId)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
          {tip.fundingConfirmations} / {tip.confirmationsRequired} confs
        </span>
      </div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--smirk-fg-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {tip.senderDisplay ? `from ${tip.senderDisplay}` : 'from anonymous'} ·{' '}
        {timeAgo(tip.createdAt)}
      </div>
      <div
        style={{
          height: 4,
          background: 'var(--smirk-bg-sunken, rgba(255,255,255,0.06))',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.round(progress * 100)}%`,
            height: '100%',
            background: 'var(--smirk-accent)',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--smirk-fg-muted)',
        padding: '8px 12px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px dashed var(--smirk-border)',
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Bucket a slatepack relay row by age:
 *   - `fresh`    (< 1h) — normal styling.
 *   - `stale`    (≥ 1h, < 24h) — yellow border + "Stale" pill. The
 *                counterparty has gone quiet for an hour.
 *   - `expiring` (≥ 24h) — red border + "Expiring" pill, dimmed. The
 *                backend drops the row at 7d; this is just a visual
 *                signal that the user might want to chase the
 *                counterparty or cancel manually.
 * Purely informational — nothing is auto-dropped here.
 */
function ageBucket(iso: string): 'fresh' | 'stale' | 'expiring' {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'fresh';
  const ms = Date.now() - t;
  const HOUR = 60 * 60 * 1000;
  if (ms >= 24 * HOUR) return 'expiring';
  if (ms >= HOUR) return 'stale';
  return 'fresh';
}
