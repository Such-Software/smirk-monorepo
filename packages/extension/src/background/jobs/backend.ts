/**
 * Which backend a background job runs against.
 *
 * The coordinator used to forward whatever its own `api` singleton pointed at.
 * That singleton followed a switch to another operator but not a reset to the
 * default, so after "reset to the default backend" the next background sign-in
 * registered the wallet with the operator the user had just left and handed the
 * popup that operator's token to present to the default backend.
 *
 * The rule now: a job runs against the wallet's durable selection, read when the
 * job starts, and a job bound to a backend (a sign-in, whose token is only valid
 * where it was minted) must name that same backend or it does not run.
 */
import type { JobBackend, JobKind } from './types';

/** Job kinds whose result is only valid at one backend. */
const BOUND_TO_BACKEND: ReadonlySet<JobKind> = new Set<JobKind>(['bootstrap-auth']);

/**
 * Admit `input`'s backend against the wallet's `selected` backend, returning
 * the backend the job runs against. Throws, naming both, when a bound job names
 * no backend or a different one.
 */
export function admitJobBackend(
  kind: JobKind,
  input: unknown,
  selected: JobBackend,
): JobBackend {
  const named = (input as { backend?: Partial<JobBackend> } | null | undefined)?.backend;
  if (!named) {
    if (BOUND_TO_BACKEND.has(kind)) {
      throw new Error(
        `Refused to start ${kind}: it does not name a backend, so it cannot be ` +
          `tied to the selected one (${selected.url}). Reopen Smirk and try again.`,
      );
    }
    return selected;
  }
  if (named.url !== selected.url) {
    throw new Error(
      `Refused to sign in to ${String(named.url)}: the wallet's selected backend is ` +
        `${selected.url}. This window was still pointed at the previous backend; ` +
        `reopen Smirk to continue on the selected one.`,
    );
  }
  return selected;
}
