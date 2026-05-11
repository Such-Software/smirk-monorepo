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
  // rendering, native button reset, dialog title-bar gradient (when we
  // grow a header bar to put one on).
  css: `
    .smirk-theme-win95 img,
    .smirk-theme-win95 svg {
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }
    .smirk-theme-win95 button {
      /* Native UA button styling reasserted via tokens — wipe the round
         corners + soft gradients some browsers add by default. */
      border: 1px solid #000000;
      cursor: default;
    }
    .smirk-theme-win95 button:active {
      box-shadow: var(--smirk-shadow-sunken);
    }
    .smirk-theme-win95 input,
    .smirk-theme-win95 select,
    .smirk-theme-win95 textarea {
      border: 1px solid #000000;
      box-shadow: var(--smirk-shadow-sunken);
      background: var(--smirk-bg-sunken);
      color: var(--smirk-fg);
    }
  `,
};
