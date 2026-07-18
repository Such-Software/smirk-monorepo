import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type WalletState } from '@smirk/core';
import {
  BrowserShell,
  IframeBrowserContent,
  ApprovalScreen,
  formatAmountWithTicker,
  type ApprovalApproval,
  type ApprovalRequest as UiApprovalRequest,
} from '@smirk/ui';
import {
  createWalletHandler,
  type ApprovalRequest as DappApprovalRequest,
} from '@such-software/smirk-dapp-api';
import { store } from '../singletons';
import { normalizePaymentAmount } from '../format';
import { ensureWasmInit } from '../wasm-init';
import { send } from '../send-handler';
import { claimPublicTip } from '../tip-claim-handler';
import { readBootstrapCache } from '../bootstrap-cache';
import type { BrowserControllerGlobal, IframeBrowserController } from '../browser-controller';
import { chromeStoragePermissionStore } from '../../background/dapp/permissions';
import {
  createInPopupApprovalQueue,
  createLiveWalletProvider,
  createPageRequestBridge,
  executeApproval,
} from '../../dapp-popup';

// ============================================================================
// Browse tab — desktop-only, mounted via globalThis.__smirk_browser__
// ============================================================================


/**
 * BrowseTab wires the embedded-browser controller (provided by the
 * Tauri desktop shell on the `__smirk_browser__` global) to the
 * wallet's dapp surface. Three concerns live here:
 *
 *  1. **Open the browser** (`controller.open()`) and seed a first
 *     tab so the user lands somewhere useful instead of a blank
 *     frame slot.
 *  2. **Wire the page-RPC bridge** so `window.smirk` calls inside
 *     embedded pages route through the same `WalletHandler` the
 *     extension SW uses — full method parity (connect / signMessage
 *     / requestPayment / claimPublicTip). No SW round-trip; the
 *     unlocked wallet stays in this React tree.
 *  3. **Render the approval modal** on top of the browser shell
 *     when a dapp request needs user consent. Single-pending queue:
 *     a second concurrent request gets a deny so the user can't be
 *     tricked into approving the wrong thing.
 *
 * The provider + permission store are reused verbatim from the
 * extension's chrome-shim-backed factories — the chrome-shim turns
 * `chrome.storage.*` into Tauri's `plugin-store`, so the same code
 * persists per-origin permissions on desktop.
 *
 * `walletStateRef` lets the approval handler read the latest unlock
 * state at the moment the user clicks Approve (which may be many
 * seconds after the request arrived). A user who locks mid-decision
 * gets a clear "wallet locked" error instead of a stale signature.
 */
export function BrowseTab({
  controller,
  walletStateRef,
}: {
  controller: BrowserControllerGlobal;
  walletStateRef: { current: WalletState | null };
}) {
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<DappApprovalRequest | null>(null);

  // Approval queue + wallet handler — created once per BrowseTab
  // mount. The queue's listener wiring lives in its own effect
  // below so the React subscriber unsubscribes on unmount.
  const queue = useMemo(() => createInPopupApprovalQueue(), []);

  useEffect(() => queue.subscribe(setPending), [queue]);

  // Hide the embedded WebviewWindow while an approval is pending.
  // The embedded webview is a separate top-level OS window stacked
  // over the wallet's frame slot — a React `position: fixed` modal
  // would render in the wallet popup BENEATH that window, invisible
  // to the user. `controller.hideFrame()` calls `embedded.hide()` on
  // the Rust side; when the user resolves the approval, we nudge a
  // resize event so `BrowserShell`'s `ResizeObserver` re-pushes the
  // frame rect to Rust, which restores the embedded webview to its
  // previous position via the apply_rect → show() path.
  const hadPendingRef = useRef(false);
  useEffect(() => {
    if (pending) {
      void controller.hideFrame();
      hadPendingRef.current = true;
    } else if (hadPendingRef.current) {
      hadPendingRef.current = false;
      // BrowserShell's `useFrameRect` listens for window resize and
      // re-measures + re-pushes. Fire it once after the React tree
      // settles so the resize handler reads the post-modal layout.
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  }, [pending, controller]);

  useEffect(() => {
    // Desktop uses a LIVE provider that reads `walletStateRef`
    // directly, not the chrome-shim-backed public cache. Two reasons:
    // (1) the cache's `sessionExpiresAtMs` is stamped to `Date.now()`
    // for `autoLockMinutes = 0` (the default), which the SW provider
    // treats as expired → every dapp call from the desktop browser
    // would come back `LOCKED`. (2) BrowseTab has direct access to
    // the unlocked wallet in this React tree, so going through a
    // cache adds a stale-read failure mode for no benefit. The
    // permission store still uses the chrome-shim — per-origin
    // permissions DO want to persist across wallet locks.
    const provider = createLiveWalletProvider(() => {
      const ws = walletStateRef.current;
      return ws && ws.kind === 'unlocked' ? ws.wallet : null;
    });
    const permissions = chromeStoragePermissionStore();
    const dispatch = createWalletHandler({
      provider,
      permissions,
      approval: queue.handler,
    });
    const bridge = createPageRequestBridge(dispatch);
    void controller.setPageRequestHandler(async (req) => {
      const resp = await bridge(req);
      return resp;
    });

    let cancelled = false;
    void controller.open().then(() => {
      if (cancelled) return;
      setOpened(true);
      void controller
        .listTabs()
        .then((tabs) => {
          if (cancelled) return;
          if (tabs.length === 0) {
            void controller.newTab('https://smirk.cash');
          }
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      // Unregister the page-request handler on unmount so a
      // re-mounted BrowseTab (different controller instance, or
      // simply hot-reload during dev) doesn't end up with a stale
      // listener pointing at a dead React tree.
      void controller.setPageRequestHandler(null);
      // Leave the controller's tabs OPEN across mounts so navigation
      // state persists when the user toggles back to Home and back
      // to Browse.
    };
  }, [controller, queue]);

  const handleApprove = async (approval: ApprovalApproval) => {
    if (!pending) return;
    // Convert the dapp's human decimal amount to atomic units once (wallet owns the
    // per-asset decimals). A malformed amount surfaces on the ApprovalScreen.
    const { request, amountError } = normalizePaymentAmount(pending);
    if (amountError) throw new Error(amountError);
    const ws = walletStateRef.current;
    if (!ws || ws.kind !== 'unlocked') {
      // Wallet locked between request arrival and approve click.
      // Resolve as denied so the page sees USER_REJECTED rather
      // than hanging on the modal that just disappeared.
      queue.resolveCurrent({ approved: false });
      return;
    }
    try {
      const result = await executeApproval(request, approval, {
        wallet: ws.wallet,
        ensureWasmInit,
        send,
        claimPublicTip,
        readBootstrapCache,
        api,
        loadState: () => store.load(),
        updateState: (m) => store.update(m),
      });
      queue.resolveCurrent(result);
    } catch (e) {
      console.error('[BrowseTab] executeApproval threw:', e);
      queue.resolveCurrent({ approved: false });
    }
  };

  const handleDeny = () => {
    queue.resolveCurrent({ approved: false });
  };

  // BrowserShell must render UNWRAPPED so its content-frame
  // `getBoundingClientRect` returns the same rect the parent
  // AppShell gave it — any extra flex/grid wrapper collapses the
  // measured slot and the embedded WebviewWindow ends up
  // positioned over a zero-size area (i.e. invisible).
  //
  // The approval modal renders as a sibling at `position: fixed`,
  // overlaying the entire wallet window (sidebar included). That's
  // intentional: while a dapp approval is pending, the only
  // sensible actions are Approve / Deny / close-wallet — letting
  // the user click the Home tab and forget the request open is a
  // worse UX.
  // When the controller advertises `inlineMode` (currently the
  // `IframeBrowserController` used on Linux desktop), pass an
  // `IframeBrowserContent` into `BrowserShell`'s frame slot so the
  // iframe elements live inside the React tree. For native-WebView
  // controllers (Tauri WebviewWindow on macOS / Windows) the slot
  // stays empty and the controller overlays its own native window
  // via `setFrameRect`. Same component for both — only the slot
  // content differs.
  const isInlineController =
    (controller as { inlineMode?: boolean }).inlineMode === true;
  const slotContent = isInlineController ? (
    <IframeBrowserContent
      controller={controller as unknown as IframeBrowserController}
    />
  ) : null;

  return (
    <Fragment>
      {!opened ? (
        <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>
          Loading browser…
        </div>
      ) : (
        <BrowserShell controller={controller} slotContent={slotContent} />
      )}
      {pending && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            style={{
              maxWidth: 420,
              width: '90%',
              maxHeight: '90%',
              overflow: 'auto',
              background: 'var(--smirk-bg)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 8,
            }}
          >
            <ApprovalScreen
              request={normalizePaymentAmount(pending).request as unknown as UiApprovalRequest}
              onApprove={handleApprove}
              onDeny={handleDeny}
              formatAmount={(asset, atomic) => {
                try {
                  return formatAmountWithTicker(BigInt(atomic), asset);
                } catch {
                  return atomic;
                }
              }}
            />
          </div>
        </div>
      )}
    </Fragment>
  );
}
