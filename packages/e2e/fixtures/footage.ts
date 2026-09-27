/** Compatibility for existing scenario markers. Wallet tests retain no footage. */
export class Footage {
  // Names and notes are deliberately not retained: callers may include dynamic
  // UI text or URLs. A new capture lane needs a separate secret-free fixture.
  mark(_name: string, _note?: string): void {}
}
