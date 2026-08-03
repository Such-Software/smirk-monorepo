import type { Theme } from './types';

/**
 * Nintendo 64: Mario 64 "SELECT FILE" era. Gold-and-cardboard gilt
 * frames, chunky rounded cartoonish display type, primary-color blocks
 * (green/blue/red/magenta) for action surfaces, and a warm-brown
 * desktop background that reads like a wooden table.
 *
 * Era reference: SM64 menu (1996). Big, soft, friendly, the opposite
 * of the precision pixel aesthetic of the DMG or Workbench. Gradients
 * are gentle (early-3D smooth shading), not glossy in the iPhone sense.
 *
 * Palette:
 *   chrome / page: warm brown #6b4a2b (table-top)
 *   frame:         gold gradient #f0c75e → #b88a2c → #6b4a2b
 *   panel:         deep red-brown #4a2412 (inset frame)
 *   action green:  #2fb84a → #1e8a36 (top-bottom shading)
 *   action blue:   #2e7ad6 → #1c5aa8
 *   action red:    #d63a30 → #9a221a
 *   action magenta:#a23fb3 → #6f1f80
 *   star yellow:   #ffe14a (Mario star accent)
 */
export const n64Theme: Theme = {
  // Stable id: kept as `n64`. Display name uses the pre-launch
  // codename "Ultra 64" rather than the final trademarked product name.
  id: 'n64',
  name: 'Ultra 64',
  description: 'Gilt frames. Magenta blocks. Polygons with attitude.',
  tokens: {
    bg: '#6b4a2b',
    bgElevated: '#4a2412',
    bgSunken: '#3a1c0e',

    fg: '#ffffff',
    fgMuted: '#f0d9a8',

    // Mario star yellow is the call-to-action color: bright on dark.
    accent: '#ffe14a',
    accentHover: '#fff080',
    accentFg: '#4a2412',

    // The gold-frame highlight color reads as our "border" token; the
    // strong variant is the deep brown that frames the inset panel.
    border: '#b88a2c',
    borderStrong: '#4a2412',

    positive: '#2fb84a',
    negative: '#d63a30',
    warning: '#ffb340',

    // Chunky rounded display font for the cartoonish SM64-menu vibe.
    // Extension bundles Lilita One (OFL, /fonts/) as the primary
    // choice; see @font-face below. Fallback to any chunky display
    // font the system has, then a heavy sans as last resort.
    fontFamily:
      "'Lilita One', 'Bagel Fat One', 'Fredoka', 'Bowlby One', 'Trebuchet MS', sans-serif",
    fontFamilyMono: "'Cascadia Code', 'Consolas', 'Lucida Console', monospace",
    fontSizeBase: '14px',
    fontSizeSmall: '12px',

    // N64 chrome leaned into soft rounded corners on every panel.
    radius: '10px',
    radiusSm: '6px',
    radiusLg: '14px',

    shadowRaised:
      '0 2px 0 rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.25) inset',
    shadowSunken: 'inset 0 2px 4px rgba(0,0,0,0.6)',
  },
  css: `
    /* Bundled chunky display font (Lilita One, OFL). Loaded from the
       extension dist same-origin; falls through to system display
       fonts if absent. */
    @font-face {
      font-family: 'Lilita One';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('/fonts/lilita-one.ttf') format('truetype');
    }

    /* Warm wood-grain page background. */
    .smirk-theme-n64 {
      background:
        radial-gradient(ellipse at top, #8a5e36 0%, #6b4a2b 50%, #4a311a 100%) !important;
      color: #ffffff;
    }

    /* Headline balance: the gilt frame around an inset deep-brown
       panel — Mario 64's "Select File" gold border in spirit. */
    .smirk-theme-n64 .smirk-unified-balance {
      background:
        linear-gradient(180deg, #4a2412 0%, #2a1408 100%);
      color: #ffe14a;
      border-radius: 14px;
      border: 3px solid #f0c75e;
      margin: 10px;
      padding: 22px 16px 16px !important;
      box-shadow:
        0 0 0 1px #6b4a2b,
        0 0 0 4px #b88a2c,
        0 0 0 5px #4a2412,
        0 4px 10px rgba(0,0,0,0.5),
        inset 0 1px 0 rgba(255,225,74,0.2);
      text-shadow: 0 2px 0 rgba(0,0,0,0.5);
    }

    /* Buttons: chunky colorful blocks. Default = green; the action row
       can override per-button via .smirk-action-button--{tip,send,...}
       if/when needed. Soft top-down shading, dark drop shadow under. */
    .smirk-theme-n64 button:not(.smirk-headline-action) {
      background: linear-gradient(180deg, #2fb84a 0%, #1e8a36 100%);
      color: #ffffff;
      border: 2px solid #154d20;
      border-radius: 10px;
      font-family: var(--smirk-font-family);
      font-weight: 700;
      letter-spacing: 0.02em;
      cursor: pointer;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.3) inset,
        0 3px 0 rgba(0,0,0,0.45);
      text-shadow: 0 -1px 0 rgba(0,0,0,0.4);
      padding-bottom: 0.5em;
    }
    .smirk-theme-n64 button:not(.smirk-headline-action):hover:not(:disabled) {
      filter: brightness(1.1);
    }
    .smirk-theme-n64 button:not(.smirk-headline-action):active:not(:disabled) {
      transform: translateY(2px);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.2) inset,
        0 1px 0 rgba(0,0,0,0.45);
    }
    .smirk-theme-n64 button:not(.smirk-headline-action):focus-visible {
      outline: 2px solid #ffe14a;
      outline-offset: 2px;
    }

    /* Inputs: deep-brown well inside a gold hairline. */
    .smirk-theme-n64 input,
    .smirk-theme-n64 select,
    .smirk-theme-n64 textarea {
      background: #2a1408;
      color: #ffffff;
      border: 2px solid #b88a2c;
      border-radius: 8px;
      font-family: var(--smirk-font-family);
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.6);
    }
    .smirk-theme-n64 input::placeholder,
    .smirk-theme-n64 textarea::placeholder {
      color: rgba(240,217,168,0.5);
    }

    /* Asset list: the inset deep-brown panel framed in gold. */
    .smirk-theme-n64 .smirk-asset-list {
      background: linear-gradient(180deg, #4a2412 0%, #2a1408 100%);
      border: 3px solid #f0c75e;
      border-radius: 12px;
      margin: 0 10px 10px;
      padding: 4px;
      box-shadow:
        0 0 0 1px #6b4a2b,
        0 0 0 4px #b88a2c,
        0 0 0 5px #4a2412,
        0 2px 6px rgba(0,0,0,0.5);
      gap: 2px !important;
    }
    .smirk-theme-n64 .smirk-balance-card {
      background: linear-gradient(180deg, #6b4a2b 0%, #4a311a 100%);
      color: #ffffff;
      border: 2px solid #b88a2c;
      border-radius: 8px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.15) inset,
        0 2px 0 rgba(0,0,0,0.35);
    }
    .smirk-theme-n64 .smirk-balance-card:hover {
      background: linear-gradient(180deg, #2e7ad6 0%, #1c5aa8 100%);
      border-color: #5fb0ff;
    }
    .smirk-theme-n64 .smirk-balance-card:hover * {
      color: #ffffff !important;
    }

    /* Bottom nav: gold-bordered wooden bar with chunky raised tabs. */
    .smirk-theme-n64 .smirk-bottom-nav {
      background: linear-gradient(180deg, #4a2412 0%, #2a1408 100%) !important;
      border-top: 3px solid #b88a2c;
      box-shadow: 0 -1px 0 #f0c75e;
    }
    .smirk-theme-n64 .smirk-bottom-nav__tab {
      background: transparent;
      color: #f0d9a8 !important;
      border: none;
      border-radius: 0;
      font-weight: 700;
      text-shadow: 0 -1px 0 rgba(0,0,0,0.5);
    }
    .smirk-theme-n64 .smirk-bottom-nav__tab--active {
      background: linear-gradient(180deg, #a23fb3 0%, #6f1f80 100%) !important;
      color: #ffffff !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.25),
        inset 0 -2px 0 rgba(0,0,0,0.3);
    }
  `,
};
