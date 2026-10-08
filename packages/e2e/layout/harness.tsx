/**
 * Renders the real AppShell with the extension popup's real stylesheet, so the
 * layout specs exercise the same component and CSS the popup ships, in any
 * browser Playwright drives (Firefox cannot load our extension under Playwright,
 * so this is how its popup layout is tested).
 *
 * The header gets the same controls the extension passes: an identity chip as
 * `headerActions`, plus open-in-tab, pop-out and lock.
 */
import { h, render } from 'preact';
import { InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';
import { StateProvider } from '../../ui/src/state/hooks';
import { AppShell } from '../../ui/src/components/shell/AppShell';

declare global {
  interface Window {
    __shellClicks: string[];
  }
}

window.__shellClicks = [];
const clicked = (name: string) => () => {
  window.__shellClicks.push(name);
};

const storage = new InMemoryStorage();
const store = new SessionStateStore(storage);
const router = new RouteController(store);

const body = (label: string) => h('div', { 'data-testid': `route-${label}` }, label);

render(
  h(
    StateProvider,
    { store, router },
    h(AppShell, {
      routes: {
        home: body('home'),
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
