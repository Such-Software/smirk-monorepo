/**
 * `IframeBrowserContent` — renders the `<iframe>` elements managed by
 * an `IframeBrowserController` and wires up the postMessage transport
 * between embedded pages and the wallet's RPC handler.
 *
 * Composition: place INSIDE `BrowserShell`'s frame slot via
 * `<BrowserShell slotContent={<IframeBrowserContent controller={…}/>}/>`.
 * Outside that slot the layout is undefined; the component fills its
 * parent (`position: absolute; inset: 0`) and expects the parent to
 * be the `BrowserShell` frame container (which sets
 * `position: relative`).
 *
 * Rendering model:
 *  - One `<iframe>` per tab, all mounted. Inactive tabs are
 *    `visibility: hidden` + `pointer-events: none` rather than
 *    `display: none` — `display: none` discards the iframe's
 *    layout box and some browsers re-fire a navigation on the next
 *    mount, which would break "switch tab, come back" persistence.
 *  - The iframe's React key incorporates the controller's per-tab
 *    `reloadGen` so `controller.reload()` produces a full remount
 *    (which is the only cross-origin-safe way to force a fresh
 *    document load when the URL hasn't changed).
 *
 * postMessage routing:
 *  - A single `window.message` listener routes every page-side
 *    `SMIRK_REQUEST` event to the right tab by comparing
 *    `event.source` to each iframe's `contentWindow`. The matched
 *    tab id is handed to `controller.dispatchPageMessage`; the
 *    handler's response is posted back to the same iframe via
 *    `iframe.contentWindow.postMessage`.
 *  - Messages from frames we don't own are ignored. The wire
 *    envelope's `channel` discriminator filters out unrelated
 *    `message` events from other libraries.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  type BrowserSnapshot,
  type IframeBrowserController,
  type TabId,
} from '@smirk/dapp-browser';

/**
 * Channel discriminator that pairs with the `postMessage` transport
 * in `@such-software/smirk-dapp-api`'s page-api script. Must match the value the
 * page-side runtime uses. Public constant so dapps building their
 * own integration can reference it; treat as a stable wire field.
 */
export const SMIRK_DAPP_POSTMESSAGE_CHANNEL = 'smirk:dapp';

export interface IframeBrowserContentProps {
  readonly controller: IframeBrowserController;
}

/** See file header. */
export function IframeBrowserContent(
  props: IframeBrowserContentProps,
): JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const iframeRefs = useRef<Map<TabId, HTMLIFrameElement | null>>(new Map());

  useEffect(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    return unsubscribe;
  }, [props.controller]);

  // Global `message` listener — routes every page-side request that
  // matches our channel discriminator to the originating tab's
  // dispatch path. One listener for the whole component (rather than
  // one per iframe) keeps lifecycle simple: mount installs, unmount
  // removes, no per-tab churn on switch.
  useEffect(() => {
    const controller = props.controller;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { channel?: unknown; payload?: unknown }
        | null
        | undefined;
      if (!data || data.channel !== SMIRK_DAPP_POSTMESSAGE_CHANNEL) return;

      // Resolve which of our iframes produced this message. Browsers
      // populate `event.source` with the originating window for
      // cross-origin postMessage.
      let originatingTab: TabId | null = null;
      for (const [tabId, frame] of iframeRefs.current.entries()) {
        if (frame && frame.contentWindow === event.source) {
          originatingTab = tabId;
          break;
        }
      }
      if (!originatingTab) return;

      const target = originatingTab;
      const source = event.source as Window | null;
      void controller
        .dispatchPageMessage(event.origin, target, data.payload)
        .then((response: unknown) => {
          if (!source) return;
          source.postMessage(
            { channel: SMIRK_DAPP_POSTMESSAGE_CHANNEL, payload: response },
            event.origin,
          );
        })
        .catch((e: unknown) => {
          console.error('[IframeBrowserContent] dispatch threw:', e);
        });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [props.controller]);

  if (!snapshot) return <></>;

  // Garbage-collect refs for tabs that no longer exist — long-lived
  // sessions could otherwise accumulate stale entries that hold
  // freed DOM nodes (modern browsers null them, but the Map keys
  // would linger).
  const liveTabIds = new Set(snapshot.tabs.map((t) => t.id));
  for (const tabId of [...iframeRefs.current.keys()]) {
    if (!liveTabIds.has(tabId)) iframeRefs.current.delete(tabId);
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--smirk-bg, #0e0e10)',
      }}
    >
      {snapshot.tabs.map((tab) => {
        const isActive = tab.id === snapshot.activeTab;
        const reloadGen = props.controller.getReloadGen(tab.id);
        // The key bundles tab id + reload generation + URL so:
        //  - Reloading the same URL bumps reloadGen → React
        //    remounts the iframe → fresh document load.
        //  - Navigating to a new URL changes the URL component →
        //    same remount path.
        //  - Switching tabs leaves keys stable so iframes persist
        //    in the DOM and don't re-load on tab switch.
        const key = `${tab.id}::${reloadGen}::${tab.state.url}`;
        return (
          <iframe
            key={key}
            ref={(el) => {
              iframeRefs.current.set(tab.id, el);
            }}
            src={tab.state.url}
            title={tab.state.title || tab.state.url}
            onLoad={() => props.controller.notifyTabLoaded(tab.id)}
            // sandbox is intentionally unset: first-party dapps
            // include their own scripts, set their own cookies, and
            // navigate via their own forms. A restrictive sandbox
            // would break smirk.cash. Trust boundary is enforced at
            // the wallet's approval handler, not at the iframe.
            allow="clipboard-read; clipboard-write"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 'none',
              visibility: isActive ? 'visible' : 'hidden',
              pointerEvents: isActive ? 'auto' : 'none',
            }}
          />
        );
      })}
    </div>
  );
}
