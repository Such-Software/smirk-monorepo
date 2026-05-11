import type { Theme } from './types';

/**
 * Win95 theme — chunky, gray, beveled, MS Sans Serif. The proof-of-
 * concept second theme that stresses the token system: it needs
 * outset/inset bevels that don't translate to flat colors, so the
 * raised/sunken shadow tokens are used plus a small CSS payload for
 * the things tokens alone can't express.
 *
 * Authentic palette references the original Windows 95 system color
 * scheme: 3DFACE (#c0c0c0), 3DSHADOW (#808080), 3DHILIGHT (#ffffff),
 * 3DDKSHADOW (#0a0a0a). Title-bar gradient #0a246a → #a6caf0.
 */
export const win95Theme: Theme = {
  id: 'win95',
  name: 'Windows 95',
  description: 'Chunky bevels. MS Sans Serif. For aficionados.',
  tokens: {
    // Classic system gray; raised surfaces use the same color and rely
    // on bevel shadows for separation, the way real Win95 does.
    bg: '#c0c0c0',
    bgElevated: '#c0c0c0',
    bgSunken: '#ffffff',

    fg: '#000000',
    fgMuted: '#404040',

    // Win95 title-bar blue, slightly darker than EGA to read well as
    // a button accent on the gray background.
    accent: '#000080',
    accentHover: '#0a246a',
    accentFg: '#ffffff',

    // No borders proper — the bevel shadows are the border. Keep token
    // values transparent so any component that draws a 1px border on
    // top of the bevel doesn't double up.
    border: 'transparent',
    borderStrong: '#000000',

    positive: '#008000',
    negative: '#800000',
    warning: '#808000',

    // MS Sans Serif is the iconic font; modern systems alias it to
    // Microsoft Sans Serif. Tahoma is the closest cross-platform
    // fallback; Geneva ships on macOS.
    fontFamily: "'MS Sans Serif', 'Microsoft Sans Serif', Tahoma, Geneva, sans-serif",
    fontFamilyMono: "'Courier New', Courier, monospace",
    fontSizeBase: '12px',
    fontSizeSmall: '11px',

    // Win95 doesn't round. Anything.
    radius: '0',
    radiusSm: '0',
    radiusLg: '0',

    // The hero feature: 2px bevel via box-shadow stacking. Outer ring
    // is dark+light to draw the chamfer, inner ring is the highlight
    // gradient. Order matters — outer first, inner second.
    shadowRaised:
      'inset -1px -1px #0a0a0a, inset 1px 1px #ffffff, inset -2px -2px #808080, inset 2px 2px #dfdfdf',
    shadowSunken:
      'inset 1px 1px #0a0a0a, inset -1px -1px #ffffff, inset 2px 2px #808080, inset -2px -2px #dfdfdf',
  },
  // Theme-specific CSS for things tokens can't carry: pixelated icon
  // rendering, the chunky-button bevel-active feedback, asset-list
  // sunken-well padding, and contrast resets for components that use
  // `opacity: 0.X` to mute text (the dark theme uses opacity-on-white;
  // on a light background it makes text invisible — restore full ink).
  css: `
    .smirk-theme-win95 img,
    .smirk-theme-win95 svg {
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }

    /* Generic <button> reset — chunky bevel, square corners, raised. */
    .smirk-theme-win95 button {
      border: 1px solid #000000;
      cursor: default;
      background: var(--smirk-bg-elevated);
      color: var(--smirk-fg);
      box-shadow: var(--smirk-shadow-raised);
      border-radius: 0;
      font-family: var(--smirk-font-family);
    }
    .smirk-theme-win95 button:active:not(:disabled) {
      box-shadow: var(--smirk-shadow-sunken);
    }
    .smirk-theme-win95 button:focus-visible {
      outline: 1px dotted #000000;
      outline-offset: -4px;
    }

    /* Inputs + selects look sunken (well into the surface). */
    .smirk-theme-win95 input,
    .smirk-theme-win95 select,
    .smirk-theme-win95 textarea {
      border: 1px solid #000000;
      box-shadow: var(--smirk-shadow-sunken);
      background: var(--smirk-bg-sunken);
      color: var(--smirk-fg);
      border-radius: 0;
      font-family: var(--smirk-font-family);
    }

    /* Asset list framed as a sunken group-box style well — gray surface
       (matches the outer chrome) with the inset bevel + thin hairline
       row separators between cards. Avoids the stark "white listbox"
       look while staying authentic to Win95 group-box rendering. */
    .smirk-theme-win95 .smirk-asset-list {
      background: var(--smirk-bg-elevated);
      box-shadow: var(--smirk-shadow-sunken);
      padding: 2px;
      gap: 0 !important;
    }
    .smirk-theme-win95 .smirk-balance-card {
      background: transparent;
      border-bottom: 1px solid #808080;
      box-shadow: inset 0 -1px 0 #ffffff;
    }
    .smirk-theme-win95 .smirk-balance-card:last-child {
      border-bottom: none;
      box-shadow: none;
    }
    .smirk-theme-win95 .smirk-balance-card:hover {
      background: var(--smirk-accent);
      color: var(--smirk-accent-fg);
    }
    /* When the row is hovered, the muted ticker/fiat children need to
       flip to the inverse foreground so they don't disappear into the
       navy-blue accent surface. */
    .smirk-theme-win95 .smirk-balance-card:hover,
    .smirk-theme-win95 .smirk-balance-card:hover * {
      color: var(--smirk-accent-fg) !important;
    }

    /* Bottom-nav tabs render as flat toolbar buttons — no bevel shadow,
       no border — overriding the generic button-bevel rule above. */
    .smirk-theme-win95 .smirk-bottom-nav__tab {
      box-shadow: none;
      border: none;
      border-top: 1px solid #808080;
    }
    .smirk-theme-win95 .smirk-bottom-nav__tab--active {
      box-shadow: var(--smirk-shadow-sunken);
      background: var(--smirk-bg-elevated) !important;
      color: var(--smirk-fg) !important;
    }

  `,
};
