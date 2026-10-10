// The E-swaps in-flight ledger: no second deposit while a swap is unfinished.
// Run: node --test packages/e2e/fixtures/E-swaps-ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InflightLedger, swapKey } from './E-swaps-ledger.mjs';

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'e-swaps-ledger-'));
  try {
    fn(new InflightLedger(join(dir, 'nested', 'inflight.json')), join(dir, 'nested', 'inflight.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a swap is refused from its Send tap until the provider finishes it', () => {
  withLedger((ledger, file) => {
    const key = swapKey('thorchain', 'btc', 'ltc');
    assert.equal(ledger.refusal(key), null);
    ledger.begin(key, { wallet: 'alice', runId: '1' });
    assert.ok(ledger.refusal(key), 'refused while the deposit may exist');
    assert.equal((statSync(file).mode & 0o777).toString(8), '600');
    assert.throws(() => ledger.begin(key, { wallet: 'bob', runId: '2' }), undefined, 'not on another wallet either');
    ledger.broadcast(key, 'ab'.repeat(32));
    assert.ok(ledger.refusal(key)?.includes('ab'.repeat(32)), 'the refusal names the deposit to check');
    // Another pair is independent.
    assert.equal(ledger.refusal(swapKey('thorchain', 'ltc', 'btc')), null);
    ledger.finish(key);
    assert.equal(ledger.refusal(key), null);
  });
});

test('a later run sees the entry, and only an explicit clearance removes it', () => {
  withLedger((ledger, file) => {
    const key = swapKey('nonlogs', 'xmr', 'wow');
    ledger.begin(key, { wallet: 'carol', runId: '1' });
    const later = new InflightLedger(file);
    assert.ok(later.refusal(key));
    assert.deepEqual(later.clear(['thorchain:btc-ltc']), [], 'clearing another key changes nothing');
    assert.ok(later.refusal(key));
    const removed = later.clear([key]);
    assert.ok(removed.some((r) => r.key === key && r.wallet === 'carol'));
    assert.equal(later.refusal(key), null);
    assert.throws(() => later.clear(['not a key']));
  });
});
