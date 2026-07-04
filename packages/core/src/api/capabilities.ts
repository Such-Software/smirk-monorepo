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
  /**
   * Restore-PoW pricing curve: a restore depth (days) free of PoW, then +1
   * hashcash difficulty bit per `pow_days_per_bit` days beyond it (0 = pricing
   * off), capped at `pow_max_bits`. Optional — older backends omit it. The
   * wallet computes its required difficulty from these + the chosen restore date.
   */
  pow_free_days?: number;
  pow_days_per_bit?: number;
  pow_max_bits?: number;
}

/**
 * Registration gates a NEW wallet must clear on this instance (returning wallets
 * and self-hosting bypass them). Mirrors the backend `RegistrationCapability`.
 * Optional on `BackendCapabilities` because legacy/older backends don't advertise
 * it — treat an absent value as "open" (no gates). See {@link summarizeRegistration}.
 */
export interface RegistrationCapability {
  /** A valid operator-minted invite code is required to register. */
  invite_required: boolean;
  /** A proof-of-work solution is required (v0.3.0+ clients always send one). */
  pow_required: boolean;
  /** A settled payment invoice (from `/auth/payment-invoice`) is required. */
  payment_required: boolean;
  /** Registration price; present only when `payment_required`. */
  payment_amount?: string | null;
  payment_currency?: string | null;
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
    /** First-party Nostr relay (encrypted DM inbox). See `messaging`. */
    nostr_relay: boolean;
    tips: boolean;
  };
  restore: RestoreCapability;
  /** Registration gates for a new wallet. Absent on legacy backends ⇒ treat as open. */
  registration?: RegistrationCapability;
  /** First-party Nostr relay details; present only when `features.nostr_relay`. */
  messaging?: MessagingCapability;
}

/** A plain summary of a backend's registration gates for onboarding UI. An
 *  absent `registration` (legacy backend, or self-hosted with gates off) reads
 *  as fully open. `pow` is informational: v0.3.0+ always solves it, so it never
 *  needs a user prompt. `price` is `"<amount> <currency>"` when payment-gated. */
export function summarizeRegistration(reg?: RegistrationCapability): {
  open: boolean;
  invite: boolean;
  pow: boolean;
  payment: boolean;
  price?: string;
} {
  const invite = !!reg?.invite_required;
  const pow = !!reg?.pow_required;
  const payment = !!reg?.payment_required;
  const price =
    payment && reg?.payment_amount
      ? `${reg.payment_amount}${reg.payment_currency ? ` ${reg.payment_currency}` : ''}`
      : undefined;
  return {
    // "open" = nothing a user must actively supply. PoW is automatic, so it
    // does not make onboarding non-open.
    open: !invite && !payment,
    invite,
    pow,
    payment,
    ...(price ? { price } : {}),
  };
}

/** First-party Nostr relay this instance runs — the wallet's DM inbox, used
 *  alongside the public interop relays. */
export interface MessagingCapability {
  /** ws(s):// relay URL to connect to. */
  relay_url: string;
  /** `inbox-outbox` | `author-allowlist` | `open`. */
  write_policy: string;
  /** NIP-13 PoW bits required on cross-ecosystem inbound (0 = off). */
  inbound_pow_bits: number;
  /** NIPs the relay speaks, e.g. [1, 17, 44, 59]. */
  supported_nips: number[];
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
