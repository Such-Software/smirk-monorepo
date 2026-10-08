/**
 * Interval polls that run while the popup (or the desktop window) is open.
 *
 * A poll must not keep presenting an access token the backend has refused.
 * v0.3.0 never refreshes its token, and one window left open past the token's
 * lifetime polled the received-tips and Grin relay routes once a minute for
 * about five hours, every request a 401 against the shared rate-limit budget.
 *
 * So each tick first asks the API client whether the backend has refused the
 * current token, and skips while it has. The poll resumes by itself once the
 * next unlock or bootstrap installs a new token (`setAccessToken` clears the
 * rejection), with no restart needed from the caller.
 */

/** The part of `SmirkApi` a background poll needs. */
export interface PollSession {
  isSessionRejected(): boolean;
}

/**
 * Run `tick` every `intervalMs` (and once right away when `immediate`), skipping
 * every tick while the session token is rejected. Returns the stop function.
 */
export function startBackgroundPoll(
  session: PollSession,
  tick: () => unknown,
  intervalMs: number,
  options: { immediate?: boolean } = {},
): () => void {
  const run = (): void => {
    if (session.isSessionRejected()) return;
    void tick();
  };
  if (options.immediate) run();
  const handle = setInterval(run, intervalMs);
  return () => clearInterval(handle);
}
