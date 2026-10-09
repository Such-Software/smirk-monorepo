/**
 * Renders the extension popup's real Swap tab (SwapRouter, with the real
 * SwapTab, THORChain client, NonLogs client and price loader) in a plain page,
 * so swap-exposure.spec.ts can watch every request it makes. Only
 * `chrome.storage` (swap-harness-stubs.ts) and the WASM bundle (aliased by the
 * spec's build) are stand-ins; nothing on the Swap tab's path signs anything.
 */
import './swap-harness-stubs';
import { h, render } from 'preact';
import { DEFAULT_SESSION_STATE } from '@smirk/core';
import { StateProvider, THORCHAIN_WIZARD_ID } from '@smirk/ui';
import { store, router } from '../../extension/src/popup/singletons';
import { SwapRouter } from '../../extension/src/popup/routes/swap';

declare global {
  interface Window {
    __mounted: boolean;
  }
}

// Public receive addresses only, all synthetic. No keys.
const wallet = {
  addresses: {
    btc: 'bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv',
    ltc: 'ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz',
    xmr: `4${'A'.repeat(94)}`,
    wow: `Wo${'B'.repeat(95)}`,
  },
} as never;

void (async () => {
  // `?restore=thorchain`: the popup reopened onto a THORChain swap the user
  // had already started, as persisted route and wizard state does.
  if (new URLSearchParams(location.search).get('restore') === 'thorchain') {
    await store.save({
      ...DEFAULT_SESSION_STATE,
      wizards: { [THORCHAIN_WIZARD_ID]: { step: 0, fields: { step: 0 }, startedAt: Date.now() } },
    });
  }
  render(h(StateProvider, { store, router }, h(SwapRouter, { wallet, session: null })), document.getElementById('root')!);
  window.__mounted = true;
})();
