/**
 * ReceiveScreen: pick asset, show address + QR.
 *
 * Mirrors SendWizard's first step (asset picker), then drops directly
 * into the receive surface. No persistence needed: receive is
 * stateless from the wallet's POV (the address is whatever the registry
 * says about this asset's current receive address).
 *
 * QR rendering is injected: `@smirk/ui` doesn't bundle a QR library,
 * so consumers wire in their own (qrcode-svg, qrcode.react, etc.) via
 * the `renderQr` prop. When omitted, the address shows as text only.
 *
 * Address resolution is also injected: the consumer (extension) knows
 * how to ask its key-derivation layer for the right address per asset.
 *
 * @example
 * ```tsx
 * <ReceiveScreen
 *   assetIds={['btc', 'ltc', 'xmr', 'wow', 'grin']}
 *   resolveAddress={async (id) => walletGetReceiveAddress(id)}
 *   renderQr={(data) => <QRCode value={data} />}
 *   onCopy={(text) => void copyText(text).catch(() => undefined)}
 *   onExit={() => router.back()}
 * />
 * ```
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { ActionButton } from './ActionButton';
import { AssetIcon } from './AssetIcon';

export interface ReceiveScreenProps {
  /** Asset ids the user can receive into, in display order. */
  assetIds: string[];
  /**
   * Resolve the receive address for an asset. Async to allow
   * key-derivation work or fresh-subaddress generation.
   */
  resolveAddress: (assetId: string) => Promise<string> | string;
  /** Optional: how to render a QR code for the given payload string. */
  renderQr?: (data: string) => ComponentChildren;
  /** Copy-to-clipboard handler: platform-specific (extension vs mobile). */
  onCopy?: (text: string) => void;
  /** Exit the screen (back to Home). */
  onExit: () => void;
  /** Pre-select an asset (skip the picker step). */
  initialAssetId?: string;
  /** Icon resolver passed through to AssetIcon. */
  resolveIcon?: (iconKey: string) => string | undefined;
  /**
   * The account's Smirk handle (`name@domain`), when a username is claimed.
   * Shown as the human identity above the raw per-asset address. Send-by-handle
   * across chains lands once the resolver ships.
   */
  handle?: string;
  /**
   * Optional: surface a "Request specific amount" affordance below the
   * address for assets that support it. Currently only Grin's
   * interactive invoice flow uses this; the shell routes to a
   * dedicated request wizard when invoked.
   */
  onRequestInvoice?: (assetId: string) => void;
  /**
   * Whether the "New address" affordance applies to this asset. Per-asset
   * because the picker choice is made inside this component, so the shell
   * cannot decide up front. Only XMR/WOW answer true today, and only with the
   * `ENABLE_SUBADDRESS_RECEIVE` client flag on; every other asset (and the
   * default flag-off build) never renders the button.
   */
  canIssueNewAddress?: (assetId: string) => boolean;
  /**
   * Issue a FRESH receive address and return it. This is the only path that
   * advances the wallet's issuance counter, which is why it is an explicit
   * user action: `resolveAddress` re-runs on every render and must stay a pure
   * read. Rejecting is expected and surfaced inline (e.g. the server has not
   * provisioned the next index yet); the displayed address is left untouched.
   */
  onNewAddress?: (assetId: string) => Promise<string>;
  /**
   * Optional: the asset's PRIMARY address. When it differs from the address on
   * screen, an "advanced" disclosure lets the user reach it: a subaddress is
   * an alias for the same account, and some counterparties (exchanges, older
   * tooling) still want the primary. Return `null` for assets that have no
   * separate primary (the disclosure is then never rendered, and the shell does
   * no derivation work on a screen that re-renders often).
   */
  resolvePrimaryAddress?: (assetId: string) => Promise<string | null> | string | null;
  class?: string;
}

export function ReceiveScreen(props: ReceiveScreenProps) {
  const [pickedAssetId, setPickedAssetId] = useState<string | null>(
    props.initialAssetId ?? null,
  );

  return (
    <div class={props.class} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <button
          onClick={pickedAssetId && !props.initialAssetId ? () => setPickedAssetId(null) : props.onExit}
          aria-label={pickedAssetId && !props.initialAssetId ? 'Back' : 'Cancel'}
          style={iconButtonStyle}
        >
          {pickedAssetId && !props.initialAssetId ? '‹ Back' : 'Cancel'}
        </button>
        <span style={{ opacity: 0.5 }}>{pickedAssetId ? 'Receive' : 'Choose asset'}</span>
        <span style={{ width: 60 }} />
      </header>

      {props.handle && (
        <button
          data-testid="receive-handle"
          onClick={props.onCopy ? () => props.onCopy?.(props.handle as string) : undefined}
          style={{
            textAlign: 'left',
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(245,197,66,0.10)',
            border: '1px solid rgba(245,197,66,0.35)',
            color: 'inherit',
            cursor: props.onCopy ? 'pointer' : 'default',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ fontSize: 11, opacity: 0.6 }}>Your Smirk handle{props.onCopy ? ' (tap to copy)' : ''}</span>
          <span style={{ fontSize: 15, fontWeight: 700, wordBreak: 'break-all' }}>{props.handle}</span>
        </button>
      )}

      {!pickedAssetId ? (
        <PickAsset
          assetIds={props.assetIds}
          onPick={setPickedAssetId}
          {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
        />
      ) : (
        <ShowAddress
          assetId={pickedAssetId}
          resolveAddress={props.resolveAddress}
          {...(props.renderQr ? { renderQr: props.renderQr } : {})}
          {...(props.onCopy ? { onCopy: props.onCopy } : {})}
          {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
          {...(props.onRequestInvoice
            ? { onRequestInvoice: props.onRequestInvoice }
            : {})}
          {...(props.canIssueNewAddress
            ? { canIssueNewAddress: props.canIssueNewAddress }
            : {})}
          {...(props.onNewAddress ? { onNewAddress: props.onNewAddress } : {})}
          {...(props.resolvePrimaryAddress
            ? { resolvePrimaryAddress: props.resolvePrimaryAddress }
            : {})}
        />
      )}
    </div>
  );
}

function PickAsset({
  assetIds,
  onPick,
  resolveIcon,
}: {
  assetIds: string[];
  onPick: (id: string) => void;
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {assetIds.map((id) => {
        const asset = mustGetAsset(id);
        return (
          <button
            key={id}
            data-testid={`receive-asset-${id}`}
            onClick={() => onPick(id)}
            style={rowButtonStyle()}
          >
            <AssetIcon assetId={id} size={32} {...(resolveIcon ? { resolveIcon } : {})} />
            <span style={{ marginLeft: 12, flex: 1, textAlign: 'left' }}>
              <div style={{ fontWeight: 600 }}>{asset.ticker}</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>{asset.displayName}</div>
            </span>
            <span style={{ fontSize: 18, opacity: 0.4 }}>›</span>
          </button>
        );
      })}
    </div>
  );
}

function ShowAddress({
  assetId,
  resolveAddress,
  renderQr,
  onCopy,
  resolveIcon,
  onRequestInvoice,
  canIssueNewAddress,
  onNewAddress,
  resolvePrimaryAddress,
}: {
  assetId: string;
  resolveAddress: (assetId: string) => Promise<string> | string;
  onRequestInvoice?: (assetId: string) => void;
  renderQr?: (data: string) => ComponentChildren;
  onCopy?: (text: string) => void;
  resolveIcon?: (iconKey: string) => string | undefined;
  canIssueNewAddress?: (assetId: string) => boolean;
  onNewAddress?: (assetId: string) => Promise<string>;
  resolvePrimaryAddress?: (assetId: string) => Promise<string | null> | string | null;
}) {
  const asset = mustGetAsset(assetId);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  // These three are KEYED BY ASSET rather than reset from an effect. The
  // `resolve*` props are inline closures in the shell, so their identity changes
  // on every parent render (a balance poll, a session tick); an effect that
  // cleared them would snap the disclosure shut and blank the error at random.
  // Keying makes them self-invalidate when the user switches asset, with no
  // effect involved.
  const [primaryFor, setPrimaryFor] = useState<{ assetId: string; address: string } | null>(null);
  const [showPrimaryFor, setShowPrimaryFor] = useState<string | null>(null);
  const [issueErrorFor, setIssueErrorFor] = useState<{ assetId: string; message: string } | null>(
    null,
  );
  const primary = primaryFor?.assetId === assetId ? primaryFor.address : null;
  const showPrimary = showPrimaryFor === assetId;
  const issueError = issueErrorFor?.assetId === assetId ? issueErrorFor.message : null;
  // Bumped by "New address" so the resolver re-reads the (now advanced)
  // counter. `resolveAddress` is a pure read, so re-running it is free and
  // cannot itself hand out another address.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAddress(null);
    setError(null);
    Promise.resolve(resolveAddress(assetId))
      .then((addr) => {
        if (!cancelled) setAddress(addr);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load address');
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, resolveAddress, reloadNonce]);

  // Primary address, resolved alongside. Only used to decide whether to offer
  // the advanced disclosure; a failure here is silent (it must never block the
  // receive address itself from rendering).
  useEffect(() => {
    if (!resolvePrimaryAddress) return undefined;
    let cancelled = false;
    Promise.resolve(resolvePrimaryAddress(assetId))
      .then((addr) => {
        if (!cancelled && addr) setPrimaryFor({ assetId, address: addr });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [assetId, resolvePrimaryAddress]);

  const canIssue = !!onNewAddress && !!canIssueNewAddress?.(assetId);

  const handleNewAddress = () => {
    if (!onNewAddress || issuing) return;
    setIssuing(true);
    setIssueErrorFor(null);
    onNewAddress(assetId)
      .then((addr) => {
        setAddress(addr);
        // Re-sync from the counter too, so the screen matches persisted state
        // even if the shell derived the string a different way.
        setReloadNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        // Keep showing the current address: a refused issuance means the next
        // index is not safe to hand out, not that the current one went bad.
        setIssueErrorFor({
          assetId,
          message: e instanceof Error ? e.message : 'Could not get a new address',
        });
      })
      .finally(() => setIssuing(false));
  };

  const handleCopy = () => {
    if (!address || !onCopy) return;
    onCopy(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AssetIcon assetId={assetId} size={28} {...(resolveIcon ? { resolveIcon } : {})} />
        <span style={{ fontWeight: 600, fontSize: 16 }}>{asset.displayName}</span>
      </div>

      {error ? (
        <div style={{ color: '#ff6b6b', padding: '12px 0' }}>{error}</div>
      ) : !address ? (
        <div style={{ opacity: 0.6, padding: '40px 0' }}>Loading address…</div>
      ) : (
        <>
          {renderQr && (
            <div
              style={{
                background: '#fff',
                padding: 12,
                borderRadius: 8,
                lineHeight: 0,
              }}
            >
              {renderQr(address)}
            </div>
          )}

          <div
            data-testid="receive-address"
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              wordBreak: 'break-all',
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              width: '100%',
              boxSizing: 'border-box',
              textAlign: 'center',
            }}
          >
            {address}
          </div>

          {onCopy && (
            <ActionButton
              testid="receive-copy-btn"
              label={copied ? 'Copied' : 'Copy address'}
              icon={copied ? '✓' : '📋'}
              onClick={handleCopy}
            />
          )}

          {canIssue && (
            <ActionButton
              testid="receive-new-address-btn"
              label={issuing ? 'Getting a new address…' : 'New address'}
              icon="🔄"
              onClick={handleNewAddress}
            />
          )}

          {issueError && (
            <div
              data-testid="receive-new-address-error"
              style={{ color: '#ff6b6b', fontSize: 11, textAlign: 'center' }}
            >
              {issueError}
            </div>
          )}

          {primary && primary !== address && (
            <div style={{ width: '100%' }}>
              <button
                data-testid="receive-toggle-primary"
                onClick={() => setShowPrimaryFor(showPrimary ? null : assetId)}
                style={{
                  ...iconButtonStyle,
                  opacity: 0.6,
                  width: '100%',
                  textAlign: 'center' as const,
                }}
              >
                {showPrimary ? 'Hide primary address' : 'Show primary address'}
              </button>
              {showPrimary && (
                <div
                  data-testid="receive-primary-address"
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    wordBreak: 'break-all',
                    padding: '8px 10px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    boxSizing: 'border-box',
                    textAlign: 'center',
                    opacity: 0.8,
                  }}
                >
                  {primary}
                </div>
              )}
            </div>
          )}

          {onRequestInvoice && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                width: '100%',
                marginTop: 12,
                paddingTop: 12,
                borderTop: '1px solid var(--smirk-border)',
              }}
            >
              <ActionButton
                label="Request specific amount"
                icon="🧾"
                onClick={() => onRequestInvoice(assetId)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const iconButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
} as const;

function rowButtonStyle() {
  return {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: 'inherit',
    cursor: 'pointer',
    padding: '12px 14px',
    borderRadius: 8,
    fontFamily: 'inherit',
    width: '100%',
    textAlign: 'left' as const,
  };
}
