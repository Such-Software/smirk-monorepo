// What the private failure log may hold: shapes only, never values.
// Run: node --test packages/e2e/fixtures/failure-record.test.mjs
//
// Every no-leak check runs over leak-probes.mjs: a phrase in every case and
// separator, whole or in part, passwords of the shapes people and the lanes
// use, keys, addresses and links. A probe counts as leaked when any piece of
// it appears in any case, not only its first characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { PHRASE_WORDS } from './phrase-words.mjs';
import { leaked, mixedToken, phraseForms, probes, randomPhrase } from './leak-probes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hex = () => randomBytes(32).toString('hex');

/** Labels and titles the lanes use today, of every token shape the allowlist admits. */
const LANE_LABELS = [
  'Open the home tab',
  'Continue to review',
  'recover alice: tap the Home tab',
  'Wallet import: phrase and password entry (redacted)',
  'Tip 1 of 3',
  'label withheld',
  'signed in on smirk.cash',
  'v0.2.4 wallet detected, migration offered',
  'reseal + BTC/LTC sweep + Nostr identity done',
  "THORChain's quote and the wallet's own address",
  'Grin send accepts an npub + a NIP-05 name as recipient (federation)',
  'migrated pre-v0.3 import signs in to its existing account',
  'F2 scan registers unwatched older Monero and Wownero addresses with the server',
  'a local dummy origin cannot get a smirk.cash challenge signed (#27)',
  // The longest run of phrase words in any lane label or title: five.
  'NonLogs: asset list, order-book quote, slippage warning and the own-address check',
];

test('labels are kept only when every token has an allowed shape', () => {
  for (const ok of LANE_LABELS) assert.equal(safeLabel(ok), ok, 'a lane label is kept whole');
  for (const probe of probes()) {
    for (const label of [probe.value, `Send ${probe.value}`, `unlock with ${probe.value}`, `${probe.value} (redacted)`]) {
      assert.equal(safeLabel(label), null, `${probe.name} is withheld`);
    }
  }
  for (const bad of ['', '  ', 'x'.repeat(200), 42, null, undefined, '<b>Send</b>', 'Send "quoted"', 'tap a/b', 'id ab12cd', 'Pay alice.bob']) {
    assert.equal(safeLabel(bad), null);
  }
});

test('a recovery phrase never passes as a label, in any case or separator, whole or six words of it', () => {
  for (let draw = 0; draw < 200; draw++) {
    for (const [form, value] of Object.entries(phraseForms(randomPhrase()))) {
      assert.equal(safeLabel(value), null, form);
      assert.equal(safeLabel(`Step 3: ${value}`), null, form);
    }
  }
});

test("the phrase word list is the wallet's own BIP-39 list, word for word", async () => {
  // Resolved from packages/core, which declares @scure/bip39 and draws phrases from it (src/hd.ts).
  const fromCore = createRequire(join(here, '..', '..', 'core', 'package.json'));
  const { wordlist } = await import(pathToFileURL(fromCore.resolve('@scure/bip39/wordlists/english.js')).href);
  assert.equal(PHRASE_WORDS.size, 2048);
  assert.deepEqual([...PHRASE_WORDS], [...wordlist]);
});

test('test ids keep their names and lose their values', () => {
  const key = hex();
  assert.equal(safeTestId('send-review-submit'), 'send-review-submit');
  assert.equal(safeTestId('send-custom-fee-rate-input'), 'send-custom-fee-rate-input', 'four phrase words in a row, the most an app id has');
  assert.equal(safeTestId('onboarding-import-word-11'), 'onboarding-import-word-11', 'a word index is a position, not a value');
  assert.equal(safeTestId(`nostr-identity-${key}`), 'nostr-identity-*');
  assert.equal(safeTestId('tip-detail-3f2a9b1c-4d2e-4a1b-9c3d-0123456789ab'), 'tip-detail-*');
  assert.equal(safeTestId('sent-tip-card-1234567'), 'sent-tip-card-*');
  assert.equal(safeTestId(safeTestId(`nostr-identity-${key}`)), 'nostr-identity-*', 'shaping is idempotent');
  for (const bad of ['two words', 'quote"', '<script>', '', 7, `${'a'.repeat(300)}`]) assert.equal(safeTestId(bad), null);
  for (const probe of probes().filter((p) => p.idShaped)) {
    const shaped = safeTestIds([`row-${probe.value}`, probe.value, `word-${probe.value.replace(/[^A-Za-z0-9]+/g, '-')}`]);
    assert.equal(leaked(shaped.join(' '), probe.parts), false, `${probe.name} in a test id`);
  }
  assert.deepEqual(safeTestIds(['row-btc', 'row-btc', 'nav-home']), ['row-btc', 'nav-home'], 'de-duplicated, in order');
  assert.equal(safeTestIds(Array.from({ length: 500 }, (_, i) => `row-${i}-x`)).length <= 48, true, 'bounded');
});

test('an error class names the kind of failure and never quotes the message', () => {
  for (const probe of probes()) {
    const value = probe.value;
    const errors = [
      { message: `locator.fill: Timeout 60000ms exceeded.\nCall log:\n  - fill("${value}")`, stack: `TimeoutError: locator.fill: Timeout 60000ms exceeded.\n    at tap (/x/packages/e2e/fixtures/C-tips-footage.ts:425:18)` },
      { message: `Error: expect(locator).toHaveValue(expected) failed\n\nExpected: "x"\nReceived: "${value}"`, stack: 'Error: expect(locator).toHaveValue(expected) failed\n    at /x/tests/live/c-tips.live.spec.ts:154:9' },
      { message: `${value} setup failed`, stack: `Error: ${value}\n    at load (/x/fixtures/C-tips-live.ts:437:13)`, cause: { message: value, stack: `WalletRecoveryError: ${value}` } },
      { message: `Fixture "${value}" timeout of 1ms exceeded during setup.` },
      { value: `'${value}'` },
      // Message lines that end like a frame: a call log, Expected and Received.
      {
        message: 'x',
        stack: `TimeoutError: locator.click: Timeout 1ms exceeded.\nCall log:\n  - navigated to "https://wallet.test/${value}:12:3"\n  - waiting for /tmp/${value}:12:3\nExpected: /${value}:4:5\nReceived: (/x/${value}:7:1)\n    at tap (/x/fixtures/E-swaps-ui.ts:389:7)`,
      },
    ];
    for (const error of errors) {
      const shape = errorClassOf(error);
      assert.equal(leaked(JSON.stringify(shape), probe.parts), false, `${probe.name} in an error class`);
      assert.equal(leaked(JSON.stringify(safeErrorClass(shape)), probe.parts), false, `${probe.name} in a re-checked error class`);
    }
    assert.equal(errorClassOf(errors.at(-1)).at, 'E-swaps-ui.ts:389', 'only an `at` frame names the place');
  }
  for (const at of [`${mixedToken(30)}:12`, `${hex()}.ts:3`, 'notes:12', 'claim.html:4']) {
    assert.equal(safeErrorClass({ name: 'Error', at }).at, undefined, 'a place is a source file and a line');
  }
  assert.equal(safeErrorClass({ name: 'Error', at: 'C-tips-live.ts:123456' }).at, 'C-tips-live.ts:123456', 'a long line number is still a place');
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
  for (const probe of probes()) {
    const value = encodeURIComponent(probe.value);
    const shape = requestShape(`https://api.smirk.cash/api/v1/${value}/${probe.value.replace(/[^A-Za-z0-9]+/g, '/')}?q=${value}`);
    assert.equal(leaked(JSON.stringify(shape), probe.parts), false, `${probe.name} in a request shape`);
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
  for (const probe of probes()) {
    const value = probe.value;
    const raw = {
      errors: [
        { name: 'TimeoutError', api: 'locator.click', at: 'C-tips-live.ts:220', message: value },
        { name: value, api: `locator.${value}`, kind: value, at: `${value}:12`, fixture: `${value} setup`, code: value },
      ],
      steps: [{ label: 'Open the home tab', ago: 10 }, { label: value }, { label: `Confirm ${value}`, ago: 3 }],
      screens: [{ wallet: 'alice', page: 'wallet', testIds: ['send-review-submit', ...(probe.idShaped ? [`row-${value}`, value] : [])], text: value }],
      network: [
        { method: 'GET', scheme: 'https', host: 'api.smirk.cash', path: '/api/v1/tips/:x', status: 200, ms: 31, ago: 400, wallet: 'alice', headers: value },
        { method: 'POST', scheme: 'https', host: 'api.smirk.cash', path: `/api/v1/${value}` },
      ],
      recoveries: [{ wallet: 'bob', reached: 'home', from: ['tip-success-heading', ...(probe.idShaped ? [`x-${value}`] : [])], moves: ['close the tip result', value, `type ${value}`], kept: value, ms: 900 }],
      page: value,
      message: value,
    };
    const shaped = shapeContext(raw);
    assert.equal(leaked(JSON.stringify(shaped), probe.parts), false, `${probe.name} in a shaped context`);
    assert.deepEqual(Object.keys(shaped).sort(), ['errors', 'network', 'recoveries', 'screens', 'steps']);
    assert.equal(shaped.errors[0].api, 'locator.click');
    assert.deepEqual(shaped.steps.map((s) => s.label), ['Open the home tab']);
    assert.equal(shaped.screens[0].testIds[0], 'send-review-submit');
    assert.equal(shaped.network.length, 1);
    assert.deepEqual(shaped.recoveries[0].moves, ['close the tip result']);
    assert.equal(shaped.recoveries[0].kept, undefined);
  }
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
