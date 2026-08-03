import type { Theme } from './types';

/**
 * Amiga Workbench 1.x: the iconic four-color palette (black, white,
 * cobalt blue, orange) of the OG Workbench desktop. Bold, plasticky,
 * unmistakable. Sharp rectangles, thick borders, and a bitmap-feel
 * Topaz-ish font.
 *
 * Color reference (Workbench 1.3 default palette):
 *   color 0 = #0055AA (background)
 *   color 1 = #000000 (text / chrome border)
 *   color 2 = #FFFFFF (highlight surface)
 *   color 3 = #FF8800 (accent / drag bars)
 *
 * Workbench used a strict 4-color WB screen; we lean into that
 * constraint instead of softening it. Chrome is white-on-blue with
 * orange accents; surfaces are white "windows" with thick black
 * borders, which is what Workbench actually looked like.
 */
export const amigaTheme: Theme = {
  // Stable id: kept as `amiga`. Display name uses the OS name
  // ("Workbench") rather than the Commodore hardware trademark.
  id: 'amiga',
  name: 'Workbench',
  description: 'Four colors. Hard edges. Sound chips you can hear.',
  tokens: {
    // The blue WB background is the whole-screen color in real life.
    bg: '#0055aa',
    // White "window" surfaces sit on top of the blue desktop.
    bgElevated: '#ffffff',
    bgSunken: '#ffffff',

    // Black ink on white windows, white on the blue desktop chrome
    // (handled via CSS payload for headlines that span the blue).
    fg: '#000000',
    fgMuted: '#555577',

    // Orange is the drag-bar / selection / call-to-action color.
    accent: '#ff8800',
    accentHover: '#dd6e00',
    accentFg: '#000000',

    // The 1px black hairline is the border. No softness.
    border: '#000000',
    borderStrong: '#000000',

    positive: '#007733',
    negative: '#cc0000',
    warning: '#ff8800',

    // Topaz was the Workbench system bitmap font; the extension bundles
    // Press Start 2P (OFL, /fonts/) as the closest permissively-licensed
    // pixel substitute; see the @font-face in the CSS payload. If a
    // user has a real Topaz on the system, that wins via the front of
    // the stack.
    fontFamily:
      "'Topaz-8', 'Topaz', 'PxPlus IBM VGA8', 'Press Start 2P', 'Courier New', monospace",
    fontFamilyMono:
      "'Topaz-8', 'Topaz', 'Press Start 2P', 'Courier New', monospace",
    fontSizeBase: '10px',
    fontSizeSmall: '8px',

    // Workbench drew only orthogonal rectangles. No rounding.
    radius: '0',
    radiusSm: '0',
    radiusLg: '0',

    // No drop shadows on Workbench: depth was conveyed by stacking
    // windows with thick borders. Use sharp 2px outlines via box-shadow
    // when components ask for raised/sunken styling.
    shadowRaised: '0 0 0 1px #000000, inset 1px 1px 0 #ffffff',
    shadowSunken: '0 0 0 1px #000000',
  },
  css: `
    /* Bundled pixel font as a Topaz substitute. Loads from the
       extension dist same-origin; falls through if absent. */
    @font-face {
      font-family: 'Press Start 2P';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('/fonts/press-start-2p.woff2') format('woff2');
    }

    /* On the blue desktop, foreground text should be white. The popup
       chrome lives on the blue desktop color; cards live on white. */
    .smirk-theme-amiga {
      color: #ffffff;
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }

    /* Pixel-art icon rendering throughout. */
    .smirk-theme-amiga img,
    .smirk-theme-amiga svg {
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }

    /* Headline balance sits in a white "window" with a black border
       and an orange drag bar across the top — pure Workbench. */
    .smirk-theme-amiga .smirk-unified-balance {
      background: #ffffff;
      color: #000000;
      border: 1px solid #000000;
      box-shadow: 4px 4px 0 #000000;
      margin: 8px;
      padding: 20px 16px 14px !important;
      position: relative;
    }
    .smirk-theme-amiga .smirk-unified-balance::before {
      content: '';
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: repeating-linear-gradient(
        90deg,
        #ff8800 0 2px,
        #ffffff 2px 4px
      );
    }

    /* Generic buttons: white face, black border, orange when active. */
    .smirk-theme-amiga button:not(.smirk-headline-action) {
      background: #ffffff;
      color: #000000;
      border: 1px solid #000000;
      border-radius: 0;
      font-family: var(--smirk-font-family);
      cursor: pointer;
    }
    .smirk-theme-amiga button:not(.smirk-headline-action):hover:not(:disabled) {
      background: #ff8800;
      color: #000000;
    }
    .smirk-theme-amiga button:not(.smirk-headline-action):active:not(:disabled) {
      background: #000000;
      color: #ff8800;
    }
    .smirk-theme-amiga button:not(.smirk-headline-action):focus-visible {
      outline: 1px dotted #000000;
      outline-offset: 2px;
    }

    /* Inputs: white field, black border, no rounding. */
    .smirk-theme-amiga input,
    .smirk-theme-amiga select,
    .smirk-theme-amiga textarea {
      background: #ffffff;
      color: #000000;
      border: 1px solid #000000;
      border-radius: 0;
      font-family: var(--smirk-font-family);
    }

    /* Asset list framed as a white listbox window. */
    .smirk-theme-amiga .smirk-asset-list {
      background: #ffffff;
      border: 1px solid #000000;
      box-shadow: 4px 4px 0 #000000;
      margin: 0 8px 8px;
      padding: 0;
      gap: 0 !important;
    }
    .smirk-theme-amiga .smirk-balance-card {
      color: #000000;
      border-bottom: 1px solid #000000;
      background: #ffffff;
    }
    .smirk-theme-amiga .smirk-balance-card:last-child {
      border-bottom: none;
    }
    .smirk-theme-amiga .smirk-balance-card:hover,
    .smirk-theme-amiga .smirk-balance-card:hover * {
      background: #ff8800;
      color: #000000 !important;
    }

    /* Bottom nav: white tabs with black borders sit on the blue desktop.
       The base BottomNav inlines color/background, so !important is
       required to beat the inline style. */
    .smirk-theme-amiga .smirk-bottom-nav {
      background: #ffffff !important;
      border-top: 1px solid #000000 !important;
    }
    .smirk-theme-amiga .smirk-bottom-nav__tab {
      background: #ffffff !important;
      color: #000000 !important;
      border: none;
      border-right: 1px solid #000000;
      border-radius: 0;
    }
    .smirk-theme-amiga .smirk-bottom-nav__tab:last-child {
      border-right: none;
    }
    .smirk-theme-amiga .smirk-bottom-nav__tab--active {
      background: #ff8800 !important;
      color: #000000 !important;
    }
  `,
};
