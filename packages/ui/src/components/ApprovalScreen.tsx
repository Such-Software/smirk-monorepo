/**
 * ApprovalScreen — the wallet-side UI for every dapp prompt.
 *
 * Single component, switches on `request.kind` internally so each
 * platform shell can mount one screen and let it render whatever the
 * pending request needs (connect / signMessage / requestPayment /
 * claimPublicTip).
 *
 * **Trust posture.** Every field we render that came from the page
 * (origin, siteName, favicon, message, address, amount) gets shown
 * as inert text — never injected as HTML, never made interactive.
 * The dapp doesn't get to style or animate the prompt. We do
 * surface the origin prominently because the user's mental model for
 * "should I approve this" is rooted in "do I trust this origin", not
 * "do I trust this payment shape".
 *
 * **Async approve handler.** The platform shell does the actual work
 * (sign a message, broadcast a payment) AFTER the user clicks
 * Approve — we show a spinner during that work so the user gets
 * feedback when crypto / network calls take a moment. If the
 * handler throws, we surface the error and let the user retry or
 * deny.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Button } from './Button';

/** Asset id the dapp protocol exchanges. Mirrors `SmirkAsset` from
 *  `@such-software/smirk-dapp-api` — declared inline so this UI package doesn't
 *  reach into the protocol package directly. */
export type ApprovalAsset = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';

/** Origin metadata for the requesting page. */
export interface ApprovalOrigin {
  origin: string;
  siteName?: string;
  favicon?: string;
}

/** Discriminated request shape — must match `ApprovalRequest` from
 *  `@such-software/smirk-dapp-api` so platform shells can pass it through. */
export type ApprovalRequest =
  | {
      kind: 'connect';
      origin: ApprovalOrigin;
      requestedAssets: ApprovalAsset[];
    }
  | {
      kind: 'signMessage';
      origin: ApprovalOrigin;
      message: string;
      assets: ApprovalAsset[];
    }
  | {
      kind: 'requestPayment';
      origin: ApprovalOrigin;
      asset: 'btc' | 'ltc' | 'xmr' | 'wow';
      amount: string;
      address: string;
      memo?: string;
    }
  | {
      kind: 'claimPublicTip';
      origin: ApprovalOrigin;
      tipId: string;
      fragmentKey: string;
    }
  | {
      kind: 'nostrGrant';
      origin: ApprovalOrigin;
    }
  | {
      kind: 'signNostrEvent';
      origin: ApprovalOrigin;
      event: {
        kind: number;
        content: string;
        tags: string[][];
        created_at?: number;
      };
      /** Risk tier of the event kind. `money` shows a strong warning + no session
       *  option; `session-grantable` may offer "remember for this session". */
      tier?: 'money' | 'session-grantable' | 'default';
      /** True when an active session already covers this kind — auto-approve. */
      sessionCovered?: boolean;
    }
  | {
      kind: 'appEncKey';
      origin: ApprovalOrigin;
      domainScope: string;
      context: string;
      /** True on the origin's first e2ee use — shows the disclosure and asks
       *  for a click. False = re-derive under an existing grant (auto-approves). */
      firstGrant: boolean;
    }
  | {
      kind: 'appSealOpen';
      origin: ApprovalOrigin;
      domainScope: string;
      context: string;
      sealed: string;
    }
  | {
      kind: 'nostrCrypt';
      origin: ApprovalOrigin;
      op: 'encrypt' | 'decrypt';
      scheme: 'nip44' | 'nip04';
      peer: string;
      data: string;
      /** True on this origin's FIRST crypto call, which prompts instead of
       *  self-approving. Mirrors the field in @such-software/smirk-dapp-api. */
      firstGrant?: boolean;
    };

export interface ApprovalScreenProps {
  request: ApprovalRequest;
  /** Called when the user confirms. For `connect`, the chosen
   *  subset of assets is passed; for everything else the platform
   *  shell already has the request params and does the work
   *  internally. Resolves when the work is done — the screen
   *  shows a spinner in the meantime. May throw, in which case the
   *  screen surfaces the error and stays open so the user can retry
   *  or deny. */
  onApprove: (approval: ApprovalApproval) => Promise<void>;
  /** Called when the user denies. The screen calls this and trusts
   *  the platform shell to close the window. */
  onDeny: () => void;
  /**
   * Format an atomic-units amount into a display string with the
   * correct decimals/ticker for the asset. Injected so this UI
   * package doesn't depend on `@smirk/assets`. Optional — falls back
   * to "<atomic> (atomic units)" when missing.
   */
  formatAmount?: (asset: string, atomic: string) => string;
}

/** What the screen hands back on approve. Discriminated on `kind`
 *  to match the request. */
export type ApprovalApproval =
  | { kind: 'connect'; approvedAssets: ApprovalAsset[] }
  | { kind: 'signMessage' }
  | { kind: 'requestPayment' }
  | { kind: 'claimPublicTip' }
  | { kind: 'nostrGrant'; perOrigin?: boolean }
  | { kind: 'signNostrEvent'; grantSession?: { kinds: number[]; expiresAt: number } }
  | { kind: 'appEncKey' }
  | { kind: 'appSealOpen' }
  | { kind: 'nostrCrypt' };

/** Kinds the wallet resolves WITHOUT a fresh user click. `appSealOpen`, a
 *  re-derive `appEncKey` (firstGrant === false), and `nostrCrypt` (NIP-07 DM
 *  encrypt/decrypt) all run under an already-granted scope on low-risk data — a
 *  per-call prompt would be friction with no security value (Goblin's model too:
 *  DM crypto is session-grantable; only money-tier events prompt). The screen
 *  still renders (unlock is enforced upstream); it just self-approves on mount. */
function isAutoApprove(request: ApprovalRequest): boolean {
  if (request.kind === 'appSealOpen') return true;
  // NOT unconditional: the first crypto call for an origin prompts, so the user
  // learns the scope covers reading their messages, not just disclosing an npub.
  // Subsequent calls run silently (a prompt per DM decrypt is unusable).
  if (request.kind === 'nostrCrypt') return !request.firstGrant;
  if (request.kind === 'appEncKey') return !request.firstGrant;
  // A Nostr signature auto-approves ONLY when an active session covers its kind.
  // The handler sets sessionCovered=false for money-tier, so those always prompt.
  if (request.kind === 'signNostrEvent') return request.sessionCovered === true;
  return false;
}

export function ApprovalScreen({
  request,
  onApprove,
  onDeny,
  formatAmount,
}: ApprovalScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Remember for this session" toggle — only meaningful for a session-grantable
  // Nostr signature. Ignored for every other kind (and for money-tier, which the
  // body never offers it for).
  const [grantForSession, setGrantForSession] = useState(false);
  // Nostr identity-grant picker: false = share your main identity (default),
  // true = a fresh compartmentalized identity just for this site.
  const [nostrPerOrigin, setNostrPerOrigin] = useState(false);

  const handleApprove = async (approval: ApprovalApproval) => {
    setBusy(true);
    setError(null);
    try {
      await onApprove(approval);
      // Caller is responsible for window.close — we don't presume.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
      setBusy(false);
    }
  };

  // Granted-scope e2ee reads self-approve on mount (no user click). If it
  // throws, the error surfaces and the Deny/Approve buttons stay live for a
  // manual retry, same as any other prompt.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current || !isAutoApprove(request)) return;
    autoFired.current = true;
    if (request.kind === 'appSealOpen') void handleApprove({ kind: 'appSealOpen' });
    else if (request.kind === 'nostrCrypt') void handleApprove({ kind: 'nostrCrypt' });
    else if (request.kind === 'appEncKey') void handleApprove({ kind: 'appEncKey' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  return (
    // Natural-height stack — let content size to its actual size.
    // Earlier this used `minHeight: 100vh` with a `flex:1` spacer to
    // pin actions to the bottom; in the chrome.windows.create popup
    // (640px tall, much taller than the prompt body) the spacer
    // grew to push the Deny/Approve buttons out the bottom edge.
    // No spacer + no minHeight = actions sit immediately below the
    // body, popup window auto-fits.
    <div
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxSizing: 'border-box',
        background: 'var(--smirk-bg)',
        color: 'var(--smirk-fg)',
      }}
    >
      <OriginHeader origin={request.origin} />
      <ApprovalBody
        request={request}
        grantForSession={grantForSession}
        onToggleGrant={setGrantForSession}
        nostrPerOrigin={nostrPerOrigin}
        onToggleNostrPerOrigin={setNostrPerOrigin}
        {...(formatAmount ? { formatAmount } : {})}
      />
      {error && (
        <div
          style={{
            background: 'var(--smirk-bg-sunken)',
            color: 'var(--smirk-negative)',
            border: '1px solid var(--smirk-negative)',
            padding: 12,
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      <ApprovalActions
        request={request}
        busy={busy}
        onApprove={handleApprove}
        onDeny={onDeny}
        grantForSession={grantForSession}
        nostrPerOrigin={nostrPerOrigin}
      />
    </div>
  );
}

function OriginHeader({ origin }: { origin: ApprovalOrigin }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {origin.favicon ? (
        <img
          src={origin.favicon}
          alt=""
          width={32}
          height={32}
          style={{ borderRadius: 6, background: 'var(--smirk-bg-sunken)' }}
        />
      ) : (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            background: 'var(--smirk-bg-sunken)',
            border: '1px solid var(--smirk-border)',
          }}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {origin.siteName && (
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--smirk-fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {origin.siteName}
          </div>
        )}
        <div
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {origin.origin}
        </div>
      </div>
    </div>
  );
}

function ApprovalBody({
  request,
  formatAmount,
  grantForSession,
  onToggleGrant,
  nostrPerOrigin,
  onToggleNostrPerOrigin,
}: {
  request: ApprovalRequest;
  formatAmount?: (asset: string, atomic: string) => string;
  grantForSession: boolean;
  onToggleGrant: (v: boolean) => void;
  nostrPerOrigin: boolean;
  onToggleNostrPerOrigin: (v: boolean) => void;
}) {
  switch (request.kind) {
    case 'connect':
      return <ConnectBody assets={request.requestedAssets} />;
    case 'signMessage':
      return <SignMessageBody message={request.message} />;
    case 'requestPayment':
      return (
        <PaymentBody
          asset={request.asset}
          amount={request.amount}
          address={request.address}
          {...(request.memo !== undefined ? { memo: request.memo } : {})}
          {...(formatAmount ? { formatAmount } : {})}
        />
      );
    case 'claimPublicTip':
      return <ClaimTipBody />;
    case 'nostrGrant':
      return <NostrGrantBody perOrigin={nostrPerOrigin} onToggle={onToggleNostrPerOrigin} />;
    case 'signNostrEvent':
      return (
        <SignNostrEventBody
          event={request.event}
          tier={request.tier ?? 'default'}
          grantForSession={grantForSession}
          onToggleGrant={onToggleGrant}
        />
      );
    case 'appEncKey':
      return <AppEncKeyBody firstGrant={request.firstGrant} context={request.context} />;
    case 'appSealOpen':
      return <AppSealOpenBody />;
    case 'nostrCrypt':
      return <NostrCryptBody op={request.op} />;
  }
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--smirk-fg-muted)',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ConnectBody({ assets }: { assets: ApprovalAsset[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Connect this site?
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        The site will be able to see your public keys and request
        signatures for the assets you authorize. It cannot move funds
        without an explicit prompt every time.
      </p>
      <Section title="Assets requested">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {assets.map((a) => (
            <AssetChip key={a} asset={a} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function SignMessageBody({ message }: { message: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Sign message?
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        The site is requesting a signature. Signatures can prove
        ownership of your address — do not sign messages you don't
        recognize.
      </p>
      <Section title="Message">
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--smirk-bg-sunken)',
            color: 'var(--smirk-fg)',
            border: '1px solid var(--smirk-border)',
            borderRadius: 8,
            fontSize: 12,
            fontFamily: 'var(--smirk-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {message}
        </pre>
      </Section>
    </div>
  );
}

function PaymentBody({
  asset,
  amount,
  address,
  memo,
  formatAmount,
}: {
  asset: string;
  amount: string;
  address: string;
  memo?: string;
  formatAmount?: (asset: string, atomic: string) => string;
}) {
  const display = formatAmount ? formatAmount(asset, amount) : `${amount} (atomic units)`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Send {asset.toUpperCase()}?
      </h2>
      <Section title="Amount">
        <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--smirk-fg)' }}>
          {display}
        </div>
      </Section>
      <Section title="To">
        <div
          style={{
            fontSize: 12,
            color: 'var(--smirk-fg)',
            fontFamily: 'var(--smirk-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            wordBreak: 'break-all',
          }}
        >
          {address}
        </div>
      </Section>
      {memo && (
        <Section title="Memo">
          <div style={{ fontSize: 13, color: 'var(--smirk-fg)' }}>{memo}</div>
        </Section>
      )}
    </div>
  );
}

function ClaimTipBody() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Claim public tip?
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        The site found a Smirk tip address shared with you and is
        offering to deposit it into your wallet.
      </p>
    </div>
  );
}

function NostrGrantBody({
  perOrigin,
  onToggle,
}: {
  perOrigin: boolean;
  onToggle: (v: boolean) => void;
}) {
  const optStyle = (selected: boolean) =>
    ({
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
      textAlign: 'left' as const,
      padding: '10px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      border: `1px solid ${selected ? 'var(--smirk-accent)' : 'var(--smirk-border)'}`,
      background: selected ? 'var(--smirk-bg-elevated, rgba(255,255,255,0.04))' : 'transparent',
      color: 'inherit',
      font: 'inherit',
    }) as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Share your Nostr identity?
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        The site is requesting your public Nostr key (npub) so it can recognize
        you. This reveals an identity to the site — it can never move funds.
      </p>
      {/* Say what the scope ACTUALLY grants. It also covers NIP-04/44
          encrypt/decrypt, which runs without a further prompt, so a granted site
          can decrypt any message addressed to this identity. The previous copy
          described identity disclosure only, which understated it. */}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
        It also lets the site encrypt and decrypt messages <em>as</em> this
        identity, without asking again. Use a private identity if you would
        rather it could not read messages sent to your main one.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button type="button" style={optStyle(!perOrigin)} onClick={() => onToggle(false)}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Use my main identity</span>
          <span style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
            The site sees your primary npub — recognizable across sites.
          </span>
        </button>
        <button type="button" style={optStyle(perOrigin)} onClick={() => onToggle(true)}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Use a private identity for this site</span>
          <span style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
            A fresh npub only this site sees — unlinkable to your main identity.
          </span>
        </button>
      </div>
    </div>
  );
}

/** Human summary of an unsigned Nostr event for the sign prompt. */
function nostrEventSummary(event: { kind: number; tags: string[][] }): {
  title: string;
  detail: string;
} {
  if (event.kind === 27235) {
    const u = event.tags.find((t) => t[0] === 'u')?.[1];
    let host = 'this site';
    try {
      if (u) host = new URL(u).host;
    } catch {
      // keep the fallback
    }
    return {
      title: 'Sign in with Nostr?',
      detail: `Prove your identity to ${host}. This is a login credential — it moves no funds.`,
    };
  }
  if (event.kind === 1) {
    return {
      title: 'Publish a note?',
      detail: 'The site will publish this note to Nostr as you.',
    };
  }
  return {
    title: 'Sign a Nostr event?',
    detail: `The site wants a signature over a kind-${event.kind} Nostr event.`,
  };
}

function SignNostrEventBody({
  event,
  tier,
  grantForSession,
  onToggleGrant,
}: {
  event: { kind: number; content: string; tags: string[][] };
  tier: 'money' | 'session-grantable' | 'default';
  grantForSession: boolean;
  onToggleGrant: (v: boolean) => void;
}) {
  const { title, detail } = nostrEventSummary(event);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        {detail}
      </p>
      {tier === 'money' ? (
        <div
          role="alert"
          style={{
            padding: 10,
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.4,
            color: 'var(--smirk-fg)',
            background: 'var(--smirk-negative-bg, rgba(255,107,107,0.12))',
            border: '1px solid var(--smirk-negative, #ff6b6b)',
          }}
        >
          ⚠️ This is a value / authorization signature (payment, listing, or login).
          It's signed once, right now — Smirk will never auto-sign these.
        </div>
      ) : null}
      {tier === 'session-grantable' ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={grantForSession}
            onChange={(e) => onToggleGrant((e.target as HTMLInputElement).checked)}
          />
          Allow this site to sign events like this for the next hour without asking
        </label>
      ) : null}
      {event.content ? (
        <Section title="Content">
          <pre
            style={{
              margin: 0,
              padding: 12,
              background: 'var(--smirk-bg-sunken)',
              color: 'var(--smirk-fg)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 8,
              fontSize: 12,
              fontFamily:
                'var(--smirk-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              maxHeight: 200,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {event.content}
          </pre>
        </Section>
      ) : null}
    </div>
  );
}

function AppEncKeyBody({ firstGrant, context }: { firstGrant: boolean; context: string }) {
  // Re-derive under an existing grant: the screen auto-approves before the user
  // reads this, so keep it to a quiet status line.
  if (!firstGrant) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        Providing this site's encryption key…
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--smirk-fg)' }}>
        Allow private storage?
      </h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
        The site wants an encryption key derived from your wallet so it can store
        data that only you can read — the server can't. The key is unique to this
        site{context ? ` (“${context}”)` : ''} and unrelated to your identity or
        funds; your wallet never hands out the private half.
      </p>
    </div>
  );
}

function AppSealOpenBody() {
  // Always auto-approves; shown only briefly (or if a decrypt error surfaces).
  return (
    <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
      Decrypting this site's data…
    </p>
  );
}

function NostrCryptBody({ op }: { op: 'encrypt' | 'decrypt' }) {
  // Auto-approves (NIP-07 DM crypto under the granted Nostr scope); shown briefly.
  return (
    <p style={{ margin: 0, fontSize: 13, color: 'var(--smirk-fg-muted)' }}>
      {op === 'encrypt' ? 'Encrypting a message…' : 'Decrypting a message…'}
    </p>
  );
}

function AssetChip({ asset }: { asset: ApprovalAsset }) {
  // Use the accent color for asset chips so they stay high-contrast
  // against every theme background (light, dark, retro). Do NOT use
  // `--smirk-surface-2`: it is not a real token, so it falls back to
  // grey with inherited foreground, which renders light-grey-on-white
  // on light themes and grey-on-white in the dark Smirk theme.
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        background: 'var(--smirk-accent)',
        color: 'var(--smirk-accent-fg)',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        lineHeight: 1.2,
      }}
    >
      {asset}
    </span>
  );
}

function ApprovalActions({
  request,
  busy,
  onApprove,
  onDeny,
  grantForSession,
  nostrPerOrigin,
}: {
  request: ApprovalRequest;
  busy: boolean;
  onApprove: (a: ApprovalApproval) => void;
  onDeny: () => void;
  grantForSession: boolean;
  nostrPerOrigin: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button variant="secondary" onClick={() => !busy && onDeny()} disabled={busy}>
        {busy ? 'Working…' : 'Deny'}
      </Button>
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          switch (request.kind) {
            case 'connect':
              return onApprove({
                kind: 'connect',
                approvedAssets: request.requestedAssets,
              });
            case 'signMessage':
              return onApprove({ kind: 'signMessage' });
            case 'requestPayment':
              return onApprove({ kind: 'requestPayment' });
            case 'claimPublicTip':
              return onApprove({ kind: 'claimPublicTip' });
            case 'nostrGrant':
              return onApprove({ kind: 'nostrGrant', perOrigin: nostrPerOrigin });
            case 'signNostrEvent':
              return onApprove({
                kind: 'signNostrEvent',
                ...(grantForSession && request.tier === 'session-grantable'
                  ? {
                      grantSession: {
                        kinds: [request.event.kind],
                        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
                      },
                    }
                  : {}),
              });
            case 'appEncKey':
              return onApprove({ kind: 'appEncKey' });
            case 'appSealOpen':
              return onApprove({ kind: 'appSealOpen' });
            case 'nostrCrypt':
              return onApprove({ kind: 'nostrCrypt' });
          }
        }}
      >
        {busy ? 'Working…' : 'Approve'}
      </Button>
    </div>
  );
}
