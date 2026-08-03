/**
 * AssetIcon: chain logo, sized + accessibility-labeled from the registry.
 *
 * Resolves the actual image path via a consumer-supplied resolver: icon
 * assets live in the consumer package (extension / mobile / desktop), not
 * here, so the same component renders against whichever asset folder the
 * host wraps it with. Falls back to a circle with the ticker text.
 *
 * @example
 * ```tsx
 * import { AssetIcon } from '@smirk/ui';
 * import iconUrlFor from './icons';   // consumer-supplied
 *
 * <AssetIcon assetId="btc" size={32} resolveIcon={iconUrlFor} />
 * ```
 */

import { mustGetAsset } from '@smirk/assets';

export interface AssetIconProps {
  /** Asset id, e.g. `"btc"`. Must be registered in `@smirk/assets`. */
  assetId: string;
  /** Pixel size (square). */
  size?: number;
  /**
   * Resolver from `iconKey` to an image URL. The ui package doesn't
   * bundle icon assets; consumer wires this up against its own
   * icons folder.
   */
  resolveIcon?: (iconKey: string) => string | undefined;
  /** Extra class names for styling hooks. */
  class?: string;
}

export function AssetIcon({
  assetId,
  size = 24,
  resolveIcon,
  class: className,
}: AssetIconProps) {
  const asset = mustGetAsset(assetId);
  const url = resolveIcon?.(asset.iconKey);

  if (url) {
    return (
      <img
        src={url}
        alt={asset.displayName}
        width={size}
        height={size}
        class={className}
      />
    );
  }

  // Fallback: circular badge with ticker text. Better than a broken
  // image and still works in tests / storybook without icon plumbing.
  return (
    <span
      class={className}
      role="img"
      aria-label={asset.displayName}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.1)',
        fontSize: Math.max(8, Math.floor(size / 3)),
        fontWeight: 600,
        letterSpacing: '0.5px',
      }}
    >
      {asset.ticker}
    </span>
  );
}
