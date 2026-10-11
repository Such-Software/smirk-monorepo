/**
 * What a relaunched wallet reopens.
 *
 * Session state keeps the route and every wizard's fields, so closing the
 * wallet mid-flow resumes that flow where it stopped. A flow that already
 * finished is different: its result screen ("Tip sent", a send receipt, a
 * completed swap) has told the user the outcome, and reopening on it reads as
 * if the operation were still pending or about to run again. A relaunch
 * therefore drops finished flows and opens Home. Drafts, and operations still
 * in flight, resume exactly as before.
 *
 * A flow is known to be finished in one of two ways:
 *
 * - A wizard-backed flow is judged from its persisted state by a
 *   [`FinishedFlowRule`]: a send on its receipt step, a swap its provider
 *   settled. Judging the stored state also covers state an older build wrote
 *   before this module existed.
 * - A screen that holds its result only in memory (the tip composer, a pasted
 *   tip link claim) marks its own route with `RouteController.markFinished`.
 *
 * Dropping state is the direction that cannot be undone, so a rule that cannot
 * read the state it is given keeps it.
 */

import type { Route, SessionState, SessionStateStore, WizardState } from './session-state';

/** Route param a result screen sets on its own route; see `RouteController.markFinished`. */
export const FINISHED_ROUTE_PARAM = 'finished';

/** Where a relaunch lands in place of a finished flow. */
const LAUNCH_ROUTE = 'home';

/** How to tell that one wizard-backed flow has finished. */
export interface FinishedFlowRule {
  /** Wizard id whose persisted state the rule judges. */
  wizardId: string;
  /** Routes that show this wizard: each an exact route id, or a prefix followed by `/`. */
  routes: readonly string[];
  /**
   * True when the persisted state shows a result with nothing left to resume.
   * A draft, or an operation still in flight, must answer false.
   */
  finished: (state: WizardState) => boolean;
}

/** Whether a result screen marked this route as finished. */
export function routeIsFinished(route: Route): boolean {
  return route.params?.[FINISHED_ROUTE_PARAM] === true;
}

/** Whether `routeId` is one of `routes`, or a drill-down beneath one. */
export function routeWithin(routeId: string, routes: readonly string[]): boolean {
  return routes.some((r) => routeId === r || routeId.startsWith(`${r}/`));
}

function judgeFinished(rule: FinishedFlowRule, state: WizardState): boolean {
  try {
    return rule.finished(state) === true;
  } catch {
    // Unreadable persisted fields: keep them rather than drop a live flow.
    return false;
  }
}

/**
 * The session a relaunch should open: finished wizards dropped, and Home in
 * place of a route that showed a finished flow. A route keeps its place while
 * any other wizard it hosts is still active. Pure: returns `state` itself when
 * nothing needs to change.
 */
export function stateForLaunch(state: SessionState, rules: readonly FinishedFlowRule[]): SessionState {
  const dropped = new Set<string>();
  for (const rule of rules) {
    const w = state.wizards[rule.wizardId];
    if (w !== undefined && judgeFinished(rule, w)) dropped.add(rule.wizardId);
  }

  const hosting = rules.filter((rule) => routeWithin(state.route.current, rule.routes));
  const routeLostItsFlow =
    hosting.some((rule) => dropped.has(rule.wizardId)) &&
    !hosting.some((rule) => !dropped.has(rule.wizardId) && state.wizards[rule.wizardId] !== undefined);
  const leaveRoute = routeIsFinished(state.route) || routeLostItsFlow;

  if (dropped.size === 0 && !leaveRoute) return state;
  const wizards = { ...state.wizards };
  for (const id of dropped) delete wizards[id];
  return {
    ...state,
    wizards,
    route: leaveRoute ? { current: LAUNCH_ROUTE } : state.route,
  };
}

/**
 * Apply [`stateForLaunch`] to the stored session. Run once when the wallet
 * launches, before a routed screen renders. Writes only when something
 * changes, so an ordinary launch does not wake other open windows.
 */
export async function settleForLaunch(
  store: SessionStateStore,
  rules: readonly FinishedFlowRule[],
): Promise<SessionState> {
  const current = await store.load();
  if (stateForLaunch(current, rules) === current) return current;
  return store.update((s) => stateForLaunch(s, rules));
}
