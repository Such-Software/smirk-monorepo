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
 * 2026-06-19: introduced after the e2e harness caught LTC public-tip
 * funding failing ("rejected by network rules") while plain sends — the
 * only path that already floored — succeeded. The estimate was 1.0; the
 * unfloored funding/sweep paths broadcast at 1.0 and were rejected.
 */
export const RELAY_FLOOR_SAT_PER_VB = 1.1;

/** Clamp a sat/vB fee rate up to the BTC/LTC relay floor. */
export function applyRelayFloor(rate: number): number {
  return Math.max(rate, RELAY_FLOOR_SAT_PER_VB);
}
