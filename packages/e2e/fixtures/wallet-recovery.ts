/**
 * Bring a reopened wallet back to the root of Home, from whatever screen it
 * restored, within a fixed budget, and say what it found.
 *
 * The wallet restores its last route and every open wizard when the popup
 * reopens (core/src/state/route.ts, wizards.ts). A lane that reopens a kept
 * profile after a failed test therefore lands on whatever that test left: a
 * Send draft on Review, a finished tip, a coin screen, Settings. The open
 * fixtures used to wait up to five minutes for Home's balance there, which
 * never came, and every later test of the run failed the same way.
 *
 * Moves, in order, each only when its control is on screen:
 *   1. a result or sheet's own close control (send receipt, tip result,
 *      pasted tip, transaction or tip sheet), or Escape for another dialog;
 *   2. Back (then Cancel) through a Send draft, but only on the steps that hold
 *      no funds in flight (asset, address, amount, Review): stepping out of a
 *      Grin exchange would drop its slate, so that screen is left in place and
 *      only navigated away from;
 *   3. back from a coin's detail screen;
 *   4. the Home tab: a tap on the active tab returns to its root, a tap on
 *      another tab first restores Home's own last screen, which the next round
 *      handles.
 * Swaps are never cancelled here: a swap screen is left by the Home tab and
 * its state kept, because a deposit may already be on its way.
 *
 * Home counts only once it has held for a short settle window. The restored
 * route can paint after Home: on 2026-10-14 carol's unlock showed Home, then
 * her restored BTC coin screen, and a single look had already returned 'home'.
 * waitForHome below is the long wait a caller makes after that, and it brings
 * the wallet back again whenever another shell screen replaces Home.
 *
 * Every move is a navigation the wallet offers its user; none signs, sends or
 * changes the backend. The lock screen, onboarding and the bootstrap-error
 * screen are returned to the caller, which knows how to answer them.
 *
 * Nothing on screen is read except test ids and whether a dialog is open; the
 * report names screens by those ids (shaped, see failure-record.mjs), so it may
 * be printed and logged.
 */
import type { Locator, Page } from '@playwright/test';
import { noteRecovery, noteStep, readScreen, type ScreenIds } from './failure-context.js';
import { safeTestIds } from './failure-record.mjs';

export type WalletSurface = 'home' | 'locked' | 'onboarding' | 'bootstrap-error';

export class WalletRecoveryError extends Error {
  constructor(
    message: string,
    /** `no-surface`: the popup never showed a wallet screen; `stuck`: no move reached Home. */
    readonly reason: 'no-surface' | 'stuck',
    readonly report: RecoveryReport,
  ) {
    super(message);
  }
}
// On the prototype, so the stack's first line names the class too.
WalletRecoveryError.prototype.name = 'WalletRecoveryError';

export interface RecoveryReport {
  wallet: string;
  /** Where it ended. */
  reached: WalletSurface;
  /** The first screen that was not Home, by shaped test ids without the shell; null when it opened on Home. */
  from: string[] | null;
  /** The moves made, in order (static labels). */
  moves: string[];
  /** What was deliberately left in place, if anything. */
  kept?: string;
  ms: number;
}

export interface RecoveryOptions {
  /** The wallet's name, for the report. */
  wallet: string;
  /** How long the popup may take to show any wallet screen at all. Default 60 s. */
  firstPaintMs?: number;
  /** How long the moves may take once a screen shows. Default 45 s; a recorded tap holds the screen first, so pass more. */
  budgetMs?: number;
  /** The most moves before giving up. Default 12. */
  maxMoves?: number;
  /** How long Home must hold before it counts. Default 2.5 s. */
  settleMs?: number;
  /** A recorded lane's tap (holds before tapping). Default: a plain, bounded click. */
  tap?: (target: Locator, label: string) => Promise<void>;
  /** A recorded lane's key press. Default: a plain key press. */
  press?: (page: Page, key: string, label: string) => Promise<void>;
}

type Screen = ScreenIds & { surface: WalletSurface | 'shell' | 'loading' };

/** Shell chrome present on every screen: not what the screen is. */
const CHROME = /^(?:app-shell-root|app-shell-header|app-shell-header-actions|bottom-nav|nav-tab-.+)$/;

/** Controls that close a finished result or a sheet, and nothing else. */
const CLOSERS: readonly { id: string; label: string }[] = [
  { id: 'send-done-close', label: 'close the send receipt' },
  { id: 'tip-success-done-btn', label: 'close the tip result' },
  { id: 'paste-tip-done-btn', label: 'close the pasted tip' },
  { id: 'tx-detail-close', label: 'close the transaction sheet' },
  { id: 'tip-detail-close', label: 'close the tip sheet' },
];

/** Send steps whose draft holds no funds in flight; Back from each, and Cancel from the first, only discard a draft. */
function sendDraftStep(ids: readonly string[]): boolean {
  return ids.some(
    (id) =>
      id === 'send-review-submit' ||
      id === 'send-compose-continue' ||
      id === 'send-amount-input' ||
      id === 'send-address-input' ||
      id === 'send-address-continue' ||
      id.startsWith('send-asset-'),
  );
}

function classify(screen: ScreenIds): Screen {
  const has = (id: string) => screen.ids.includes(id);
  const shell = has('bottom-nav');
  let surface: Screen['surface'] = 'loading';
  if (has('lockscreen-root') || has('lockscreen-password-input')) surface = 'locked';
  else if (!shell && screen.ids.some((id) => id.startsWith('onboarding-'))) surface = 'onboarding';
  else if (has('home-total-balance') && !screen.dialog) surface = 'home';
  else if (has('bootstrap-error')) surface = 'bootstrap-error';
  else if (shell) surface = 'shell';
  return { ...screen, surface };
}

async function look(page: Page): Promise<Screen> {
  return classify(await readScreen(page).catch(() => ({ ids: [], dialog: false })));
}

const signature = (screen: ScreenIds) => `${screen.dialog ? 'dialog|' : ''}${screen.ids.join(' ')}`;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until the screen differs from `before` (or `ms` passes); returns what it shows then. */
async function changed(page: Page, before: string, ms: number): Promise<Screen> {
  const deadline = Date.now() + ms;
  let screen = await look(page);
  while (signature(screen) === before && Date.now() < deadline) {
    await pause(200);
    screen = await look(page);
  }
  return screen;
}

/** Home, held for `ms`; or the first screen that replaced it. */
async function heldHome(page: Page, ms: number): Promise<Screen | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await pause(Math.min(250, Math.max(0, deadline - Date.now())));
    const screen = await look(page);
    if (screen.surface !== 'home') return screen;
  }
  return null;
}

function describe(ids: readonly string[] | null): string {
  return ids?.length ? ids.slice(0, 8).join(', ') : 'no test ids';
}

/**
 * From whatever the wallet page shows, to the root of Home: or to the lock
 * screen, onboarding or the bootstrap-error screen, which the caller answers.
 * Throws WalletRecoveryError, naming the screen by its test ids, when the
 * popup shows no wallet screen in time or no move reaches Home.
 */
export async function recoverToHome(page: Page, options: RecoveryOptions): Promise<RecoveryReport> {
  const started = Date.now();
  const firstPaintMs = options.firstPaintMs ?? 60_000;
  const budgetMs = options.budgetMs ?? 45_000;
  const maxMoves = options.maxMoves ?? 12;
  const settleMs = options.settleMs ?? 2_500;
  const tap = options.tap ?? ((target: Locator) => target.click({ timeout: 5_000 }));
  const press = options.press ?? ((p: Page, key: string) => p.keyboard.press(key));
  const report: RecoveryReport = { wallet: options.wallet, reached: 'home', from: null, moves: [], ms: 0 };
  const tried = new Set<string>();
  const finish = (reached: WalletSurface): RecoveryReport => {
    report.reached = reached;
    report.ms = Date.now() - started;
    if (report.from || report.moves.length) noteRecovery({ ...report });
    return report;
  };
  const fail = (reason: 'no-surface' | 'stuck', message: string): never => {
    report.ms = Date.now() - started;
    const { reached: _unreached, ...partial } = report;
    noteRecovery({ ...partial, failed: true });
    throw new WalletRecoveryError(message, reason, { ...report });
  };

  // The popup's first screen: the wallet boots before it shows anything.
  let screen = await look(page);
  const paintDeadline = started + firstPaintMs;
  while (screen.surface === 'loading' && Date.now() < paintDeadline) {
    await pause(250);
    screen = await look(page);
  }
  if (screen.surface === 'loading') {
    fail('no-surface', `${options.wallet}: no wallet screen appeared within ${Math.round(firstPaintMs / 1000)} s (showing: ${describe(safeTestIds(screen.ids, 8))})`);
  }

  const moveDeadline = Date.now() + budgetMs;
  for (;;) {
    if (screen.surface === 'home') {
      // Judge Home once it holds: a restored route may replace it a moment later.
      const replaced = await heldHome(page, settleMs);
      if (!replaced) return finish('home');
      screen = replaced;
      continue;
    }
    if (screen.surface !== 'shell' && screen.surface !== 'loading') return finish(screen.surface);
    if (report.moves.length >= maxMoves || Date.now() >= moveDeadline) {
      fail('stuck', `${options.wallet}: still not on Home after ${report.moves.length} moves (${report.moves.join(', ') || 'none'}); it opened on ${describe(report.from)} and now shows ${describe(safeTestIds(screen.ids.filter((id) => !CHROME.test(id)), 8))}`);
    }
    if (screen.surface === 'loading') {
      // Between screens (a route change can render Loading first).
      screen = await changed(page, signature(screen), Math.min(5_000, Math.max(0, moveDeadline - Date.now())));
      continue;
    }
    report.from ??= safeTestIds(screen.ids.filter((id) => !CHROME.test(id)), 16);

    const before = signature(screen);
    const fresh = (label: string) => !tried.has(`${before}|${label}`);
    let move: { label: string; run: () => Promise<void> } | null = null;
    const closer = CLOSERS.find((c) => screen.ids.includes(c.id) && fresh(c.label));
    if (closer) {
      move = { label: closer.label, run: () => tap(page.getByTestId(closer.id).first(), closer.label) };
    } else if (screen.dialog && fresh('dismiss the dialog')) {
      move = { label: 'dismiss the dialog', run: () => press(page, 'Escape', 'dismiss the dialog') };
    } else if (screen.ids.includes('send-wizard-header-back') && sendDraftStep(screen.ids) && fresh('step back out of the send draft')) {
      move = { label: 'step back out of the send draft', run: () => tap(page.getByTestId('send-wizard-header-back'), 'step back out of the send draft') };
    } else if (screen.ids.includes('asset-detail-back') && fresh('back from the coin screen')) {
      move = { label: 'back from the coin screen', run: () => tap(page.getByTestId('asset-detail-back'), 'back from the coin screen') };
    } else if (screen.ids.includes('nav-tab-home') && fresh('tap the Home tab')) {
      if (screen.ids.includes('send-wizard-header-back') && !sendDraftStep(screen.ids)) report.kept = 'a send in progress was left in place';
      else if (screen.ids.some((id) => /^swap-(?:wizard|deposit|status)-/.test(id))) report.kept = 'a swap in progress was left in place';
      move = { label: 'tap the Home tab', run: () => tap(page.getByTestId('nav-tab-home'), 'tap the Home tab') };
    }
    if (!move) {
      // Every move this screen offers was tried: give a slow render one more
      // chance to change it, then stop.
      const later = await changed(page, before, Math.min(5_000, Math.max(0, moveDeadline - Date.now())));
      if (signature(later) !== before) {
        screen = later;
        continue;
      }
      fail('stuck', `${options.wallet}: no way back to Home from ${describe(safeTestIds(screen.ids.filter((id) => !CHROME.test(id)), 8))} (moves so far: ${report.moves.join(', ') || 'none'})`);
      return report; // unreachable: fail throws
    }

    tried.add(`${before}|${move.label}`);
    noteStep(`recover ${options.wallet}: ${move.label}`);
    report.moves.push(move.label);
    await move.run().catch(() => undefined);
    screen = await changed(page, before, Math.min(5_000, Math.max(0, moveDeadline - Date.now())));
  }
}

export interface HomeWaitOptions extends RecoveryOptions {
  /** The whole wait: a returning wallet may solve proof of work or rescan before Home shows. */
  timeoutMs: number;
  /** How often to look. Default 1 s. */
  sliceMs?: number;
  /** How many recoveries may run before giving up. Default 5. */
  maxRecoveries?: number;
}

/**
 * Wait, within one budget, for Home's root to show and hold. Whenever the
 * shell shows another screen instead (a restored coin screen, Settings, a
 * sheet), bring it back with recoverToHome rather than wait out the budget
 * on a screen one tap could leave. Anything else (loading, onboarding still
 * finishing, the lock screen) is waited on as before. True when Home holds;
 * false when the budget or the recoveries ran out, so the caller can name
 * the screen it was left on.
 */
export async function waitForHome(page: Page, options: HomeWaitOptions): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  const sliceMs = options.sliceMs ?? 1_000;
  const maxRecoveries = options.maxRecoveries ?? 5;
  let recoveries = 0;
  for (;;) {
    const screen = await look(page);
    if (screen.surface === 'home' || screen.surface === 'shell') {
      if (recoveries++ >= maxRecoveries) return false;
      try {
        const { reached } = await recoverToHome(page, { ...options, firstPaintMs: Math.max(1_000, deadline - Date.now()) });
        if (reached === 'home') return true;
      } catch (error) {
        // Already noted as failed; a slow sign-in may still be painting, so look again.
        if (!(error instanceof WalletRecoveryError)) throw error;
      }
    }
    if (Date.now() >= deadline) return false;
    await pause(Math.min(sliceMs, Math.max(0, deadline - Date.now())));
  }
}
