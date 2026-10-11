/** Types for hold-timer.mjs, so the TypeScript recorders can import it. */
export const HOLD_TOLERANCE_MS: number;
export function heldLongEnough(measuredMs: number, policyMs: number, toleranceMs?: number): boolean;
export function sleepAtLeast(ms: number, clock?: { now(): number; mono(): number; wait(ms: number): Promise<void> }): Promise<number>;
