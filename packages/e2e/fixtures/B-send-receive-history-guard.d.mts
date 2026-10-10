export interface GuardPatterns {
  testId: string;
  text: string;
  allowedButton: string;
  allowedEmptyInput: string;
}
export interface ExtraPatterns {
  selectors: readonly string[];
  text: string;
}
export const B_PATTERNS: Readonly<GuardPatterns>;
export const B_EXTRA: Readonly<ExtraPatterns>;
export const MASK_SELECTORS: readonly string[];
export function secretSurface(patterns: GuardPatterns): string | null;
export function extraSecretSurface(extra: ExtraPatterns): string | null;
export function canarySnapshot(): { text: string; values: string[] };
