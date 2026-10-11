/**
 * What a wallet E2E failure may say about itself, and nothing more.
 *
 * The private reporter withholds every error message, call log, assertion
 * value and snapshot, because any of them can quote a phrase word, a
 * password, a key or a claim link. That left failures unexplainable after the
 * run. This module defines the explanation that is safe to keep: each field is
 * built from an allowlist of shapes, never copied from free text.
 *
 *   error class   the error's class name, the Playwright call or matcher that
 *                 failed (`locator.click`, `toBeVisible`), a fixed category
 *                 (action timeout, test timeout, target closed, ...), a network
 *                 error code, and the file and line that threw. Never the message.
 *   step label    the static label of the lane step that was running (the
 *                 footage labels the lanes already restrict to static words),
 *                 re-checked here; anything value-like is dropped.
 *   screen        the data-testid values visible on each wallet page, with any
 *                 id-like part (uuid, hex, key, address, long number) replaced
 *                 by `*`. Never text, never input values.
 *   network       method, scheme, host, a path template (every segment that is
 *                 not a known route word becomes `:x`), status and timing of
 *                 recent requests. Never query strings, fragments, headers or
 *                 bodies.
 *   recoveries    where a reopened wallet started, by screen ids, and the
 *                 static moves that brought it Home.
 *
 * The worker builds these (fixtures/failure-context.ts) and the reporter
 * passes everything through `shapeContext` again before writing it, so a
 * fixture bug cannot widen what reaches the log. The log is a JSON-lines file,
 * 0600 in a 0700 directory, never uploaded.
 *
 * Why not Playwright traces: with screenshots and snapshots off, a trace still
 * records every call's parameters (the values `fill` typed, so passwords and
 * phrase words) and results (what `textContent` read, so claim links), every
 * console message with its arguments, and dialogs. Its network log exists only
 * with snapshots on, and then keeps headers (the bearer token) and response
 * bodies. No option keeps step names without those, so traces stay off and
 * this record carries the safe part. scripts/test-private-capture.mjs proves
 * both halves against the installed Playwright.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The attachment a worker hands the reporter: JSON, already shaped. */
export const CONTEXT_ATTACHMENT = 'smirk-private-context';

/** Upper bounds on how much of each kind one record keeps. */
export const LIMITS = Object.freeze({ testIds: 48, steps: 8, network: 30, screens: 8, recoveries: 6, moves: 16, errors: 4 });

// ── Labels ───────────────────────────────────────────────────────────────────

const LABEL_SHAPE = /^[A-Za-z][A-Za-z0-9 ,.:;()'/&+#-]{0,119}$/;
const VALUE_LIKE = /:\/\/|@|npub1|nsec1|[0-9a-fA-F]{16,}|[A-Za-z0-9]{24,}|\d{5,}/;

/**
 * A static label, or null. Rejects anything with the shape of a value: a URL,
 * an address or handle, a key or hash, a long number, and twelve or more bare
 * lowercase words in a row, which is what a recovery phrase looks like.
 */
export function safeLabel(label) {
  if (typeof label !== 'string') return null;
  const text = label.trim().replace(/\s+/g, ' ');
  if (!LABEL_SHAPE.test(text) || VALUE_LIKE.test(text)) return null;
  const words = text.split(' ');
  let run = 0;
  for (const word of words) {
    run = /^[a-z]{3,12}$/.test(word) ? run + 1 : 0;
    if (run >= 12) return null;
  }
  return text;
}

// ── Screen test ids ──────────────────────────────────────────────────────────

/**
 * A data-testid with every id-like part replaced by `*`, or null when the
 * attribute is not a plain identifier at all. `tip-detail-<uuid>` becomes
 * `tip-detail-*`, `nostr-identity-<hex key>` becomes `nostr-identity-*`.
 */
export function safeTestId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  // `*` is allowed in, so shaping an already shaped id is a no-op.
  if (!/^[A-Za-z0-9_.:*-]+$/.test(id)) return null;
  const shaped = id
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
    .replace(/[A-Za-z0-9]{16,}/g, '*')
    .replace(/[0-9a-fA-F]{8,}/g, '*')
    .replace(/\d{3,}/g, '*')
    .replace(/\*(?:[-_.:]?\*)+/g, '*');
  return shaped.length <= 96 && /[A-Za-z]{2,}/.test(shaped) ? shaped : null;
}

/** Shaped, de-duplicated test ids in screen order, at most `limit`. */
export function safeTestIds(ids, limit = LIMITS.testIds) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const shaped = safeTestId(id);
    if (shaped && !out.includes(shaped)) out.push(shaped);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Errors ───────────────────────────────────────────────────────────────────

const CLASS_NAME = '[A-Z][A-Za-z0-9]{0,47}(?:Error|Exception|Refusal)';
const API_NAME =
  '(?:locator|page|frame|frameLocator|browserContext|browser|browserType|elementHandle|jsHandle|keyboard|mouse|touchscreen|request|response|route|webSocket|worker|apiRequestContext)\\.[a-z][A-Za-z]{0,39}';
const MATCHER_NAME = '(?:not\\.)?to[A-Z][A-Za-z]{0,39}';
const NET_CODE_NAME = '(?:net::ERR_[A-Z_]{2,48}|NS_ERROR_[A-Z_]{2,48}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)';
const NAME = new RegExp(`^(${CLASS_NAME})(?=[:\\s]|$)`);
const API = new RegExp(`\\b(${API_NAME})(?=[:(])`);
const MATCHER = new RegExp(`\\bexpect(?:\\.(?:poll|soft))?\\([A-Za-z]{0,16}\\)\\.(${MATCHER_NAME})\\(`);
const NET_CODE = new RegExp(`\\b(${NET_CODE_NAME})\\b`);
const FIXTURE = /Fixture "([A-Za-z_$][A-Za-z0-9_$]{0,40})" timeout of \d+ms exceeded during (setup|teardown)/;
const KINDS = [
  [/Test timeout of \d+ms exceeded/, 'test timeout'],
  [/Fixture "[^"\n]{0,60}" timeout/, 'fixture timeout'],
  [/Worker teardown timeout/, 'worker teardown timeout'],
  [/Timeout \d+ms exceeded while waiting on the predicate/, 'poll timeout'],
  [/Timeout \d+ms exceeded/, 'action timeout'],
  [/strict mode violation/, 'strict mode violation'],
  [/intercepts pointer events/, 'tap intercepted'],
  [/element is not (?:visible|enabled|editable|stable|attached)|not attached to the DOM/, 'not actionable'],
  [/Target page, context or browser has been closed|Target closed|Browser has been closed|has been closed/, 'target closed'],
  [/Execution context was destroyed/, 'page navigated during a call'],
  [/net::ERR_|NS_ERROR_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/, 'network error'],
];

/** `file.ts:123` for a location object or a stack frame, basename only. */
export function locationLabel(location) {
  return location && typeof location === 'object' ? shortLocation(location.file, location.line) : null;
}

function shortLocation(file, line) {
  if (typeof file !== 'string' || !Number.isInteger(line)) return null;
  const name = basename(file.replace(/[?#].*$/, ''));
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? `${name}:${line}` : null;
}

/** The first stack frame in the suite's own code (not node_modules, not node internals). */
function throwSite(stack) {
  if (typeof stack !== 'string') return null;
  for (const line of stack.split('\n').slice(1, 40)) {
    const frame = line.match(/\(?((?:file:\/\/)?\/[^():\s]+|[A-Za-z]:\\[^():]+|[a-z-]+:\/\/[^():\s]+):(\d+):\d+\)?\s*$/);
    if (!frame) continue;
    const file = frame[1];
    if (/node_modules|^node:|[\\/]internal[\\/]/.test(file)) continue;
    return shortLocation(file, Number(frame[2]));
  }
  return null;
}

/**
 * What kind of failure an error was, from fixed shapes only. Accepts a
 * TestInfoError or reporter TestError (message, stack, value, location) or an
 * Error. Never returns any part of the message itself.
 */
export function errorClassOf(error, depth = 0) {
  if (error === null || error === undefined) return { name: 'unknown' };
  if (typeof error !== 'object') return { name: 'thrown value' };
  // Playwright colours its messages; the shapes are matched on plain text.
  const plain = (value) => (typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/g, '') : '');
  const stack = plain(error.stack);
  const message = plain(error.message);
  const text = `${message}\n${stack}`;
  const firstLine = (stack || message).split('\n')[0] ?? '';
  const out = {};
  const ownName = typeof error.name === 'string' && error.name !== 'Error' ? error.name.match(NAME)?.[1] : undefined;
  const name = ownName ?? firstLine.match(NAME)?.[1];
  out.name = name ?? (message || stack ? 'Error' : typeof error.value === 'string' ? 'thrown value' : 'unknown');
  const api = text.match(API)?.[1];
  if (api && !VALUE_LIKE.test(api)) out.api = api;
  const matcher = text.match(MATCHER)?.[1];
  if (matcher && !VALUE_LIKE.test(matcher)) out.matcher = matcher;
  const kind = KINDS.find(([pattern]) => pattern.test(text))?.[1];
  if (kind) out.kind = kind;
  const fixture = text.match(FIXTURE);
  if (fixture && !VALUE_LIKE.test(fixture[1])) out.fixture = `${fixture[1]} ${fixture[2]}`;
  const code = text.match(NET_CODE)?.[1];
  if (code) out.code = code;
  // Where it threw (the deepest frame of the suite's own code), else where the test saw it.
  const at = throwSite(stack) ?? (error.location ? shortLocation(error.location.file, error.location.line) : null);
  if (at) out.at = at;
  // A lane that wraps an error keeps the original as its cause: one level is classified too.
  if (depth === 0 && error.cause && typeof error.cause === 'object') out.cause = errorClassOf(error.cause, 1);
  return out;
}

/** One line for a console: the class, call or matcher, kind and place. */
export function describeErrorClass(shape) {
  const parts = [shape.name, shape.api ?? shape.matcher, shape.kind && `(${shape.kind})`, shape.fixture && `fixture ${shape.fixture}`, shape.code, shape.at && `at ${shape.at}`];
  if (shape.cause) parts.push(`caused by ${describeErrorClass(shape.cause)}`);
  return parts.filter(Boolean).join(' ');
}

const ERROR_FIELDS = Object.freeze({
  name: new RegExp(`^(?:${CLASS_NAME}|Error|thrown value|unknown)$`),
  api: new RegExp(`^${API_NAME}$`),
  matcher: new RegExp(`^${MATCHER_NAME}$`),
  kind: new RegExp(`^(?:${KINDS.map(([, kind]) => kind).join('|')})$`),
  fixture: /^[A-Za-z_$][A-Za-z0-9_$]{0,40} (?:setup|teardown)$/,
  code: new RegExp(`^${NET_CODE_NAME}$`),
  at: /^[A-Za-z0-9_.-]{1,80}:\d{1,6}$/,
});

/** An error class as the reporter re-checks it: known fields of known shapes only. */
export function safeErrorClass(shape, depth = 0) {
  const out = {};
  if (!shape || typeof shape !== 'object') return { name: 'unknown' };
  for (const [field, pattern] of Object.entries(ERROR_FIELDS)) {
    const value = shape[field];
    if (typeof value === 'string' && pattern.test(value) && (field === 'at' || field === 'code' || !VALUE_LIKE.test(value))) out[field] = value;
  }
  out.name ??= 'unknown';
  if (depth === 0 && shape.cause) out.cause = safeErrorClass(shape.cause, 1);
  return out;
}

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * Path words the log may keep: the backend's own route words (every static
 * segment of core/openapi.json, which failure-record.test.mjs keeps in step)
 * and the fixed route words of the third-party APIs the wallet calls. Any
 * other segment, however plain it looks (a username is a plain word too), is
 * written as `:x`. A list, not a file read: Playwright loads this module
 * through its CommonJS transform, where the module cannot locate itself.
 */
const BACKEND_WORDS = [
  '.well-known', 'activate', 'address', 'assets', 'attach-funding', 'auth', 'balance', 'balance_multi', 'broadcast',
  'by-username', 'cancel', 'capabilities', 'challenge', 'check-restore', 'claim', 'claimable', 'clawback', 'confirm-sweep',
  'confirmations', 'create', 'extension', 'fee', 'finalize', 'get', 'grin', 'health', 'height', 'heights', 'history',
  'history_multi', 'invoice', 'keys', 'legacy-merge', 'link', 'link-challenge', 'logout', 'lws', 'me', 'nonlogs', 'nostr',
  'nostr.json', 'orderbook', 'payment-invoice', 'pending', 'pow-challenge', 'premium', 'prices', 'provision_subaddrs',
  'public', 'quote', 'random_outs', 'received', 'refresh', 'register', 'register-challenge', 'relay', 'respond', 'scan',
  'sent', 'social', 'status', 'submit_tx', 'swaps', 'tip', 'tips', 'unspent_outs', 'user', 'username', 'users', 'utxo',
  'utxos', 'utxos_multi', 'verify', 'wallet', 'website',
];

const THIRD_PARTY_WORDS = [
  'api', 'v1', 'v2', 'v3',
  // Esplora (mempool.space, blockstream) and similar explorers
  'address', 'addresses', 'tx', 'txs', 'utxo', 'blocks', 'block', 'tip', 'height', 'hash', 'mempool', 'fee-estimates', 'fees', 'recommended', 'raw', 'hex', 'outspends', 'chain',
  // Light wallet servers (Monero, Wownero)
  'get_address_info', 'get_address_txs', 'get_unspent_outs', 'get_random_outs', 'submit_raw_tx', 'login', 'import_wallet_request', 'get_subaddrs', 'upsert_subaddrs',
  // THORChain, Trocador, NonLogs, prices
  'thorchain', 'quote', 'swap', 'inbound_addresses', 'pool', 'pools', 'new_rate', 'new_trade', 'trade', 'coins', 'simple', 'price',
  // NIP-05
  '.well-known', 'nostr.json',
];

/** Every path word requestShape keeps. */
export const PATH_WORDS = Object.freeze(new Set([...BACKEND_WORDS, ...THIRD_PARTY_WORDS]));
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT']);
const SCHEMES = new Set(['http', 'https', 'ws', 'wss']);
const HOST = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$|^\[[0-9a-fA-F:]{2,39}\](?::\d{1,5})?$/;
const FAILURE = /^(?:net::ERR_[A-Z_]{2,48}|NS_ERROR_[A-Z_]{2,48}|aborted|failed)$/;

/**
 * The shape of a URL: scheme, host and a path template, or null for anything
 * that is not http(s) or ws(s). Query, fragment and credentials are dropped;
 * a path segment survives only as a known route word (`api`, `v1`, `tips`,
 * `claim`); anything else (ids, keys, addresses, amounts, usernames) is `:x`.
 */
export function requestShape(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!SCHEMES.has(scheme) || !HOST.test(parsed.host)) return null;
  const segments = parsed.pathname.split('/').filter(Boolean).slice(0, 12).map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return ':x';
    }
    return PATH_WORDS.has(decoded) ? decoded : ':x';
  });
  return { scheme, host: parsed.host.toLowerCase(), path: `/${segments.join('/')}` };
}

/** A path template as requestShape writes it: vocabulary words and `:x` only. */
function isPathTemplate(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 400) return false;
  const segments = path.slice(1).split('/');
  if (segments.length === 1 && segments[0] === '') return true;
  return segments.length <= 12 && segments.every((segment) => segment === ':x' || PATH_WORDS.has(segment));
}
const WALLET_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;

const finiteInt = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : undefined);

/** One network entry as the log keeps it, or null. */
export function shapeNetworkEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const method = typeof entry.method === 'string' && METHODS.has(entry.method) ? entry.method : null;
  const scheme = SCHEMES.has(entry.scheme) ? entry.scheme : null;
  const host = typeof entry.host === 'string' && HOST.test(entry.host) ? entry.host : null;
  const path = isPathTemplate(entry.path) ? entry.path : null;
  if (!method || !scheme || !host || !path) return null;
  const out = { method, scheme, host, path };
  const wallet = typeof entry.wallet === 'string' && WALLET_NAME.test(entry.wallet) ? entry.wallet : undefined;
  if (wallet) out.wallet = wallet;
  const status = finiteInt(entry.status, 999);
  if (status !== undefined) out.status = status;
  const ms = finiteInt(entry.ms, 24 * 3_600_000);
  if (ms !== undefined) out.ms = ms;
  const ago = finiteInt(entry.ago, 7 * 24 * 3_600_000);
  if (ago !== undefined) out.ago = ago;
  if (typeof entry.failure === 'string' && FAILURE.test(entry.failure)) out.failure = entry.failure;
  return out;
}

// ── One context record ───────────────────────────────────────────────────────

const PAGE_KIND = /^(?:wallet|approval|site|local|blank|other)$/;
const SURFACE = /^(?:home|locked|onboarding|bootstrap-error)$/;

function shapeScreen(screen) {
  if (!screen || typeof screen !== 'object') return null;
  const wallet = typeof screen.wallet === 'string' && WALLET_NAME.test(screen.wallet) ? screen.wallet : null;
  const page = typeof screen.page === 'string' && PAGE_KIND.test(screen.page) ? screen.page : 'other';
  if (!wallet) return null;
  return { wallet, page, testIds: safeTestIds(screen.testIds) };
}

function shapeRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object') return null;
  const wallet = typeof recovery.wallet === 'string' && WALLET_NAME.test(recovery.wallet) ? recovery.wallet : null;
  if (!wallet) return null;
  const out = { wallet };
  if (typeof recovery.reached === 'string' && SURFACE.test(recovery.reached)) out.reached = recovery.reached;
  if (Array.isArray(recovery.from)) out.from = safeTestIds(recovery.from, 16);
  out.moves = (Array.isArray(recovery.moves) ? recovery.moves : []).map(safeLabel).filter(Boolean).slice(0, LIMITS.moves);
  const kept = safeLabel(recovery.kept);
  if (kept) out.kept = kept;
  const ms = finiteInt(recovery.ms, 3_600_000);
  if (ms !== undefined) out.ms = ms;
  if (recovery.failed === true) out.failed = true;
  return out;
}

/**
 * Everything a worker may hand the reporter, shaped. Unknown fields are
 * dropped; known ones keep only their allowed shapes.
 */
export function shapeContext(raw) {
  const context = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (Array.isArray(context.errors)) out.errors = context.errors.slice(0, LIMITS.errors).map(safeErrorClass);
  if (Array.isArray(context.steps)) {
    out.steps = context.steps
      .map((step) => {
        const label = safeLabel(step?.label);
        if (!label) return null;
        const ago = finiteInt(step.ago, 7 * 24 * 3_600_000);
        return ago === undefined ? { label } : { label, ago };
      })
      .filter(Boolean)
      .slice(-LIMITS.steps);
  }
  if (Array.isArray(context.screens)) out.screens = context.screens.map(shapeScreen).filter(Boolean).slice(0, LIMITS.screens);
  if (Array.isArray(context.network)) out.network = context.network.map(shapeNetworkEntry).filter(Boolean).slice(-LIMITS.network);
  if (Array.isArray(context.recoveries)) out.recoveries = context.recoveries.map(shapeRecovery).filter(Boolean).slice(0, LIMITS.recoveries);
  return out;
}

// ── The private log ──────────────────────────────────────────────────────────

/**
 * Where this invocation's private log goes: E2E_PRIVATE_LOG when set (the
 * v0.3.1 runner puts it beside the phase log), else a new file under
 * ~/Build/smirk-e2e/private-logs named by the time and the config.
 */
export function privateLogPath(env = process.env, configFile = '', now = new Date()) {
  if (env.E2E_PRIVATE_LOG) return env.E2E_PRIVATE_LOG;
  const config = basename(configFile || 'playwright.config.ts').replace(/\.(?:[cm]?[jt]s)$/, '').replace(/[^A-Za-z0-9_.-]+/g, '-');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(homedir(), 'Build', 'smirk-e2e', 'private-logs', `${stamp}-${config}-${process.pid}.jsonl`);
}

/** Append one record as a JSON line: the directory 0700, the file 0600. */
export function appendPrivateLog(path, record) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
