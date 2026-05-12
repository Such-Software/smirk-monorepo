import type { Theme } from './types';

/**
 * Windows XP Luna theme — the blue/silver/green palette that defined
 * an era. Glossy gradient title bars, rounded corners on chrome,
 * Tahoma 11, and that unmistakable green Start button.
 *
 * Palette reference (Luna blue):
 *   title-bar gradient: #0058E6 → #3F8CFF → #245EDB
 *   surface (taskbar):  #245EDB
 *   window background:  #ECE9D8 (the warm-tan content area)
 *   start button:       #399B22 → #80C53E
 *
 * The XP look came from gradients, not flat color. The CSS payload
 * carries the gradients on title-bar-equivalent surfaces (the balance
 * card top, action buttons) since the token system only carries flat
 * colors.
 */
export const winxpTheme: Theme = {
  // Stable id — kept as `winxp`. Display name uses the visual style's
  // codename ("Luna") instead of the OS trademark.
  id: 'winxp',
  name: 'Luna',
  description: 'Glossy blue gradients. Tahoma 11. Bliss.',
  tokens: {
    // The classic XP "bliss" content surface is warm tan, not white.
    // App background is white; cards/balance use the tan to feel like
    // a document inside an XP window.
    bg: '#ece9d8',
    bgElevated: '#ffffff',
    bgSunken: '#ffffff',

    fg: '#000000',
    fgMuted: '#555555',

    // Luna blue. accentFg white reads correctly on the deep blue.
    accent: '#0058e6',
    accentHover: '#1672ff',
    accentFg: '#ffffff',

    // Luna's actual chrome borders are a darker blue; subtle outline
    // for cards is a light gray.
    border: '#aca899',
    borderStrong: '#0a246a',

    positive: '#399b22',
    negative: '#c63030',
    warning: '#e8a200',

    // Tahoma was the XP system font; Trebuchet MS was the title-bar
    // font in some places. Keep Tahoma primary.
    fontFamily: "Tahoma, 'Trebuchet MS', 'Segoe UI', sans-serif",
    fontFamilyMono: "'Lucida Console', 'Courier New', monospace",
    fontSizeBase: '12px',
    fontSizeSmall: '11px',

    // XP rounded the top corners of windows and the corners of buttons.
    radius: '4px',
    radiusSm: '3px',
    radiusLg: '8px 8px 0 0',

    // Soft drop shadow gives that Luna window-floating look.
    shadowRaised: '0 1px 0 #ffffff inset, 0 1px 2px rgba(0,0,0,0.25)',
    shadowSunken: 'inset 0 1px 2px rgba(0,0,0,0.2)',
  },
  css: `
    .smirk-theme-winxp {
      background: linear-gradient(180deg, #2a52be 0%, #4a90e2 100%);
    }

    /* Headline balance is the "title bar + content" combo — the iconic
       blue gradient header sits above a white content area. */
    .smirk-theme-winxp .smirk-unified-balance {
      background: #ffffff;
      border: 1px solid #0a246a;
      border-radius: 8px 8px 4px 4px;
      margin: 8px;
      padding: 22px 16px 16px !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      position: relative;
      overflow: hidden;
    }
    .smirk-theme-winxp .smirk-unified-balance::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 8px;
      background: linear-gradient(180deg, #0058e6 0%, #3f8cff 50%, #245edb 100%);
      border-bottom: 1px solid #0a246a;
    }

    /* Buttons get the Luna pill: rounded blue-gradient face, glossy
       top highlight, a darker outer halo + drop shadow so the button
       reads as physically lifted off the surface (the "popping out"
       Start-button effect). Text gets a light embossed shadow so the
       glyphs look chiseled into the gloss. */
    .smirk-theme-winxp button:not(.smirk-headline-action) {
      background: linear-gradient(180deg, #f5f9ff 0%, #d4e4ff 45%, #88b1ff 100%);
      color: #04265b;
      border: 1px solid #003c74;
      border-radius: 4px;
      font-family: var(--smirk-font-family);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.95),
        inset 0 -2px 4px rgba(0,60,116,0.25),
        0 0 0 1px rgba(255,255,255,0.4),
        0 2px 4px rgba(0,0,0,0.35),
        0 4px 8px rgba(0,0,0,0.2);
      text-shadow: 0 1px 0 rgba(255,255,255,0.9);
    }
    .smirk-theme-winxp button:not(.smirk-headline-action):hover:not(:disabled) {
      background: linear-gradient(180deg, #ffffff 0%, #e5efff 45%, #a8c6ff 100%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,1),
        inset 0 -2px 4px rgba(0,60,116,0.2),
        0 0 0 1px rgba(255,255,255,0.5),
        0 3px 5px rgba(0,0,0,0.4),
        0 5px 10px rgba(0,0,0,0.22);
    }
    .smirk-theme-winxp button:not(.smirk-headline-action):active:not(:disabled) {
      background: linear-gradient(180deg, #88b1ff 0%, #4a7fcf 100%);
      box-shadow:
        inset 0 2px 4px rgba(0,0,0,0.45),
        inset 0 -1px 0 rgba(255,255,255,0.3),
        0 1px 1px rgba(0,0,0,0.3);
      text-shadow: 0 -1px 0 rgba(0,0,0,0.4);
      transform: translateY(1px);
    }
    .smirk-theme-winxp button:not(.smirk-headline-action):focus-visible {
      outline: 1px dotted #000000;
      outline-offset: -3px;
    }

    /* Inputs: white field with the slightly-blue Luna border, rounded. */
    .smirk-theme-winxp input,
    .smirk-theme-winxp select,
    .smirk-theme-winxp textarea {
      background: #ffffff;
      color: #000000;
      border: 1px solid #7f9db9;
      border-radius: 2px;
      font-family: var(--smirk-font-family);
    }
    .smirk-theme-winxp input:focus,
    .smirk-theme-winxp select:focus,
    .smirk-theme-winxp textarea:focus {
      border-color: #0058e6;
      outline: none;
    }

    /* Asset list framed as an XP groupbox — white card with a soft
       gray hairline, rounded corners. */
    .smirk-theme-winxp .smirk-asset-list {
      background: #ffffff;
      border: 1px solid #aca899;
      border-radius: 4px;
      margin: 0 8px 8px;
      padding: 4px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
      gap: 0 !important;
    }
    .smirk-theme-winxp .smirk-balance-card {
      border-bottom: 1px solid #ece9d8;
      background: transparent;
    }
    .smirk-theme-winxp .smirk-balance-card:last-child {
      border-bottom: none;
    }
    .smirk-theme-winxp .smirk-balance-card:hover {
      background: linear-gradient(180deg, #d4e4ff 0%, #a8c6ff 100%);
    }

    /* Bottom nav: the XP taskbar — deep blue gradient, raised. */
    .smirk-theme-winxp .smirk-bottom-nav {
      background: linear-gradient(180deg, #245edb 0%, #1941a5 100%) !important;
      border-top: 1px solid #0a246a;
    }
    .smirk-theme-winxp .smirk-bottom-nav__tab {
      background: transparent !important;
      color: #ffffff !important;
      border: none;
      border-radius: 0;
    }
    .smirk-theme-winxp .smirk-bottom-nav__tab:hover {
      background: rgba(255,255,255,0.15) !important;
    }
    .smirk-theme-winxp .smirk-bottom-nav__tab--active {
      background: linear-gradient(180deg, #399b22 0%, #80c53e 100%) !important;
      color: #ffffff !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.4);
    }
  `,
};
