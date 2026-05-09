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

import init, * as wasm from '../../../crates/smirk-wasm/pkg/smirk_wasm.js';

let initialized = false;

/**
 * Initialize the WASM bundle. Must be called once before any other
 * function in this package. Idempotent — subsequent calls are no-ops.
 *
 * @param moduleOrPath Optional pre-fetched WASM bytes. In browser
 *   environments this is auto-resolved relative to the JS bundle URL;
 *   pass explicit bytes only if your environment doesn't support that.
 */
export async function initialize(
  moduleOrPath?: BufferSource | URL | string,
): Promise<void> {
  if (initialized) return;
  await init(moduleOrPath ? { module_or_path: moduleOrPath } : undefined);
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
};
