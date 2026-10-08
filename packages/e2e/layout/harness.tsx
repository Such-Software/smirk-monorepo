/**
 * Renders the real AppShell with the extension popup's real stylesheet and the
 * real theme engine, so the layout specs exercise the same component, CSS and
 * themes the popup ships, in any browser Playwright drives (Firefox cannot
 * load our extension under Playwright, so this is how its popup is tested).
 *
 * Query parameters:
 *   theme=<id>     apply a built-in theme (default: default)
 *   layout=<mode>  AppShell layout prop: auto (default), popup or wide
 *
 * The header gets the same controls the extension passes (identity chip,
 * open-in-tab, pop-out, lock), and Home starts with a balance card carrying
 * the `smirk-unified-balance` class that themes such as WinXP position.
 */
import { h, render } from 'preact';
import { InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';
import { StateProvider } from '../../ui/src/state/hooks';
import { AppShell } from '../../ui/src/components/shell/AppShell';
import { applyTheme, getTheme } from '../../ui/src/themes';
import { defaultTheme } from '../../ui/src/themes/default';

declare global {
  interface Window {
    __shellClicks: string[];
  }
}

const params = new URLSearchParams(location.search);
applyTheme(getTheme(params.get('theme') ?? 'default') ?? defaultTheme);
const layoutParam = params.get('layout');
const layout = layoutParam === 'popup' || layoutParam === 'wide' ? layoutParam : 'auto';

window.__shellClicks = [];
const clicked = (name: string) => () => {
  window.__shellClicks.push(name);
};

const storage = new InMemoryStorage();
const store = new SessionStateStore(storage);
const router = new RouteController(store);

const body = (label: string) => h('div', { 'data-testid': `route-${label}` }, label);

const home = h(
  'div',
  { 'data-testid': 'route-home' },
  h(
    'div',
    {
      class: 'smirk-unified-balance',
      'data-testid': 'balance-card',
      style: { padding: 16, textAlign: 'center', fontSize: 28, fontWeight: 700 },
    },
    '$0.20',
    h('div', { style: { fontSize: 12, opacity: 0.7 } }, 'USD'),
  ),
);

render(
  h(
    StateProvider,
    { store, router },
    h(AppShell, {
      layout,
      routes: {
        home,
        swap: body('swap'),
        inbox: body('inbox'),
        feed: body('feed'),
        settings: body('settings'),
        browse: body('browse'),
      },
      onOpenInTab: clicked('tab'),
      onPopOut: clicked('popout'),
      onLock: clicked('lock'),
      headerActions: h(
        'button',
        {
          type: 'button',
          'aria-label': 'Switch identity',
          onClick: clicked('identity'),
          style: {
            padding: '4px 10px',
            borderRadius: 999,
            border: '1px solid #8b5cf6',
            background: '#2a1f3d',
            color: '#f5f5f5',
            fontFamily: 'monospace',
            fontSize: 12,
            whiteSpace: 'nowrap',
          },
        },
        'npub1hvx9j…sec7 ▾',
      ),
    }),
  ),
  document.getElementById('root')!,
);
