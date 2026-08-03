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
  /**
   * How the enabled invite/payment gates combine: `"all"` (satisfy every gate,
   * the default) or `"any"` (they are alternatives; satisfy one). Absent on
   * older backends ⇒ treat as `"all"`. PoW is orthogonal regardless.
   */
  registration_mode?: 'all' | 'any';
}

/** The onboarding path for a backend's registration gates, derived from
 *  {@link RegistrationCapability}. `kind` drives the wizard branch:
 *  - `free`: no user-facing gate (maybe PoW, auto) — proceed straight to register.
 *  - `invite` / `payment`: exactly one gate — route straight to it.
 *  - `choose`: 2+ gates that are ALTERNATIVES (`mode: any`) — show method buttons.
 *  - `sequential`: 2+ gates ALL required (`mode: all`) — collect each in turn. */
export interface RegistrationPlan {
  kind: 'free' | 'invite' | 'payment' | 'choose' | 'sequential';
  /** Enabled user-facing methods (PoW excluded — it is automatic). */
  methods: Array<'invite' | 'payment'>;
  /** Formatted price ("<amount> <ccy>"), when a payment method is involved. */
  price?: string;
  /** Whether PoW applies (informational; the client always auto-solves it). */
  pow: boolean;
}

/** Plan the onboarding registration branch. Pure; mirrors the backend's
 *  `plan_gates` composition so the wizard and the server agree on what a given
 *  backend expects. Absent registration ⇒ fully open (`free`). */
export function planRegistration(reg?: RegistrationCapability): RegistrationPlan {
  const s = summarizeRegistration(reg);
  const methods: Array<'invite' | 'payment'> = [];
  if (s.invite) methods.push('invite');
  if (s.payment) methods.push('payment');
  const base = {
    methods,
    pow: s.pow,
    ...(s.price ? { price: s.price } : {}),
  };
  if (methods.length === 0) return { kind: 'free', ...base };
  if (methods.length === 1) return { kind: methods[0]!, ...base };
  // 2+ enabled: alternatives (any) => choose; all-required (default) => sequential.
  const mode = reg?.registration_mode ?? 'all';
  return { kind: mode === 'any' ? 'choose' : 'sequential', ...base };
}

export interface BackendCapabilities {
  /** The domain this instance's handles live at (the `<domain>` in
   *  `name@<domain>`, and the host serving `/.well-known/nostr.json`).
   *
   *  Advertised by the backend because the client cannot derive it: the old
   *  approach stripped a leading `api.` from the backend URL, which is correct
   *  only for a two-host deployment shaped like smirk.cash. Optional, since an
   *  older backend does not send it. */
  nip05_domain?: string;
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
    /**
     * npub-native registration is available (`POST /auth/nostr/register`): the
     * wallet can register + authenticate from its seed-derived Nostr key alone,
     * no BTC signature. Absent on legacy backends ⇒ use the BTC bootstrap.
     */
    nostr_native_auth?: boolean;
    /** First-party Nostr relay (encrypted DM inbox). See `messaging`. */
    nostr_relay: boolean;
    /** Paid premium relay tier (unlocks posting on a `premium-post` relay). See
     *  `premium`. Absent on backends without a premium tier. */
    premium_relay?: boolean;
    /** Operator-curated public feed (owner/allowlist/hashtag notes over the
     *  relay). See `feed`. Absent on backends that run no feed. */
    feed?: boolean;
    tips: boolean;
  };
  restore: RestoreCapability;
  /** Registration gates for a new wallet. Absent on legacy backends ⇒ treat as open. */
  registration?: RegistrationCapability;
  /** First-party Nostr relay details; present only when `features.nostr_relay`. */
  messaging?: MessagingCapability;
  /** Premium relay tier (plans + pricing); present only when `features.premium_relay`. */
  premium?: PremiumCapability;
  /** Operator feed configuration; present only when `features.feed`. */
  feed?: FeedCapability;
}

/** One premium plan the operator sells (unlocks posting on a `premium-post` relay). */
export interface PremiumPlanInfo {
  id: string;
  days: number;
  amount: string;
}

/** The authenticated user's CURRENT premium subscription status (`GET
 *  /premium/status`). Distinct from {@link PremiumCapability} (which is the
 *  operator's plans/pricing) — this is "am I, right now, a subscriber?". Gates
 *  premium-only actions like posting to a `premium-post` relay feed. */
export interface PremiumStatus {
  /** True iff the user holds an unexpired subscription. */
  active: boolean;
  /** RFC3339 expiry timestamp, or `null` if never subscribed. */
  premium_until: string | null;
  /** True iff the caller's npub is on the operator write-allowlist
   *  (`RELAY_WRITE_ALLOWLIST_NPUBS`), which permits any kind regardless of
   *  policy or premium. Optional: older backends omit it. */
  write_allowlisted?: boolean;
  /** The SERVER's own answer to "may I publish a general event right now?".
   *  Authoritative when present, because only the server knows the operator
   *  write-allowlist. Optional: older backends omit it. */
  can_post_general?: boolean;
}

/** Paid premium relay tier. Present only when `features.premium_relay`. */
export interface PremiumCapability {
  /** Pricing currency, e.g. `XMR`. */
  currency: string;
  /** Purchasable plans. */
  plans: PremiumPlanInfo[];
  /** The relay premium posting targets (mirrors `messaging.relay_url`). */
  relay_url: string;
}

/**
 * Operator-curated public feed. Present only when `features.feed`. The wallet
 * reads notes DIRECTLY from `relay_url` (+ `extra_relays`) filtered to the
 * owner/allowlist authors — there is no feed-serving backend endpoint. Maps onto
 * the Nostr `FeedSources` type. See {@link feedSourcesFromCapability}.
 */
export interface FeedCapability {
  /** ws(s):// relay the feed is read from (mirrors `messaging.relay_url`). */
  relay_url: string;
  /** Include the operator's own announcements (`owner_npub`) in the feed. */
  show_owner: boolean;
  /** Include premium members' posts (advisory; the relay serves them). */
  show_premium: boolean;
  /** The operator announcements npub, or `null` if unset. */
  owner_npub: string | null;
  /** Additional curated author npubs to include. */
  allowlist_npubs: string[];
  /** Extra relays to pull feed notes from, beyond `relay_url`. */
  extra_relays: string[];
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

// ============================================================================
// Feature gates. Everything is opt-in: a minimal backend may advertise no
// prices, tips, feed, or relay, and "absent" is a valid first-class state, not
// an error. Components + poll loops call these before rendering/fetching.
//
// Two flavours by design:
//  - PERMISSIVE-on-unknown (prices/tips/grin): a `null` caps object (still
//    loading, OR a legacy pre-/capabilities backend) reads as ALLOWED, so we
//    preserve old behavior and never hide mid-load. Only an EXPLICIT `false`
//    from a caps-advertising backend gates the feature off.
//  - STRICT (relay/premium/feed): brand-new surfaces with no legacy install
//    base, shown ONLY when explicitly advertised (a `null`/absent reads off).
// ============================================================================

type Caps = BackendCapabilities | null | undefined;

/** Fiat prices (`GET /prices`). Permissive on unknown. */
export const capAllowsPrices = (c: Caps): boolean => c == null || c.features.prices;
/** Social tips (`/tips/social/*`). Permissive on unknown (default-off on new backends). */
export const capAllowsTips = (c: Caps): boolean => c == null || c.features.tips;
/** Social tips, STRICT — only when a caps-advertising backend says tips:true.
 *  Used to gate the tip poll loops + Tip action so they never fire on a backend
 *  that doesn't run tips (the v3 client only ever talks to caps-advertising
 *  backends, so an unknown/legacy caps reads as "no tips" here). */
export const capHasTips = (c: Caps): boolean => !!c?.features.tips;
/** Grin relay (address registration + slatepack relay). Permissive on unknown. */
export const capAllowsGrin = (c: Caps): boolean => c == null || c.features.grin_relay;
/** First-party Nostr relay (DM inbox). STRICT — only when advertised. */
export const capHasRelay = (c: Caps): boolean => !!c?.features.nostr_relay && !!c?.messaging;
/** Operator public feed. STRICT — needs the flag AND the feed config block. */
export const capHasFeed = (c: Caps): boolean => !!c?.features.feed && !!c?.feed;
/** Paid premium relay tier. STRICT. */
export const capHasPremium = (c: Caps): boolean => !!c?.features.premium_relay && !!c?.premium;
/** Whether a specific chain is serviceable. Permissive on unknown (legacy backends
 *  serve every chain the wallet knows). */
export const capAllowsChain = (
  c: Caps,
  chain: 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin',
): boolean => c == null || c.chains[chain].enabled;

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
