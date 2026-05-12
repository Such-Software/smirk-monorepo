/**
 * `@smirk/ui/themes` — theme registry, token system, application.
 *
 * Components in `@smirk/ui` consume themes by reading CSS variables
 * (`var(--smirk-bg)`, `var(--smirk-accent)`, etc) — never by importing
 * theme objects directly. To use a theme, the shell (extension, mobile,
 * desktop) calls `applyTheme(theme)` once at boot and on every change.
 *
 * @example Apply a theme at popup boot
 * ```ts
 * import { applyTheme, getTheme, defaultTheme } from '@smirk/ui';
 *
 * const stored = await session.load();
 * const theme = getTheme(stored.ui.theme) ?? defaultTheme;
 * applyTheme(theme);
 * ```
 *
 * @example Register a shell-specific theme
 * ```ts
 * import { registerTheme } from '@smirk/ui';
 *
 * registerTheme({
 *   id: 'macos-aqua',
 *   name: 'macOS Aqua',
 *   tokens: { ... },
 *   css: '...',
 * });
 * ```
 */

export type { Theme, ThemeTokens } from './types';
export {
  defaultTheme,
  registerTheme,
  listThemes,
  getTheme,
} from './registry';
export { win95Theme } from './win95';
export { winxpTheme } from './winxp';
export { amigaTheme } from './amiga';
export { iosClassicTheme } from './ios-classic';
export { gameboyTheme } from './gameboy';
export { n64Theme } from './n64';
export { applyTheme, resetTheme } from './apply';
