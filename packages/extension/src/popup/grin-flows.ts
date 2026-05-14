/**
 * Grin send + invoice + receive orchestration.
 *
 * Sits between `@smirk/wasm`'s slate-ceremony primitives and the backend
 * RPC endpoints in `@smirk/core/api/grin.ts`. Owns the data flow for each
 * Grin user action:
 *
 *   - `startGrinSend` — sender's S1 step: select UTXOs, lock them on
 *     the backend, build S1 slate, optionally drop encrypted slatepack
 *     at the backend relay if the recipient is also a Smirk user.
 *   - `processGrinS2` — sender's S3 step: finalize the slate, broadcast
 *     the tx, mark inputs spent + tx 'finalized'.
 *   - `cancelGrinSend` — unlock outputs + delete relay entry +
 *     mark tx 'cancelled'.
 *   - `startGrinInvoice` / `signGrinInvoice` / `processGrinI2` —
 *     inverse-direction trio for the receiver-initiated flow.
 *   - `signIncomingGrinSlate` — counterpart receive flow: external
 *     wallet hands us an S1, we sign as S2 + post-back via relay.
 *
 * Wizard state (sender_context, receiver_context) lives in
 * `wizard.fields` between rounds — opaque JSON to the wizard, restored
 * verbatim when the popup reopens mid-flow.
 *
 * Slatepack format: the canonical container is ASCII-armored binary
 * (BEGINSLATEPACK…ENDSLATEPACK). Inside is a slatepack wire-format
 * blob (version + sender + payload). The payload is a slate v4 binary
 * (the format grin-wallet CLI / Niffler / etc. use). Smirk-to-Smirk
 * via relay can transit JSON inline; clipboard / external interop
 * always uses the armored binary form.
 */

import { api } from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';
import type {
  GrinChangeOutputInfo,
  GrinCreateInvoiceResult,
  GrinCreateSendTxResult,
  GrinFinalizeInvoiceResult,
  GrinFinalizeSendResult,
  GrinReceiverOutputInfo,
  GrinSignIncomingSendResult,
  GrinSignInvoiceResult,
  GrinUnspentOutput,
} from '@smirk/wasm';

// ============================================================================
// Helpers
// ============================================================================

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Pack a slate JSON into the canonical armored slatepack envelope —
 * what users copy/paste and what we transmit over the backend relay
 * for external-wallet interop.
 *
 * Two modes:
 *
 *   - **Encrypted** (when `recipientSlatepackAddress` is provided): age-
 *     encrypt to the recipient's ed25519 pubkey via
 *     `slatepackPackEncrypted`. Backend relay (and any other observer)
 *     stores only ciphertext. Recipient decrypts with their slatepack
 *     secret. grin-wallet / Grim / v0.2.4 + v0.3 all handle this mode.
 *   - **Plain** (no recipient): falls back to plaintext for clipboard
 *     handoff to a recipient whose address we don't know yet (e.g. the
 *     I1 we just generated for an invoice).
 *
 * Pipeline (encrypted): slate JSON → compact binary → age-encrypt to
 * recipient → SlatepackBin mode=1 → ASCII armor.
 * Pipeline (plain): slate JSON → compact binary → SlatepackBin mode=0
 * → ASCII armor.
 */
export function armorSlate(
  slateJson: string,
  senderSlatepackAddress?: string,
  recipientSlatepackAddress?: string,
): string {
  const binHex = wasmGrin.slateV4ToBinHex(slateJson);
  if (recipientSlatepackAddress) {
    const recipientPubkeyHex = wasmGrin.slatepackAddressToPubkeyHex(
      recipientSlatepackAddress,
    );
    const packedHex = wasmGrin.slatepackPackEncrypted(
      binHex,
      senderSlatepackAddress ?? null,
      recipientPubkeyHex,
    );
    return wasmGrin.slatepackArmor(packedHex);
  }
  const packedHex = wasmGrin.slatepackPackPlain(binHex, senderSlatepackAddress ?? null);
  return wasmGrin.slatepackArmor(packedHex);
}

/**
 * Inverse of `armorSlate` — takes a BEGINSLATEPACK…ENDSLATEPACK
 * string and returns the slate JSON. Throws on malformed input.
 *
 * Accepts both plaintext and encrypted slatepacks. For encrypted
 * payloads the caller must pass `secretKeyHex` (the receiver's
 * slatepack ed25519 secret seed, from `slatepackAddressSecret`); pass
 * `undefined` for plain-only decode.
 */
export function dearmorSlate(armored: string, secretKeyHex?: string): string {
  const packedHex = wasmGrin.slatepackDearmor(armored);
  if (secretKeyHex) {
    // `slatepackUnpackWithSecret` handles both modes — plain payloads
    // ignore the key, encrypted payloads age-decrypt with it. Single
    // call site for the unified read path.
    const unpackedJson = wasmGrin.slatepackUnpackWithSecret(packedHex, secretKeyHex);
    const unpacked = JSON.parse(unpackedJson) as { payload_hex: string };
    return wasmGrin.slateV4FromBinHex(unpacked.payload_hex);
  }
  const unpackedJson = wasmGrin.slatepackUnpack(packedHex);
  const unpacked = JSON.parse(unpackedJson) as { payload_hex: string };
  return wasmGrin.slateV4FromBinHex(unpacked.payload_hex);
}

/**
 * Inspect a slatepack-armored slate without consuming wallet state.
 * Returns the parsed slate state code so the UI can route based on
 * `S1` / `S2` / `I1` / `I2` (sender vs receiver flow direction).
 *
 * `secretKeyHex` is required to decrypt encrypted slatepacks (the
 * default mode v0.3 emits when recipient address is known); pass
 * undefined to inspect plain slatepacks only.
 */
export interface InspectedSlatepack {
  /** Slate state: "S1" | "S2" | "S3" | "I1" | "I2" | "I3" | "NA". */
  sta: string;
  /** Slate UUID. */
  id: string;
  amount: number;
  fee: number;
  slate_json: string;
}

export function inspectSlatepack(armored: string, secretKeyHex?: string): InspectedSlatepack {
  const slateJson = dearmorSlate(armored, secretKeyHex);
  const parsed = JSON.parse(slateJson) as {
    sta: string;
    id: string;
    amt?: number | string;
    fee?: number | string;
  };
  return {
    sta: parsed.sta,
    id: parsed.id,
    amount: typeof parsed.amt === 'string' ? Number(parsed.amt) : parsed.amt ?? 0,
    fee: typeof parsed.fee === 'string' ? Number(parsed.fee) : parsed.fee ?? 0,
    slate_json: slateJson,
  };
}

/**
 * Like `dearmorSlate` but also returns the slatepack's `sender`
 * field (the originator's bech32 slatepack address, when present).
 * Receiver-side flows use this to encrypt the response back to the
 * sender without the user having to type the address again.
 */
export function dearmorSlateAndSender(
  armored: string,
  secretKeyHex?: string,
): { slate_json: string; sender: string | null } {
  const packedHex = wasmGrin.slatepackDearmor(armored);
  const unpackedJson = secretKeyHex
    ? wasmGrin.slatepackUnpackWithSecret(packedHex, secretKeyHex)
    : wasmGrin.slatepackUnpack(packedHex);
  const unpacked = JSON.parse(unpackedJson) as {
    payload_hex: string;
    sender?: string | null;
  };
  return {
    slate_json: wasmGrin.slateV4FromBinHex(unpacked.payload_hex),
    sender: unpacked.sender ?? null,
  };
}

// ============================================================================
// Fee math
// ============================================================================

/**
 * Grin fee = `BASE_FEE × max(1, num_outputs - num_inputs + num_kernels)`.
 * (See `grin-wallet/libwallet/src/internal/tx.rs::calc_fee`.)
 *
 * Used for greedy input selection — we iterate, recompute fee per
 * candidate input set, stop when sum(inputs) ≥ amount + fee.
 */
const GRIN_BASE_FEE = 1_000_000; // 0.001 GRIN, the network default

export function calcGrinFee(numInputs: number, numOutputs: number, numKernels: number): number {
  const txWeight = Math.max(1, 4 * numOutputs - numInputs + numKernels);
  return GRIN_BASE_FEE * txWeight;
}

// ============================================================================
// Send flow (sender-initiated S1 → S2 → S3)
// ============================================================================

export interface GrinSendInputResolver {
  /**
   * Return all currently-unspent outputs the wallet can spend, plus
   * the next-available BIP32 child index for new outputs. Backed by
   * `/wallet/grin/user/:userId/outputs` server-side.
   */
  fetchSpendable: () => Promise<{
    outputs: Array<{
      key_id: string;
      n_child: number;
      amount: number;
      commitment: string;
      is_coinbase: boolean;
    }>;
    next_child_index: number;
  }>;
}

export interface GrinSendInitResult {
  slate_id: string;
  /** Armored slatepack for clipboard / external interop. */
  armored: string;
  /** Slate JSON for backend relay (Smirk-to-Smirk). */
  slate_json: string;
  /** Opaque sender context (persist in wizard fields). */
  sender_context_json: string;
  /** Inputs that got locked — needed at finalize. */
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
  /** Backend relay entry id, if recipient is a Smirk user. */
  relay_id?: string;
  amount: number;
  fee: number;
}

/**
 * Start a Grin send: select inputs, build S1 slate, lock outputs.
 *
 * The caller passes the recipient slatepack address (`grin1…`) so
 * we can include it in the slatepack envelope. Whether we ALSO drop
 * an entry at the backend relay depends on whether the recipient is
 * a registered Smirk user — caller looks up via
 * `api.client.request('/wallet/grin/address/:address/user')` and
 * passes the user_id if known.
 */
export async function startGrinSend(args: {
  // api: imported at top, used directly
  userId: string;
  mnemonic: string;
  senderSlatepackAddress: string;
  recipientSlatepackAddress: string;
  /** Set if recipient is also a Smirk user; we'll drop the slatepack
   *  at the backend relay so they don't have to copy/paste manually. */
  recipientUserId?: string;
  amount: number;
  resolver: GrinSendInputResolver;
}): Promise<GrinSendInitResult> {
  // 1. Derive 64-byte extended private key. JS-side; never logged.
  const extKeyJson = wasmGrin.deriveExtendedKey(args.mnemonic);
  const extKey = JSON.parse(extKeyJson) as { extended_private_key_hex: string };
  const extKeyHex = extKey.extended_private_key_hex;

  // 2. Pick inputs via greedy + fee iteration. Grin fee depends on
  //    input count, so loop until stable.
  const spendable = await args.resolver.fetchSpendable();
  if (spendable.outputs.length === 0) {
    throw new Error('No spendable Grin outputs');
  }
  // Sort largest-first for fewest-inputs selection.
  const sorted = [...spendable.outputs].sort((a, b) => b.amount - a.amount);
  let selected: typeof sorted = [];
  let total = 0;
  let fee = 0;
  let estimatedInputs = 1;
  const MAX_ITER = 10;
  for (let i = 0; i < MAX_ITER; i++) {
    // Assume 2 outputs (recipient + change), 1 kernel.
    fee = calcGrinFee(estimatedInputs, 2, 1);
    const target = args.amount + fee;
    selected = [];
    total = 0;
    for (const out of sorted) {
      selected.push(out);
      total += out.amount;
      if (total >= target) break;
    }
    if (total < target) {
      // Could be sweep — recompute with 1 output (no change).
      const noChangeFee = calcGrinFee(selected.length, 1, 1);
      if (total >= args.amount + noChangeFee) {
        fee = noChangeFee;
        break;
      }
      throw new Error(
        `Insufficient funds: have ${total / 1e9} GRIN, need ${target / 1e9} GRIN (amount + fee)`,
      );
    }
    if (selected.length === estimatedInputs) break;
    estimatedInputs = selected.length;
  }

  const hasChange = total - args.amount - fee > 0;
  if (hasChange) {
    // Recompute fee with actual output count.
    fee = calcGrinFee(selected.length, 2, 1);
  } else {
    fee = calcGrinFee(selected.length, 1, 1);
  }

  // 3. Path each input + present commitments for verification.
  const inputs: GrinUnspentOutput[] = selected.map((o) => ({
    path: keyIdToPath(o.key_id, o.n_child),
    amount: o.amount,
    commitment_hex: o.commitment,
    is_coinbase: o.is_coinbase,
  }));

  // 4. Build S1 slate via wasm orchestrator.
  const sendResult: GrinCreateSendTxResult = wasmGrin.createSendTransaction({
    extended_private_key_hex: extKeyHex,
    inputs,
    amount: args.amount,
    fee,
    kernel_kind: 'plain',
    change_path: childIndexToPath(spendable.next_child_index),
    kernel_offset_hex: '00'.repeat(32),
    kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // 5. Backend bookkeeping — record + lock + relay drop.
  await api.recordGrinTransaction({
    userId: args.userId,
    slateId: sendResult.slate_id,
    amount: args.amount,
    fee,
    direction: 'send',
    counterpartyAddress: args.recipientSlatepackAddress,
  });
  await api.lockGrinOutputs({
    userId: args.userId,
    outputIds: selected.map((o) => o.key_id),
    txSlateId: sendResult.slate_id,
  });
  // NOTE: change_output is NOT recorded here in v0.3. We forward it
  // through wizard state and the backend `broadcast_grin_transaction`
  // handler inserts it atomically with the broadcast. Recording the
  // change at S1 build (the v0.2.4 pattern) leaves an orphan
  // `unconfirmed` row in the DB if the user cancels — discovered as
  // wowovermoon's 6.14 GRIN ghost balance 2026-05-14. The change_output
  // details still flow up to the wizard via the return value below so
  // finalize can build the broadcastable tx bytes.

  let relay_id: string | undefined;
  // Encrypt the S1 to the recipient's slatepack address. Both Smirk
  // (v0.2.4 + v0.3) and grin-wallet/Grim decrypt encrypted slatepacks
  // via the ed25519 → X25519 + age scheme, so this is privacy-free
  // upside: the relay backend (and any observer) sees only ciphertext.
  // If the recipient address is malformed bech32, armorSlate falls back
  // to plain via the exception path — but we'd rather let that throw so
  // the user sees a clear error than silently leak the slate.
  const armored = armorSlate(
    sendResult.slate_json,
    args.senderSlatepackAddress,
    args.recipientSlatepackAddress,
  );
  // Smirk-to-Smirk auto-detect: always post the S1 to the relay with the
  // recipient's slatepack address. Backend matches that address against
  // the `wallets` table — if the recipient is a registered Smirk user,
  // the slatepack lands in their pending_to_sign queue. If not, the relay
  // entry expires after 7 days unused; the sender's wizard surface stays
  // clipboard-mode (the armored slatepack is also returned to the caller).
  const relay = await api.createGrinRelay({
    senderUserId: args.userId,
    slatepack: armored,
    slateId: sendResult.slate_id,
    amount: args.amount,
    ...(args.recipientUserId ? { recipientUserId: args.recipientUserId } : {}),
    recipientAddress: args.recipientSlatepackAddress,
  });
  if (relay.data) relay_id = relay.data.id;

  return {
    slate_id: sendResult.slate_id,
    armored,
    slate_json: sendResult.slate_json,
    sender_context_json: sendResult.sender_context_json,
    sender_inputs: inputs,
    ...(sendResult.change_output ? { change_output: sendResult.change_output } : {}),
    ...(relay_id !== undefined ? { relay_id } : {}),
    amount: args.amount,
    fee,
  };
}

export interface GrinSendBroadcastResult {
  /** Slate id — Grin's analog of a txid for wallet bookkeeping. */
  slate_id: string;
  /** On-chain kernel commitment — what block explorers index. */
  kernel_excess_hex: string;
}

/**
 * Receiver returned S2; finalize and broadcast.
 *
 * `s2Source` is either an armored slatepack (clipboard/relay) or the
 * raw slate JSON. We detect by leading 'B' (slatepack) vs '{' (JSON).
 */
export async function processGrinS2(args: {
  // api: imported at top, used directly
  userId: string;
  /** Sender's mnemonic — needed to derive the slatepack secret for
   *  decrypting an S2 the receiver encrypted to us. */
  mnemonic: string;
  s2: string;
  sender_context_json: string;
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
  /** If non-null, finalize via the relay /grin/relay/finalize endpoint
   *  so the recipient gets notified instantly. Otherwise just broadcast. */
  relay_id?: string;
}): Promise<GrinSendBroadcastResult> {
  const secretKeyHex = wasmGrin.slatepackAddressSecret(args.mnemonic, 0);
  const s2_slate_json = looksArmored(args.s2)
    ? dearmorSlate(args.s2, secretKeyHex)
    : args.s2;

  const finalize: GrinFinalizeSendResult = wasmGrin.finalizeSendSlate({
    s2_slate_json,
    sender_context_json: args.sender_context_json,
    sender_inputs: args.sender_inputs,
    ...(args.change_output ? { change_output: args.change_output } : {}),
  });

  // Broadcast the binary tx_bytes via the backend. Pass change_output
  // through so the backend atomically records the change row alongside
  // the broadcast — replaces the v0.2.4 pre-record pattern that
  // leaked orphans on cancel.
  await api.broadcastGrinTransaction({
    userId: args.userId,
    slateId: JSON.parse(finalize.slate_json).id,
    tx: { tx_bytes_hex: finalize.tx_bytes_hex },
    ...(args.change_output
      ? {
          changeOutput: {
            keyId: pathToKeyId(args.change_output.path),
            nChild: args.change_output.path[3],
            amount: args.change_output.amount,
            commitment: args.change_output.commitment_hex,
          },
        }
      : {}),
  });

  // Cleanup: mark inputs spent + tx finalized + stamp kernel excess.
  const slateId = JSON.parse(finalize.slate_json).id;
  await api.spendGrinOutputs({ userId: args.userId, txSlateId: slateId });
  await api.updateGrinTransaction({
    userId: args.userId,
    slateId,
    status: 'finalized',
    kernelExcess: finalize.kernel_excess_hex,
  });

  // Relay completion (if Smirk-to-Smirk path).
  if (args.relay_id) {
    await api.finalizeGrinSlatepack({
      relayId: args.relay_id,
      userId: args.userId,
      finalizedSlatepack: armorSlate(finalize.slate_json),
    });
  }

  return {
    slate_id: slateId,
    kernel_excess_hex: finalize.kernel_excess_hex,
  };
}

export async function cancelGrinSend(args: {
  // api: imported at top, used directly
  userId: string;
  slate_id: string;
  relay_id?: string;
}): Promise<void> {
  if (args.relay_id) {
    await api
      .cancelGrinSlatepack({ relayId: args.relay_id, userId: args.userId })
      .catch(() => undefined);
  }
  await api.unlockGrinOutputs({ userId: args.userId, txSlateId: args.slate_id });
  await api.updateGrinTransaction({
    userId: args.userId,
    slateId: args.slate_id,
    status: 'cancelled',
  });
}

// ============================================================================
// Invoice flow (receiver-initiated I1 → I2 → I3)
// ============================================================================

export interface GrinInvoiceInitResult {
  slate_id: string;
  armored: string;
  slate_json: string;
  receiver_context_json: string;
  output: GrinReceiverOutputInfo;
  amount: number;
  fee: number;
}

export async function startGrinInvoice(args: {
  // api: imported at top, used directly
  userId: string;
  mnemonic: string;
  receiverSlatepackAddress: string;
  amount: number;
  /** Receiver picks the fee in the invoice — sender accepts or rejects. */
  fee: number;
  resolver: GrinSendInputResolver;
}): Promise<GrinInvoiceInitResult> {
  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(args.mnemonic)) as {
    extended_private_key_hex: string;
  };
  const spendable = await args.resolver.fetchSpendable();

  const invoice: GrinCreateInvoiceResult = wasmGrin.createInvoice({
    extended_private_key_hex: extKey.extended_private_key_hex,
    amount: args.amount,
    fee: args.fee,
    kernel_kind: 'plain',
    output_path: childIndexToPath(spendable.next_child_index),
    kernel_offset_hex: '00'.repeat(32),
    receiver_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  return {
    slate_id: invoice.slate_id,
    armored: armorSlate(invoice.slate_json, args.receiverSlatepackAddress),
    slate_json: invoice.slate_json,
    receiver_context_json: invoice.receiver_context_json,
    output: invoice.output,
    amount: args.amount,
    fee: args.fee,
  };
}

export interface GrinInvoiceSignedResult {
  slate_id: string;
  armored: string;
  slate_json: string;
  sender_context_json: string;
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
}

/** Payer signs an invoice (I1 → I2). */
export async function signGrinInvoice(args: {
  // api: imported at top, used directly
  userId: string;
  mnemonic: string;
  payerSlatepackAddress: string;
  i1Armored: string;
  resolver: GrinSendInputResolver;
}): Promise<GrinInvoiceSignedResult> {
  const secretKeyHex = wasmGrin.slatepackAddressSecret(args.mnemonic, 0);
  // Pull the sender (= invoice originator = receiver of the payment)
  // address out of the slatepack envelope so we can encrypt I2 back
  // to them. The receiver's `slatepack_address` field is set when
  // they build I1 via `create_invoice` — we plumbed it through the
  // wasm DTO from grin-ext.
  const { slate_json: i1_slate_json, sender: i1Sender } = dearmorSlateAndSender(
    args.i1Armored,
    secretKeyHex,
  );
  const parsed = JSON.parse(i1_slate_json) as {
    sta: string;
    id: string;
    amt: number | string;
    fee: number | string;
  };
  if (parsed.sta !== 'I1') {
    throw new Error(`expected I1 slate, got ${parsed.sta}`);
  }

  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(args.mnemonic)) as {
    extended_private_key_hex: string;
  };
  const spendable = await args.resolver.fetchSpendable();

  // Pick inputs covering amount + fee declared in the invoice.
  const amount = Number(parsed.amt);
  const fee = Number(parsed.fee);
  const sorted = [...spendable.outputs].sort((a, b) => b.amount - a.amount);
  const selected: typeof sorted = [];
  let total = 0;
  for (const o of sorted) {
    selected.push(o);
    total += o.amount;
    if (total >= amount + fee) break;
  }
  if (total < amount + fee) {
    throw new Error('Insufficient funds to pay invoice');
  }
  const inputs: GrinUnspentOutput[] = selected.map((o) => ({
    path: keyIdToPath(o.key_id, o.n_child),
    amount: o.amount,
    commitment_hex: o.commitment,
    is_coinbase: o.is_coinbase,
  }));

  const signed: GrinSignInvoiceResult = wasmGrin.signInvoice({
    extended_private_key_hex: extKey.extended_private_key_hex,
    i1_slate_json,
    inputs,
    change_path: childIndexToPath(spendable.next_child_index),
    sender_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // Lock + record at the payer's side.
  await api.recordGrinTransaction({
    userId: args.userId,
    slateId: parsed.id,
    amount,
    fee,
    direction: 'send',
  });
  await api.lockGrinOutputs({
    userId: args.userId,
    outputIds: selected.map((o) => o.key_id),
    txSlateId: parsed.id,
  });
  if (signed.change_output) {
    await api.recordGrinOutput({
      userId: args.userId,
      keyId: pathToKeyId(signed.change_output.path),
      nChild: signed.change_output.path[3],
      amount: signed.change_output.amount,
      commitment: signed.change_output.commitment_hex,
      txSlateId: parsed.id,
    });
  }

  return {
    slate_id: parsed.id,
    // Encrypt I2 back to whoever sent us I1 (invoice originator).
    // i1Sender is set when the originator built the I1 via the
    // create_invoice flow; if absent (older external tooling that
    // didn't populate the slatepack `sender` field), fall back to
    // plaintext so the user can still copy-paste it.
    armored: armorSlate(
      signed.slate_json,
      args.payerSlatepackAddress,
      i1Sender ?? undefined,
    ),
    slate_json: signed.slate_json,
    sender_context_json: signed.sender_context_json,
    sender_inputs: inputs,
    ...(signed.change_output ? { change_output: signed.change_output } : {}),
  };
}

/** Recipient finalizes their invoice (I2 → I3 + broadcast).
 *
 * Sender's inputs are extracted from the I2 slate's `coms` list — entries
 * without a rangeproof `p` are input refs (vs outputs which carry a proof).
 * The Rust finalize uses commitment + features only, so path + amount are
 * dummy on the receiver side.
 */
export async function processGrinI2(args: {
  // api: imported at top, used directly
  userId: string;
  /** Receiver's mnemonic — derives the slatepack secret for
   *  decrypting an I2 the payer encrypted to us. */
  mnemonic: string;
  i2: string;
  receiver_context_json: string;
}): Promise<GrinSendBroadcastResult> {
  const secretKeyHex = wasmGrin.slatepackAddressSecret(args.mnemonic, 0);
  const i2_slate_json = looksArmored(args.i2)
    ? dearmorSlate(args.i2, secretKeyHex)
    : args.i2;
  const parsed = JSON.parse(i2_slate_json) as {
    coms?: Array<{ c: string; p?: string | null; f?: number }>;
  };
  const sender_inputs: GrinUnspentOutput[] = (parsed.coms ?? [])
    .filter((c) => c.p === undefined || c.p === null)
    .map((c) => ({
      path: [0, 0, 0, 0] as [number, number, number, number],
      amount: 0,
      commitment_hex: c.c,
      is_coinbase: (c.f ?? 0) === 1,
    }));
  const finalize: GrinFinalizeInvoiceResult = wasmGrin.finalizeInvoice({
    i2_slate_json,
    receiver_context_json: args.receiver_context_json,
    sender_inputs,
  });
  const slateId = JSON.parse(finalize.slate_json).id;
  await api.broadcastGrinTransaction({
    userId: args.userId,
    slateId,
    tx: { tx_bytes_hex: finalize.tx_bytes_hex },
  });
  await api.updateGrinTransaction({
    userId: args.userId,
    slateId,
    status: 'finalized',
    kernelExcess: finalize.kernel_excess_hex,
  });
  return { slate_id: slateId, kernel_excess_hex: finalize.kernel_excess_hex };
}

// ============================================================================
// Receive flow (external S1 → we sign as S2 → external broadcasts)
// ============================================================================

export interface GrinSignS1Result {
  slate_id: string;
  /** S2 armored slatepack to hand back to the sender. */
  s2_armored: string;
  s2_slate_json: string;
  receiver_context_json: string;
  output: GrinReceiverOutputInfo;
  kernel_excess_hex: string;
  amount: number;
}

/**
 * External wallet handed us an S1 slatepack. Sign as S2 and emit
 * the result. The sender will finalize + broadcast; we just record
 * the incoming output + tx so balance + history update once the
 * kernel is confirmed on chain.
 */
export async function signIncomingGrinSlate(args: {
  // api: imported at top, used directly
  userId: string;
  mnemonic: string;
  receiverSlatepackAddress: string;
  s1Armored: string;
  resolver: GrinSendInputResolver;
}): Promise<GrinSignS1Result> {
  const secretKeyHex = wasmGrin.slatepackAddressSecret(args.mnemonic, 0);
  // Pull the original sender's address out of the slatepack envelope
  // so we can encrypt S2 back to them. Without `sender` (e.g. a
  // legacy plaintext slatepack from an external wallet that didn't
  // include it), we fall back to plain — the user can still copy
  // S2 to clipboard and hand it back manually.
  const { slate_json: s1_slate_json, sender: s1Sender } = dearmorSlateAndSender(
    args.s1Armored,
    secretKeyHex,
  );
  const parsed = JSON.parse(s1_slate_json) as { sta: string; id: string; amt: number | string };
  if (parsed.sta !== 'S1') {
    throw new Error(`expected S1 slate, got ${parsed.sta}`);
  }

  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(args.mnemonic)) as {
    extended_private_key_hex: string;
  };
  const spendable = await args.resolver.fetchSpendable();

  const signed: GrinSignIncomingSendResult = wasmGrin.signIncomingSendSlate({
    extended_private_key_hex: extKey.extended_private_key_hex,
    s1_slate_json,
    output_path: childIndexToPath(spendable.next_child_index),
    receiver_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // Record our incoming output + the pending receive tx.
  const amount = Number(parsed.amt);
  await api.recordGrinTransaction({
    userId: args.userId,
    slateId: parsed.id,
    amount,
    fee: 0, // receiver doesn't pay fee
    direction: 'receive',
  });
  await api.recordGrinOutput({
    userId: args.userId,
    keyId: pathToKeyId(signed.output.path),
    nChild: signed.output.path[3],
    amount: signed.output.amount,
    commitment: signed.output.commitment_hex,
    txSlateId: parsed.id,
  });
  await api.updateGrinTransaction({
    userId: args.userId,
    slateId: parsed.id,
    status: 'signed',
    kernelExcess: signed.kernel_excess_hex,
  });

  return {
    slate_id: parsed.id,
    s2_armored: armorSlate(
      signed.slate_json,
      args.receiverSlatepackAddress,
      s1Sender ?? undefined,
    ),
    s2_slate_json: signed.slate_json,
    receiver_context_json: signed.receiver_context_json,
    output: signed.output,
    kernel_excess_hex: signed.kernel_excess_hex,
    amount,
  };
}

// ============================================================================
// Helpers — path packing
// ============================================================================

/**
 * Convert a stored `key_id` blob + `n_child` index into the 4-level
 * BIP32 path our wasm primitives expect.
 *
 * Legacy stored key_id as hex-encoded `Identifier` bytes; the canonical
 * Grin path is `m/0/0/n_child/0` for receive outputs and similar for
 * change. We rely on the BACKEND to round-trip `key_id` exactly and
 * only use `n_child` here; the path is recoverable from the index.
 */
function keyIdToPath(_keyId: string, nChild: number): [number, number, number, number] {
  return [0, 0, nChild, 0];
}

function childIndexToPath(nChild: number): [number, number, number, number] {
  return [0, 0, nChild, 0];
}

/** Pack a 4-level path back into a hex key_id for backend storage. */
function pathToKeyId(path: [number, number, number, number]): string {
  // 1-byte depth (4) + 4 × 4-byte BE u32 = 17 bytes total. Matches
  // grin-wallet's `Identifier::to_bytes` layout used by our backend
  // for storing key_id.
  const out = new Uint8Array(17);
  out[0] = 4;
  const view = new DataView(out.buffer);
  view.setUint32(1, path[0], false);
  view.setUint32(5, path[1], false);
  view.setUint32(9, path[2], false);
  view.setUint32(13, path[3], false);
  return bytesToHex(out);
}

function looksArmored(s: string): boolean {
  return s.trimStart().startsWith('BEGINSLATEPACK');
}
