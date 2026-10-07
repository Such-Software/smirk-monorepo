import './_chrome-stub';
import { generateMnemonicPhrase } from '@smirk/core';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialize } from '@smirk/wasm';
import { hasCompleteSigningMaterial } from '@smirk/core';
import { sessionStorage, walletKeystore } from '../singletons';
import { clearSessionCache, tryRestoreSessionCache, writeSessionCache } from '../session-cache';
import { lockWalletContexts, acknowledgePasswordUnlock } from '../session-lock';
import {
  DAPP_FLOW_GRACE_KEY, DAPP_FLOW_GRACE_DEFAULT_SECONDS, DAPP_FLOW_GRACE_MAX_SECONDS,
  clearFlowGrace, clearFlowGraceForTab, flowGraceSeconds, scopeOf, startFlowGrace, tryRestoreFlowGrace,
} from '../flow-grace';

const MNEMONIC = generateMnemonicPhrase();
const PASSWORD = 'test-only-password';
const SCOPE = { origin: 'https://smirk.example', tabId: 41 };

before(async () => {
  (chrome as unknown as { runtime: { getURL: (path: string) => string } }).runtime = { getURL: (path) => path };
  await initialize(await readFile(new URL('../../../../../crates/smirk-wasm/pkg/smirk_wasm_bg.wasm', import.meta.url)));
});

beforeEach(async () => {
  await walletKeystore.destroy();
  await clearSessionCache();
  acknowledgePasswordUnlock();
});

const create = () => walletKeystore.createWallet({ mnemonic: MNEMONIC, password: PASSWORD, iterations: 1_000 });

/** An approval window that unlocked, then closed: keys leave memory, the grace stays. */
async function unlockedThenClosed(minutes = 0, seconds = 90) {
  const wallet = await create();
  await writeSessionCache(wallet, minutes);
  const expiry = await startFlowGrace(wallet, SCOPE, minutes, seconds);
  await walletKeystore.lock();
  return expiry;
}

test('the same site and tab reuse the unlock without the password', async () => {
  assert.ok(await unlockedThenClosed());
  const restored = await tryRestoreFlowGrace(SCOPE);
  assert.ok(restored && hasCompleteSigningMaterial(restored));
  assert.equal(restored.mnemonic, undefined);
  assert.equal(restored.seed, undefined);
  // Multi-step: a second request in the flow still restores.
  await walletKeystore.lock();
  assert.ok(await tryRestoreFlowGrace(SCOPE));
});

test('another origin or another tab gets nothing, and does not disturb the flow', async () => {
  await unlockedThenClosed();
  assert.equal(await tryRestoreFlowGrace({ origin: 'https://evil.example', tabId: SCOPE.tabId }), null);
  assert.equal(await tryRestoreFlowGrace({ origin: SCOPE.origin, tabId: SCOPE.tabId + 1 }), null);
  assert.equal(await tryRestoreFlowGrace(null), null);
  assert.ok(await sessionStorage.get(DAPP_FLOW_GRACE_KEY));
  assert.ok(await tryRestoreFlowGrace(SCOPE));
});

test('the main popup never sees the grace: Home stays locked', async () => {
  await unlockedThenClosed();
  assert.equal(await tryRestoreSessionCache(), null);
  const state = await walletKeystore.getState();
  assert.notEqual(state.kind, 'unlocked');
});

test('the grace expires at a fixed time and is cleared when stale', async () => {
  const expiry = await unlockedThenClosed(0, 60);
  assert.ok(expiry);
  assert.equal(await tryRestoreFlowGrace(SCOPE, expiry + 1), null);
  assert.equal(await sessionStorage.get(DAPP_FLOW_GRACE_KEY), null);
});

test('a later unlock in the same flow does not extend the deadline', async () => {
  const wallet = await create();
  const t0 = Date.now();
  const first = await startFlowGrace(wallet, SCOPE, 0, 90, t0);
  const second = await startFlowGrace(wallet, SCOPE, 0, 90, t0 + 30_000);
  assert.equal(second, first);
});

test('any wallet lock ends the grace', async () => {
  await unlockedThenClosed();
  await lockWalletContexts(walletKeystore, sessionStorage);
  assert.equal(await tryRestoreFlowGrace(SCOPE), null);
});

test('clearing the session (every lock path) removes the grace', async () => {
  await unlockedThenClosed();
  await clearSessionCache();
  assert.equal(await sessionStorage.get(DAPP_FLOW_GRACE_KEY), null);
});

test('deny clears the grace', async () => {
  await unlockedThenClosed();
  await clearFlowGrace();
  assert.equal(await tryRestoreFlowGrace(SCOPE), null);
});

test('closing the tab clears only that tab\'s grace', async () => {
  await unlockedThenClosed();
  const area = chrome.storage.session as unknown as Parameters<typeof clearFlowGraceForTab>[0];
  await clearFlowGraceForTab(area, SCOPE.tabId + 5);
  assert.ok(await sessionStorage.get(DAPP_FLOW_GRACE_KEY));
  await clearFlowGraceForTab(area, SCOPE.tabId);
  assert.equal(await sessionStorage.get(DAPP_FLOW_GRACE_KEY), null);
});

test('no grace when auto-lock is on, when disabled, or without a tab', async () => {
  const wallet = await create();
  assert.equal(await startFlowGrace(wallet, SCOPE, 5, 90), null);
  assert.equal(await startFlowGrace(wallet, SCOPE, 0, 0), null);
  assert.equal(scopeOf({ origin: SCOPE.origin }), null);
  assert.equal(scopeOf({ origin: '', tabId: 1 }), null);
  assert.deepEqual(scopeOf({ origin: SCOPE.origin, tabId: 3 }), { origin: SCOPE.origin, tabId: 3 });
});

test('the configured duration is bounded', () => {
  assert.equal(flowGraceSeconds(undefined), DAPP_FLOW_GRACE_DEFAULT_SECONDS);
  assert.equal(flowGraceSeconds(0), 0);
  assert.equal(flowGraceSeconds(-5), 0);
  assert.equal(flowGraceSeconds('nonsense'), 0);
  assert.equal(flowGraceSeconds(10_000), DAPP_FLOW_GRACE_MAX_SECONDS);
});

test('a requested duration above the cap is capped', async () => {
  const wallet = await create();
  const t0 = Date.now();
  const expiry = await startFlowGrace(wallet, SCOPE, 0, 10_000, t0);
  assert.equal(expiry, t0 + DAPP_FLOW_GRACE_MAX_SECONDS * 1000);
});
