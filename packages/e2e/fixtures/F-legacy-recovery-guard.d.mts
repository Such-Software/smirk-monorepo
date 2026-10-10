export interface FrameGuardPatterns {
  readonly cardTestId: string;
  readonly privateText: string;
  readonly mask: ReadonlyArray<readonly [string, string]>;
  readonly maskWhenFilled: ReadonlyArray<readonly [string, string]>;
  readonly claimLinkText: string;
}
export interface PageCanary {
  keyHex: string;
  digests: string[];
}
export interface FrameVerdict {
  kind: 'clean' | 'mask' | 'card';
  reasons: string[];
}
export interface Canary {
  addPhrase(words: readonly string[]): void;
  addToken(value: string): void;
  size(): number;
  forPage(): PageCanary;
}
export const FRAME_GUARD_PATTERNS: FrameGuardPatterns;
export function maskSelectors(patterns?: FrameGuardPatterns): string[];
export function canaryUnits(text: string): string[];
export function createCanary(): Canary;
export function classifyFrame(args: { patterns: FrameGuardPatterns; canary: PageCanary | null }): Promise<FrameVerdict>;
