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
 * Skeleton today — components fill in as the redesign work progresses.
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

export const UI_PACKAGE_VERSION = '0.0.1';

// ----- Components -----
export { ActionButton, ActionRow } from './components/ActionButton';
export type { ActionButtonProps, ActionRowProps } from './components/ActionButton';

export { Button } from './components/Button';
export type { ButtonProps } from './components/Button';

export { AssetIcon } from './components/AssetIcon';
export type { AssetIconProps } from './components/AssetIcon';

export { BalanceCard } from './components/BalanceCard';
export type { BalanceCardProps } from './components/BalanceCard';

export { UnifiedBalance, HomeActionRow } from './components/UnifiedBalance';
export type {
  UnifiedBalanceProps,
  HomeActionRowProps,
} from './components/UnifiedBalance';

export { HomeTab } from './components/HomeTab';
export type { HomeTabProps, HomeAssetRow } from './components/HomeTab';

export { SendWizard } from './components/SendWizard';
export type {
  SendWizardProps,
  SendFields,
  SendSubmitResult,
} from './components/SendWizard';

export { ReceiveScreen } from './components/ReceiveScreen';
export type { ReceiveScreenProps } from './components/ReceiveScreen';

export { OnboardingWizard } from './components/OnboardingWizard';
export type { OnboardingWizardProps } from './components/OnboardingWizard';

export { LockScreen } from './components/LockScreen';
export type { LockScreenProps } from './components/LockScreen';

// ----- Shell -----
export { AppShell } from './components/shell/AppShell';
export type { AppShellProps } from './components/shell/AppShell';
export { BottomNav } from './components/shell/BottomNav';
export type { BottomNavProps } from './components/shell/BottomNav';

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
  registerTheme,
  listThemes,
  getTheme,
  applyTheme,
  resetTheme,
} from './themes';

// ----- Helpers -----
export { formatAmount, formatAmountWithAsset, formatAmountWithTicker } from './format';
