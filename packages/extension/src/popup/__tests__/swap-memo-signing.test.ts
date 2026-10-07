import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1';
import { NETWORK, OutScript, Transaction, p2wpkh } from '@scure/btc-signer';
import type { UnlockedWallet } from '@smirk/core';
import { signUtxoSessionTransaction } from '../utxo-session-signing';
import { opReturnVbytes } from '../send-handler';

// A throwaway BIP84 account built straight from a fixed seed, so the test
// needs neither the wasm build nor a keystore round trip.
const SEED = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
const account = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'");
const receive = account.deriveChild(0).deriveChild(0);
const fromAddress = p2wpkh(secp256k1.getPublicKey(receive.privateKey!, true), NETWORK).address!;

function wallet(): UnlockedWallet {
  return {
    addresses: { btc: fromAddress },
    sessionSecrets: {
      btc: { privateKey: account.privateKey!.slice(), chainCode: account.chainCode!.slice() },
    },
  } as unknown as UnlockedWallet;
}

const base = {
  asset: 'btc' as const,
  inputs: [{
    txid: '11'.repeat(32), vout: 0, value: 100_000, masterPath: "m/84'/0'/0'/0/0",
  }],
  recipientAddress: 'bc1qfh0ze362dd6878wsrysrw8twqv4g92ad5da8v6',
  recipientSat: 50_000,
  changeAddress: fromAddress,
  changeSat: 49_000,
  feeSat: 1_000,
};

test('a swap memo becomes the last, zero-value OP_RETURN output', () => {
  const memo = '=:l:ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz:1212699958';
  const raw = signUtxoSessionTransaction({ ...base, wallet: wallet(), opReturnMemo: memo });
  const tx = Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
  assert.equal(tx.outputsLength, 3, 'inbound, change, OP_RETURN');
  const last = tx.getOutput(2);
  assert.equal(last.amount, 0n);
  const decoded = OutScript.decode(last.script!);
  assert.equal(decoded.type, 'unknown');
  // OP_RETURN, push length, payload.
  assert.equal(last.script![0], 0x6a);
  assert.equal(new TextDecoder().decode(last.script!.slice(2)), memo);
  assert.equal(tx.getOutput(0).amount, 50_000n, 'the inbound address is paid first');
});

test('no memo leaves the transaction exactly as before', () => {
  const raw = signUtxoSessionTransaction({ ...base, wallet: wallet() });
  assert.equal(Transaction.fromRaw(hex.decode(raw)).outputsLength, 2);
});

test('a memo that does not fit is refused, never truncated', () => {
  assert.throws(() => signUtxoSessionTransaction({ ...base, wallet: wallet(), opReturnMemo: 'a'.repeat(81) }));
  assert.throws(() => signUtxoSessionTransaction({ ...base, wallet: wallet(), opReturnMemo: '' }));
});

test('fee planning prices the OP_RETURN output it will add', () => {
  assert.equal(opReturnVbytes(undefined), 0);
  // value 8 + script length 1 + OP_RETURN 1 + push opcode 1 + payload.
  assert.equal(opReturnVbytes('a'.repeat(10)), 21);
  // Payloads above 75 bytes need OP_PUSHDATA1 plus a length byte.
  assert.equal(opReturnVbytes('a'.repeat(80)), 8 + 1 + 1 + 2 + 80);
});
