/**
 * Discord webhook notifier.
 *
 * Posts a single message per smoke run. Bodies are kept under
 * Discord's 2000-char limit; longer error traces get truncated with
 * a tail marker so the alert still fits.
 *
 * Failure of the webhook itself is swallowed (logged to stderr) —
 * we never want a Discord outage to mask the real smoke-test
 * verdict in CI exit codes / cron logs.
 */

const DISCORD_MAX_CONTENT = 2000;

export interface NotifyResult {
  /** Total scenarios that ran. */
  total: number;
  /** Scenarios that returned `ok: true`. */
  passed: number;
  /** Per-scenario rows for the post body. */
  scenarios: ReadonlyArray<{
    name: string;
    ok: boolean;
    durationMs: number;
    /** Truncated to ~400 chars for fit. */
    error?: string;
  }>;
  /** Optional environment + balance snapshot, surfaced on green runs
   *  so the user can eyeball balances and notice drift before they
   *  drop below the dust threshold. */
  context?: string;
}

export async function notifyDiscord(
  webhookUrl: string | undefined,
  result: NotifyResult,
): Promise<void> {
  if (!webhookUrl) {
    // No webhook configured — log to stderr so cron / journald carries
    // it. Smoke-test runs without a notifier are still useful for
    // local dev.
    console.error('[smoke] DISCORD_WEBHOOK_URL not set; result =', {
      passed: result.passed,
      total: result.total,
      failed: result.scenarios.filter((s) => !s.ok).map((s) => s.name),
    });
    return;
  }

  const allGreen = result.passed === result.total;
  const tagLine = allGreen
    ? `✅ smirk-smoke: ${result.passed}/${result.total} green`
    : `🚨 smirk-smoke: ${result.passed}/${result.total} (FAILED: ${result.scenarios
        .filter((s) => !s.ok)
        .map((s) => s.name)
        .join(', ')})`;

  const rows = result.scenarios.map((s) => {
    const icon = s.ok ? '✅' : '❌';
    const dur = `${(s.durationMs / 1000).toFixed(1)}s`;
    const tail =
      !s.ok && s.error ? `\n    ↳ ${truncate(s.error, 400)}` : '';
    return `${icon} ${s.name} (${dur})${tail}`;
  });

  const ctx = result.context ? `\n\`\`\`\n${result.context}\n\`\`\`` : '';
  const content = truncate(
    `${tagLine}\n${rows.join('\n')}${ctx}`,
    DISCORD_MAX_CONTENT,
  );

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(
        '[smoke] Discord webhook POST failed:',
        res.status,
        await res.text().catch(() => ''),
      );
    }
  } catch (e) {
    console.error('[smoke] Discord webhook threw:', e);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Reserve characters for the truncation marker.
  return s.slice(0, max - 20) + '\n…[truncated]';
}
