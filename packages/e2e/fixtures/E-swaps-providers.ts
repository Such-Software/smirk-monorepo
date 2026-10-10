/**
 * Independent checks of what the wallet told THORChain, made from the test
 * runner rather than the wallet: the vault the deposit went to, and the memo
 * THORChain observed on it. These read THORChain's public API only.
 */

/** The wallet's default gateway (DEFAULT_THORNODE_URL in @smirk/swap). */
export const THORNODE = process.env.E2E_THORNODE_URL ?? 'https://gateway.liquify.com/chain/thorchain_api';

async function thor<T>(path: string): Promise<T> {
  const res = await fetch(`${THORNODE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`THORChain ${path.split('?')[0]} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** THORChain's current inbound (vault) address for a chain. */
export async function thorInbound(chain: 'BTC' | 'LTC'): Promise<string> {
  const list = await thor<Array<{ chain: string; address?: string }>>('/thorchain/inbound_addresses');
  const hit = list.find((x) => x.chain === chain)?.address;
  if (!hit) throw new Error(`THORChain publishes no ${chain} inbound address`);
  return hit;
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
