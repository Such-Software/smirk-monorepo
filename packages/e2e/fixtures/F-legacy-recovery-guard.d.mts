export interface FrameGuardPatterns {
  readonly cardTestId: string;
  readonly privateText: string;
  readonly mask: ReadonlyArray<readonly [string, string]>;
  readonly maskWhenFilled: ReadonlyArray<readonly [string, string]>;
  readonly claimLinkText: string;
}
export interface FrameVerdict {
  kind: 'clean' | 'mask' | 'card';
  reasons: string[];
}
/** What the in-page half returns: a structural verdict plus texts for the Node-side canary. */
export interface RawFrameVerdict extends FrameVerdict {
  texts: string[];
  protocol: string;
}
export interface Canary {
  addPhrase(words: readonly string[]): void;
  addToken(value: string): void;
  size(): number;
  hit(texts: readonly string[]): boolean;
}
export const FRAME_GUARD_PATTERNS: FrameGuardPatterns;
export const RECORDABLE_PROTOCOL: string;
export function maskSelectors(patterns?: FrameGuardPatterns): string[];
export function canaryUnits(text: string): string[];
export function createCanary(): Canary;
export function classifyFrame(args: { patterns: FrameGuardPatterns }): Promise<RawFrameVerdict>;
export function finalVerdict(raw: RawFrameVerdict, canary: Pick<Canary, 'hit'> | null): FrameVerdict;
