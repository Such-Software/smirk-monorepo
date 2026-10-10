/**
 * Area H sign-in budget.
 *
 * Every sign-in (an import, an unlock, the wallet opened in a new tab or
 * window, a reopen that cannot reuse the warm session) asks the backend's
 * /auth/check-restore, which allows 30 an hour per client IP for every wallet
 * and agent behind that IP (RESTORE_IP_THRESHOLD), areas A to G included. Past
 * it the wallet shows "Could not check wallet history: Rate limited", so a
 * lane that runs into it fails for a reason that has nothing to do with the
 * release. Three defences, cheapest first:
 *
 *   1. Other e2e runs on this host share the budget. otherE2eRuns() finds
 *      them, and the lane waits (bounded) for them to finish before it starts:
 *      area H is scheduled apart from the others, not raced against them.
 *   2. A machine-local ledger (timestamps, lane names and static labels only)
 *      records each sign-in H spends. Before a lane starts, admissibleAt()
 *      says when its planned spend fits H's share of the hour; the lane waits
 *      for that (bounded) before launching a browser.
 *   3. A refused check is not counted by the backend, so waiting it out is
 *      free: on "Rate limited" the lane backs off (bounded) and retries.
 *
 * Nothing here reads or records a secret.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { POLL_MS } from './H-cross-browser-desktop-policy.mjs';

export const SIGNIN = Object.freeze({
  /** The backend's limit per client IP. */
  perHour: 30,
  windowMs: 3_600_000,
  /** H's share of the hour by default; leaves room for a stray manual run. */
  budget: 24,
  /** Planned spend: import 2, two hand-offs and one Lock in each theme 6, a reopen 1, the lock-every-time unlock 1. */
  plan: Object.freeze({ browserLane: 10, desktop: 3 }),
  /** One backoff after a refusal, and how many a lane may take in all. */
  backoffMs: 5 * 60_000,
  maxBackoffs: 12,
  /** The longest a pre-flight waits for the budget or for other e2e runs, and how often it looks again. */
  maxPreflightWaitMs: 2 * 3_600_000,
  otherRunsPollMs: 60_000,
});

/** Our own refusals: static text, safe to print. */
export class BudgetError extends Error {
  name = 'BudgetError';
}

/** Wait `ms`, looking at `stop()` every poll; resolves early (false) when it says stop. */
export async function pause(ms, stop = () => false) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stop()) return false;
    const every = Math.min(POLL_MS, end - Date.now());
    await sleep(every);
  }
  return true;
}

export class SignInLedger {
  /**
   * @param {string} file owner-only JSON lines: { at, lane, what }
   * @param {{ lane: string, budget?: number, windowMs?: number, now?: () => number }} options
   */
  constructor(file, { lane, budget = SIGNIN.budget, windowMs = SIGNIN.windowMs, now = () => Date.now() }) {
    this.file = file;
    this.lane = lane;
    this.budget = budget;
    this.windowMs = windowMs;
    this.now = now;
  }

  entries() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return Number.isFinite(entry?.at) ? [entry] : [];
      } catch { return []; }
    });
  }

  /** Sign-ins this host's H lanes spent inside the current window. */
  used() {
    const since = this.now() - this.windowMs;
    return this.entries().filter((entry) => entry.at > since);
  }

  /** Record one sign-in (static `what`). */
  record(what) {
    appendFileSync(this.file, `${JSON.stringify({ at: this.now(), lane: this.lane, what })}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /**
   * When `planned` more sign-ins fit the budget: now, or the moment enough of
   * the window's entries age out. Infinity when the plan alone exceeds it.
   */
  admissibleAt(planned) {
    if (planned > this.budget) return Infinity;
    const times = this.used().map((entry) => entry.at).sort((a, b) => a - b);
    const excess = times.length + planned - this.budget;
    if (excess <= 0) return this.now();
    return times[excess - 1] + this.windowMs;
  }
}

/**
 * Other end-to-end runs on this host (they share the sign-in budget): other
 * Playwright runs, the demo capture lane and other area H processes. Process
 * ids only; command lines are matched here and never printed.
 */
export function otherE2eRuns({ self = process.pid } = {}) {
  const listed = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) return null;
  const pattern = /(playwright[^ ]*( |\/cli\.js )test\b|capture-demo\.mjs|\.live\.(spec\.ts|mjs)\b|desktop-smoke-macos\.sh)/;
  // Fundless suites spend no sign-ins: unit tests and the layout suite.
  const fundless = /(^| )--test( |$)|test:layout|playwright\.layout\.config/;
  const rows = String(listed.stdout).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
  // This process, the chain that started it (a shell, a wrapper script) and
  // its own children are this run. Siblings under a shared ancestor (another
  // agent's Playwright run started from the same session) are not.
  const parentOf = new Map(rows.map((row) => [row.pid, row.parent]));
  const ancestors = new Set();
  for (let pid = self; pid > 1 && !ancestors.has(pid); pid = parentOf.get(pid) ?? 0) ancestors.add(pid);
  const descendsFromSelf = (pid) => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; at = parentOf.get(at) ?? 0, hops++) if (at === self) return true;
    return false;
  };
  return rows
    .filter((row) => !ancestors.has(row.pid) && !descendsFromSelf(row.pid) && pattern.test(row.command) && !fundless.test(row.command))
    .map((row) => row.pid);
}

/**
 * Bounded pre-flight: wait for other e2e runs to finish, then for the planned
 * spend to fit the ledger. `say` prints a static reason once per kind of wait.
 */
export async function admitLane(ledger, planned, { shareBudget = false, stop = () => false, say = () => {}, maxWaitMs = SIGNIN.maxPreflightWaitMs } = {}) {
  const deadline = Date.now() + maxWaitMs;
  if (!shareBudget) {
    let told = false;
    for (;;) {
      const others = otherE2eRuns();
      if (others === null) throw new BudgetError('could not list processes to schedule area H apart from other e2e runs; pass --share-signin-budget to skip');
      if (!others.length) break;
      if (!told) say(`waiting for ${others.length} other e2e process(es) on this host to finish (pids ${others.slice(0, 5).join(', ')}): they share the backend's sign-in budget`);
      told = true;
      if (Date.now() > deadline) throw new BudgetError('other e2e runs on this host did not finish in time; schedule area H apart from them');
      if (!(await pause(SIGNIN.otherRunsPollMs, stop))) throw new BudgetError('interrupted');
    }
  }
  const at = ledger.admissibleAt(planned);
  if (at === Infinity) throw new BudgetError(`the lane plans ${planned} sign-ins, more than the budget of ${ledger.budget} an hour`);
  const wait = at - Date.now();
  if (wait <= 0) return 0;
  if (Date.now() + wait > deadline) throw new BudgetError(`the sign-in budget frees up in ${Math.ceil(wait / 60_000)} min, past the pre-flight limit`);
  say(`waiting ${Math.ceil(wait / 60_000)} min for the sign-in budget (${ledger.used().length} of ${ledger.budget} used this hour; this lane plans ${planned})`);
  if (!(await pause(wait, stop))) throw new BudgetError('interrupted');
  return wait;
}
