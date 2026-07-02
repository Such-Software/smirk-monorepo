/**
 * Authentication API methods.
 */

import { ApiClient, ApiResponse } from './client';
import { snakeToCamel } from './parse';
import type { AltchaPayload } from '../pow';
import {
  buildNip98Event,
  buildSignedActionEvent,
  descriptorSha256,
  nip98AuthHeader,
  requestDescriptor,
  type NostrIdentity,
} from '../nostr';

export interface AuthMethods {
  telegramLogin(initData: string): Promise<
    ApiResponse<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { id: string; telegramId?: number; telegramUsername?: string };
    }>
  >;

  refreshToken(refreshToken: string): Promise<
    ApiResponse<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>
  >;

  extensionRegister(params: {
    keys: Array<{
      asset: string;
      publicKey: string;
      publicSpendKey?: string;
    }>;
    username?: string;
    walletBirthday?: number;
    seedFingerprint?: string;
    xmrStartHeight?: number;
    wowStartHeight?: number;
    /** Unix timestamp (seconds) that was signed. */
    signedTimestamp: number;
    /** Bitcoin message signature of `smirk-auth-{timestamp}` using BTC private key. */
    signature: string;
    /**
     * Optional ALTCHA proof-of-work solution. Always sent by v0.3.0+
     * clients (so the backend can flip `POW_REQUIRED=true` without
     * breaking us). The `challenge` must be the FULL original
     * Challenge object returned by `/auth/pow-challenge`, NOT the
     * Solution's internal challenge-hash field — the envelope shape
     * matches the backend's `altcha::Payload` struct exactly.
     *
     * The typed alias is in `@smirk/core/pow.ts::AltchaPayload`;
     * `solvePowChallenge` returns it directly.
     */
    altchaSolution?: AltchaPayload;
  }): Promise<
    ApiResponse<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { id: string; username?: string; isNew?: boolean };
    }>
  >;

  /**
   * Fetch a fresh ALTCHA proof-of-work challenge. The wallet must solve
   * it (typically via `altcha-lib`'s `solveChallenge`) and pass the
   * resulting payload as `altchaSolution` to `extensionRegister`.
   * Challenges expire after 10 minutes; one challenge → one
   * registration.
   */
  powChallenge(): Promise<ApiResponse<unknown>>;

  checkRestore(params: {
    fingerprint: string;
    keys: Array<{
      asset: string;
      publicKey: string;
      publicSpendKey?: string;
    }>;
  }): Promise<
    ApiResponse<{
      exists: boolean;
      userId?: string;
      keysValid?: boolean;
      error?: string;
      xmrStartHeight?: number;
      wowStartHeight?: number;
    }>
  >;

  /**
   * Sign in with a seed-derived Nostr identity (NIP-98). Builds + signs the auth
   * event for POST /auth/nostr and returns a session. The npub must already be
   * linked (see `linkNostr`); 401 otherwise. Shell-agnostic (extension / desktop
   * / mobile) — the logic lives here in core.
   */
  nostrLogin(identity: NostrIdentity): Promise<
    ApiResponse<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { id: string; telegramId?: number; telegramUsername?: string };
    }>
  >;

  /**
   * Link a Nostr identity (npub) to the CURRENT authenticated user: the JWT on
   * the request identifies them; the NIP-98 proof in the body proves npub
   * control. Stores it so `nostrLogin` resolves to the same wallet.
   */
  linkNostr(identity: NostrIdentity): Promise<ApiResponse<{ nostrPubkey: string }>>;

  /**
   * The authenticated user (GET /auth/me). Used by the Settings identity screen
   * to detect whether an npub is already linked. Requires a session token.
   */
  getMe(): Promise<
    ApiResponse<{ id: string; username?: string; nostrPubkey?: string }>
  >;
}

interface AuthResponseCamel {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    telegramId?: number;
    telegramUsername?: string;
    username?: string;
    isNew?: boolean;
  };
}

/**
 * Transform a snake_case response to camelCase, or pass error through
 * unchanged. Replaces a manual `{ error, status, code }` spread that
 * trips up `exactOptionalPropertyTypes`.
 */
function transformResponse<T>(
  result: ApiResponse<Record<string, unknown>>,
  transform: (data: Record<string, unknown>) => T,
): ApiResponse<T> {
  if (result.data) {
    return { data: transform(result.data) };
  }
  return result as ApiResponse<T>;
}

interface CheckRestoreResponseCamel {
  exists: boolean;
  userId?: string;
  keysValid?: boolean;
  error?: string;
  xmrStartHeight?: number;
  wowStartHeight?: number;
}

export function createAuthMethods(client: ApiClient): AuthMethods {
  return {
    async telegramLogin(initData) {
      const result = await client.request<Record<string, unknown>>('/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ init_data: initData }),
      });
      return transformResponse(result, snakeToCamel<AuthResponseCamel>);
    },

    async refreshToken(refreshToken) {
      // Retry OK — refresh is idempotent (returns same token if not expired).
      const result = await client.retryableRequest<Record<string, unknown>>(
        '/auth/refresh',
        {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        },
      );
      return transformResponse(result, snakeToCamel<AuthResponseCamel>);
    },

    async extensionRegister(params) {
      const result = await client.request<Record<string, unknown>>('/auth/extension', {
        method: 'POST',
        body: JSON.stringify({
          keys: params.keys.map((k) => ({
            asset: k.asset,
            public_key: k.publicKey,
            public_spend_key: k.publicSpendKey,
          })),
          username: params.username,
          wallet_birthday: params.walletBirthday,
          seed_fingerprint: params.seedFingerprint,
          xmr_start_height: params.xmrStartHeight,
          wow_start_height: params.wowStartHeight,
          signed_timestamp: params.signedTimestamp,
          signature: params.signature,
          altcha_solution: params.altchaSolution,
        }),
      });
      return transformResponse(result, snakeToCamel<AuthResponseCamel>);
    },

    async powChallenge() {
      // Retryable: this is a fresh-issue idempotent on the server
      // (every call mints a new challenge), but transient 5xx
      // shouldn't fail the wallet-creation flow on first try.
      return await client.retryableRequest<unknown>('/auth/pow-challenge', {
        method: 'POST',
      });
    },

    async checkRestore(params) {
      // Retry OK — check-restore is a read-only query.
      const result = await client.retryableRequest<Record<string, unknown>>(
        '/auth/check-restore',
        {
          method: 'POST',
          body: JSON.stringify({
            fingerprint: params.fingerprint,
            keys: params.keys.map((k) => ({
              asset: k.asset,
              public_key: k.publicKey,
              public_spend_key: k.publicSpendKey,
            })),
          }),
        },
      );
      return transformResponse(result, snakeToCamel<CheckRestoreResponseCamel>);
    },

    async nostrLogin(identity) {
      // NIP-98: the signed event rides in the Authorization header; the `u` tag
      // must match the absolute URL (baseUrl + path) the backend validates.
      // Trim a trailing slash so the `u` tag matches the server's expected URL,
      // which trims too (a self-hoster's baseUrl ending in '/' would otherwise
      // sign a double-slash path the backend rejects).
      const url = `${client.getBaseUrl().replace(/\/+$/, '')}/auth/nostr`;
      const token = nip98AuthHeader(buildNip98Event({ url, method: 'POST' }, identity));
      const result = await client.request<Record<string, unknown>>('/auth/nostr', {
        method: 'POST',
        headers: { Authorization: token },
      });
      return transformResponse(result, snakeToCamel<AuthResponseCamel>);
    },

    async linkNostr(identity) {
      // 1. Fetch a single-use server nonce (authed — the session JWT is added
      // automatically). The server binds it to THIS account, so a nonce minted
      // for another user cannot be spent here.
      const challenge = await client.request<{ nonce: string }>(
        '/auth/nostr/link-challenge',
        { method: 'GET' },
      );
      if (!challenge.data?.nonce) {
        // Surface the challenge error (auth / feature-off) unchanged. The failed
        // response carries no `data`, only { error, status, code }, so the shape
        // is compatible once the phantom data type is erased.
        return challenge as unknown as ApiResponse<{ nostrPubkey: string }>;
      }
      const nonce = challenge.data.nonce;

      // 2. Build the signed-action proof of npub control, binding the nonce, the
      // `nostr_link` purpose, and the EMPTY-body request descriptor. The path is
      // a fixed cross-impl contract string (matches the server + the pinned KAT),
      // NOT derived from the base URL.
      const url = `${client.getBaseUrl().replace(/\/+$/, '')}/auth/nostr/link`;
      const payloadSha256Hex = descriptorSha256(
        requestDescriptor('POST', '/api/v1/auth/nostr/link', '', ''),
      );
      const nostrToken = nip98AuthHeader(
        buildSignedActionEvent(
          { url, method: 'POST', purpose: 'nostr_link', challenge: nonce, payloadSha256Hex },
          identity,
        ),
      );

      // 3. Submit the proof + the nonce it commits to.
      const result = await client.request<Record<string, unknown>>('/auth/nostr/link', {
        method: 'POST',
        body: JSON.stringify({ nostr_token: nostrToken, nonce }),
      });
      return transformResponse(result, snakeToCamel<{ nostrPubkey: string }>);
    },

    async getMe() {
      // Read-only; safe to retry.
      const result = await client.retryableRequest<Record<string, unknown>>('/auth/me', {
        method: 'GET',
      });
      return transformResponse(
        result,
        snakeToCamel<{ id: string; username?: string; nostrPubkey?: string }>,
      );
    },
  };
}
