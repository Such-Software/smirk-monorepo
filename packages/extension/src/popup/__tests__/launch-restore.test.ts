/**
 * What the wallet reopens on after it was closed mid-flow.
 *
 * Closed on a result screen ("Tip sent", a send receipt, a completed swap, a
 * claimed tip), the wallet used to reopen on that flow instead of Home. Closed
 * on a draft or an operation still in flight, it must keep resuming it: a send
 * on Review, a Grin exchange waiting for its reply, a swap waiting for its
 * deposit.
 *
 * Runs the popup's real rule table and the real session store; each case
 * writes the state a closed wallet leaves behind, then launches on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryStorage,
  RouteController,
  SessionStateStore,
  routeIsFinished,
  settleForLaunch,
  type SessionState,
  type WizardState,
} from '@smirk/core';
import {
  GRIN_PASTE_INCOMING_WIZARD_ID,
  SEND_WIZARD_ID,
  THORCHAIN_WIZARD_ID,
  TROCADOR_WIZARD_ID,
  type SwapInFlight,
} from '@smirk/ui';

import { FINISHED_FLOW_RULES, markResultShown } from '../launch-restore';

type Closed = (store: SessionStateStore, router: RouteController) => Promise<void>;

/** Leave the wallet as `close` does, then launch a fresh window on the same storage. */
async function relaunch(close: Closed): Promise<SessionState> {
  const storage = new InMemoryStorage();
  const before = new SessionStateStore(storage);
  await close(before, new RouteController(before));
  before.destroy();
  const after = new SessionStateStore(storage);
  await settleForLaunch(after, FINISHED_FLOW_RULES);
  const opened = await after.load();
  after.destroy();
  return opened;
}

function put(store: SessionStateStore, id: string, state: WizardState): Promise<SessionState> {
  return store.update((s) => {
    s.wizards[id] = state;
  });
}

function swap(state: SwapInFlight['state'], provider = 'thorchain'): WizardState {
  const inFlight: SwapInFlight = {
    id: 'trade-1',
    fromAsset: 'btc',
    toAsset: 'ltc',
    fromAmountAtomic: '23000',
    toAmountEstimateAtomic: '1000000',
    depositAddress: 'deposit',
    provider,
    state,
  };
  return { step: 0, fields: { step: 3, inFlight }, startedAt: 1 };
}

const REVIEW: WizardState = {
  step: 3,
  fields: { fromAssetId: 'btc', toAddress: 'destination', amountText: '0.00023', feeTier: 'normal' },
  startedAt: 1,
};
const RECEIPT: WizardState = { step: 4, fields: { fromAssetId: 'btc', lastTxid: 'txid' }, startedAt: 1 };

test('closed on a send receipt, the wallet reopens on Home', async () => {
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/send/asset/btc');
    await put(store, SEND_WIZARD_ID, RECEIPT);
  });
  assert.equal(opened.route.current, 'home');
  assert.equal(opened.wizards[SEND_WIZARD_ID], undefined);
});

test('closed on Review, a send awaiting broadcast resumes there', async () => {
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/send');
    await put(store, SEND_WIZARD_ID, REVIEW);
  });
  assert.equal(opened.route.current, 'home/send');
  assert.deepEqual(opened.wizards[SEND_WIZARD_ID], REVIEW);
});

test('closed waiting for a Grin reply, the exchange resumes', async () => {
  const exchange: WizardState = {
    step: 3,
    fields: { fromAssetId: 'grin', toAddress: 'npub', amountText: '1', grinSlateId: 'slate', grinArmoredOutgoing: 'S1' },
    startedAt: 1,
  };
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/send');
    await put(store, SEND_WIZARD_ID, exchange);
  });
  assert.equal(opened.route.current, 'home/send');
  assert.deepEqual(opened.wizards[SEND_WIZARD_ID], exchange);
});

test('closed on a swap awaiting its deposit, the swap resumes', async () => {
  const waiting = swap({ state: 'pending', reason: 'awaiting_deposit' });
  const opened = await relaunch(async (store, router) => {
    await router.navigate('swap');
    await put(store, THORCHAIN_WIZARD_ID, waiting);
  });
  assert.equal(opened.route.current, 'swap');
  assert.deepEqual(opened.wizards[THORCHAIN_WIZARD_ID], waiting);
});

test('closed on a failed swap, it stays reachable with its trade id', async () => {
  const failed = swap({ state: 'failed', reason: 'Quote expired or provider could not complete in time.' }, 'trocador');
  const opened = await relaunch(async (store, router) => {
    await router.navigate('swap');
    await put(store, TROCADOR_WIZARD_ID, failed);
  });
  assert.equal(opened.route.current, 'swap');
  assert.deepEqual(opened.wizards[TROCADOR_WIZARD_ID], failed);
});

test('closed on a settled swap, the wallet reopens on Home', async () => {
  const settled: Array<[string, WizardState]> = [
    ['delivered', swap({ state: 'completed', outboundTxId: 'out', toAmount: '990000' })],
    ['refunded', swap({ state: 'refunded', refundTxId: 'back', reason: 'THORChain refunded the deposit' })],
  ];
  for (const [outcome, state] of settled) {
    const opened = await relaunch(async (store, router) => {
      await router.navigate('swap');
      await put(store, THORCHAIN_WIZARD_ID, state);
    });
    assert.equal(opened.route.current, 'home', outcome);
    assert.equal(opened.wizards[THORCHAIN_WIZARD_ID], undefined, outcome);
  }
});

test('closed on the receipt for a swap deposit, the swap still resumes', async () => {
  const deposited = swap({ state: 'pending', reason: 'awaiting_confirmations' });
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/send');
    await put(store, THORCHAIN_WIZARD_ID, deposited);
    await put(store, SEND_WIZARD_ID, RECEIPT);
  });
  assert.equal(opened.route.current, 'home');
  assert.equal(opened.wizards[SEND_WIZARD_ID], undefined);
  assert.deepEqual(opened.wizards[THORCHAIN_WIZARD_ID], deposited);
});

test('closed on "Tip sent", the wallet reopens on Home', async () => {
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/tip/btc');
    // An unrelated draft survives the tip result.
    await put(store, SEND_WIZARD_ID, REVIEW);
    markResultShown(router, 'home/tip/btc');
    // Updates run in order, so this one settles after the mark.
    await store.update(() => undefined);
  });
  assert.equal(opened.route.current, 'home');
  assert.equal(routeIsFinished(opened.route), false);
  assert.deepEqual(opened.wizards[SEND_WIZARD_ID], REVIEW);
});

test('closed while still composing a tip, the composer reopens', async () => {
  const opened = await relaunch(async (_store, router) => {
    await router.navigate('home/tip/btc');
  });
  assert.equal(opened.route.current, 'home/tip/btc');
});

test('closed on a claimed tip link, the wallet reopens on Home', async () => {
  const opened = await relaunch(async (store, router) => {
    await router.navigate('home/inbox/paste-tip');
    markResultShown(router, 'home/inbox/paste-tip');
    // Updates run in order, so this one settles after the mark.
    await store.update(() => undefined);
  });
  assert.equal(opened.route.current, 'home');
});

test('an incoming Grin slatepack resumes while signing and gives way once replied', async () => {
  const signing = { step: 1, fields: { armoredIncoming: 'S1', relayId: 'relay' }, startedAt: 1 };
  const resumed = await relaunch(async (store, router) => {
    await router.navigate('home/receive/grin-incoming');
    await put(store, GRIN_PASTE_INCOMING_WIZARD_ID, signing);
  });
  assert.equal(resumed.route.current, 'home/receive/grin-incoming');
  assert.deepEqual(resumed.wizards[GRIN_PASTE_INCOMING_WIZARD_ID], signing);

  const replied = await relaunch(async (store, router) => {
    await router.navigate('home/receive/grin-incoming');
    await put(store, GRIN_PASTE_INCOMING_WIZARD_ID, { ...signing, step: 2 });
  });
  assert.equal(replied.route.current, 'home');
  assert.equal(replied.wizards[GRIN_PASTE_INCOMING_WIZARD_ID], undefined);
});

test('every finished-flow rule judges its own wizard', () => {
  const ids = FINISHED_FLOW_RULES.map((rule) => rule.wizardId);
  assert.equal(new Set(ids).size, ids.length, 'one rule per wizard');
});

test('a result that cannot be marked never fails the operation that produced it', async () => {
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    const broken = { markFinished: () => Promise.reject(new Error('storage unavailable')) };
    assert.doesNotThrow(() => markResultShown(broken, 'home/tip'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(warned.length > 0, 'the failed mark is reported');
  } finally {
    console.warn = warn;
  }
});
