/**
 * The default keymap shipped with Smirk.
 *
 * Conventions:
 *
 * - Desktop / extension uses the platform's primary modifier: Cmd on
 *   macOS, Ctrl on Windows / Linux. The two are usually equivalent
 *   user expectations on each platform; we don't share a binding
 *   between them.
 * - Mobile platforms typically do not declare bindings here: mobile
 *   keyboards lack reliable modifier rails and most users drive the
 *   wallet by touch. The few mobile chords that exist are gesture
 *   names, not key codes; consumed by the mobile-platform glue.
 * - A single action MAY declare multiple bindings on the same
 *   platform (e.g. `F5` and `Ctrl+R` for reload). They all trigger
 *   the same action.
 *
 * To add a shortcut: add the action to `KeymapAction` in `types.ts`,
 * then append a `KeymapEntry` here. Consumers find shortcuts by
 * action via `lookup()`.
 */

import type {
  KeyChord,
  KeymapAction,
  KeymapEntry,
  KeymapPlatform,
  PlatformBinding,
} from './types';

// ======================================================================
// Helpers for building bindings
// ======================================================================

const macMod = (key: string, shift = false): PlatformBinding => ({
  platform: 'desktop-mac',
  chord: { key, meta: true, ...(shift ? { shift: true } : {}) },
});

const winMod = (key: string, shift = false): PlatformBinding => ({
  platform: 'desktop-win',
  chord: { key, ctrl: true, ...(shift ? { shift: true } : {}) },
});

const linuxMod = (key: string, shift = false): PlatformBinding => ({
  platform: 'desktop-linux',
  chord: { key, ctrl: true, ...(shift ? { shift: true } : {}) },
});

const extMac = (key: string): PlatformBinding => ({
  platform: 'extension-mac',
  chord: { key, meta: true },
});

const extWin = (key: string): PlatformBinding => ({
  platform: 'extension-win',
  chord: { key, ctrl: true },
});

const extLinux = (key: string): PlatformBinding => ({
  platform: 'extension-linux',
  chord: { key, ctrl: true },
});

/**
 * Generate desktop bindings for all three desktop platforms with the
 * same key. The vast majority of shortcuts follow this pattern.
 */
const desktopTrio = (key: string, shift = false): PlatformBinding[] => [
  macMod(key, shift),
  winMod(key, shift),
  linuxMod(key, shift),
];

/**
 * Generate extension bindings for all three host OSes with the same
 * key.
 */
const extensionTrio = (key: string): PlatformBinding[] => [
  extMac(key),
  extWin(key),
  extLinux(key),
];

// ======================================================================
// Default keymap
// ======================================================================

export const DEFAULT_KEYMAP: readonly KeymapEntry[] = [
  // -------- Browser chrome --------
  {
    action: 'browser:focus-url-bar',
    label: 'Focus address bar',
    bindings: [...desktopTrio('l'), ...extensionTrio('l')],
  },
  {
    action: 'browser:new-tab',
    label: 'New tab',
    bindings: [...desktopTrio('t'), ...extensionTrio('t')],
  },
  {
    action: 'browser:close-tab',
    label: 'Close tab',
    bindings: [...desktopTrio('w'), ...extensionTrio('w')],
  },
  {
    action: 'browser:next-tab',
    label: 'Next tab',
    // Cmd/Ctrl+Tab is reserved by the OS for window switching on
    // macOS; we use Cmd+Alt+Right / Ctrl+PageDown to avoid the
    // conflict. PageDown is the canonical Windows convention.
    bindings: [
      { platform: 'desktop-mac', chord: { key: 'ArrowRight', meta: true, alt: true } },
      { platform: 'desktop-win', chord: { key: 'PageDown', ctrl: true } },
      { platform: 'desktop-linux', chord: { key: 'PageDown', ctrl: true } },
    ],
  },
  {
    action: 'browser:previous-tab',
    label: 'Previous tab',
    bindings: [
      { platform: 'desktop-mac', chord: { key: 'ArrowLeft', meta: true, alt: true } },
      { platform: 'desktop-win', chord: { key: 'PageUp', ctrl: true } },
      { platform: 'desktop-linux', chord: { key: 'PageUp', ctrl: true } },
    ],
  },
  {
    action: 'browser:reload',
    label: 'Reload page',
    bindings: [
      ...desktopTrio('r'),
      // F5 is the universal reload key across web browsers and
      // expected by users.
      { platform: 'desktop-mac', chord: { key: 'F5' } },
      { platform: 'desktop-win', chord: { key: 'F5' } },
      { platform: 'desktop-linux', chord: { key: 'F5' } },
    ],
  },
  {
    action: 'browser:go-back',
    label: 'Go back',
    bindings: [
      { platform: 'desktop-mac', chord: { key: 'ArrowLeft', meta: true } },
      { platform: 'desktop-win', chord: { key: 'ArrowLeft', alt: true } },
      { platform: 'desktop-linux', chord: { key: 'ArrowLeft', alt: true } },
    ],
  },
  {
    action: 'browser:go-forward',
    label: 'Go forward',
    bindings: [
      { platform: 'desktop-mac', chord: { key: 'ArrowRight', meta: true } },
      { platform: 'desktop-win', chord: { key: 'ArrowRight', alt: true } },
      { platform: 'desktop-linux', chord: { key: 'ArrowRight', alt: true } },
    ],
  },

  // -------- Wallet shell --------
  {
    action: 'wallet:lock',
    label: 'Lock wallet',
    // Shifted: unshifted Cmd/Ctrl+L is the address-bar binding above.
    bindings: [...desktopTrio('l', true), ...extensionTrio('L')],
  },
  {
    action: 'wallet:refresh-balances',
    label: 'Refresh balances',
    // Reload (Cmd+R) is taken by the browser; for the wallet itself
    // we use Shift+Cmd+R to mean "refresh wallet state".
    bindings: [...desktopTrio('r', true), ...extensionTrio('R')],
  },
  {
    action: 'wallet:open-settings',
    label: 'Open Settings',
    bindings: [
      { platform: 'desktop-mac', chord: { key: ',', meta: true } },
      { platform: 'desktop-win', chord: { key: ',', ctrl: true } },
      { platform: 'desktop-linux', chord: { key: ',', ctrl: true } },
    ],
  },
  {
    action: 'wallet:switch-tab-home',
    label: 'Switch to Home',
    bindings: [...desktopTrio('1'), ...extensionTrio('1')],
  },
  {
    action: 'wallet:switch-tab-swap',
    label: 'Switch to Swap',
    bindings: [...desktopTrio('2'), ...extensionTrio('2')],
  },
  {
    action: 'wallet:switch-tab-inbox',
    label: 'Switch to Inbox',
    bindings: [...desktopTrio('3'), ...extensionTrio('3')],
  },
  {
    action: 'wallet:switch-tab-settings',
    label: 'Switch to Settings',
    bindings: [...desktopTrio('4'), ...extensionTrio('4')],
  },
];

// ======================================================================
// Lookup helpers
// ======================================================================

/**
 * Find the bindings for an action on a given platform. Returns an
 * empty array if the action has no bindings on that platform; that
 * is a normal state (mobile platforms typically have few bindings)
 * and not an error.
 */
export function lookup(
  action: KeymapAction,
  platform: KeymapPlatform,
  keymap: readonly KeymapEntry[] = DEFAULT_KEYMAP,
): readonly PlatformBinding[] {
  const entry = keymap.find((e) => e.action === action);
  if (!entry) return [];
  return entry.bindings.filter((b) => b.platform === platform);
}

/**
 * Detect the current platform from runtime signals. The host
 * environment is provided as a hint (extension popup, desktop
 * window, mobile webview) because no single runtime check
 * disambiguates "extension on macOS" vs "desktop on macOS". Pass
 * the host explicitly from the platform's wallet shell.
 */
export function detectPlatform(host: KeymapHost): KeymapPlatform {
  const os = detectOs();
  return `${host}-${os}` as KeymapPlatform;
}

export type KeymapHost = 'extension' | 'desktop' | 'mobile';

function detectOs(): 'mac' | 'win' | 'linux' | 'ios' | 'android' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'win';
  return 'linux';
}

/**
 * Check whether a given `KeyboardEvent` matches a `KeyChord`. Useful
 * for the platform-side keymap listener: consumes a raw DOM event
 * and reports the action(s) that fired.
 */
export function chordMatches(event: KeyboardEvent, chord: KeyChord): boolean {
  if (event.key !== chord.key) return false;
  if (!!chord.ctrl !== event.ctrlKey) return false;
  if (!!chord.meta !== event.metaKey) return false;
  if (!!chord.alt !== event.altKey) return false;
  if (!!chord.shift !== event.shiftKey) return false;
  return true;
}

/**
 * Given a fired `KeyboardEvent`, return every action whose binding on
 * this platform matches. Usually one action fires, but the model
 * supports overlap if a future custom keymap defines collisions.
 */
export function actionsFromEvent(
  event: KeyboardEvent,
  platform: KeymapPlatform,
  keymap: readonly KeymapEntry[] = DEFAULT_KEYMAP,
): KeymapAction[] {
  const out: KeymapAction[] = [];
  for (const entry of keymap) {
    for (const binding of entry.bindings) {
      if (binding.platform !== platform) continue;
      if (chordMatches(event, binding.chord)) {
        out.push(entry.action);
        break;
      }
    }
  }
  return out;
}
