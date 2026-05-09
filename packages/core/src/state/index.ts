/**
 * `@smirk/core/state` — popup state, route persistence, wizard scaffold.
 *
 * Framework-agnostic. Reactive UI bindings (Preact hooks like
 * `usePopupState`, `useRoute`, `useWizard`) live in `@smirk/ui/state`.
 *
 * @example Boot in an extension popup
 * ```ts
 * import { autoDetectEphemeralStorage, PopupStateStore, RouteController } from '@smirk/core/state';
 *
 * const storage = autoDetectEphemeralStorage();
 * const popupState = new PopupStateStore(storage);
 * const router = new RouteController(popupState);
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
 * const tipWizard = new Wizard<TipFields>(popupState, 'tip-maker', {});
 * await tipWizard.start();
 * await tipWizard.setField('assetId', 'btc');
 * await tipWizard.next();   // → step 1
 * // popup closes, browser doesn't restart
 * // popup reopens
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
  DEFAULT_POPUP_STATE,
  MIGRATIONS,
  PopupStateStore,
  migrate,
} from './popup-state';
export type { Migration, PopupState, Route, WizardState } from './popup-state';

export { RouteController, tabOf } from './route';
export type { Tab } from './route';

export { Wizard } from './wizards';
