/**
 * Smirk popup — Phase 2 shell.
 *
 * Real `AppShell` with bottom nav + tab switching + persistent route
 * (survives popup close, restored on reopen). Each tab is a placeholder
 * that fills in across subsequent phases. Pop-out wired to
 * `chrome.windows.create` so opening it shows the same state as the
 * popup it came from.
 */

import { render } from 'preact';
import {
  PopupStateStore,
  RouteController,
  autoDetectEphemeralStorage,
} from '@smirk/core';
import {
  AppShell,
  StateProvider,
  UI_PACKAGE_VERSION,
} from '@smirk/ui';
import { listAssets } from '@smirk/assets';

// Boot the state foundation. One store + one router shared across the
// whole popup tree; pop-out windows construct their own (different
// instance, same backing storage — they sync via cross-context
// notifications).
const storage = autoDetectEphemeralStorage();
const store = new PopupStateStore(storage);
const router = new RouteController(store);

function openPopOut() {
  const popoutUrl = chrome.runtime.getURL('popup.html');
  void chrome.windows.create({
    url: popoutUrl,
    type: 'popup',
    width: 480,
    height: 720,
  });
  // Close the popup so we don't have two windows showing the same
  // content. The pop-out picks up exactly where this popup was via
  // the shared `chrome.storage.session`.
  window.close();
}

function App() {
  return (
    <StateProvider store={store} router={router}>
      <AppShell
        onPopOut={openPopOut}
        routes={{
          home: <HomeStub />,
          swap: <SwapStub />,
          inbox: <InboxStub />,
          settings: <SettingsStub />,
        }}
      />
    </StateProvider>
  );
}

// ----- Tab placeholders -----
//
// Each tab gets a real screen in subsequent phases. For now these
// just announce themselves so we can verify the shell wiring.

function HomeStub() {
  const assets = listAssets();
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Home</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        Phase 2 shell — total balance, action row, asset list, recent activity all
        land in Phase 3.
      </p>
      <p class="muted" style={{ fontSize: 11 }}>
        ui@{UI_PACKAGE_VERSION} · {assets.length} assets registered
      </p>
    </div>
  );
}

function SwapStub() {
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Swap</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        Aggregator (THORChain) vs Native (P2P) sub-toggle lands when the THORChain
        prototype work begins.
      </p>
    </div>
  );
}

function InboxStub() {
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Inbox</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        Slatepacks, swap rounds, tip notes, and DMs land here. Empty for now.
      </p>
    </div>
  );
}

function SettingsStub() {
  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Settings</h2>
      <p class="muted" style={{ fontSize: 12 }}>
        Per-asset RPC config, denomination, spam mode, view-key export, seed
        reveal. All TBD.
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
