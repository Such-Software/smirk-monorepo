/**
 * The Swap tab's "Open Send → pre-filled" lands on Compose with the deposit.
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
 * Runs the popup's real handoff, the real session store and router over a
 * storage double that answers like chrome.storage.local, the Swap tab's own
 * status-step write racing it, and Send's real mount preparation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RouteController,
  SessionStateStore,
  Wizard,
  type PlatformStorage,
  type SessionState,
  type WizardState,
} from '@smirk/core';
import {
  SEND_WIZARD_ID,
  THORCHAIN_WIZARD_ID,
  TROCADOR_WIZARD_ID,
  prepareSendDraft,
  type SwapInFlight,
} from '@smirk/ui';
import { parseAmount } from '../format';
import { SEND_ROUTE, openSwapDepositInSend, sendDraftInProgress } from '../swap-handoff';

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
 * chrome.storage.local as an extension page sees it: writes applied in order
 * and announced to the writing page before their promise settles, reads
 * answered in order with keys sorted. Every state ever stored is kept.
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
    if (key === KEY) this.history.push(sortedCopy(value) as unknown as SessionState);
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

/**
 * A popup on the Swap tab's deposit step: the store, its router, and a Send
 * screen that mounts the way SendWizard does whenever the route reaches Send.
 */
async function popupOnDepositStep(wizardId: string, deposit: SwapInFlight, send?: WizardState) {
  const storage = new ChromeLikeStorage();
  const store = new SessionStateStore(storage);
  const router = new RouteController(store);
  await router.navigate('swap');
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

/** What DepositStep does on the tap: hand off, and move the swap to its status step. */
async function tapOpenSend(store: SessionStateStore, wizardId: string, deposit: SwapInFlight, confirm = () => true) {
  const opened = openSwapDepositInSend(store, deposit, confirm);
  void new Wizard(store, wizardId, {}).patchFields({ step: 3 });
  const result = await opened;
  await settle();
  return result;
}

for (const [provider, wizardId, deposit] of [
  ['Trocador', TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT],
  ['THORChain', THORCHAIN_WIZARD_ID, THORCHAIN_DEPOSIT],
] as const) {
  test(`${provider}: Open Send lands on Compose with the deposit's coin, address and exact amount`, async () => {
    const { storage, store, mounts } = await popupOnDepositStep(wizardId, deposit);
    assert.equal(await tapOpenSend(store, wizardId, deposit), true);

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
    if (deposit.memo) assert.equal(ctx.amountAtomic, deposit.fromAmountAtomic);
    assert.equal(s.wizards[wizardId]!.fields.step, 3, 'the swap moved to its status step');

    // Stored state agrees, and Send was never routed to without its deposit.
    assert.deepEqual(storage.history.at(-1), sortedCopy(s));
    for (const stored of storage.history.filter((h) => h.route.current.startsWith(SEND_ROUTE))) {
      assert.equal(stored.wizards[SEND_WIZARD_ID]?.fields.toAddress, deposit.depositAddress);
    }
  });
}

test('a Send draft in progress is kept when the user declines, and nothing moves', async () => {
  const draft: WizardState = {
    step: 2,
    startedAt: 5,
    fields: { fromAssetId: 'ltc', toAddress: 'ltc1qfriend', amountText: '1.5' },
  };
  const { store, mounts } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, draft);
  let asked = 0;
  const opened = await openSwapDepositInSend(store, TROCADOR_DEPOSIT, () => {
    asked += 1;
    return false;
  });
  await settle();
  assert.equal(opened, false);
  assert.equal(asked, 1);
  const s = await store.load();
  assert.equal(s.route.current, 'swap');
  assert.deepEqual(s.wizards[SEND_WIZARD_ID], draft);
  assert.deepEqual(mounts, []);
});

test('a replaced draft leaves nothing of itself behind', async () => {
  const draft: WizardState = {
    step: 3,
    startedAt: 5,
    fields: { fromAssetId: 'ltc', toAddress: 'ltc1qfriend', amountText: '1.5', feeTier: 'custom', customFeeRate: 40, sweep: true },
  };
  const { store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, draft);
  assert.equal(await tapOpenSend(store, TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT), true);
  const send = (await store.load()).wizards[SEND_WIZARD_ID]!;
  assert.equal(send.step, 2);
  assert.deepEqual(
    Object.keys(send.fields).sort(),
    ['amountText', 'fromAssetId', 'pendingContext', 'pendingContextSeed', 'toAddress'],
  );
});

test('a finished send or an empty chooser is not a draft to protect', async () => {
  assert.equal(sendDraftInProgress(undefined), false);
  assert.equal(sendDraftInProgress({ step: 0, startedAt: 1, fields: { fromAssetId: 'ltc' } }), false);
  assert.equal(
    sendDraftInProgress({ step: 4, startedAt: 1, fields: { fromAssetId: 'btc', toAddress: DEPOSIT_BTC, amountText: '0.001', lastTxid: 'ab' } }),
    false,
  );
  assert.equal(sendDraftInProgress({ step: 1, startedAt: 1, fields: { fromAssetId: 'btc' } }), true);
  assert.equal(sendDraftInProgress({ step: 0, startedAt: 1, fields: { amountText: '2' } }), true);

  const receipt: WizardState = { step: 4, startedAt: 1, fields: { fromAssetId: 'btc', toAddress: 'bc1qold', amountText: '0.001', lastTxid: 'ab' } };
  const { store } = await popupOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, receipt);
  assert.equal(await tapOpenSend(store, TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, () => assert.fail('asked to replace a receipt')), true);
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
