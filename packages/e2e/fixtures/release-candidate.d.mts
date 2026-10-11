export interface ReleaseZip {
  readonly file: string;
  readonly sha256: string;
}
export interface ReleaseCandidate {
  readonly version: string;
  readonly run: string;
  readonly sourceCommit: string;
  readonly buildsWrapper: string;
  readonly stampCommits: readonly string[];
  readonly runLabel: string;
  readonly stagedDir: string;
  readonly chromeZip: ReleaseZip;
  readonly firefoxZip: ReleaseZip;
}
export const CANDIDATE_FILE: string;
export function parseReleaseCandidate(raw: unknown): ReleaseCandidate;
export const RC: ReleaseCandidate;
export const RC_FOOTAGE_ROOT: string;
