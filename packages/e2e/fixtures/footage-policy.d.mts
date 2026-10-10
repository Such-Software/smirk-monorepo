/** Types for footage-policy.mjs, so the TypeScript recorder can import it. */
export const HOLD_MS: Readonly<{ settled: number; result: number; preTap: number }>;
export type HoldKind = keyof typeof HOLD_MS;
export const POLICY_TOLERANCE_MS: number;

/** The timeline entries the check reads; the recorder writes more kinds. */
export type PolicyEntry =
  | { kind: 'recorder' | 'frame' | 'card' | 'stop'; t: number; recorder: string }
  | { kind: 'hold'; t: number; end: number; hold: HoldKind; label: string; recorder: string | null }
  | { kind: 'tap'; t: number; label: string; recorder: string | null }
  | { kind: string; t: number };

export type PolicyRule = 'tap without a static pause' | 'screen left without a settled hold' | 'hold ended on a changing screen';

export interface PolicyViolation {
  rule: PolicyRule;
  recorder: string;
  label: string;
  t: number;
  /** How long the recording had shown the same frame at that point. */
  staticMs: number;
  requiredMs: number;
}

export interface PolicyReport {
  taps: number;
  holds: number;
  violations: PolicyViolation[];
}

export function checkHoldPolicy(entries: readonly PolicyEntry[], tolerance?: number): PolicyReport;
export function describeViolations(violations: readonly PolicyViolation[]): string;
