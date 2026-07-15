import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  postingRequirement,
  feedSourcesFromCapability,
  NostrClient,
  NostrNotes,
  type BackendCapabilities,
  type DisplayNote,
  type NostrIdentity,
  type PostingRequirement,
  type UnlockedWallet,
} from '@smirk/core';
import { feedTimeAgo } from '../format';
import { getActiveNostrIdentityFromWallet } from '../nostr-vault';

/** Compact relative time for a unix-seconds timestamp ("3m", "5h", "2d"). */
/** One note in the feed. Author npub is shown truncated; content is inert text. */
export function FeedNote({ note, nowMs }: { note: DisplayNote; nowMs: number }) {
  const who = `${note.npub.slice(0, 12)}…${note.npub.slice(-4)}`;
  return (
    <div
      data-testid="feed-note"
      style={{
        border: '1px solid var(--smirk-border)',
        borderRadius: 8,
        padding: 10,
        background: 'var(--smirk-bg-sunken)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.6 }}>
        <span style={{ fontFamily: 'var(--smirk-font-family-mono, monospace)' }}>{who}</span>
        <span>{feedTimeAgo(note.createdAt, nowMs)}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {note.content}
      </div>
    </div>
  );
}

/**
 * Feed tab — the operator-curated public Nostr feed (kind-1 notes by the owner +
 * allowlist over the relay) plus compose. Opt-in: this route only mounts when the
 * backend advertises a `feed` capability, so the whole surface is absent on a
 * feed-less instance. Reading is always available; POSTING is capability-gated by
 * the relay's write policy via {@link postingRequirement} (open / needs-premium).
 */
export function FeedRoute({
  wallet,
  caps,
}: {
  wallet: UnlockedWallet;
  caps: BackendCapabilities | null;
}) {
  const [notes, setNotes] = useState<DisplayNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // A single tick source so every note's relative time stays fresh without a
  // per-note timer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const h = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(h);
  }, []);

  // Resolve the ACTIVE identity (async — a non-default identity may need the vault).
  // Works on a warm resume for the default identity via the cached account-0 key; a
  // non-default active identity that isn't available warm sets identityLockedLabel so
  // the composer asks for a precise re-unlock instead of posting as the main identity.
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [identityLockedLabel, setIdentityLockedLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getActiveNostrIdentityFromWallet(wallet).then((res) => {
      if (cancelled) return;
      setIdentity(res.identity);
      setIdentityLockedLabel(
        res.identity ? null : res.needsUnlock ? (res.activeLabel ?? 'your selected identity') : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [wallet.mnemonic, wallet.fingerprint]);

  // The user's premium status gates posting on a `premium-post` relay. Fetched
  // once; failures read as non-premium (compose shows "needs premium").
  const [hasPremium, setHasPremium] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .getPremiumStatus()
      .then((r) => {
        if (!cancelled) setHasPremium(r.data?.active ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const feed = caps?.feed ?? null;
  const writePolicy = caps?.messaging?.write_policy;
  const posting: PostingRequirement = feed
    ? postingRequirement({
        relayUrl: feed.relay_url,
        ...(writePolicy ? { writePolicy } : {}),
        hasPremium,
      })
    : { kind: 'no-relay' };

  // One shared transport for the screen's lifetime.
  const clientRef = useRef<NostrClient | null>(null);
  if (!clientRef.current) clientRef.current = new NostrClient();
  const notesApiRef = useRef<NostrNotes | null>(null);
  if (!notesApiRef.current) notesApiRef.current = new NostrNotes(clientRef.current);

  const refresh = async () => {
    if (!feed) return;
    setLoading(true);
    setError(undefined);
    try {
      const { sources, relayUrl } = feedSourcesFromCapability(feed);
      const list = await notesApiRef.current!.fetchFeed(sources, relayUrl, { limit: 50 });
      setNotes(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the feed');
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    const client = clientRef.current;
    return () => client?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed?.relay_url]);

  const publish = async () => {
    const body = text.trim();
    if (!identity || !body || posting.kind !== 'allowed' || !feed) return;
    setSending(true);
    setError(undefined);
    try {
      const relays = [feed.relay_url, ...feed.extra_relays];
      const note = await notesApiRef.current!.publishNote(body, identity, relays);
      setNotes((prev) => [note, ...prev.filter((n) => n.id !== note.id)]);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post');
    }
    setSending(false);
  };

  const muted = { fontSize: 12, opacity: 0.65, lineHeight: 1.5 } as const;

  return (
    <div
      data-testid="feed-screen"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Feed</h2>
        <button
          data-testid="feed-refresh"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: loading ? 'default' : 'pointer',
            fontSize: 16,
            opacity: loading ? 0.4 : 0.8,
          }}
        >
          ↻
        </button>
      </div>

      {posting.kind === 'allowed' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            data-testid="feed-compose"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            placeholder={
              identity
                ? 'Share something…'
                : identityLockedLabel
                  ? `Re-unlock to post as ${identityLockedLabel}`
                  : 'Unlock the wallet to post'
            }
            disabled={!identity || sending}
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--smirk-border)',
              background: 'var(--smirk-bg)',
              color: 'var(--smirk-fg)',
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          />
          <button
            data-testid="feed-post"
            onClick={() => void publish()}
            disabled={sending || !text.trim() || !identity}
            style={{
              alignSelf: 'flex-end',
              padding: '6px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: sending || !text.trim() ? 'default' : 'pointer',
              background: 'var(--smirk-accent)',
              color: 'var(--smirk-accent-fg, #fff)',
              fontWeight: 600,
              fontSize: 13,
              opacity: sending || !text.trim() || !identity ? 0.5 : 1,
            }}
          >
            {sending ? 'Posting…' : 'Post'}
          </button>
        </div>
      ) : posting.kind === 'needs-premium' ? (
        <p data-testid="feed-needs-premium" style={muted}>
          Posting to this feed needs a premium subscription. You can read it below.
        </p>
      ) : null}

      {error && (
        <p style={{ ...muted, color: 'var(--smirk-negative)', opacity: 1 }}>{error}</p>
      )}

      {loading && notes.length === 0 ? (
        <p style={muted}>Loading the feed…</p>
      ) : notes.length === 0 ? (
        <p data-testid="feed-empty" style={muted}>
          No posts in this feed yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notes.map((n) => (
            <FeedNote key={n.id} note={n} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}
