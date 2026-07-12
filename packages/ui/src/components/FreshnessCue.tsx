/**
 * FreshnessCue — the escalating "are these balances live?" affordance shown next
 * to the Home total.
 *
 * Seamless balances paint an instant cached number, then a background loop keeps
 * it fresh. This cue tells the user which of three worlds they're in WITHOUT
 * making a healthy wallet look broken:
 *
 *   - up to date + a refresh in flight  -> a SUBTLE "updating" dot. Not alarming.
 *   - fresh + idle                       -> nothing (the number is trusted).
 *   - refreshes failing for > 30s        -> a subtle amber WARNING.
 *   - refreshes failing for > 60s        -> a CLEAR red error: something is broken.
 *
 * The escalation is TIME-since-last-success based, not per-attempt: one transient
 * network blip must NOT flip the wallet to red; sustained failure must. The
 * component owns a low-frequency internal ticker so it escalates on its own
 * between refresh attempts (the parent only re-renders when a refresh settles,
 * which can be coarser than the thresholds).
 *
 * Presentational only: the consumer feeds it `refreshing` / `lastSuccessAt` /
 * `lastAttemptFailed` from session state and decides where to mount it.
 */

import { useEffect, useState } from 'preact/hooks';

/** Sustained failure past this (ms since last success) shows a subtle warning. */
export const FRESHNESS_WARN_MS = 30_000;
/** Sustained failure past this (ms since last success) shows a clear error. */
export const FRESHNESS_ERROR_MS = 60_000;

/** How often the cue re-evaluates itself while in a failing state, so the
 *  30s/60s thresholds trip without waiting for the next parent re-render. */
const FRESHNESS_TICK_MS = 5_000;

export type FreshnessLevel = 'fresh' | 'updating' | 'warn' | 'error';

export interface FreshnessCueProps {
  /** True while a balance refresh is in flight. */
  refreshing: boolean;
  /** Epoch ms of the last refresh that actually returned fresh data, or null if
   *  none has landed yet this session. */
  lastSuccessAt: number | null;
  /** True when the most recent COMPLETED refresh attempt failed to get fresh
   *  data (threw, or every attempted asset errored). A recent single failure is
   *  held below the warning threshold; only sustained failure escalates. */
  lastAttemptFailed: boolean;
  class?: string;
}

/**
 * Pure state machine: map raw session freshness inputs + `now` to a level.
 * Exported so consumers (and tests) can reason about the escalation without the
 * component. Sustained failure wins over an in-flight retry, so a retry mid
 * outage does NOT downgrade red back to a subtle dot.
 */
export function computeFreshnessLevel(
  input: { refreshing: boolean; lastSuccessAt: number | null; lastAttemptFailed: boolean },
  now: number,
): FreshnessLevel {
  const { refreshing, lastSuccessAt, lastAttemptFailed } = input;
  if (lastAttemptFailed) {
    const elapsed = lastSuccessAt === null ? Infinity : now - lastSuccessAt;
    if (elapsed >= FRESHNESS_ERROR_MS) return 'error';
    if (elapsed >= FRESHNESS_WARN_MS) return 'warn';
    // Failed but recent: a transient blip. Don't alarm; show the subtle
    // updating affordance if we're already retrying, else treat as fresh.
    return refreshing ? 'updating' : 'fresh';
  }
  return refreshing ? 'updating' : 'fresh';
}

export function FreshnessCue({
  refreshing,
  lastSuccessAt,
  lastAttemptFailed,
  class: className,
}: FreshnessCueProps) {
  const [now, setNow] = useState(() => Date.now());

  // Only tick while we're failing AND still below the top (error) level: a
  // healthy wallet, or one already pinned to red, has nothing left to escalate
  // to, so we don't burn a timer. A known-null success anchor is already maxed
  // out (Infinity elapsed => error), so it doesn't tick either. Each settled
  // refresh re-runs this effect with fresh inputs.
  const needsTicking =
    lastAttemptFailed &&
    lastSuccessAt !== null &&
    Date.now() - lastSuccessAt < FRESHNESS_ERROR_MS;
  useEffect(() => {
    if (!needsTicking) return undefined;
    const handle = setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(handle);
  }, [needsTicking]);

  // Compute against the freshest clock available: `now` is bumped by the ticker
  // for time-driven escalation, but read Date.now() too so an input-driven
  // re-render (a settled refresh) is never a threshold behind.
  const level = computeFreshnessLevel(
    { refreshing, lastSuccessAt, lastAttemptFailed },
    Math.max(now, Date.now()),
  );

  if (level === 'fresh') return null;

  const style = LEVEL_STYLE[level];
  // Announce the escalating states to assistive tech; keep the subtle,
  // every-cycle "updating" dot silent so it doesn't spam a screen reader.
  const isAlarm = level === 'warn' || level === 'error';
  return (
    <div
      class={className}
      data-testid="balance-freshness-cue"
      data-freshness={level}
      {...(level === 'error' ? { role: 'alert' } : isAlarm ? { role: 'status' } : {})}
      aria-live={level === 'error' ? 'assertive' : isAlarm ? 'polite' : 'off'}
      title={style.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        lineHeight: 1.3,
        color: style.color,
        maxWidth: '100%',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: style.color,
          ...(level === 'updating' ? { animation: 'smirk-freshness-pulse 1.2s ease-in-out infinite' } : {}),
        }}
      />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {style.label}
      </span>
      {/* Keyframes are inlined so the cue is self-contained; @smirk/ui ships no
          global stylesheet and a missing keyframe just yields a static dot. */}
      <style>{PULSE_KEYFRAMES}</style>
    </div>
  );
}

const LEVEL_STYLE: Record<
  Exclude<FreshnessLevel, 'fresh'>,
  { color: string; label: string; title: string }
> = {
  updating: {
    color: 'var(--smirk-fg-muted)',
    label: 'Updating…',
    title: 'Refreshing your balances',
  },
  warn: {
    color: 'var(--smirk-warning, #b8860b)',
    label: 'Balance may be out of date',
    title: "Haven't been able to refresh recently — showing your last-known balances",
  },
  error: {
    color: 'var(--smirk-negative, #ff6b6b)',
    label: "Can't reach the server — balance may be stale",
    title: "Can't reach the backend — the numbers shown are last-known, not live",
  },
};

const PULSE_KEYFRAMES = `@keyframes smirk-freshness-pulse{0%,100%{opacity:.35}50%{opacity:1}}`;
