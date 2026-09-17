/**
 * Build per-input decoy rings from a pool of random outputs.
 *
 * A CLSAG ring is encoded as ascending global indices turned into deltas, and a
 * delta of zero is not representable: `Decoys::new` checks each offset strictly
 * increases the running sum and returns `None` otherwise. Two ring members with
 * the same global index therefore produce a ring the signer refuses to build,
 * which surfaced as the flat, unactionable "Failed to create Decoys".
 *
 * A collision is not exotic. `random_outs` samples the output distribution
 * independently per draw, so it can hand back the same index twice, or hand
 * back the very output being spent. It is rare per ring and much less rare
 * across a 22-member WOW ring on a multi-input send, which is why it read as
 * intermittent: the next attempt drew a different sample and worked.
 *
 * Deduplicating is also the privacy-correct thing to do rather than merely the
 * thing that compiles. A ring with a repeated member has a smaller anonymity
 * set than its size claims, and a ring containing the real output twice is a
 * fingerprint pointing straight at the spend.
 *
 * Rings are kept disjoint from each other as well. Sharing a decoy between two
 * inputs of one transaction is legal and does not break signing, but it is an
 * unusual pattern that distinguishes the transaction for no benefit.
 */

/** The fields of a random output this module needs. Callers pass richer rows. */
export interface RingMemberLike {
  global_index: number;
}

export type DecoyRingResult<T> =
  | { ok: true; rings: T[][] }
  | { ok: false; error: string };

/**
 * Partition `pool` into one ring of `decoysPerInput` members per real input.
 *
 * `realGlobalIndices[i]` is the index of the output input `i` actually spends;
 * it is excluded from that input's ring. Returns an error rather than a short
 * ring: a ring below the protocol's size is a worse outcome than a failed send,
 * because it is permanently visible on chain.
 */
export function buildDecoyRings<T extends RingMemberLike>(
  pool: readonly T[],
  realGlobalIndices: readonly number[],
  decoysPerInput: number,
): DecoyRingResult<T> {
  const rings: T[][] = [];
  const consumed = new Set<number>();
  let cursor = 0;

  for (const realIndex of realGlobalIndices) {
    const ring: T[] = [];
    const used = new Set<number>([realIndex]);

    while (ring.length < decoysPerInput && cursor < pool.length) {
      const candidate = pool[cursor];
      cursor += 1;
      if (candidate === undefined) continue;
      const gi = candidate.global_index;
      if (used.has(gi) || consumed.has(gi)) continue;
      used.add(gi);
      consumed.add(gi);
      ring.push(candidate);
    }

    if (ring.length < decoysPerInput) {
      return {
        ok: false,
        error:
          `Could not assemble a full ring: the node returned ${pool.length} decoys but too ` +
          `many were duplicates. Try again in a moment.`,
      };
    }
    rings.push(ring);
  }

  return { ok: true, rings };
}
