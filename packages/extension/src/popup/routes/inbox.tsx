import { useState } from 'preact/hooks';
import { type UnlockedWallet } from '@smirk/core';
import {
  InboxTab,
  useRoute,
  formatAmountWithTicker,
  type InboxItem,
  type InboxTipItem,
} from '@smirk/ui';
import { store } from '../singletons';
import { cancelInboxItem } from '../inbox-actions';
import { MessagesRoute } from './messages';

/**
 * InboxPasteRouter: universal paste-and-dispatch screen.
 *
 * One textarea. User pastes a slatepack of any sta (S1/S2/I1/I2/S3/I3);
 * the shell's onDispatch inspects the slate, seeds the appropriate
 * wizard slot, and navigates there. The user never has to know what
 * kind of slatepack they have; they just paste once.
 */
export function InboxPasteRouter({
  onReadClipboard,
  onDispatch,
  onExit,
}: {
  onReadClipboard?: () => Promise<string>;
  onDispatch: (armored: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onExit: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Accept a slatepack OR a goblin:/nostr: pay-link; the shell's onDispatch
  // routes a pay-link to a pre-filled Send flow, a slatepack to the right wizard.
  const looksDispatchable = (s: string): boolean => {
    const t = s.trimStart();
    return t.startsWith('BEGINSLATEPACK') || /^(goblin|nostr):/i.test(t);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!looksDispatchable(trimmed)) {
      setError("Doesn't look like a slatepack or a pay-link");
      return;
    }
    setError(null);
    setBusy(true);
    const result = await onDispatch(trimmed);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const pasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      if (looksDispatchable(clip)) {
        setText(clip);
        setError(null);
      } else {
        setError("Clipboard doesn't contain a slatepack.");
      }
    } catch {
      setError('Could not read clipboard. Paste manually below.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button
          onClick={onExit}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            padding: '4px 8px',
          }}
        >
          ‹ Back
        </button>
        <span style={{ opacity: 0.5 }}>Paste slatepack</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Paste a slatepack</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
        Drop in any Grin slatepack — incoming payment (S1), invoice (I1),
        signed response (S2/I2). We'll figure out what kind it is and
        route you to the right next step.
      </div>

      <textarea
        data-testid="paste-dispatch-input"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK.&#10;…&#10;ENDSLATEPACK."
        rows={6}
        autoFocus
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 11,
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid var(--smirk-border)',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          color: 'inherit',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <div style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {onReadClipboard && (
          <button
            onClick={pasteFromClipboard}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '1px solid var(--smirk-border)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 6,
            }}
          >
            📋 Paste from clipboard
          </button>
        )}
        <button
          data-testid="paste-dispatch-submit"
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          style={{
            flex: 1,
            background: text.trim() && !busy ? 'var(--smirk-accent)' : 'rgba(255,255,255,0.06)',
            color: 'var(--smirk-accent-fg, #fff)',
            border: 'none',
            cursor: text.trim() && !busy ? 'pointer' : 'not-allowed',
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 16px',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'Inspecting…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

/**
 * PasteTipLinkScreen: entry point for public tips shared as a URL.
 *
 * Public tips never land in the received-tips list because they're
 * not addressed to a specific username; the URL fragment is the only
 * access token. Whoever pastes the link in here can claim the funds.
 *
 * On success we render the swept amount + txid in a toast and bounce
 * back to Inbox; the shell auto-unhides the asset so the funds appear
 * on Home.
 */
export function PasteTipLinkScreen({
  onReadClipboard,
  onClaim,
  onExit,
}: {
  onReadClipboard?: () => Promise<string>;
  onClaim: (
    url: string,
  ) => Promise<
    | { ok: true; assetId?: string; amountAtomic?: bigint }
    | { ok: false; error: string }
  >;
  onExit: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    assetId?: string;
    amountAtomic?: bigint;
  } | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Paste a tip link first.');
      return;
    }
    setError(null);
    setBusy(true);
    const outcome = await onClaim(trimmed);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    const next: { assetId?: string; amountAtomic?: bigint } = {};
    if (outcome.assetId !== undefined) next.assetId = outcome.assetId;
    if (outcome.amountAtomic !== undefined) next.amountAtomic = outcome.amountAtomic;
    setResult(next);
  };

  const pasteFromClipboard = async () => {
    if (!onReadClipboard) return;
    try {
      const clip = await onReadClipboard();
      setText(clip);
      setError(null);
    } catch {
      setError('Could not read clipboard. Paste manually below.');
    }
  };

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ width: 60 }} />
          <span style={{ opacity: 0.5 }}>Tip claimed</span>
          <span style={{ width: 60 }} />
        </header>
        <div
          data-testid="paste-tip-success"
          style={{
            padding: 16,
            background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
            border: '1px solid var(--smirk-accent)',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {result.assetId && result.amountAtomic !== undefined
              ? `Received ${formatAmountWithTicker(result.amountAtomic, result.assetId)}`
              : 'Tip claimed'}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--smirk-fg-muted)',
              marginTop: 6,
            }}
          >
            Funds are settling on-chain. They'll appear on Home shortly.
          </div>
        </div>
        <button
          onClick={onExit}
          data-testid="paste-tip-done-btn"
          style={{
            background: 'var(--smirk-accent)',
            color: 'var(--smirk-accent-fg, #fff)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            padding: '10px 16px',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          Back to Inbox
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button
          onClick={onExit}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            padding: '4px 8px',
          }}
        >
          ‹ Back
        </button>
        <span style={{ opacity: 0.5 }}>Paste tip link</span>
        <span style={{ width: 60 }} />
      </header>

      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Claim a tip from a link</h2>
      <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)', marginBottom: 4 }}>
        Paste a Smirk public-tip URL (smirk.cash/tip/…#…). The fragment
        after the # is the spend key — keep the full URL secret until
        you've claimed.
      </div>

      <textarea
        data-testid="paste-tip-input"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        placeholder="https://smirk.cash/tip/…#…"
        rows={3}
        autoFocus
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 11,
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid var(--smirk-border)',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
          color: 'inherit',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <div data-testid="paste-tip-error" style={{ fontSize: 12, color: 'var(--smirk-negative, #ff6b6b)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {onReadClipboard && (
          <button
            data-testid="paste-tip-clipboard-btn"
            onClick={pasteFromClipboard}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '1px solid var(--smirk-border)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 6,
            }}
          >
            📋 Paste from clipboard
          </button>
        )}
        <button
          data-testid="paste-tip-claim-btn"
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          style={{
            flex: 1,
            background: text.trim() && !busy ? 'var(--smirk-accent)' : 'rgba(255,255,255,0.06)',
            color: 'var(--smirk-accent-fg, #fff)',
            border: 'none',
            cursor: text.trim() && !busy ? 'pointer' : 'not-allowed',
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 16px',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      </div>
    </div>
  );
}

// ----- Other tabs (still stubs) -----




export function InboxRouter({
  wallet,
  userId,
  inbox,
  tips,
  onRefresh,
  onClaimTip,
}: {
  wallet: UnlockedWallet;
  /** Backend user UUID from `bootstrap.userId`. Required for Grin API
   *  calls: the local seed fingerprint won't parse as a UUID
   *  server-side. */
  userId: string;
  inbox: { items: InboxItem[]; loading: boolean; error: string | null };
  tips: InboxTipItem[];
  onRefresh: () => Promise<void>;
  onClaimTip: (item: InboxTipItem) => Promise<void>;
}) {
  const { navigate, route } = useRoute();
  // Tapping a pending_to_sign row seeds the GrinPasteIncomingWizard
  // with the relay's slatepack + relayId so the user lands at the
  // auto-sign step instead of pasting manually. The wizard's sign
  // handler posts S2 back through the relay (api.signGrinSlatepack)
  // when relayId is set, advancing the sender's queue automatically.
  const handleOpenIncomingSign = async (
    slatepack: string,
    relayId: string,
  ) => {
    await store.update((s) => {
      s.wizards['grin-paste-incoming'] = {
        step: 1, // skip the Paste step (already have S1)
        startedAt: Date.now(),
        fields: {
          armoredIncoming: slatepack,
          relayId,
        },
      };
    });
    void navigate('home/receive/grin-incoming');
    // wallet param reserved for v0.4 (multi-pending tracking that keys
    // wizard slots by counterparty / relay_id rather than overwriting
    // the singleton slot).
    void wallet;
  };
  // pending_to_finalize: the SendWizard's existing wizard.fields already
  // hold the sender context for the in-flight S1 (set on send-time).
  // Pre-fill the S2 textarea via wizard.fields.grinPastedS2 so the
  // user just hits "Finalize & broadcast" in the Exchange step. If the
  // wizard's slate_id doesn't match the inbox row (e.g. user sent
  // twice), they can still cancel + restart manually.
  const handleOpenIncomingFinalize = async (slatepack: string) => {
    await store.update((s) => {
      const w = s.wizards.send;
      if (w) {
        w.fields.grinPastedS2 = slatepack;
      }
    });
    // Clipboard fallback for the "wizard slot mismatch" case.
    void navigator.clipboard.writeText(slatepack).catch(() => undefined);
    void navigate('home/send');
  };
  // Drop a row from the relay. Backend marks the entry cancelled; our 30s poll
  // picks up the removal.
  //
  // A `pending_to_finalize` row is an in-flight send we initiated but have NOT
  // broadcast yet (we're waiting on the recipient's S2 / to finalize). The
  // overlay reserves this send's inputs + change index AT BUILD TIME
  // (startGrinSend), so cancelling the row must ALSO free those reserved inputs
  // or they stay excluded from selection until the 7-day age-out (stuck funds).
  // cancelInboxItem does exactly that; it calls the overlay's pre-broadcast
  // remove() (which refuses to free an already-broadcast tx's inputs) before
  // cancelling on the transport. (The old custodial
  // unlockGrinOutputs/updateGrinTransaction calls hit dead v3 endpoints and are
  // gone.)
  const handleCancel = async (item: InboxItem) => {
    // Don't silently swallow: if we can't cancel this row (backend ownership
    // check, or a Nostr gift-wrap that won't send) the user sees nothing happen
    // and the row sticks around forever. Surface the failure so they can act on
    // it. Routes over the item's transport: a Nostr item (relayId packs the
    // counterparty) gift-wraps a cancel back to the sender; a backend item hits
    // the relay cancel endpoint.
    const mnemonic = wallet.mnemonic;
    if (!mnemonic) {
      window.alert("Couldn't cancel: wallet is locked");
      return;
    }
    const cancelRes = await cancelInboxItem({ relayId: item.relayId, userId, mnemonic });
    if (cancelRes.error) {
      window.alert(`Couldn't cancel: ${cancelRes.error}`);
      return;
    }
    await onRefresh();
  };

  // The Messages drill-down is hosted here (under the Inbox tab) so it keeps the
  // Inbox nav highlighted. The paste family still lives in HomeRouter (they are
  // complex sub-routers); those keep the `home/inbox/*` prefix.
  if (route.current === 'inbox/messages') {
    return <MessagesRoute wallet={wallet} onBack={() => navigate('inbox')} />;
  }

  return (
    <InboxTab
      items={inbox.items}
      tips={tips}
      loading={inbox.loading}
      error={inbox.error}
      onRefresh={() => void onRefresh()}
      onClaimTip={(item) => onClaimTip(item)}
      onPasteSlatepack={() => {
        // Reset prior paste-router state so the user starts fresh.
        void store
          .update((s) => {
            if (s.wizards['grin-paste-router']) {
              delete s.wizards['grin-paste-router'];
            }
          })
          .then(() => navigate('home/inbox/paste'));
      }}
      onOpenMessages={() => navigate('inbox/messages')}
      onPasteTipLink={() => navigate('home/inbox/paste-tip')}
      onOpenIncomingSign={(item) =>
        void handleOpenIncomingSign(item.slatepack, item.relayId)
      }
      onOpenIncomingFinalize={(item) =>
        void handleOpenIncomingFinalize(item.slatepack)
      }
      onCancel={(item) => void handleCancel(item)}
    />
  );
}
