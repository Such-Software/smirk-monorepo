import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  SESSION_CACHE_KEY,
  AUTO_LOCK_MAX_MINUTES,
  withAssetVisibility,
  type UnlockedWallet,
} from '@smirk/core';
import { useRoute, useSessionState, listThemes } from '@smirk/ui';
import { listAssets } from '@smirk/assets';
import { store, sessionStorage, walletKeystore } from '../singletons';
import { bytesToHex } from '../format';
import { settingsInputStyle } from '../ui-shared';
import { writeSessionCache } from '../session-cache';
import { browserController } from '../browser-controller';
import { isInjectDisabled, setInjectDisabled } from '../../background/dapp/inject-policy';
import type { WalletSession } from '../types';
import { SentTipsRoute } from './sent-tips';
import { NostrIdentityRoute } from './nostr-identity';
import { BackendRoute } from './backend';

/**
 * The auto-lock dropdown options. `0` = lock immediately on popup close
 * (safe default). Positive = minutes, clamped to `AUTO_LOCK_MAX_MINUTES`;
 * there is no "never" value.
 *
 * When non-zero, the popup persists the unlocked wallet's derived keys and
 * addresses into `chrome.storage.session` for the chosen duration. The
 * mnemonic is never cached, so the "do not persist seed material" rule holds
 * at every setting; the convenience-vs-security tradeoff here is only over
 * how long usable keys stay resident.
 */
const AUTO_LOCK_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Immediately (most secure)' },
  { value: 10, label: '10 minutes' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  // 2026-06-13: dropped the "Never (until browser closes)" /
  // -1 / MAX_SAFE_INTEGER option as part of the wrapped-key
  // session-cache hardening. AUTO_LOCK_MAX_MINUTES (24h) is the
  // hardest upper bound now: anything beyond clamps. See
  // keystore.ts file header.
  { value: AUTO_LOCK_MAX_MINUTES, label: '24 hours (maximum)' },
];

/**
 * Settings → Assets: show/hide each registered asset.
 *
 * Hidden assets disappear from Home, the Send/Receive/Tip choosers,
 * and balance-poll round-trips. They're still routable directly
 * (claim notifications, external links) and the wallet still owns
 * their keys; visibility is a UI preference, not a destructive
 * action.
 *
 * Footer count gives at-a-glance feedback. Auto-unhide-on-claim
 * (handled elsewhere) and onboarding hint round out the surface.
 */
function AssetsVisibilityPanel({
  sessionState,
}: {
  sessionState: ReturnType<typeof useSessionState>;
}) {
  const hidden = sessionState.ui.hiddenAssets ?? [];
  const all = listAssets();
  const visibleCount = all.filter((a) => !hidden.includes(a.id)).length;
  const toggle = async (assetId: string, visible: boolean) => {
    await store.update((s) => {
      s.ui.hiddenAssets = withAssetVisibility(
        s.ui.hiddenAssets ?? [],
        assetId,
        visible,
      );
    });
  };
  return (
    <section style={{ marginTop: 20 }}>
      <label
        style={{
          display: 'block',
          fontSize: 12,
          opacity: 0.8,
          marginBottom: 6,
        }}
      >
        Assets
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          padding: '6px 8px',
        }}
      >
        {all.map((a) => {
          const isVisible = !hidden.includes(a.id);
          return (
            <label
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 13,
                padding: '6px 4px',
                cursor: 'pointer',
                lineHeight: 1.2,
              }}
            >
              <input
                type="checkbox"
                checked={isVisible}
                onChange={(e) =>
                  void toggle(a.id, (e.target as HTMLInputElement).checked)
                }
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                {a.displayName}{' '}
                <span
                  style={{
                    opacity: 0.55,
                    fontSize: 11,
                    fontFamily: 'var(--smirk-font-family-mono, monospace)',
                  }}
                >
                  {a.ticker}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p
        style={{
          fontSize: 11,
          opacity: 0.55,
          margin: '6px 0 0',
          lineHeight: 1.4,
        }}
      >
        {visibleCount} visible · {hidden.length} hidden. Hidden assets stop
        polling the backend until you re-enable them. The wallet still
        owns the keys — hiding never destroys access.
      </p>
    </section>
  );
}

/**
 * Settings tab router.
 *
 * Sub-routes:
 *   - `settings`:             the main Settings page (SettingsStub)
 *   - `settings/sent-tips`:   cross-asset Sent Tips list with
 *                             inline Clawback + Discard Draft actions.
 *   - `settings/nostr`      (the Nostr identity vault)
 *   - `settings/backend`    (backend selection)
 *
 * Per-asset history already surfaces sent-tip rows inline in
 * AssetDetailScreen; this is the cross-asset surface: find a
 * forgotten clawback-eligible tip across all 5 chains in one place.
 */
export function SettingsRouter({
  wallet,
  session,
  onRefresh,
  onLock,
  onForgetComplete,
  onBackendSwitched,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Balance refresh: threaded through to SentTipsRoute so clawback
   *  can show the recovered funds immediately. */
  onRefresh: () => Promise<void>;
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
  /** Drop the per-backend session + caches so the shell re-bootstraps auth
   *  against the newly-selected backend. */
  onBackendSwitched: () => Promise<void>;
}) {
  const { route, navigate } = useRoute();
  if (route.current === 'settings/sent-tips') {
    return (
      <SentTipsRoute
        wallet={wallet}
        session={session}
        onRefresh={onRefresh}
        onBack={() => void navigate('settings')}
      />
    );
  }
  if (route.current === 'settings/nostr') {
    return <NostrIdentityRoute wallet={wallet} onBack={() => void navigate('settings')} />;
  }
  if (route.current === 'settings/backend') {
    return (
      <BackendRoute
        onSwitched={onBackendSwitched}
        onBack={() => void navigate('settings')}
      />
    );
  }
  return (
    <SettingsStub
      wallet={wallet}
      onLock={onLock}
      onForgetComplete={onForgetComplete}
    />
  );
}






/**
 * Settings → Security. Three sub-panels:
 *   1. Seed fingerprint display (read-only identifier).
 *   2. Change password (in-place keystore rotation).
 *   3. Export raw keys (with strong warning + reveal-on-confirm).
 *
 * Each section is collapsed by default: they're rarely used and
 * shouldn't compete with everyday surfaces (auto-lock, theme).
 * Clicking the section header expands. Keeps the Settings tab
 * scrollable but not overwhelming.
 */
function SecurityPanel({ wallet }: { wallet: UnlockedWallet }) {
  const [openSection, setOpenSection] = useState<
    null | 'fingerprint' | 'password' | 'export'
  >(null);
  const toggle = (s: typeof openSection) =>
    setOpenSection(openSection === s ? null : s);

  return (
    <section style={{ marginTop: 20 }}>
      <label
        style={{
          display: 'block',
          fontSize: 12,
          opacity: 0.8,
          marginBottom: 6,
        }}
      >
        Security
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          padding: '6px 8px',
        }}
      >
        <SecurityRow
          label="Wallet fingerprint"
          open={openSection === 'fingerprint'}
          onToggle={() => toggle('fingerprint')}
        >
          <FingerprintPanel fingerprint={wallet.fingerprint} />
        </SecurityRow>
        <SecurityRow
          label="Change password"
          open={openSection === 'password'}
          onToggle={() => toggle('password')}
        >
          <ChangePasswordPanel
            onClose={() => setOpenSection(null)}
          />
        </SecurityRow>
        <SecurityRow
          label="Export raw keys"
          open={openSection === 'export'}
          onToggle={() => toggle('export')}
        >
          <ExportKeysPanel wallet={wallet} />
        </SecurityRow>
      </div>
    </section>
  );
}

function SecurityRow({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '8px 4px',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{label}</span>
        <span style={{ opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ padding: '0 4px 8px' }}>{children}</div>}
    </div>
  );
}

function FingerprintPanel({ fingerprint }: { fingerprint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={{ fontSize: 11, opacity: 0.65, margin: 0, lineHeight: 1.4 }}>
        A one-way SHA-256 of your seed. Smirk uses this as your
        wallet&apos;s anonymous identifier across devices — not
        reversible, cannot move funds.
      </p>
      <div
        style={{
          fontFamily: 'var(--smirk-font-family-mono, monospace)',
          fontSize: 11,
          padding: '6px 8px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6,
          wordBreak: 'break-all',
        }}
      >
        {fingerprint}
      </div>
      <button
        onClick={() => void copy()}
        style={{
          alignSelf: 'flex-start',
          padding: '4px 10px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ChangePasswordPanel({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await walletKeystore.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setDone(true);
      // Auto-close the panel after the success message shows briefly.
      setTimeout(() => {
        setCurrent('');
        setNext('');
        setConfirm('');
        setDone(false);
        onClose();
      }, 1500);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to change password',
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p
        style={{
          fontSize: 12,
          color: 'var(--smirk-positive, #4ade80)',
          margin: 0,
        }}
      >
        ✓ Password changed. Use the new password next time you unlock.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 11, opacity: 0.65, margin: 0, lineHeight: 1.4 }}>
        Rotates the local encryption key on your keystore. Your seed
        phrase is unchanged — this only affects how the wallet is
        unlocked on this device.
      </p>
      <input
        type="password"
        value={current}
        onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
        placeholder="Current password"
        autoComplete="current-password"
        style={settingsInputStyle}
      />
      <input
        type="password"
        value={next}
        onInput={(e) => setNext((e.target as HTMLInputElement).value)}
        placeholder="New password (≥ 8 chars)"
        autoComplete="new-password"
        style={settingsInputStyle}
      />
      <input
        type="password"
        value={confirm}
        onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
        placeholder="Confirm new password"
        autoComplete="new-password"
        style={settingsInputStyle}
      />
      {error && (
        <p
          style={{
            fontSize: 11,
            color: 'var(--smirk-negative, #ff6b6b)',
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
      <button
        onClick={() => void submit()}
        disabled={busy}
        style={{
          alignSelf: 'flex-start',
          padding: '6px 12px',
          background: 'var(--smirk-accent)',
          color: 'var(--smirk-accent-fg)',
          border: 'none',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </div>
  );
}

function ExportKeysPanel({ wallet }: { wallet: UnlockedWallet }) {
  const [revealed, setRevealed] = useState(false);
  const [powHash, setPowHash] = useState<string>('computing…');
  const keys = wallet.keys;

  useEffect(() => {
    // SHA-256 of the BTC pubkey hex string. Matches the backend's
    // `hash_public_key` exactly so the value here pastes verbatim
    // into TEST_POW_REQUIRED_FOR_PUBKEYS for safe pre-flip testing.
    void (async () => {
      const pubkeyHex = bytesToHex(keys.btc.publicKey);
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(pubkeyHex),
      );
      const hash = bytesToHex(new Uint8Array(buf));
      setPowHash(hash);
    })();
  }, [keys.btc.publicKey]);

  // Always-visible public material: addresses, public keys, the PoW
  // gate hash. Safe to show without the reveal gate. Lives above the
  // gate so a user doesn't have to opt into "I understand the risk"
  // just to copy a public address or a hash that's only useful for
  // anti-abuse config.
  const publicMaterial = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KeyRow
        label="Smirk PoW gate hash"
        sub="SHA-256 of your BTC pubkey hex — paste into TEST_POW_REQUIRED_FOR_PUBKEYS on the backend"
        value={powHash}
      />
      <KeyRow
        label="BTC address"
        sub="bech32 P2WPKH — m/84'/0'/0'/0/0"
        value={wallet.addresses.btc}
      />
      <KeyRow
        label="BTC public key (compressed)"
        sub="33-byte secp256k1 pubkey"
        value={bytesToHex(keys.btc.publicKey)}
      />
      <KeyRow
        label="LTC address"
        sub="bech32 P2WPKH — m/84'/2'/0'/0/0"
        value={wallet.addresses.ltc}
      />
      <KeyRow
        label="LTC public key (compressed)"
        sub="33-byte secp256k1 pubkey"
        value={bytesToHex(keys.ltc.publicKey)}
      />
      <KeyRow
        label="XMR address"
        sub="standard CryptoNote address (95 chars)"
        value={wallet.addresses.xmr}
      />
      <KeyRow
        label="XMR public spend key"
        sub="32-byte ed25519 — half of the public address"
        value={bytesToHex(keys.xmr.publicSpendKey)}
      />
      <KeyRow
        label="XMR public view key"
        sub="32-byte ed25519 — half of the public address"
        value={bytesToHex(keys.xmr.publicViewKey)}
      />
      <KeyRow
        label="WOW address"
        sub="standard Wownero address"
        value={wallet.addresses.wow}
      />
      <KeyRow
        label="WOW public spend key"
        sub="32-byte ed25519"
        value={bytesToHex(keys.wow.publicSpendKey)}
      />
      <KeyRow
        label="WOW public view key"
        sub="32-byte ed25519"
        value={bytesToHex(keys.wow.publicViewKey)}
      />
      <KeyRow
        label="Grin slatepack address"
        sub="bech32-encoded ed25519 pubkey"
        value={wallet.addresses.grin}
      />
      <KeyRow
        label="Grin public key"
        sub="32-byte ed25519 pubkey"
        value={bytesToHex(keys.grin.publicKey)}
      />
    </div>
  );

  if (!revealed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p
          style={{
            fontSize: 11,
            opacity: 0.65,
            margin: 0,
            lineHeight: 1.4,
          }}
        >
          For recovering your wallet in another tool (Monero CLI,
          grin-wallet, Sparrow, Electrum, etc.) and for backend
          anti-abuse config. Public material below is safe to copy;
          private keys require a confirmation tap.
        </p>
        {publicMaterial}
        <div
          style={{
            padding: '8px 10px',
            background: 'rgba(239, 68, 68, 0.10)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: 6,
            fontSize: 11,
            color: '#ef4444',
            lineHeight: 1.4,
          }}
        >
          ⚠ <strong>Never share private keys.</strong> Anyone with
          these can spend your funds. Smirk staff will NEVER ask
          for these. Don&apos;t paste them into websites, chat apps,
          or AI assistants.
        </div>
        <button
          onClick={() => setRevealed(true)}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            background: 'rgba(239, 68, 68, 0.10)',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            color: '#ef4444',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          I understand the risk — reveal private keys
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {publicMaterial}
      <div
        style={{
          padding: '6px 10px',
          background: 'rgba(239, 68, 68, 0.08)',
          borderRadius: 4,
          fontSize: 10,
          color: '#ef4444',
          opacity: 0.85,
        }}
      >
        Private keys below — full spend access.
      </div>
      <KeyRow
        label="BTC private key (secp256k1)"
        sub="BIP84 path m/84'/0'/0'/0/0 — import into Sparrow/Electrum"
        value={bytesToHex(keys.btc.privateKey)}
      />
      <KeyRow
        label="LTC private key (secp256k1)"
        sub="BIP84 path m/84'/2'/0'/0/0 — import into Electrum-LTC"
        value={bytesToHex(keys.ltc.privateKey)}
      />
      <KeyRow
        label="XMR private spend key"
        sub="32-byte ed25519 scalar — Cake/Feather: import 'spend key' + view key below"
        value={bytesToHex(keys.xmr.privateSpendKey)}
      />
      <KeyRow
        label="XMR private view key"
        sub="32-byte ed25519 scalar — pair with spend key above for read-only import"
        value={bytesToHex(keys.xmr.privateViewKey)}
      />
      <KeyRow
        label="WOW private spend key"
        sub="32-byte ed25519 scalar — Cake/Feather Wownero: import 'spend key' + view key below"
        value={bytesToHex(keys.wow.privateSpendKey)}
      />
      <KeyRow
        label="WOW private view key"
        sub="32-byte ed25519 scalar — pair with spend key above"
        value={bytesToHex(keys.wow.privateViewKey)}
      />
      <KeyRow
        label="Grin slatepack secret key"
        sub="32-byte ed25519 scalar — grin-wallet/Grim Smirk-compat import"
        value={bytesToHex(keys.grin.privateKey)}
      />
      <button
        onClick={() => setRevealed(false)}
        style={{
          alignSelf: 'flex-start',
          padding: '4px 10px',
          background: 'transparent',
          border: '1px solid var(--smirk-border)',
          color: 'inherit',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        Hide
      </button>
    </div>
  );
}

function KeyRow({
  label,
  sub,
  value,
}: {
  label: string;
  sub: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 10, opacity: 0.5 }}>{sub}</div>
      <div
        style={{
          fontFamily: 'var(--smirk-font-family-mono, monospace)',
          fontSize: 10,
          padding: '4px 6px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 4,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
      <button
        onClick={() => void copy()}
        style={{
          alignSelf: 'flex-start',
          padding: '2px 8px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 10,
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Compact nav row used in Settings to deep-link into sub-screens
 * (Sent Tips, future: per-asset RPC config, etc.). Two lines
 * (label + hint) with a chevron at the right and a hover affordance.
 */
function SettingsNavRow({
  label,
  hint,
  onClick,
  testid,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <section style={{ marginTop: 20 }}>
      <button
        onClick={onClick}
        data-testid={testid}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--smirk-fg-muted)',
              lineHeight: 1.3,
            }}
          >
            {hint}
          </span>
        </div>
        <span style={{ opacity: 0.5, fontSize: 14 }}>›</span>
      </button>
    </section>
  );
}


function SettingsStub({ wallet, onLock, onForgetComplete }: {
  wallet: UnlockedWallet;
  onLock: () => Promise<void>;
  onForgetComplete: () => Promise<void>;
}) {
  const { navigate } = useRoute();
  const sessionState = useSessionState();
  const autoLockMinutes = sessionState.ui.autoLockMinutes ?? 0;
  const themeId = sessionState.ui.theme ?? 'default';
  const [forgetOpen, setForgetOpen] = useState(false);
  // window.smirk injection toggle: closes the short-term ask in
  // Such-Software/smirk-extension#1. Lives in chrome.storage.local
  // (read directly by the content script at document_start) rather
  // than the session-state store, so the toggle isn't gated on a
  // JSON-blob parse on the hot path.
  const [injectDisabled, setInjectDisabledState] = useState<boolean | null>(null);
  useEffect(() => {
    void isInjectDisabled().then(setInjectDisabledState);
  }, []);
  const toggleInjectDisabled = async (next: boolean) => {
    await setInjectDisabled(next);
    setInjectDisabledState(next);
  };

  const setThemeId = async (next: string) => {
    await store.update((s) => {
      s.ui.theme = next;
    });
  };

  const setAutoLock = async (minutes: number) => {
    await store.update((s) => {
      s.ui.autoLockMinutes = minutes;
    });
    if (minutes === 0) {
      // Immediate-lock chosen: wipe any existing session-cache so the
      // new policy takes effect now, not when the old timer expires.
      await sessionStorage.remove(SESSION_CACHE_KEY);
    } else {
      // Re-stamp the session cache against the currently-unlocked
      // wallet so the new TTL applies immediately. Without this, a
      // user who unlocks with "Immediately" (no cache) and then
      // switches to "Never" sees no effect until the next manual
      // unlock, defeating the toggle.
      const ks = await walletKeystore.getState();
      if (ks.kind === 'unlocked') {
        await writeSessionCache(ks.wallet, minutes);
      }
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Settings</h2>

      <section style={{ marginTop: 16 }}>
        <label
          style={{
            display: 'block',
            fontSize: 12,
            opacity: 0.8,
            marginBottom: 6,
          }}
        >
          Auto-lock wallet after
        </label>
        <select
          data-testid="settings-autolock-select"
          value={String(autoLockMinutes)}
          onChange={(e) => void setAutoLock(Number((e.target as HTMLSelectElement).value))}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          {AUTO_LOCK_OPTIONS.map((o) => (
            <option
              key={o.value}
              value={String(o.value)}
              data-testid={o.value === 0 ? 'settings-autolock-immediately' : undefined}
            >
              {o.label}
            </option>
          ))}
        </select>
        {autoLockMinutes !== 0 && (
          <p
            style={{
              fontSize: 11,
              opacity: 0.55,
              margin: '6px 0 0',
              lineHeight: 1.4,
            }}
          >
            ⚠ While unlocked, this device keeps your derived keys in browser
            session storage (never your recovery phrase). Only choose a
            non-immediate option on devices you trust physically.
          </p>
        )}
        {browserController && (
          // Desktop-only callout: the chrome-shim does not polyfill
          // `chrome.alarms`, so the auto-lock timer only runs while
          // the wallet window is open. A user who closes the wallet
          // does NOT relock until they reopen the app; make sure
          // they know. Tracked for a `WalletTimers` abstraction in
          // `@smirk/core/state/platform.ts`.
          <p
            style={{
              fontSize: 11,
              opacity: 0.7,
              margin: '6px 0 0',
              lineHeight: 1.4,
              color: 'var(--smirk-warn, #c69)',
            }}
          >
            Desktop: the auto-lock timer pauses while the wallet
            window is closed. Closing the window does not relock
            until you reopen it. Plan accordingly when stepping
            away from the device.
          </p>
        )}
      </section>

      {browserController && (
        // Desktop-only: surface the v0.3.0 known limitations a user
        // would otherwise blame on a bug. Notifications are silent
        // because chrome.notifications isn't polyfilled. Tracked
        // alongside auto-lock under `WalletTimers` /
        // `WalletNotifications` in `@smirk/core/state/platform.ts`.
        <section
          style={{
            marginTop: 20,
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
            Desktop limitations (v0.3.0)
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 16,
              fontSize: 11,
              opacity: 0.65,
              lineHeight: 1.5,
            }}
          >
            <li>
              Auto-lock pauses while the wallet window is closed
              (no background timer).
            </li>
            <li>
              Tip-arrival notifications are silent (no OS-level
              alerts). Check the Inbox tab for new tips.
            </li>
          </ul>
        </section>
      )}

      <section style={{ marginTop: 20 }}>
        <label
          style={{
            display: 'block',
            fontSize: 12,
            opacity: 0.8,
            marginBottom: 6,
          }}
        >
          Theme
        </label>
        <select
          value={themeId}
          onChange={(e) => void setThemeId((e.target as HTMLSelectElement).value)}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          {listThemes().map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </section>

      {/* Assets visibility: let the user curate which coins appear
          on Home, in choosers, and in balance polling. Hiding an
          asset never destroys access; the wallet still owns the keys.
          See docs/MULTI_ASSET_ARCHITECTURE.md for the long-form
          rationale + the polling cost savings. */}
      <AssetsVisibilityPanel sessionState={sessionState} />

      <section style={{ marginTop: 20 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            fontSize: 13,
            cursor: injectDisabled === null ? 'default' : 'pointer',
            lineHeight: 1.35,
          }}
        >
          <input
            type="checkbox"
            checked={injectDisabled === true}
            disabled={injectDisabled === null}
            onChange={(e) =>
              void toggleInjectDisabled((e.target as HTMLInputElement).checked)
            }
            style={{ marginTop: 2 }}
          />
          <span>
            Disable <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>window.smirk</code> on websites
          </span>
        </label>
        <p
          style={{
            fontSize: 11,
            opacity: 0.55,
            margin: '6px 0 0 24px',
            lineHeight: 1.4,
          }}
        >
          Prevents websites from detecting Smirk is installed. Breaks
          dapp integrations (smirk.cash login, tip claims, etc.).
          Takes effect on next page load for each tab.
        </p>
      </section>

      {/* Security section: fingerprint display, change-password
          flow, export-raw-keys panel. Three audit-flagged TODOs
          rolled into one Settings group. */}
      <SecurityPanel wallet={wallet} />

      {/* Cross-asset Sent Tips entry point. Per-asset history covers
          the day-to-day case (a few rows per coin); this is for
          finding a forgotten clawback-eligible tip across all 5
          chains in one view. Same affordances as the per-asset
          rows (Clawback + Discard Draft) but in a single list. */}
      <SettingsNavRow
        label="Sent Tips"
        hint="Cross-asset list of every tip you've sent + inline clawback"
        onClick={() => void navigate('settings/sent-tips')}
        testid="settings-sent-tips-nav"
      />

      {/* Nostr identity: link the seed-derived npub for "Sign in with Nostr"
          (NIP-98) on any Smirk-compatible backend (Identity Phase 1). */}
      <SettingsNavRow
        label="Nostr identity"
        hint="Link your seed-derived npub to sign in with Nostr"
        onClick={() => void navigate('settings/nostr')}
        testid="settings-nostr-nav"
      />


      {/* Backend selection: point the wallet at a self-hosted smirk-backend or
          another operator's for max privacy (self-sovereign). */}
      <SettingsNavRow
        label="Backend"
        hint="Choose which backend the wallet talks to (run your own for max privacy)"
        onClick={() => void navigate('settings/backend')}
        testid="settings-backend-nav"
      />

      <button
        onClick={() => void onLock()}
        data-testid="settings-lock-now-btn"
        style={{
          marginTop: 20,
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Lock wallet now
      </button>

      <section style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px', opacity: 0.85 }}>
          Danger zone
        </h3>
        <p style={{ fontSize: 11, opacity: 0.55, margin: '0 0 10px', lineHeight: 1.4 }}>
          Deleting this wallet wipes its encrypted keystore from this device. You
          can only recover with your 12-word recovery phrase.
        </p>
        {!forgetOpen ? (
          <button
            onClick={() => setForgetOpen(true)}
            style={{
              padding: '8px 14px',
              background: 'rgba(239, 68, 68, 0.10)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: 6,
              color: '#ef4444',
              fontFamily: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Forget this wallet…
          </button>
        ) : (
          <ForgetWalletFlow
            onCancel={() => setForgetOpen(false)}
            onConfirmed={onForgetComplete}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Three-gate destructive confirmation for "Forget wallet":
 *
 *   1. Warning panel (acknowledge what's about to happen)
 *   2. Checkbox: "I have my recovery phrase written down"
 *   3. Type-to-confirm: type the word `FORGET` to enable the
 *      destructive button
 *
 * Order matters: each gate clears the next, in sequence. Nothing
 * about this needs to be slick; this is the one place in the app
 * where friction is the feature.
 */
function ForgetWalletFlow({
  onCancel,
  onConfirmed,
}: {
  onCancel: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const CONFIRM_WORD = 'FORGET';
  const typedMatches = typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <div
      style={{
        background: 'rgba(239, 68, 68, 0.06)',
        border: '1px solid rgba(239, 68, 68, 0.3)',
        borderRadius: 8,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ef4444', marginBottom: 6 }}>
          ⚠ Forget this wallet
        </div>
        <p style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: 0 }}>
          This <strong>permanently deletes</strong> the encrypted keystore from
          this device. Smirk cannot recover it for you — there is no support
          channel that can.
        </p>
        <p style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: '8px 0 0' }}>
          You can only restore from your <strong>12-word recovery phrase</strong>.
          If you don't have your phrase written down somewhere safe right now,
          <strong> all coins in this wallet will be lost forever.</strong>
        </p>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          fontSize: 12,
          cursor: 'pointer',
          opacity: 0.9,
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged((e.target as HTMLInputElement).checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          I have my 12-word recovery phrase written down somewhere safe.
        </span>
      </label>

      <div style={{ opacity: acknowledged ? 1 : 0.4, pointerEvents: acknowledged ? 'auto' : 'none' }}>
        <label style={{ display: 'block', fontSize: 11, opacity: 0.75, marginBottom: 4 }}>
          To confirm, type <strong>{CONFIRM_WORD}</strong> below:
        </label>
        <input
          type="text"
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder={CONFIRM_WORD}
          style={{
            width: '100%',
            padding: '8px 10px',
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6,
            color: 'inherit',
            fontFamily: 'monospace',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            letterSpacing: '0.1em',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: '8px 14px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 6,
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 13,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          disabled={!acknowledged || !typedMatches || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirmed();
            } finally {
              setBusy(false);
            }
          }}
          style={{
            padding: '8px 14px',
            background:
              !acknowledged || !typedMatches
                ? 'rgba(239, 68, 68, 0.10)'
                : '#ef4444',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            borderRadius: 6,
            color:
              !acknowledged || !typedMatches ? 'rgba(239, 68, 68, 0.6)' : '#fff',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor:
              !acknowledged || !typedMatches || busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Forgetting…' : 'Permanently forget wallet'}
        </button>
      </div>
    </div>
  );
}
