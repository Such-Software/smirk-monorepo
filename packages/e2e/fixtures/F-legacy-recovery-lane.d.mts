export type WalletName = 'alice' | 'bob' | 'carol';
export type MoveAsset = 'btc' | 'ltc' | 'xmr' | 'wow';
export type OlderSource = 'm44' | 'v1' | 'v2';
type Env = Record<string, string | undefined>;

export const LANE_ID: 'F-legacy-recovery';
export const WALLET_NAMES: readonly WalletName[];
export const SKIP_OPT_IN: string;
export const SKIP_NO_FIXTURE: string;
export function optIn(why: string): string;
export function noFixture(why: string): string;
export const ACTION_TIMEOUT_MS: number;

export interface LaneGates {
  /** The spec declares its tests only inside this lane's own invocation. */
  declared: boolean;
  live: boolean;
  money: boolean;
  /** Writes to the backend are allowed: a local backend, or ALLOW_PROD_WRITES on a shared one. */
  prodWrites: boolean;
}
export function laneGates(env?: Env): LaneGates;
export function writeRefusal(g?: LaneGates): string | null;
export function moneyRefusal(g?: LaneGates): string | null;

export interface MoveScenario {
  asset: MoveAsset;
  kind: 'utxo' | 'cryptonote';
  funder: WalletName;
  target: WalletName;
  /** Which older address of the target receives the fixture. */
  source: OlderSource;
  /** Decimal amount the funder sends, at most the asset's cap. */
  amount: string;
  amountAtomic: bigint;
  decimals: number;
}
export function toAtomic(amount: string, decimals: number): bigint;
export function moveScenarios(env?: Env): MoveScenario[];
export function expectedExecuted(g: LaneGates, moves: number): number;

export const DEFAULT_RELEASE_ZIP: string;
export const FOOTAGE_RUN: string;
export function footageRoot(): string;
export function footageEnabled(env?: Env): boolean;
export function assertOwnerOnlyFile(file: string, what: string): void;

export interface ReleaseFacts {
  zipSha256: string;
  files: number;
  version: string;
  sourceCommit: string | null;
}
export function lanePreflight(env?: Env): ReleaseFacts;

export class LaneEvidence {
  readonly file: string;
  constructor(isSecret: (value: string) => boolean);
  note(test: string, key: string, value: string | number | boolean): void;
}

export function walletLockHolder(name: WalletName): { pid: number; lane?: string } | null;
export function acquireWalletLock(name: WalletName): Promise<() => void>;
