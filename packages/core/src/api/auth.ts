/**
 * Authentication API methods.
 */

import { ApiClient, ApiResponse } from './client';
import { snakeToCamel } from './parse';

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
  }): Promise<
    ApiResponse<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { id: string; username?: string; isNew?: boolean };
    }>
  >;

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
        }),
      });
      return transformResponse(result, snakeToCamel<AuthResponseCamel>);
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
  };
}
