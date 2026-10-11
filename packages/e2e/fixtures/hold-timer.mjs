/**
 * The hold timer every recorder shares, and the one tolerance every encoder
 * applies when it compares a measured hold with the owner's policy.
 *
 * A recorder used to hold with `await sleep(policyMs)` and then write
 * `Date.now() - from` as the hold. Node's timers run on a monotonic clock that
 * the event loop caches, so a timer can fire a millisecond before the wall
 * clock says it is due, and a correct 6 s hold was written as 5999 ms. The
 * E-swaps encoder then refused the whole run (a 5999 ms tap hold against the
 * 6000 ms policy, an 11999 ms settle against 12000 ms).
 *
 * Two fixes, each enough on its own:
 *   - `sleepAtLeast` keeps sleeping until the wall clock agrees, so a recorder
 *     never writes a short hold in the first place;
 *   - `heldLongEnough` admits a measured hold up to HOLD_TOLERANCE_MS short.
 *     50 ms is a fifth of one capture interval (frames are about 250 ms apart),
 *     so no frame of the policy's still screen is lost; anything shorter by
 *     more is still refused.
 * The declared policy itself (6, 12 and 25 seconds) gets no tolerance: a
 * recorder configured below it is refused exactly as before.
 */

/** How far a measured hold may fall short of its policy and still count. */
export const HOLD_TOLERANCE_MS = 50;

/** True when a measured hold meets its policy within the timer tolerance. */
export function heldLongEnough(measuredMs, policyMs, toleranceMs = HOLD_TOLERANCE_MS) {
  return Number.isFinite(measuredMs) && Number.isFinite(policyMs) && measuredMs + toleranceMs >= policyMs;
}

/** A wall clock stepped back (an NTP correction) may stretch a hold by at most this much. */
const STEP_BACK_ALLOWANCE_MS = 1_000;

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  mono: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * Sleep until at least `ms` of wall-clock time has passed, however early the
 * timer fires, and resolve with the wall-clock duration. A wall clock stepped
 * back cannot hold the screen forever: past `ms` plus a second of monotonic
 * time it returns what the wall clock says, and the encoder judges that.
 * `clock` exists for tests.
 */
export async function sleepAtLeast(ms, clock = REAL_CLOCK) {
  const from = clock.now();
  const monoFrom = clock.mono();
  for (;;) {
    const left = ms - (clock.now() - from);
    const budget = ms + STEP_BACK_ALLOWANCE_MS - (clock.mono() - monoFrom);
    if (left <= 0 || budget <= 0) return clock.now() - from;
    await clock.wait(Math.min(left, budget));
  }
}
