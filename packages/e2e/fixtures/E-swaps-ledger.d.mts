export interface InflightEntry {
  wallet: string;
  runId: string;
  phase: 'sending' | 'broadcast';
  since: string;
  txid?: string;
}
export function swapKey(provider: string, from: string, to: string): string;
export class InflightLedger {
  constructor(file: string);
  open(key: string): InflightEntry | null;
  refusal(key: string): string | null;
  begin(key: string, entry: { wallet: string; runId: string }): void;
  broadcast(key: string, txid: string): void;
  finish(key: string): void;
  clear(keys: readonly string[]): Array<InflightEntry & { key: string }>;
}
