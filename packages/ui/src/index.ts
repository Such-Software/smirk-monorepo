/**
 * @smirk/ui — shared Preact components for the Smirk wallet.
 *
 * Drives the action-centric redesign described in
 * `smirk-monorepo/docs/UI_DESIGN.md`. Components are presentational and
 * registry-driven — they take asset ids (not hardcoded chains) and
 * render against `@smirk/assets` definitions.
 *
 * Consumers (extension popup, Capacitor mobile, Tauri desktop) wrap
 * these with their own platform-specific wiring (storage, navigation,
 * icon assets, fiat-rate fetching) but share the visual surface.
 *
 * @example
 * ```tsx
 * import { BalanceCard, ActionButton, ActionRow, formatAmount } from '@smirk/ui';
 * import { listAssets } from '@smirk/assets';
 *
 * function Home() {
 *   return (
 *     <>
 *       <ActionRow>
 *         <ActionButton label="Tip"   icon="🎁" onClick={...} />
 *         <ActionButton label="Send"  icon="↗"  onClick={...} />
 *         <ActionButton label="Swap"  icon="⇄"  onClick={...} />
 *         <ActionButton label="Claim" icon="📥" onClick={...} />
 *       </ActionRow>
 *       {listAssets().map((a) => (
 *         <BalanceCard key={a.id} assetId={a.id} balanceAtomic={...} />
 *       ))}
 *     </>
 *   );
 * }
 * ```
 */

// ----- Components -----
export { ActionButton, ActionRow } from './components/ActionButton';
export type { ActionButtonProps, ActionRowProps } from './components/ActionButton';

export { Button } from './components/Button';
export type { ButtonProps } from './components/Button';

export { AssetIcon } from './components/AssetIcon';
export type { AssetIconProps } from './components/AssetIcon';

export { BalanceCard } from './components/BalanceCard';
export type { BalanceCardProps } from './components/BalanceCard';
export { AssetDetailScreen } from './components/AssetDetailScreen';
export type {
  AssetDetailScreenProps,
  AssetDetailTxRow,
  SparklinePoint,
} from './components/AssetDetailScreen';
export { SentTipsScreen } from './components/SentTipsScreen';
export type { SentTipRow, SentTipsScreenProps } from './components/SentTipsScreen';

export { UnifiedBalance, HomeActionRow } from './components/UnifiedBalance';
export type {
  UnifiedBalanceProps,
  HomeActionRowProps,
} from './components/UnifiedBalance';

export {
  FreshnessCue,
  computeFreshnessLevel,
  FRESHNESS_WARN_MS,
  FRESHNESS_ERROR_MS,
} from './components/FreshnessCue';
export type { FreshnessCueProps, FreshnessLevel } from './components/FreshnessCue';

export { HomeTab } from './components/HomeTab';
export type { HomeTabProps, HomeAssetRow } from './components/HomeTab';

export { ClaimableTipsBanner } from './components/ClaimableTipsBanner';
export type { ClaimableTipsBannerProps } from './components/ClaimableTipsBanner';

export { ReadyToShareTipsBanner } from './components/ReadyToShareTipsBanner';
export type { ReadyToShareTipsBannerProps } from './components/ReadyToShareTipsBanner';

export { SwapTab, TROCADOR_WIZARD_ID } from './components/SwapTab';
export type {
  SwapTabProps,
  SwapQuoteSummary,
  SwapInFlight,
  SwapKindBadge,
  SwapProviderStatus,
} from './components/SwapTab';

export { SendWizard } from './components/SendWizard';
export type {
  SendWizardProps,
  SendFields,
  SendSubmitResult,
  GrinBuildSlateResult,
  GrinBuildSlateOutcome,
  GrinFinalizeResult,
  GrinFinalizeOutcome,
} from './components/SendWizard';

export { GrinRequestWizard } from './components/GrinRequestWizard';
export type {
  GrinRequestWizardProps,
  GrinRequestFields,
  GrinRequestBuildResult,
  GrinRequestBuildOutcome,
  GrinRequestFinalizeResult,
  GrinRequestFinalizeOutcome,
} from './components/GrinRequestWizard';

export { GrinPasteIncomingWizard } from './components/GrinPasteIncomingWizard';
export type {
  GrinPasteIncomingWizardProps,
  GrinPasteIncomingFields,
  GrinPasteIncomingSignResult,
  GrinPasteIncomingSignOutcome,
} from './components/GrinPasteIncomingWizard';

export { GrinPayInvoiceWizard } from './components/GrinPayInvoiceWizard';
export type {
  GrinPayInvoiceWizardProps,
  GrinPayInvoiceFields,
  GrinPayInvoiceSignResult,
  GrinPayInvoiceSignOutcome,
} from './components/GrinPayInvoiceWizard';

export { ReceiveScreen } from './components/ReceiveScreen';
export type { ReceiveScreenProps } from './components/ReceiveScreen';

export { OnboardingWizard } from './components/OnboardingWizard';
export type {
  ExistingIdentity,
  ExistingSocial,
  OnboardingWizardProps,
  OnboardingRegistration,
} from './components/OnboardingWizard';
export { MigrationWizard } from './components/MigrationWizard';
export type { MigrationWizardProps } from './components/MigrationWizard';
export { BackendPicker } from './components/BackendPicker';
export type { BackendPickerProps, BackendProbeInfo } from './components/BackendPicker';
export { IdentityPicker, IdentityAvatar, shortNpubDisplay } from './components/IdentityPicker';
export type { PickerIdentity, IdentitySource } from './components/IdentityPicker';

export { LockScreen } from './components/LockScreen';
export type { LockScreenProps } from './components/LockScreen';

export { ApprovalScreen } from './components/ApprovalScreen';
export type {
  ApprovalScreenProps,
  ApprovalRequest,
  ApprovalApproval,
  ApprovalOrigin,
  ApprovalAsset,
} from './components/ApprovalScreen';

export { TipMaker } from './components/TipMaker';
export type {
  TipMakerProps,
  TipPlatform,
  RecentRecipient,
  TipSubmitFields,
  TipSubmitOutcome,
} from './components/TipMaker';

export { InboxTab } from './components/InboxTab';
export type {
  InboxTabProps,
  InboxItem,
  InboxItemBase,
  InboxItemPendingToSign,
  InboxItemPendingToFinalize,
  InboxTipItem,
} from './components/InboxTab';

// ----- Shell -----
export { AppShell } from './components/shell/AppShell';
export type { AppShellProps } from './components/shell/AppShell';
export { BottomNav } from './components/shell/BottomNav';
export type { BottomNavProps } from './components/shell/BottomNav';

// ----- Embedded browser -----
// Pluggable chrome around a @smirk/dapp-browser controller. See
// `docs/EMBEDDED_BROWSER.md` for the architecture.
export { BrowserShell } from './components/browser/BrowserShell';
export type { BrowserShellProps } from './components/browser/BrowserShell';
export { BrowserUrlBar } from './components/browser/BrowserUrlBar';
export type { BrowserUrlBarProps } from './components/browser/BrowserUrlBar';
export { BrowserTabStrip } from './components/browser/BrowserTabStrip';
export type { BrowserTabStripProps } from './components/browser/BrowserTabStrip';
export {
  IframeBrowserContent,
  SMIRK_DAPP_POSTMESSAGE_CHANNEL,
} from './components/browser/IframeBrowserContent';
export type { IframeBrowserContentProps } from './components/browser/IframeBrowserContent';

// ----- State / hooks -----
export {
  StateProvider,
  useIsPopout,
  useSessionState,
  useRoute,
  useWizard,
} from './state/hooks';
export type {
  StateProviderProps,
  UseRouteApi,
  UseWizardApi,
} from './state/hooks';

// ----- Themes -----
export type { Theme, ThemeTokens } from './themes';
export {
  defaultTheme,
  win95Theme,
  winxpTheme,
  amigaTheme,
  iosClassicTheme,
  gameboyTheme,
  n64Theme,
  registerTheme,
  listThemes,
  getTheme,
  applyTheme,
  resetTheme,
} from './themes';

// ----- Helpers -----
export { formatAmount, formatAmountWithAsset, formatAmountWithTicker } from './format';

// ----- Advanced settings -----
export { RevealKeysPanel } from './components/RevealKeysPanel';
export type {
  RevealKeysPanelProps,
  RevealKeysPanelWallet,
} from './components/RevealKeysPanel';
