/**
 * The worker's side of the private failure log (fixtures/failure-record.mjs
 * says what may be in it and why traces stay off).
 *
 * Lanes tell it three things, all value-free by construction:
 *   noteStep(label)          the static label of the step now running (the
 *                            lanes' footage helpers call it for every tap,
 *                            entry, settle and result);
 *   watchContext(name, ctx)  a wallet's browser context, so a failure can
 *                            list the test ids each of its pages shows and
 *                            the shape of its recent requests;
 *   noteRecovery(report)     a reopened wallet that had to be brought Home
 *                            (fixtures/wallet-recovery.ts).
 * private-test.ts collects them when a test fails (or recovered a wallet) and
 * attaches them, shaped, for the private reporter to write.
 */
import type { BrowserContext, Page, Request, TestInfo } from '@playwright/test';
import { CONTEXT_ATTACHMENT, LIMITS, errorClassOf, requestShape, safeLabel, safeTestIds, shapeContext } from './failure-record.mjs';

interface StepNote {
  label: string;
  at: number;
}

interface NetworkNote {
  wallet: string;
  method: string;
  scheme: string;
  host: string;
  path: string;
  status?: number;
  ms?: number;
  failure?: string;
  at: number;
}

export interface RecoveryNote {
  wallet: string;
  reached?: string;
  from: string[] | null;
  moves: string[];
  kept?: string;
  ms: number;
  failed?: boolean;
}

const STEP_RING = 32;
const NETWORK_RING = 200;
/** What one failure may spend collecting its explanation, in total. */
const COLLECT_BUDGET_MS = 6_000;

const steps: StepNote[] = [];
const watched = new Map<BrowserContext, { wallet: string; network: NetworkNote[] }>();
/** Contexts closed before a failure was collected (a setup that closes its browser on error) keep their requests. */
const closed: { wallet: string; network: NetworkNote[] }[] = [];
let recoveries: RecoveryNote[] = [];

/** The step the lane is now running. A label that is not static is kept only as "label withheld". */
export function noteStep(label: string): void {
  steps.push({ label: safeLabel(label) ?? 'label withheld', at: Date.now() });
  if (steps.length > STEP_RING) steps.splice(0, steps.length - STEP_RING);
}

/** A wallet's recovery to Home, for the next record. */
export function noteRecovery(note: RecoveryNote): void {
  recoveries.push(note);
  if (recoveries.length > LIMITS.recoveries) recoveries = recoveries.slice(-LIMITS.recoveries);
}

/** Recoveries since the last call, which clears them. */
export function takeRecoveries(): RecoveryNote[] {
  const taken = recoveries;
  recoveries = [];
  return taken;
}

function failureCode(text: string | undefined): string {
  return text?.match(/net::ERR_[A-Z_]{2,48}|NS_ERROR_[A-Z_]{2,48}/)?.[0] ?? 'failed';
}

/** Watch a wallet's context: request shapes only (no query, header or body), and its pages at failure time. */
export function watchContext(wallet: string, context: BrowserContext): void {
  const known = watched.get(context);
  if (known) {
    known.wallet = wallet;
    return;
  }
  const entry = { wallet, network: [] as NetworkNote[] };
  watched.set(context, entry);
  const record = (request: Request, status?: number, failure?: string) => {
    const shape = requestShape(request.url());
    if (!shape) return;
    // Time to the response's first byte (or to the failure), from the request's start.
    const timing = request.timing();
    const ms = timing.responseStart >= 0 ? timing.responseStart : timing.responseEnd;
    entry.network.push({
      wallet: entry.wallet,
      method: request.method(),
      ...shape,
      ...(status === undefined ? {} : { status }),
      ...(ms >= 0 ? { ms: Math.round(ms) } : {}),
      ...(failure ? { failure } : {}),
      at: Date.now(),
    });
    if (entry.network.length > NETWORK_RING) entry.network.splice(0, entry.network.length - NETWORK_RING);
  };
  // The response event carries its status; no extra round trip per request.
  context.on('response', (response) => record(response.request(), response.status()));
  context.on('requestfailed', (request) => record(request, undefined, failureCode(request.failure()?.errorText)));
  context.on('close', () => {
    watched.delete(context);
    closed.push(entry);
    if (closed.length > 3) closed.shift();
  });
}

/** What a page shows, by name only: its visible test ids and whether a dialog is open. */
export interface ScreenIds {
  ids: string[];
  dialog: boolean;
}

/**
 * The data-testid values of the visible elements of a page, in document order,
 * and whether a dialog is open. Only attributes and boxes are read: never
 * text, never an input's value.
 */
export async function readScreen(page: Page): Promise<ScreenIds> {
  return page.evaluate(READ_SCREEN) as Promise<ScreenIds>;
}

/**
 * The page side of readScreen, as source text: a transpiler that wraps inner
 * functions in helpers (tsx's keepNames) would otherwise send the page a call
 * to a helper the page does not have.
 */
const READ_SCREEN = `(() => {
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const ids = [];
  for (const element of document.querySelectorAll('[data-testid]')) {
    if (!shown(element)) continue;
    ids.push(element.getAttribute('data-testid') || '');
    if (ids.length >= 400) break;
  }
  const dialog = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')).some(shown);
  return { ids, dialog };
})()`;

/** The visible test ids of a page (see readScreen). */
export async function visibleTestIds(page: Page): Promise<string[]> {
  return (await readScreen(page)).ids;
}

function pageKind(url: string): string {
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return url.includes('#approval/') ? 'approval' : 'wallet';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return 'local';
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'site';
  } catch {
    /* about:blank and friends */
  }
  return 'blank';
}

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

async function screens(deadline: number): Promise<{ wallet: string; page: string; testIds: string[] }[]> {
  const out: { wallet: string; page: string; testIds: string[] }[] = [];
  for (const [context, entry] of watched) {
    for (const page of context.pages()) {
      if (page.isClosed() || out.length >= LIMITS.screens) continue;
      const left = deadline - Date.now();
      if (left <= 0) return out;
      const ids = await within(visibleTestIds(page), Math.min(2_000, left), [] as string[]);
      out.push({ wallet: entry.wallet, page: pageKind(page.url()), testIds: safeTestIds(ids) });
    }
  }
  return out;
}

function network(now: number): Omit<NetworkNote, 'at'>[] {
  const all = [...closed, ...watched.values()].flatMap((entry) => entry.network);
  return all
    .sort((a, b) => a.at - b.at)
    .slice(-LIMITS.network)
    .map(({ at, ...rest }) => ({ ...rest, ago: Math.max(0, now - at) }));
}

/**
 * The shaped explanation of this test, or null when there is nothing to say
 * (it passed and recovered nothing). Collects within a fixed budget, and never
 * throws: the failure itself is already recorded by the runner.
 */
export async function privateContext(testInfo: Pick<TestInfo, 'errors' | 'status' | 'expectedStatus'>): Promise<ReturnType<typeof shapeContext> | null> {
  const failed = testInfo.errors.length > 0 || (testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus && testInfo.status !== 'skipped');
  const recovered = takeRecoveries();
  if (!failed && recovered.length === 0) return null;
  const now = Date.now();
  const raw: Record<string, unknown> = { recoveries: recovered };
  if (failed) {
    // Classes are read before the errors are sanitized; never their messages.
    raw.errors = testInfo.errors.map((error) => errorClassOf(error));
    raw.steps = steps.slice(-LIMITS.steps).map((step) => ({ label: step.label, ago: Math.max(0, now - step.at) }));
    raw.screens = await within(screens(now + COLLECT_BUDGET_MS), COLLECT_BUDGET_MS, []);
    raw.network = network(now);
  }
  return shapeContext(raw);
}

const attached = new WeakSet<TestInfo>();

/**
 * Attach this test's explanation for the private reporter, once per test (a
 * fixture that sanitizes errors before private-test.ts does attaches first).
 * Best effort; never throws.
 */
export async function attachPrivateContext(testInfo: TestInfo): Promise<void> {
  if (attached.has(testInfo)) return;
  attached.add(testInfo);
  try {
    const context = await privateContext(testInfo);
    if (!context) return;
    await testInfo.attach(CONTEXT_ATTACHMENT, { body: JSON.stringify(context), contentType: 'application/json' });
  } catch {
    /* an explanation that cannot be collected is simply absent */
  }
}
