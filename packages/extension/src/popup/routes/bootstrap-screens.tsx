/**
 * Placeholder rendered while the background `bootstrap-auth` job is
 * still running. Shows the animated doge so the wait reads as
 * intentional ("we're proving you're probably human") rather than
 * a hang. The actual work — PoW + register — happens in the
 * offscreen runner; this view just listens for the result.
 *
 * If the popup closes while this is showing, the SW continues the
 * bootstrap; the *next* popup mount finds the result in
 * `chrome.storage.session` via the bootstrap-auth job's dedup key.
 */
export function BootstrappingPlaceholder({
  dogeImageUrl,
}: {
  dogeImageUrl: string;
}) {
  return (
    <div
      data-testid="bootstrapping-placeholder"
      style={{
        padding: '48px 16px 16px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          animation: 'smirk-bootstrap-bounce 0.9s ease-in-out infinite',
        }}
      >
        <img
          src={dogeImageUrl}
          alt=""
          style={{ width: 140, height: 'auto', display: 'block' }}
        />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.9 }}>
        Setting up wallet…
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          maxWidth: 280,
          lineHeight: 1.4,
        }}
      >
        Signing you in &mdash; this can take a few seconds. Safe to
        click away; the work continues in the background and resumes
        when you reopen the wallet.
      </div>
      <style>{`
        @keyframes smirk-bootstrap-bounce {
          0%, 100% { transform: translateY(0) rotate(-3deg); }
          50%      { transform: translateY(-12px) rotate(3deg); }
        }
      `}</style>
    </div>
  );
}

/** Shown when auth bootstrap FAILS (rather than masking it behind the endless
 *  "Setting up wallet…" placeholder). Offers a retry, which re-runs the session
 *  bootstrap from a clean slate. */
export function BootstrapErrorScreen({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="bootstrap-error"
      style={{
        padding: '48px 16px 16px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <div style={{ fontSize: 30 }} aria-hidden="true">
        ⚠️
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Couldn&apos;t sign in</div>
      <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 300, lineHeight: 1.45 }}>
        {message}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginTop: 6,
          padding: '8px 18px',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.08)',
          color: 'inherit',
        }}
      >
        Try again
      </button>
    </div>
  );
}
