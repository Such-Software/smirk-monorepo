/**
 * The owner's VIDEO POLICY for the E-swaps live lane, in one place: the
 * recorder (E-swaps-footage.ts) holds by these numbers and the encoder
 * (scripts/E-swaps-encode.mjs) refuses a timeline that does not meet them.
 * Neither keeps its own copy, so the two cannot drift apart.
 *
 *   - every tap or typed field: the screen held still for 6 s first;
 *   - every screen an action leads to: held settled for 12 s before the next
 *     action, and before the recording ends;
 *   - key results (balances, swap status, history detail, a broadcast): 25 s.
 */

/** Hold lengths the recorder uses, in milliseconds. */
export const HOLD = Object.freeze({
  /** Static screen before every tap or typed field. */
  preTapMs: 6_000,
  /** Every settled screen. */
  settledMs: 12_000,
  /** Key results: balances, confirmations, swap status, history detail. */
  resultMs: 25_000,
});

/** The shortest hold of each kind the encoder admits. */
export const HOLD_MIN_MS = Object.freeze({
  tap: HOLD.preTapMs,
  type: HOLD.preTapMs,
  settled: HOLD.settledMs,
  result: HOLD.resultMs,
});

/**
 * Taps that may follow the previous action without its 12 s settle, because
 * the screen they act on closes itself sooner. Send's done screen returns
 * Home after 12 s unless "Stay on this screen" is tapped; its 6 s pre-tap
 * hold still applies, and the screen it keeps is then held as a result.
 * Adding a label here is a reviewed exception to the owner's policy.
 */
export const AUTO_CLOSE_TAPS = Object.freeze(['stay on the send result']);

const ACTIONS = new Set(['tap', 'type']);
const SETTLES = new Set(['settled', 'result']);

/**
 * Every reason a timeline's holds break the policy. Empty means admissible.
 * Messages name hold kinds and static labels only.
 */
export function holdRefusals(timeline) {
  const out = [];
  const holds = [...(timeline.holds ?? [])].sort((a, b) => a.from - b.from);
  for (const h of holds) {
    const need = HOLD_MIN_MS[h.kind];
    if (need === undefined) out.push(`hold of unknown kind ${String(h.kind).slice(0, 20)}`);
    else if (h.until - h.from < need || h.requiredMs < need) out.push(`a ${h.kind} hold lasted ${h.until - h.from} ms, under the ${need} ms policy`);
    if (h.beforeAutoClose && !AUTO_CLOSE_TAPS.includes(h.label)) out.push(`"${String(h.label).slice(0, 80)}" skipped its settle but is not an allowed auto-close tap`);
  }
  // A screen that was never held cannot be caught by checking the holds that
  // were made, so check the gaps: after each action, a settled or result hold
  // must start before the next action does (or before a closed timeline ends).
  const actions = holds.filter((h) => ACTIONS.has(h.kind));
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const next = actions[i + 1];
    if (next?.beforeAutoClose && AUTO_CLOSE_TAPS.includes(next.label)) continue;
    // A timeline cut short (a crashed worker) has no end to check against.
    const end = next ? next.from : timeline.stoppedAt;
    if (end === null || end === undefined) continue;
    const held = holds.some((h) => SETTLES.has(h.kind) && h.from >= action.until && h.until <= end);
    if (!held) out.push(`the screen after "${String(action.label).slice(0, 80)}" was never held settled`);
  }
  return [...new Set(out)];
}
