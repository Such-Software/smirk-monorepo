/**
 * Send handler — turns SendWizard's `onSubmit({ assetId, atomic, recipient })`
 * into a real network transaction.
 *
 * Per-asset dispatch:
 * - BTC / LTC: UTXO fetch → greedy selection → buildPsbt → signPsbt
 *   → extractTx → broadcast.
 * - XMR / WOW: not implemented yet — returns a clear error so the UI
 *   surfaces "send not available for this asset" rather than the old
 *   fake-success stub.
 * - GRIN: not implemented yet — slatepack ceremony lands later.
 *
 * Architecture per `docs/SEND_FLOW.md`. The handler stays inside the
 * extension package because it ties together the asset-specific
 * choices the shell makes (which API endpoint, which derivation path,
 * which fee tier). `@smirk/core` provides the network primitives;
 * `@smirk/wasm` provides the crypto; this glue is platform-side.
 */

import {
  api,
  type UnlockedWallet,
} from '@smirk/core';
import { mustGetAsset } from '@smirk/assets';
import {
  bitcoin as wasmBitcoin,
  monero as wasmMonero,
  type BtcNetwork,
} from '@smirk/wasm';
import type { SendSubmitResult } from '@smirk/ui';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse a `WasmResult` envelope JSON (`{ success, data?, error? }`) and
 * return `data` on success. Throws with the envelope's `error` on failure.
 */
function parseWasmResult<T>(json: string): T {
  const parsed = JSON.parse(json) as { success: boolean; data?: T; error?: string };
  if (!parsed.success) {
    throw new Error(parsed.error ?? 'wasm call returned success=false with no error');
  }
  if (parsed.data === undefined) {
    throw new Error('wasm call returned success=true with no data');
  }
  return parsed.data;
}

/**
 * P2WPKH transaction-size estimator (BIP-141 vsize).
 *
 * Each input: 41 bytes of base data (outpoint + sequence + empty
 * script_sig) + ~27.25 vbytes of witness data (compressed witness =
 * 109 bytes / 4). Rounded to 68 vbytes per input — matches the
 * Bitcoin Core default-policy estimate for P2WPKH.
 *
 * Each output: 31 vbytes (8-byte value + 1-byte script length +
 * 22-byte P2WPKH scriptPubKey).
 *
 * Overhead: 10 vbytes (version + locktime + segwit marker/flag +
 * input/output counts).
 *
 * This is a rough estimate good for fee planning; the actual size
 * after signing may differ by 1-2 vbytes per input due to DER
 * encoding length variation. Underestimating fees risks the tx
 * sitting in the mempool until next block-cycle; we don't try to
 * recompute after signing — the popular tradeoff is to round fees
 * up rather than tighten the estimator.
 */
function estimateVsize(numInputs: number, numOutputs: number): number {
  return numInputs * 68 + numOutputs * 31 + 10;
}

/**
 * Selected input set + per-output amounts.
 *
 * In **sweep** mode: numOutputs = 1, no change output ever, recipient
 * gets `sum(inputs) - feeSat`. Source address ends at 0.
 *
 * In **normal** mode: numOutputs = 2 unless change would be dust
 * (< 294 sat), in which case the dust is forfeit to the miner and we
 * fall back to numOutputs = 1. recipient gets the user-entered
 * amount, change gets the rest.
 */
interface SelectedSet {
  inputs: Array<{ txid: string; vout: number; value: number }>;
  /** Amount the recipient will receive (in atomic units). */
  recipientSat: number;
  /** Change amount; 0 means no change output. */
  changeSat: number;
  /** Computed fee. */
  feeSat: number;
}

/**
 * Sweep all UTXOs into a single 1-output tx to the recipient. Fee comes
 * out of the recipient amount — user pays the fee implicitly. Final
 * source-address balance is exactly 0.
 */
function selectUtxosForSweep(
  utxos: Array<{ txid: string; vout: number; value: number; height: number }>,
  feeRateSatPerVb: number,
): SelectedSet | { error: string } {
  if (utxos.length === 0) {
    return { error: 'No spendable UTXOs to sweep' };
  }
  const inputs = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
  const total = inputs.reduce((s, i) => s + i.value, 0);
  const feeSat = Math.ceil(estimateVsize(inputs.length, 1) * feeRateSatPerVb);
  const recipientSat = total - feeSat;
  if (recipientSat <= 0) {
    return {
      error: `Sweep impossible: total ${total} sat ≤ fee ${feeSat} sat at ${feeRateSatPerVb} sat/vB`,
    };
  }
  return { inputs, recipientSat, changeSat: 0, feeSat };
}

/**
 * Normal greedy UTXO selection: largest-first until selected ≥ amount + fee.
 *
 * Fee depends on input count, which depends on selection — so we
 * loop: start with 1 input, compute fee, add inputs if short, retry.
 * Caps at 50 iterations as a sanity bound (caller's UTXO set should
 * never need more).
 */
function selectUtxos(
  utxos: Array<{ txid: string; vout: number; value: number; height: number }>,
  targetSat: number,
  feeRateSatPerVb: number,
): SelectedSet | { error: string } {
  // Sort largest-first. Confirmed-only would be more conservative;
  // for v0.3 we include unconfirmed (height === 0) — explorers + LWS
  // agree on RBF semantics for our paths.
  const sorted = [...utxos].sort((a, b) => b.value - a.value);

  const selected: typeof sorted = [];
  let selectedSat = 0;
  // We always produce 1-2 outputs (recipient + optional change).
  // Start with both, recompute if change ends up dust.
  let numOutputs = 2;

  for (let iter = 0; iter < 50; iter++) {
    // Add the next largest UTXO until we cover target + fee.
    while (
      selectedSat <
        targetSat + estimateVsize(selected.length, numOutputs) * feeRateSatPerVb &&
      selected.length < sorted.length
    ) {
      const next = sorted[selected.length]!;
      selected.push(next);
      selectedSat += next.value;
    }

    const feeSat = Math.ceil(estimateVsize(selected.length, numOutputs) * feeRateSatPerVb);
    const changeSat = selectedSat - targetSat - feeSat;

    if (changeSat < 0) {
      // Even with every UTXO selected we can't cover it.
      return {
        error: `Insufficient funds: have ${selectedSat} sat, need ${targetSat + feeSat} sat (target + fee)`,
      };
    }

    // If change would be dust (sub-294 sat for P2WPKH), drop the
    // change output and let the excess go to the miner. Recompute
    // fee with 1 output instead of 2.
    if (changeSat > 0 && changeSat < 294 && numOutputs === 2) {
      numOutputs = 1;
      continue;
    }

    return {
      inputs: selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
      recipientSat: targetSat,
      changeSat: numOutputs === 1 ? 0 : changeSat,
      feeSat,
    };
  }
  return { error: 'UTXO selection did not converge (too many inputs needed)' };
}

/**
 * Send BTC or LTC.
 *
 * Flow: UTXO fetch → selection (sweep-all or greedy) → buildPsbt →
 * signPsbt → extractTx → broadcast. Single-recipient P2WPKH only;
 * change goes back to the from-address (Smirk's single-address scheme
 * — see `docs/SEND_FLOW.md`).
 *
 * Caller supplies the fee rate (chosen via Compose-screen fee picker)
 * and the sweep flag — no hidden defaults or magic multipliers here.
 *
 * - `feeRateSatPerVb`: rate the user picked from the fee tiers shown
 *   on the Compose screen (Fast / Normal / Slow).
 * - `sweep`: when true, ignore `amountAtomic` and send **every UTXO**
 *   to `toAddress` as a single 1-output tx; recipient gets
 *   `sum(utxos) - fee`, source address ends at exactly 0. When false,
 *   normal greedy selection: recipient gets `amountAtomic`, change
 *   (if non-dust) goes back to from-address.
 *
 * Throws on missing keys, surfaces all other errors as
 * `{ ok: false, error }` for the wizard to display.
 */
async function sendBtcLtc(
  wallet: UnlockedWallet,
  asset: 'btc' | 'ltc',
  amountAtomic: bigint,
  toAddress: string,
  feeRateSatPerVb: number,
  sweep: boolean,
): Promise<SendSubmitResult> {
  if (!wallet.mnemonic) {
    return { ok: false, error: 'Wallet not unlocked (no mnemonic available)' };
  }

  const fromAddress = (wallet.addresses as unknown as Record<string, string | undefined>)[asset];
  if (!fromAddress) {
    return { ok: false, error: `No ${asset.toUpperCase()} address in wallet` };
  }

  // 1. Fetch UTXOs.
  const utxosResp = await api.getUtxos(asset, fromAddress);
  if (utxosResp.error || !utxosResp.data) {
    return { ok: false, error: utxosResp.error ?? 'Failed to fetch UTXOs' };
  }
  const utxos = utxosResp.data.utxos;
  if (utxos.length === 0) {
    return { ok: false, error: 'No spendable UTXOs at this address' };
  }

  // 2. UTXO selection. Sweep ignores amountAtomic; normal mode uses it.
  let selection: SelectedSet;
  if (sweep) {
    const r = selectUtxosForSweep(utxos, feeRateSatPerVb);
    if ('error' in r) return { ok: false, error: r.error };
    selection = r;
  } else {
    const target = Number(amountAtomic);
    if (target > Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: 'Amount exceeds JS-safe-integer range' };
    }
    const r = selectUtxos(utxos, target, feeRateSatPerVb);
    if ('error' in r) return { ok: false, error: r.error };
    selection = r;
  }

  // 3. Build the unsigned PSBT.
  const network: BtcNetwork = asset === 'btc' ? 'btc-mainnet' : 'ltc-mainnet';
  // Smirk v3 single-address scheme — every input is at the same leaf.
  const masterPath = `m/84'/${asset === 'btc' ? 0 : 2}'/0'/0/0`;
  let unsignedPsbt: string;
  try {
    unsignedPsbt = wasmBitcoin.buildPsbt({
      network,
      inputs: selection.inputs.map((i) => ({
        txid: i.txid,
        vout: i.vout,
        valueSat: i.value,
        masterPath,
      })),
      recipientAddress: toAddress,
      recipientSat: selection.recipientSat,
      ...(selection.changeSat > 0
        ? { changeAddress: fromAddress, changeSat: selection.changeSat }
        : {}),
      mnemonic: wallet.mnemonic,
      passphrase: '',
    });
  } catch (e) {
    return { ok: false, error: `Build PSBT failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 5. Sign. signPsbt's masterPath is the *account* level — its
  //    descendant resolves against bip32_derivation entries we put
  //    in during build.
  let signedJson: string;
  try {
    signedJson = wasmBitcoin.signPsbt(
      wallet.mnemonic,
      '',
      network,
      `m/84'/${asset === 'btc' ? 0 : 2}'/0'`,
      unsignedPsbt,
    );
  } catch (e) {
    return { ok: false, error: `Sign PSBT failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = JSON.parse(signedJson) as {
    psbt: string;
    inputs_total: number;
    inputs_signed: number;
  };
  if (parsed.inputs_signed !== parsed.inputs_total) {
    return {
      ok: false,
      error: `Only signed ${parsed.inputs_signed} of ${parsed.inputs_total} inputs — derivation mismatch?`,
    };
  }

  // 6. Extract tx hex.
  let txHex: string;
  try {
    txHex = wasmBitcoin.extractTx(parsed.psbt);
  } catch (e) {
    return { ok: false, error: `Extract tx failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 7. Broadcast. On failure, dump tx hex + the inputs/recipient/change/fee
  //    to the browser console so we can decode the raw tx offline
  //    (`bitcoin-cli decoderawtransaction <hex>` or
  //    https://blockstream.info/tools/tx-decoder) and find the exact
  //    rejection reason. Diagnostic-only; the hex carries no private data.
  const broadcast = await api.broadcastTx(asset, txHex);
  if (broadcast.error || !broadcast.data) {
    console.error('[smirk send] broadcast failed', {
      asset,
      sweep,
      recipient: toAddress,
      recipientSat: selection.recipientSat,
      changeSat: selection.changeSat,
      feeSat: selection.feeSat,
      feeRateSatPerVb,
      inputs: selection.inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: i.value })),
      txHex,
      backendError: broadcast.error,
    });
    return { ok: false, error: broadcast.error ?? 'Broadcast failed' };
  }

  return { ok: true, txid: broadcast.data.txid };
}

/**
 * Send XMR or WOW.
 *
 * Flow: get_unspent_outs → greedy input selection (iterating fee estimate
 * with the wasm helper) → get_random_outs (ring-size − 1 decoys per
 * input, distributed across inputs) → wasm.sign_transaction → submitLwsTx
 * with `recipient_address` + `amount` + `tx_hash` so the backend can
 * insert a `pending_transactions` row for instant smirk-to-smirk pending
 * detection (only fires when the recipient is a registered Smirk address;
 * backend silently skips for external sends — see legacy commit `3afce50`).
 *
 * No fee picker, no sweep yet. Fee comes from LWS's `per_byte_fee`
 * (rounded to `fee_mask`); change goes back to the sender's single
 * address (Smirk uses one main address per asset — no subaddresses).
 *
 * Privacy-critical: every transaction must use a fresh `outgoing_view_key`
 * from OS randomness. That happens inside `wasm.sign_transaction` —
 * NEVER hardcoded, never zero-init. Pre-2026-05-10 the wasm had a
 * `Zeroizing::new([0u8; 32])` bug there that killed amount privacy on
 * every Smirk XMR/WOW tx; the regression test
 * `test_outgoing_view_key_is_fresh_per_call` guards it now.
 */
async function sendXmrWow(
  wallet: UnlockedWallet,
  asset: 'xmr' | 'wow',
  amountAtomic: bigint,
  toAddress: string,
): Promise<SendSubmitResult> {
  const fromAddress = wallet.addresses[asset];
  if (!fromAddress) {
    return { ok: false, error: `No ${asset.toUpperCase()} address in wallet` };
  }
  const keys = wallet.keys[asset];
  const viewKeyHex = bytesToHex(keys.privateViewKey);
  const spendKeyHex = bytesToHex(keys.privateSpendKey);

  // 1. Fetch unspent outputs from LWS. The endpoint applies a server-side
  //    lock-window cushion (XMR ≥10 confs, WOW ≥4 confs) so anything
  //    returned here is past lock-time. BUT LWS still returns outputs
  //    that look spendable to it without the spend key — including ones
  //    we've already spent (the spend-key-images list ships candidates
  //    the daemon flagged, and we have to verify them ourselves).
  const unspentResp = await api.getUnspentOuts(asset, fromAddress, viewKeyHex);
  if (unspentResp.error || !unspentResp.data) {
    return { ok: false, error: unspentResp.error ?? 'Failed to fetch unspent outputs' };
  }
  const { outputs: lwsOutputs, per_byte_fee, fee_mask } = unspentResp.data;
  if (lwsOutputs.length === 0) {
    return { ok: false, error: 'No spendable outputs at this address' };
  }

  // 1a. Filter out already-spent outputs by computing the real key
  //     image for each owned output and matching it against the
  //     server's `spend_key_images` candidate list. This is the same
  //     verification balance display does — without it, the largest-
  //     first selection happily picks an already-spent output and the
  //     daemon rejects at submit time with "key image already in chain"
  //     surfaced as a 500. Bug observed 2026-05-12 on second WOW send.
  const spendableOutputs: typeof lwsOutputs = [];
  for (const out of lwsOutputs) {
    if (out.spend_key_images.length === 0) {
      // Nothing for the server to claim; output is definitely unspent.
      spendableOutputs.push(out);
      continue;
    }
    let computedKi: string;
    try {
      const kiJson = wasmMonero.computeKeyImage(
        viewKeyHex,
        spendKeyHex,
        out.tx_pub_key,
        out.index,
      );
      computedKi = parseWasmResult<string>(kiJson);
    } catch (e) {
      // Failure to compute key image is unusual; fall back to treating
      // this output as spent to be safe (would rather skip than risk
      // double-spend rejection at submit).
      console.warn('[smirk send xmr/wow] key-image compute failed; skipping output', {
        global_index: out.global_index,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const computedLower = computedKi.toLowerCase();
    const isSpent = out.spend_key_images.some(
      (ki) => ki.toLowerCase() === computedLower,
    );
    if (!isSpent) spendableOutputs.push(out);
  }
  if (spendableOutputs.length === 0) {
    return {
      ok: false,
      error: 'No unspent outputs available — recent sends may still be pending. Try again in a minute.',
    };
  }

  // 2. Greedy input selection over the spendable (unspent) set. Each
  //    loop adds the next-largest output, asks the wasm helper for the
  //    resulting fee at (n inputs, 2 outputs), and stops when
  //    sum(inputs) ≥ amount + fee. RingCT always carries a change
  //    output, so num_outputs is always 2.
  const sortedOutputs = [...spendableOutputs].sort((a, b) => b.amount - a.amount);
  const target = amountAtomic;
  if (target > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'Amount exceeds JS-safe-integer range' };
  }
  const feePerByteBig = BigInt(per_byte_fee);
  const feeMaskBig = BigInt(fee_mask);

  const selected: typeof sortedOutputs = [];
  let selectedTotal = 0n;
  let feeAtomic = 0n;
  let covered = false;
  for (const out of sortedOutputs) {
    selected.push(out);
    selectedTotal += BigInt(out.amount);
    const feeJson = wasmMonero.estimateFee(selected.length, 2, feePerByteBig, feeMaskBig);
    let feeNum: number;
    try {
      feeNum = parseWasmResult<number>(feeJson);
    } catch (e) {
      return { ok: false, error: `Fee estimate failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    feeAtomic = BigInt(feeNum);
    if (selectedTotal >= target + feeAtomic) {
      covered = true;
      break;
    }
  }
  if (!covered) {
    return {
      ok: false,
      error: `Insufficient funds: have ${selectedTotal} atomic, need ${target + feeAtomic} atomic (amount + fee)`,
    };
  }

  // 3. Fetch decoys. (ringSize − 1) per input from one batched call, then
  //    slice into per-input rings.
  const ringSize = asset === 'wow' ? 22 : 16;
  const decoysPerInput = ringSize - 1;
  const totalDecoys = decoysPerInput * selected.length;
  const decoysResp = await api.getRandomOuts(asset, totalDecoys);
  if (decoysResp.error || !decoysResp.data) {
    return { ok: false, error: decoysResp.error ?? 'Failed to fetch decoys' };
  }
  const decoyPool = decoysResp.data.outputs;
  if (decoyPool.length < totalDecoys) {
    return {
      ok: false,
      error: `LWS returned ${decoyPool.length} decoys, expected ${totalDecoys}`,
    };
  }

  // 4. Build TxParams JSON. Field names are snake_case to match the
  //    Rust serde contract (see crates/smirk-wasm/src/signing.rs::TxParams).
  const inputs = selected.map((out, i) => ({
    output: {
      amount: out.amount,
      public_key: out.public_key,
      tx_pub_key: out.tx_pub_key,
      index: out.index,
      global_index: out.global_index,
      height: out.height,
      rct: out.rct,
    },
    decoys: decoyPool.slice(i * decoysPerInput, (i + 1) * decoysPerInput),
  }));
  const amountNum = Number(amountAtomic);
  const params = {
    inputs,
    destinations: [{ address: toAddress, amount: amountNum }],
    change_address: fromAddress,
    fee_per_byte: per_byte_fee,
    fee_mask,
    view_key: viewKeyHex,
    spend_key: spendKeyHex,
    network: 'mainnet',
    coin: asset,
  };

  // 5. Sign. `wasm.sign_transaction` generates a fresh outgoing_view_key
  //    from OsRng internally (see signing.rs::fresh_outgoing_view_key).
  let signed: { tx_hex: string; tx_hash: string; fee: number };
  try {
    const signedJson = wasmMonero.signTransaction(JSON.stringify(params));
    signed = parseWasmResult<{ tx_hex: string; tx_hash: string; fee: number }>(signedJson);
  } catch (e) {
    return { ok: false, error: `Sign tx failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 6. Submit. Passing recipient + amount + tx_hash lets the backend
  //    insert a pending_transactions row when the recipient is also a
  //    Smirk user (per legacy commit `3afce50`). For external sends the
  //    backend silently skips the insert. The recipient sees pending
  //    balance immediately; sender's own pending tracking is Phase 2.
  const submit = await api.submitLwsTx(asset, signed.tx_hex, toAddress, amountNum, signed.tx_hash);
  if (submit.error || !submit.data) {
    console.error('[smirk send xmr/wow] submit failed', {
      asset,
      recipient: toAddress,
      amount: amountNum,
      txHash: signed.tx_hash,
      fee: signed.fee,
      inputCount: selected.length,
      backendError: submit.error,
    });
    return { ok: false, error: submit.error ?? 'Submit failed' };
  }

  return { ok: true, txid: signed.tx_hash };
}

/**
 * Top-level send dispatcher. SendWizard.onSubmit calls this with the
 * collected Compose-screen fields; we route to per-asset implementations.
 */
export async function send(
  wallet: UnlockedWallet,
  fields: {
    fromAssetId: string;
    amountAtomic: bigint;
    toAddress: string;
    feeRateSatPerVb: number;
    sweep: boolean;
  },
): Promise<SendSubmitResult> {
  const asset = mustGetAsset(fields.fromAssetId);

  if (asset.id === 'btc' || asset.id === 'ltc') {
    return sendBtcLtc(
      wallet,
      asset.id,
      fields.amountAtomic,
      fields.toAddress,
      fields.feeRateSatPerVb,
      fields.sweep,
    );
  }

  if (asset.id === 'xmr' || asset.id === 'wow') {
    // Phase-1 scope: single-recipient, single main address, no sweep,
    // no subaddresses. Fee comes from LWS (`per_byte_fee` / `fee_mask`)
    // not from the user-picker — the wizard's feeRateSatPerVb and
    // sweep fields are deliberately ignored for these assets.
    if (fields.sweep) {
      return {
        ok: false,
        error: `Sweep mode not yet implemented for ${asset.ticker}. Use a specific amount.`,
      };
    }
    return sendXmrWow(wallet, asset.id, fields.amountAtomic, fields.toAddress);
  }

  // Stub for assets we haven't wired yet (Grin). Returning an explicit
  // error means the wizard surfaces "Send not implemented for <asset>"
  // rather than the previous fake-success stub that pretended a fake
  // txid was valid. Closes the footgun.
  return {
    ok: false,
    error: `Send is not yet implemented in v0.3 for ${asset.ticker}. Use the legacy Smirk extension v0.2.x, or run scripts/seed-to-keys to extract keys for an external wallet.`,
  };
}
