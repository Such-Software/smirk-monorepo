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
export function maskSelectorFor(nonce: string): string;

export interface CTipsSurveyInput {
  rules: CTipsRules;
  nonce: string | null;
  mode: 'scan' | 'mark' | 'verify';
}
export type CTipsSurvey =
  | { card: 'phrase'; masked: 0; unmarked: 0; signature: ''; segments: string[] }
  | { card: null; masked: number; unmarked: number; signature: string; segments: string[] };
export function cTipsSurvey(input: CTipsSurveyInput): CTipsSurvey;

export interface KnownSecrets {
  exact?: readonly string[];
  phraseWords?: readonly string[];
}
export function findLeak(segments: readonly string[], secrets?: KnownSecrets): string | null;
export function assertStaticLabel(label: string): string;
