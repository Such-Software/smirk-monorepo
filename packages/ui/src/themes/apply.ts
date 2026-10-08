import type { Theme, ThemeTokens } from './types';
import { defaultTheme } from './registry';

/**
 * CSS-variable name a token maps to. `bgElevated` → `--smirk-bg-elevated`.
 */
function tokenVarName(token: keyof ThemeTokens): string {
  // camelCase → kebab-case
  return '--smirk-' + token.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/**
 * The CSS `color-scheme` a theme's background calls for.
 *
 * The browser draws scrollbars, form controls and other UA surfaces from
 * `color-scheme`, and without a declaration it follows `prefers-color-scheme`.
 * Hardened Firefox builds (LibreWolf, Mullvad Browser, Tor Browser) force that
 * to light under privacy.resistFingerprinting, so a dark theme got light,
 * native-looking UA parts. Deriving it from the theme keeps the user's chosen
 * theme in charge. Unparseable colors default to dark, the default theme.
 */
export function colorSchemeFor(bg: string): 'dark' | 'light' {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return 'dark';
  const hex = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  // Relative luminance (sRGB), WCAG definition.
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? 'light' : 'dark';
}

const STYLE_ELEMENT_ID = 'smirk-theme-css';
const THEME_CLASS_PREFIX = 'smirk-theme-';

/**
 * Apply a theme to the document. Sets CSS variables on `:root`, injects
 * the theme's optional `css` payload, and tags `<html>` with a
 * `smirk-theme-<id>` class so theme-specific CSS selectors can target.
 *
 * Idempotent: calling repeatedly with the same theme is a no-op
 * beyond the DOM writes. Calling with a different theme cleanly
 * replaces the previous one.
 *
 * No-op outside the browser (Node test runs, SSR).
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // 1. Set tokens. Fall back to default tokens for any missing values
  //    so a partial theme can override just a few fields.
  for (const key of Object.keys(defaultTheme.tokens) as Array<keyof ThemeTokens>) {
    const value = theme.tokens[key] ?? defaultTheme.tokens[key];
    root.style.setProperty(tokenVarName(key), value);
  }
  root.style.setProperty('color-scheme', colorSchemeFor(theme.tokens.bg ?? defaultTheme.tokens.bg));

  // 2. Swap the theme-id class on <html>. Lets theme CSS selectors
  //    target with `.smirk-theme-win95 button { ... }`.
  for (const cls of Array.from(root.classList)) {
    if (cls.startsWith(THEME_CLASS_PREFIX)) {
      root.classList.remove(cls);
    }
  }
  root.classList.add(THEME_CLASS_PREFIX + theme.id);

  // 3. Inject / replace the theme-specific CSS payload.
  let styleEl = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (theme.css) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ELEMENT_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = theme.css;
  } else if (styleEl) {
    styleEl.textContent = '';
  }
}

/**
 * Reset to default theme. Useful for "Theme: System default" picks
 * and for tests that need a clean slate.
 */
export function resetTheme(): void {
  applyTheme(defaultTheme);
}
