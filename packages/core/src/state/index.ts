/**
 * `@smirk/core/state` — session state, route persistence, wizard scaffold.
 *
 * "Session" semantics differ per platform (extension popup-close,
 * mobile backgrounding, desktop window-close) — see
 * [`./session-state.ts`] for the lifetime model.
 *
 * Framework-agnostic. Reactive UI bindings (Preact hooks like
 * `useSessionState`, `useRoute`, `useWizard`) live in `@smirk/ui/state`.
 *
 * @example Boot in an extension popup
 * ```ts
 * import { autoDetectEphemeralStorage, SessionStateStore, RouteController } from '@smirk/core/state';
 *
 * const storage = autoDetectEphemeralStorage();
 * const session = new SessionStateStore(storage);
 * const router = new RouteController(session);
 *
 * await router.navigate('home');           // go home
 * await router.navigate('home/asset/btc'); // drill into BTC
 * await router.back();                     // back to home
 * ```
 *
 * @example Multi-step wizard
 * ```ts
 * import { Wizard } from '@smirk/core/state';
 *
 * interface TipFields {
 *   assetId?: string;
 *   amountAtomic?: string;
 *   note?: string;
 * }
 *
 * const tipWizard = new Wizard<TipFields>(session, 'tip-maker', {});
 * await tipWizard.start();
 * await tipWizard.setField('assetId', 'btc');
 * await tipWizard.next();   // → step 1
 * // session ends (popup closes, app backgrounded, window closes...)
 * // session resumes
 * const snap = await tipWizard.snapshot();
 * // snap.step === 1, snap.fields.assetId === 'btc'
 * ```
 */

export {
  ChromeLocalStorage,
  ChromeSessionStorage,
  InMemoryStorage,
  WebLocalStorage,
  autoDetectEphemeralStorage,
} from './platform';
export type { PlatformStorage } from './platform';

export {
  CURRENT_VERSION,
  DEFAULT_SESSION_STATE,
  MIGRATIONS,
  SessionStateStore,
  migrate,
} from './session-state';
export type { Migration, SessionState, Route, WizardState } from './session-state';

export { RouteController, tabOf } from './route';
export type { Tab } from './route';

export { Wizard } from './wizards';

export {
  isStale as isPendingOutgoingStale,
  pendingOutgoingFor,
  pendingOutgoingTotal,
  pendingOutgoingTotalWithFee,
  inFlightInputsTotal,
  expectedLockedChange,
  recentlySpentInputs,
  reconcilePendingOutgoing,
} from './pending-outgoing';
export type { PendingOutgoingTx } from './pending-outgoing';

export {
  visibleAssetIds,
  isAssetVisible,
  withAssetVisibility,
} from './visibility';
