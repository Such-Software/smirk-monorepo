/**
 * Grin send + invoice + receive orchestration.
 *
 * Sits between `@smirk/wasm`'s slate-ceremony primitives and the v3 Grin backend
 * (`@smirk/core/api/grin.ts`). Grin on v3 is NON-CUSTODIAL: there is no
 * server-side output store, balance, or lock/spend lifecycle. Spendable inputs
 * come from `POST /wallet/grin/scan` (the source of truth), and the client owns
 * output state via a minimal local pending overlay
 * (`@smirk/core` `GrinPendingOverlay`):
 *
 *   - `resolveGrinSpendable`: scan → maturity filter → exclude just-spent
 *     (overlay) → recover each output's BIP32 path (preferring grin-lws's
 *     verified `key_id`, else the `wasmGrin.identifyOutput` search). This is the
 *     scan-based replacement for the old custodial `listOutputs`.
 *   - `startGrinSend`, sender's S1: select inputs, build S1, RESERVE the spent
 *     inputs + change index in the overlay AT BUILD TIME (so a concurrent
 *     send/receive/invoice can neither re-select the inputs nor re-derive the
 *     change index), then deliver over the unified channel seam
 *     (`selectSendChannel`).
 *   - `processGrinS2`, sender's S3: finalize + broadcast, then mark the reserved
 *     overlay entry `broadcast` (re-anchoring its TTL to the real broadcast) and
 *     settle the exchange on the wire. The child index was already advanced at
 *     build time: it does NOT bump again here.
 *   - `cancelGrinSend`: drop the overlay entry (inputs selectable again), but
 *     ONLY while still pre-broadcast, and cancel the exchange on its channel.
 *   - `startGrinInvoice` / `signGrinInvoice` / `processGrinI2`: receiver-
 *     initiated trio.
 *   - `signIncomingGrinSlate`: external wallet hands us an S1; we sign as S2.
 *
 * The child-index counter (`overlay.nextChildIndex`) is money-critical: with the
 * server output store gone there is no `next_child_index` field, and reusing an
 * index re-derives an identical commitment (the second output is unspendable →
 * fund loss). Every flow that mints a new output advances the counter.
 */

import {
  chainProviders,
  GrinPendingOverlay,
  selectSendChannel,
  type GrinPending,
  type GrinPendingStore,
  type GrinScanOutput,
  type SlatepackChannels,
} from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';
import { recordGrinTx, updateGrinTxStatus } from './grin-tx-journal';
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

/** Grin coinbase maturity: coinbase outputs are unspendable for 1440 blocks. */
const GRIN_COINBASE_MATURITY = 1440;

/**
 * Child-index search span for `identifyOutput`. Scan returns no derivation path,
 * so we search `0..=(persistedNextChildIndex + span)` for each output. Generous
 * enough to cover a fresh-load wallet whose counter hasn't been seeded yet;
 * grin's UTXO set is small so the cost is bounded. Identify runs only at
 * send/receive time, never on a plain balance refresh.
 */
const GRIN_IDENTIFY_SEARCH_SPAN = 2000;

/**
 * Parse a Grin output identifier (`key_id`) into the canonical Smirk spend path.
 *
 * grin-lws recovers `key_id` by rewinding the output's rangeproof, which
 * cryptographically binds the commitment to its value and derivation path, so a
 * `key_id` it returns is already verified server-side. We use it to skip the
 * client-side `identifyOutput` search entirely.
 *
 * A Grin identifier is 17 bytes: a 1-byte depth followed by four big-endian u32
 * path elements. We accept ONLY the exact depth-4 `[0, 0, n, 0]` layout every
 * Smirk output uses, returning `[0, 0, n, 0]`. Anything else (wrong length,
 * non-canonical shape, unparseable) returns null, so the caller falls back to
 * the verified `identifyOutput` search that covers the full candidate matrix.
 * The spendable child index is `path[2]`, NOT the trailing `n_child`. A wrong
 * path can only yield an invalid (node-rejected) tx, never a fund loss.
 */
function parseGrinCanonicalKeyId(
  keyId: string,
): [number, number, number, number] | null {
  if (!/^[0-9a-fA-F]{34}$/.test(keyId)) return null;
  const u32 = (byteOffset: number) => parseInt(keyId.slice(byteOffset * 2, byteOffset * 2 + 8), 16);
  const depth = parseInt(keyId.slice(0, 2), 16);
  const p0 = u32(1);
  const p1 = u32(5);
  const p2 = u32(9);
  const p3 = u32(13);
  // Only the canonical depth-4 [0,0,n,0] layout; defer anything else to the
  // verified identify search.
  if (depth !== 4 || p0 !== 0 || p1 !== 0 || p3 !== 0) return null;
  return [0, 0, p2, 0];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Derive the canonical (grin-wallet/Grim-compatible) slatepack address
 * from a mnemonic, via wasm. This is the ONLY correct address for Grin
 * signing/encryption: `wallet.addresses.grin` (computed at unlock
 * time by `@smirk/core`'s `deriveGrinKey`) uses a Smirk-custom
 * `SHA256(master || "smirk:grin:v1")` derivation that does NOT match
 * what `slatepack_address_secret` produces. Mixing them means the
 * sender encrypts to one pubkey and the receiver decrypts with a
 * different one: age throws "No matching keys found".
 *
 * Requires wasm to already be initialized (call `ensureWasmInit()`
 * upstream).
 */
export function canonicalGrinSlatepackAddress(mnemonic: string): string {
  return wasmGrin.slatepackAddress(mnemonic, 0, 'mainnet');
}

/**
 * Compute the wallet's Grin `rewind_hash` (view-only credential) from the
 * mnemonic. This is the only secret handed to `POST /wallet/grin/scan`; it lets
 * the backend recognize this wallet's outputs without spend authority. Requires
 * wasm to be initialized.
 */
export function grinRewindHashFromMnemonic(mnemonic: string): string {
  const extKeyHex = (
    JSON.parse(wasmGrin.deriveExtendedKey(mnemonic)) as { extended_private_key_hex: string }
  ).extended_private_key_hex;
  return wasmGrin.rewindHash(extKeyHex);
}

/**
 * Wrap a dearmor failure so the resulting Error.message carries enough
 * information to debug in the UI (without forcing the user to open
 * DevTools). Also fires a structured console.error.
 *
 * Triggered most often by:
 *  - Unicode lookalike periods (U+FF0E '．' or U+2024 '‧') in the
 *    armored payload: input passes the eye-test but no ASCII 0x2E byte
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


// ============================================================================
// Scan-based spendable resolver (replaces the custodial output store)
// ============================================================================

/** Dependencies for a scan-based spendable resolution. */
export interface GrinScanDeps {
  /** Mnemonic: derives ext keys for `identifyOutput`. Never logged. */
  mnemonic: string;
  /** View-only credential for the scan (see {@link grinRewindHashFromMnemonic}). */
  rewindHash: string;
  /** Client pending overlay: excludes just-spent inputs + owns the child index. */
  overlay: GrinPendingOverlay;
}

/** Spendable inputs resolved from scan, each with its recovered BIP32 path. */
export interface GrinSpendable {
  outputs: GrinUnspentOutput[];
  /**
   * The child-index counter value AFTER seeding from scan: informational only.
   * Do NOT derive a new output's path from this: a read-here / bump-later pair
   * races (two concurrent flows read the same value → duplicate commitment → fund
   * loss). Mint flows MUST call `overlay.reserveNextChildIndex()` to atomically
   * read-and-increment instead.
   */
  nextChildIndex: number;
}

/**
 * Resolve currently-spendable Grin inputs from a fresh scan.
 *
 * 1. scan (source of truth) + chain tip.
 * 2. reconcile the overlay against the scan (clear settled entries first).
 * 3. keep MATURE outputs (coinbase ≥1440 confs; regular past lock_height) that
 *    are NOT in the overlay's pending-spent set (just-broadcast, not yet mined).
 * 4. recover each output's path: prefer grin-lws's `key_id` (skips the search),
 *    else fall back to the `identifyOutput` search. DROP (warn) any output whose
 *    path can't be recovered (never feed a wrong path to the send builder: it
 *    silently yields a bad blind and an invalid tx).
 * 5. seed the child-index counter to max(CLIENT-VERIFIED path[2]) + 1 so a new
 *    output never reuses an index (reuse = duplicate commitment = fund loss).
 *    Only `identifyOutput`-verified indices seed it; a raw `key_id` index is
 *    trusted for spending but never moves the counter (see the seed note below).
 */
export async function resolveGrinSpendable(deps: GrinScanDeps): Promise<GrinSpendable> {
  const grin = chainProviders.grin();
  const [scanRes, heightRes] = await Promise.all([
    grin.scan({ rewindHash: deps.rewindHash }),
    grin.getHeight(),
  ]);
  if (scanRes.error || !scanRes.data) {
    throw new Error(`Failed to scan Grin outputs: ${scanRes.error ?? 'network error'}`);
  }
  const scanned: GrinScanOutput[] = scanRes.data.outputs;
  const tip = heightRes.data?.height ?? 0;

  // Reconcile BEFORE reading the overlay so settled entries stop excluding
  // inputs / inflating the counter.
  await deps.overlay.reconcile(scanned);
  const pendingSpent = await deps.overlay.selectablePendingSpent();

  const selectable = scanned.filter((o) => {
    const spendableHeight = o.is_coinbase
      ? o.height + GRIN_COINBASE_MATURITY
      : Math.max(o.height, o.lock_height);
    const mature = o.height > 0 && tip >= spendableHeight;
    return mature && !pendingSpent.has(o.commit);
  });

  const extKeyHex = (
    JSON.parse(wasmGrin.deriveExtendedKey(deps.mnemonic)) as { extended_private_key_hex: string }
  ).extended_private_key_hex;
  const legacyExtKeyHex = wasmGrin.deriveExtendedKeyLegacyBip39(deps.mnemonic);

  const persisted = await deps.overlay.nextChildIndex();
  const maxN = persisted + GRIN_IDENTIFY_SEARCH_SPAN;

  const outputs: GrinUnspentOutput[] = [];
  // ONLY indices we cryptographically verified client-side may seed the
  // money-critical child-index counter. `wasmGrin.identifyOutput` re-derives the
  // output's blinding factor and checks that it reproduces `o.commit`, so an
  // index it returns is bound to the rangeproof/commitment. A raw `key_id` index
  // is NOT verified here (grin-lws asserts the rangeproof rewind server-side, but
  // a hostile/buggy LWS could report a wrong index), so it must never move the
  // counter: see the residual-trust note on the seed below.
  const verifiedIndices: number[] = [];
  for (const o of selectable) {
    // SPEND PATH: prefer grin-lws's recovered `key_id`. When it is the canonical
    // Smirk shape we spend directly and skip the O(span) identify search. Fall
    // back to the client-side verified search when the scan carried no usable
    // key_id (the grin-wallet fallback path, or a non-canonical identifier).
    const fromKeyId = o.key_id ? parseGrinCanonicalKeyId(o.key_id) : null;
    let path = fromKeyId;
    if (!path) {
      path = wasmGrin.identifyOutput(
        extKeyHex,
        legacyExtKeyHex,
        o.commit,
        BigInt(o.value),
        maxN,
      );
      // Only a path returned by the verified search is safe to seed the counter:
      // it is cryptographically bound to this output's commitment.
      if (path) verifiedIndices.push(path[2]);
    }
    if (!path) {
      console.warn(
        '[grin-spend] could not identify derivation path for output; dropping from selection:',
        o.commit,
      );
      continue;
    }
    outputs.push({ path, amount: o.value, commitment_hex: o.commit, is_coinbase: o.is_coinbase });
  }

  // Seed the counter from the highest index we CRYPTOGRAPHICALLY VERIFIED, so the
  // next new output allocates a fresh index. seedNextChildIndex never rewinds.
  //
  // Residual trust: `@smirk/wasm` exposes no O(1) "commitment for a path+value"
  // primitive, and the scan output carries no rangeproof for `recoverOutput`, so
  // there is no cheap per-`key_id` verification. We therefore split the trust:
  //   - `key_id` is still trusted for SPENDING (fast path). That is safe: a wrong
  //     path only yields a bad blind → an invalid, node-rejected tx, never a loss
  //     of funds (a duplicate-commitment mint is likewise consensus-rejected).
  //   - `key_id` indices do NOT seed the counter, so a hostile/buggy LWS cannot
  //     poison `nextChildIndex` (e.g. push it toward u32 overflow, or deflate it
  //     to force a reuse). The trade-off: a fresh restore whose every output
  //     carries a `key_id` won't seed the counter from scan and leans on the
  //     persisted counter + consensus reject-on-reuse; that reject is non-fatal
  //     (the failed mint self-heals: reserveNextChildIndex already advanced).
  if (verifiedIndices.length > 0) {
    await deps.overlay.seedNextChildIndex(Math.max(...verifiedIndices) + 1);
  }
  const nextChildIndex = await deps.overlay.nextChildIndex();
  return { outputs, nextChildIndex };
}

/** Build a {@link GrinSendInputResolver} bound to a scan context. */
export function makeGrinResolver(deps: GrinScanDeps): GrinSendInputResolver {
  return { fetchSpendable: () => resolveGrinSpendable(deps) };
}

// ── Counterparty ref codec ───────────────────────────────────────────────────
//
// The send channel (nostr vs backend) + the counterparty address are threaded
// through the wizard as one opaque string so the wizard contract stays a single
// `relayId`/`relay_id`. `settle`/`cancel` decode it to pick the right channel.

type ChannelKind = 'nostr' | 'backend';

function encodeCounterparty(kind: ChannelKind, ref: string): string {
  return `${kind}:${ref}`;
}

function decodeCounterparty(s: string): { kind: ChannelKind; ref: string } | null {
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const kind = s.slice(0, i);
  const ref = s.slice(i + 1);
  if ((kind !== 'nostr' && kind !== 'backend') || !ref) return null;
  return { kind, ref };
}

/**
 * Pack a slate JSON into the canonical armored slatepack envelope:
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
  // wrap them with `slatepackArmor`: that re-armor pass tries to
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
 * Inverse of `armorSlate`: takes a BEGINSLATEPACK…ENDSLATEPACK
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
  // passing the resulting hex to them double-dearmors: the second
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
  // Same as dearmorSlate: pass armored directly; slatepackUnpack*
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
 * nanogrin (0.023 GRIN). The v0.2.4 extension uses the same numbers.
 * Do not substitute `BASE_FEE × max(1, 4·out − in + kern)`: it yields
 * 8M nanogrin, which the node rejects with
 * `Failed to update pool: Low fee transaction 8000000`.
 *
 * Used for greedy input selection: iterate, recompute fee per
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

/**
 * Decide the Grin fee and whether a change output is produced, for a send of
 * `amount` from selected inputs totalling `total` (`numInputs` of them).
 *
 * The builder derives `change = total - (amount + fee)` and emits a change output
 * iff that is > 0, so the fee we pick MUST be consistent with the output count we
 * intend, or the built tx carries the wrong fee for its weight:
 *   - surplus above the 2-output fee is positive  -> change output; fee = fee(2 out)
 *   - otherwise -> NO change output; fee = total - amount, which folds a
 *     sub-change-cost surplus (or an exact match) into the fee. That is always
 *     >= the 1-output minimum, so the node never rejects it as a low fee, and it
 *     never underfunds the inputs the way bumping back to the 2-output fee did.
 *
 * Caller must guarantee `total >= amount + calcGrinFee(numInputs, 1, 1)`.
 */
export function resolveGrinFee(
  total: number,
  amount: number,
  numInputs: number,
): { fee: number; hasChange: boolean } {
  const fee2 = calcGrinFee(numInputs, 2, 1);
  if (total - amount - fee2 > 0) {
    return { fee: fee2, hasChange: true };
  }
  return { fee: total - amount, hasChange: false };
}

// ============================================================================
// Send flow (sender-initiated S1 → S2 → S3)
// ============================================================================

/**
 * Resolves currently-spendable Grin inputs (scan-based). Each output already
 * carries its recovered BIP32 `path`; `nextChildIndex` is the counter for a new
 * change/receive output. Build one with {@link makeGrinResolver}.
 */
export interface GrinSendInputResolver {
  fetchSpendable: () => Promise<GrinSpendable>;
}

export interface GrinSendInitResult {
  slate_id: string;
  /** Armored slatepack for clipboard / external interop. */
  armored: string;
  /** Slate JSON for backend relay (Smirk-to-Smirk). */
  slate_json: string;
  /** Opaque sender context (persist in wizard fields). */
  sender_context_json: string;
  /** Inputs consumed, needed at finalize (+ their commits become pending-spent). */
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
  /** Opaque counterparty ref (`kind:ref`) when delivered over a channel;
   *  round-tripped to finalize (settle) + cancel. Absent for manual/clipboard. */
  relay_id?: string;
  amount: number;
  fee: number;
}

/**
 * Start a Grin send: scan for spendable inputs, select, build S1, deliver over
 * the unified channel seam.
 *
 * Delivery routing (Nostr default, backend fallback, else manual):
 *   - `recipientPubkeyHex` present → Nostr gift-wrap.
 *   - else `recipientUserId` present → backend relay.
 *   - else → manual (armored blob only; no channel).
 *
 * NO backend output record/lock here: v3 has no output store. The overlay entry
 * (spent inputs + change) is RESERVED here at BUILD TIME so a concurrent flow
 * can't re-select the inputs or re-derive the change index; {@link processGrinS2}
 * flips it to `broadcast`, and a pre-broadcast {@link cancelGrinSend} frees it.
 * The selected inputs + change also flow up through the wizard so finalize can
 * build the tx.
 */
export async function startGrinSend(args: {
  mnemonic: string;
  senderSlatepackAddress: string;
  /** Recipient slatepack address (encrypts the S1 to them). Omit for manual
   *  plain-armored delivery to a recipient whose address isn't known up front. */
  recipientSlatepackAddress?: string;
  /** Backend-relay recipient (same-instance user_id). */
  recipientUserId?: string;
  /** Nostr recipient (x-only pubkey hex): the Goblin-interoperable default. */
  recipientPubkeyHex?: string;
  /** Both send transports, built by the caller (`buildSlatepackChannels`). */
  channels: SlatepackChannels;
  amount: number;
  resolver: GrinSendInputResolver;
  /** Client pending overlay: reserves the spent inputs + change index at build. */
  overlay: GrinPendingOverlay;
}): Promise<GrinSendInitResult> {
  // 1. Derive both v3 and legacy ext keys. JS-side; never logged. The
  //    orchestrator tries v3 first per input, falls back to legacy on
  //    commitment mismatch; lets v0.3 spend outputs created by pre-2026-05
  //    v0.2.x wallets. Sunset 2026-11-15.
  const extKeyJson = wasmGrin.deriveExtendedKey(args.mnemonic);
  const extKey = JSON.parse(extKeyJson) as { extended_private_key_hex: string };
  const extKeyHex = extKey.extended_private_key_hex;
  const legacyExtKeyHex = wasmGrin.deriveExtendedKeyLegacyBip39(args.mnemonic);

  // 2. Pick inputs via greedy + fee iteration. Grin fee depends on input
  //    count, so loop until stable.
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
      // Could be sweep: recompute with 1 output (no change).
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

  // Pick a fee consistent with what the builder will actually emit: a change output
  // only when the surplus exceeds the 2-output fee, otherwise fold the surplus into
  // the fee (single output). Toggling change on/off with a mismatched fee used to
  // produce node-rejected "Low fee" or spurious "insufficient inputs" sends within a
  // ~0.0105-GRIN window near an exact-balance spend.
  fee = resolveGrinFee(total, args.amount, selected.length).fee;

  // 3. Inputs already carry their identified path (from the scan resolver).
  const inputs: GrinUnspentOutput[] = selected;

  // 3b. ATOMICALLY reserve the change index BEFORE the build (the builder needs
  //     the change_path up front, before we know whether a change output is
  //     actually produced). Reserving here, rather than reading spendable's
  //     counter and bumping after, closes the race where two concurrent mint
  //     flows read the same index and mint duplicate (unspendable) commitments.
  //     If this send turns out to have no change, the reserved index is simply
  //     skipped (harmless; the counter never re-hands a value).
  const changeIndex = await args.overlay.reserveNextChildIndex();

  // 4. Build S1 slate via wasm orchestrator.
  const sendResult: GrinCreateSendTxResult = wasmGrin.createSendTransaction({
    extended_private_key_hex: extKeyHex,
    legacy_extended_private_key_hex: legacyExtKeyHex,
    inputs,
    amount: args.amount,
    fee,
    kernel_kind: 'plain',
    change_path: childIndexToPath(changeIndex),
    // Per-slate random kernel offset for kernel-linkability privacy.
    kernel_offset_hex: wasmGrin.randomSecretNonce(),
    kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  console.debug('[grin-send] input derivations:', sendResult.input_derivations);

  // 4b. Reserve the selected inputs + the change index in the overlay AT BUILD
  //     TIME (before delivery), matching the invoice/receive flows. This is
  //     money-critical: without it a concurrent send/invoice/receive could
  //     re-select the same inputs (double-spend reject) or re-derive the same
  //     change index (duplicate commitment → unspendable → fund loss), because
  //     the overlay wasn't updated until broadcast. The entry starts NOT
  //     broadcast; processGrinS2 flips it, cancelGrinSend frees it while still
  //     pre-broadcast, and the 7-day reconcile backstop frees an abandoned one.
  await args.overlay.addPending(sendResult.slate_id, {
    spentCommits: inputs.map((i) => i.commitment_hex),
    ...(sendResult.change_output
      ? {
          change: {
            commit: sendResult.change_output.commitment_hex,
            value: sendResult.change_output.amount,
          },
        }
      : {}),
  });
  // The change index was already reserved atomically at step 3b: do NOT bump
  // again here or it would double-advance and skip an index.

  // 5. Deliver over the unified channel seam. Encrypt the S1 to the recipient's
  //    slatepack address when known; else armor plain (gift-wrap / manual still
  //    interoperable). NO backend bookkeeping: the overlay is recorded at
  //    broadcast (processGrinS2).
  const hasRecipientAddr = !!(
    args.recipientSlatepackAddress && args.recipientSlatepackAddress.trim()
  );
  const armored = armorSlate(
    sendResult.slate_json,
    args.senderSlatepackAddress,
    // Nostr sends armor plain (the gift-wrap provides confidentiality + routing).
    args.recipientPubkeyHex ? undefined : hasRecipientAddr ? args.recipientSlatepackAddress : undefined,
  );

  let relay_id: string | undefined;
  const recipient = {
    ...(args.recipientPubkeyHex ? { pubkeyHex: args.recipientPubkeyHex } : {}),
    ...(args.recipientUserId ? { userId: args.recipientUserId } : {}),
  };
  if (recipient.pubkeyHex || recipient.userId) {
    const channel = selectSendChannel(recipient, args.channels);
    await channel.deliver({
      slateId: sendResult.slate_id,
      slatepack: armored,
      amountNanogrin: args.amount,
      ...(recipient.pubkeyHex ? { recipientPubkeyHex: recipient.pubkeyHex } : {}),
      ...(recipient.userId ? { recipientUserId: recipient.userId } : {}),
    });
    relay_id = encodeCounterparty(channel.kind, recipient.pubkeyHex ?? recipient.userId!);
  }

  // Best-effort tx-journal (display-only history; NEVER gates money). Record the
  // send as pending at build time; processGrinS2 upgrades it to finalized +
  // kernelExcess after broadcast. A failure here must never break the send.
  void recordGrinTx({
    slateId: sendResult.slate_id,
    direction: 'send',
    amountNanogrin: args.amount,
    fee,
    ...(args.recipientUserId ?? args.recipientSlatepackAddress ?? args.recipientPubkeyHex
      ? {
          counterparty:
            args.recipientUserId ??
            args.recipientSlatepackAddress ??
            args.recipientPubkeyHex,
        }
      : {}),
    status: 'pending',
    createdAt: Date.now(),
  }).catch(() => undefined);

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
  /** Slate id: Grin's analog of a txid for wallet bookkeeping. */
  slate_id: string;
  /** On-chain kernel commitment: what block explorers index. */
  kernel_excess_hex: string;
}

/**
 * Receiver returned S2; finalize, broadcast, and record the pending overlay.
 *
 * `s2` is either an armored slatepack (clipboard/relay) or raw slate JSON.
 */
export async function processGrinS2(args: {
  /** Sender's mnemonic: derives the slatepack secret for decrypting an
   *  S2 the receiver encrypted to us. */
  mnemonic: string;
  s2: string;
  sender_context_json: string;
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
  /** Opaque counterparty ref from startGrinSend, used to settle on its channel. */
  relay_id?: string;
  channels: SlatepackChannels;
  overlay: GrinPendingOverlay;
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

  // Broadcast the tx_json via the backend (reads only { tx }). Grin's
  // /v2/foreign push_transaction expects a JSON Transaction object, NOT the
  // binary wire-format hex; tx_json matches grin_core's Transaction serde shape.
  const slateId = JSON.parse(finalize.slate_json).id as string;
  const broadcastRes = await chainProviders.grin().broadcast({
    tx: finalize.tx_json as object,
  });
  // CRITICAL: bail on broadcast failure so we never record a pending overlay
  // entry (excluding inputs) for a tx that never hit the chain.
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error}`);
  }

  // Mark the reserved overlay entry (created at startGrinSend) as broadcast:
  // exclude the spent inputs until they leave the UTXO set, show the change as
  // pending until scanned, and re-anchor broadcastAt to the real broadcast time
  // (the TTL age-out clock). The child index was ALREADY advanced at build time
  // (startGrinSend): do NOT bump again here or it would double-advance and skip
  // an index.
  await args.overlay.addPending(slateId, {
    broadcast: true,
    spentCommits: args.sender_inputs.map((i) => i.commitment_hex),
    ...(args.change_output
      ? { change: { commit: args.change_output.commitment_hex, value: args.change_output.amount } }
      : {}),
  });

  // Best-effort tx-journal: upgrade the build-time `pending` row (if the send
  // build journalled one) to `finalized` + its on-chain kernel excess. amount 0
  // preserves whatever the build recorded (see recordGrinTx merge semantics).
  void recordGrinTx({
    slateId,
    direction: 'send',
    amountNanogrin: 0,
    status: 'finalized',
    kernelExcess: finalize.kernel_excess_hex,
    createdAt: Date.now(),
  }).catch(() => undefined);

  // Settle the exchange on its channel (S3 notice / relay finalize). Best-effort:
  // never undo an on-chain broadcast.
  if (args.relay_id) {
    const cp = decodeCounterparty(args.relay_id);
    if (cp) {
      const channel = cp.kind === 'nostr' ? args.channels.nostr : args.channels.backend;
      // Pass the finalized kernel excess as the tx reference: the backend relay's
      // relay/finalize rejects an empty tx_hash (400), so an empty string here
      // silently failed every same-instance Grin settle. The Nostr channel ignores it.
      await channel.settle(slateId, cp.ref, finalize.kernel_excess_hex).catch(() => undefined);
    }
  }

  return { slate_id: slateId, kernel_excess_hex: finalize.kernel_excess_hex };
}

export async function cancelGrinSend(args: {
  slate_id: string;
  /** Opaque counterparty ref from startGrinSend, if the send was delivered. */
  relay_id?: string;
  channels: SlatepackChannels;
  overlay: GrinPendingOverlay;
}): Promise<void> {
  // Guard: once the tx has broadcast, its inputs are genuinely spent in-flight;
  // freeing them here would let a later send re-select them and build a
  // double-spend (node reject at best, fund confusion at worst). Only a send
  // that's still pre-broadcast (a build-time reservation that never went out)
  // frees its inputs on cancel; a broadcast tx retires scan-driven (reconcile)
  // instead, and there is nothing legitimate to cancel on the wire.
  //
  // FAIL SAFE: if we can't even read the overlay, ASSUME broadcast and do NOT
  // free: a spurious free (double-spend risk) is far worse than leaving a
  // pre-broadcast reservation to age out via the 7-day backstop. (overlay.remove
  // carries its own pre-broadcast guard as defense-in-depth, but we must not even
  // attempt the wire-cancel of a possibly-broadcast tx on an unknown state.)
  const pending = await args.overlay.load().catch(() => null);
  if (pending === null || pending.entries[args.slate_id]?.broadcast) return;
  // Best-effort tx-journal: mark the row cancelled (display-only; runs only on a
  // genuine pre-broadcast cancel, never for a broadcast tx).
  void updateGrinTxStatus(args.slate_id, 'cancelled').catch(() => undefined);
  // Free the reserved inputs immediately (they become selectable again).
  // remove() re-checks the broadcast flag, so this can only free a pre-broadcast
  // reservation.
  await args.overlay.remove(args.slate_id).catch(() => undefined);
  // Notify the counterparty over the exact channel the send used.
  if (args.relay_id) {
    const cp = decodeCounterparty(args.relay_id);
    if (cp) {
      const channel = cp.kind === 'nostr' ? args.channels.nostr : args.channels.backend;
      await channel.cancel(args.slate_id, cp.ref).catch(() => undefined);
    }
  }
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
  mnemonic: string;
  receiverSlatepackAddress: string;
  amount: number;
  /** Receiver picks the fee in the invoice; sender accepts or rejects. */
  fee: number;
  resolver: GrinSendInputResolver;
  overlay: GrinPendingOverlay;
}): Promise<GrinInvoiceInitResult> {
  const extKey = JSON.parse(wasmGrin.deriveExtendedKey(args.mnemonic)) as {
    extended_private_key_hex: string;
  };
  await args.resolver.fetchSpendable();

  // ATOMICALLY reserve the receiver's output index so it can never be reused
  // (reuse = duplicate commitment = fund loss), even if this invoice is
  // abandoned. Reserving in one persisted step (rather than read-now / bump-later)
  // closes the race where a concurrent mint flow reads the same index. But do NOT
  // record the incoming value as pending here: WE created this invoice and nobody
  // has committed to pay it yet, so counting it would inflate the headline pending
  // balance on speculation. The incoming only becomes genuinely in-flight once the
  // payer returns I2 and we finalize + broadcast (processGrinI2).
  const outputIndex = await args.overlay.reserveNextChildIndex();

  const invoice: GrinCreateInvoiceResult = wasmGrin.createInvoice({
    extended_private_key_hex: extKey.extended_private_key_hex,
    amount: args.amount,
    fee: args.fee,
    kernel_kind: 'plain',
    output_path: childIndexToPath(outputIndex),
    kernel_offset_hex: wasmGrin.randomSecretNonce(),
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
  mnemonic: string;
  payerSlatepackAddress: string;
  i1Armored: string;
  resolver: GrinSendInputResolver;
  overlay: GrinPendingOverlay;
}): Promise<GrinInvoiceSignedResult> {
  const secretKeyHex = wasmGrin.slatepackAddressSecret(args.mnemonic, 0);
  // Pull the invoice originator's address out of the envelope so we can encrypt
  // I2 back to them.
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
  const inputs: GrinUnspentOutput[] = selected;

  // ATOMICALLY reserve the change index BEFORE the build (the builder needs the
  // change_path up front). Reserving in one step closes the race where a
  // concurrent mint flow reads the same index → duplicate commitment → fund loss.
  // A no-change invoice payment simply skips the reserved index (harmless).
  const changeIndex = await args.overlay.reserveNextChildIndex();

  const signed: GrinSignInvoiceResult = wasmGrin.signInvoice({
    extended_private_key_hex: extKey.extended_private_key_hex,
    legacy_extended_private_key_hex: legacyExtKeyHex,
    i1_slate_json,
    inputs,
    change_path: childIndexToPath(changeIndex),
    sender_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  console.debug('[grin-pay-invoice] input derivations:', signed.input_derivations);

  // Record the pending overlay at the payer's side: exclude the spent inputs +
  // show the change as pending until the receiver broadcasts and scan reflects
  // it. The change index was already reserved atomically above: do NOT bump here.
  await args.overlay.addPending(parsed.id, {
    spentCommits: inputs.map((i) => i.commitment_hex),
    ...(signed.change_output
      ? { change: { commit: signed.change_output.commitment_hex, value: signed.change_output.amount } }
      : {}),
  });

  return {
    slate_id: parsed.id,
    // Encrypt I2 back to whoever sent us I1 (invoice originator); plaintext
    // fallback when the envelope carried no sender.
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
 * Sender's inputs are extracted from the I2 slate's `coms` list: entries
 * without a rangeproof `p` are input refs (vs outputs which carry a proof).
 * The Rust finalize uses commitment + features only, so path + amount are
 * dummy on the receiver side. The receiver's incoming output's child index was
 * already reserved at {@link startGrinInvoice}; here, after a SUCCESSFUL
 * broadcast, we also record the `incoming` pending entry so the received value
 * shows in the pending balance until the next scan confirms it (symmetric with
 * {@link signIncomingGrinSlate}). The output commitment + amount come from the
 * receiver context we created at invoice time.
 */
export async function processGrinI2(args: {
  /** Receiver's mnemonic: derives the slatepack secret for
   *  decrypting an I2 the payer encrypted to us. */
  mnemonic: string;
  i2: string;
  receiver_context_json: string;
  /** Client pending overlay: records the incoming after broadcast. */
  overlay: GrinPendingOverlay;
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
  const slateId = JSON.parse(finalize.slate_json).id as string;
  const broadcastRes = await chainProviders.grin().broadcast({
    tx: finalize.tx_json as object,
  });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error}`);
  }

  // Broadcast succeeded: record our incoming output as pending so the received
  // value is visible in the balance until the next scan (~1 block) confirms it,
  // symmetric with signIncomingGrinSlate. The receiver context (created at
  // startGrinInvoice) carries our output's commitment + amount as JSON (see the
  // Rust `ReceiverContext` serde: `commitment` hex + `amount`). Best-effort: an
  // unparsable/absent context must never undo an on-chain broadcast.
  try {
    const ctx = JSON.parse(args.receiver_context_json) as {
      commitment?: string;
      amount?: number;
    };
    if (ctx.commitment && typeof ctx.amount === 'number') {
      // Flag broadcast: WE just put this tx on-chain (unlike signIncomingGrinSlate,
      // where the SENDER broadcasts). This keeps the invoice wizard's onCancel →
      // remove() from wiping a legitimately in-flight incoming before scan confirms.
      await args.overlay.addPending(slateId, {
        incoming: { commit: ctx.commitment, value: ctx.amount },
        broadcast: true,
      });
      // Best-effort tx-journal: our invoice was paid, record a finalized
      // receive with its on-chain kernel excess (display-only).
      void recordGrinTx({
        slateId,
        direction: 'receive',
        amountNanogrin: ctx.amount,
        status: 'finalized',
        kernelExcess: finalize.kernel_excess_hex,
        createdAt: Date.now(),
      }).catch(() => undefined);
    }
  } catch {
    // Non-fatal: the next scan still surfaces the confirmed output.
  }

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
 * External wallet handed us an S1 slatepack. Sign as S2 and emit the result.
 * The sender finalizes + broadcasts; we reserve our incoming output's child
 * index and show it as pending until scan confirms it on chain.
 */
export async function signIncomingGrinSlate(args: {
  mnemonic: string;
  receiverSlatepackAddress: string;
  s1Armored: string;
  resolver: GrinSendInputResolver;
  overlay: GrinPendingOverlay;
}): Promise<GrinSignS1Result> {
  // Sanity-check that the current mnemonic actually derives the slatepack
  // address the wallet claims: a mismatch means the wallet was recreated since
  // this slatepack was sent (age decrypt would fail with "No matching keys").
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
  await args.resolver.fetchSpendable();

  // ATOMICALLY reserve our incoming output's index before the build (one persisted
  // step, so a concurrent mint flow can't be handed the same index → duplicate
  // commitment → fund loss).
  const outputIndex = await args.overlay.reserveNextChildIndex();

  const signed: GrinSignIncomingSendResult = wasmGrin.signIncomingSendSlate({
    extended_private_key_hex: extKey.extended_private_key_hex,
    s1_slate_json,
    output_path: childIndexToPath(outputIndex),
    receiver_kernel_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_rewind_nonce_hex: wasmGrin.randomSecretNonce(),
    bp_private_nonce_hex: wasmGrin.randomSecretNonce(),
  });

  // Show our incoming output as pending until the sender broadcasts and scan
  // reflects it. The index was already reserved atomically above.
  const amount = Number(parsed.amt);
  await args.overlay.addPending(parsed.id, {
    incoming: { commit: signed.output.commitment_hex, value: signed.output.amount },
  });

  // Best-effort tx-journal: we signed an incoming send as S2, record it as a
  // pending receive (the sender broadcasts; scan later confirms the amount).
  void recordGrinTx({
    slateId: parsed.id,
    direction: 'receive',
    amountNanogrin: amount,
    ...(s1Sender ? { counterparty: s1Sender } : {}),
    status: 'pending',
    createdAt: Date.now(),
  }).catch(() => undefined);

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
// Helpers: path packing
// ============================================================================

function childIndexToPath(nChild: number): [number, number, number, number] {
  return [0, 0, nChild, 0];
}

function looksArmored(s: string): boolean {
  return s.trimStart().startsWith('BEGINSLATEPACK');
}

// ============================================================================
// Pending overlay store adapter (chrome.storage.local)
// ============================================================================

const GRIN_PENDING_STORAGE_KEY = 'grin_pending_v1';

/**
 * A {@link GrinPendingStore} backed by `chrome.storage.local`. Keeps
 * `@smirk/core` platform-agnostic (no `chrome.*` there); the extension wires
 * this adapter and injects the resulting {@link GrinPendingOverlay}.
 */
export function createChromeGrinPendingStore(): GrinPendingStore {
  const empty = (): GrinPending => ({ entries: {}, nextChildIndex: 0 });
  return {
    // Report the storage key so EVERY overlay over this same chrome slot shares
    // one process-global serialization lock (see GrinPendingStore.key), even a
    // code path that constructs its own overlay instead of importing the shared
    // `grinOverlay` singleton below. Belt-and-suspenders with the singleton.
    key: GRIN_PENDING_STORAGE_KEY,
    async load(): Promise<GrinPending> {
      try {
        const got = await chrome.storage.local.get(GRIN_PENDING_STORAGE_KEY);
        const raw = got[GRIN_PENDING_STORAGE_KEY];
        if (raw && typeof raw === 'object' && 'entries' in raw) {
          return raw as GrinPending;
        }
        return empty();
      } catch {
        return empty();
      }
    },
    async save(p: GrinPending): Promise<void> {
      await chrome.storage.local.set({ [GRIN_PENDING_STORAGE_KEY]: p });
    },
  };
}

/**
 * THE single shared client-only Grin pending overlay (v3 is non-custodial: no
 * server output store). Backed by the one `chrome.storage.local` slot, so every
 * money-critical flow (the always-on ~30s balance reconcile, send/receive/
 * invoice child-index reservation, and the voucher tip/claim + inbox handlers)
 * MUST route through this instance rather than constructing its own.
 *
 * The overlay's serialization lock is now process-global per storage key (see
 * `GrinPendingStore.key`), so even a stray `new GrinPendingOverlay(...)` over the
 * same slot would still serialize; sharing this singleton is the primary guard
 * and the global lock is the belt-and-suspenders backstop. Import THIS: do not
 * build a fresh overlay.
 */
export const grinOverlay = new GrinPendingOverlay(createChromeGrinPendingStore());
