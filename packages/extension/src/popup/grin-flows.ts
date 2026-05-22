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

/**
 * Derive the canonical (grin-wallet/Grim-compatible) slatepack address
 * from a mnemonic, via wasm. This is the ONLY correct address for Grin
 * signing/encryption — `wallet.addresses.grin` (computed at unlock
 * time by `@smirk/core`'s `deriveGrinKey`) uses a Smirk-custom
 * `SHA256(master || "smirk:grin:v1")` derivation that does NOT match
 * what `slatepack_address_secret` produces. Mixing them means the
 * sender encrypts to one pubkey and the receiver decrypts with a
 * different one — age throws "No matching keys found".
 *
 * Requires wasm to already be initialized (call `ensureWasmInit()`
 * upstream).
 */
export function canonicalGrinSlatepackAddress(mnemonic: string): string {
  return wasmGrin.slatepackAddress(mnemonic, 0, 'mainnet');
}

/**
 * Wrap a dearmor failure so the resulting Error.message carries enough
 * information to debug in the UI (without forcing the user to open
 * DevTools). Also fires a structured console.error.
 *
 * Triggered most often by:
 *  - Unicode lookalike periods (U+FF0E '．' or U+2024 '‧') in the
 *    armored payload — input passes the eye-test but no ASCII 0x2E byte
 *    is present.
 *  - Silently empty / wrong-typed `armored` from a stale wizard slot.
 *  - Relay-side encoding / quoting that mangled the payload in transit.
 */
function augmentDearmorError(e: unknown, armored: string): Error {
  const orig = e instanceof Error ? e.message : String(e);
  const preview = armored.slice(0, 80);
  const bytes = new TextEncoder().encode(preview);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hasAsciiDot = armored.includes('.');
  // Single concatenated string so chrome://extensions Errors panel
  // shows something readable (it renders %O / object args as
  // "[object Object]"). Also captured in DevTools console with full
  // structured fields below.
  const summary = `[grin-dearmor] failed: ${orig} | len=${armored.length} asciiDot=${hasAsciiDot} preview=${JSON.stringify(preview)} first80hex=${hex}`;
  console.error(summary);
  console.error('[grin-dearmor] details:', {
    error: orig,
    length: armored.length,
    preview,
    previewHex: hex,
    hasAsciiDot,
  });
  return new Error(
    `${orig} (len=${armored.length}, asciiDot=${hasAsciiDot}, first80hex=${hex.slice(0, 80)}…)`,
  );
}


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
  // slatepackPackEncrypted / slatepackPackPlain are one-call helpers that
  // already return the BEGINSLATEPACK…ENDSLATEPACK armored string. Do not
  // wrap them with `slatepackArmor` — that re-armor pass tries to
  // hex-decode "BEGINSLATEPACK…" and dies with "invalid payload_hex:
  // Invalid character 'G' at position 2".
  if (recipientSlatepackAddress) {
    const recipientPubkeyHex = wasmGrin.slatepackAddressToPubkeyHex(
      recipientSlatepackAddress,
    );
    return wasmGrin.slatepackPackEncrypted(
      binHex,
      senderSlatepackAddress ?? null,
      recipientPubkeyHex,
    );
  }
  return wasmGrin.slatepackPackPlain(binHex, senderSlatepackAddress ?? null);
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
  // slatepackUnpack[WithSecret] take an ASCII-armored slatepack and do
  // dearmor + bin-decode internally. Calling slatepackDearmor first and
  // passing the resulting hex to them double-dearmors — the second
  // dearmor sees the hex (no period byte) and throws "no header
  // terminator '.' found".
  let unpackedJson: string;
  try {
    unpackedJson = secretKeyHex
      ? wasmGrin.slatepackUnpackWithSecret(armored, secretKeyHex)
      : wasmGrin.slatepackUnpack(armored);
  } catch (e) {
    throw augmentDearmorError(e, armored);
  }
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
  // Same as dearmorSlate — pass armored directly; slatepackUnpack*
  // dearmors internally, so the previous pre-dearmor was a
  // double-decode that threw "no header terminator '.' found".
  let unpackedJson: string;
  try {
    unpackedJson = secretKeyHex
      ? wasmGrin.slatepackUnpackWithSecret(armored, secretKeyHex)
      : wasmGrin.slatepackUnpack(armored);
  } catch (e) {
    throw augmentDearmorError(e, armored);
  }
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
 * Grin minimum acceptable fee.
 *
 * Matches `grin_core::global::DEFAULT_ACCEPT_FEE_BASE` (= 500_000
 * nanogrin per weight unit) × the per-component weight formula in
 * `grin_core::core::transaction::TransactionBody::weight`:
 *
 * ```
 * weight = inputs * 1 + outputs * 21 + kernels * 3
 * fee    = weight * 500_000
 * ```
 *
 * For a typical 1-input 2-output 1-kernel send: weight = 46, fee = 23_000_000
 * nanogrin (0.023 GRIN). v0.2.4 used these same numbers (see
 * `/home/jw/src/smirk-extension/src/lib/grin/constants.ts`); the
 * monorepo briefly shipped a wrong `BASE_FEE × max(1, 4·out − in + kern)`
 * formula that produced 8M nanogrin — accepted by every test broadcast
 * since 2026-04-28 was rejected by the node with
 * `Failed to update pool: Low fee transaction 8000000`.
 *
 * Used for greedy input selection — iterate, recompute fee per
 * candidate input set, stop when sum(inputs) ≥ amount + fee.
 */
const GRIN_FEE_BASE = 500_000;
const GRIN_INPUT_WEIGHT = 1;
const GRIN_OUTPUT_WEIGHT = 21;
const GRIN_KERNEL_WEIGHT = 3;

export function calcGrinFee(numInputs: number, numOutputs: number, numKernels: number): number {
  const weight =
    numInputs * GRIN_INPUT_WEIGHT +
    numOutputs * GRIN_OUTPUT_WEIGHT +
    Math.max(1, numKernels) * GRIN_KERNEL_WEIGHT;
  return weight * GRIN_FEE_BASE;
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
      /** Backend grin_outputs.id (UUID). Required for lock/spend RPCs —
       *  the backend's `lock_grin_outputs` and `spend_grin_outputs`
       *  match by row UUID, NOT by `key_id`. Passing `key_id` here
       *  silently no-ops (the UUID parse 400s) and leaves the input
       *  unlocked → input never marked spent → balance double-counts
       *  the spent UTXO. */
      id: string;
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
  // 1. Derive both v3 and legacy ext keys. JS-side; never logged.
  // The orchestrator tries v3 first per input, falls back to legacy
  // (PBKDF2-then-HMAC) on commitment mismatch — lets v0.3 spend
  // outputs created by pre-2026-05 v0.2.x wallets that hadn't yet
  // migrated derivationVersion to 3. Sunset 2026-11-15.
  const extKeyJson = wasmGrin.deriveExtendedKey(args.mnemonic);
  const extKey = JSON.parse(extKeyJson) as { extended_private_key_hex: string };
  const extKeyHex = extKey.extended_private_key_hex;
  const legacyExtKeyHex = wasmGrin.deriveExtendedKeyLegacyBip39(args.mnemonic);

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
    legacy_extended_private_key_hex: legacyExtKeyHex,
    inputs,
    amount: args.amount,
    fee,
    kernel_kind: 'plain',
    change_path: childIndexToPath(spendable.next_child_index),
    // TEMP DIAGNOSTIC 2026-05-17: revert to zero offset. The
    // randomized offset change introduced a "keychain error" at the
    // node — local sig self-verify passes but on-chain check fails.
    // Zero offset is documented as the compact-slate default; we'll
    // re-introduce per-slate random offsets after confirming the
    // wasm offset path balances correctly with the on-chain equation.
    kernel_offset_hex: '00'.repeat(32),
    kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // Plan-C diagnostic: log which derivation matched each input.
  // Expect "v3+Regular" for post-2026-05 outputs; "legacy+Regular"
  // (or "legacy+None") for pre-rotation v0.2.x outputs.
  console.log('[grin-send] input derivations:', sendResult.input_derivations);

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
    outputIds: selected.map((o) => o.id),
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

  // Broadcast the tx_json via the backend. Pass change_output through
  // so the backend atomically records the change row alongside the
  // broadcast — replaces the v0.2.4 pre-record pattern that leaked
  // orphans on cancel.
  const broadcastRes = await api.broadcastGrinTransaction({
    userId: args.userId,
    slateId: JSON.parse(finalize.slate_json).id,
    // Grin's /v2/foreign push_transaction expects a JSON Transaction
    // object ({offset, body:{inputs,outputs,kernels}}), NOT the binary
    // wire-format hex. Sending the hex blob (the old shape) yielded
    // JSON-RPC error -32602 InvalidArgStructure "tx" at position 0,
    // which our backend parser silently treated as success — every
    // broadcast since 2026-04-28 was a no-op. tx_json comes from
    // grin-ext's slate_to_transaction_json and matches grin_core's
    // Transaction serde shape verbatim.
    tx: finalize.tx_json,
    ...(args.change_output
      ? {
          changeOutput: {
            keyId: pathToKeyId(args.change_output.path),
            // The real BIP32 child index sits at path[2]; path[3] is the
            // trailing padding `0` per Grin's depth-3-+-1 convention.
            // Storing path[3] left every change output's n_child=0,
            // so derive_blind on the NEXT send walked m/0/0/0/0 instead
            // of m/0/0/<actual>/0 and reported "no candidate derivation
            // reproduced the on-chain commit" — full wallet bricking
            // after one spend.
            nChild: args.change_output.path[2],
            amount: args.change_output.amount,
            commitment: args.change_output.commitment_hex,
          },
        }
      : {}),
  });
  // CRITICAL: bail on broadcast failure. Previously we await'd the
  // response and continued blindly to spendGrinOutputs +
  // updateGrinTransaction(status='finalized'), so a node rejection
  // (low fee, bad kernel, etc.) silently became a "finalized" row in
  // our DB while no kernel ever hit the chain. That's the source of
  // every "+X pending" ghost row on receivers — sender's tx looks
  // finalized so the receive output never gets cleaned up.
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error}`);
  }

  // Cleanup: mark inputs spent + tx finalized + stamp kernel excess.
  const slateId = JSON.parse(finalize.slate_json).id;
  await api.spendGrinOutputs({ userId: args.userId, txSlateId: slateId });
  await api.updateGrinTransaction({
    userId: args.userId,
    slateId,
    status: 'finalized',
    kernelExcess: finalize.kernel_excess_hex,
  });

  // Relay slatepack status flip now happens server-side inside
  // `broadcast_grin_transaction` (atomic with the push_transaction
  // call, on the same DB transaction). The old `finalize_grin_relay`
  // endpoint goes through the grin-wallet daemon's slatepack decoder
  // which hangs at ECDH against the wallet socket, leaving the
  // slatepack stuck in `pending_sender` and the sender's "pending to
  // finalize" counter stale forever. Removed the call entirely.

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
    // TEMP DIAGNOSTIC 2026-05-17: revert to zero offset. The
    // randomized offset change introduced a "keychain error" at the
    // node — local sig self-verify passes but on-chain check fails.
    // Zero offset is documented as the compact-slate default; we'll
    // re-introduce per-slate random offsets after confirming the
    // wasm offset path balances correctly with the on-chain equation.
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
  const legacyExtKeyHex = wasmGrin.deriveExtendedKeyLegacyBip39(args.mnemonic);
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
    legacy_extended_private_key_hex: legacyExtKeyHex,
    i1_slate_json,
    inputs,
    change_path: childIndexToPath(spendable.next_child_index),
    sender_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  console.log('[grin-pay-invoice] input derivations:', signed.input_derivations);

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
    outputIds: selected.map((o) => o.id),
    txSlateId: parsed.id,
  });
  if (signed.change_output) {
    await api.recordGrinOutput({
      userId: args.userId,
      keyId: pathToKeyId(signed.change_output.path),
      nChild: signed.change_output.path[2],
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
  const broadcastRes = await api.broadcastGrinTransaction({
    userId: args.userId,
    slateId,
    // Grin's /v2/foreign push_transaction expects a JSON Transaction
    // object ({offset, body:{inputs,outputs,kernels}}), NOT the binary
    // wire-format hex. tx_json comes from grin-ext's
    // slate_to_transaction_json and matches grin_core's Transaction
    // serde shape verbatim.
    tx: finalize.tx_json,
  });
  // See parallel comment in processGrinS2 — bail on error so the tx
  // stays "pending" / cancellable instead of getting wrongly stamped
  // "finalized" by the next update call.
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error}`);
  }
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
  // Sanity-check that the current mnemonic actually derives the
  // slatepack address the wallet is claiming. If they disagree, the
  // wallet has been recreated since this slatepack was sent — the
  // sender encrypted to an address we no longer control and age
  // decrypt is guaranteed to fail with the cryptic "No matching
  // keys found". Surface a clear cause instead.
  const derivedAddress = wasmGrin.slatepackAddress(args.mnemonic, 0, 'mainnet');
  if (derivedAddress !== args.receiverSlatepackAddress) {
    throw new Error(
      `wallet/address mismatch — your current mnemonic derives ${derivedAddress.slice(0, 24)}… ` +
        `but this slatepack was encrypted to ${args.receiverSlatepackAddress.slice(0, 24)}…. ` +
        `The receiver wallet was likely recreated since the slatepack was sent. ` +
        `Cancel this row and ask the sender to re-send to your current address.`,
    );
  }
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
    nChild: signed.output.path[2],
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
