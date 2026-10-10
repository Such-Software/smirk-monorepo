/**
 * LIVE: sends, receives and their history on all five coins among the three
 * demo wallets.
 *
 * THIS SPENDS REAL FUNDS. It runs only in the reviewed live lane
 * (B-send-receive-history.live.config.ts) and only with every gate open:
 * E2E_LIVE=1 registers it, E2E_LIVE_MONEY=1 permits a broadcast, and
 * ALLOW_PROD_WRITES=1 is required against a shared backend. Without
 * E2E_LIVE=1 this file defines no tests at all, so the ordinary suite neither
 * runs nor skips it (the default config also ignores tests/live).
 *
 * Money moves only among alice, bob and carol, in small amounts that
 * circulate: each coin's three payments form a ring (fixtures/live-send.ts,
 * RING_AMOUNTS), so a ring costs three network fees. Destinations come from
 * the wallets' own Receive and Nostr screens (the AddressBook allowlist);
 * every leg is reserved in the spend ledger against per-send and per-run caps
 * before its Send tap; a leg that already broadcast in an earlier attempt of
 * the same run is resumed, never paid twice. Review-only and refusal checks
 * block every broadcast endpoint and assert none was attempted.
 *
 * Order: cheap checks first. Addresses, then the funding check, which reads
 * every balance and refuses before any money moves if a ring cannot be paid;
 * then the checks that spend nothing; then the money, coin by coin.
 *
 * Every payment is checked end to end in one test, so in one worker and the
 * browser profiles that made it: the receipt's id, the recipient's pending
 * incoming row and amount (watched while the sender holds its receipt), the
 * confirmations, both balances moving by the amount and the fee, and then the
 * history detail sheet on both sides (recipient, fee, time, confirmations,
 * txid, the explorer action, and on XMR/WOW the transaction key offered only
 * masked). Grin waits ten blocks past spendable, measured on the chain.
 *
 * Footage (FOOTAGE=guarded) follows the owner's video policy through the
 * fixture's hooks; see fixtures/B-send-receive-history-footage.ts.
 */

import { test, expect, LIVE_LANE, type LiveLane } from '../../fixtures/B-send-receive-history-wallets.js';
import {
  RECEIVE_CONFIRMATIONS,
  dappApprovals,
  ensureDestinations,
  expectSettledBalances,
  goHome,
  grinHistoryDetail,
  grinLeg,
  grinSettled,
  historyDetail,
  maxReviewOnly,
  openCoin,
  outgoingRowIds,
  paylinkPrefill,
  planCoin,
  readNpub,
  readReceiveAddress,
  refusedDestination,
  sendLeg,
  truncId,
  waitConfirmations,
} from '../../fixtures/B-send-receive-history-flows.js';
import {
  CHAIN_RING,
  GRIN_RING,
  LIVE_ASSETS,
  TICKER,
  WALLET_NAMES,
  type LiveAsset,
  type PlannedLeg,
  type WalletName,
} from '../../fixtures/live-send.js';

const HOUR = 60 * 60_000;

function requireMoney(live: LiveLane): void {
  const gate = live.moneyAllowed();
  if (!gate.ok) {
    live.progress(`skip: ${gate.reason}`);
    test.skip(true, gate.reason);
  }
}

/** Plan a coin's ring from the balances now; a ring nobody can fund skips with the shortfall. */
async function requirePlan(live: LiveLane, asset: LiveAsset): Promise<PlannedLeg[]> {
  const plan = await planCoin(live, asset, asset === 'grin' ? GRIN_RING : CHAIN_RING);
  if (!plan.ok) {
    live.progress(`skip ${TICKER[asset]}: ${plan.reason}`);
    test.skip(true, plan.reason);
    return [];
  }
  return plan.legs;
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

/** One on-chain coin's ring: each payment sent, received, confirmed, settled and read back in history. */
async function chainRing(live: LiveLane, asset: Exclude<LiveAsset, 'grin'>, legs: PlannedLeg[]): Promise<void> {
  for (const [i, leg] of legs.entries()) {
    const sent = await sendLeg(live, {
      id: leg.id,
      asset,
      from: leg.from,
      to: leg.to,
      amount: leg.amount,
      // BTC: every fee tier and the custom floor, once, on the ring's first payment.
      feeTour: asset === 'btc' && leg.position === 0,
    });
    await waitConfirmations(live, live.wallets[leg.to], asset, { txid: sent.txid }, RECEIVE_CONFIRMATIONS[asset], `${leg.id} receive`);
    await expectSettledBalances(live, sent);
    // XMR/WOW: on the first payment, also hold the sheet open while one more block lands.
    await historyDetail(live, sent, { watchRise: i === 0 });
  }
}

if (LIVE_LANE) {
  test.describe('B live: sends, receives and history on all five coins', () => {
    test('receive screens show each wallet\'s address for every coin, and its npub', async ({ live }) => {
      test.setTimeout(2 * HOUR);
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

    test('funding: every coin\'s ring of payments can be paid from the wallets\' balances, before any money moves', async ({ live }) => {
      test.setTimeout(2 * HOUR);
      const refused: string[] = [];
      for (const asset of LIVE_ASSETS) {
        const plan = await planCoin(live, asset, asset === 'grin' ? GRIN_RING : CHAIN_RING, { show: true });
        if (!plan.ok) refused.push(plan.reason);
      }
      // The reasons are in the progress log too: the reporter withholds assertion values.
      expect(refused, 'every coin can fund its ring; fund the wallet each reason names').toEqual([]);
    });

    test('USD in every coin header, the Home fiat total, and a fresh freshness cue on every wallet', async ({ live }) => {
      test.setTimeout(2 * HOUR);
      for (const name of WALLET_NAMES) {
        const w = live.wallets[name];
        await goHome(w, { strict: true });
        await w.footage.result('Home fiat total');
        for (const asset of LIVE_ASSETS) {
          // Strict: the USD line for every priced coin with a balance, and
          // on the way a resolved Home total and a fresh cue.
          await openCoin(live, w, asset, { strict: true });
          await w.footage.result('Coin header with its USD value');
        }
      }
    });

    test('malformed and unusable-key destinations are refused before signing, with nothing broadcast', async ({ live }) => {
      test.setTimeout(HOUR);
      for (const asset of ['btc', 'xmr', 'wow'] as const) await ensureDestinations(live, asset, ['bob']);
      const alice = live.wallets.alice;
      await refusedDestination(live, alice, 'btc', 'malformed', 'bob');
      await refusedDestination(live, alice, 'xmr', 'malformed', 'bob');
      await refusedDestination(live, alice, 'xmr', 'unusable-key', 'bob');
      await refusedDestination(live, alice, 'wow', 'unusable-key', 'bob');
    });

    test('Max on a small balance shows the sweep note and reaches Review, never sent', async ({ live }) => {
      test.setTimeout(HOUR);
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

    test('a GoblinPay pay-link pre-fills a Grin send to the payee, without building or broadcasting', async ({ live }) => {
      test.setTimeout(HOUR);
      if (!live.book.has('alice', 'grin', 'npub')) await readNpub(live, live.wallets.alice);
      await paylinkPrefill(live, live.wallets.carol, 'alice', '0.1');
    });

    test('a shop connects through the connect approval, its payment request shows in human units and Deny broadcasts nothing', async ({ live }) => {
      test.setTimeout(HOUR);
      await ensureDestinations(live, 'wow', ['bob']);
      await dappApprovals(live, live.wallets.alice, 'bob');
    });

    test('BTC: a ring of three payments (every fee tier on the first), each confirmed, settled and read back in history', async ({ live }) => {
      test.setTimeout(8 * HOUR);
      requireMoney(live);
      await ensureDestinations(live, 'btc', WALLET_NAMES);
      await chainRing(live, 'btc', await requirePlan(live, 'btc'));
    });

    test('LTC: a ring of three payments, each confirmed, settled and read back in history', async ({ live }) => {
      test.setTimeout(4 * HOUR);
      requireMoney(live);
      await ensureDestinations(live, 'ltc', WALLET_NAMES);
      await chainRing(live, 'ltc', await requirePlan(live, 'ltc'));
    });

    test('XMR: a ring of three payments, ten blocks each, read back in history with the key masked; decoys never show as sends', async ({ live }) => {
      test.setTimeout(6 * HOUR);
      requireMoney(live);
      await ensureDestinations(live, 'xmr', WALLET_NAMES);
      const legs = await requirePlan(live, 'xmr');
      const before = await outgoingSnapshot(live, 'xmr');
      await chainRing(live, 'xmr', legs);
      await expectNoDecoySends(live, 'xmr', before);
    });

    test('WOW: a ring of three payments, four blocks each, read back in history with the key masked; decoys never show as sends', async ({ live }) => {
      test.setTimeout(6 * HOUR);
      requireMoney(live);
      await ensureDestinations(live, 'wow', WALLET_NAMES);
      const legs = await requirePlan(live, 'wow');
      const before = await outgoingSnapshot(live, 'wow');
      await chainRing(live, 'wow', legs);
      await expectNoDecoySends(live, 'wow', before);
    });

    test('GRIN: a ring over Nostr npub (To sign, To finalize), pasted slatepack and grin1 address, each ten blocks past spendable and read back in history', async ({ live }) => {
      test.setTimeout(5 * HOUR);
      requireMoney(live);
      for (const name of WALLET_NAMES) {
        if (!live.book.has(name, 'grin', 'npub')) await readNpub(live, live.wallets[name]);
      }
      await ensureDestinations(live, 'grin', WALLET_NAMES);
      for (const leg of await requirePlan(live, 'grin')) {
        // Built, exchanged, finalized; the recipient's total grows by the amount.
        const sent = await grinLeg(live, { id: leg.id, from: leg.from, to: leg.to, amount: leg.amount, via: leg.via! });
        await grinSettled(live, sent);
        await grinHistoryDetail(live, sent);
      }
    });
  });
}
