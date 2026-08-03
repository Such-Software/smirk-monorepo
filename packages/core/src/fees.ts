/**
 * BTC/LTC relay-fee floor — one source of truth for every broadcast path.
 *
 * Electrum fee estimates can return rates (e.g. 1.0 sat/vB) that sit at
 * or below the network's effective minimum relay fee. A tx built at the
 * raw estimate is then rejected by every node with "transaction was
 * rejected by network rules", and (since Smirk relies on external
 * Electrum servers, not its own BTC/LTC nodes) there's no fallback.
 *
 * So EVERY BTC/LTC broadcast path must clamp the chosen sat/vB rate to
 * this floor before building the tx:
 *   - SendWizard (display + submit)        — packages/ui
 *   - send() / sendBtcLtc                   — send-handler.ts
 *   - tip funding                           — tip-handler.ts (via send)
 *   - dapp approval send                    — execute-approval.ts (via send)
 *   - tip claim sweep (sweepUtxo)           — tip-claim-handler.ts
 *
 * A 1.0 sat/vB estimate is what gets rejected in practice, so the floor
 * sits just above it. The tip-funding and sweep paths are the ones that
 * broadcast unfloored before this constant existed.
 */
export const RELAY_FLOOR_SAT_PER_VB = 1.1;

/**
 * Last-resort BTC/LTC fee rate (sat/vB) for when the backend cannot estimate at
 * all (fee endpoint down / unreachable / contract error). Deliberately on the
 * higher side so a rare fallback tx still confirms rather than sticking in the
 * mempool; the primary path is always the live estimate. Every fee-dependent
 * BTC/LTC flow degrades to THIS one constant instead of the ad-hoc `?? 10` /
 * `?? 1` literals that used to diverge across the send / tip / sweep paths.
 */
export const DEFAULT_FALLBACK_FEE_SAT_PER_VB = 10;

/** Clamp a sat/vB fee rate up to the BTC/LTC relay floor. */
export function applyRelayFloor(rate: number): number {
  return Math.max(rate, RELAY_FLOOR_SAT_PER_VB);
}

/**
 * Resolve a usable normal-tier sat/vB rate, always relay-floored, degrading to
 * `DEFAULT_FALLBACK_FEE_SAT_PER_VB` when the estimate is missing or non-positive.
 * Never returns null, so a fee-endpoint hiccup can never disable a send or
 * hard-fail a tip: the flow proceeds at a safe fallback rate instead.
 */
export function resolveFeeRateOrFallback(rate: number | null | undefined): number {
  return applyRelayFloor(
    typeof rate === 'number' && Number.isFinite(rate) && rate > 0
      ? rate
      : DEFAULT_FALLBACK_FEE_SAT_PER_VB,
  );
}

/**
 * A full fast/normal/slow tier set to fall back to when the fee estimate is
 * unavailable, so the Send UI can still offer a rate (and stay enabled) instead
 * of blocking the user. All tiers are relay-floored.
 */
export function fallbackFeeTiers(): { fast: number; normal: number; slow: number } {
  const n = DEFAULT_FALLBACK_FEE_SAT_PER_VB;
  return {
    fast: applyRelayFloor(Math.ceil(n * 1.5)),
    normal: applyRelayFloor(n),
    slow: applyRelayFloor(Math.max(RELAY_FLOOR_SAT_PER_VB, Math.floor(n * 0.6))),
  };
}
