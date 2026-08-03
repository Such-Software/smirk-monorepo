/**
 * `dapp-popup`: wallet-foreground dapp infrastructure shared across
 * the platforms where the wallet runs in a single trusted UI context
 * (Tauri desktop today, Capacitor mobile in v0.4).
 *
 * The Chrome MV3 extension path uses a different composition,
 * `background/dapp/*`, because its trusted context is a separate
 * popup window opened by the SW. See ARCHITECTURE.md for why the
 * surface splits.
 */

export { signMessageWithUnlocked } from './signers';
export { executeApproval, type ExecuteApprovalDeps } from './execute-approval';
export {
  createInPopupApprovalQueue,
  type InPopupApprovalQueue,
} from './in-popup-approval';
export { createPageRequestBridge, type PageRequest } from './page-bridge';
export { createLiveWalletProvider } from './live-wallet-provider';
