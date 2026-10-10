export interface StrictGuardPatterns {
  testId: string;
  text: string;
  allowedButton: string;
  allowedEmptyInput: string;
}
export const PRIVATE_TEXT: StrictGuardPatterns;
export function secretSurface(patterns: StrictGuardPatterns): string | null;

export const TIP_LINK_SOURCE: string;
export interface CTipsRules {
  readonly cardTestId: string;
  readonly maskSelectors: readonly string[];
  readonly maskWhenFilled: readonly string[];
  readonly tipLink: string;
  readonly markAttribute: string;
}
export const C_TIPS_RULES: CTipsRules;
export const MASK_SELECTOR: string;

export type CTipsSurvey =
  | { card: 'phrase'; masked: 0; segments: string[] }
  | { card: null; masked: number; signature: string; segments: string[] };
export function cTipsSurvey(rules: CTipsRules): CTipsSurvey;

export interface KnownSecrets {
  exact?: readonly string[];
  phraseWords?: readonly string[];
}
export function findLeak(segments: readonly string[], secrets?: KnownSecrets): string | null;
export function assertStaticLabel(label: string): string;
