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
  funding_confirmations: number;
  confirmations_required: number;
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
   * Moves tip from `claiming` to `claimed`.
   */
  confirmTipSweep(
    tipId: string,
    sweepTxid: string,
  ): Promise<ApiResponse<{ success: boolean }>>;

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
      // Retry OK — confirm-sweep is idempotent.
      return client.retryableRequest<{ success: boolean }>(
        `/tips/social/${tipId}/confirm-sweep`,
        {
          method: 'POST',
          body: JSON.stringify({ sweep_txid: sweepTxid }),
        },
      );
    },

    async getPublicSocialTip(tipId) {
      return client.retryableRequest<PublicTipInfo>(`/tips/social/${tipId}/public`, {
        method: 'GET',
      });
    },
  };
}
