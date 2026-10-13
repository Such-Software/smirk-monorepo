export const TROCADOR_SWAP_DECISION: 'V031_TROCADOR_SWAP';
export const TROCADOR_LTC_LADDER_DEFAULT: string;
export const TROCADOR_LTC_CAP_DEFAULT: string;
export const TROCADOR_LTC_HARD_MAX: string;
export const TROCADOR_TRADE_ID: RegExp;
export function ltcAtomic(decimal: string): bigint;
export function trocadorSwapRefusal(env: Record<string, string | undefined>): string | null;
export interface TrocadorStep {
  text: string;
  atomic: bigint;
}
export function trocadorPlan(env: Record<string, string | undefined>): { ladder: TrocadorStep[]; capAtomic: bigint };
export function trocadorAmountRefusal(amountAtomic: bigint, capAtomic: bigint): string | null;
export interface TrocadorEvidenceFields {
  tradeId?: string;
  exchange?: string;
  depositLtc?: string;
  depositTxid?: string;
  finalStatus?: string;
  completedXmrAtomic?: string;
  xmrRiseAtomic?: string;
}
export function trocadorEvidence(fields: TrocadorEvidenceFields & Record<string, unknown>): Record<string, string>;
