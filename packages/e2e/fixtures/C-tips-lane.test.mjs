// Offline checks of the C-tips lane's safety rails: the live gate, the ledger
// that keeps every funded tip findable after a failure, the sweep-report shape
// per coin, and the skip guard's lane-chosen skips. No browser, no backend.
//
//   node --import tsx --test packages/e2e/fixtures/C-tips-lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveGateReason } from './C-tips-live.ts';
import { TipLedger } from './C-tips-ledger.ts';
import { sweepTxidShape } from './C-tips-actions.ts';
import SkipGuardReporter from '../skip-guard-reporter.ts';

test('the live gate stays closed until every opt-in is set, requires recording, and refuses HEADED', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c-tips-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const custody = join(dir, 'wallets.env');
  writeFileSync(custody, '', { mode: 0o600 });
  const open = {
    C_TIPS_INVOCATION: 'gate-test-1',
    E2E_LIVE: '1',
    E2E_LIVE_MONEY: '1',
    SMOKE_WALLET_FILE: custody,
    FOOTAGE: 'guarded',
  };
  assert.equal(liveGateReason(open), null);
  const without = (name) => Object.fromEntries(Object.entries(open).filter(([k]) => k !== name));
  assert.match(liveGateReason(without('C_TIPS_INVOCATION')), /C-tips\.live\.config\.ts/);
  assert.match(liveGateReason(without('E2E_LIVE')), /E2E_LIVE=1/);
  assert.match(liveGateReason(without('E2E_LIVE_MONEY')), /REAL FUNDS/);
  assert.match(liveGateReason(without('FOOTAGE')), /FOOTAGE=guarded/, 'an unrecorded release run is refused');
  assert.match(liveGateReason({ ...open, FOOTAGE: 'off' }), /FOOTAGE=guarded/);
  assert.match(liveGateReason({ ...open, HEADED: '1' }), /HEADED is refused/);
  assert.match(liveGateReason({ ...open, SMOKE_WALLET_FILE: join(dir, 'missing') }), /custody file/);
});

test('the ledger records a tip once, refuses a second tip for one plan, and survives a new reader', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c-tips-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tip = {
    key: 'link:alice-btc',
    tipId: '11111111-2222-4333-8444-555555555555',
    asset: 'btc',
    amount: '0.00003',
    sender: 'alice',
    expiryDays: 7,
    submittedAtMs: 1,
  };
  const first = new TipLedger(dir, 'run', 'inv-a');
  first.record(tip);
  first.record(tip); // the response handler and the success path both record: a no-op
  assert.equal(first.tips().length, 1);
  assert.throws(() => first.record({ ...tip, tipId: '99999999-2222-4333-8444-555555555555' }), /never pays for one plan twice/);
  assert.equal(statSync(join(dir, 'ledger.json')).mode & 0o777, 0o600);
  // A restarted worker of the same invocation sees the tip; a later invocation inherits it.
  assert.equal(new TipLedger(dir, 'run', 'inv-a').tip('link:alice-btc')?.tipId, tip.tipId);
  const later = new TipLedger(dir, 'run', 'inv-b');
  assert.deepEqual(later.inheritedTips().map((x) => x.key), ['link:alice-btc']);
  assert.deepEqual(later.tips('npub:'), []);
  // Never a link, key or password: only plan facts.
  const text = readFileSync(join(dir, 'ledger.json'), 'utf8');
  assert.equal(/#|nsec|password/i.test(text), false);
});

test('a sweep report txid has the coin\'s shape: 32 bytes, or a 33-byte Grin kernel excess', () => {
  const hash = 'ab'.repeat(32);
  const excess = '08' + 'cd'.repeat(32);
  for (const asset of ['btc', 'ltc', 'xmr', 'wow']) {
    assert.equal(sweepTxidShape(asset).test(hash), true, asset);
    assert.equal(sweepTxidShape(asset).test(excess), false, asset);
  }
  assert.equal(sweepTxidShape('grin').test(excess), true, 'a GRIN claim reports the kernel excess');
  assert.equal(sweepTxidShape('grin').test(hash), false);
});

test('the skip guard excuses only skips whose reason the lane config names, and still fails on the rest', async () => {
  const quiet = console.error;
  const said = [];
  console.error = (m) => said.push(String(m));
  const log = console.log;
  console.log = (m) => said.push(String(m));
  try {
    process.env.E2E_MIN_EXECUTED = '1';
    const guard = new SkipGuardReporter({ expectedReasonPrefixes: ['optional:', 'acknowledged gap:'] });
    const skip = (title, description) =>
      guard.onTestEnd(
        { title, location: { file: '/x/tests/live/c-tips.live.spec.ts' }, annotations: [] },
        { status: 'skipped', annotations: [{ type: 'skip', description }] },
      );
    guard.onTestEnd({ title: 'ran', location: { file: '/x/a.spec.ts' }, annotations: [] }, { status: 'passed', annotations: [] });
    skip('delivery failure', 'optional: opted out');
    skip('federation', 'acknowledged gap: federation: no second backend');
    assert.equal(await guard.onEnd({ status: 'passed' }), undefined, 'chosen skips do not fail the run');
    skip('create', 'alice holds too little BTC; top up the demo wallet');
    assert.deepEqual(await guard.onEnd({ status: 'passed' }), { status: 'failed' }, 'any other skip fails it');
    assert.ok(said.some((m) => /top up the demo wallet/.test(m)), 'the failing skip is named with its reason');
  } finally {
    console.error = quiet;
    console.log = log;
    delete process.env.E2E_MIN_EXECUTED;
  }
});
