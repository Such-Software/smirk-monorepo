/**
 * Shared types for `@smirk/core`.
 *
 * Intentionally narrow: only the types the API surface and the
 * cross-chain orchestration layer need. Wallet-shell types
 * (encrypted-seed schemas, message-passing union types, onboarding
 * state) live in the consumer packages (`@smirk/extension`,
 * `@smirk/mobile`, etc.).
 */

/** All chains supported by the Smirk wallet stack. */
export type AssetType = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';

// ============================================================================
// Tipping
// ============================================================================

export interface TipInfo {
  id: string;
  linkId: string;
  asset: AssetType;
  amountRaw: number;
  amountDisplay: string;
  status: 'pending' | 'funded' | 'claimed' | 'expired' | 'refunded';
  expiresAt: string;
  createdAt: string;
  ephemeralPubkey?: string;
  encryptedKey: string;
  isEncrypted: boolean;
  recipientHint?: string;
}

export interface CreateTipResponse {
  id: string;
  linkId: string;
  claimUrl: string;
  expiresAt: string;
  isEncrypted: boolean;
}

// ============================================================================
// Keys
// ============================================================================

export interface UserKeysResponse {
  keys: Array<{
    asset: AssetType;
    publicKey: string;
    publicSpendKey?: string;
  }>;
}

// ============================================================================
// Social tipping
// ============================================================================

export interface SocialLookupResult {
  registered: boolean;
  userId: string | null;
  publicKeys: {
    btc: string | null;
    ltc: string | null;
    xmr: string | null;
    wow: string | null;
    grin: string | null;
  } | null;
}

export interface SocialTipResult {
  tipId: string;
  status: string;
  /** Whether this is a public tip (claimable by anyone with the URL). */
  isPublic?: boolean;
  /** Share URL: only available after tip is confirmed for public tips. */
  shareUrl?: string;
}
