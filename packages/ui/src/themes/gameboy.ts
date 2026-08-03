import type { Theme } from './types';

/**
 * Game Boy DMG: the original 1989 four-shade pea-green LCD. The whole
 * interior of the popup becomes the screen: every surface uses one of
 * the four canonical shades, every glyph is rendered in chunky
 * monospace, and the bevel chrome around the screen sits behind it
 * via the page background.
 *
 * Canonical DMG palette (lightest → darkest):
 *   #9bbc0f: lightest (background)
 *   #8bac0f: light
 *   #306230: dark
 *   #0f380f: darkest (ink)
 *
 * Bandai's Super Game Boy + Pocket cartridges popularized variations
 * with cooler greens; we use the DMG-01 palette specifically since
 * it's the most recognizable.
 */
export const gameboyTheme: Theme = {
  // Stable id: kept as `gameboy`. Display name uses the Nintendo
  // internal model designator "DMG" (Dot Matrix Game) rather than
  // the consumer trademark.
  id: 'gameboy',
  name: 'DMG',
  description: 'Four shades of pea-green LCD. Beep boop.',
  tokens: {
    bg: '#9bbc0f',
    bgElevated: '#9bbc0f',
    bgSunken: '#8bac0f',

    // The darkest green is the ink. The mid-dark green is the muted
    // ink: used for labels/units.
    fg: '#0f380f',
    fgMuted: '#306230',

    // No real "accent" color exists in the four-shade palette;
    // we co-opt the dark green as the call-to-action surface and
    // the lightest green as text on top of it (inverted).
    accent: '#0f380f',
    accentHover: '#306230',
    accentFg: '#9bbc0f',

    // The "border" is the next shade darker than the surface.
    border: '#306230',
    borderStrong: '#0f380f',

    // Reuse the existing palette: there's nothing else available.
    positive: '#0f380f',
    negative: '#0f380f',
    warning: '#306230',

    // Pixel-feel monospace stack. The extension bundles Press Start 2P
    // (NES-era 8x8 bitmap font, OFL-licensed) under /fonts/; see the
    // @font-face declaration in the CSS payload. Falls back to any
    // pixel-monospace the system has, then to generic monospace if a
    // shell ships this theme without the bundled font.
    fontFamily:
      "'Press Start 2P', 'Pixel Operator', 'ProFont for Powerline', ProFont, 'Courier New', monospace",
    fontFamilyMono:
      "'Press Start 2P', 'Pixel Operator', 'ProFont for Powerline', ProFont, 'Courier New', monospace",
    // Pixel fonts read tiny at their natural size; bump the base so
    // the 8x8 glyphs are legible inside the popup.
    fontSizeBase: '10px',
    fontSizeSmall: '8px',

    // The LCD pixel grid is square. No rounding.
    radius: '0',
    radiusSm: '0',
    radiusLg: '0',

    // No drop shadows on an LCD: depth was conveyed by changing shade.
    shadowRaised: 'inset 0 0 0 2px #0f380f',
    shadowSunken: 'inset 0 0 0 1px #306230',
  },
  css: `
    /* Bundled pixel font: extension dist serves /fonts/ same-origin.
       If this theme is consumed outside the extension (mobile shell,
       desktop, web), the @font-face just fails to resolve and the
       fontFamily stack falls through to system pixel monospaces. */
    @font-face {
      font-family: 'Press Start 2P';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('/fonts/press-start-2p.woff2') format('woff2');
    }

    /* Crisp pixels everywhere: disable browser smoothing on icons,
       SVGs, and even text where the engine allows. */
    .smirk-theme-gameboy {
      image-rendering: pixelated;
    }
    .smirk-theme-gameboy img,
    .smirk-theme-gameboy svg {
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }
    .smirk-theme-gameboy * {
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    /* Restore the asset display-name + balance from being shouty: the
       wallet shows mixed-case addresses and numerics that shouldn't
       all-caps. */
    .smirk-theme-gameboy input,
    .smirk-theme-gameboy textarea,
    .smirk-theme-gameboy [data-no-uppercase],
    .smirk-theme-gameboy code,
    .smirk-theme-gameboy pre {
      text-transform: none;
      letter-spacing: 0;
    }

    /* Headline balance: chunky pixel-step double frame; thick dark
       border with a one-shade-lighter gap, then an outer dark ring.
       Reads like the LCD-era 4-pixel inset bezels on real Game Boy UI. */
    .smirk-theme-gameboy .smirk-unified-balance {
      background: #9bbc0f;
      color: #0f380f;
      border: 4px solid #0f380f;
      margin: 12px 10px 8px;
      padding: 22px 14px 16px !important;
      box-shadow:
        inset 0 0 0 2px #9bbc0f,
        inset 0 0 0 4px #306230,
        0 0 0 2px #8bac0f,
        0 0 0 4px #0f380f;
    }

    /* Buttons: chunky 3-pixel border + an outer dark halo for that
       stepped pixel-art look. Invert on press. */
    .smirk-theme-gameboy button:not(.smirk-headline-action) {
      background: #9bbc0f;
      color: #0f380f;
      border: 3px solid #0f380f;
      border-radius: 0;
      font-family: var(--smirk-font-family);
      font-size: 9px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      box-shadow: 0 0 0 1px #8bac0f, 0 0 0 2px #0f380f;
    }
    .smirk-theme-gameboy button:not(.smirk-headline-action):hover:not(:disabled) {
      background: #8bac0f;
    }
    .smirk-theme-gameboy button:not(.smirk-headline-action):active:not(:disabled),
    .smirk-theme-gameboy button:not(.smirk-headline-action):focus-visible {
      background: #0f380f;
      color: #9bbc0f;
      outline: none;
    }

    /* Inputs: sunken (one shade darker than the surface), chunky pixel
       border to match the rest of the chrome. */
    .smirk-theme-gameboy input,
    .smirk-theme-gameboy select,
    .smirk-theme-gameboy textarea {
      background: #8bac0f;
      color: #0f380f;
      border: 3px solid #0f380f;
      border-radius: 0;
      font-family: var(--smirk-font-family);
      box-shadow: inset 0 0 0 1px #306230;
    }
    .smirk-theme-gameboy input::placeholder,
    .smirk-theme-gameboy textarea::placeholder {
      color: #306230;
    }

    /* Asset list framed as a stats panel. */
    .smirk-theme-gameboy .smirk-asset-list {
      background: #9bbc0f;
      border: 2px solid #0f380f;
      margin: 0 8px 8px;
      padding: 2px;
      gap: 0 !important;
    }
    .smirk-theme-gameboy .smirk-balance-card {
      background: transparent;
      color: #0f380f;
      border-bottom: 1px dashed #306230;
    }
    .smirk-theme-gameboy .smirk-balance-card:last-child {
      border-bottom: none;
    }
    .smirk-theme-gameboy .smirk-balance-card:hover,
    .smirk-theme-gameboy .smirk-balance-card:hover * {
      background: #0f380f;
      color: #9bbc0f !important;
    }

    /* Bottom nav: dark-green ink bar across the bottom, like the
       DMG's built-in status strip. */
    .smirk-theme-gameboy .smirk-bottom-nav {
      background: #8bac0f !important;
      border-top: 2px solid #0f380f;
    }
    .smirk-theme-gameboy .smirk-bottom-nav__tab {
      background: transparent;
      color: #306230 !important;
      border: none;
      border-right: 1px solid #306230;
      border-radius: 0;
    }
    .smirk-theme-gameboy .smirk-bottom-nav__tab:last-child {
      border-right: none;
    }
    .smirk-theme-gameboy .smirk-bottom-nav__tab--active {
      background: #0f380f !important;
      color: #9bbc0f !important;
    }
  `,
};
