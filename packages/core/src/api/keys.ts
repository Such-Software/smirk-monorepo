/**
 * User Keys API methods.
 */

import type { AssetType, UserKeysResponse } from '../types';
import { ApiClient, ApiResponse } from './client';

/**
 * Which row a registered key lands in, server-side.
 *
 * Omit it and the backend routes by value, which is what every shipped wallet
 * relies on and the only thing that works for keys whose role is legible from
 * their own bytes (a Grin address is bech32; a signing key is hex).
 *
 * `enc` has to be explicit: a per-asset encryption subkey is 32 opaque bytes
 * indistinguishable from the identity key, so without this it would upsert over
 * the key that sign-in verifies against.
 */
export type KeyType = 'primary' | 'enc' | 'slatepack';

export interface KeysMethods {
  registerKey(
    asset: AssetType,
    publicKey: string,
    publicSpendKey?: string,
    keyType?: KeyType,
  ): Promise<ApiResponse<{ asset: AssetType; publicKey: string }>>;

  getUserKeys(userId: string): Promise<ApiResponse<UserKeysResponse>>;

  getUserKeyForAsset(
    userId: string,
    asset: AssetType,
  ): Promise<
    ApiResponse<{ asset: AssetType; publicKey: string; publicSpendKey?: string }>
  >;
}

export function createKeysMethods(client: ApiClient): KeysMethods {
  return {
    async registerKey(asset, publicKey, publicSpendKey, keyType) {
      return client.request('/keys', {
        method: 'POST',
        body: JSON.stringify({
          asset,
          public_key: publicKey,
          public_spend_key: publicSpendKey,
          // Left off the wire entirely when unspecified, so a backend predating
          // the field sees byte-identical requests to the ones it handles today.
          ...(keyType ? { key_type: keyType } : {}),
        }),
      });
    },

    async getUserKeys(userId) {
      return client.request(`/users/${userId}/keys`);
    },

    async getUserKeyForAsset(userId, asset) {
      return client.request(`/users/${userId}/keys/${asset}`);
    },
  };
}
