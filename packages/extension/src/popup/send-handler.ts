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
  chainProviders,
  applyRelayFloor,
  btcLtcFreshAddrsEnabled,
  UtxoAddressBook,
  buildUtxoScanRefs,
  recordUtxoActivity,
  utxoAddressAt,
  type UnlockedWallet,
} from '@smirk/core';
import { storage } from './singletons';
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
 * Normalize an LWS output's `subaddr_index` into "the index to pass to the
 * signer", or `undefined` for the primary address.
 *
 * `undefined` is returned for BOTH "the backend didn't say" (legacy flat
 * dialect) and an explicit `(0, 0)`: Monero's primary address IS account 0 /
 * minor 0, and the wasm spend path treats an absent index and `(0,0)`
 * identically. Collapsing them here means the primary-output payload is
 * byte-identical to the pre-subaddress one.
 *
 * Anything malformed (non-integer, negative) is treated as primary rather than
 * passed through: a bogus index would silently produce a key image that does
 * not match the output, and the send would be rejected at submit. Primary is
 * the only value we can reason about without server input.
 */
function subaddrOf(out: {
  subaddr_index?: { major: number; minor: number };
}): { major: number; minor: number } | undefined {
  const s = out.subaddr_index;
  if (!s) return undefined;
  const ok = (v: number) => Number.isInteger(v) && v >= 0;
  if (!ok(s.major) || !ok(s.minor)) return undefined;
  if (s.major === 0 && s.minor === 0) return undefined;
  return { major: s.major, minor: s.minor };
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
  /**
   * UTXO ids (`${txid}:${vout}`) of inputs spent by still-pending
   * sends from this wallet. We exclude these from selection so a
   * fast second-send doesn't try to spend a UTXO that's already in
   * the mempool — Electrum would reject as "missing inputs".
   */
  excludeInputs: Set<string>,
): Promise<SendSubmitResult> {
  if (!wallet.mnemonic) {
    return { ok: false, error: 'Wallet not unlocked (no mnemonic available)' };
  }

  const fromAddress = (wallet.addresses as unknown as Record<string, string | undefined>)[asset];
  if (!fromAddress) {
    return { ok: false, error: `No ${asset.toUpperCase()} address in wallet` };
  }

  // Fresh-address mode is opt-in (ENABLE_BTCLTC_FRESH_ADDRS) AND requires the
  // account xpub (present on every v3 unlock; absent on a pre-xpub session
  // cache, which self-heals to a re-unlock). With it off — the default — this
  // whole function behaves exactly as before: one address, fixed `/0/0` path,
  // change back to the from-address.
  const accountXpub = (
    wallet.keys as unknown as Record<string, { accountXpub?: string }>
  )[asset]?.accountXpub;
  const freshEnabled = btcLtcFreshAddrsEnabled() && typeof accountXpub === 'string';
  const coin = asset === 'btc' ? 0 : 2;
  const singlePath = `m/84'/${coin}'/0'/0/0`;

  // 1. Fetch UTXOs and filter out any we've already spent in a
  //    still-pending tx (Electrum may not have reflected the spend
  //    yet). Without this filter, a fast second-send picks the
  //    largest UTXO, which is the one we just spent — Electrum
  //    rejects with "missing inputs / already in mempool".
  //
  //    In fresh-address mode we fetch across the whole address book
  //    (receive + reserved change indices) via the multi endpoint, so
  //    every returned UTXO carries its own owning-address + master path
  //    tag; the signer uses that tag and never re-guesses (money gate G9).
  type WalletUtxo = {
    txid: string;
    vout: number;
    value: number;
    height: number;
    masterPath?: string;
    address?: string;
  };
  let fetchedUtxos: WalletUtxo[];
  const book = freshEnabled ? new UtxoAddressBook(storage, wallet.fingerprint, asset) : null;
  if (freshEnabled && book) {
    const refs = await buildUtxoScanRefs(book, asset, accountXpub as string);
    const resp = await chainProviders.utxo(asset).listOutputsMulti(refs);
    if (resp.error || !resp.data) {
      return { ok: false, error: resp.error ?? 'Failed to fetch UTXOs' };
    }
    fetchedUtxos = resp.data.utxos;
    // Gap discovery, free of charge: every address the listing came back with
    // is an address that holds money, so mark its index used and slide the
    // receive / change windows forward. Best-effort: a book write failing
    // must never block a send that is otherwise ready to go.
    try {
      const active = fetchedUtxos.map((u) => u.address).filter((a): a is string => !!a);
      if (active.length > 0) await recordUtxoActivity(book, refs, active);
    } catch (e) {
      console.warn('[smirk] utxo activity record failed', e);
    }
  } else {
    const utxosResp = await chainProviders.utxo(asset).listOutputs(fromAddress);
    if (utxosResp.error || !utxosResp.data) {
      return { ok: false, error: utxosResp.error ?? 'Failed to fetch UTXOs' };
    }
    fetchedUtxos = utxosResp.data.utxos;
  }

  const utxos = fetchedUtxos.filter((u) => !excludeInputs.has(`${u.txid}:${u.vout}`));
  if (utxos.length === 0) {
    if (fetchedUtxos.length > 0) {
      return {
        ok: false,
        error:
          'All UTXOs at this address are tied up in recent sends — wait for confirmation and try again.',
      };
    }
    return { ok: false, error: 'No spendable UTXOs at this address' };
  }

  // Owning-address + path tag map, keyed by `txid:vout`. In fresh mode this
  // comes straight off the tagged multi listing; in single-address mode it's
  // the fixed primary leaf. Selection below only carries `{txid,vout,value}`,
  // so we recover each selected input's path/owner from this map — the path
  // is never re-derived from the amount or re-guessed (money gate G9).
  const tagByOutpoint = new Map<string, { masterPath: string; ownerAddress?: string }>();
  for (const u of utxos) {
    tagByOutpoint.set(`${u.txid}:${u.vout}`, {
      masterPath: freshEnabled ? u.masterPath ?? singlePath : singlePath,
      ...(freshEnabled && u.address ? { ownerAddress: u.address } : {}),
    });
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

  // 2b. Change destination. Fresh mode reserves a fresh `/1/j` change address
  //     BEFORE broadcast (monotonic, mutex-guarded) so change stops clustering
  //     back onto the receive address. Only reserve when there IS change, so a
  //     no-change (or dust-dropped) send never burns an index. Flag-off keeps
  //     change on the from-address exactly as before.
  let changeAddress = fromAddress;
  if (freshEnabled && book && selection.changeSat > 0) {
    try {
      const j = await book.reserveChange();
      changeAddress = utxoAddressAt(asset, accountXpub as string, 1, j);
    } catch (e) {
      return {
        ok: false,
        error: `Reserve change address failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // 3. Build the unsigned PSBT. Each input carries the path (and, in fresh
  //    mode, the owner-address tag for the fail-closed G9 script assertion)
  //    resolved from `tagByOutpoint`.
  const network: BtcNetwork = asset === 'btc' ? 'btc-mainnet' : 'ltc-mainnet';
  let unsignedPsbt: string;
  try {
    unsignedPsbt = wasmBitcoin.buildPsbt({
      network,
      inputs: selection.inputs.map((i) => {
        const tag = tagByOutpoint.get(`${i.txid}:${i.vout}`);
        return {
          txid: i.txid,
          vout: i.vout,
          valueSat: i.value,
          masterPath: tag?.masterPath ?? singlePath,
          ...(tag?.ownerAddress ? { ownerAddress: tag.ownerAddress } : {}),
        };
      }),
      recipientAddress: toAddress,
      recipientSat: selection.recipientSat,
      ...(selection.changeSat > 0
        ? { changeAddress, changeSat: selection.changeSat }
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
  const broadcast = await chainProviders.utxo(asset).broadcast(txHex);
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

  return {
    ok: true,
    txid: broadcast.data.txid,
    amountAtomic: BigInt(selection.recipientSat),
    feeAtomic: BigInt(selection.feeSat),
    inputs: selection.inputs.map((i) => `${i.txid}:${i.vout}`),
    inputsTotalAtomic: selection.inputs.reduce(
      (acc, i) => acc + BigInt(i.value),
      0n,
    ),
  };
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
 * (rounded to `fee_mask`); change always goes back to the account's
 * PRIMARY address.
 *
 * Subaddresses: each unspent output carries the `subaddr_index` the LWS
 * attributed it to, and that index is threaded verbatim into BOTH the
 * key-image computation and the wasm signing params. It is never
 * re-derived or guessed. A subaddress output's key image folds the
 * subaddress secret into the key offset, so spending one under the
 * primary index yields a key image the network rejects and strands the
 * output. Absent or `(0,0)` means the primary address and the call is
 * byte-identical to the pre-subaddress path, which is what every output
 * looks like while `ENABLE_SUBADDRESS_RECEIVE` is off (nothing ever
 * hands out a subaddress, so nothing can be received on one).
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
  /**
   * Lowercase-hex computed key images of inputs spent by still-pending
   * sends from this wallet. We exclude these from selection — the LWS
   * `spend_key_images` filter (Phase 1) catches outputs the *server*
   * thinks are spent, but doesn't catch the window where we just
   * broadcast a tx and LWS hasn't yet reflected it. This cache covers
   * that window.
   */
  excludeInputs: Set<string>,
  /**
   * Sweep mode: select every spendable output, send `sum(inputs) − fee`
   * to recipient, no meaningful change. `amountAtomic` is ignored.
   * RingCT requires a 2-output minimum, so monero-oxide will still
   * create a small/zero-value change output to the sender's own
   * address — that's protocol-mandated padding, not "real" change.
   */
  sweep: boolean,
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
  const unspentResp = await chainProviders.lws(asset).listOutputs(fromAddress, viewKeyHex);
  if (unspentResp.error || !unspentResp.data) {
    return { ok: false, error: unspentResp.error ?? 'Failed to fetch unspent outputs' };
  }
  const { outputs: lwsOutputs, per_byte_fee, fee_mask } = unspentResp.data;
  if (lwsOutputs.length === 0) {
    return { ok: false, error: 'No spendable outputs at this address' };
  }

  // 1a. Compute every output's key image up front, then exclude:
  //     (a) outputs whose key image matches one of the server's
  //         `spend_key_images` candidates (LWS-reflected spend), and
  //     (b) outputs whose key image is in `excludeInputs` (a still-
  //         pending send from this wallet — LWS hasn't reflected yet).
  //     Each kept output is annotated with its key image so the post-
  //     send pendingOutgoing entry can capture them for the next call.
  //     Bug closed by (a) alone: legacy 500 on second-WOW-send after
  //     spent output was reused. Bug closed by (b): mempool double-
  //     spend rejection when two sends fire before LWS reflects the
  //     first.
  type SpendableOutput = (typeof lwsOutputs)[number] & { keyImage: string };
  const spendableOutputs: SpendableOutput[] = [];
  let blockedByLocalCache = 0;
  for (const out of lwsOutputs) {
    // Subaddress the LWS attributed this output to. Absent (legacy backend) or
    // `(0,0)` is the primary address: pass `undefined` so the wasm call is the
    // exact pre-subaddress call. A non-primary index MUST reach both the key
    // image here and the signing params below, or the output is unspendable.
    const sub = subaddrOf(out);
    let computedKi: string;
    try {
      const kiJson = wasmMonero.computeKeyImage(
        viewKeyHex,
        spendKeyHex,
        out.tx_pub_key,
        out.index,
        sub?.major,
        sub?.minor,
      );
      computedKi = parseWasmResult<string>(kiJson).toLowerCase();
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
    // LWS-reported spend (server-side reconciliation already happened).
    const lwsSaysSpent = out.spend_key_images.some(
      (ki) => ki.toLowerCase() === computedKi,
    );
    if (lwsSaysSpent) continue;
    // Local pending-outgoing cache (we spent this; LWS hasn't seen yet).
    if (excludeInputs.has(computedKi)) {
      blockedByLocalCache++;
      continue;
    }
    spendableOutputs.push({ ...out, keyImage: computedKi });
  }
  if (spendableOutputs.length === 0) {
    return {
      ok: false,
      error:
        blockedByLocalCache > 0
          ? 'All outputs are tied up in recent sends — wait for confirmation and try again.'
          : 'No unspent outputs available — recent sends may still be pending. Try again in a minute.',
    };
  }

  // 2. Input selection.
  //
  // - Normal mode: greedy largest-first until sum(inputs) ≥ amount + fee.
  //   Re-estimates fee each loop because each input adds ~2500 bytes
  //   to the RingCT signature, so n changes the target each iteration.
  //
  // - Sweep mode: select every spendable output. amount = sum − fee
  //   (computed once, since N is known). RingCT requires a 2-output
  //   minimum, so monero-oxide will still write a small/zero-value
  //   change output to fromAddress — protocol-mandated padding, not
  //   "real" change. Any tiny residual (estimated_fee − actual_fee,
  //   rounded down to fee_mask granularity) stays with the user.
  // Atomic amounts are strings (may exceed 2^53); sort by BigInt, largest-first.
  const sortedOutputs = [...spendableOutputs].sort((a, b) => {
    const d = BigInt(b.amount) - BigInt(a.amount);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const feePerByteBig = BigInt(per_byte_fee);
  const feeMaskBig = BigInt(fee_mask);

  let selected: typeof sortedOutputs;
  let selectedTotal: bigint;
  let feeAtomic: bigint;
  let effectiveAmount: bigint; // amount the recipient receives

  if (sweep) {
    selected = sortedOutputs;
    selectedTotal = selected.reduce((s, o) => s + BigInt(o.amount), 0n);
    const feeJson = wasmMonero.estimateFee(selected.length, 2, feePerByteBig, feeMaskBig);
    let feeNum: number;
    try {
      feeNum = parseWasmResult<number>(feeJson);
    } catch (e) {
      return { ok: false, error: `Fee estimate failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    feeAtomic = BigInt(feeNum);
    if (selectedTotal <= feeAtomic) {
      return {
        ok: false,
        error: `Sweep impossible: have ${selectedTotal} atomic, fee ${feeAtomic} atomic`,
      };
    }
    effectiveAmount = selectedTotal - feeAtomic;
  } else {
    const target = amountAtomic;
    if (target > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: 'Amount exceeds JS-safe-integer range' };
    }
    const acc: typeof sortedOutputs = [];
    let accTotal = 0n;
    let accFee = 0n;
    let covered = false;
    for (const out of sortedOutputs) {
      acc.push(out);
      accTotal += BigInt(out.amount);
      const feeJson = wasmMonero.estimateFee(acc.length, 2, feePerByteBig, feeMaskBig);
      let feeNum: number;
      try {
        feeNum = parseWasmResult<number>(feeJson);
      } catch (e) {
        return { ok: false, error: `Fee estimate failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      accFee = BigInt(feeNum);
      if (accTotal >= target + accFee) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      return {
        ok: false,
        error: `Insufficient funds: have ${accTotal} atomic, need ${target + accFee} atomic (amount + fee)`,
      };
    }
    selected = acc;
    selectedTotal = accTotal;
    feeAtomic = accFee;
    effectiveAmount = target;
  }

  // 3. Fetch decoys. (ringSize − 1) per input from one batched call, then
  //    slice into per-input rings.
  const ringSize = asset === 'wow' ? 22 : 16;
  const decoysPerInput = ringSize - 1;
  const totalDecoys = decoysPerInput * selected.length;
  const decoysResp = await chainProviders.lws(asset).getRandomOutputs(totalDecoys);
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
  //    Each input's `subaddr_index` is threaded through only when the output
  //    was actually received on a subaddress; for a primary output the field is
  //    omitted entirely, so the JSON is identical to the pre-subaddress payload
  //    and the Rust side takes its unchanged primary path.
  const inputs = selected.map((out, i) => {
    const sub = subaddrOf(out);
    return {
      output: {
        amount: out.amount,
        public_key: out.public_key,
        tx_pub_key: out.tx_pub_key,
        index: out.index,
        global_index: out.global_index,
        height: out.height,
        rct: out.rct,
        ...(sub ? { subaddr_index: { major: sub.major, minor: sub.minor } } : {}),
      },
      decoys: decoyPool.slice(i * decoysPerInput, (i + 1) * decoysPerInput),
    };
  });
  const amountNum = Number(effectiveAmount);
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

  // 6. Submit. Only the signed tx is sent: the recipient address + amount are NOT
  //    transmitted (the backend broadcasts from the raw tx and no longer uses that
  //    metadata; sending it would leak a sender<->recipient<->amount link to the
  //    operator on every send, including external ones). If the pending-transfer
  //    "you have incoming funds" hint returns, deliver it over the E2EE channel.
  const submit = await chainProviders.lws(asset).broadcast(signed.tx_hex);
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

  return {
    ok: true,
    txid: signed.tx_hash,
    amountAtomic: effectiveAmount,
    feeAtomic: BigInt(signed.fee),
    inputs: selected.map((s) => s.keyImage),
    inputsTotalAtomic: selected.reduce((acc, s) => acc + BigInt(s.amount), 0n),
  };
}

/**
 * Top-level send dispatcher. SendWizard.onSubmit calls this with the
 * collected Compose-screen fields; we route to per-asset implementations.
 *
 * `excludeInputs` is the set of identifiers (chain-appropriate format
 * — `txid:vout` for UTXO chains, lowercase-hex key image for
 * CryptoNote) of inputs spent by still-pending sends from the same
 * wallet. The popup builds this from `sessionState.pendingOutgoing`
 * via `recentlySpentInputs()` and passes it on every call.
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
  excludeInputs: Set<string> = new Set(),
): Promise<SendSubmitResult> {
  const asset = mustGetAsset(fields.fromAssetId);

  if (asset.id === 'btc' || asset.id === 'ltc') {
    // Clamp to the relay floor — every BTC/LTC broadcast path must, or
    // an at-floor Electrum estimate (e.g. 1.0 sat/vB) is rejected by
    // network rules. The SendWizard already floors for display; this is
    // the defensive backstop for non-wizard callers (tip funding, dapp).
    return sendBtcLtc(
      wallet,
      asset.id,
      fields.amountAtomic,
      fields.toAddress,
      applyRelayFloor(fields.feeRateSatPerVb),
      fields.sweep,
      excludeInputs,
    );
  }

  if (asset.id === 'xmr' || asset.id === 'wow') {
    // Single-recipient; change returns to the account's primary
    // address. Inputs received on a subaddress are spent under their
    // own `subaddr_index` (threaded from the LWS unspent list into both
    // the key image and the signing params). Fee
    // comes from LWS (per_byte_fee / fee_mask) — wizard's
    // feeRateSatPerVb is deliberately ignored. `sweep` is honored:
    // selects every spendable output, recipient gets sum − fee.
    return sendXmrWow(
      wallet,
      asset.id,
      fields.amountAtomic,
      fields.toAddress,
      excludeInputs,
      fields.sweep,
    );
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
