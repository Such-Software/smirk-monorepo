/**
 * Backend capabilities (`GET /capabilities`) — what THIS instance offers, so the
 * wallet adapts per-instance: grey out disabled chains/features, pick the right
 * network, and shape the import-restore UX to the operator's restore policy.
 *
 * Fields mirror the backend wire shape (snake_case) verbatim — no transform, so
 * the types track the OpenAPI contract directly.
 */

export type RestorePolicyName = 'create-only' | 'bounded' | 'unlimited';

export interface RestoreCapability {
  policy: RestorePolicyName;
  /** Days behind the tip a restore may start; present only for `bounded`. */
  max_depth_days: number | null;
}

export interface BackendCapabilities {
  version: string;
  contract_version: number;
  chains: Record<
    'btc' | 'ltc' | 'xmr' | 'wow' | 'grin',
    { enabled: boolean; network: string | null }
  >;
  features: {
    grin_relay: boolean;
    prices: boolean;
    nostr_identity: boolean;
    tips: boolean;
  };
  restore: RestoreCapability;
}

/**
 * Earliest wallet-birthday / restore date this instance's policy permits, given
 * `now`. `null` = no floor (the `unlimited` policy — any date is allowed).
 *
 * - `unlimited`   → `null` (no restriction)
 * - `create-only` → `now` (only a wallet created ~today registers; the backend
 *   refuses a deeper restore scan)
 * - `bounded`     → `now − max_depth_days`
 *
 * The wallet uses this to bound the restore-date picker on import and to explain
 * why an older date isn't available on this backend. Pure (testable; `now` is
 * injected) and the single place the policy semantics live client-side — mirrors
 * the backend's enforcement so the UX and the server agree.
 */
export function earliestRestoreDate(restore: RestoreCapability, now: Date): Date | null {
  switch (restore.policy) {
    case 'unlimited':
      return null;
    case 'create-only':
      return now;
    case 'bounded': {
      const days = restore.max_depth_days ?? 0;
      return new Date(now.getTime() - days * 86_400_000);
    }
  }
}
