/** Types for failure-record.mjs, so the TypeScript reporter and fixtures can import it. */
export const CONTEXT_ATTACHMENT: string;
export const PATH_WORDS: ReadonlySet<string>;
export const LIMITS: Readonly<{ testIds: number; steps: number; network: number; screens: number; recoveries: number; moves: number; errors: number }>;

export interface ErrorClass {
  name: string;
  api?: string;
  matcher?: string;
  kind?: string;
  fixture?: string;
  code?: string;
  at?: string;
  /** The wrapped error's class, one level deep. */
  cause?: ErrorClass;
}

export interface NetworkShape {
  method: string;
  scheme: string;
  host: string;
  path: string;
  wallet?: string;
  status?: number;
  ms?: number;
  ago?: number;
  failure?: string;
}

export interface ShapedContext {
  errors?: ErrorClass[];
  steps?: { label: string; ago?: number }[];
  screens?: { wallet: string; page: string; testIds: string[] }[];
  network?: NetworkShape[];
  recoveries?: { wallet: string; reached?: string; from?: string[]; moves: string[]; kept?: string; ms?: number; failed?: true }[];
}

export function safeLabel(label: unknown): string | null;
export function safeTestId(id: unknown): string | null;
export function safeTestIds(ids: unknown, limit?: number): string[];
export function errorClassOf(error: unknown): ErrorClass;
export function describeErrorClass(shape: ErrorClass): string;
export function locationLabel(location: { file: string; line: number } | undefined | null): string | null;
export function safeErrorClass(shape: unknown): ErrorClass;
export function requestShape(url: string): { scheme: string; host: string; path: string } | null;
export function shapeNetworkEntry(entry: unknown): NetworkShape | null;
export function shapeContext(raw: unknown): ShapedContext;
export function privateLogPath(env?: Record<string, string | undefined>, configFile?: string, now?: Date): string;
export function appendPrivateLog(path: string, record: unknown): void;
