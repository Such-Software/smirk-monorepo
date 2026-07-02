/**
 * ReceiveScreen — pick asset, show address + QR.
 *
 * Mirrors SendWizard's first step (asset picker), then drops directly
 * into the receive surface. No persistence needed — receive is
 * stateless from the wallet's POV (the address is whatever the registry
 * says about this asset's current receive address).
 *
 * QR rendering is injected — `@smirk/ui` doesn't bundle a QR library,
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
 *   onCopy={(text) => navigator.clipboard.writeText(text)}
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
  /** Copy-to-clipboard handler — platform-specific (extension vs mobile). */
  onCopy?: (text: string) => void;
  /** Exit the screen (back to Home). */
  onExit: () => void;
  /** Pre-select an asset (skip the picker step). */
  initialAssetId?: string;
  /** Icon resolver passed through to AssetIcon. */
  resolveIcon?: (iconKey: string) => string | undefined;
  /**
   * Optional: surface a "Request specific amount" affordance below the
   * address for assets that support it. Currently only Grin's
   * interactive invoice flow uses this — the shell routes to a
   * dedicated request wizard when invoked.
   */
  onRequestInvoice?: (assetId: string) => void;
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
}: {
  assetId: string;
  resolveAddress: (assetId: string) => Promise<string> | string;
  onRequestInvoice?: (assetId: string) => void;
  renderQr?: (data: string) => ComponentChildren;
  onCopy?: (text: string) => void;
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  const asset = mustGetAsset(assetId);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
  }, [assetId, resolveAddress]);

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
