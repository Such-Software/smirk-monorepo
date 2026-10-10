export type HoldKind = 'tap' | 'type' | 'settled' | 'result';
export interface PolicyHold {
  kind: HoldKind | string;
  label: string;
  from: number;
  until: number;
  requiredMs: number;
  beforeAutoClose?: boolean;
}
export const HOLD: Readonly<{ preTapMs: number; settledMs: number; resultMs: number }>;
export const HOLD_MIN_MS: Readonly<Record<HoldKind, number>>;
export const AUTO_CLOSE_TAPS: readonly string[];
export function holdRefusals(timeline: { holds?: readonly PolicyHold[]; stoppedAt?: number | null }): string[];
