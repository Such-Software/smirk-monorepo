import { formatApproximateUsd } from '../format';

/** Display only. Fiat estimates never enter transaction construction. */
export function UsdEstimate({ amount, assetId, price, testid }: {
  amount: bigint | null;
  assetId: string;
  price: number | null | undefined;
  testid: string;
}) {
  if (amount === null || amount <= 0n) return null;
  const estimate = formatApproximateUsd(amount, assetId, price);
  return <div data-testid={testid} aria-live="polite" style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
    {estimate ?? 'USD estimate unavailable'}
  </div>;
}
