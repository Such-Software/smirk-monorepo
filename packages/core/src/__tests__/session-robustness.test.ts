/**
 * Robustness regressions in session handling.
 *
 * 1. parseSessionCache must reject a payload that is missing per-asset keys,
 *    not just a missing top-level keys/addresses object. A corrupted
 *    {keys:{}, addresses:{}} otherwise parses and crashes downstream on
 *    keys.btc.publicKey / addresses.xmr.
 * 2. SessionStateStore's cross-context sync must not turn a rejecting or
 *    unserializable (circular) storage read into an unhandled rejection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionCache } from '../keystore';
import { SessionStateStore } from '../state/session-state';
import type { PlatformStorage } from '../state/platform';

const validCache = () => ({
  version: 2,
  _noMnemonic: true,
  fingerprint: 'fp',
  // nostr rides in `keys` (no address entry); parseSessionCache validates its
  // presence separately, so a well-formed payload must carry it.
  keys: { btc: {}, ltc: {}, xmr: {}, wow: {}, grin: {}, nostr: {} },
  addresses: { btc: 'a', ltc: 'a', xmr: 'a', wow: 'a', grin: 'a' },
  expiresAtMs: 1_700_000_000_000,
});

test('parseSessionCache accepts a well-formed v2 payload', () => {
  assert.notEqual(parseSessionCache(validCache()), null);
});

test('parseSessionCache rejects payloads missing per-asset keys/addresses', () => {
  // The exact shape the old double-cast let through.
  assert.equal(parseSessionCache({ ...validCache(), keys: {}, addresses: {} }), null);
  // One asset key missing.
  assert.equal(
    parseSessionCache({ ...validCache(), keys: { btc: {}, ltc: {}, xmr: {}, wow: {} } }),
    null,
  );
  // One asset address missing.
  assert.equal(
    parseSessionCache({ ...validCache(), addresses: { btc: 'a', ltc: 'a', xmr: 'a', wow: 'a' } }),
    null,
  );
});

/** Storage with a triggerable subscribe and a get that fails on demand. */
class ControllableStorage implements PlatformStorage {
  private listener: ((key: string) => void) | null = null;
  constructor(private readonly mode: 'reject' | 'circular') {}
  async get<T>(_key: string): Promise<T | null> {
    if (this.mode === 'reject') throw new Error('storage read failed');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    return circular as T;
  }
  async set<T>(_key: string, _value: T): Promise<void> {}
  async remove(_key: string): Promise<void> {}
  subscribe(listener: (key: string) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  fire(key: string): void {
    this.listener?.(key);
  }
}

test('cross-context sync handles a rejecting storage read (logs, does not throw)', async () => {
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a);
  };
  try {
    const mock = new ControllableStorage('reject');
    new SessionStateStore(mock, 'k');
    mock.fire('k');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(warns.length, 1, 'a failed sync should be logged, not become an unhandled rejection');
  } finally {
    console.warn = orig;
  }
});

test('cross-context sync survives an unserializable (circular) payload', async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const mock = new ControllableStorage('circular');
    new SessionStateStore(mock, 'k');
    mock.fire('k');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(true, 'JSON.stringify on a circular payload must not throw out of the sync');
  } finally {
    console.warn = orig;
  }
});
