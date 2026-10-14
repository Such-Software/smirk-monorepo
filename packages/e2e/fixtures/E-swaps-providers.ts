import { activeVaultAddresses } from './E-swaps-thorvaults.mjs';

/**
 * Independent checks of what the wallet told THORChain, made from the test
 * runner rather than the wallet: the vault the deposit went to, and the memo
 * THORChain observed on it. These read THORChain's public API only.
 */

/** The wallet's default gateway (DEFAULT_THORNODE_URL in @smirk/swap). */
export const THORNODE = process.env.E2E_THORNODE_URL ?? 'https://gateway.liquify.com/chain/thorchain_api';

/** At least this long between the runner's own THORChain requests, as the wallet spaces its own. */
const SPACING_MS = 1_100;
let lastRequestAt = 0;

/**
 * One spaced GET to THORChain, retried once on a rate limit or server error.
 * Returns the response; network failures throw.
 */
async function thorFetch(path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + SPACING_MS * (attempt + 1) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const res = await fetch(`${THORNODE}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
    return res;
  }
}

async function thor<T>(path: string): Promise<T> {
  const res = await thorFetch(path);
  if (!res.ok) throw new Error(`THORChain ${path.split('?')[0]} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The vault addresses a quoted deposit on `chain` may name: every ActiveVault
 * of an unhalted chain (see E-swaps-thorvaults.mjs for why not just the
 * advertised inbound address).
 */
export async function thorActiveVaults(chain: 'BTC' | 'LTC'): Promise<string[]> {
  const inbound = await thor<Array<{ chain?: string; halted?: boolean }>>('/thorchain/inbound_addresses');
  const asgard = await thor<Array<{ status?: string; addresses?: Array<{ chain?: string; address?: string }> }>>('/thorchain/vaults/asgard');
  return activeVaultAddresses(chain, inbound, asgard);
}

export interface ThorObserved {
  chain: string;
  toAddress: string;
  memo: string;
}

/** The inbound transaction as THORChain observed it, or null before it does. */
export async function thorObservedTx(txid: string): Promise<ThorObserved | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('not a transaction id');
  const status = await thor<{ tx?: { chain?: string; to_address?: string; memo?: string } }>(
    `/thorchain/tx/status/${txid.toUpperCase()}`,
  );
  const tx = status.tx;
  if (!tx?.memo || !tx.to_address) return null;
  return { chain: tx.chain ?? '', toAddress: tx.to_address, memo: tx.memo };
}

/** THORChain's answer to the quote a wallet is about to ask for. */
export type ThorProbe = { ok: true; recommendedMinIn: bigint | null } | { ok: false; reason: string };

/**
 * Planning only, before any wallet is chosen: ask THORChain's public quote
 * endpoint the question the wallet's own quote will ask (same pools, amount
 * in 1e8 units, the wallet's 3% tolerance, the affiliate the wallet server
 * names, no destination). The wallet's own answer stays authoritative.
 */
export async function thorQuoteProbe(
  from: 'BTC' | 'LTC',
  to: 'BTC' | 'LTC',
  amountAtomic: bigint,
  affiliate: { name: string; bps: number } | null,
): Promise<ThorProbe> {
  const q = new URLSearchParams({
    from_asset: `${from}.${from}`,
    to_asset: `${to}.${to}`,
    amount: amountAtomic.toString(),
    tolerance_bps: '300',
  });
  if (affiliate) {
    q.set('affiliate', affiliate.name);
    q.set('affiliate_bps', String(affiliate.bps));
  }
  let res: Response;
  try {
    res = await thorFetch(`/thorchain/quote/swap?${q.toString()}`);
  } catch {
    return { ok: false, reason: 'THORChain did not answer the planning quote' };
  }
  const body = (await res.json().catch(() => null)) as { recommended_min_amount_in?: string } | null;
  if (!res.ok) return { ok: false, reason: `THORChain refused the planning quote (HTTP ${res.status})` };
  const min = body?.recommended_min_amount_in;
  return { ok: true, recommendedMinIn: min && /^\d+$/.test(min) ? BigInt(min) : null };
}

/** `=:ASSET:DEST[/REFUND]:LIMIT[...]`, as THORChain writes swap memos. */
export function parseThorMemo(memo: string): { asset: string; destination: string; limit: string } | null {
  const parts = memo.split(':');
  if (parts.length < 4 || !['=', 's', 'SWAP'].includes(parts[0] ?? '')) return null;
  const destination = (parts[2] ?? '').split('/')[0] ?? '';
  return { asset: (parts[1] ?? '').toUpperCase(), destination, limit: parts[3] ?? '' };
}

/** Memo asset codes, long and short form, per destination coin. */
export const THOR_ASSET_CODES: Readonly<Record<'btc' | 'ltc', readonly string[]>> = {
  btc: ['BTC.BTC', 'B'],
  ltc: ['LTC.LTC', 'L'],
};

/**
 * Valid mainnet addresses that are not the demo wallet's, used only where the
 * wallet must REFUSE them; nothing is ever sent to them.
 *
 * BTC and LTC: synthetic bech32 programs with no known keys, from the recorded
 * THORChain fixture (packages/swap/src/__tests__/fixtures/thorchain).
 * XMR and WOW: the v2 derivations of the public BIP-39 test vector
 * ("abandon" x11 "about"), pinned in packages/core/src/__tests__/legacy-recovery.test.ts.
 */
export const FOREIGN_ADDRESS: Readonly<Record<'btc' | 'ltc' | 'xmr' | 'wow', string>> = {
  btc: 'bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv',
  ltc: 'ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz',
  xmr: '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR',
  wow: 'Wo4QCU357B96b79xKHCbmL6gj5uSwArGCfegF5RE1hXSE3crtrvDKjsZ9qs3iBsy1mbgD11abnPkWX7Rp5NFYSdi22NnfZVGZ',
};
