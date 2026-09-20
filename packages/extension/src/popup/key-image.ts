/**
 * Recompute a spent-output's key image, so a real spend can be told apart from
 * a ring decoy.
 *
 * monero-lws reports `spent_outputs` as CANDIDATES: its scanner records a spend
 * for every ring member that matches one of the account's outputs, with no
 * key-image check, which is why the upstream struct is named `possible_spend`.
 * Only recomputing the key image with the spend key settles whether a given
 * candidate is the wallet's own spend, or its output appearing as somebody
 * else's decoy.
 *
 * This lives in its own module because both the balance path (`index.tsx`) and
 * the history path (`routes/asset-detail.tsx`) need it, and importing it from
 * `index.tsx` would be circular.
 *
 * `subaddrMajor` / `subaddrMinor` are the index the output was RECEIVED at, as
 * reported on the spend record. Both omitted (or `(0, 0)`) is the primary
 * address and produces the exact pre-subaddress call. For a subaddress output
 * both MUST reach wasm: the subaddress secret is folded into the key offset, so
 * computing it against the primary index yields a key image that never matches
 * the reported one, the spend reads as a decoy, and its amount is never
 * subtracted, so the wallet shows money it has already spent, forever, and
 * later sends fail for insufficient funds while the UI insists otherwise.
 *
 * A half-supplied index is an error inside wasm, not a quiet fall back to the
 * primary address, so a plumbing mistake surfaces as a failure rather than as a
 * wrong balance.
 */

import { monero as wasmMonero } from '@smirk/wasm';

import { ensureWasmInit } from './wasm-init';

export const verifyKeyImage = async ({
  privateViewKeyHex,
  privateSpendKeyHex,
  txPubKeyHex,
  outputIndex,
  subaddrMajor,
  subaddrMinor,
}: {
  privateViewKeyHex: string;
  privateSpendKeyHex: string;
  txPubKeyHex: string;
  outputIndex: number;
  subaddrMajor?: number;
  subaddrMinor?: number;
}): Promise<string> => {
  await ensureWasmInit();
  const resultJson = wasmMonero.computeKeyImage(
    privateViewKeyHex,
    privateSpendKeyHex,
    txPubKeyHex,
    outputIndex,
    subaddrMajor,
    subaddrMinor,
  );
  const result = JSON.parse(resultJson) as { success: boolean; data?: string; error?: string };
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'compute_key_image failed');
  }
  return result.data;
};
