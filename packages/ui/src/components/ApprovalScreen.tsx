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

import { useState } from 'preact/hooks';
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
  | { kind: 'claimPublicTip' };

export function ApprovalScreen({
  request,
  onApprove,
  onDeny,
  formatAmount,
}: ApprovalScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <ApprovalBody request={request} {...(formatAmount ? { formatAmount } : {})} />
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
}: {
  request: ApprovalRequest;
  formatAmount?: (asset: string, atomic: string) => string;
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

function AssetChip({ asset }: { asset: ApprovalAsset }) {
  // Use the accent color for asset chips so they're high-contrast
  // against every theme background (light, dark, retro). Earlier
  // version used `--smirk-surface-2` (no such token → grey fallback)
  // with inherited foreground — rendered light-grey-on-white text on
  // light themes and grey-on-white in the dark Smirk theme, which
  // is exactly the bad-contrast state shown in the bug screenshot.
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
}: {
  request: ApprovalRequest;
  busy: boolean;
  onApprove: (a: ApprovalApproval) => void;
  onDeny: () => void;
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
          }
        }}
      >
        {busy ? 'Working…' : 'Approve'}
      </Button>
    </div>
  );
}
