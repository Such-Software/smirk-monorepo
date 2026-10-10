export type FrameVerdictKind = 'clean' | 'masked' | 'card';

export interface PremiumGuardPatterns {
  readonly card: string;
  readonly keyText: string;
  readonly mask: string;
  readonly claimText: string;
}

export interface FrameVerdict {
  verdict: FrameVerdictKind;
  /** Kind of surface only, never its content. */
  reason: string;
  /** A visible protected input holds a value. */
  filledSecret: boolean;
  /** Visible page text, for the in-memory canary only. Never persisted. */
  text: string;
  /** Visible non-password input values, for the canary only. Never persisted. */
  values: string[];
}

export const PREMIUM_GUARD: PremiumGuardPatterns;
export const MASK_SELECTORS: readonly string[];
export function frameVerdict(patterns: PremiumGuardPatterns): FrameVerdict;
