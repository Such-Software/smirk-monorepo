/**
 * `RevealKeysPanel` — surface every cryptographic identifier Smirk
 * derives from the unlocked seed, behind a "Reveal" gate per dangerous
 * field.
 *
 * Why expose all of this:
 *   - The BTC pubkey hash is what `TEST_POW_REQUIRED_FOR_PUBKEYS` on
 *     the backend wants — without surfacing it somewhere, the only way
 *     to opt your wallet into the PoW gate is to grep the backend logs
 *     (which truncate at the first 16 chars).
 *   - Power users moving funds to / from other wallets need WIFs for
 *     BTC/LTC and the spend key for XMR/WOW.
 *   - Auditors / staff / forum verifiers may want a public view key for
 *     a CryptoNote address.
 *
 * Threat model: the wallet is already unlocked when this renders — the
 * keys live in memory either way. The "Reveal" gate is a shoulder-surf
 * defence, not a cryptographic gate. Private spend keys carry a second
 * "I understand" tap so a misclick doesn't paint your seed value on
 * screen.
 *
 * Address-reuse caveat for BTC/LTC xpubs: Smirk currently uses one
 * address per asset (the first derivation under BIP84). xpubs / zpubs
 * derived from the same seed are out of scope here — adding them would
 * surface that other wallets could derive additional addresses, which
 * is technically true and creates a confusing UX where "my Smirk
 * balance" diverges from "this xpub's balance". Tracked for v0.3.x
 * once we either ship multi-address derivation or wire a clear
 * disclaimer.
 */

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

/**
 * Minimal shape this panel needs from the unlocked wallet. Subset of
 * `@smirk/core::UnlockedWallet` — we don't import the type directly to
 * keep `@smirk/ui` zero-dependency on `@smirk/core`. The host wallet
 * narrows the type at the call site.
 */
export interface RevealKeysPanelWallet {
  readonly addresses: {
    readonly btc: string;
    readonly ltc: string;
    readonly xmr: string;
    readonly wow: string;
    readonly grin: string;
  };
  readonly keys: {
    readonly btc: { privateKey: Uint8Array; publicKey: Uint8Array };
    readonly ltc: { privateKey: Uint8Array; publicKey: Uint8Array };
    readonly xmr: {
      privateSpendKey: Uint8Array;
      privateViewKey: Uint8Array;
      publicSpendKey: Uint8Array;
      publicViewKey: Uint8Array;
    };
    readonly wow: {
      privateSpendKey: Uint8Array;
      privateViewKey: Uint8Array;
      publicSpendKey: Uint8Array;
      publicViewKey: Uint8Array;
    };
    readonly grin: { privateKey: Uint8Array; publicKey: Uint8Array };
  };
}

export interface RevealKeysPanelProps {
  readonly wallet: RevealKeysPanelWallet;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += b[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(buf));
}

// ============================================================================
// Field components
// ============================================================================

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard write can fail on some packaged environments
          // (Tauri without permission). Silent — the value is still
          // visible to copy manually.
        }
      }}
      style={{
        padding: '4px 10px',
        background: copied ? 'var(--smirk-accent, #8b5cf6)' : 'rgba(255,255,255,0.06)',
        color: copied ? 'var(--smirk-accent-fg, #fff)' : 'inherit',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 4,
        fontSize: 11,
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function FieldRow({
  label,
  value,
  note,
  monoSize = 11,
}: {
  label: string;
  value: string;
  note?: string;
  monoSize?: number;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 11, opacity: 0.75 }}>{label}</span>
        <CopyButton value={value} label={label} />
      </div>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: monoSize,
          background: 'rgba(0,0,0,0.25)',
          padding: '6px 8px',
          borderRadius: 4,
          wordBreak: 'break-all',
          lineHeight: 1.4,
        }}
      >
        {value}
      </div>
      {note && (
        <div
          style={{
            fontSize: 10,
            opacity: 0.55,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

function RevealRow({
  label,
  value,
  note,
  danger = false,
}: {
  label: string;
  value: string;
  note?: string;
  danger?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [confirmed, setConfirmed] = useState(!danger);
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          {label} {danger && <span style={{ color: '#ef4444' }}>(spend access)</span>}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              if (!confirmed) return;
              setShown((s) => !s);
            }}
            disabled={!confirmed}
            style={{
              padding: '4px 10px',
              background: shown ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.06)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'inherit',
              cursor: confirmed ? 'pointer' : 'not-allowed',
              opacity: confirmed ? 1 : 0.4,
            }}
          >
            {shown ? 'Hide' : 'Reveal'}
          </button>
          {shown && <CopyButton value={value} label={label} />}
        </div>
      </div>
      {danger && !confirmed && (
        <button
          type="button"
          onClick={() => setConfirmed(true)}
          style={{
            width: '100%',
            padding: '8px',
            background: 'rgba(239,68,68,0.10)',
            color: '#ef4444',
            border: '1px solid rgba(239,68,68,0.30)',
            borderRadius: 4,
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer',
            marginBottom: 4,
          }}
        >
          I understand revealing this gives full access to my {label.toLowerCase()}.
          Tap to enable.
        </button>
      )}
      {shown && (
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            background: danger ? 'rgba(239,68,68,0.10)' : 'rgba(0,0,0,0.25)',
            padding: '6px 8px',
            borderRadius: 4,
            wordBreak: 'break-all',
            lineHeight: 1.4,
            border: danger ? '1px solid rgba(239,68,68,0.20)' : 'none',
          }}
        >
          {value}
        </div>
      )}
      {note && (
        <div
          style={{
            fontSize: 10,
            opacity: 0.55,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ComponentChildren;
}) {
  return (
    <section
      style={{
        marginTop: 20,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 6,
      }}
    >
      <h3 style={{ fontSize: 13, margin: '0 0 4px', fontWeight: 600 }}>{title}</h3>
      {subtitle && (
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 12, lineHeight: 1.4 }}>
          {subtitle}
        </div>
      )}
      {children}
    </section>
  );
}

// ============================================================================
// Main panel
// ============================================================================

/**
 * Renders every cryptographic identifier the unlocked wallet exposes.
 * Caller decides where to mount it; expected home is Settings →
 * Advanced.
 */
export function RevealKeysPanel(props: RevealKeysPanelProps): JSX.Element {
  const { wallet } = props;
  const [powHash, setPowHash] = useState<string>('…');

  useEffect(() => {
    void (async () => {
      // Backend hashes the BTC pubkey hex string with SHA-256. Mirror
      // exactly so the value here pastes verbatim into
      // TEST_POW_REQUIRED_FOR_PUBKEYS on the server.
      const pubkeyHex = bytesToHex(wallet.keys.btc.publicKey);
      const hash = await sha256Hex(pubkeyHex);
      setPowHash(hash);
    })();
  }, [wallet]);

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Export keys</h2>

      <div
        style={{
          padding: '10px 12px',
          background: 'rgba(239,68,68,0.10)',
          border: '1px solid rgba(239,68,68,0.30)',
          borderRadius: 6,
          color: '#ef4444',
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        <strong>Private keys give full control of your funds.</strong> Anyone
        with a private key can move your money. Don&rsquo;t paste them into
        Telegram, Discord, support emails, or any web form. Use{' '}
        <em>Reveal</em> only on a device you trust, alone.
      </div>

      {/* PoW gate hash — front and centre since it's the v0.3.x rollout tool. */}
      <Section
        title="Smirk PoW gate hash"
        subtitle="Drop this into TEST_POW_REQUIRED_FOR_PUBKEYS on the backend to make YOUR wallet require a proof-of-work solution while leaving POW_REQUIRED=false globally. Used during the pre-flip safety test (see backend README)."
      >
        <FieldRow label="BTC pubkey hash (SHA-256 of pubkey hex)" value={powHash} />
      </Section>

      {/* BTC */}
      <Section title="Bitcoin (BTC)">
        <FieldRow label="Address" value={wallet.addresses.btc} />
        <FieldRow label="Public key (hex)" value={bytesToHex(wallet.keys.btc.publicKey)} />
        <RevealRow
          label="Private key"
          value={bytesToHex(wallet.keys.btc.privateKey)}
          note="Raw 32-byte secp256k1 private key, hex-encoded. To import into Electrum or another BTC wallet you may need to convert to WIF format first."
          danger
        />
      </Section>

      {/* LTC */}
      <Section title="Litecoin (LTC)">
        <FieldRow label="Address" value={wallet.addresses.ltc} />
        <FieldRow label="Public key (hex)" value={bytesToHex(wallet.keys.ltc.publicKey)} />
        <RevealRow
          label="Private key"
          value={bytesToHex(wallet.keys.ltc.privateKey)}
          note="Raw 32-byte secp256k1 private key, hex-encoded. Same caveat as BTC for external-wallet import."
          danger
        />
      </Section>

      {/* XMR */}
      <Section title="Monero (XMR)" subtitle="CryptoNote dual-key model: spend key controls funds, view key only scans incoming transactions.">
        <FieldRow label="Address" value={wallet.addresses.xmr} />
        <FieldRow
          label="Public spend key"
          value={bytesToHex(wallet.keys.xmr.publicSpendKey)}
        />
        <FieldRow
          label="Public view key"
          value={bytesToHex(wallet.keys.xmr.publicViewKey)}
        />
        <RevealRow
          label="Private view key"
          value={bytesToHex(wallet.keys.xmr.privateViewKey)}
          note="Safe to share with accountants / watchers — gives read-only visibility but not spend access."
        />
        <RevealRow
          label="Private spend key"
          value={bytesToHex(wallet.keys.xmr.privateSpendKey)}
          note="Gives full spend control. Use to restore in Monero GUI / Feather."
          danger
        />
      </Section>

      {/* WOW */}
      <Section title="Wownero (WOW)" subtitle="Same dual-key model as XMR.">
        <FieldRow label="Address" value={wallet.addresses.wow} />
        <FieldRow
          label="Public spend key"
          value={bytesToHex(wallet.keys.wow.publicSpendKey)}
        />
        <FieldRow
          label="Public view key"
          value={bytesToHex(wallet.keys.wow.publicViewKey)}
        />
        <RevealRow
          label="Private view key"
          value={bytesToHex(wallet.keys.wow.privateViewKey)}
          note="Watch-only access. Pair with public spend key to make a view-only Wownero wallet."
        />
        <RevealRow
          label="Private spend key"
          value={bytesToHex(wallet.keys.wow.privateSpendKey)}
          note="Use to restore in Wownero GUI."
          danger
        />
      </Section>

      {/* GRIN */}
      <Section title="Grin (GRIN)" subtitle="Mimblewimble — one ed25519 keypair for the slatepack identity.">
        <FieldRow label="Slatepack address" value={wallet.addresses.grin} monoSize={10} />
        <FieldRow
          label="Public key"
          value={bytesToHex(wallet.keys.grin.publicKey)}
        />
        <RevealRow
          label="Private key"
          value={bytesToHex(wallet.keys.grin.privateKey)}
          note="Ed25519 root scalar. Use with grin-wallet's restore flow."
          danger
        />
      </Section>
    </div>
  );
}
