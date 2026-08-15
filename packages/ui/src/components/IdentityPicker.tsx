/**
 * Identity avatar + picker: the shared "who am I acting as" control used by the
 * Feed composer and each DM thread (per-conversation/context identities).
 *
 * North stars: ACCESSIBLE (a real listbox: keyboard operable, labelled, focus-
 * managed) and COOL (a deterministic blockies-style avatar so every identity has a
 * recognizable face). Presentational only: the consumer supplies the identity list +
 * the current selection + an onSelect; resolving keys stays in the wallet.
 *
 * An identity is named by what the user recognizes: their private label, else the
 * public handle they claimed (`name@domain`), else the npub. A wallet whose only
 * identity is the seed default has neither a label nor anything else on screen, so
 * before handles reached here it announced the user as `npub1abcd…wxyz`: a name they
 * cannot read, share, or check against the one they just reserved.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

export type IdentitySource = 'derived' | 'burner' | 'imported' | 'per-origin';

export interface PickerIdentity {
  /** x-only pubkey hex: the stable id. */
  pubkeyHex: string;
  /** NIP-19 npub, for display + the recognizable face. */
  npub: string;
  /** Private local label (never published). */
  label?: string;
  source?: IdentitySource;
  /**
   * Public Smirk handle (`name@domain`) THIS identity owns, when it owns one.
   * Set it ONLY on the identity the handle actually resolves to. Lending the main
   * identity's handle to a burner row would both tie the two together on screen and
   * name the burner something that no payment to it would ever reach.
   */
  handle?: string;
  /**
   * True while this identity's handle is still being read back. Set it on the
   * identity that could own one, so the control holds a neutral placeholder instead
   * of an npub it would swap out a frame later.
   */
  handleLoading?: boolean;
}

const SOURCE_META: Record<IdentitySource, { text: string; hue: number }> = {
  derived: { text: 'seed', hue: 145 },
  burner: { text: 'burner', hue: 32 },
  imported: { text: 'imported', hue: 265 },
  'per-origin': { text: 'per-site', hue: 205 },
};

/** npub1abcd…wxyz: compact, monospace-friendly. */
export function shortNpubDisplay(npub: string): string {
  return npub.length > 18 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub;
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16) || 0);
  return out.length ? out : [0];
}

/**
 * Deterministic blockies-style avatar: a left-right-symmetric 5×5 block pattern +
 * a two-tone palette, all derived from the pubkey, so an identity always looks the
 * same and different identities look different at a glance.
 */
export function IdentityAvatar({
  pubkeyHex,
  size = 22,
  title,
}: {
  pubkeyHex: string;
  size?: number;
  title?: string;
}) {
  const b = hexBytes(pubkeyHex);
  const hue = ((b[0] ?? 0) / 256) * 360;
  const bg = `hsl(${hue}, 58%, 20%)`;
  const fg = `hsl(${(hue + 42) % 360}, 82%, 64%)`;
  const cell = size / 5;
  const rects: preact.JSX.Element[] = [];
  // Decide the left 3 columns (0,1,2); mirror 0->4 and 1->3 for symmetry.
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const byte = b[(y * 3 + x) % b.length] ?? 0;
      if ((byte >> ((y + x) % 7)) & 1) {
        const cols = x === 2 ? [2] : [x, 4 - x];
        for (const cx of cols) {
          rects.push(
            <rect key={`${cx}-${y}`} x={cx * cell} y={y * cell} width={cell + 0.5} height={cell + 0.5} fill={fg} />,
          );
        }
      }
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-hidden={title ? undefined : true}
      {...(title ? { 'aria-label': title } : {})}
      style={{ borderRadius: size * 0.3, background: bg, flex: '0 0 auto', display: 'block' }}
    >
      {rects}
    </svg>
  );
}

function SourceBadge({ source }: { source?: IdentitySource }) {
  if (!source) return null;
  const m = SOURCE_META[source];
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '1px 5px',
        borderRadius: 999,
        color: `hsl(${m.hue}, 80%, 72%)`,
        background: `hsl(${m.hue}, 60%, 20%)`,
        whiteSpace: 'nowrap',
      }}
    >
      {m.text}
    </span>
  );
}

/**
 * `name@domain` → `@name`, for the trigger pill only. The pill is ~135px of text,
 * so a full handle is cut mid-name by the ellipsis; the domain is the part that can
 * be dropped. The full form stays in the list below and in the accessible name.
 */
function shortHandleDisplay(handle: string): string {
  const at = handle.lastIndexOf('@');
  return `@${at > 0 ? handle.slice(0, at) : handle}`;
}

/**
 * What to CALL this identity, most-recognizable first: the private label the user
 * chose, else the handle they claimed, else the npub. `null` means "not known yet"
 * (the handle is still resolving), which the caller renders as a placeholder.
 */
function displayName(id: PickerIdentity, short = false): string | null {
  if (id.label) return id.label;
  if (id.handle) return short ? shortHandleDisplay(id.handle) : id.handle;
  if (id.handleLoading) return null;
  return shortNpubDisplay(id.npub);
}

/** Spoken stand-in while the handle read is in flight (the pill shows a bar). */
const NAME_LOADING = 'loading your handle';

/**
 * Placeholder for a name we do not have yet. Deliberately not the npub: showing the
 * npub here would be replaced by the handle a moment later, and a name that changes
 * under the user is exactly what makes it untrustworthy.
 */
function NamePlaceholder({ width = 64 }: { width?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width,
        height: 8,
        borderRadius: 4,
        background: 'currentColor',
        opacity: 0.25,
        flex: '0 0 auto',
      }}
    />
  );
}

/**
 * The acting-identity control: a compact pill (avatar + label + chevron) that opens
 * an accessible listbox. Keyboard: Enter/Space/↓ open; ↑/↓ move; Enter/Space select;
 * Esc/Tab close; focus returns to the pill on close.
 */
export function IdentityPicker({
  identities,
  selectedPubkey,
  onSelect,
  label = 'Acting as',
  compact = false,
  class: className,
  testid,
  onManage,
  manageLabel = 'Manage identities…',
}: {
  identities: PickerIdentity[];
  selectedPubkey: string;
  onSelect: (pubkeyHex: string) => void;
  /** Screen-reader prefix, e.g. "Posting as" / "Messaging as". */
  label?: string;
  compact?: boolean;
  class?: string;
  /** Optional data-testid on the trigger button (for e2e). */
  testid?: string;
  /**
   * Optional footer action. When set, the dropdown gains a final
   * "Manage identities…" option and the trigger stays interactive even with a
   * single identity (so a fresh, one-identity wallet can still reach the hub).
   */
  onManage?: () => void;
  manageLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected =
    identities.find((i) => i.pubkeyHex === selectedPubkey) ?? identities[0];
  const selIdx = Math.max(0, identities.findIndex((i) => i.pubkeyHex === selectedPubkey));

  // The Manage action (when present) is a virtual option at index === length,
  // so it participates in keyboard nav / aria-activedescendant like any option.
  const single = identities.length <= 1;
  const interactive = !single || !!onManage;
  const optCount = identities.length + (onManage ? 1 : 0);

  // Close on outside click / focus leaving.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Move focus into the list when opened (to the selected option).
  useEffect(() => {
    if (open) {
      setActiveIdx(selIdx);
      requestAnimationFrame(() => listRef.current?.focus());
    }
  }, [open, selIdx]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const choose = (idx: number) => {
    if (onManage && idx === identities.length) {
      close();
      onManage();
      return;
    }
    const id = identities[idx];
    if (id) onSelect(id.pubkeyHex);
    close();
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIdx((i) => Math.min(optCount - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIdx(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIdx(optCount - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(activeIdx);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  if (!selected) return null;

  // Two forms of the same name: the pill shows `@name` (it has ~135px), while the
  // accessible name keeps `name@domain`, because the domain is what makes a handle
  // verifiable and a screen-reader user has no list row to fall back on.
  const selectedName = displayName(selected, true);
  const spokenName = displayName(selected) ?? NAME_LOADING;

  return (
    <div ref={rootRef} class={className} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        {...(testid ? { 'data-testid': testid } : {})}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label} ${spokenName}${interactive ? '. Activate to change or manage identities.' : ''}`}
        aria-busy={selectedName === null}
        disabled={!interactive}
        onClick={() => interactive && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (interactive && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '3px 8px 3px 4px' : '4px 10px 4px 5px',
          borderRadius: 999,
          border: '1px solid var(--smirk-border)',
          background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.04))',
          color: 'inherit',
          cursor: interactive ? 'pointer' : 'default',
          font: 'inherit',
          fontSize: compact ? 11 : 12,
          maxWidth: 200,
        }}
      >
        <IdentityAvatar pubkeyHex={selected.pubkeyHex} size={compact ? 18 : 20} />
        {selectedName === null ? (
          <NamePlaceholder />
        ) : (
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedName}
          </span>
        )}
        {interactive && (
          <span aria-hidden="true" style={{ opacity: 0.6, fontSize: 10 }}>
            ▾
          </span>
        )}
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Choose identity"
          aria-activedescendant={`idpick-opt-${activeIdx}`}
          onKeyDown={onListKeyDown}
          style={{
            position: 'absolute',
            zIndex: 20,
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 240,
            maxHeight: 280,
            overflowY: 'auto',
            margin: 0,
            padding: 4,
            listStyle: 'none',
            borderRadius: 12,
            border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
            background: 'var(--smirk-bg-sunken, var(--smirk-bg))',
            boxShadow: 'var(--smirk-shadow-raised, 0 8px 24px rgba(0,0,0,0.35))',
            outline: 'none',
          }}
        >
          {identities.map((id, idx) => {
            const active = idx === activeIdx;
            const isSel = id.pubkeyHex === selectedPubkey;
            const name = displayName(id);
            return (
              <li
                key={id.pubkeyHex}
                id={`idpick-opt-${idx}`}
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => choose(idx)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? 'var(--smirk-bg-elevated, rgba(255,255,255,0.06))' : 'transparent',
                }}
              >
                <IdentityAvatar pubkeyHex={id.pubkeyHex} size={26} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {name === null ? (
                      <NamePlaceholder width={96} />
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {name}
                      </span>
                    )}
                    {id.source ? <SourceBadge source={id.source} /> : null}
                  </span>
                  {/* A private label outranks the handle on the name line, so show
                      the handle here instead of dropping it: it is the address other
                      people pay, and only the full `name@domain` is worth sharing. */}
                  {id.handle && id.handle !== name ? (
                    <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {id.handle}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', fontFamily: 'var(--smirk-font-family-mono, monospace)' }}>
                    {shortNpubDisplay(id.npub)}
                  </span>
                </span>
                <span aria-hidden="true" style={{ width: 16, color: 'var(--smirk-accent)', fontWeight: 700 }}>
                  {isSel ? '✓' : ''}
                </span>
              </li>
            );
          })}
          {onManage && (
            <li
              id={`idpick-opt-${identities.length}`}
              role="option"
              aria-selected={false}
              onMouseEnter={() => setActiveIdx(identities.length)}
              onClick={() => choose(identities.length)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                marginTop: 4,
                borderTop: '1px solid var(--smirk-border)',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'var(--smirk-accent)',
                fontSize: 13,
                fontWeight: 600,
                background:
                  activeIdx === identities.length
                    ? 'var(--smirk-bg-elevated, rgba(255,255,255,0.06))'
                    : 'transparent',
              }}
            >
              <span aria-hidden="true" style={{ width: 26, textAlign: 'center', fontSize: 16 }}>
                ⚙
              </span>
              <span>{manageLabel}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
