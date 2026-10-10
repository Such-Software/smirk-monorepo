export interface FrameSurface {
  /** Why the frame must be a redaction card, or null. Names a kind, never content. */
  card: string | null;
  /** Visible elements covered by a mask, by test id or tag. */
  masked: string[];
  /** Visible text outside the masks. In memory only; never written or printed. */
  text: string;
  /** Visible input values outside the masks. In memory only. */
  values: string[];
}
export interface CardPatterns {
  testId: string;
  keyText: string;
  tipLink: string;
}
export const MASK_SELECTORS: readonly string[];
export const CARD_PATTERNS: Readonly<CardPatterns>;
export function frameSurface(input: { masks: readonly string[]; patterns: CardPatterns }): FrameSurface;
export function assertStaticLabel(label: string): string;
export class Canary {
  addPhrase(words: readonly string[]): void;
  addLiteral(value: string, publicParts?: readonly string[]): void;
  hit(surface: Pick<FrameSurface, 'text' | 'values'>): boolean;
}
