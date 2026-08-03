/**
 * Asset-aware formatting helpers.
 *
 * All amount math takes atomic units (the integer value the chain
 * represents internally) and renders against the registry's `decimals`
 * field. No floating-point math on consensus-critical values.
 */

import { type AssetDefinition, registry } from '@smirk/assets';

/**
 * Format an atomic-unit amount as a human-readable display string.
 *
 * @param amountAtomic Atomic units (sats, piconero, atomic-WOW, nanogrin).
 * @param assetId The registered asset id (`"btc"`, `"xmr"`, ...).
 * @param maxFractionalDigits Cap on trailing decimals shown; defaults to
 *   the asset's full precision but the UI will usually pass 6 or 8 to
 *   keep the display compact.
 *
 * Trailing zeros are trimmed. Whole-number amounts render without a
 * decimal point (`"5 BTC"` not `"5.00000000 BTC"`).
 */
export function formatAmount(
  amountAtomic: bigint | number,
  assetId: string,
  maxFractionalDigits?: number,
): string {
  const def = registry.mustGet(assetId);
  return formatAmountWithAsset(amountAtomic, def, maxFractionalDigits);
}

/** Variant for callers that already have the AssetDefinition in hand. */
export function formatAmountWithAsset(
  amountAtomic: bigint | number,
  asset: AssetDefinition,
  maxFractionalDigits?: number,
  options?: { trimZeros?: boolean },
): string {
  const decimals = asset.decimals;
  const cap = Math.min(decimals, maxFractionalDigits ?? decimals);
  const trimZeros = options?.trimZeros ?? true;

  const big =
    typeof amountAtomic === 'bigint' ? amountAtomic : BigInt(Math.trunc(amountAtomic));
  const negative = big < 0n;
  const abs = negative ? -big : big;

  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;

  if (cap === 0) {
    return (negative ? '-' : '') + whole.toString();
  }
  if (frac === 0n && trimZeros) {
    return (negative ? '-' : '') + whole.toString();
  }

  // Render fractional part with leading zeros, then trim to `cap` digits.
  // Optionally strip trailing zeros (default true: typical "0.5" rather
  // than "0.50000000"). Pass `trimZeros: false` for balance displays
  // where the user wants to see the dust, à la Sparrow / Bitcoin Core.
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, cap);
  if (trimZeros) {
    fracStr = fracStr.replace(/0+$/, '');
  }

  if (fracStr === '') {
    return (negative ? '-' : '') + whole.toString();
  }

  return (negative ? '-' : '') + `${whole.toString()}.${fracStr}`;
}

/**
 * Compose `{amount} {ticker}` for an asset, e.g. `"0.005 BTC"`.
 */
export function formatAmountWithTicker(
  amountAtomic: bigint | number,
  assetId: string,
  maxFractionalDigits?: number,
): string {
  const def = registry.mustGet(assetId);
  return `${formatAmountWithAsset(amountAtomic, def, maxFractionalDigits)} ${def.ticker}`;
}
