/**
 * Social tipping API methods (tips targeted at @user on a platform).
 */

import type { AssetType } from '../types';
import { ApiClient, ApiResponse } from './client';

// ============================================================================
// Types
// ============================================================================

export interface SocialLookupResponse {
  registered: boolean;
  user_id: string | null;
  public_keys: {
    btc: string | null;
    ltc: string | null;
    xmr: string | null;
    wow: string | null;
    grin: string | null;
  } | null;
}

/**
 * One linked third-party social account (Telegram, Discord, and any
 * platform we add later — Matrix, Bluesky, etc.). Wire shape matches
 * the backend's `SocialAccountInfo`. `platform` is intentionally a
 * string, not a closed union, so the client picks up new platforms
 * automatically when the backend rolls them out.
 */
export interface LinkedSocialAccount {
  platform: string;
  username: string | null;
  display_name: string | null;
  platform_user_id: string | null;
  verified: boolean;
  verified_at: string | null;
  pending_verification: boolean;
}

/** Response shape of `GET /api/v1/socials/me`. */
export interface LinkedSocialsResponse {
  socials: LinkedSocialAccount[];
}

export interface CreateSocialTipRequest {
  platform?: string;
  username?: string;
  asset: AssetType;
  amount: number;
  encrypted_key?: string;
  is_public: boolean;
  claim_key_hash?: string;
  tip_address?: string;
  funding_txid?: string;
  /** Private view key for tip address (XMR/WOW only, for 0-conf detection). */
  tip_view_key?: string;
  /** Voucher commitment hex (Grin only, for the non-interactive
   *  voucher-sweep claim path). */
  grin_commitment?: string;
  /** Hide sender identity in channel announcements (default: false). */
  sender_anonymous?: boolean;
}

export interface CreateSocialTipResponse {
  tip_id: string;
  status: string;
  share_url: string | null;
}

// NOTE: `ClaimableTip` and `ReceivedTip` are the full/targeted-tip shape and
// carry fields (`from_platform`, `sender_username`, `sender_anonymous`, ...) that
// a PUBLIC backend does not emit. A public-only instance serves an empty list for
// both `/tips/social/received` and `/tips/social/claimable` (200, never 404), so
// these types describe the richer targeted-tip payload a full backend can return,
// not what the public backend puts on the wire. Do NOT delete them: keep them so
// a full-backend client stays typed.
export interface ClaimableTip {
  id: string;
  asset: AssetType;
  amount: number;
  from_platform: string | null;
  created_at: string;
  encrypted_key: string | null;
  tip_address: string | null;
  /** Current number of confirmations for funding tx. */
  funding_confirmations: number;
  /** Required confirmations before tip is claimable (XMR/GRIN=10, WOW=4, BTC/LTC=0). */
  confirmations_required: number;
}

export interface SentTip {
  id: string;
  sender_user_id: string;
  recipient_platform: string | null;
  recipient_username: string | null;
  asset: AssetType;
  amount: number;
  is_public: boolean;
  status: string;
  created_at: string;
  claimed_at: string | null;
  clawed_back_at: string | null;
  funding_confirmations: number;
  confirmations_required: number;
  is_claimable: boolean;
}

/** Received tip (includes confirmation status for pending tips). */
export interface ReceivedTip {
  id: string;
  sender_user_id: string;
  /** Sender's Smirk @handle, when (a) the sender has reserved one
   *  AND (b) they did NOT send anonymously. `null` for anonymous
   *  senders or senders with no handle set. UI should fall back to
   *  "anonymous" when this is null. */
  sender_username: string | null;
  /** True iff the sender opted into anonymity at create time.
   *  Render "anonymous" regardless of whether a handle could
   *  otherwise be looked up. */
  sender_anonymous: boolean;
  recipient_platform: string | null;
  recipient_username: string | null;
  asset: AssetType;
  amount: number;
  is_public: boolean;
  status: string;
  created_at: string;
  claimed_at: string | null;
  clawed_back_at: string | null;
  funding_confirmations: number;
  confirmations_required: number;
  is_claimable: boolean;
}

export interface PublicTipInfo {
  id: string;
  asset: AssetType;
  amount: number;
  status: string;
  created_at: string;
  is_public: boolean;
  /** Hex-encoded AES-GCM ciphertext of the spend key. Useless without
   *  the URL fragment key that lives only on the sharer/receiver side. */
  encrypted_key: string | null;
  /** Per-tip sweep destination — populated for public tips. */
  tip_address: string | null;
  funding_confirmations: number;
  confirmations_required: number;
  /** Convenience flag — true iff funding has enough confirmations
   *  AND the tip is still pending/claiming. */
  is_claimable: boolean;
}

// ============================================================================
// Methods interface
// ============================================================================

export interface SocialMethods {
  /** Look up a username on a platform; returns registered user's public keys if any. */
  lookupSocial(
    platform: string,
    username: string,
  ): Promise<ApiResponse<SocialLookupResponse>>;

  /** Look up a Smirk-registered username (no platform). */
  lookupSmirkName(username: string): Promise<ApiResponse<SocialLookupResponse>>;

  /**
   * Reserve / update the current user's Smirk handle. Backend
   * enforces 3-32 chars, `[a-z0-9_]`, unique across users; rejects
   * with `VALIDATION_ERROR` on shape, `CONFLICT` on already-taken.
   *
   * Auth required — caller must have already run `bootstrapAuth` so
   * the api client has a valid JWT.
   */
  setMySmirkUsername(
    username: string,
  ): Promise<ApiResponse<{ username: string }>>;

  /**
   * Read the current user's reserved Smirk handle, or `null` if none
   * is set. Used on import to skip the onboarding "reserve a handle"
   * prompt for wallets that already own one on a previous device.
   *
   * Auth required.
   */
  getMySmirkUsername(): Promise<ApiResponse<string | null>>;

  /**
   * List the user's linked third-party social accounts (Telegram,
   * Discord, future platforms). Used on import alongside
   * `getMySmirkUsername` to compose the full "Welcome back" panel.
   *
   * The wire shape is platform-agnostic: callers should iterate
   * `socials` and render each entry generically rather than special-
   * casing platforms. Adding Matrix or Bluesky later is a backend
   * change with no client edits required.
   *
   * Auth required.
   */
  getMyLinkedSocials(): Promise<ApiResponse<LinkedSocialsResponse>>;

  /**
   * Create a social tip. Two modes:
   *
   * - **Draft** (v0.3+, recommended): omit `funding_txid`. Backend
   *   persists the encrypted key + tip_address BEFORE the sender
   *   broadcasts. Returns `tip_id` immediately; the sender then
   *   broadcasts on-chain and calls `attachSocialTipFunding(tip_id,
   *   txid)` to commit. Closes the v0.2.x atomicity gap where a
   *   failed POST after broadcast stranded funds + key forever.
   * - **Single-call legacy** (v0.2.x): pass `funding_txid` — backend
   *   creates the tip in `pending_confirmation` / `pending` directly.
   *   Still works for backwards compatibility; new code should
   *   prefer the draft flow.
   */
  createSocialTip(
    request: CreateSocialTipRequest,
  ): Promise<ApiResponse<CreateSocialTipResponse>>;

  /**
   * Attach a broadcast txid to a draft tip created via
   * `createSocialTip` without funding_txid. Transitions the tip into
   * the normal lifecycle (`pending_confirmation` for XMR/WOW/Grin,
   * `pending` for BTC/LTC) and fires the LWS-register +
   * recipient-DM side-effects.
   *
   * Idempotent on (tip_id, funding_txid). Retrying with the same
   * pair is a no-op; retrying with a different txid is an error.
   */
  attachSocialTipFunding(
    tipId: string,
    fundingTxid: string,
  ): Promise<ApiResponse<CreateSocialTipResponse>>;

  /**
   * Cancel a draft tip — sender abandons before broadcast (or after
   * a failed broadcast). Only valid from the 'draft' state. Tips
   * with funding already attached use `clawbackSocialTip` instead
   * because the funds are on-chain.
   */
  cancelSocialTip(tipId: string): Promise<ApiResponse<{ ok: boolean }>>;

  /** Get tips the current user can claim (only confirmed tips). */
  getClaimableTips(): Promise<ApiResponse<{ tips: ClaimableTip[] }>>;

  /** Get all received tips, including unconfirmed (for "waiting for confirmations" UI). */
  getReceivedTips(): Promise<ApiResponse<{ tips: ReceivedTip[] }>>;

  /** Get tips sent by the current user. */
  getSentSocialTips(): Promise<ApiResponse<{ tips: SentTip[] }>>;

  /** Claim a social tip. */
  claimSocialTip(
    tipId: string,
  ): Promise<
    ApiResponse<{
      success: boolean;
      encrypted_key: string | null;
      tip_address: string | null;
    }>
  >;

  /** Clawback an unclaimed tip (sender reclaims funds). */
  clawbackSocialTip(tipId: string): Promise<ApiResponse<{ success: boolean }>>;

  /**
   * Confirm that a tip sweep was broadcast successfully.
   * Moves tip from `claiming` to `claimed` (first-wins semantics).
   *
   * Response includes the **winning** `sweep_txid` recorded on the
   * row — caller compares to their own broadcast txid to detect
   * race loss (public tips: multiple URL-holders can race; whoever
   * confirms first wins the chain race; loser sees the winner's
   * txid here). When `sweep_txid !== yourBroadcastTxid`, the
   * caller's sweep landed in the mempool but didn't make the
   * winning transition; UI should render "swept by someone else".
   */
  confirmTipSweep(
    tipId: string,
    sweepTxid: string,
  ): Promise<ApiResponse<{ sweep_txid: string | null; status: string }>>;

  /** Get public tip info (unauthenticated). 404 for targeted tips. */
  getPublicSocialTip(tipId: string): Promise<ApiResponse<PublicTipInfo>>;
}

// ============================================================================
// Factory
// ============================================================================

export function createSocialMethods(client: ApiClient): SocialMethods {
  return {
    async lookupSocial(platform, username) {
      return client.retryableRequest<SocialLookupResponse>(
        `/socials/lookup?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(username)}`,
        { method: 'GET' },
      );
    },

    async lookupSmirkName(username) {
      const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
      return client.retryableRequest<SocialLookupResponse>(
        `/users/by-username/${encodeURIComponent(cleanUsername)}`,
        { method: 'GET' },
      );
    },

    async setMySmirkUsername(username) {
      // No retry: the backend's set-username endpoint mutates state
      // and a second POST with a different value (the user typed
      // another name in the brief retry window) would silently
      // overwrite the first. Single shot — caller surfaces the error
      // and lets the user retry explicitly.
      const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
      return client.request<{ username: string }>('/users/me/username', {
        method: 'POST',
        body: JSON.stringify({ username: cleanUsername }),
      });
    },

    async getMySmirkUsername() {
      // Read-only — retryable on 5xx / network. Backend returns the
      // raw `Option<String>` as the JSON body: `"my-handle"` or `null`.
      return client.retryableRequest<string | null>('/users/me/username', {
        method: 'GET',
      });
    },

    async getMyLinkedSocials() {
      // Read-only — retryable. Empty `socials` array is a valid
      // response (user has no linked platforms).
      return client.retryableRequest<LinkedSocialsResponse>('/socials/me', {
        method: 'GET',
      });
    },

    async createSocialTip(req) {
      // POST — no retry. Could create duplicate tips for the legacy
      // single-call path. For the v0.3 draft path, the create POST is
      // idempotent at the wallet level (the sender's tip private key
      // is regenerated per submit attempt, so a duplicate would have
      // a different tip_address anyway), but we still don't retry —
      // a duplicate draft is wasted DB space, not a fund-loss risk.
      return client.request<CreateSocialTipResponse>('/tips/social', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    async attachSocialTipFunding(tipId, fundingTxid) {
      // Retryable: backend dedupes on (tip_id, funding_txid) — same
      // pair is a no-op. Retrying a flaky network is exactly what we
      // want here because the sender already broadcast on-chain and
      // we MUST get the txid attached.
      return client.retryableRequest<CreateSocialTipResponse>(
        `/tips/social/${tipId}/attach-funding`,
        {
          method: 'POST',
          body: JSON.stringify({ funding_txid: fundingTxid }),
        },
      );
    },

    async cancelSocialTip(tipId) {
      return client.request<{ ok: boolean }>(
        `/tips/social/${tipId}/cancel`,
        { method: 'POST' },
      );
    },

    async getClaimableTips() {
      return client.retryableRequest<{ tips: ClaimableTip[] }>('/tips/social/claimable', {
        method: 'GET',
      });
    },

    async getReceivedTips() {
      return client.retryableRequest<{ tips: ReceivedTip[] }>('/tips/social/received', {
        method: 'GET',
      });
    },

    async getSentSocialTips() {
      return client.retryableRequest<{ tips: SentTip[] }>('/tips/social/sent', {
        method: 'GET',
      });
    },

    async claimSocialTip(tipId) {
      // POST — no retry. Claim is not idempotent.
      return client.request<{
        success: boolean;
        encrypted_key: string | null;
        tip_address: string | null;
      }>(`/tips/social/${tipId}/claim`, { method: 'POST' });
    },

    async clawbackSocialTip(tipId) {
      return client.request<{ success: boolean }>(
        `/tips/social/${tipId}/clawback`,
        { method: 'POST' },
      );
    },

    async confirmTipSweep(tipId, sweepTxid) {
      // Retry OK — confirm-sweep is idempotent (first-wins).
      return client.retryableRequest<{
        sweep_txid: string | null;
        status: string;
      }>(`/tips/social/${tipId}/confirm-sweep`, {
        method: 'POST',
        body: JSON.stringify({ sweep_txid: sweepTxid }),
      });
    },

    async getPublicSocialTip(tipId) {
      return client.retryableRequest<PublicTipInfo>(`/tips/social/${tipId}/public`, {
        method: 'GET',
      });
    },
  };
}
