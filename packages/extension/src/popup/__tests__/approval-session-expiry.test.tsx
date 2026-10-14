/**
 * The dapp approval window asks for the password again when its restored
 * session expires, and returns to the same request.
 *
 * v0.3.1 regression (live e2e, 2026-10-14): the window decided lock versus
 * approve once, on mount. A wallet restored from the sign-in flow grace or the
 * auto-lock cache carries a deadline the keystore enforces, and nothing in the
 * window watched it. Approving after the deadline showed "Wallet is locked" on
 * the approval screen, with no way to unlock short of closing the window and
 * failing the site's request.
 *
 * These mount the real ApprovalApp in a minimal DOM over the real keystore,
 * flow grace and executor, and press the real buttons.
 */
import './_chrome-stub';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { h, options, render } from 'preact';
import { generateMnemonicPhrase } from '@smirk/core';
import { initialize } from '@smirk/wasm';
import { walletKeystore } from '../singletons';
import { clearSessionCache } from '../session-cache';
import { acknowledgePasswordUnlock } from '../session-lock';
import { startFlowGrace } from '../flow-grace';
import { ApprovalApp } from '../routes/approval';
import {
  buttonsByText, byTestId, click, installMiniDom, miniDocument, type MiniElement,
} from '../../../../ui/src/components/__tests__/mini-dom';

const MNEMONIC = generateMnemonicPhrase();
const PASSWORD = 'test-only-password';
const SCOPE = { origin: 'https://smirk.example', tabId: 41 };
const APPROVAL_ID = 'expiry-test';
const PENDING_KEY = `smirk:dapp:approval-pending:${APPROVAL_ID}`;
const RESULT_KEY = `smirk:dapp:approval-result:${APPROVAL_ID}`;

const session = () => chrome.storage.session as unknown as {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};
const writtenResult = async () => (await session().get(RESULT_KEY))[RESULT_KEY];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `cond` holds; PBKDF2 and storage hops take a variable number of ticks. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const approveButton = (root: MiniElement) => buttonsByText(root, /^Approve$/)[0] ?? null;
const lockInput = (root: MiniElement) => byTestId(root, 'lockscreen-password-input');

let restoreDom: (() => void) | null = null;
let root: MiniElement | null = null;
const hookOptions = options as { requestAnimationFrame?: ((cb: () => void) => void) | undefined };
let previousRaf: typeof hookOptions.requestAnimationFrame;

before(async () => {
  (chrome as unknown as { runtime: { getURL: (path: string) => string } }).runtime = { getURL: (path) => path };
  // finish() closes the window shortly after writing the result.
  (globalThis as { window?: unknown }).window = { close() {} };
  await initialize(await readFile(new URL('../../../../../crates/smirk-wasm/pkg/smirk_wasm_bg.wasm', import.meta.url)));
});

after(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** The mini DOM plus the little of `<html>` the window's theme bootstrap writes. */
function installWindowDom(): () => void {
  const restore = installMiniDom();
  const classes = new Set<string>();
  const documentElement = Object.assign(miniDocument.createElement('html'), {
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), [Symbol.iterator]: () => classes.values() },
  });
  (globalThis as { document?: unknown }).document = {
    ...miniDocument, documentElement, head: miniDocument.createElement('head'), getElementById: () => null,
  };
  return restore;
}

beforeEach(async () => {
  restoreDom = installWindowDom();
  // Preact runs effects after the next frame, which Node does not have.
  previousRaf = hookOptions.requestAnimationFrame;
  hookOptions.requestAnimationFrame = (cb) => {
    setImmediate(cb);
  };
  await walletKeystore.destroy();
  await clearSessionCache();
  await session().remove(PENDING_KEY);
  await session().remove(RESULT_KEY);
  acknowledgePasswordUnlock();
});

afterEach(async () => {
  if (root) render(null, root as unknown as Element);
  root = null;
  await sleep(10);
  mock.timers.reset();
  hookOptions.requestAnimationFrame = previousRaf;
  restoreDom?.();
});

/**
 * A site's sign request whose window restores the wallet from the flow grace
 * started by an earlier unlock in the same tab, with the grace ending at
 * `expiresAtMs`. The earlier window has closed, so no keys are in memory.
 */
async function pendingSignWithGrace(expiresAtMs: number): Promise<void> {
  const wallet = await walletKeystore.createWallet({ mnemonic: MNEMONIC, password: PASSWORD, iterations: 1_000 });
  const started = await startFlowGrace(wallet, SCOPE, 0, 90, expiresAtMs - 90_000);
  assert.equal(started, expiresAtMs);
  await walletKeystore.lock();
  await session().set({
    [PENDING_KEY]: {
      id: APPROVAL_ID,
      createdAt: Date.now(),
      request: { kind: 'signMessage', origin: SCOPE, message: 'Sign in to smirk.example', assets: ['btc'] },
    },
  });
}

/** Mount the window and wait for the restored session's approval screen. */
async function mountApproval(): Promise<MiniElement> {
  const el = miniDocument.createElement('div');
  root = el;
  render(h(ApprovalApp, { approvalId: APPROVAL_ID }), el as unknown as Element);
  await until(() => approveButton(el) !== null, 'the approval screen');
  assert.equal(lockInput(el), null, 'the restored session opens on the approval, not the password');
  return el;
}

function typePassword(input: MiniElement, value: string): void {
  (input as unknown as { value: string }).value = value;
  for (const listener of input.listeners.get('input') ?? []) {
    listener.call(input, {
      type: 'input', target: input, currentTarget: input, defaultPrevented: false,
      preventDefault() {}, stopPropagation() {},
    });
  }
}

test('Approve after the session expired asks for the password, then signs the same request', async () => {
  // Only the clock moves: a background window's timer can run late, so the tap
  // may come first. The real setTimeout below would fire 90 s from now.
  const t0 = Date.now();
  mock.timers.enable({ apis: ['Date'], now: t0 });
  await pendingSignWithGrace(t0 + 90_000);
  const el = await mountApproval();

  mock.timers.setTime(t0 + 91_000);
  assert.ok(click(approveButton(el)!));
  await until(() => lockInput(el) !== null || /locked/i.test(el.textContent), 'the window to react to the tap');

  assert.ok(lockInput(el), 'the lock screen replaces the approval');
  assert.doesNotMatch(el.textContent, /Wallet is locked/);
  assert.equal(await writtenResult(), undefined, 'the expired attempt answers nothing to the site');

  typePassword(lockInput(el)!, PASSWORD);
  await until(() => !(byTestId(el, 'lockscreen-unlock-btn')?.hasAttribute('disabled') ?? true), 'the unlock button');
  assert.ok(click(byTestId(el, 'lockscreen-unlock-btn')!));
  await until(() => approveButton(el) !== null, 'the same approval after unlock');
  assert.match(el.textContent, /Sign in to smirk\.example/);

  assert.ok(click(approveButton(el)!));
  await until(async () => (await writtenResult()) !== undefined, 'the approval result');
  const answered = (await writtenResult()) as { kind?: string; approved?: boolean };
  assert.equal(answered.kind, 'signMessage');
  assert.equal(answered.approved, true);
});

test('the deadline alone turns the open approval into the lock screen', async () => {
  await pendingSignWithGrace(Date.now() + 1_500);
  const el = await mountApproval();

  await until(() => lockInput(el) !== null, 'the lock screen at the deadline', 4_000);
  assert.equal(approveButton(el), null);
  assert.equal(await writtenResult(), undefined);
});
