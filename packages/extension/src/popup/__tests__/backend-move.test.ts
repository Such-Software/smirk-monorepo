/**
 * A wallet window that another context moves to a different backend starts
 * over there, and nothing it was still doing for the old backend lands.
 *
 * Review of #46: the wallet window booted its backend selection with no
 * callback, so after another window's reset its `api` moved and its state did
 * not: the session kept the old backend's user id (the Grin inbox poll sent it
 * to the new backend), the Feed and an open Messages screen kept the old
 * operator's relays, and a capabilities read in flight during the reset put the
 * old relay back after the reset had cleared it.
 */
import './_chrome-stub';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  api,
  applyBackendConfig,
  initSmirkMessaging,
  invalidateCapabilities,
  messagingRelays,
} from '@smirk/core';
import {
  advanceBackendGeneration,
  backendScope,
  followBackendSelection,
  onBackendMovedElsewhere,
} from '../backend-generation';
import { adoptBackendCapabilities } from '../backend-capabilities';

const A = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const B = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };
const RELAY_A = 'ws://127.0.0.1:18711';
const RELAY_B = 'ws://127.0.0.1:18712';

function startAt(t: TestContext, backend: typeof A): void {
  const previous = { url: api.getBaseUrl(), apiStyle: api.getWalletApiStyle() };
  applyBackendConfig(backend);
  invalidateCapabilities();
  initSmirkMessaging({ publicRelays: [] });
  t.after(() => {
    applyBackendConfig(previous);
    invalidateCapabilities();
    initSmirkMessaging({ publicRelays: [] });
  });
}

/** The window boot, and what `bootBackendSelection` does when another context
 *  resets: re-point, drop the capabilities and relay set, then call back. */
function bootWindow(): { resetElsewhereTo: (backend: typeof A) => void } {
  let onMoved: () => void = () => {
    throw new Error('the window boot registered no callback for a move made elsewhere');
  };
  followBackendSelection((callback) => {
    onMoved = callback;
  });
  return {
    resetElsewhereTo(backend) {
      applyBackendConfig(backend);
      invalidateCapabilities();
      initSmirkMessaging({ publicRelays: [] });
      onMoved();
    },
  };
}

test('a move made in another window restarts this window on the new backend', (t) => {
  startAt(t, B);
  const window = bootWindow();
  let restarts = 0;
  t.after(onBackendMovedElsewhere(() => (restarts += 1)));
  const session = backendScope(api);

  window.resetElsewhereTo(A);

  assert.equal(restarts, 1, 'the wallet UI was not told to start over');
  assert.equal(session.current(), false, 'work started on the old backend still counts as current');
});

test('a capabilities read in flight across the move does not restore the old relay', async (t) => {
  startAt(t, B);
  const window = bootWindow();
  let answer: (caps: unknown) => void = () => undefined;
  t.mock.method(api, 'getCapabilities', () => new Promise((resolve) => (answer = resolve)));

  const adopting = adoptBackendCapabilities(api);
  window.resetElsewhereTo(A);
  answer({ status: 200, data: { features: { nostr_relay: true }, messaging: { relay_url: RELAY_B } } });

  const adopted = await adopting;
  assert.equal(adopted.stale, true);
  assert.deepEqual(messagingRelays(), [], "the previous operator's relay was put back");
});

test('a capabilities read that stays on its backend configures that relay', async (t) => {
  startAt(t, A);
  t.mock.method(api, 'getCapabilities', async () => ({
    status: 200,
    data: { features: { nostr_relay: true }, messaging: { relay_url: RELAY_A } },
  }));

  const adopted = await adoptBackendCapabilities(api);
  assert.equal(adopted.stale, false);
  assert.deepEqual(messagingRelays(), [RELAY_A]);
});

test("a switch made in this window ends the previous backend's work too", (t) => {
  startAt(t, A);
  const session = backendScope(api);
  advanceBackendGeneration();
  assert.equal(session.current(), false);
  assert.equal(backendScope(api).current(), true);
});
