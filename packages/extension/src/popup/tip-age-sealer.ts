/**
 * The wasm-backed `age` operations the tip envelope's age suites need.
 *
 * Lives outside `@smirk/core` so the core stays free of a wasm-init dependency:
 * the envelope codec and its secp256k1 suite are unit-testable without one.
 * Lives outside both tip handlers so the send and claim sides provably share a
 * single implementation rather than two that could drift.
 *
 * Callers must have run `ensureWasmInit()` first.
 */

import { bytesToHex, hexToBytes, type AgeSealer } from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';

export const wasmAgeSealer: AgeSealer = {
  seal: (payload, recipientPub) =>
    hexToBytes(wasmGrin.ageSeal(bytesToHex(payload), bytesToHex(recipientPub))),
  open: (body, seed) => hexToBytes(wasmGrin.ageOpen(bytesToHex(body), bytesToHex(seed))),
};
