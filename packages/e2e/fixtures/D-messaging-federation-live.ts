/**
 * Live lane fixture for area D (messaging and federation): alice, bob and carol
 * loaded once per worker into three persistent Chromium profiles of the
 * UNPACKED RELEASE ARTIFACT, each recorded by its own guarded footage recorder.
 *
 * Gates, each its own explicit opt-in (see `dLiveSkipReason`):
 *   - `E2E_LIVE=1`         this lane runs at all.
 *   - `BACKEND_URL`        the backend the release build targets (production
 *                          for the v0.3.1 run); global setup proves the bundle
 *                          was built against it.
 *   - `EXTENSION_DIST`     the unpacked, hash-verified release zip.
 *   - `E2E_WALLET_FILE`    the owner-only custody file (default: the main
 *                          checkout's packages/smoke-tests/secrets path).
 *   - `E2E_LIVE_RELAY=1`   publishing to the production relay (specs check it).
 *   - `FOOTAGE=guarded`    recording; `E2E_FOOTAGE_DIR` overrides the output.
 *
 * Custody: each phrase is read in-process by the demo lane's reviewed
 * `readWalletPhrase` (one NAME=value line, regular 0600 file owned by this
 * user, 12 or 24 lowercase words). It is never placed in the environment, so no
 * child process (the browsers included) inherits it, and browsers launch with
 * secret-looking variables scrubbed. Each wallet's password is derived in
 * memory from its phrase and a random per-run salt, so a worker restarted
 * after a failure can unlock the profile instead of importing again (the
 * backend allows 30 history lookups an hour per IP); it is never stored.
 * After import the word arrays are zeroed; only the canary's shingle digests
 * and the account-0 PUBLIC key remain. Profiles live in a 0700 run directory,
 * removed by the config's global teardown (or, after a crash, by the next run).
 *
 * Nothing here prints a phrase, password, key or page text. A failed import
 * reports its stage and the visible screen's test IDs (plus its text, never on
 * a phrase screen), and only with E2E_LIVE_DIAGNOSE=1, to the findings file,
 * after the known-secret canary has checked the line.
 *
 * Funds: nothing in this lane moves funds. `E2E_LIVE_MONEY` is not consulted.
 *
 * Isolation: run this lane ALONE. Lanes B, C and E use the same three wallets,
 * and the federation test compares carol's balances before and after her trip
 * to backend B exactly. Relay evidence does not depend on it (every check looks
 * up the gift wraps this run published, by id), but the balance check does.
 *
 * Relay guard: every WebSocket a wallet page opens goes through
 * `context.routeWebSocket`. An outbound EVENT frame is forwarded only when
 * `liveRelayAdmits` (fixtures/relay-guard.ts) admits its kind for that relay,
 * and only to a relay this worker PINNED: the operator relay the backend
 * advertises, plus an approved backend B's. Anything else is answered with a
 * relay-style refusal and counted. The guard also records the ids of the gift
 * wraps it forwarded and the keys each gift-wrap subscription listens for
 * (public data), which the specs use as evidence. The fixture proves the route
 * is attached before any test runs (fails closed).
 *
 * A profile left pointing at another backend (a worker that failed while carol
 * was on B) is put back on the default backend before any test sees it.
 */

import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveNostrIdentity } from '@smirk/core';
import { test as privateTest } from './private-test.js';
import { isLocalPublishRelay, liveRelayAdmits, relayKey } from './relay-guard.js';
import { readCapabilities } from './D-messaging-federation-nostr.js';
import {
  DFootage,
  SecretCanary,
  assertHoldsMeetPolicy,
  footageEnabled,
  holdsShortened,
  loadGuard,
} from './D-messaging-federation-footage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DWalletName = 'alice' | 'bob' | 'carol';
export const D_WALLET_NAMES: readonly DWalletName[] = ['alice', 'bob', 'carol'];

/** Popup-sized viewport at device pixels, as the demo lane records. */
const VIEWPORT = { width: 380, height: 600 };
const SCALE = 2;

/** Backend under test (required for the live lane; global setup checks the bundle). */
export const D_BACKEND_URL = process.env.BACKEND_URL ?? '';

/** Unpacked release artifact. */
export const D_EXTENSION_DIST = process.env.EXTENSION_DIST ?? '';

/** Owner-only custody file holding SMOKE_<NAME>_MNEMONIC lines. */
export const D_WALLET_FILE = resolve(
  process.env.E2E_WALLET_FILE ?? join(__dirname, '..', '..', 'smoke-tests', 'secrets', 'smoke-mnemonics.env'),
);

/** Backend B for the federation spec (`FED_BACKEND_URL`), as the operator typed it. */
export const D_FED_URL = (process.env.FED_BACKEND_URL ?? '').trim();

/** The durable backend selection key (core `BACKEND_CONFIG_KEY`). */
export const BACKEND_CONFIG_KEY = 'smirk_backend_v1';

/** The API base the wallet derives from what the user types (core `connectBackend`). */
export function dFedApiBase(): string {
  let url = D_FED_URL.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  return url;
}

/**
 * Why backend B cannot be used in this run, or null. A loopback B is a
 * disposable local instance; a shared one registers carol there and hands its
 * light-wallet servers her view keys, so it needs the owner's approval.
 */
export function dFedSkipReason(): string | null {
  if (!D_FED_URL) {
    return 'federation: FED_BACKEND_URL must name an independent backend B (a disposable local smirk-backend-core with a local relay, or a shared host such as https://api.moon.vote with owner approval)';
  }
  let host = '';
  try {
    host = new URL(dFedApiBase()).hostname;
  } catch {
    return 'federation: FED_BACKEND_URL is not a URL';
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (!loopback && process.env.FED_BACKEND_APPROVED !== '1') {
    return `federation: switching carol to ${host} registers her there and hands it her view keys; set FED_BACKEND_APPROVED=1 once the owner approves`;
  }
  try {
    if (new URL(dFedApiBase()).host === new URL(D_BACKEND_URL).host) {
      return 'federation: FED_BACKEND_URL names the default backend; B must be an independent instance';
    }
  } catch {
    return 'federation: BACKEND_URL is not a URL';
  }
  return null;
}

/** Relay guard bookkeeping per wallet context: counts, kinds and public ids, never content. */
export interface DRelayGuard {
  /** Relays this worker may publish to (see `relayPins`). */
  pins: readonly string[];
  /** WebSockets the route saw (the attach proof). */
  connections: number;
  /** Relay hosts the page opened, with when (public operator hosts only). */
  opened: { host: string; at: number }[];
  /** Outbound events forwarded, by kind. */
  forwarded: Record<number, number>;
  /** Outbound events refused, with the relay host and the static rule that refused them. */
  blocked: { kind: number; host: string; reason: string }[];
  /** Gift wraps (kind 1059) the page published, by public event id and relay host. */
  sentWraps: { id: string; host: string; at: number }[];
  /** Gift-wrap subscriptions (REQ for kind 1059) the page opened, by the keys they listen for. */
  wrapSubscriptions: { p: string[]; host: string; at: number }[];
  /**
   * While true, the page's gift-wrap subscriptions are answered with EOSE at the
   * socket and never reach the relay, so whatever Messages shows can only come
   * from the wraps the background poller already collected.
   */
  holdWrapReads: boolean;
  /** Gift-wrap subscriptions held that way. */
  heldWrapReads: number;
  /** Set by the feed test only after the server granted posting rights and the
   *  owner approved a public note (E2E_LIVE_FEED_POST=1). */
  notePostingVerified: boolean;
}

export interface DWallet {
  name: DWalletName;
  context: BrowserContext;
  page: Page;
  extensionId: string;
  /** Seed account-0 identity (public). Checked against the UI by the specs. */
  npub: string;
  pubkeyHex: string;
  footage: DFootage;
  relayGuard: DRelayGuard;
  /**
   * Whether the account is linked to this seed npub, as the identity hub shows
   * it (null until read). The operator relay admits gift wraps only to linked
   * npubs, so an unlinked wallet cannot receive DMs there.
   */
  linked: boolean | null;
  /** Unlock from the lock screen inside a redaction scope (no-op when unlocked). */
  unlock(): Promise<void>;
  /** Confirm an operation-password prompt inside a redaction scope. */
  confirmOperationPassword(): Promise<void>;
  /** Answer the identity hub's own inline password field inside a redaction scope. */
  unlockHub(): Promise<void>;
}

export interface DWallets {
  alice: DWallet;
  bob: DWallet;
  carol: DWallet;
  all: readonly DWallet[];
  /** Relays this run may publish to (the operator's, plus an approved backend B's). */
  relayPins: readonly string[];
  /** Chapter marker on every recorder (static label). */
  chapter(label: string): void;
  /** Register a Node-side secret (a test key) with the footage canary. */
  watchSecret(value: string): void;
  /** True when `text` contains a known secret (canary match). */
  carriesSecret(text: string): boolean;
}

/**
 * Why this lane cannot run here, or null. Call at file level so a skipped run
 * never instantiates the wallets.
 */
export function dLiveSkipReason(): string | null {
  if (process.env.E2E_LIVE !== '1') {
    return 'live lane: set E2E_LIVE=1 (and BACKEND_URL, EXTENSION_DIST, E2E_WALLET_FILE) to run against real services';
  }
  if (!D_BACKEND_URL) return 'live lane: BACKEND_URL must name the backend the release build targets';
  if (!D_EXTENSION_DIST || !existsSync(join(D_EXTENSION_DIST, 'manifest.json'))) {
    return 'live lane: EXTENSION_DIST must point at the unpacked release artifact';
  }
  if (!existsSync(D_WALLET_FILE)) {
    return 'live lane: the wallet custody file is not on this host (set E2E_WALLET_FILE to the owner-only file in the main checkout)';
  }
  return null;
}

/**
 * Why a relay-publishing test cannot run here, or null. A loopback backend's
 * relay is a disposable local one; anything else is production and needs the
 * explicit `E2E_LIVE_RELAY=1` (which admits only kinds 1059 and 10050).
 */
export function dRelaySkipReason(): string | null {
  let host = '';
  try {
    host = new URL(D_BACKEND_URL).hostname;
  } catch {
    // Unparseable: treated as production below.
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return null;
  return process.env.E2E_LIVE_RELAY === '1'
    ? null
    : 'live lane: these tests publish NIP-17 gift wraps to the production relay; set E2E_LIVE_RELAY=1 to admit kinds 1059 and 10050';
}

/**
 * Whether the owner approved linking a demo wallet's seed npub to its own
 * account during the run (`E2E_LIVE_LINK=1`, with `ALLOW_PROD_WRITES=1`). It is
 * a durable production account write, so it is never inferred.
 */
export function dLinkApproved(): boolean {
  return process.env.E2E_LIVE_LINK === '1' && process.env.ALLOW_PROD_WRITES === '1';
}

/** Version of the artifact under test (from its manifest). */
export function dExtensionVersion(): string {
  const manifest = JSON.parse(readFileSync(join(D_EXTENSION_DIST, 'manifest.json'), 'utf8')) as { version?: string };
  return manifest.version ?? 'unknown';
}

/**
 * This worker's footage directory:
 * ~/Build/smirk-e2e/v<version>-<label>/footage/raw/D-messaging-federation/<run stamp>/segment-<ms>.
 * One run stamp per Playwright run (kept in the run directory), one segment per
 * worker, so a worker restarted after a failure never overwrites earlier frames.
 * The encoder joins the segments in order.
 */
function footageRoot(runDir: string): string {
  const stampFile = join(runDir, 'footage-stamp');
  if (!existsSync(stampFile)) writeFileSync(stampFile, new Date().toISOString().replace(/[:.]/g, '-'), { mode: 0o600 });
  const stamp = readFileSync(stampFile, 'utf8').trim();
  const label = (process.env.E2E_RUN_LABEL ?? 'run').replace(/[^A-Za-z0-9._-]/g, '');
  const runRoot = process.env.E2E_FOOTAGE_DIR
    ? resolve(process.env.E2E_FOOTAGE_DIR)
    : join(homedir(), 'Build', 'smirk-e2e', `v${dExtensionVersion()}-${label}`, 'footage', 'raw', 'D-messaging-federation', stamp);
  const root = join(runRoot, `segment-${Date.now()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  chmodSync(root, 0o700);
  return root;
}

/**
 * Record a finding: an honest outcome that is not a failure but must reach the
 * owner (a scenario the deployment cannot exercise, a policy that refuses by
 * design). Static descriptions only. The private reporter prints statuses
 * alone, so findings also go to a 0600 JSON-lines file beside the footage:
 * E2E_REPORTS_DIR, or ~/Build/smirk-e2e/v<version>-<label>/reports, then
 * D-messaging-federation-findings.jsonl
 */
export function recordFinding(type: string, description: string): void {
  const info = test.info();
  info.annotations.push({ type, description });
  appendFinding(info.title, type, description);
}

function appendFinding(title: string, type: string, description: string): void {
  const label = (process.env.E2E_RUN_LABEL ?? 'run').replace(/[^A-Za-z0-9._-]/g, '');
  const dir = process.env.E2E_REPORTS_DIR
    ? resolve(process.env.E2E_REPORTS_DIR)
    : join(homedir(), 'Build', 'smirk-e2e', `v${dExtensionVersion()}-${label}`, 'reports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), test: title, type, description });
  appendFileSync(join(dir, 'D-messaging-federation-findings.jsonl'), `${line}\n`, { mode: 0o600 });
}

/** Browser environment without anything that looks like a credential. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/MNEMONIC|SEED|PASSWORD|PASSPHRASE|SECRET|TOKEN|PRIVATE|NSEC|API_KEY|CREDENTIAL/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

type ReadWalletPhrase = (file: string, variable: string) => string[];

/** The reviewed custody reader from the demo lane (one implementation, not two). */
async function loadCustody(): Promise<ReadWalletPhrase> {
  const href = new URL('../demo/capture-demo.mjs', import.meta.url).href;
  const mod = (await import(href)) as { readWalletPhrase?: ReadWalletPhrase };
  if (typeof mod.readWalletPhrase !== 'function') throw new Error('custody reader did not load');
  return mod.readWalletPhrase;
}

/** An outbound relay frame, parsed: EVENT, REQ and CLOSE are the ones the guard reads. */
type OutboundFrame =
  | { type: 'EVENT'; id: string; kind: number }
  | { type: 'REQ'; subId: string; filters: { kinds?: unknown; '#p'?: unknown }[] }
  | { type: 'CLOSE'; subId: string }
  | null;

function outboundFrame(message: string): OutboundFrame {
  let frame: unknown;
  try {
    frame = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(frame)) return null;
  if (frame[0] === 'EVENT') {
    const event = frame[1] as { id?: unknown; kind?: unknown } | undefined;
    if (!event || typeof event.kind !== 'number') return { type: 'EVENT', id: '', kind: -1 };
    return { type: 'EVENT', id: typeof event.id === 'string' ? event.id : '', kind: event.kind };
  }
  if (frame[0] === 'REQ' && typeof frame[1] === 'string') {
    const filters = frame.slice(2).filter((f): f is { kinds?: unknown; '#p'?: unknown } => !!f && typeof f === 'object');
    return { type: 'REQ', subId: frame[1], filters };
  }
  if (frame[0] === 'CLOSE' && typeof frame[1] === 'string') return { type: 'CLOSE', subId: frame[1] };
  return null;
}

/**
 * The relays this worker may publish to: the operator relay the backend under
 * test advertises, plus backend B's when the federation run is configured and
 * admitted (`dFedSkipReason`). Absent evidence is not health: an unreadable
 * default backend refuses the lane; an unreachable B only leaves B unpinned
 * (the federation spec then fails on its own capabilities read).
 */
async function relayPins(): Promise<string[]> {
  const pins: string[] = [];
  let relayA: string | undefined;
  try {
    relayA = (await readCapabilities(D_BACKEND_URL)).messaging?.relay_url;
  } catch {
    throw new Error('live lane: could not read /capabilities to pin the operator relay');
  }
  if (relayA && relayKey(relayA)) pins.push(relayA);
  if (dFedSkipReason() === null) {
    try {
      const relayB = (await readCapabilities(dFedApiBase())).messaging?.relay_url;
      if (relayB && relayKey(relayB)) pins.push(relayB);
    } catch {
      // B unreachable: nothing is pinned for it.
    }
  }
  return pins;
}

async function installRelayGuard(context: BrowserContext, pins: readonly string[]): Promise<DRelayGuard> {
  const state: DRelayGuard = {
    pins,
    connections: 0,
    opened: [],
    forwarded: {},
    blocked: [],
    sentWraps: [],
    wrapSubscriptions: [],
    holdWrapReads: false,
    heldWrapReads: 0,
    notePostingVerified: false,
  };
  await context.routeWebSocket(/^wss?:\/\//, (ws) => {
    state.connections++;
    const url = ws.url();
    let host = 'unparseable';
    try {
      host = new URL(url).host;
    } catch {
      // Recorded as unparseable; liveRelayAdmits refuses it as production.
    }
    state.opened.push({ host, at: Date.now() });
    const server = ws.connectToServer();
    // Subscriptions this route answered itself (held reads): their CLOSE stays here too.
    const held = new Set<string>();
    ws.onMessage((message) => {
      // Nostr is text. A binary frame to a production relay is not something
      // the wallet sends, so it is dropped rather than inspected.
      if (typeof message !== 'string') {
        if (!isLocalPublishRelay(url)) {
          state.blocked.push({ kind: -1, host, reason: 'binary frame to a production relay' });
          return;
        }
        server.send(message);
        return;
      }
      const frame = outboundFrame(message);
      if (frame?.type === 'EVENT') {
        const decision = liveRelayAdmits(url, frame.kind, { premium: state.notePostingVerified, pinned: state.pins });
        if (!decision.admit) {
          state.blocked.push({ kind: frame.kind, host, reason: decision.reason });
          ws.send(JSON.stringify(['OK', frame.id, false, 'blocked: e2e relay guard refused this event']));
          return;
        }
        state.forwarded[frame.kind] = (state.forwarded[frame.kind] ?? 0) + 1;
        if (frame.kind === 1059 && frame.id) state.sentWraps.push({ id: frame.id, host, at: Date.now() });
      } else if (frame?.type === 'REQ') {
        const wraps = frame.filters.filter((f) => Array.isArray(f.kinds) && f.kinds.includes(1059));
        if (wraps.length > 0) {
          if (state.holdWrapReads) {
            state.heldWrapReads++;
            held.add(frame.subId);
            ws.send(JSON.stringify(['EOSE', frame.subId]));
            return;
          }
          const p = wraps.flatMap((f) => (Array.isArray(f['#p']) ? f['#p'].filter((k): k is string => typeof k === 'string') : []));
          state.wrapSubscriptions.push({ p, host, at: Date.now() });
        }
      } else if (frame?.type === 'CLOSE' && held.has(frame.subId)) {
        held.delete(frame.subId);
        return;
      }
      server.send(message);
    });
  });
  return state;
}

/** Prove the route is attached: a REQ-only socket from the page must be seen. */
async function assertRelayGuardAttached(page: Page, guard: DRelayGuard): Promise<void> {
  const relayUrl = guard.pins[0];
  if (!relayUrl) return; // no relay advertised: nothing to publish to, nothing to guard
  const before = guard.connections;
  const outcome = await page.evaluate(async (url) => {
    return await new Promise<string>((done) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => done('timeout'), 20_000);
      socket.onopen = () => {
        clearTimeout(timer);
        socket.close();
        done('open');
      };
      socket.onerror = () => {
        clearTimeout(timer);
        done('error');
      };
    });
  }, relayUrl);
  if (guard.connections <= before || outcome !== 'open') {
    throw new Error('live lane: the relay guard did not attach to the wallet page; refusing to publish anything');
  }
}

/** Import one wallet (never recorded: this page's earlier screens are not captured). */
async function importIntoProfile(
  context: BrowserContext,
  extensionId: string,
  words: readonly string[],
  password: string,
): Promise<Page> {
  const page = await context.newPage();
  let stage = 'open';
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    stage = 'welcome';
    await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
    await page.getByTestId('onboarding-import-warning-continue').click();
    stage = 'phrase';
    for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
    await page.getByTestId('onboarding-import-continue').click();
    stage = 'password';
    // The wizard fails closed until the backend's sign-up requirements resolve;
    // its retry rebuilds the step with empty fields, so re-enter before each press.
    const submit = page.getByTestId('onboarding-set-password-submit');
    const pw = page.getByTestId('onboarding-password-input');
    const onward = page.getByTestId('onboarding-setup-finish-btn').or(page.getByTestId('home-total-balance'));
    for (let attempt = 0; attempt < 12; attempt++) {
      await pw.fill(password);
      await page.getByTestId('onboarding-password-confirm-input').fill(password);
      await submit.click();
      // The wizard's own verdict, not a fixed wait: it moves on (setup step or
      // Home), or it comes back to this step with an error. A register error
      // leaves the step and rebuilds it with empty fields (both are proof the
      // press was processed). A capabilities race never leaves the step and
      // keeps the fields, so its notice counts only once it has held steady
      // for two seconds with the step never left: the notice may still be the
      // previous attempt's while this press is in flight.
      type Verdict = 'onward' | 'retry' | 'pending';
      let left = false;
      let refusedSince = 0;
      const verdict = async (): Promise<Verdict> => {
        if (await onward.first().isVisible().catch(() => false)) return 'onward';
        if (!(await submit.isVisible().catch(() => false))) {
          left = true;
          return 'pending';
        }
        if (left || (await pw.inputValue().catch(() => password)) === '') return 'retry';
        const screen = await page.locator('#root').innerText().catch(() => '');
        if (!/sign-up requirements/.test(screen)) {
          refusedSince = 0;
          return 'pending';
        }
        refusedSince ||= Date.now();
        return Date.now() - refusedSince >= 2_000 ? 'retry' : 'pending';
      };
      // Assigned inside the poll's callback, which control flow cannot see.
      let outcome = 'pending' as Verdict;
      await expect
        .poll(async () => (outcome = await verdict()), { timeout: 5 * 60_000, intervals: [250, 500, 1_000, 2_000] })
        .not.toBe('pending');
      if (outcome === 'onward') break;
      // Retry only what the wallet itself calls retryable: the capabilities
      // race, and a history lookup that did not answer ("Retry before
      // registering"). The backend allows 30 history lookups an hour per IP,
      // shared by every run on this host, so a rate-limited lookup backs off a
      // minute for the window to move. Any other refusal stops here.
      const screen = await page.locator('#root').innerText();
      if (!/sign-up requirements|Could not check wallet history/.test(screen)) break;
      const limited = /too many|rate.?limit|429/i.test(screen);
      await retryBackoff(limited ? 60_000 : /wallet history/.test(screen) ? 20_000 : 5_000);
    }
    stage = 'setup';
    await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 25_000 }).catch(() => {});
    stage = 'home';
    const total = page.getByTestId('home-total-balance');
    await total.waitFor({ timeout: 120_000 });
    await expect.poll(async () => (await total.textContent()) ?? '', { timeout: 120_000 }).toMatch(/\d/);
    return page;
  } catch {
    // Stage only: Playwright call logs can quote values typed into fields.
    // As in the demo lane, name the visible screen by its test IDs, and add
    // its text only when no phrase field is on it. Typed values (the phrase
    // words, the password) live in input values, never in the page text. The
    // worker fixture runs the known-secret canary over this line before it
    // records it (E2E_LIVE_DIAGNOSE=1 only), whatever its prefix.
    const ids = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => (e as HTMLElement).dataset.testid ?? '')
          .slice(0, 30),
      )
      .catch(() => [] as string[]);
    const sensitive = ids.some((id) => /import-word|mnemonic|seed|revealed/i.test(id));
    const text = sensitive
      ? '(withheld on a phrase screen)'
      : ((await page.locator('#root').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-240);
    throw new Error(`live lane: wallet import stopped at the ${stage} stage; screen: ${ids.join(', ') || 'none'}; text: ${text}`);
  }
}

/**
 * A deliberate delay before retrying a request the backend refused for now (a
 * rate-limited or unanswered history lookup). Never a stand-in for a UI signal:
 * the static check refuses `waitForTimeout` in these helpers.
 */
function retryBackoff(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a durable extension storage key from a wallet page (public data only), or null. */
async function storedKey(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (k) => {
    const api = (globalThis as unknown as {
      chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } };
    }).chrome;
    return (await api.storage.local.get(k))[k] ?? null;
  }, key);
}

/**
 * Unlock a profile a previous worker of this run imported (no history lookup).
 *
 * A worker that failed while carol was on backend B leaves that choice in her
 * profile, and every later test would then run her against B. It is reset to
 * the default backend here, through the wallet's own Backend settings (the
 * bootstrap-error screen's escape when B refuses the sign-in), before any test
 * sees the wallet. Recording has not started yet. Returns whether it was reset.
 */
async function unlockProfile(
  context: BrowserContext,
  extensionId: string,
  password: string,
): Promise<{ page: Page; resetBackend: boolean }> {
  const page = await context.newPage();
  const lock = page.getByTestId('lockscreen-password-input');
  const nav = page.getByTestId('bottom-nav');
  const failed = page.getByTestId('bootstrap-error');
  const unlock = async () => {
    await lock.fill(password);
    await page.getByTestId('lockscreen-unlock-btn').click();
  };
  let stage = 'open';
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    stage = 'lock screen';
    await lock.waitFor({ timeout: 60_000 });
    await unlock();
    stage = 'sign-in';
    await expect(nav.or(failed)).toBeVisible({ timeout: 180_000 });
    let resetBackend = false;
    if (await storedKey(page, BACKEND_CONFIG_KEY)) {
      stage = 'backend reset';
      resetBackend = true;
      if (await failed.isVisible()) {
        await page.getByTestId('bootstrap-error-backend').click();
      } else {
        // A tab tap restores the tab's last sub-screen; a second tap is its root.
        await page.getByTestId('nav-tab-settings').click();
        const backendNav = page.getByTestId('settings-backend-nav');
        if (!(await backendNav.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
          await page.getByTestId('nav-tab-settings').click();
        }
        await backendNav.click();
      }
      await page.getByTestId('backend-reset-default').click();
      await expect.poll(() => storedKey(page, BACKEND_CONFIG_KEY), { timeout: 60_000 }).toBeNull();
      await expect(nav.or(failed).or(lock)).toBeVisible({ timeout: 180_000 });
      if (await lock.isVisible()) await unlock();
      await expect(nav).toBeVisible({ timeout: 180_000 });
    }
    stage = 'home';
    const total = page.getByTestId('home-total-balance');
    if (!(await total.isVisible())) await page.getByTestId('nav-tab-home').click();
    await total.waitFor({ timeout: 120_000 });
    await expect.poll(async () => (await total.textContent()) ?? '', { timeout: 120_000 }).toMatch(/\d/);
    return { page, resetBackend };
  } catch {
    throw new Error(`live lane: unlocking the run's profile stopped at the ${stage} stage`);
  }
}

/**
 * The run's profile directory, shared by every worker of ONE Playwright run
 * (keyed by the runner's pid). A failed test restarts the worker; reusing the
 * imported profiles then costs an unlock instead of three more history
 * lookups, which the backend limits to 30 an hour per IP for every run on the
 * host. The directory is 0700 and removed by the config's global teardown;
 * directories of runs that no longer exist are removed here.
 */
function runProfileDir(): { dir: string; salt: string } {
  for (const entry of readdirSync(tmpdir())) {
    const match = entry.match(/^smirk-e2e-D-run-(\d+)$/);
    if (!match || Number(match[1]) === process.ppid) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
  const dir = join(tmpdir(), `smirk-e2e-D-run-${process.ppid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const saltFile = join(dir, 'salt');
  if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString('hex'), { mode: 0o600 });
  return { dir, salt: readFileSync(saltFile, 'utf8').trim() };
}

async function openWallet(
  name: DWalletName,
  deps: {
    readWalletPhrase: ReadWalletPhrase;
    canary: SecretCanary;
    scratch: string;
    salt: string;
    recordRoot: string | null;
    guard: Awaited<ReturnType<typeof loadGuard>>;
    shortHolds: boolean;
    pins: readonly string[];
  },
): Promise<DWallet> {
  const words = deps.readWalletPhrase(D_WALLET_FILE, `SMOKE_${name.toUpperCase()}_MNEMONIC`);
  // Derived in memory from the phrase and the run's salt, so a restarted
  // worker can unlock the profile this run already imported. Never stored.
  const password = createHmac('sha256', words.join(' ')).update(`smirk-e2e-D|${name}|${deps.salt}`).digest('base64url');
  deps.canary.addPhrase(words);
  deps.canary.addExact(password);
  let npub: string;
  let pubkeyHex: string;
  {
    const identity = deriveNostrIdentity(words.join(' '), 0);
    npub = identity.npub;
    pubkeyHex = identity.pubkeyHex;
    identity.privateKey.fill(0);
  }

  const profile = join(deps.scratch, name);
  const marker = join(deps.scratch, `${name}.imported`);
  const reuse = existsSync(marker) && existsSync(profile);
  // A profile without the marker is a failed import (it may hold a half-set-up
  // wallet that opens on the lock screen): start it clean.
  if (!reuse) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    headless: !process.env.HEADED,
    channel: 'chromium',
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    env: scrubbedEnv(),
    args: [`--disable-extensions-except=${D_EXTENSION_DIST}`, `--load-extension=${D_EXTENSION_DIST}`],
  });
  try {
    // Bound every action: a control that never becomes actionable fails the
    // step instead of waiting out the two-hour test budget.
    context.setDefaultTimeout(90_000);
    context.setDefaultNavigationTimeout(90_000);
    const relayGuard = await installRelayGuard(context, deps.pins);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const { page, resetBackend } = reuse
      ? await unlockProfile(context, extensionId, password)
      : { page: await importIntoProfile(context, extensionId, words, password), resetBackend: false };
    words.fill('');
    if (!reuse) writeFileSync(marker, 'imported\n', { mode: 0o600 });
    if (resetBackend) {
      appendFinding(
        'wallet setup',
        'note',
        `${name}: an earlier worker of this run left the wallet on another backend; it was reset to the default backend before any test`,
      );
    }
    await assertRelayGuardAttached(page, relayGuard);
    // Dialogs: identity actions use window.confirm; tests accept them
    // explicitly, and anything else is dismissed (Playwright's default).
    const footage = new DFootage(name, page, {
      dir: deps.recordRoot ? join(deps.recordRoot, name) : null,
      canary: deps.canary,
      guard: deps.guard,
      shortHolds: deps.shortHolds,
    });
    // Every password step: the screen held static before the field entry, then
    // the redaction card for the typing, a held pre-tap pause and the tap, and
    // recording resumes only after the guard passes clean twice.
    const enterPassword = async (input: Locator, submit: Locator, label: string, done: () => Promise<void>) => {
      await footage.beforeTap('enter the password');
      await footage.secret(label, async () => {
        await input.fill(password);
        await footage.beforeTap(label);
        await submit.click();
        await done();
      });
    };
    const wallet: DWallet = {
      name,
      context,
      page,
      extensionId,
      npub,
      pubkeyHex,
      footage,
      relayGuard,
      linked: null,
      async unlock() {
        const input = page.getByTestId('lockscreen-password-input');
        if (!(await input.isVisible().catch(() => false))) return;
        await enterPassword(input, page.getByTestId('lockscreen-unlock-btn'), 'unlock the wallet', async () => {
          // Home, or the bootstrap-error screen when the chosen backend refuses.
          await expect(page.getByTestId('bottom-nav').or(page.getByTestId('bootstrap-error'))).toBeVisible({
            timeout: 120_000,
          });
        });
        await footage.settled('wallet unlocked');
      },
      async confirmOperationPassword() {
        const input = page.getByTestId('operation-password');
        if (!(await input.isVisible().catch(() => false))) return;
        await enterPassword(input, page.getByTestId('operation-password-confirm'), 'confirm with the password', async () => {
          await input.waitFor({ state: 'hidden', timeout: 60_000 });
        });
      },
      async unlockHub() {
        const input = page.getByTestId('nostr-unlock-input');
        if (!(await input.isVisible().catch(() => false))) return;
        await enterPassword(input, page.getByTestId('nostr-unlock-submit'), 'unlock identity management', async () => {
          await input.waitFor({ state: 'hidden', timeout: 60_000 });
        });
      },
    };
    return wallet;
  } catch (error) {
    words.fill('');
    await context.close().catch(() => {});
    throw error;
  }
}

type DFixtures = { dPacing: void };
type DWorkerFixtures = { dWallets: DWallets };

export const test = privateTest.extend<DFixtures, DWorkerFixtures>({
  dWallets: [
    async ({}, use) => {
      let guard: Awaited<ReturnType<typeof loadGuard>>;
      let readWalletPhrase: ReadWalletPhrase;
      let shortHolds: boolean;
      let recordRoot: string | null;
      try {
        guard = await loadGuard();
        readWalletPhrase = await loadCustody();
        shortHolds = holdsShortened();
        recordRoot = footageEnabled() ? footageRoot(runProfileDir().dir) : null;
        const expected = process.env.E2E_EXPECT_VERSION;
        if (expected && dExtensionVersion() !== expected) {
          throw new Error('live lane: EXTENSION_DIST is not the expected release version');
        }
      } catch (error) {
        // Nothing secret is loaded yet: the first line is safe to record.
        if (process.env.E2E_LIVE_DIAGNOSE === '1') {
          appendFinding('lane setup', 'failure', String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 300));
        }
        throw error;
      }
      const canary = new SecretCanary();
      const { dir: scratch, salt } = runProfileDir();
      const opened: DWallet[] = [];
      try {
        // Nothing secret is loaded yet; an unreadable backend refuses the lane.
        const pins = await relayPins();
        // Sequential: three concurrent restores against one backend would race
        // its sign-up checks for no benefit.
        for (const name of D_WALLET_NAMES) {
          try {
            opened.push(await openWallet(name, { readWalletPhrase, canary, scratch, salt, recordRoot, guard, shortHolds, pins }));
          } catch (error) {
            if (process.env.E2E_LIVE_DIAGNOSE === '1') {
              // Only the first line, and only after the known-secret canary and
              // the key patterns pass it. The lane's own messages are no
              // exception: an import failure quotes up to 240 characters of the
              // visible screen.
              const first = String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 700);
              const safe = !(canary.hit([first]) || /nsec1|[xtyz]prv|tip\/[^\s]*#/.test(first));
              appendFinding('wallet setup', 'failure', `${name}: ${safe ? first : '(withheld: it carries a secret)'}`);
            }
            throw error;
          }
        }
        // Recording starts only once all three wallets are on Home.
        for (const wallet of opened) wallet.footage.start();
        const [alice, bob, carol] = opened as [DWallet, DWallet, DWallet];
        await use({
          alice,
          bob,
          carol,
          all: opened,
          relayPins: opened[0]!.relayGuard.pins,
          chapter(label: string) {
            for (const wallet of opened) wallet.footage.mark(label);
          },
          watchSecret(value: string) {
            canary.addExact(value);
          },
          carriesSecret(text: string) {
            return canary.hit([text]);
          },
        });
      } finally {
        for (const wallet of opened) await wallet.footage.stop().catch(() => {});
        // Profiles stay for the next worker of this run; the config's global
        // teardown removes the run directory.
        for (const wallet of opened) await wallet.context.close().catch(() => {});
      }
    },
    { scope: 'worker', timeout: 45 * 60_000 },
  ],

  // After every passing test: every hold met the video policy. A shortened
  // selector-check run (no footage) is exempt by construction.
  //
  // `E2E_LIVE_DIAGNOSE=1` (off by default) records the FIRST LINE of a failure
  // in the findings file, so a long run can be triaged without the withheld
  // reporter output. Assertion messages here are static; Playwright puts
  // values only on later lines. A line that carries a known secret (canary) or
  // key-like text is withheld outright.
  dPacing: [
    async ({ dWallets }, use, testInfo) => {
      await use();
      if (testInfo.status === 'passed' && !holdsShortened()) {
        assertHoldsMeetPolicy(dWallets.all.map((w) => w.footage));
      }
      if (process.env.E2E_LIVE_DIAGNOSE === '1' && testInfo.status !== testInfo.expectedStatus) {
        for (const error of testInfo.errors) {
          const first = (error.message ?? '').split('\n')[0]!.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300);
          const unsafe = dWallets.carriesSecret(first) || /nsec1|[xtyz]prv|tip\/[^\s]*#/.test(first);
          const frame = (error.stack ?? '').match(/([\w.-]+\.(?:spec\.)?ts):(\d+)/);
          const where = frame ? `${frame[1]}:${frame[2]}` : 'unknown';
          // Breadcrumbs: each wallet's last hold (static labels).
          const trail = dWallets.all.map((w) => `${w.name}: ${w.footage.lastAction}`).join('; ');
          recordFinding('failure', `${where} ${unsafe ? '(first line withheld: it carries a secret)' : first} [last: ${trail}]`);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
