/**
 * Unit tests for the FreshnessCue state machine.
 *
 * Only the pure `computeFreshnessLevel(input, now)` reducer is exercised here;
 * it maps raw session freshness inputs + a supplied clock to a level, so it can
 * be reasoned about without mounting the component or the internal ticker. Every
 * `now` is expressed relative to a fixed `lastSuccessAt` anchor so the escalation
 * is deterministic (no real clock, no Date.now()).
 *
 * Matches the runner the rest of @smirk/ui uses: node:test + node:assert/strict,
 * no jsdom. This case is a pure function, so it needs no preact-render-to-string.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFreshnessLevel,
  FRESHNESS_WARN_MS,
  FRESHNESS_ERROR_MS,
} from '../FreshnessCue';

// Fixed last-success anchor. Every `now` below is this plus an explicit offset,
// so the elapsed time under test is unambiguous and clock-independent.
const T0 = 1_700_000_000_000;

describe('computeFreshnessLevel — thresholds', () => {
  it('exposes the documented 30s / 60s thresholds', () => {
    assert.equal(FRESHNESS_WARN_MS, 30_000);
    assert.equal(FRESHNESS_ERROR_MS, 60_000);
  });
});

describe('computeFreshnessLevel — healthy (not failing)', () => {
  it('not failing + not refreshing -> fresh', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: false },
        T0,
      ),
      'fresh',
    );
  });

  it('not failing + refreshing -> updating', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: true, lastSuccessAt: T0, lastAttemptFailed: false },
        T0,
      ),
      'updating',
    );
  });

  it('not failing stays fresh even long after the last success', () => {
    // A never-failing wallet is trusted no matter how old the anchor is; only a
    // failed attempt starts the time-based escalation.
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: false },
        T0 + 10 * 60_000,
      ),
      'fresh',
    );
  });
});

describe('computeFreshnessLevel — transient blip (failed but recent)', () => {
  it('failed + <30s since success + refreshing -> updating (blip does not alarm)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: true, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + 10_000,
      ),
      'updating',
    );
  });

  it('failed + <30s since success + not refreshing -> fresh (blip does not alarm)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + 10_000,
      ),
      'fresh',
    );
  });

  it('just below the warn threshold (29_999ms) is still treated as a blip', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + FRESHNESS_WARN_MS - 1,
      ),
      'fresh',
    );
  });
});

describe('computeFreshnessLevel — sustained failure escalates', () => {
  it('failed + exactly 30s since success -> warn (boundary is inclusive)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + FRESHNESS_WARN_MS,
      ),
      'warn',
    );
  });

  it('failed + between 30s and 60s -> warn', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + 45_000,
      ),
      'warn',
    );
  });

  it('just below the error threshold (59_999ms) is still warn, not error', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + FRESHNESS_ERROR_MS - 1,
      ),
      'warn',
    );
  });

  it('failed + exactly 60s since success -> error (boundary is inclusive)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + FRESHNESS_ERROR_MS,
      ),
      'error',
    );
  });

  it('failed + well past 60s -> error', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + 90_000,
      ),
      'error',
    );
  });
});

describe('computeFreshnessLevel — never succeeded this session', () => {
  it('failed + lastSuccessAt === null -> error (elapsed is Infinity, maxed out)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: false, lastSuccessAt: null, lastAttemptFailed: true },
        T0,
      ),
      'error',
    );
  });

  it('failed + lastSuccessAt === null stays error even while refreshing', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: true, lastSuccessAt: null, lastAttemptFailed: true },
        T0,
      ),
      'error',
    );
  });
});

describe('computeFreshnessLevel — sustained failure wins over an in-flight retry', () => {
  it('failed + >=60s + refreshing:true still -> error (a mid-outage retry does not downgrade red)', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: true, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + FRESHNESS_ERROR_MS,
      ),
      'error',
    );
  });

  it('failed + >30s + refreshing:true stays warn, not downgraded to updating', () => {
    assert.equal(
      computeFreshnessLevel(
        { refreshing: true, lastSuccessAt: T0, lastAttemptFailed: true },
        T0 + 45_000,
      ),
      'warn',
    );
  });
});
