/**
 * What the demo wallets were before v0.3.1 existed: the facts a v0.3.1 import
 * of each seed must keep. Comparing a v0.3.1 import with another v0.3.1 import
 * cannot show that; a build that minted a new account for an old seed, or that
 * restored without the old history, would agree with itself.
 *
 * Nothing here is a secret.
 *   - User ids: the v3 (api.smirk.cash) identities table of the demo wallet
 *     reference beside the custody file (WALLETS.md, generated 2026-08-24). The
 *     same seeds were already registered then ("isNew: false" for all three).
 *   - Chain facts: the 2026-10-03 demo wallet balance review (journal,
 *     ops/handoffs/smirk), read from the shipped extension's history: Alice
 *     received 0.05 and 0.14 XMR (blocks 3699306 and 3700373) and 20 WOW (block
 *     848913) and holds about 0.19 XMR and 19.78 WOW; Bob received 0.1 WOW twice
 *     (blocks 849073 and 849098) and holds 0.2 WOW; Carol has no history; Alice
 *     has one cancelled public-link tip on XMR.
 *
 * Funds circulate among the three wallets in the money areas, so balances are
 * asserted as "still holds some", not as amounts; the 2026-10-03 amounts are
 * recorded beside the observed ones for the owner. Receipts and the cancelled
 * tip are history: later activity adds to it and never removes them.
 *
 * E2E_BASELINE_FILE replaces this with a JSON file of the same shape, for a
 * different set of wallets. A wallet missing from it has no baseline, and the
 * scenarios that need one skip with that reason, which the lane reports.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { AssetId } from './live-wallets.js';

export interface WalletBaseline {
  /** The v3 user id this seed was registered as before v0.3.1. */
  userId: string;
  /** Incoming amounts on chain before v0.3.1, per asset, as the history shows them. */
  receipts: Partial<Record<AssetId, readonly string[]>>;
  /**
   * The earliest receipt's block per CryptoNote chain. A restore whose scan
   * starts above it cannot show that receipt, so its start height must not.
   */
  firstReceiptHeight: Partial<Record<'xmr' | 'wow', number>>;
  /** Assets the wallet held at the baseline: they must still show a positive balance. */
  holds: readonly AssetId[];
  /** Balances at the baseline, recorded for the owner's comparison only. */
  balancesAtBaseline: Partial<Record<AssetId, string>>;
  /** Sent tips on the account: an asset, who it went to, and a status the badge starts with. */
  sentTips: ReadonlyArray<{ asset: AssetId; recipient: string; status: string }>;
}

export interface DemoBaseline {
  /** The date the facts were read. */
  asOf: string;
  wallets: Readonly<Record<string, WalletBaseline>>;
}

const DEMO_WALLET_BASELINES: Record<string, WalletBaseline> = {
  alice: {
    userId: 'da674ba7-b520-48a8-8bb5-59022d96df07',
    receipts: { xmr: ['0.05', '0.14'], wow: ['20'] },
    firstReceiptHeight: { xmr: 3_699_306, wow: 848_913 },
    holds: ['xmr', 'wow'],
    balancesAtBaseline: { xmr: '0.19', wow: '19.78' },
    sentTips: [{ asset: 'xmr', recipient: 'link', status: 'Cancelled' }],
  },
  bob: {
    userId: '74123af7-85fa-4159-bdb9-66d082ed1764',
    receipts: { wow: ['0.1', '0.1'] },
    firstReceiptHeight: { wow: 849_073 },
    holds: ['wow'],
    balancesAtBaseline: { wow: '0.2' },
    sentTips: [],
  },
  carol: {
    userId: '00d7e9a8-1342-4a02-898d-d7ba504d98a8',
    receipts: {},
    firstReceiptHeight: {},
    holds: [],
    balancesAtBaseline: {},
    sentTips: [],
  },
};

export const DEMO_BASELINE: DemoBaseline = Object.freeze({
  asOf: '2026-10-03',
  wallets: Object.freeze(DEMO_WALLET_BASELINES),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The baseline in force: E2E_BASELINE_FILE when set (and valid), else the shipped one. */
export function loadBaseline(): DemoBaseline {
  const file = process.env.E2E_BASELINE_FILE;
  if (!file) return DEMO_BASELINE;
  if (!existsSync(file)) throw new Error('E2E_BASELINE_FILE does not exist');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DemoBaseline> | null;
  if (!parsed || typeof parsed !== 'object' || !parsed.wallets || typeof parsed.wallets !== 'object') {
    throw new Error('E2E_BASELINE_FILE must hold { "asOf": "...", "wallets": { "<name>": { "userId": "...", ... } } }');
  }
  return { asOf: String(parsed.asOf ?? 'unknown'), wallets: parsed.wallets };
}

/** One wallet's baseline, or null when there is none or it names no valid user id. */
export function baselineFor(name: string): WalletBaseline | null {
  const entry = loadBaseline().wallets[name];
  if (!entry || typeof entry.userId !== 'string' || !UUID.test(entry.userId)) return null;
  return {
    userId: entry.userId,
    receipts: entry.receipts ?? {},
    firstReceiptHeight: entry.firstReceiptHeight ?? {},
    holds: entry.holds ?? [],
    balancesAtBaseline: entry.balancesAtBaseline ?? {},
    sentTips: entry.sentTips ?? [],
  };
}
