import { useEffect, useState } from 'preact/hooks';
import { api, type WalletState } from '@smirk/core';
import {
  applyTheme,
  defaultTheme,
  getTheme,
  formatAmountWithTicker,
  LockScreen,
  ApprovalScreen,
  type ApprovalApproval,
  type ApprovalRequest as UiApprovalRequest,
} from '@smirk/ui';
import type { ApprovalResult as DappApprovalResult } from '@such-software/smirk-dapp-api';
import { store, walletKeystore } from '../singletons';
import { normalizePaymentAmount } from '../format';
import { tryRestoreSessionCache, writeSessionCache, convergeLegacySweep } from '../session-cache';
import { dappPublicCacheFor } from '../dapp-public-cache';
import { readBootstrapCache } from '../bootstrap-cache';
import { ensureWasmInit } from '../wasm-init';
import { send } from '../send-handler';
import { claimPublicTip } from '../tip-claim-handler';
import { approvalPopupBridge, type PendingApproval } from '../../background/dapp/approval';
import { writeDappPublicCache } from '../../background/dapp/provider';
import { executeApproval } from '../../dapp-popup';

interface ApprovalAppProps {
  approvalId: string;
}

export function ApprovalApp({ approvalId }: ApprovalAppProps) {
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [missing, setMissing] = useState(false);

  // Mirror the main App's theme bootstrap; without this the
  // approval popup renders with NO `--smirk-*` CSS variables set,
  // so ApprovalScreen's themed colors (asset-chip background,
  // origin text contrast, etc.) all fall back to "undefined" and
  // the popup looks like an unstyled white-on-black mess (the
  // exact bug shown in the connect-prompt screenshot).
  useEffect(() => {
    const apply = (themeId: string) => {
      applyTheme(getTheme(themeId) ?? defaultTheme);
    };
    void store.load().then((s) => apply(s.ui.theme ?? 'default'));
    return store.subscribe((s) => apply(s.ui.theme ?? 'default'));
  }, []);

  const refresh = async () => {
    await tryRestoreSessionCache();
    const ks = await walletKeystore.getState();
    setWalletState(ks);
    const p = await approvalPopupBridge.readPending(approvalId);
    if (!p) {
      // SW already cleaned it up (race), or never wrote it. Show
      // "no longer valid" and close shortly.
      setMissing(true);
      return;
    }
    setPending(p);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Cache public material on unlock just like the main app does, so
  // the SW provider stays consistent even if the user first unlocked
  // inside an approval flow. Threads `autoLockMinutes` through so
  // the SW provider's session-expiry check works (Finding 13).
  useEffect(() => {
    if (walletState?.kind === 'unlocked') {
      void store.load().then((s) => {
        const minutes = s.ui.autoLockMinutes ?? 0;
        void writeDappPublicCache(
          dappPublicCacheFor(walletState.wallet, minutes),
        );
      });
    }
  }, [walletState]);

  if (missing) {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.7 }}>
        This approval is no longer valid.
        <div style={{ marginTop: 12 }}>
          <button onClick={() => window.close()} style={{ padding: '6px 12px' }}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!walletState || !pending) {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>Loading…</div>
    );
  }

  if (walletState.kind === 'empty') {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.7 }}>
        No wallet — open Smirk to create one, then approve again.
        <div style={{ marginTop: 12 }}>
          <button onClick={() => window.close()} style={{ padding: '6px 12px' }}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (walletState.kind === 'locked') {
    return (
      <LockScreen
        iconUrl={chrome.runtime.getURL('icons/icon-128.png')}
        onUnlock={async (password) => {
          const wallet = await walletKeystore.unlock(password);
          const minutes = (await store.load()).ui.autoLockMinutes ?? 0;
          await writeSessionCache(wallet, minutes);
          // Converge any un-swept legacy m/44' funds (in-between wallets that
          // migrated the keystore before the sweep shipped). Fire-and-forget so
          // unlock stays snappy; idempotent + gated on legacy state presence.
          void convergeLegacySweep(wallet);
          await refresh();
        }}
      />
    );
  }

  const wallet = walletState.wallet;

  // Dapps quote a human decimal amount (e.g. "9" WOW); the wallet converts it to
  // atomic units ONCE here (it owns each asset's decimals), so the confirmation
  // display and the executed tx agree and `BigInt()` never chokes on a decimal.
  const { request, amountError } = normalizePaymentAmount(pending.request);

  // atomic units -> "9 WOW" for the confirmation; robust if a value is malformed.
  const formatAmount = (asset: string, atomic: string): string => {
    try {
      return formatAmountWithTicker(BigInt(atomic), asset);
    } catch {
      return atomic;
    }
  };

  const finish = async (result: DappApprovalResult) => {
    await approvalPopupBridge.writeResult(approvalId, result);
    // Give the SW a tick to pick up the storage change before the
    // window disappears: chrome.storage.onChanged fires async.
    setTimeout(() => window.close(), 50);
  };

  const handleApprove = async (approval: ApprovalApproval) => {
    // A malformed dapp amount is surfaced here (ApprovalScreen shows the error and
    // stays open) instead of proceeding with a bad payment.
    if (amountError) throw new Error(amountError);
    // Delegate to the shared executor used by every wallet-foreground
    // approval surface (extension popup window AND Tauri desktop's
    // BrowseTab modal). The executor calls `ensureWasmInit()` itself,
    // computes signatures with the unlocked wallet, performs payments
    // / claims, and returns the result envelope to pass back to the
    // SW via `approvalPopupBridge.writeResult`.
    const result = await executeApproval(request, approval, {
      wallet,
      ensureWasmInit,
      send,
      claimPublicTip,
      readBootstrapCache,
      api,
      loadState: () => store.load(),
      updateState: (m) => store.update(m),
    });
    await finish(result);
  };

  // Translate the dapp-api ApprovalRequest into the UI's shape. They
  // line up 1:1 by design; this is just a name-spaced cast that
  // keeps the UI package decoupled from the protocol package.
  const uiRequest = request as unknown as UiApprovalRequest;

  return (
    <ApprovalScreen
      request={uiRequest}
      onApprove={handleApprove}
      onDeny={() => void finish({ approved: false })}
      formatAmount={formatAmount}
    />
  );
}
