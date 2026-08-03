/**
 * `@smirk/keymap`: cross-platform keyboard-shortcut registry.
 *
 * See [docs/ACCESSIBILITY.md#keyboard-map](../../../docs/ACCESSIBILITY.md#keyboard-map)
 * for the rationale and conventions.
 */

export type {
  KeymapAction,
  KeymapEntry,
  KeymapPlatform,
  KeyChord,
  PlatformBinding,
} from './types';

export type { KeymapHost } from './keymap';
export {
  DEFAULT_KEYMAP,
  actionsFromEvent,
  chordMatches,
  detectPlatform,
  lookup,
} from './keymap';
