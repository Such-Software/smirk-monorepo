/**
 * InboxTab — unified surface for everything that needs the user's
 * attention (UI_DESIGN.md Principle 3).
 *
 * v0.3 ships with **pending Grin exchanges** only: incoming S1s
 * awaiting our receiver-side sign (`pending_to_sign`), and outgoing
 * S2s ready for our finalize (`pending_to_finalize`). The
 * relay-side data structures are described in
 * `packages/core/src/api/grin.ts` (createGrinRelay / getGrinPendingSlatepacks).
 *
 * v0.4+ adds atomic-swap rounds, tip notes, and e2ee DMs — each ride
 * the same envelope pattern, just different `kind` tags.
 *
 * Presentation-only: data + handlers are injected by the shell. The
 * shell is responsible for the 30s poll cadence and for routing each
 * row's "Sign" / "Finalize" actions into the appropriate wizard.
 */

import type { ComponentChildren } from 'preact';
import { ActionButton } from './ActionButton';
import { formatAmountWithTicker } from '../format';

// Grin's asset id in the registry. Used to format amounts for the v0.3
// Inbox (only Grin slatepacks today). When v0.4 adds swap rounds + tip
// notes, the row component will look up the asset per-item instead.
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

export interface InboxTabProps {
  /** Items the shell pulled from the slatepack relay. */
  items: InboxItem[];
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
}

export function InboxTab(props: InboxTabProps) {
  const toSign = props.items.filter(
    (i): i is InboxItemPendingToSign => i.kind === 'pending_to_sign',
  );
  const toFinalize = props.items.filter(
    (i): i is InboxItemPendingToFinalize => i.kind === 'pending_to_finalize',
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Header
        loading={props.loading ?? false}
        {...(props.onRefresh ? { onRefresh: props.onRefresh } : {})}
      />

      {props.error && toSign.length === 0 && toFinalize.length === 0 && (
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
          Grin slatepacks routed through Smirk relay.
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
}: {
  item: InboxItem;
  actionLabel: string;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid var(--smirk-border)',
        borderRadius: 8,
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        width: '100%',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {formatAmountWithTicker(item.amountAtomic, GRIN_ASSET_ID)}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {timeAgo(item.createdAt)} · slate {item.slateId.slice(0, 8)}…
          {item.counterpartyUserId ? ` · from ${item.counterpartyUserId.slice(0, 6)}…` : ' · external'}
        </div>
      </div>
      <ActionButton label={actionLabel} icon="›" onClick={onOpen} />
    </button>
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
