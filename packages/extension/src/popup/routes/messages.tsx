import { useEffect, useState } from 'preact/hooks';
import {
  api,
  initSmirkMessaging,
  deriveNostrIdentity,
  decryptWrap,
  subscribeDms,
  sendDm,
  type UnlockedWallet,
  type NostrIdentity,
  type DirectMessage,
  type DmSubscription,
  type GiftWrapEvent,
} from '@smirk/core';
import { settingsInputStyle } from '../ui-shared';

/**
 * Settings → Messages (Identity/messaging plane). Basic NIP-17 encrypted DMs over
 * the backend's relay: subscribe to our inbox while open, and compose to an npub.
 * Reads the relay URL from /capabilities and self-disables when the instance runs
 * no relay. The subscription lives for the screen's lifetime (a basic surface;
 * background delivery + notifications are future work).
 */

export function MessagesRoute({ wallet, onBack }: { wallet: UnlockedWallet; onBack: () => void }) {
  const [ready, setReady] = useState<'loading' | 'off' | 'on'>('loading');
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let sub: DmSubscription | undefined;
    let cancelled = false;
    void (async () => {
      const caps = await api.getCapabilities();
      const relayUrl = caps.data?.messaging?.relay_url;
      if (!caps.data?.features?.nostr_relay || !relayUrl) {
        if (!cancelled) setReady('off');
        return;
      }
      if (!wallet.mnemonic) {
        if (!cancelled) {
          setError('Unlock the wallet to use messaging');
          setReady('off');
        }
        return;
      }
      // Local-only for now: the Smirk relay is the inbox; public interop relays
      // are added when we resolve a recipient's kind-10050 (future).
      initSmirkMessaging({ relayUrl, publicRelays: [] });
      const id = deriveNostrIdentity(wallet.mnemonic, 0);
      if (cancelled) return;
      setIdentity(id);

      // Kick off background delivery (persists after this screen closes) and load
      // any encrypted wraps the background poller already collected while away.
      void chrome.runtime
        .sendMessage({ type: 'DM_WATCH_SET', npubHex: id.pubkeyHex, relayUrl })
        .catch(() => {});
      void chrome.runtime
        .sendMessage({ type: 'DM_WRAPS_GET' })
        .then((res: { wraps?: GiftWrapEvent[] } | undefined) => {
          if (cancelled || !res?.wraps?.length) return;
          const decrypted = res.wraps
            .map((w) => decryptWrap(id, w))
            .filter((m): m is DirectMessage => !!m);
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...decrypted.filter((m) => !seen.has(m.id))].sort(
              (a, b) => b.createdAt - a.createdAt,
            );
          });
        })
        .catch(() => {});

      sub = subscribeDms(id, (dm) => {
        if (cancelled) return;
        setMessages((prev) =>
          prev.some((m) => m.id === dm.id)
            ? prev
            : [dm, ...prev].sort((a, b) => b.createdAt - a.createdAt),
        );
      });
      setReady('on');
    })().catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Messaging failed to start');
        setReady('off');
      }
    });
    return () => {
      cancelled = true;
      sub?.close();
    };
  }, [wallet.mnemonic]);

  const send = async () => {
    if (!identity || !recipient.trim() || !text.trim()) return;
    setStatus('sending');
    setError(undefined);
    try {
      await sendDm(identity, recipient.trim(), text.trim());
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    }
    setStatus('idle');
  };

  return (
    <div data-testid="messages-screen">
      <button
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
          padding: '4px 0',
          opacity: 0.7,
        }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 16, marginTop: 4 }}>Messages</h2>

      {ready === 'off' ? (
        <p data-testid="messages-relay-off" style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4 }}>
          {error ?? 'This backend does not run a Nostr relay, so encrypted messaging is unavailable.'}
        </p>
      ) : (
        <>
          <p style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.4, marginTop: 4 }}>
            End-to-end encrypted (NIP-17). Send to an npub; incoming messages appear
            below while this screen is open.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            <input
              data-testid="dm-recipient-input"
              placeholder="recipient npub1…"
              value={recipient}
              onInput={(e) => setRecipient((e.target as HTMLInputElement).value)}
              style={settingsInputStyle}
            />
            <textarea
              data-testid="dm-text-input"
              placeholder="Message"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              rows={2}
              style={{ ...settingsInputStyle, resize: 'vertical' }}
            />
            <button
              data-testid="dm-send-btn"
              onClick={() => void send()}
              disabled={status === 'sending' || ready !== 'on' || !recipient.trim() || !text.trim()}
              style={{
                padding: '8px 14px',
                background: 'var(--smirk-accent, #6366f1)',
                border: 'none',
                borderRadius: 6,
                color: 'var(--smirk-accent-fg, #fff)',
                fontFamily: 'inherit',
                fontSize: 13,
                cursor: status === 'sending' ? 'default' : 'pointer',
                opacity: status === 'sending' ? 0.7 : 1,
                alignSelf: 'flex-start',
              }}
            >
              {status === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>

          {error && (
            <div data-testid="messages-error" style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.length === 0 ? (
              <p style={{ fontSize: 12, opacity: 0.5 }}>No messages yet.</p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  data-testid="message-item"
                  style={{
                    padding: '8px 10px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 6,
                  }}
                >
                  <div
                    data-testid="message-from"
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 10,
                      opacity: 0.6,
                      wordBreak: 'break-all',
                    }}
                  >
                    {m.fromNpub}
                  </div>
                  <div data-testid="message-text" style={{ fontSize: 13, marginTop: 2 }}>
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
