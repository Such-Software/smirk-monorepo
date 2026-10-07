/**
 * Key-free half of the sign-in flow grace (see `flow-grace.ts`): constants,
 * the scope rule, and the tab-close cleanup the service worker runs. Kept
 * apart so the service worker imports no popup singletons or key handling.
 */

export const DAPP_FLOW_GRACE_KEY = 'smirk.session.dapp-flow.v1';
export const DAPP_FLOW_GRACE_DEFAULT_SECONDS = 90;
export const DAPP_FLOW_GRACE_MAX_SECONDS = 120;

export interface FlowScope {
  origin: string;
  tabId: number;
}

/** Seconds of grace for a stored preference: absent means the default, a
 *  non-positive or unreadable value disables it, the cap bounds it. */
export function flowGraceSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) return DAPP_FLOW_GRACE_DEFAULT_SECONDS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), DAPP_FLOW_GRACE_MAX_SECONDS);
}

/** A scope needs a verified origin and a real tab; without a tab (a request
 *  that did not come from a browser tab) there is no grace. */
export function scopeOf(origin: { origin?: unknown; tabId?: unknown } | undefined): FlowScope | null {
  if (!origin || typeof origin.origin !== 'string' || origin.origin.length === 0) return null;
  if (typeof origin.tabId !== 'number' || !Number.isInteger(origin.tabId) || origin.tabId < 0) return null;
  return { origin: origin.origin, tabId: origin.tabId };
}

/** Service-worker side: a closed tab ends its flow. */
export async function clearFlowGraceForTab(
  area: { get(key: string): Promise<Record<string, unknown>>; remove(key: string): Promise<void> },
  tabId: number,
): Promise<void> {
  const res = await area.get(DAPP_FLOW_GRACE_KEY);
  const entry = res[DAPP_FLOW_GRACE_KEY] as { tabId?: unknown } | undefined;
  if (entry && entry.tabId === tabId) await area.remove(DAPP_FLOW_GRACE_KEY);
}
