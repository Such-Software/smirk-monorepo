import type { Theme } from './types';
import { defaultTheme } from './default';
import { win95Theme } from './win95';
import { winxpTheme } from './winxp';
import { amigaTheme } from './amiga';
import { iosClassicTheme } from './ios-classic';
import { gameboyTheme } from './gameboy';
import { n64Theme } from './n64';

/**
 * Built-in themes. Order is preserved for picker UI display.
 * Default must always be first.
 */
const BUILT_INS: Theme[] = [
  defaultTheme,
  win95Theme,
  winxpTheme,
  amigaTheme,
  iosClassicTheme,
  gameboyTheme,
  n64Theme,
];

const registry = new Map<string, Theme>(BUILT_INS.map((t) => [t.id, t]));

/**
 * Register a theme at runtime. Returns the previously-registered
 * theme with the same id, if any.
 *
 * Use case: shells can ship platform-specific themes (e.g. a
 * "macOS Aqua" theme that lives in `packages/desktop/`) without
 * baking them into `@smirk/ui`.
 */
export function registerTheme(theme: Theme): Theme | undefined {
  const prev = registry.get(theme.id);
  registry.set(theme.id, theme);
  return prev;
}

/** List all themes in registration order. */
export function listThemes(): Theme[] {
  return Array.from(registry.values());
}

/**
 * Look up a theme by id. Returns `undefined` if not registered; callers
 * should fall back to the default theme on miss.
 */
export function getTheme(id: string): Theme | undefined {
  return registry.get(id);
}

/** The default theme. Used as the fallback for missing-tokens or unknown ids. */
export { defaultTheme };
