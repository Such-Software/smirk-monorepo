/**
 * A resolved tip recipient survives the parent re-rendering.
 *
 * v0.3.1 rc e2e, 2026-10-15 (C-tips footage holds): the popup passed
 * `resolveRecipient` as an inline arrow, so every ~25 s balance poll handed
 * TipMaker a new function. The lookup effect depended on it, reset the
 * recipient to "checking" and resolved it again: the hint flickered to
 * "Looking up…" and the submit button went disabled until the lookup came
 * back, and a transient lookup error would have shown as a recipient error.
 *
 * These tests mount the real composer in a minimal DOM, resolve a recipient,
 * then re-render it the way the popup does on a poll.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, options, render } from 'preact';
import { TipMaker, type ResolveTipRecipient, type TipMakerProps } from '../TipMaker';
import { byTestId, installMiniDom, isDisabled, miniDocument, type MiniElement } from './mini-dom';

const NPUB = 'npub1' + 'q'.repeat(58);
const RESOLVE_DEBOUNCE_MS = 400;

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Wait out the composer's lookup debounce, then let the result render. */
async function afterDebounce(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 50));
  await settle();
}

function type(el: MiniElement, value: string): void {
  (el as unknown as { value: string }).value = value;
  for (const listener of el.listeners.get('input') ?? []) {
    listener.call(el, {
      type: 'input',
      target: el,
      currentTarget: el,
      defaultPrevented: false,
      preventDefault() {},
      stopPropagation() {},
    });
  }
}

const hookOptions = options as { requestAnimationFrame?: (cb: () => void) => void };
let previousRaf: typeof hookOptions.requestAnimationFrame;
let restoreDom: (() => void) | null = null;
let root: MiniElement | null = null;
const g = globalThis as { window?: unknown };
let hadWindow = false;
let previousWindow: unknown;

beforeEach(() => {
  restoreDom = installMiniDom();
  hadWindow = 'window' in g;
  previousWindow = g.window;
  g.window = { setTimeout, clearTimeout };
  previousRaf = hookOptions.requestAnimationFrame;
  hookOptions.requestAnimationFrame = (cb) => {
    setImmediate(cb);
  };
});

afterEach(async () => {
  if (root) {
    render(null, root as unknown as Element);
    root = null;
  }
  await settle();
  hookOptions.requestAnimationFrame = previousRaf;
  if (hadWindow) g.window = previousWindow;
  else delete g.window;
  restoreDom?.();
});

function props(resolveRecipient: ResolveTipRecipient): TipMakerProps {
  return {
    assetIds: ['btc'],
    resolveBalance: () => 100_000_000n,
    parseAmount: () => 5_000n,
    // A new function per call, like the popup's inline props.
    resolveRecipient,
    onSubmit: async () => ({ ok: false, error: 'not in this test' }),
    onExit: () => {},
  };
}

test('a parent re-render with a new resolver function does not re-run the lookup or disable submit', async () => {
  let calls = 0;
  const makeResolver = (): ResolveTipRecipient => async () => {
    calls++;
    return { ok: true, recipient: { pubkeyHex: 'ab'.repeat(32), display: 'alice' } };
  };

  root = miniDocument.createElement('div');
  const mount = () => render(h(TipMaker, props(makeResolver())), root as unknown as Element);
  mount();
  await settle();

  type(byTestId(root, 'tip-recipient-input')!, NPUB);
  type(byTestId(root, 'tip-amount-input')!, '0.00005');
  await settle();
  await afterDebounce();

  const submit = () => byTestId(root!, 'tip-submit-btn')!;
  assert.equal(calls, 1, 'resolved once');
  assert.equal(isDisabled(submit()), false, 'ready to send once resolved');
  const readyLabel = submit().textContent;
  const readyHint = byTestId(root, 'tip-recipient-hint')?.textContent;
  assert.ok(readyHint, 'the resolved recipient is shown');

  // Three balance polls' worth of parent renders.
  for (let poll = 0; poll < 3; poll++) {
    mount();
    await settle();
    assert.equal(isDisabled(submit()), false, `submit disabled after re-render ${poll + 1}`);
    assert.equal(submit().textContent, readyLabel, `submit label changed after re-render ${poll + 1}`);
    assert.equal(byTestId(root, 'tip-recipient-hint')?.textContent, readyHint, 'recipient hint changed');
    await afterDebounce();
  }
  assert.equal(calls, 1, 'a re-render alone never looks the recipient up again');
});

test('editing the recipient still resolves the new text', async () => {
  const seen: string[] = [];
  const resolver: ResolveTipRecipient = async (text) => {
    seen.push(text);
    return { ok: true, recipient: { pubkeyHex: 'cd'.repeat(32), display: text } };
  };
  root = miniDocument.createElement('div');
  render(h(TipMaker, props(resolver)), root as unknown as Element);
  await settle();

  type(byTestId(root, 'tip-recipient-input')!, 'alice');
  await settle();
  await afterDebounce();
  type(byTestId(root, 'tip-recipient-input')!, 'bob');
  await settle();
  await afterDebounce();

  assert.deepEqual(seen, ['alice', 'bob']);
  assert.match(byTestId(root, 'tip-recipient-hint')?.textContent ?? '', /bob/);
});
