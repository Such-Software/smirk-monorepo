/**
 * The Swap tab's "Open Send → pre-filled" lands on Compose with the deposit,
 * and Inbox's pasted pay link lands on Send's address step with its recipient.
 *
 * Owner report (v0.3.0, Trocador, 0.003 BTC to LTC, 2026-10-11) and the live
 * v0.3.1 run (THORChain, 2026-10-10): the tap opened Send on "Send what?" with
 * nothing filled in. The handler saved the Send draft and the route in two
 * writes while the Swap tab saved its status step, and the store lost one of
 * them (the storage echo fixed in session-state.ts). Reproduced in Chromium
 * at 97b265e1 (v0.3.0), 14a74e10 (v0.3.1 candidate) and 8a70917 (main) with
 * the popup's SwapRouter and SendWizard; sometimes the route was lost instead
 * and Send never opened.
 *
 * Review of #50 added: a declined "replace your draft?" still moved the swap
 * to its status step, where the deposit could no longer be paid; the pay link
 * replaced any Send state without asking, including a Grin payment waiting for
 * its reply; and nothing here failed if the handoff went back to two writes.
 *
 * Runs the popup's real handoffs (the Swap tab's tap through the UI's own
 * openSendFromDeposit, and the pay link's), the real session store and router
 * over a storage double that answers like chrome.storage.local, a second
 * window saving from its own view, and Send's real mount preparation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RouteController,
  SessionStateStore,
  Wizard,
  withoutWriteStamp,
  type GoblinPayRequest,
  type PlatformStorage,
  type SessionState,
  type WizardState,
} from '@smirk/core';
import {
  SEND_WIZARD_ID,
  THORCHAIN_WIZARD_ID,
  TROCADOR_WIZARD_ID,
  openSendFromDeposit,
  prepareSendDraft,
  type SwapInFlight,
} from '@smirk/ui';
import { parseAmount } from '../format';
import {
  SEND_ROUTE,
  openPayLinkInSend,
  sendDraftInProgress,
  sendGrinExchangeInFlight,
} from '../send-handoff';
import { swapOpenSendHandler } from '../swap-handoff';

const KEY = 'smirk:popup-state';

/** Objects rebuilt with sorted keys, as chrome.storage hands them back. */
function sortedCopy<T>(value: T): T {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
    return out;
  };
  return sort(JSON.parse(JSON.stringify(value))) as T;
}

/**
 * chrome.storage.local as extension pages see it: writes applied in order
 * and announced to every page (the writer too) before their promise settles,
 * reads answered in order with keys sorted. Every state ever stored is kept,
 * without the stamp naming the window that wrote it.
 */
class ChromeLikeStorage implements PlatformStorage {
  readonly history: SessionState[] = [];
  private readonly data = new Map<string, unknown>();
  private readonly listeners = new Set<(key: string) => void>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.data.has(key) ? sortedCopy(this.data.get(key)) : null;
    return new Promise((resolve) => setImmediate(() => resolve(value as T | null)));
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, sortedCopy(value));
    if (key === KEY) this.history.push(withoutWriteStamp(sortedCopy(value)) as SessionState);
    return new Promise((resolve) => {
      setImmediate(() => {
        for (const l of this.listeners) l(key);
      });
      setImmediate(resolve);
    });
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
    return new Promise((resolve) => setImmediate(resolve));
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Let every queued write, announcement and read run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

const DEPOSIT_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const THOR_VAULT = 'bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv';

const TROCADOR_DEPOSIT: SwapInFlight = {
  id: 'TrocadorTrade1',
  fromAsset: 'btc',
  toAsset: 'ltc',
  fromAmountAtomic: '300000',
  toAmountEstimateAtomic: '65120000',
  depositAddress: DEPOSIT_BTC,
  provider: 'trocador',
  state: { state: 'pending', reason: 'awaiting_deposit' },
};

const THORCHAIN_DEPOSIT: SwapInFlight = {
  id: 'ABCDEF0123456789',
  fromAsset: 'btc',
  toAsset: 'ltc',
  fromAmountAtomic: '6201',
  toAmountEstimateAtomic: '1300000',
  depositAddress: THOR_VAULT,
  provider: 'thorchain',
  memo: '=:l:ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz:1',
  depositBeforeMs: 1_800_000_000_000,
  state: { state: 'pending', reason: 'awaiting_deposit' },
};

const PROVIDERS = [
  ['Trocador', TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT],
  ['THORChain', THORCHAIN_WIZARD_ID, THORCHAIN_DEPOSIT],
] as const;

/** A pasted GoblinPay link, as parseGoblinPayUri returns it. Placeholder recipient. */
const PAY_LINK: GoblinPayRequest = {
  scheme: 'goblin',
  recipient: 'npub1placeholderrecipient',
  recipientPubkeyHex: 'ab'.repeat(32),
  recipientRelays: [],
  amountGrin: '1.25',
  amountNanogrin: 1_250_000_000,
  memo: 'order 7',
  proofMode: false,
};

/** Send holding a Grin payment it built: the slate went out, the reply has not come back. */
const GRIN_EXCHANGE: WizardState = {
  step: 3,
  startedAt: 5,
  fields: {
    fromAssetId: 'grin',
    toAddress: 'grin-recipient-placeholder',
    amountText: '2',
    grinSlateId: 'slate-placeholder',
    grinSenderContextJson: '{"placeholder":true}',
    grinSenderInputsJson: '[]',
  },
};

/** A Send draft the user typed. */
const LTC_DRAFT: WizardState = {
  step: 2,
  startedAt: 5,
  fields: { fromAssetId: 'ltc', toAddress: 'ltc1qfriend', amountText: '1.5' },
};

/**
 * A popup on `route` with a swap on its deposit step: the store, its router,
 * and a Send screen that mounts the way SendWizard does whenever the route
 * reaches Send.
 */
async function popupOnDepositStep(wizardId: string, deposit: SwapInFlight, send?: WizardState, route = 'swap') {
  const storage = new ChromeLikeStorage();
  const store = new SessionStateStore(storage);
  const router = new RouteController(store);
  await router.navigate(route);
  await store.update((s) => {
    s.wizards[wizardId] = { step: 0, startedAt: 1, fields: { step: 2, inFlight: deposit } };
    if (send) s.wizards[SEND_WIZARD_ID] = send;
  });
  await settle();
  const mounts: string[] = [];
  store.subscribe((s) => {
    if (!s.route.current.startsWith(SEND_ROUTE) || mounts.includes(s.route.current)) return;
    mounts.push(s.route.current);
    const preselected = s.route.current.startsWith(`${SEND_ROUTE}/asset/`)
      ? s.route.current.slice(`${SEND_ROUTE}/asset/`.length)
      : undefined;
    void new Wizard(store, SEND_WIZARD_ID, {}).start((current) => prepareSendDraft(current, preselected));
  });
  return { storage, store, router, mounts };
}

/** Another popup window on the same storage, holding the view it loaded now. */
async function secondWindow(storage: PlatformStorage): Promise<SessionStateStore> {
  const other = new SessionStateStore(storage);
  await other.load();
  return other;
}

/**
 * The deposit step's tap: the popup's own onOpenSend handler, through the
 * UI's openSendFromDeposit, which moves the swap to its status step only once
 * Send opened. Records what the user was asked and told.
 */
async function tapOpenSend(
  store: SessionStateStore,
  wizardId: string,
  deposit: SwapInFlight,
  confirm: (question: string) => boolean = () => true,
) {
  const asked: string[] = [];
  const told: string[] = [];
  const onOpenSend = swapOpenSendHandler(store, {
    confirm: (question) => {
      asked.push(question);
      return confirm(question);
    },
    alert: (message) => told.push(message),
  });
  const opened = await openSendFromDeposit(onOpenSend, deposit, () =>
    new Wizard(store, wizardId, {}).patchFields({ step: 3 }),
  );
  await settle();
  return { opened, asked, told };
}

/** The swap wizard's own step (0 pair, 1 quote, 2 deposit, 3 status). */
function swapStep(s: SessionState, wizardId: string): unknown {
  return s.wizards[wizardId]?.fields.step;
}

/**
 * No stored state holds half a handoff: Send is routed to exactly when it
 * holds the handed-off draft. A reader of storage at any moment (another
 * window, the next launch after the popup closed) sees Send untouched or Send
 * open on the draft, never one without the other.
 */
function assertNeverHalfStored(storage: ChromeLikeStorage, toAddress: string, label: string): void {
  for (const stored of storage.history) {
    const holds = stored.wizards[SEND_WIZARD_ID]?.fields.toAddress === toAddress;
    const onSend = stored.route.current.startsWith(SEND_ROUTE);
    assert.equal(onSend, holds, `${label}: storage held ${onSend ? 'the Send route without' : 'Send\'s draft without'} the other`);
  }
}

for (const [provider, wizardId, deposit] of PROVIDERS) {
  test(`${provider}: Open Send lands on Compose with the deposit's coin, address and exact amount`, async () => {
    const { storage, store, mounts } = await popupOnDepositStep(wizardId, deposit);
    const tap = await tapOpenSend(store, wizardId, deposit);
    assert.equal(tap.opened, true);
    assert.deepEqual(tap.asked, [], 'nothing to replace, so nothing asked');

    const s = await store.load();
    assert.equal(s.route.current, SEND_ROUTE);
    assert.deepEqual(mounts, [SEND_ROUTE], 'Send mounted once');
    const send = s.wizards[SEND_WIZARD_ID]!;
    assert.equal(send.step, 2, 'Send is on Compose, not on its coin chooser');
    assert.equal(send.fields.fromAssetId, deposit.fromAsset);
    assert.equal(send.fields.toAddress, deposit.depositAddress);
    assert.equal(parseAmount(deposit.fromAsset, String(send.fields.amountText)), BigInt(deposit.fromAmountAtomic));
    const ctx = send.fields.pendingContext as Record<string, unknown>;
    assert.equal(ctx.kind, 'swap-deposit');
    assert.equal(ctx.provider, deposit.provider);
    assert.equal(ctx.tradeId, deposit.id);
    assert.equal(ctx.memo, deposit.memo);
    if (deposit.memo) {
      // Every binding the THORChain send gate checks: memo, quoted amount, deadline.
      assert.equal(ctx.amountAtomic, deposit.fromAmountAtomic);
      assert.equal(ctx.depositBeforeMs, deposit.depositBeforeMs);
    }
    // The seed the submit path compares against: the vault, not just any address.
    assert.deepEqual(send.fields.pendingContextSeed, {
      fromAssetId: deposit.fromAsset,
      toAddress: deposit.depositAddress,
    });
    assert.equal(swapStep(s, wizardId), 3, 'the swap moved to its status step');

    // Stored state agrees, and Send was never routed to without its deposit.
    assert.deepEqual(storage.history.at(-1), sortedCopy(s));
    assertNeverHalfStored(storage, deposit.depositAddress, provider);
  });

  test(`${provider}: declining to replace a Send draft keeps it, and the swap stays on its deposit step`, async () => {
    const { storage, store, mounts } = await popupOnDepositStep(wizardId, deposit, LTC_DRAFT);
    const writesBefore = storage.history.length;
    const tap = await tapOpenSend(store, wizardId, deposit, () => false);

    assert.equal(tap.opened, false);
    assert.equal(tap.asked.length, 1, 'asked once');
    assert.deepEqual(tap.told, [], 'a declined question needs no message');
    const s = await store.load();
    assert.equal(s.route.current, 'swap');
    assert.deepEqual(s.wizards[SEND_WIZARD_ID], LTC_DRAFT);
    assert.equal(swapStep(s, wizardId), 2, 'the deposit step, where the deposit can still be paid');
    assert.deepEqual(mounts, []);
    assert.equal(storage.history.length, writesBefore, 'nothing was written');
  });

  test(`${provider}: a Grin payment waiting for its reply is never replaced, and the user is told why`, async () => {
    const { storage, store, mounts } = await popupOnDepositStep(wizardId, deposit, GRIN_EXCHANGE);
    const writesBefore = storage.history.length;
    const tap = await tapOpenSend(store, wizardId, deposit, () => assert.fail('asked to replace a Grin payment'));

    assert.equal(tap.opened, false);
    assert.equal(tap.told.length, 1, 'the refusal is shown');
    assert.match(tap.told[0]!, /Grin/, 'the refusal names what it protects');
    const s = await store.load();
    assert.deepEqual(s.wizards[SEND_WIZARD_ID], GRIN_EXCHANGE, 'the sender context is still there to finalize');
    assert.equal(s.route.current, 'swap');
    assert.equal(swapStep(s, wizardId), 2);
    assert.deepEqual(mounts, []);
    assert.equal(storage.history.length, writesBefore, 'nothing was written');
  });
}

test('a Grin payment saved just before the handoff writes is still not replaced', async () => {
  const { store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT);
  // Queued ahead of the handoff's write, after it looked at Send: the write
  // itself must see it.
  void store.update((s) => {
    s.wizards[SEND_WIZARD_ID] = GRIN_EXCHANGE;
  });
  const tap = await tapOpenSend(store, TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT);
  assert.equal(tap.opened, false);
  assert.equal(tap.told.length, 1);
  const s = await store.load();
  assert.deepEqual(s.wizards[SEND_WIZARD_ID], GRIN_EXCHANGE);
  assert.equal(s.route.current, 'swap');
  assert.equal(swapStep(s, TROCADOR_WIZARD_ID), 2);
});

test('a replaced draft leaves nothing of itself behind', async () => {
  const draft: WizardState = {
    step: 3,
    startedAt: 5,
    fields: { fromAssetId: 'ltc', toAddress: 'ltc1qfriend', amountText: '1.5', feeTier: 'custom', customFeeRate: 40, sweep: true },
  };
  const { store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, draft);
  const tap = await tapOpenSend(store, TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT);
  assert.equal(tap.opened, true);
  assert.equal(tap.asked.length, 1);
  const send = (await store.load()).wizards[SEND_WIZARD_ID]!;
  assert.equal(send.step, 2);
  assert.deepEqual(
    Object.keys(send.fields).sort(),
    ['amountText', 'fromAssetId', 'pendingContext', 'pendingContextSeed', 'toAddress'],
  );
});

test('a finished send, an empty chooser or a cancelled Grin payment is not a draft to protect', async () => {
  assert.equal(sendDraftInProgress(undefined), false);
  assert.equal(sendDraftInProgress({ step: 0, startedAt: 1, fields: { fromAssetId: 'ltc' } }), false);
  assert.equal(
    sendDraftInProgress({ step: 4, startedAt: 1, fields: { fromAssetId: 'btc', toAddress: DEPOSIT_BTC, amountText: '0.001', lastTxid: 'ab' } }),
    false,
  );
  assert.equal(sendDraftInProgress({ step: 1, startedAt: 1, fields: { fromAssetId: 'btc' } }), true);
  assert.equal(sendDraftInProgress({ step: 0, startedAt: 1, fields: { amountText: '2' } }), true);

  assert.equal(sendGrinExchangeInFlight(undefined), false);
  assert.equal(sendGrinExchangeInFlight(LTC_DRAFT), false);
  assert.equal(sendGrinExchangeInFlight(GRIN_EXCHANGE), true);
  // Send's Cancel clears these fields; a finalized payment shows its receipt.
  assert.equal(
    sendGrinExchangeInFlight({ ...GRIN_EXCHANGE, fields: { ...GRIN_EXCHANGE.fields, grinSlateId: '', grinSenderContextJson: '' } }),
    false,
  );
  assert.equal(sendGrinExchangeInFlight({ ...GRIN_EXCHANGE, step: 4 }), false);

  const receipt: WizardState = { step: 4, startedAt: 1, fields: { fromAssetId: 'btc', toAddress: 'bc1qold', amountText: '0.001', lastTxid: 'ab' } };
  const { store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, receipt);
  const tap = await tapOpenSend(store, TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, () => assert.fail('asked to replace a receipt'));
  assert.equal(tap.opened, true);
  assert.equal((await store.load()).wizards[SEND_WIZARD_ID]!.fields.toAddress, DEPOSIT_BTC);
});

test("a coin screen's Send opens on that coin's address step, never the chooser", async () => {
  for (const leftover of [undefined, { step: 0, startedAt: 1, fields: { fromAssetId: 'ltc' } } satisfies WizardState]) {
    const { store, router, mounts } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, leftover);
    await router.navigate(`${SEND_ROUTE}/asset/btc`);
    await settle();
    assert.deepEqual(mounts, [`${SEND_ROUTE}/asset/btc`]);
    const send = (await store.load()).wizards[SEND_WIZARD_ID]!;
    assert.equal(send.step, 1);
    assert.deepEqual(send.fields, { fromAssetId: 'btc' });
  }
});

// ----- Inbox: a pasted GoblinPay link ----------------------------------------

test('a pasted pay link opens Send on its recipient, amount and memo', async () => {
  const { storage, store, mounts } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, undefined, 'home/inbox/paste');
  const asked: string[] = [];
  const result = await openPayLinkInSend(store, PAY_LINK, (q) => {
    asked.push(q);
    return true;
  });
  await settle();
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(asked, []);
  const s = await store.load();
  assert.equal(s.route.current, SEND_ROUTE);
  assert.deepEqual(mounts, [SEND_ROUTE]);
  const send = s.wizards[SEND_WIZARD_ID]!;
  assert.equal(send.step, 1);
  assert.deepEqual(send.fields, {
    fromAssetId: 'grin',
    toAddress: PAY_LINK.recipientPubkeyHex,
    amountText: PAY_LINK.amountGrin,
    grinPayMemo: PAY_LINK.memo,
  });
  assertNeverHalfStored(storage, PAY_LINK.recipientPubkeyHex, 'pay link');
});

test('a pasted pay link asks before replacing a Send draft, and keeps it when declined', async () => {
  const { storage, store, mounts } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, LTC_DRAFT, 'home/inbox/paste');
  const writesBefore = storage.history.length;
  let asked = 0;
  const result = await openPayLinkInSend(store, PAY_LINK, () => {
    asked += 1;
    return false;
  });
  await settle();
  assert.equal(asked, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.length > 0, 'Inbox says what happened');
  const s = await store.load();
  assert.deepEqual(s.wizards[SEND_WIZARD_ID], LTC_DRAFT);
  assert.equal(s.route.current, 'home/inbox/paste');
  assert.deepEqual(mounts, []);
  assert.equal(storage.history.length, writesBefore, 'nothing was written');

  const accepted = await openPayLinkInSend(store, PAY_LINK, () => true);
  await settle();
  assert.deepEqual(accepted, { ok: true });
  assert.equal((await store.load()).wizards[SEND_WIZARD_ID]!.fields.toAddress, PAY_LINK.recipientPubkeyHex);
});

test('a pasted pay link never replaces a Grin payment waiting for its reply', async () => {
  const { storage, store, mounts } = await popupOnDepositStep(
    TROCADOR_WIZARD_ID,
    TROCADOR_DEPOSIT,
    GRIN_EXCHANGE,
    'home/inbox/paste',
  );
  const writesBefore = storage.history.length;
  const result = await openPayLinkInSend(store, PAY_LINK, () => assert.fail('asked to replace a Grin payment'));
  await settle();
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /Grin/.test(result.error), 'the refusal names what it protects');
  const s = await store.load();
  assert.deepEqual(s.wizards[SEND_WIZARD_ID], GRIN_EXCHANGE, 'the sender context is still there to finalize');
  assert.equal(s.route.current, 'home/inbox/paste');
  assert.deepEqual(mounts, []);
  assert.equal(storage.history.length, writesBefore, 'nothing was written');
});

// ----- Another window saving in between ---------------------------------------

/**
 * A second popup window saves from the view it loaded before the handoff,
 * `ticks` turns of the event loop after the handoff starts: before, between
 * and after the handoff's writes, in every order the sweep reaches.
 */
async function otherWindowSavesAfter(other: SessionStateStore, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
  await other.update((s) => {
    s.ui.balanceHidden = !s.ui.balanceHidden;
  });
}

const SWEEP_TICKS = 16;

for (const [provider, wizardId, deposit] of PROVIDERS) {
  test(`${provider}: another window saving in between never leaves half a handoff, or a stranded deposit`, async () => {
    for (let ticks = 0; ticks < SWEEP_TICKS; ticks++) {
      const { storage, store } = await popupOnDepositStep(wizardId, deposit);
      const other = await secondWindow(storage);
      const saved = otherWindowSavesAfter(other, ticks);
      await tapOpenSend(store, wizardId, deposit);
      await saved;
      await settle();

      assertNeverHalfStored(storage, deposit.depositAddress, `${provider}, other window after ${ticks} ticks`);
      // The other window may undo the tap, but the deposit stays payable: Send
      // open on it, or the swap still on its deposit step.
      const s = await store.load();
      if (s.route.current.startsWith(SEND_ROUTE)) {
        assert.equal(s.wizards[SEND_WIZARD_ID]?.fields.toAddress, deposit.depositAddress);
      } else {
        assert.equal(swapStep(s, wizardId), 2, `${provider}, other window after ${ticks} ticks: deposit stranded`);
      }
      other.destroy();
      store.destroy();
    }
  });
}

test('pay link: another window saving in between never leaves half a handoff', async () => {
  for (let ticks = 0; ticks < SWEEP_TICKS; ticks++) {
    const { storage, store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, undefined, 'home/inbox/paste');
    const other = await secondWindow(storage);
    const saved = otherWindowSavesAfter(other, ticks);
    await openPayLinkInSend(store, PAY_LINK, () => true);
    await saved;
    await settle();
    assertNeverHalfStored(storage, PAY_LINK.recipientPubkeyHex, `pay link, other window after ${ticks} ticks`);
    other.destroy();
    store.destroy();
  }
});
