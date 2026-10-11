// What the private failure log may hold: shapes only, never values.
// Run: node --test packages/e2e/fixtures/failure-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PATH_WORDS,
  appendPrivateLog,
  errorClassOf,
  privateLogPath,
  requestShape,
  safeErrorClass,
  safeLabel,
  safeTestId,
  safeTestIds,
  shapeContext,
  shapeNetworkEntry,
} from './failure-record.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hex = () => randomBytes(32).toString('hex');
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const NPUB = 'npub1' + 'q'.repeat(58);
const XMR = '4' + 'A'.repeat(94);

/** Values a wallet test can hold, none of which may reach the log. */
function secrets() {
  const key = hex();
  return [key, PHRASE, NPUB, XMR, `https://smirk.cash/tip/x#k=${key.slice(0, 32)}`, `bc1q${key.slice(0, 38)}`, `${key.slice(0, 20)}@example.org`, '123456789'];
}

test('labels are kept only when static', () => {
  for (const ok of ['Open the home tab', 'Continue to review', 'recover alice: tap the Home tab', 'Wallet import: phrase and password entry (redacted)', 'Tip 1 of 3']) {
    assert.equal(safeLabel(ok), ok);
  }
  for (const value of secrets()) {
    assert.equal(safeLabel(value), null, value.slice(0, 12));
    assert.equal(safeLabel(`Send ${value}`), null, value.slice(0, 12));
  }
  for (const bad of ['', '  ', 'x'.repeat(200), 42, null, undefined, '<b>Send</b>', 'Send "quoted"']) assert.equal(safeLabel(bad), null);
});

test('test ids keep their names and lose their values', () => {
  const key = hex();
  assert.equal(safeTestId('send-review-submit'), 'send-review-submit');
  assert.equal(safeTestId('onboarding-import-word-11'), 'onboarding-import-word-11', 'a word index is a position, not a value');
  assert.equal(safeTestId(`nostr-identity-${key}`), 'nostr-identity-*');
  assert.equal(safeTestId('tip-detail-3f2a9b1c-4d2e-4a1b-9c3d-0123456789ab'), 'tip-detail-*');
  assert.equal(safeTestId('sent-tip-card-1234567'), 'sent-tip-card-*');
  assert.equal(safeTestId(safeTestId(`nostr-identity-${key}`)), 'nostr-identity-*', 'shaping is idempotent');
  for (const bad of ['two words', 'quote"', '<script>', '', 7, `${'a'.repeat(300)}`]) assert.equal(safeTestId(bad), null);
  for (const value of secrets()) {
    const shaped = safeTestIds([`row-${value}`, value]);
    for (const id of shaped) assert.equal(id.includes(value.slice(0, 16)), false, id);
  }
  assert.deepEqual(safeTestIds(['row-btc', 'row-btc', 'nav-home']), ['row-btc', 'nav-home'], 'de-duplicated, in order');
  assert.equal(safeTestIds(Array.from({ length: 500 }, (_, i) => `row-${i}-x`)).length <= 48, true, 'bounded');
});

test('an error class names the kind of failure and never quotes the message', () => {
  for (const value of secrets()) {
    const errors = [
      { message: `locator.fill: Timeout 60000ms exceeded.\nCall log:\n  - fill("${value}")`, stack: `TimeoutError: locator.fill: Timeout 60000ms exceeded.\n    at tap (/x/packages/e2e/fixtures/C-tips-footage.ts:425:18)` },
      { message: `Error: expect(locator).toHaveValue(expected) failed\n\nExpected: "x"\nReceived: "${value}"`, stack: 'Error: expect(locator).toHaveValue(expected) failed\n    at /x/tests/live/c-tips.live.spec.ts:154:9' },
      { message: `${value} setup failed`, stack: `Error: ${value}\n    at load (/x/fixtures/C-tips-live.ts:437:13)`, cause: { message: value, stack: `WalletRecoveryError: ${value}` } },
      { message: `Fixture "${value}" timeout of 1ms exceeded during setup.` },
      { value: `'${value}'` },
    ];
    for (const error of errors) {
      const shape = errorClassOf(error);
      assert.equal(JSON.stringify(shape).includes(value.slice(0, 12)), false, JSON.stringify(shape));
      assert.equal(JSON.stringify(safeErrorClass(shape)).includes(value.slice(0, 12)), false);
    }
  }
  const timeout = errorClassOf({ stack: 'TimeoutError: locator.click: Timeout 60000ms exceeded.\n    at tap (/x/fixtures/E-swaps-ui.ts:389:7)\n    at node:internal/process/task_queues:105:5' });
  assert.deepEqual(timeout, { name: 'TimeoutError', api: 'locator.click', kind: 'action timeout', at: 'E-swaps-ui.ts:389' });
  // Playwright colours its matcher hints; the colour codes are not part of the shape.
  const coloured = errorClassOf({ message: 'Error: expect(\u001b[31mlocator\u001b[39m).toBeVisible\u001b[2m()\u001b[22m failed', stack: 'Error: x\n    at /x/a.spec.ts:3:1' });
  assert.equal(coloured.matcher, 'toBeVisible');
  assert.equal(coloured.at, 'a.spec.ts:3');
  const hinted = errorClassOf({ message: 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoBeVisible\u001b[2m()\u001b[22m failed' });
  assert.equal(hinted.matcher, 'toBeVisible');
  assert.equal(errorClassOf({ message: 'Test timeout of 600000ms exceeded.' }).kind, 'test timeout');
  assert.equal(errorClassOf({ message: 'Fixture "tipLane" timeout of 3600000ms exceeded during setup.' }).fixture, 'tipLane setup');
  assert.equal(errorClassOf({ message: 'page.goto: net::ERR_CONNECTION_REFUSED at https://x' }).code, 'net::ERR_CONNECTION_REFUSED');
  const wrapped = errorClassOf({ message: 'alice setup failed: y', stack: 'Error: alice setup failed: y', cause: { stack: 'WalletRecoveryError: alice: still not on Home' } });
  assert.equal(wrapped.cause?.name, 'WalletRecoveryError', 'one level of cause is classified');
  assert.deepEqual(safeErrorClass({ name: 'TimeoutError', api: 'locator.fill("x")', kind: 'anything', at: '/abs/path.ts:1', extra: 'x' }), { name: 'TimeoutError' });
});

test('a request keeps its method, host and route words, never ids, queries or credentials', () => {
  const key = hex();
  assert.deepEqual(requestShape(`https://user:${key}@api.smirk.cash/api/v1/tips/social/${key}/claim?key=${key}#k=${key}`), {
    scheme: 'https', host: 'api.smirk.cash', path: '/api/v1/tips/social/:x/claim',
  });
  assert.equal(requestShape('http://127.0.0.1:8085/api/v1/users/by-username/alice').path, '/api/v1/users/by-username/:x', 'a username is a value');
  assert.equal(requestShape(`https://mempool.space/api/address/bc1q${key.slice(0, 38)}/utxo`).path, '/api/address/:x/utxo');
  assert.equal(requestShape('wss://relay.example.org/').path, '/');
  for (const url of ['chrome-extension://abc/popup.html', 'data:text/plain,x', 'blob:https://x/1', 'not a url']) assert.equal(requestShape(url), null);
  for (const value of secrets()) {
    const shape = requestShape(`https://api.smirk.cash/api/v1/${encodeURIComponent(value)}?q=${encodeURIComponent(value)}`);
    assert.equal(JSON.stringify(shape).includes(value.slice(0, 12)), false);
  }
  assert.equal(shapeNetworkEntry({ method: 'GET', scheme: 'https', host: 'api.smirk.cash', path: `/api/v1/${key}` }), null, 'a path the shaper did not write is refused');
  assert.equal(shapeNetworkEntry({ method: 'BREW', scheme: 'https', host: 'x', path: '/' }), null);
});

test('every backend route word is in the vocabulary, so the log keeps the backend routes', () => {
  const spec = JSON.parse(readFileSync(join(here, '..', '..', 'core', 'openapi.json'), 'utf8'));
  const words = Object.keys(spec.paths).flatMap((path) => path.split('/').filter((segment) => segment && !segment.startsWith('{')));
  const missing = [...new Set(words)].filter((word) => !PATH_WORDS.has(word));
  assert.deepEqual(missing, [], 'add these words to BACKEND_WORDS in failure-record.mjs');
});

test('a context is reshaped field by field, and anything outside the shapes is dropped', () => {
  const smuggled = secrets();
  const raw = {
    errors: [{ name: 'TimeoutError', api: 'locator.click', at: 'C-tips-live.ts:220', message: smuggled[0] }, { name: smuggled[1] }],
    steps: [{ label: 'Open the home tab', ago: 10 }, { label: smuggled[0] }, { label: smuggled[1], ago: 3 }],
    screens: [{ wallet: 'alice', page: 'wallet', testIds: ['send-review-submit', `row-${smuggled[0]}`, smuggled[1]], text: smuggled[2] }],
    network: [
      { method: 'GET', scheme: 'https', host: 'api.smirk.cash', path: '/api/v1/tips/:x', status: 200, ms: 31, ago: 400, wallet: 'alice', headers: smuggled[0] },
      { method: 'POST', scheme: 'https', host: 'api.smirk.cash', path: `/api/v1/${smuggled[0]}` },
    ],
    recoveries: [{ wallet: 'bob', reached: 'home', from: ['tip-success-heading', `x-${smuggled[0]}`], moves: ['close the tip result', smuggled[4]], kept: smuggled[1], ms: 900 }],
    page: smuggled[3],
    message: smuggled.join(' '),
  };
  const shaped = shapeContext(raw);
  const text = JSON.stringify(shaped);
  for (const value of smuggled) assert.equal(text.includes(value.slice(0, 12)), false, value.slice(0, 12));
  assert.deepEqual(Object.keys(shaped).sort(), ['errors', 'network', 'recoveries', 'screens', 'steps']);
  assert.equal(shaped.errors[0].api, 'locator.click');
  assert.deepEqual(shaped.steps.map((s) => s.label), ['Open the home tab']);
  assert.deepEqual(shaped.screens[0].testIds, ['send-review-submit', 'row-*']);
  assert.equal(shaped.network.length, 1);
  assert.deepEqual(shaped.recoveries[0].moves, ['close the tip result']);
  assert.equal(shapeContext(null).errors, undefined);
  assert.deepEqual(shapeContext('not an object'), {});
});

test('the private log is owner-only, beside the run when named, under ~/Build otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smirk-private-log-'));
  try {
    const path = join(dir, 'logs', 'run.jsonl');
    appendPrivateLog(path, { type: 'failure', test: 'a.spec.ts:1' });
    appendPrivateLog(path, { type: 'recovery', test: 'a.spec.ts:2' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).type), ['failure', 'recovery']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(privateLogPath({ E2E_PRIVATE_LOG: '/run/logs/C-1.private.jsonl' }, 'C-tips.live.config.ts'), '/run/logs/C-1.private.jsonl');
  assert.match(privateLogPath({}, '/x/C-tips.live.config.ts', new Date(0)), /Build\/smirk-e2e\/private-logs\/1970-01-01T00-00-00-000Z-C-tips\.live\.config-\d+\.jsonl$/);
});
