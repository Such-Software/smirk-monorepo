/**
 * LIVE: sends and receives on all five coins among the three demo wallets.
 *
 * THIS SPENDS REAL FUNDS. It runs only in the reviewed live lane
 * (B-send-receive-history.live.config.ts) and only with every gate open:
 * E2E_LIVE=1 registers it, E2E_LIVE_MONEY=1 permits a broadcast, and
 * ALLOW_PROD_WRITES=1 is required against a shared backend. Without
 * E2E_LIVE=1 this file defines no tests at all, so the ordinary suite neither
 * runs nor skips it.
 *
 * Money moves only among alice, bob and carol, in the smallest amounts the
 * scenario names. Destinations come from the wallets' own Receive and Nostr
 * screens (the AddressBook allowlist); every leg is reserved in the spend
 * ledger against per-send and per-run caps before its Send tap; a leg that
 * already broadcast in an earlier attempt of the same run is resumed, never
 * paid twice. Review-only and refusal checks block every broadcast endpoint
 * and assert none was attempted.
 *
 * Every step asserts an outcome: the receipt's txid, the recipient's pending
 * incoming row and amount, confirmations rising, and both balances moving by
 * the amount (and the fee) once settled. A coin whose demo wallets cannot
 * fund the planned legs skips with the shortfall as its reason.
 *
 * Footage (FOOTAGE=guarded) follows the owner's video policy through the
 * fixture's hooks; see fixtures/B-send-receive-history-footage.ts.
 */

import { test, expect, LIVE_LANE, type LiveLane } from '../../fixtures/B-send-receive-history-wallets.js';
import {
  dappPaymentApproval,
  ensureDestinations,
  expectIncoming,
  expectSettledBalances,
  fundingShortfall,
  goHome,
  grinLeg,
  grinSettled,
  maxReviewOnly,
  openCoin,
  outgoingRowIds,
  paylinkPrefill,
  readNpub,
  readReceiveAddress,
  refusedDestination,
  sendLeg,
  truncId,
  waitConfirmations,
  type GrinLeg,
  type SendLeg,
} from '../../fixtures/B-send-receive-history-flows.js';
import { LIVE_ASSETS, TICKER, WALLET_NAMES, type LiveAsset, type WalletName } from '../../fixtures/live-send.js';

function requireMoney(live: LiveLane): void {
  const gate = live.moneyAllowed();
  if (!gate.ok) {
    live.progress(`skip: ${gate.reason}`);
    test.skip(true, gate.reason);
  }
}

async function requireFunding(
  live: LiveLane,
  asset: LiveAsset,
  legs: ReadonlyArray<{ id: string; from: WalletName; to: WalletName; amount: string }>,
): Promise<void> {
  const reason = await fundingShortfall(live, asset, legs);
  if (reason) {
    live.progress(`skip ${TICKER[asset]}: ${reason}`);
    test.skip(true, reason);
  }
}

/** Snapshot every wallet's outgoing rows on a CryptoNote coin, before its legs. */
async function outgoingSnapshot(live: LiveLane, asset: 'xmr' | 'wow'): Promise<Map<WalletName, Set<string>>> {
  const out = new Map<WalletName, Set<string>>();
  for (const name of WALLET_NAMES) {
    await openCoin(live, live.wallets[name], asset);
    out.set(name, await outgoingRowIds(live.wallets[name]));
  }
  return out;
}

/**
 * Ring decoys never show as sends: after the legs, the only new outgoing rows
 * on any wallet are the sends that wallet made in this run.
 */
async function expectNoDecoySends(live: LiveLane, asset: 'xmr' | 'wow', before: Map<WalletName, Set<string>>): Promise<void> {
  for (const name of WALLET_NAMES) {
    const w = live.wallets[name];
    await openCoin(live, w, asset);
    const after = await outgoingRowIds(w);
    const ours = new Set(
      live.ledger
        .entries(asset)
        .filter((e) => e.from === name && e.status === 'broadcast' && e.txid)
        .map((e) => truncId(e.txid!)),
    );
    const added = [...after].filter((id) => !before.get(name)!.has(id));
    expect(added.every((id) => ours.has(id)), `${name}'s new ${TICKER[asset]} sends are all its own`).toBe(true);
    expect([...ours].every((id) => after.has(id)), `${name}'s ${TICKER[asset]} sends all show as sends`).toBe(true);
    await w.footage.result('Activity shows only real sends');
  }
  live.progress(`${TICKER[asset]}: no ring decoy appeared as a send on any wallet`);
}

if (LIVE_LANE) {
  test.describe('B live: sends and receives on all five coins', () => {
    test.describe.configure({ timeout: 3 * 60 * 60_000 });

    test('receive screens show each wallet\'s address for every coin, and its npub', async ({ live }) => {
      // alice and bob through Home's picker, carol from each coin screen,
      // which must open Receive on that coin without the picker.
      for (const asset of LIVE_ASSETS) {
        await readReceiveAddress(live, live.wallets.alice, asset, 'home');
        await readReceiveAddress(live, live.wallets.bob, asset, 'home');
        await readReceiveAddress(live, live.wallets.carol, asset, 'coin');
      }
      for (const name of WALLET_NAMES) await readNpub(live, live.wallets[name]);
      for (const asset of LIVE_ASSETS) {
        const seen = new Set(WALLET_NAMES.map((n) => live.book.get(n, asset)));
        expect(seen.size, `three distinct ${TICKER[asset]} addresses`).toBe(3);
      }
    });

    test('BTC: alice pays bob 5,000 sat across every fee tier, bob pays carol 2,500 after a confirmation, carol pays alice 1,500', async ({ live }) => {
      requireMoney(live);
      await ensureDestinations(live, 'btc', WALLET_NAMES);
      const legs: SendLeg[] = [
        { id: 'btc-1', asset: 'btc', from: 'alice', to: 'bob', amount: '0.00005', feeTour: true },
        { id: 'btc-2', asset: 'btc', from: 'bob', to: 'carol', amount: '0.000025' },
        { id: 'btc-3', asset: 'btc', from: 'carol', to: 'alice', amount: '0.000015' },
      ];
      await requireFunding(live, 'btc', legs);
      for (const leg of legs) {
        const sent = await sendLeg(live, leg);
        await expectIncoming(live, sent);
        await waitConfirmations(live, live.wallets[leg.to], 'btc', { txid: sent.txid }, 1, `${leg.id} receive`);
        await expectSettledBalances(live, sent);
      }
    });

    test('LTC: alice pays bob 0.02, bob pays carol 0.01, carol pays alice 0.005', async ({ live }) => {
      requireMoney(live);
      await ensureDestinations(live, 'ltc', WALLET_NAMES);
      const legs: SendLeg[] = [
        { id: 'ltc-1', asset: 'ltc', from: 'alice', to: 'bob', amount: '0.02' },
        { id: 'ltc-2', asset: 'ltc', from: 'bob', to: 'carol', amount: '0.01' },
        { id: 'ltc-3', asset: 'ltc', from: 'carol', to: 'alice', amount: '0.005' },
      ];
      await requireFunding(live, 'ltc', legs);
      for (const leg of legs) {
        const sent = await sendLeg(live, leg);
        await expectIncoming(live, sent);
        await waitConfirmations(live, live.wallets[leg.to], 'ltc', { txid: sent.txid }, 1, `${leg.id} receive`);
        await expectSettledBalances(live, sent);
      }
    });

    test('XMR: alice pays bob 0.02, ten blocks, bob pays carol 0.01, ten blocks, carol pays alice 0.005; decoys never show as sends', async ({ live }) => {
      requireMoney(live);
      await ensureDestinations(live, 'xmr', WALLET_NAMES);
      const legs: SendLeg[] = [
        { id: 'xmr-1', asset: 'xmr', from: 'alice', to: 'bob', amount: '0.02' },
        { id: 'xmr-2', asset: 'xmr', from: 'bob', to: 'carol', amount: '0.01' },
        { id: 'xmr-3', asset: 'xmr', from: 'carol', to: 'alice', amount: '0.005' },
      ];
      await requireFunding(live, 'xmr', legs);
      const before = await outgoingSnapshot(live, 'xmr');
      for (const leg of legs) {
        const sent = await sendLeg(live, leg);
        await expectIncoming(live, sent);
        // CryptoNote outputs unlock after ten confirmations.
        await waitConfirmations(live, live.wallets[leg.to], 'xmr', { txid: sent.txid }, 10, `${leg.id} receive`);
        await expectSettledBalances(live, sent);
      }
      await expectNoDecoySends(live, 'xmr', before);
    });

    test('WOW: alice pays bob 2, four blocks, bob pays carol 1, carol pays alice 0.5; decoys never show as sends', async ({ live }) => {
      requireMoney(live);
      await ensureDestinations(live, 'wow', WALLET_NAMES);
      const legs: SendLeg[] = [
        { id: 'wow-1', asset: 'wow', from: 'alice', to: 'bob', amount: '2' },
        { id: 'wow-2', asset: 'wow', from: 'bob', to: 'carol', amount: '1' },
        { id: 'wow-3', asset: 'wow', from: 'carol', to: 'alice', amount: '0.5' },
      ];
      await requireFunding(live, 'wow', legs);
      const before = await outgoingSnapshot(live, 'wow');
      for (const leg of legs) {
        const sent = await sendLeg(live, leg);
        await expectIncoming(live, sent);
        await waitConfirmations(live, live.wallets[leg.to], 'wow', { txid: sent.txid }, 4, `${leg.id} receive`);
        await expectSettledBalances(live, sent);
      }
      await expectNoDecoySends(live, 'wow', before);
    });

    test('GRIN: carol pays alice\'s npub over Nostr (alice signs in To sign, carol finalizes in To finalize), then alice pays bob by pasted slatepack, then bob pays carol\'s address', async ({ live }) => {
      requireMoney(live);
      for (const name of WALLET_NAMES) {
        if (!live.book.has(name, 'grin', 'npub')) await readNpub(live, live.wallets[name]);
      }
      await ensureDestinations(live, 'grin', WALLET_NAMES);
      const legs: GrinLeg[] = [
        { id: 'grin-1', from: 'carol', to: 'alice', amount: '1', via: 'npub' },
        { id: 'grin-2', from: 'alice', to: 'bob', amount: '0.5', via: 'pasted' },
        { id: 'grin-3', from: 'bob', to: 'carol', amount: '0.25', via: 'address' },
      ];
      await requireFunding(live, 'grin', legs);
      for (const leg of legs) {
        const sent = await grinLeg(live, leg);
        // "After 10 confirmations": mined and spendable, then ten more blocks.
        await grinSettled(live, sent);
      }
    });

    test('USD in every coin header, the Home fiat total, and a fresh freshness cue on every wallet', async ({ live }) => {
      for (const name of WALLET_NAMES) {
        const w = live.wallets[name];
        await goHome(w);
        await w.footage.result('Home fiat total');
        for (const asset of LIVE_ASSETS) {
          // openCoin requires the USD line for every priced coin with a balance,
          // and goHome requires a resolved total and a fresh cue.
          await openCoin(live, w, asset);
          await w.footage.result('Coin header with its USD value');
        }
      }
    });

    test('Max on a small balance shows the sweep note and reaches Review, never sent', async ({ live }) => {
      for (const asset of ['ltc', 'xmr'] as const) {
        // The smallest spendable balance among the three, paid to the next wallet.
        let pick: { name: WalletName; confirmed: bigint } | null = null;
        for (const name of WALLET_NAMES) {
          const h = await openCoin(live, live.wallets[name], asset);
          if (h.confirmed > 0n && (!pick || h.confirmed < pick.confirmed)) pick = { name, confirmed: h.confirmed };
        }
        if (!pick) {
          const reason = `no demo wallet holds spendable ${TICKER[asset]} for the Max check`;
          live.progress(`skip: ${reason}`);
          test.skip(true, reason);
          return;
        }
        await ensureDestinations(live, asset, WALLET_NAMES);
        const to = WALLET_NAMES[(WALLET_NAMES.indexOf(pick.name) + 1) % WALLET_NAMES.length]!;
        await maxReviewOnly(live, live.wallets[pick.name], asset, to);
      }
    });

    test('malformed and unusable-key destinations are refused before signing, with nothing broadcast', async ({ live }) => {
      for (const asset of ['btc', 'xmr', 'wow'] as const) await ensureDestinations(live, asset, ['bob']);
      const alice = live.wallets.alice;
      await refusedDestination(live, alice, 'btc', 'malformed', 'bob');
      await refusedDestination(live, alice, 'xmr', 'malformed', 'bob');
      await refusedDestination(live, alice, 'xmr', 'unusable-key', 'bob');
      await refusedDestination(live, alice, 'wow', 'unusable-key', 'bob');
    });

    test('a GoblinPay pay-link pre-fills a Grin send to the payee, without building or broadcasting', async ({ live }) => {
      if (!live.book.has('alice', 'grin', 'npub')) await readNpub(live, live.wallets.alice);
      await paylinkPrefill(live, live.wallets.carol, 'alice', '0.1');
    });

    test('a shop\'s payment request shows the human amount in the approval popup; Deny broadcasts nothing', async ({ live }) => {
      await ensureDestinations(live, 'wow', ['bob']);
      await dappPaymentApproval(live, live.wallets.alice, 'bob');
    });
  });
}
