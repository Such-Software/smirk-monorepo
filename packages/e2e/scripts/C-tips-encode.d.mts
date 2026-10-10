export interface EncodeReport {
  invocation: string;
  pages: Record<string, { file: string; frames: number; seconds: number }>;
  combined: { file: string; pages: string[]; seconds: number } | null;
  holds: Array<{ wallet: string; type: string; label: string; ok: boolean; start: number; end: number }>;
  failures: string[];
}
export function encodeInvocation(options?: {
  env?: Record<string, string | undefined>;
  invocation?: string;
  allowTestPolicy?: boolean;
  log?: (message: string) => void;
}): Promise<EncodeReport>;
export function loadInvocation(root: string, invocation: string): { sessions: unknown[]; problems: string[] };
export function probeFrames(file: string): { pts: number[]; duration: number };
export function vfrArgs(): string[];
export function concatList(track: Array<{ path: string; from: number; to: number }>): string;
export function encode(
  listFile: string,
  out: string,
  vfr: string[],
  extra?: { inputs: string[]; filter: string | null; map: string[] },
): void;
export function encodeSideBySide(lists: string[], file: string, vfr?: string[], chapters?: string | null): void;
export function checkHold(
  hold: { from: number; to: number },
  t0: number,
  probe: { pts: number[]; duration: number },
): { start: number; end: number; ok: boolean; changesInside: number };
