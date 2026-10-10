/** Types for guard.mjs, so the TypeScript live lane can import it. */
export const PRIVATE_TEXT: Readonly<{
  testId: string;
  text: string;
  allowedButton: string;
  allowedEmptyInput: string;
}>;
export function secretSurface(patterns: typeof PRIVATE_TEXT): string | null;

export const LIVE_MASK_ATTRIBUTE: 'data-e2e-mask';

export interface LiveRules {
  readonly cardTestId: string;
  readonly cardText: string;
  readonly cardLabelText: string;
  readonly maskTestId: string;
  readonly maskFilledTestId: string;
  readonly maskFieldTestId: string;
  readonly claimLinkText: string;
  readonly maskSelectors: readonly string[];
  readonly protectedTestId: string;
  readonly allowedControl: string;
  readonly allowedStatus: string;
  readonly allowedEmptyInput: string;
}
export const LIVE_RULES: LiveRules;

/** Rule labels only; `text` and `values` stay inside the recording process. */
export interface LiveFrameVerdict {
  mode: 'clean' | 'mask' | 'card';
  reasons: string[];
  masks: number;
  text: string;
  values: string[];
}
export function liveFrameVerdict(rules: LiveRules): LiveFrameVerdict;

export const LIVE_CARD_CAPTIONS: Readonly<Record<string, string>>;

export interface SecretCanary {
  addSecret(value: string): void;
  addPhrase(words: readonly string[]): void;
  hit(sample: { text?: string; values?: readonly string[] }): boolean;
  readonly size: number;
}
export function createSecretCanary(): SecretCanary;
