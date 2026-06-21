/**
 * Regression tests for the Grin send orchestration in `grin-flows.ts`.
 *
 * Focus: the backend-bookkeeping guard before broadcast/finalize. If
 * `recordGrinTransaction` or `lockGrinOutputs` fails and we proceed anyway,
 * the inputs can be spent on-chain while the backend still treats them as
 * unlocked; a later send then reselects them, opening a double-spend window
 * until confirmation. `startGrinSend` must abort instead.
 *
 * Style follows @smirk/core's tests: node:test, and stub the `api` / `wasm`
 * singleton methods directly (no module-mock machinery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';
import { startGrinSend, type GrinSendInputResolver } from '../grin-flows';

type AnyFn = (...args: unknown[]) => unknown;

/** Stub the wasm slate ceremony + key derivation so the test exercises the
 *  record -> lock -> broadcast orchestration without a real wasm init. */
function stubWasm(): void {
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.deriveExtendedKey = () => JSON.stringify({ extended_private_key_hex: '00'.repeat(32) });
  w.deriveExtendedKeyLegacyBip39 = () => '00'.repeat(32);
  w.randomSecretNonce = () => '11'.repeat(32);
  w.createSendTransaction = () => ({ slate_id: 'test-slate-0001', input_derivations: ['v3+Regular'] });
}

function resolver(): GrinSendInputResolver {
  return {
    fetchSpendable: async () => ({
      outputs: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          key_id: '0300000000000000000000000100000000',
          n_child: 1,
          amount: 5_000_000_000,
          commitment: '08'.repeat(33),
          is_coinbase: false,
        },
      ],
      next_child_index: 2,
    }),
  };
}

const baseArgs = () => ({
  userId: 'u1',
  mnemonic:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  senderSlatepackAddress: 'grin1senderplaceholder',
  amount: 1_000_000_000,
  resolver: resolver(),
});

test('startGrinSend aborts (throws) when lockGrinOutputs fails', async () => {
  stubWasm();
  const a = api as unknown as Record<string, AnyFn>;
  a.recordGrinTransaction = async () => ({});
  a.lockGrinOutputs = async () => ({ error: 'simulated lock failure' });

  await assert.rejects(startGrinSend(baseArgs()), /Failed to lock Grin inputs/);
});

test('startGrinSend aborts (throws) when recordGrinTransaction fails', async () => {
  stubWasm();
  const a = api as unknown as Record<string, AnyFn>;
  a.recordGrinTransaction = async () => ({ error: 'simulated record failure' });
  a.lockGrinOutputs = async () => ({});

  await assert.rejects(startGrinSend(baseArgs()), /Failed to record Grin transaction/);
});
