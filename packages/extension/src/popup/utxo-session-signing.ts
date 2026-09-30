import { HDKey } from '@scure/bip32';
import { NETWORK, Transaction, p2wpkh } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import type { UnlockedWallet } from '@smirk/core';

const LTC_NETWORK = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 } as const;

/** Sign BIP84 inputs from one scoped account, including receive and change paths. */
export function signUtxoSessionTransaction(args: {
  wallet: UnlockedWallet;
  asset: 'btc' | 'ltc';
  inputs: Array<{ txid: string; vout: number; value: number; masterPath: string; ownerAddress?: string }>;
  recipientAddress: string;
  recipientSat: number;
  changeAddress: string;
  changeSat: number;
  feeSat: number;
}): string {
  const { wallet, asset } = args;
  const network = asset === 'btc' ? NETWORK : LTC_NETWORK;
  const account = wallet.sessionSecrets?.[asset];
  if (!account) throw new Error('Account signing keys are unavailable. Unlock the wallet again.');
  const node = new HDKey({ privateKey: account.privateKey.slice(), chainCode: account.chainCode.slice() });
  const keys: Uint8Array[] = [];
  try {
    const tx = new Transaction({ version: 2 });
    const seen = new Set<string>();
    let total = 0;
    const amount = (n: number) => Number.isSafeInteger(n) && n >= 0;
    if (!amount(args.recipientSat) || args.recipientSat <= 0 || !amount(args.changeSat)
      || !amount(args.feeSat) || args.inputs.length === 0) throw new Error('Invalid transaction amounts.');
    for (const input of args.inputs) {
      const outpoint = `${input.txid}:${input.vout}`;
      if (seen.has(outpoint)) throw new Error('A transaction input was selected more than once.');
      seen.add(outpoint);
      if (!amount(input.value) || !Number.isInteger(input.vout) || input.vout < 0
        || input.vout > 0xffffffff) throw new Error('Invalid transaction input.');
      total += input.value;
      if (!Number.isSafeInteger(total)) throw new Error('Transaction input total exceeds the supported range.');
      const prefix = `m/84'/${asset === 'btc' ? 0 : 2}'/0'/`;
      if (!input.masterPath.startsWith(prefix)) throw new Error('Input derivation is outside this account.');
      const relative = input.masterPath.slice(prefix.length);
      const match = /^([01])\/(0|[1-9][0-9]*)$/.exec(relative);
      if (!match || Number(match[2]) >= 0x80000000) throw new Error('Invalid receive or change derivation.');
      const child = node.deriveChild(Number(match[1])).deriveChild(Number(match[2]));
      if (!child.privateKey) throw new Error('Could not derive an input signing key.');
      const key = child.privateKey.slice();
      keys.push(key);
      child.wipePrivateData();
      const payment = p2wpkh(secp256k1.getPublicKey(key, true), network);
      const owner = input.ownerAddress ?? wallet.addresses[asset];
      if (payment.address !== owner) throw new Error('Input address does not match its signing key.');
      tx.addInput({
        txid: input.txid, index: input.vout, sequence: 0xfffffffd,
        witnessUtxo: { script: payment.script, amount: BigInt(input.value) },
      });
    }
    if (total !== args.recipientSat + args.changeSat + args.feeSat) throw new Error('Transaction totals do not balance.');
    tx.addOutputAddress(args.recipientAddress, BigInt(args.recipientSat), network);
    if (args.changeSat > 0) tx.addOutputAddress(args.changeAddress, BigInt(args.changeSat), network);
    for (let i = 0; i < keys.length; i++) {
      if (!tx.signIdx(keys[i]!, i)) throw new Error('An input could not be signed.');
    }
    tx.finalize();
    return hex.encode(tx.extract());
  } finally {
    node.wipePrivateData();
    for (const key of keys) key.fill(0);
  }
}
