/**
 * @smirk/wasm — TypeScript bindings for the smirk-wasm WASM crypto bundle.
 *
 * This package re-exports every function from the wasm-bindgen output of
 * `crates/smirk-wasm`, organized into namespaces by chain. The underlying
 * WASM bundle is built by `make wasm` (or `make wasm-node` for the
 * Node-target variant); this package depends on the browser-target build
 * at `crates/smirk-wasm/pkg/`.
 *
 * Consumers must call {@link initialize} once before using any of the
 * exported functions. In a browser, no arguments are needed:
 *
 * ```ts
 * import { initialize, grin } from '@smirk/wasm';
 * await initialize();
 * const addr = grin.slatepackAddress(mnemonic, 0, 'mainnet');
 * ```
 *
 * In a non-browser environment (Node, Deno, mobile WebView with restricted
 * fetch), pass the WASM bytes explicitly:
 *
 * ```ts
 * import { initialize, grin } from '@smirk/wasm';
 * import wasmBytes from '@smirk/wasm/pkg/smirk_wasm_bg.wasm';
 * await initialize(wasmBytes);
 * ```
 */

// `--target no-modules` output: an IIFE that binds `wasm_bindgen` at the
// top level. The build script (Makefile + crates/smirk-wasm/build.sh)
// appends `export { wasm_bindgen };` so we can import it as ESM. Calling
// `wasm_bindgen({ module_or_path })` loads/instantiates the WASM and
// attaches every exported function to the `wasm_bindgen` function object.
// We use `wasm_bindgen` itself as our `wasm.*` lookup target.
// @ts-expect-error — generated file has no type declarations for the
//                    no-modules export shim. The .d.ts only documents the
//                    `--target web` shape.
import { wasm_bindgen } from '../../../crates/smirk-wasm/pkg/smirk_wasm.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wasm = wasm_bindgen as any;

let initialized = false;

/**
 * Initialize the WASM bundle. Must be called once before any other
 * function in this package. Idempotent — subsequent calls are no-ops.
 *
 * @param moduleOrPath Optional pre-fetched WASM bytes or URL. In browsers
 *   the no-modules glue auto-derives the .wasm URL from the script src;
 *   pass explicit bytes when running in a service worker or other env
 *   without `document.currentScript`.
 */
export async function initialize(
  moduleOrPath?: BufferSource | URL | string,
): Promise<void> {
  if (initialized) return;
  await wasm_bindgen(moduleOrPath ? { module_or_path: moduleOrPath } : undefined);
  initialized = true;
}

// =============================================================================
// Generic
// =============================================================================

/** Sanity check — returns "smirk-wasm ready" if the bundle is loaded. */
export const test = (): string => wasm.test();

/** Bundle version + build tag (e.g. `"0.1.0-wow25"`). */
export const version = (): string => wasm.version();

/** grin-ext crate version. Useful for runtime sanity-check assertions. */
export const grinExtVersion = (): string => wasm.grin_ext_version();

// =============================================================================
// Monero / Wownero
// =============================================================================

export const monero = {
  validateAddress: (address: string): string => wasm.validate_address(address),
  parseTx: (hexData: string): string => wasm.parse_tx(hexData),
  estimateFee: (
    numInputs: number,
    numOutputs: number,
    feePerByte: bigint,
    feeMask: bigint,
  ): string => wasm.estimate_fee(numInputs, numOutputs, feePerByte, feeMask),
  signTransaction: (paramsJson: string): string => wasm.sign_transaction(paramsJson),
  deriveKeyImage: (
    outputPublicKeyHex: string,
    spendKeyHex: string,
    keyOffsetHex: string,
  ): string => wasm.derive_key_image(outputPublicKeyHex, spendKeyHex, keyOffsetHex),
  deriveOutputKeyImage: (
    viewKey: string,
    spendKey: string,
    txPubKey: string,
    outputIndex: number,
    outputKey: string,
  ): string =>
    wasm.derive_output_key_image(viewKey, spendKey, txPubKey, outputIndex, outputKey),
  computeKeyImage: (
    viewKey: string,
    spendKey: string,
    txPubKey: string,
    outputIndex: number,
  ): string => wasm.compute_key_image(viewKey, spendKey, txPubKey, outputIndex),
};

// =============================================================================
// Grin
// =============================================================================

export type GrinNetwork = 'mainnet' | 'testnet';
export type GrinKernelKind = 'plain' | 'coinbase' | 'height_locked' | 'nrd';

export const grin = {
  // ---- Seed / keys / addresses
  deriveExtendedKey: (mnemonic: string): string => wasm.grin_derive_extended_key(mnemonic),
  secp256k1PublicKey: (secretKeyHex: string): string =>
    wasm.grin_secp256k1_public_key(secretKeyHex),
  slatepackAddress: (mnemonic: string, index: number, network: GrinNetwork): string =>
    wasm.grin_slatepack_address(mnemonic, index, network),
  slatepackAddressSecret: (mnemonic: string, index: number): string =>
    wasm.grin_slatepack_address_secret(mnemonic, index),
  /** Decode a bech32 slatepack address back to its 32-byte ed25519
   *  public key (hex). Used to encrypt outgoing slatepacks to a
   *  recipient via `slatepackPackEncrypted`. */
  slatepackAddressToPubkeyHex: (address: string): string =>
    wasm.grin_slatepack_address_to_pubkey_hex(address),
  deriveKeys: (mnemonic: string, network: GrinNetwork): string =>
    wasm.grin_derive_keys(mnemonic, network),

  // ---- Schnorr
  schnorrSign: (secretKeyHex: string, secretNonceHex: string, messageHex: string): string =>
    wasm.grin_schnorr_sign(secretKeyHex, secretNonceHex, messageHex),
  schnorrVerify: (signatureHex: string, messageHex: string, publicKeyHex: string): boolean =>
    wasm.grin_schnorr_verify(signatureHex, messageHex, publicKeyHex),

  // ---- Multi-party Schnorr
  pointAdd: (aHex: string, bHex: string): string => wasm.grin_point_add(aHex, bHex),
  pointSum: (pointsConcatHex: string): string => wasm.grin_point_sum(pointsConcatHex),
  schnorrPartialSign: (
    secretKeyHex: string,
    secretNonceHex: string,
    publicNonceTotalHex: string,
    publicKeyTotalHex: string,
    messageHex: string,
  ): string =>
    wasm.grin_schnorr_partial_sign(
      secretKeyHex,
      secretNonceHex,
      publicNonceTotalHex,
      publicKeyTotalHex,
      messageHex,
    ),
  schnorrPartialVerify: (
    partialSHex: string,
    publicNonceIHex: string,
    publicKeyIHex: string,
    publicNonceTotalHex: string,
    publicKeyTotalHex: string,
    messageHex: string,
  ): boolean =>
    wasm.grin_schnorr_partial_verify(
      partialSHex,
      publicNonceIHex,
      publicKeyIHex,
      publicNonceTotalHex,
      publicKeyTotalHex,
      messageHex,
    ),
  schnorrAggregatePartials: (partialsConcatHex: string): string =>
    wasm.grin_schnorr_aggregate_partials(partialsConcatHex),
  schnorrFinalSignature: (publicNonceTotalHex: string, aggregateSHex: string): string =>
    wasm.grin_schnorr_final_signature(publicNonceTotalHex, aggregateSHex),

  // ---- Adaptor signatures (atomic-swap building block)
  adaptorPartialSign: (
    secretKeyHex: string,
    secretNonceHex: string,
    publicNonceTotalNoTHex: string,
    publicKeyTotalHex: string,
    adaptorPointTHex: string,
    messageHex: string,
  ): string =>
    wasm.grin_adaptor_partial_sign(
      secretKeyHex,
      secretNonceHex,
      publicNonceTotalNoTHex,
      publicKeyTotalHex,
      adaptorPointTHex,
      messageHex,
    ),
  adaptorPartialVerify: (
    adaptorPartialSHex: string,
    publicNonceIHex: string,
    publicKeyIHex: string,
    publicNonceTotalNoTHex: string,
    publicKeyTotalHex: string,
    adaptorPointTHex: string,
    messageHex: string,
  ): boolean =>
    wasm.grin_adaptor_partial_verify(
      adaptorPartialSHex,
      publicNonceIHex,
      publicKeyIHex,
      publicNonceTotalNoTHex,
      publicKeyTotalHex,
      adaptorPointTHex,
      messageHex,
    ),
  adaptorComplete: (adaptorPartialSHex: string, adaptorSecretTHex: string): string =>
    wasm.grin_adaptor_complete(adaptorPartialSHex, adaptorSecretTHex),
  adaptorExtractSecret: (
    completedPartialSHex: string,
    adaptorPartialSHex: string,
  ): string =>
    wasm.grin_adaptor_extract_secret(completedPartialSHex, adaptorPartialSHex),

  // ---- Slate v4
  slateRoundTrip: (slateJson: string): string => wasm.grin_slate_round_trip(slateJson),
  slateSummary: (slateJson: string): string => wasm.grin_slate_summary(slateJson),

  // ---- Slate construction
  blindAdd: (aHex: string, bHex: string): string => wasm.grin_blind_add(aHex, bHex),
  blindSub: (aHex: string, bHex: string): string => wasm.grin_blind_sub(aHex, bHex),
  blindSum: (scalarsConcatHex: string): string => wasm.grin_blind_sum(scalarsConcatHex),
  senderBlindExcess: (
    inputBlindsConcatHex: string,
    senderOutputBlindsConcatHex: string,
    kernelOffsetHex: string,
  ): string =>
    wasm.grin_sender_blind_excess(
      inputBlindsConcatHex,
      senderOutputBlindsConcatHex,
      kernelOffsetHex,
    ),
  senderInitS1: (
    slateId: string,
    amount: bigint,
    fee: bigint,
    kernelKind: GrinKernelKind,
    lockHeight: bigint | null,
    relativeHeight: number | null,
    senderBlindExcessHex: string,
    kernelOffsetHex: string,
    kernelNonceHex: string,
  ): string =>
    wasm.grin_sender_init_s1(
      slateId,
      amount,
      fee,
      kernelKind,
      lockHeight,
      relativeHeight,
      senderBlindExcessHex,
      kernelOffsetHex,
      kernelNonceHex,
    ),
  receiverRoundS2: (
    s1SlateJson: string,
    receiverOutputBlindHex: string,
    receiverKernelNonceHex: string,
    bpRewindNonceHex: string,
    bpPrivateNonceHex: string,
  ): string =>
    wasm.grin_receiver_round_s2(
      s1SlateJson,
      receiverOutputBlindHex,
      receiverKernelNonceHex,
      bpRewindNonceHex,
      bpPrivateNonceHex,
    ),
  senderFinalizeS3: (
    s2SlateJson: string,
    contextSlateId: string,
    contextAmount: bigint,
    contextFee: bigint,
    contextKernelKind: GrinKernelKind,
    contextLockHeight: bigint | null,
    contextRelativeHeight: number | null,
    contextSenderBlindExcessHex: string,
    contextKernelOffsetHex: string,
    contextKernelNonceHex: string,
  ): string =>
    wasm.grin_sender_finalize_s3(
      s2SlateJson,
      contextSlateId,
      contextAmount,
      contextFee,
      contextKernelKind,
      contextLockHeight,
      contextRelativeHeight,
      contextSenderBlindExcessHex,
      contextKernelOffsetHex,
      contextKernelNonceHex,
    ),
  receiverInitI1: (
    slateId: string,
    amount: bigint,
    fee: bigint,
    kernelKind: GrinKernelKind,
    lockHeight: bigint | null,
    relativeHeight: number | null,
    receiverOutputBlindHex: string,
    receiverKernelNonceHex: string,
    bpRewindNonceHex: string,
    bpPrivateNonceHex: string,
    kernelOffsetHex: string,
  ): string =>
    wasm.grin_receiver_init_i1(
      slateId,
      amount,
      fee,
      kernelKind,
      lockHeight,
      relativeHeight,
      receiverOutputBlindHex,
      receiverKernelNonceHex,
      bpRewindNonceHex,
      bpPrivateNonceHex,
      kernelOffsetHex,
    ),
  senderRoundI2: (
    i1SlateJson: string,
    senderBlindExcessHex: string,
    senderKernelNonceHex: string,
  ): string =>
    wasm.grin_sender_round_i2(i1SlateJson, senderBlindExcessHex, senderKernelNonceHex),
  receiverFinalizeI3: (
    i2SlateJson: string,
    contextSlateId: string,
    contextAmount: bigint,
    contextOutputBlindHex: string,
    contextKernelNonceHex: string,
    contextCommitmentHex: string,
    contextRewindNonceHex: string,
  ): string =>
    wasm.grin_receiver_finalize_i3(
      i2SlateJson,
      contextSlateId,
      contextAmount,
      contextOutputBlindHex,
      contextKernelNonceHex,
      contextCommitmentHex,
      contextRewindNonceHex,
    ),

  // ---- Kernels
  kernelSigMsg: (
    kind: GrinKernelKind,
    fee: bigint | null,
    lockHeight: bigint | null,
    relativeHeight: number | null,
  ): string => wasm.grin_kernel_sig_msg(kind, fee, lockHeight, relativeHeight),
  kernelFeaturesBytes: (
    kind: GrinKernelKind,
    fee: bigint | null,
    lockHeight: bigint | null,
    relativeHeight: number | null,
  ): string => wasm.grin_kernel_features_bytes(kind, fee, lockHeight, relativeHeight),

  // ---- Pedersen + Bulletproofs
  pedersenCommit: (value: bigint, blindingFactorHex: string): string =>
    wasm.grin_pedersen_commit(value, blindingFactorHex),
  bulletProofCreate: (
    value: bigint,
    blindingFactorHex: string,
    rewindNonceHex: string,
    privateNonceHex: string,
  ): string =>
    wasm.grin_bullet_proof_create(value, blindingFactorHex, rewindNonceHex, privateNonceHex),
  bulletProofVerify: (commitHex: string, proofHex: string): boolean =>
    wasm.grin_bullet_proof_verify(commitHex, proofHex),
  bulletProofRewind: (
    commitHex: string,
    rewindNonceHex: string,
    proofHex: string,
  ): string => wasm.grin_bullet_proof_rewind(commitHex, rewindNonceHex, proofHex),

  // ---- Slatepack codec
  slatepackArmor: (payloadHex: string): string => wasm.grin_slatepack_armor(payloadHex),
  slatepackDearmor: (armored: string): string => wasm.grin_slatepack_dearmor(armored),
  slatepackBinEncodePlain: (innerPayloadHex: string, sender: string | null): string =>
    wasm.grin_slatepack_bin_encode_plain(innerPayloadHex, sender ?? undefined),
  slatepackBinDecode: (binHex: string): string => wasm.grin_slatepack_bin_decode(binHex),
  slatepackPackPlain: (innerPayloadHex: string, sender: string | null): string =>
    wasm.grin_slatepack_pack_plain(innerPayloadHex, sender ?? undefined),
  slatepackUnpack: (armored: string): string => wasm.grin_slatepack_unpack(armored),
  slatepackEncrypt: (payloadHex: string, recipientPubkeyHex: string): string =>
    wasm.grin_slatepack_encrypt(payloadHex, recipientPubkeyHex),
  slatepackDecrypt: (encryptedPayloadHex: string, secretKeyHex: string): string =>
    wasm.grin_slatepack_decrypt(encryptedPayloadHex, secretKeyHex),
  slatepackPackEncrypted: (
    innerPayloadHex: string,
    sender: string | null,
    recipientPubkeyHex: string,
  ): string =>
    wasm.grin_slatepack_pack_encrypted(
      innerPayloadHex,
      sender ?? undefined,
      recipientPubkeyHex,
    ),
  slatepackUnpackWithSecret: (armored: string, secretKeyHex: string): string =>
    wasm.grin_slatepack_unpack_with_secret(armored, secretKeyHex),

  // ---- Transaction assembly + payment proofs
  pubkeyToCommitment: (pubkeyHex: string): string =>
    wasm.grin_pubkey_to_commitment(pubkeyHex),
  slateToTransactionBytes: (
    s3SlateJson: string,
    senderInputsConcatHex: string,
    senderChangeOutputsJson: string,
    aggregatedKernelSignatureHex: string,
  ): string =>
    wasm.grin_slate_to_transaction_bytes(
      s3SlateJson,
      senderInputsConcatHex,
      senderChangeOutputsJson,
      aggregatedKernelSignatureHex,
    ),
  signPaymentProof: (
    amount: bigint,
    kernelCommitmentHex: string,
    senderAddressHex: string,
    receiverSecretHex: string,
  ): string =>
    wasm.grin_sign_payment_proof(
      amount,
      kernelCommitmentHex,
      senderAddressHex,
      receiverSecretHex,
    ),
  verifyPaymentProof: (
    amount: bigint,
    kernelCommitmentHex: string,
    senderAddressHex: string,
    receiverAddressHex: string,
    signatureHex: string,
  ): boolean =>
    wasm.grin_verify_payment_proof(
      amount,
      kernelCommitmentHex,
      senderAddressHex,
      receiverAddressHex,
      signatureHex,
    ),

  // ---- High-level wallet orchestrators (Phase 1 → Phase 2)
  //
  // These wrap the 6 send/invoice ceremonies. Each takes a typed
  // params struct, marshals to JSON for the wasm call, and parses
  // the JSON result into a typed return. The wasm shim is the API
  // boundary — see crates/smirk-wasm/src/grin/wallet_flows.rs for the
  // canonical DTO shapes.

  randomSecretNonce: (): string => wasm.grin_random_secret_nonce(),

  slateV4ToBinHex: (slateJson: string): string =>
    wasm.grin_slate_v4_to_bin_hex(slateJson),
  slateV4FromBinHex: (binHex: string): string =>
    wasm.grin_slate_v4_from_bin_hex(binHex),

  createSendTransaction: (params: GrinCreateSendTxParams): GrinCreateSendTxResult => {
    const json = wasm.grin_create_send_transaction(JSON.stringify(params));
    return JSON.parse(json) as GrinCreateSendTxResult;
  },
  signIncomingSendSlate: (
    params: GrinSignIncomingSendParams,
  ): GrinSignIncomingSendResult => {
    const json = wasm.grin_sign_incoming_send_slate(JSON.stringify(params));
    return JSON.parse(json) as GrinSignIncomingSendResult;
  },
  finalizeSendSlate: (params: GrinFinalizeSendParams): GrinFinalizeSendResult => {
    const json = wasm.grin_finalize_send_slate(JSON.stringify(params));
    return JSON.parse(json) as GrinFinalizeSendResult;
  },
  createInvoice: (params: GrinCreateInvoiceParams): GrinCreateInvoiceResult => {
    const json = wasm.grin_create_invoice(JSON.stringify(params));
    return JSON.parse(json) as GrinCreateInvoiceResult;
  },
  signInvoice: (params: GrinSignInvoiceParams): GrinSignInvoiceResult => {
    const json = wasm.grin_sign_invoice(JSON.stringify(params));
    return JSON.parse(json) as GrinSignInvoiceResult;
  },
  finalizeInvoice: (
    params: GrinFinalizeInvoiceParams,
  ): GrinFinalizeInvoiceResult => {
    const json = wasm.grin_finalize_invoice(JSON.stringify(params));
    return JSON.parse(json) as GrinFinalizeInvoiceResult;
  },
};

// ---- High-level wallet-flow params + results -------------------------------
//
// JSON-shape DTOs that match the Rust serde structs in
// `crates/smirk-wasm/src/grin/wallet_flows.rs::dto`. Strings are
// snake_case where the Rust side expects snake_case; otherwise camelCase.
// Byte arrays are always lowercase hex.

/** Pair of (4-level BIP32 path, amount) describing a wallet UTXO. */
export interface GrinUnspentOutput {
  /** BIP32 path that derives the output's blinding factor. */
  path: [number, number, number, number];
  amount: number;
  /** 33-byte Pedersen commitment, lowercase hex (66 chars). */
  commitment_hex: string;
  /** Defaults to false; set true for coinbase outputs. */
  is_coinbase?: boolean;
}

/** Change output the wallet just produced; persist for later spending. */
export interface GrinChangeOutputInfo {
  path: [number, number, number, number];
  amount: number;
  commitment_hex: string;
  proof_hex: string;
}

/** Receiver's new output created at I1 or S2. Persist for later spending. */
export interface GrinReceiverOutputInfo {
  path: [number, number, number, number];
  amount: number;
  commitment_hex: string;
  proof_hex: string;
}

export interface GrinCreateSendTxParams {
  extended_private_key_hex: string;
  inputs: GrinUnspentOutput[];
  amount: number;
  fee: number;
  kernel_kind: GrinKernelKind;
  lock_height?: number;
  relative_height?: number;
  change_path: [number, number, number, number];
  kernel_offset_hex: string;
  kernel_nonce_hex: string;
  bp_rewind_nonce_hex: string;
  bp_private_nonce_hex: string;
  /** Optional pre-chosen UUID; omitted → wasm picks one. */
  slate_id?: string;
}

export interface GrinCreateSendTxResult {
  /** Slate v4 JSON; canonical wire form for the relay path. */
  slate_json: string;
  /** Compact binary form (external slatepacks), hex. */
  slate_bin_hex: string;
  slate_id: string;
  /** Opaque JSON. Persist; pass back to `finalize_send_slate`. */
  sender_context_json: string;
  change_output?: GrinChangeOutputInfo;
}

export interface GrinSignIncomingSendParams {
  extended_private_key_hex: string;
  /** S1 slate as JSON (callers can derive from compact-binary via
   *  `slateV4FromBinHex`). */
  s1_slate_json: string;
  output_path: [number, number, number, number];
  receiver_kernel_nonce_hex: string;
  bp_rewind_nonce_hex: string;
  bp_private_nonce_hex: string;
}

export interface GrinSignIncomingSendResult {
  slate_json: string;
  slate_bin_hex: string;
  output: GrinReceiverOutputInfo;
  /** Kernel-excess 33-byte commitment, hex. Persist on receive row
   *  so confirmed kernels can be correlated back. */
  kernel_excess_hex: string;
  receiver_context_json: string;
}

export interface GrinFinalizeSendParams {
  s2_slate_json: string;
  sender_context_json: string;
  sender_inputs: GrinUnspentOutput[];
  change_output?: GrinChangeOutputInfo;
}

export interface GrinFinalizeSendResult {
  slate_json: string;
  final_signature_hex: string;
  kernel_excess_hex: string;
  /** Broadcastable transaction bytes, hex — POST to backend
   *  `/wallet/grin/broadcast`. */
  tx_bytes_hex: string;
}

export interface GrinCreateInvoiceParams {
  extended_private_key_hex: string;
  amount: number;
  fee: number;
  kernel_kind: GrinKernelKind;
  lock_height?: number;
  relative_height?: number;
  output_path: [number, number, number, number];
  kernel_offset_hex: string;
  receiver_kernel_nonce_hex: string;
  bp_rewind_nonce_hex: string;
  bp_private_nonce_hex: string;
  slate_id?: string;
}

export interface GrinCreateInvoiceResult {
  slate_json: string;
  slate_bin_hex: string;
  slate_id: string;
  receiver_context_json: string;
  output: GrinReceiverOutputInfo;
}

export interface GrinSignInvoiceParams {
  extended_private_key_hex: string;
  i1_slate_json: string;
  inputs: GrinUnspentOutput[];
  change_path: [number, number, number, number];
  sender_kernel_nonce_hex: string;
  bp_rewind_nonce_hex: string;
  bp_private_nonce_hex: string;
}

export interface GrinSignInvoiceResult {
  slate_json: string;
  slate_bin_hex: string;
  sender_context_json: string;
  change_output?: GrinChangeOutputInfo;
}

export interface GrinFinalizeInvoiceParams {
  i2_slate_json: string;
  receiver_context_json: string;
  sender_inputs: GrinUnspentOutput[];
}

export interface GrinFinalizeInvoiceResult {
  slate_json: string;
  final_signature_hex: string;
  kernel_excess_hex: string;
  tx_bytes_hex: string;
}

// =============================================================================
// Bitcoin / Litecoin
// =============================================================================
//
// One namespace covers both chains — they differ only in network params
// (HRP, version bytes), which are passed via the `network` argument.

export type BtcNetwork = 'btc-mainnet' | 'btc-testnet' | 'ltc-mainnet' | 'ltc-testnet';
export type BtcAddressKind = 'p2wpkh' | 'p2tr';

/**
 * Parameters for {@link bitcoin.buildPsbt}. Mirrors `BuildPsbtParamsJson`
 * in `crates/smirk-wasm/src/bitcoin.rs` — keep the shapes in sync.
 */
export interface BtcBuildPsbtParams {
  network: BtcNetwork;
  inputs: Array<{
    /** Hex-encoded prevout txid. */
    txid: string;
    /** Output index in the prevout tx. */
    vout: number;
    /** UTXO value in satoshis. */
    valueSat: number;
    /**
     * BIP32 path from the master xprv to the key that controls this UTXO.
     * e.g. `"m/84'/0'/0'/0/3"` for the 4th receive address on the first
     * BIP84 mainnet account. Used to populate `bip32_derivation` so
     * `signPsbt` can later resolve the right child key.
     */
    masterPath: string;
  }>;
  recipientAddress: string;
  recipientSat: number;
  /** Optional change output. Omit + set `changeSat: 0` to skip. */
  changeAddress?: string;
  changeSat?: number;
  /** BIP39 mnemonic — needed to derive the master xprv at build time. */
  mnemonic: string;
  /** BIP39 passphrase (empty string if unused). */
  passphrase?: string;
}

export const bitcoin = {
  /**
   * Derive a BTC or LTC address from a BIP39 mnemonic + BIP32 path.
   *
   * @example
   * ```ts
   * // Native segwit (BIP84):
   * bitcoin.deriveAddress(mnemonic, '', 'btc-mainnet', "m/84'/0'/0'/0/0", 'p2wpkh')
   * // Taproot (BIP86):
   * bitcoin.deriveAddress(mnemonic, '', 'btc-mainnet', "m/86'/0'/0'/0/0", 'p2tr')
   * // Litecoin segwit:
   * bitcoin.deriveAddress(mnemonic, '', 'ltc-mainnet', "m/84'/2'/0'/0/0", 'p2wpkh')
   * ```
   */
  deriveAddress: (
    mnemonic: string,
    passphrase: string,
    network: BtcNetwork,
    path: string,
    kind: BtcAddressKind,
  ): string => wasm.btc_derive_address(mnemonic, passphrase, network, path, kind),

  /**
   * Sign a base64-encoded PSBT. Walks the per-input `bip32_derivation`
   * map and signs every input whose origin matches `mnemonic` derived at
   * `masterPath`. Inputs that don't match are left untouched.
   *
   * Returns JSON: `{ "psbt": "<base64>", "inputs_total": N, "inputs_signed": M }`.
   */
  signPsbt: (
    mnemonic: string,
    passphrase: string,
    network: BtcNetwork,
    masterPath: string,
    psbtBase64: string,
  ): string => wasm.btc_sign_psbt(mnemonic, passphrase, network, masterPath, psbtBase64),

  /**
   * Build an unsigned base64-encoded PSBT for a single-recipient
   * P2WPKH (BIP84) send. The returned PSBT is ready to feed into
   * {@link signPsbt} (using the same mnemonic). After signing, call
   * {@link extractTx} to get the final transaction hex.
   *
   * Caller's responsibility: UTXO selection, fee math (the difference
   * between `sum(inputs)` and `recipientSat + changeSat` is the fee —
   * we don't validate it here). Dust-limit on the change output is
   * checked (rejects change below 294 sat) but the recipient amount
   * is not.
   *
   * See `docs/SEND_FLOW.md` for the surrounding send-flow design.
   */
  buildPsbt: (params: BtcBuildPsbtParams): string => {
    // Rust side reads JSON; serialize with snake_case keys to match
    // `BuildPsbtParamsJson` field names exactly.
    const body = {
      network: params.network,
      inputs: params.inputs.map((i) => ({
        txid: i.txid,
        vout: i.vout,
        value_sat: i.valueSat,
        master_path: i.masterPath,
      })),
      recipient_address: params.recipientAddress,
      recipient_sat: params.recipientSat,
      ...(params.changeAddress !== undefined ? { change_address: params.changeAddress } : {}),
      ...(params.changeSat !== undefined ? { change_sat: params.changeSat } : {}),
      mnemonic: params.mnemonic,
      ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    };
    return wasm.btc_build_psbt(JSON.stringify(body));
  },

  /**
   * Extract the final network-broadcastable transaction hex from a
   * fully-signed PSBT. After {@link signPsbt} has populated every
   * input's witness, call this to get the hex ready for the
   * `/wallet/broadcast` endpoint.
   */
  extractTx: (psbtBase64: string): string => wasm.btc_extract_tx(psbtBase64),
};
