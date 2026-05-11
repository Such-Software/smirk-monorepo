/**
 * Theme system — types.
 *
 * A theme is pure data: a set of token values that get applied to the
 * document root as CSS custom properties, plus an optional CSS payload
 * for theme-specific selectors (e.g. Win95's bevel box-shadows that
 * don't map cleanly to single-token variables).
 *
 * Components consume themes by reading the CSS variables — never by
 * importing theme objects directly. This keeps `@smirk/ui` components
 * theme-agnostic and lets shells (extension/mobile/desktop) inject
 * their own themes without rebuilding the component library.
 */

/**
 * Token values applied as CSS custom properties on the theme root.
 * Property names map 1:1 to `--smirk-<kebab>` CSS variables.
 *
 * Themes can omit tokens — missing values fall back to whatever the
 * previous theme set, or to the default theme on first apply.
 */
export interface ThemeTokens {
  // ---- Surfaces ----
  /** App background. */
  bg: string;
  /** Cards, raised surfaces (action buttons, balance card). */
  bgElevated: string;
  /** Inputs, dropdowns, sunken surfaces. */
  bgSunken: string;

  // ---- Foreground ----
  /** Primary body text. */
  fg: string;
  /** Secondary text (labels, hints, units). */
  fgMuted: string;

  // ---- Accent ----
  /** Primary action color (Send/Receive/Swap buttons, links). */
  accent: string;
  /** Accent hover state. */
  accentHover: string;
  /** Text rendered on top of accent surfaces. */
  accentFg: string;

  // ---- Borders ----
  /** Subtle border (card edges, dividers). */
  border: string;
  /** Strong border (button outline, focus ring). */
  borderStrong: string;

  // ---- Semantic ----
  /** Positive value (incoming tx, gains). */
  positive: string;
  /** Negative value (outgoing tx, errors). */
  negative: string;
  /** Warning (pending, time-sensitive). */
  warning: string;

  // ---- Typography ----
  /** Body font stack. */
  fontFamily: string;
  /** Monospace stack for addresses, hashes. */
  fontFamilyMono: string;
  /** Base font size for body copy. */
  fontSizeBase: string;
  /** Small font size for labels/captions. */
  fontSizeSmall: string;

  // ---- Geometry ----
  /** Default border-radius. */
  radius: string;
  /** Smaller border-radius (tags, pills). */
  radiusSm: string;
  /** Larger border-radius (cards, modals). */
  radiusLg: string;

  // ---- Effects ----
  /** Shadow for raised surfaces. `none` for flat themes. */
  shadowRaised: string;
  /** Shadow for sunken surfaces. */
  shadowSunken: string;
}

/**
 * Complete theme definition. Includes metadata for the picker UI, the
 * token set, and an optional CSS string for theme-specific rules that
 * the token system can't express (Win95 bevels, font-rendering hints,
 * pixel-art icon overrides, etc).
 */
export interface Theme {
  /** Stable identifier — also the value stored in session state. */
  id: string;
  /** Human-readable name for the picker UI. */
  name: string;
  /** Short tagline shown in the picker. */
  description?: string;
  /** Token values. */
  tokens: ThemeTokens;
  /**
   * Optional theme-specific CSS injected into a `<style>` element.
   * Use sparingly — token-driven styling is preferred for portability
   * across @smirk/ui consumers. Reserve this for effects that genuinely
   * can't be expressed as a single variable (bevel box-shadows, etc).
   */
  css?: string;
}
