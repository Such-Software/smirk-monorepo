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

  /** Create a social tip (targeted or public). */
  createSocialTip(
    request: CreateSocialTipRequest,
  ): Promise<ApiResponse<CreateSocialTipResponse>>;

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

    async createSocialTip(req) {
      // POST — no retry. Could create duplicate tips.
      return client.request<CreateSocialTipResponse>('/tips/social', {
        method: 'POST',
        body: JSON.stringify(req),
      });
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
