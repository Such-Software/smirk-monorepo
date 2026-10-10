/**
 * The owner's dead-air policy for the live lane, and its check on a recorded
 * timeline. Plain JavaScript so `node --test` covers it without a build; the
 * recorder (fixtures/guarded-footage.ts) imports it, and the types are in
 * footage-policy.d.mts.
 */

/** Hold lengths in milliseconds. */
export const HOLD_MS = Object.freeze({
  /** Every settled screen stays static at least this long. */
  settled: 12_000,
  /** Balances, confirmations, a claimed tip, a received message, swap status, history detail. */
  result: 25_000,
  /** Before every tap. */
  preTap: 6_000,
});

/** Timeline slack for the check: one capture interval (about four frames a second). */
export const POLICY_TOLERANCE_MS = 250;

/**
 * The policy, checked on the timeline alone: what the video shows, not what
 * the helpers meant to do. A change is a written frame or card, or the page's
 * first appearance. Identical frames are never written, so the time between
 * changes is the time the video stands still. For every interaction on a
 * recorded page:
 *   - the frame on screen when it happened had been unchanged for HOLD_MS.preTap;
 *   - that same frame had completed a settled or result hold, ending after the
 *     frame appeared, with that hold's full length of unchanged frames.
 * For every hold on a recorded page still open when it ended, the frame at its
 * end had been unchanged for the hold's full length.
 */
export function checkHoldPolicy(entries, tolerance = POLICY_TOLERANCE_MS) {
  const changes = new Map();
  const stops = new Map();
  const settledHolds = new Map();
  for (const entry of entries) {
    if (entry.kind === 'recorder' || entry.kind === 'frame' || entry.kind === 'card') {
      const list = changes.get(entry.recorder) ?? [];
      list.push(entry.t);
      changes.set(entry.recorder, list);
    } else if (entry.kind === 'stop') {
      stops.set(entry.recorder, entry.t);
    } else if (entry.kind === 'hold' && entry.recorder && entry.hold !== 'preTap') {
      const list = settledHolds.get(entry.recorder) ?? [];
      list.push({ end: entry.end, required: HOLD_MS[entry.hold] });
      settledHolds.set(entry.recorder, list);
    }
  }
  for (const list of changes.values()) list.sort((a, b) => a - b);

  /** The newest change on `recorder` before `t` (or at `t` unless strict), or null. */
  const changeBefore = (recorder, t, strict) => {
    const list = changes.get(recorder);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = list[mid];
      if (strict ? value < t : value <= t) {
        found = value;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const report = { taps: 0, holds: 0, violations: [] };
  for (const entry of entries) {
    if (entry.kind === 'tap' && entry.recorder) {
      const changed = changeBefore(entry.recorder, entry.t, true);
      if (changed === null) continue;
      report.taps += 1;
      const quiet = entry.t - changed;
      const base = { recorder: entry.recorder, label: entry.label, t: entry.t, staticMs: quiet };
      if (quiet < HOLD_MS.preTap - tolerance) {
        report.violations.push({ ...base, rule: 'tap without a static pause', requiredMs: HOLD_MS.preTap });
      }
      const settled = (settledHolds.get(entry.recorder) ?? []).some((hold) =>
        hold.end >= changed && hold.end <= entry.t + tolerance && hold.end - changed >= hold.required - tolerance);
      if (!settled) {
        report.violations.push({ ...base, rule: 'screen left without a settled hold', requiredMs: HOLD_MS.settled });
      }
    } else if (entry.kind === 'hold' && entry.recorder) {
      const stop = stops.get(entry.recorder);
      if (stop !== undefined && stop <= entry.end) continue;
      const changed = changeBefore(entry.recorder, entry.end, false);
      if (changed === null) continue;
      report.holds += 1;
      const quiet = entry.end - changed;
      if (quiet < HOLD_MS[entry.hold] - tolerance) {
        report.violations.push({
          rule: 'hold ended on a changing screen', recorder: entry.recorder, label: entry.label, t: entry.t,
          staticMs: quiet, requiredMs: HOLD_MS[entry.hold],
        });
      }
    }
  }
  return report;
}

/** One clause per rule with a few examples. Labels are static phrases by construction. */
export function describeViolations(violations) {
  const rules = [...new Set(violations.map((violation) => violation.rule))];
  return `the recording breaks the dead-air policy: ${rules.map((rule) => {
    const hits = violations.filter((violation) => violation.rule === rule);
    const examples = hits.slice(0, 3)
      .map((hit) => `${hit.recorder} "${hit.label}" ${(hit.staticMs / 1000).toFixed(1)} s of ${hit.requiredMs / 1000} s`);
    return `${hits.length} ${rule} (${examples.join(', ')}${hits.length > 3 ? ', ...' : ''})`;
  }).join(', ')}; every case is in policy.json beside the timeline`;
}
