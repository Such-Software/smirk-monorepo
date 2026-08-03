import type { Theme } from './types';

/**
 * iOS Classic: the iPhone OS 1/2/3 look. Pre-flat-design. Glossy
 * "jelly" buttons, slate gradients, Helvetica, white text on dark
 * navy chrome with the lozenge dock at the bottom.
 *
 * Palette references the original SpringBoard:
 *   wallpaper / chrome:  near-black with a faint blue cast
 *   nav bar gradient:    #5C7596 → #2F4060 (slate-blue jelly)
 *   primary action:      #3F88E0 → #1860B5 (Aqua blue gradient)
 *   text on dark:        #FFFFFF
 *
 * The era's signature is the *gradient*: every chrome surface was a
 * top-to-bottom gloss. Token-wise we carry flat fallback colors and
 * paint the gradients in the CSS payload.
 */
export const iosClassicTheme: Theme = {
  // Stable id: kept as `ios-classic`. Display name avoids the Apple
  // "iPhone" trademark; uses the era + the visual style descriptor.
  id: 'ios-classic',
  name: "Glassy '07",
  description: 'Glossy jelly buttons. Helvetica. Tap before you swipe.',
  tokens: {
    // The SpringBoard wallpaper was near-black with a slate cast.
    bg: '#0a0d12',
    // Cards / "table view" surfaces use a darker slate gloss.
    bgElevated: '#1a2030',
    bgSunken: '#0a0d12',

    fg: '#ffffff',
    fgMuted: '#9aa3b2',

    // Aqua blue: the original iPhone OS action color.
    accent: '#1f7be4',
    accentHover: '#3f8ce8',
    accentFg: '#ffffff',

    // Subtle borders on the dark slate; strong border for table-view
    // row separators uses a slightly-lifted slate.
    border: 'rgba(255,255,255,0.08)',
    borderStrong: 'rgba(255,255,255,0.18)',

    positive: '#3ddc6b',
    negative: '#ff453a',
    warning: '#ffb340',

    // Helvetica was the SpringBoard font through iOS 6. Use Helvetica
    // Neue first since modern systems have it; fall back to Helvetica
    // and the system stack.
    fontFamily:
      "'Helvetica Neue', Helvetica, 'Lucida Grande', -apple-system, BlinkMacSystemFont, sans-serif",
    fontFamilyMono: "Menlo, 'SF Mono', Monaco, 'Courier New', monospace",
    fontSizeBase: '14px',
    fontSizeSmall: '12px',

    // iOS Classic rounded *everything*: icons, buttons, the chrome.
    // 22% radius on icons was the rule (the "squircle" came later).
    radius: '10px',
    radiusSm: '6px',
    radiusLg: '14px',

    // Glossy depth: the signature look.
    shadowRaised: '0 1px 0 rgba(255,255,255,0.15) inset, 0 1px 3px rgba(0,0,0,0.6)',
    shadowSunken: 'inset 0 2px 4px rgba(0,0,0,0.5)',
  },
  css: `
    .smirk-theme-ios-classic {
      background: radial-gradient(ellipse at top, #1a2030 0%, #0a0d12 60%) !important;
      -webkit-font-smoothing: antialiased;
    }

    /* Headline balance: glossy slate jelly bar, the iOS nav-bar
       gradient extended into a hero panel. */
    .smirk-theme-ios-classic .smirk-unified-balance {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 50%),
        linear-gradient(180deg, #5c7596 0%, #364866 50%, #2f4060 100%);
      color: #ffffff;
      border-radius: 14px;
      border: 1px solid rgba(0,0,0,0.6);
      margin: 10px;
      padding: 20px 16px 16px !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.25) inset,
        0 0 0 1px rgba(255,255,255,0.05),
        0 4px 10px rgba(0,0,0,0.5);
      text-shadow: 0 -1px 0 rgba(0,0,0,0.3);
    }

    /* Buttons get the classic Aqua-blue jelly. */
    .smirk-theme-ios-classic button:not(.smirk-headline-action) {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 50%),
        linear-gradient(180deg, #3f88e0 0%, #1f6cc8 50%, #1860b5 100%);
      color: #ffffff;
      border: 1px solid rgba(0,0,0,0.5);
      border-radius: 10px;
      font-family: var(--smirk-font-family);
      font-weight: 500;
      cursor: pointer;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.3) inset,
        0 1px 2px rgba(0,0,0,0.4);
      text-shadow: 0 -1px 0 rgba(0,0,0,0.35);
    }
    .smirk-theme-ios-classic button:not(.smirk-headline-action):hover:not(:disabled) {
      filter: brightness(1.1);
    }
    .smirk-theme-ios-classic button:not(.smirk-headline-action):active:not(:disabled) {
      background:
        linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 50%),
        linear-gradient(180deg, #1860b5 0%, #1f6cc8 50%, #3f88e0 100%);
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.5);
    }
    .smirk-theme-ios-classic button:not(.smirk-headline-action):focus-visible {
      outline: 2px solid rgba(63,140,232,0.7);
      outline-offset: 2px;
    }

    /* Inputs: dark "search field" look from iOS classic; pill-shape,
       inset shadow, glossy top highlight. */
    .smirk-theme-ios-classic input,
    .smirk-theme-ios-classic select,
    .smirk-theme-ios-classic textarea {
      background: rgba(0,0,0,0.4);
      color: #ffffff;
      border: 1px solid rgba(0,0,0,0.6);
      border-radius: 8px;
      font-family: var(--smirk-font-family);
      box-shadow:
        inset 0 1px 2px rgba(0,0,0,0.6),
        0 1px 0 rgba(255,255,255,0.05);
    }
    .smirk-theme-ios-classic input::placeholder,
    .smirk-theme-ios-classic textarea::placeholder {
      color: rgba(255,255,255,0.4);
    }

    /* Asset list: classic iOS "grouped table view", rounded card with
       hairline separators and a subtle inset gradient. */
    .smirk-theme-ios-classic .smirk-asset-list {
      background: linear-gradient(180deg, #232b3d 0%, #1a2030 100%);
      border: 1px solid rgba(0,0,0,0.5);
      border-radius: 12px;
      margin: 0 10px 10px;
      padding: 0;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.08) inset,
        0 2px 6px rgba(0,0,0,0.45);
      overflow: hidden;
      gap: 0 !important;
    }
    .smirk-theme-ios-classic .smirk-balance-card {
      background: transparent;
      border-bottom: 1px solid rgba(0,0,0,0.5);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      color: #ffffff;
    }
    .smirk-theme-ios-classic .smirk-balance-card:last-child {
      border-bottom: none;
      box-shadow: none;
    }
    .smirk-theme-ios-classic .smirk-balance-card:hover {
      background: rgba(63,140,232,0.15);
    }

    /* Bottom nav: the iOS dock, glossy black bar with embossed icons. */
    .smirk-theme-ios-classic .smirk-bottom-nav {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 50%),
        linear-gradient(180deg, #2a3346 0%, #141a26 100%) !important;
      border-top: 1px solid rgba(0,0,0,0.6);
      box-shadow: 0 1px 0 rgba(255,255,255,0.1) inset;
    }
    .smirk-theme-ios-classic .smirk-bottom-nav__tab {
      background: transparent;
      color: rgba(255,255,255,0.55) !important;
      border: none;
      border-radius: 0;
      text-shadow: 0 -1px 0 rgba(0,0,0,0.4);
    }
    .smirk-theme-ios-classic .smirk-bottom-nav__tab--active {
      color: #ffffff !important;
      background: radial-gradient(ellipse at center, rgba(63,140,232,0.35) 0%, transparent 70%) !important;
    }
  `,
};
