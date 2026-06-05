/**
 * Cross-platform keyboard-shortcut action set + binding model.
 *
 * Actions are platform-agnostic verbs ("focus the URL bar"). Bindings
 * are the per-platform key sequences that trigger them ("Cmd+L" on
 * macOS, "Ctrl+L" on Windows / Linux, an in-app button on mobile
 * because mobile keyboards lack modifier rails).
 *
 * For the rationale see
 * [docs/ACCESSIBILITY.md#keyboard-map](../../../docs/ACCESSIBILITY.md#keyboard-map).
 */

// ======================================================================
// Actions
// ======================================================================

/**
 * Every keyboard-shortcut action recognised by the wallet UI. Adding
 * a shortcut is a two-step process: append to this enum, then declare
 * its per-platform bindings in `keymap.ts`.
 *
 * Action names use the namespaced `domain:verb-noun` convention so
 * the enum scales without collisions as more surfaces grow shortcuts.
 *
 * **Stability:** the string values are persisted in user preference
 * storage when the user remaps keys, so they MUST NOT change in
 * breaking ways. Add new actions; do not rename existing ones.
 */
export type KeymapAction =
  // -------- Browser chrome --------
  | 'browser:focus-url-bar'
  | 'browser:new-tab'
  | 'browser:close-tab'
  | 'browser:next-tab'
  | 'browser:previous-tab'
  | 'browser:reload'
  | 'browser:go-back'
  | 'browser:go-forward'
  // -------- Wallet shell --------
  | 'wallet:lock'
  | 'wallet:refresh-balances'
  | 'wallet:open-settings'
  | 'wallet:switch-tab-home'
  | 'wallet:switch-tab-swap'
  | 'wallet:switch-tab-inbox'
  | 'wallet:switch-tab-settings';

// ======================================================================
// Binding model
// ======================================================================

/**
 * A single key combination. Modifier flags are platform-meaningful as
 * declared per binding (see {@link PlatformBinding}). The `key`
 * property is a `KeyboardEvent.key` value when the binding fires from
 * a keyboard, or an opaque string for non-keyboard triggers (e.g. a
 * touch gesture name on mobile).
 */
export interface KeyChord {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/**
 * A platform-targeted binding. `platform` identifies the host the
 * binding applies to. A single action may declare multiple bindings
 * on the same platform (e.g. both `Cmd+R` and `F5` for reload on
 * desktop).
 */
export interface PlatformBinding {
  readonly platform: KeymapPlatform;
  readonly chord: KeyChord;
}

/**
 * Host environments the keymap recognises. Mobile platforms split
 * iOS / Android because system-gesture conventions differ.
 */
export type KeymapPlatform =
  | 'extension-mac'
  | 'extension-win'
  | 'extension-linux'
  | 'desktop-mac'
  | 'desktop-win'
  | 'desktop-linux'
  | 'mobile-ios'
  | 'mobile-android';

/**
 * Complete entry for a single action: the verb, a human-readable
 * label (used for in-app help and settings), and the list of
 * platform-specific bindings.
 */
export interface KeymapEntry {
  readonly action: KeymapAction;
  /**
   * Short human-readable label, e.g. "Focus address bar". Goes
   * through `t()` for localization when consumed by UI.
   */
  readonly label: string;
  readonly bindings: readonly PlatformBinding[];
}
