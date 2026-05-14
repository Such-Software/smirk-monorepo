/**
 * Tip-handler — orchestrates the per-asset funding tx + backend POST
 * for social tipping.
 *
 * Flow (per asset):
 *   1. Generate a fresh tip keypair locally (never derived from the
 *      sender's wallet — single-use, throwaway).
 *   2. Compute the tip address from the fresh keypair.
 *   3. Build + sign + broadcast a tx funding that address with the
 *      tip amount. Sender's wallet pays the network fee.
 *   4. Encrypt the tip's private key:
 *        - Targeted: ECDH(ephemeral_priv, recipient.btc.pubkey) +
 *          XChaCha20-Poly1305. v0.2.4 wire format: ephemeralPubkey
 *          (33 bytes hex) || ciphertext (hex).
 *        - Public: random 32-byte URL fragment key + XChaCha20-Poly1305.
 *          claim_key_hash = sha256(fragment_key) so backend can
 *          authenticate claimers without seeing the key.
 *   5. POST /api/v1/social/tip with funding_txid + encrypted_key +
 *      tip_address + metadata. Backend bot DMs the recipient via
 *      Telegram / Discord once funding confirms (per asset's
 *      confirmation requirement).
 *
 * v0.3 first cut: BTC/LTC fully wired. XMR/WOW + Grin (voucher) ship
 * in the next commit — those need fresh-keypair generation paths +
 * tx-build wiring that's per-chain-specific and worth its own commit.
 */

import { sha256 } from '@noble/hashes/sha256';
import type { UnlockedWallet } from '@smirk/core';
import {
  api,
  btcAddress,
  ltcAddress,
  bytesToHex,
  hexToBytes,
  createEncryptedTipPayload,
  createPublicTipPayload,
  generatePrivateKey,
  generateUrlFragmentKey,
  getPublicKey,
} from '@smirk/core';
import type { TipPlatform, TipSubmitFields, TipSubmitOutcome } from '@smirk/ui';
import { send } from './send-handler';

/**
 * Top-level dispatcher. Branches by asset, delegates to per-asset
 * orchestrator. Catches per-asset errors and surfaces them in the
 * TipSubmitOutcome shape the TipMaker expects.
 */
export async function dispatchSocialTip(args: {
  wallet: UnlockedWallet;
  /** Backend user UUID for the sender — required for any /social
   *  endpoint that ties tips to the authenticated user. */
  senderUserId: string;
  fields: TipSubmitFields;
}): Promise<TipSubmitOutcome> {
  const { wallet, fields } = args;

  try {
    if (fields.assetId === 'btc' || fields.assetId === 'ltc') {
      return await createBtcLtcTip(wallet, fields);
    }
    if (fields.assetId === 'xmr' || fields.assetId === 'wow') {
      return {
        ok: false,
        error: `Tipping with ${fields.assetId.toUpperCase()} ships in the next commit — voucher / fresh-subaddress orchestration in flight.`,
      };
    }
    if (fields.assetId === 'grin') {
      return {
        ok: false,
        error:
          'Grin tipping ships in the next commit — voucher primitives (588ee2c) wired but the dispatcher pieces still pending.',
      };
    }
    return {
      ok: false,
      error: `Tipping not supported for ${fields.assetId}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// BTC / LTC
// ============================================================================

async function createBtcLtcTip(
  wallet: UnlockedWallet,
  fields: TipSubmitFields,
): Promise<TipSubmitOutcome> {
  const asset = fields.assetId as 'btc' | 'ltc';

  // 1. Resolve recipient's BTC pubkey if this is a targeted tip.
  // We always encrypt to BTC pubkey regardless of asset, since the
  // claimer's BTC private key is the universal decryption key (the
  // recipient might not have a wallet for this asset yet, but every
  // Smirk wallet has a BTC key). Mirrors v0.2.4.
  let recipientBtcPubkeyHex: string | undefined;
  if (!fields.isPublic) {
    const lookup = await lookupRecipientBtcPubkey(fields.platform, fields.username);
    if (!lookup.ok) return { ok: false, error: lookup.error };
    recipientBtcPubkeyHex = lookup.btcPubkeyHex;
  }

  // 2. Generate fresh tip keypair.
  const tipPrivateKey = generatePrivateKey();
  const tipPubkey = getPublicKey(tipPrivateKey, true);
  const tipAddress = asset === 'btc' ? btcAddress(tipPubkey) : ltcAddress(tipPubkey);

  // 3. Estimate fee. We use the `normal` tier; users wanting custom
  // fee control should use Send (not Tip).
  const feeRates = await api.estimateFee(asset);
  if (feeRates.error || !feeRates.data) {
    return {
      ok: false,
      error: feeRates.error ?? `Failed to estimate ${asset.toUpperCase()} fee`,
    };
  }
  const feeRateSatPerVb = feeRates.data.normal ?? 10;

  // 4. Build + sign + broadcast funding tx via the existing
  //    send-handler. The fresh tip_address is just any address from
  //    the BTC/LTC PSBT builder's POV — single-recipient send.
  const sendResult = await send(wallet, {
    fromAssetId: asset,
    amountAtomic: fields.amountAtomic,
    toAddress: tipAddress,
    feeRateSatPerVb,
    sweep: false,
  });
  if (!sendResult.ok) return { ok: false, error: sendResult.error };

  // 5. Encrypt tip private key.
  const { encryptedKey, ephemeralPubkey, claimKeyHash, urlFragmentEncoded } =
    encryptTipKeyForBtcLtc({
      tipPrivateKey,
      isPublic: fields.isPublic,
      recipientBtcPubkeyHex,
    });

  // 6. POST to backend.
  const tip = await api.createSocialTip({
    ...(fields.isPublic ? {} : { platform: fields.platform, username: fields.username }),
    asset,
    amount: Number(fields.amountAtomic),
    is_public: fields.isPublic,
    encrypted_key: encryptedKey,
    ...(claimKeyHash ? { claim_key_hash: claimKeyHash } : {}),
    tip_address: tipAddress,
    funding_txid: sendResult.txid,
    sender_anonymous: fields.senderAnonymous,
  });

  if (tip.error || !tip.data) {
    // Funds are at tipAddress + we have tipPrivateKey locally —
    // surface this to the user; they can recover via clawback later.
    return {
      ok: false,
      error: `Funded ${asset} at ${tipAddress} but backend POST failed: ${
        tip.error ?? 'unknown'
      }. Funds recoverable via the tip private key.`,
    };
  }

  return {
    ok: true,
    tipId: tip.data.tip_id,
    // BTC/LTC have 0-conf so share URL is available immediately for
    // public tips. Targeted tips don't surface a share URL (the bot
    // DMs the recipient instead).
    shareUrl: fields.isPublic ? buildShareUrl(tip.data.tip_id, urlFragmentEncoded) : null,
    shareUrlPending: false,
    // unused fields kept for clarity:
    // ephemeralPubkey would be needed for direct claim — but it's
    // already concatenated into encryptedKey per the v0.2.4 wire
    // format (ephemeral_pubkey || ciphertext).
  };

  // Reference to silence unused-var warning on ephemeralPubkey when
  // present (it's already folded into encryptedKey above).
  void ephemeralPubkey;
}

/**
 * Resolve a recipient's BTC pubkey (lowercase hex, 33 bytes/66 chars).
 * BTC pubkey is the universal encryption target for tip keys — every
 * Smirk wallet has one, regardless of which asset the tip funds.
 */
async function lookupRecipientBtcPubkey(
  platform: TipPlatform,
  username: string,
): Promise<{ ok: true; btcPubkeyHex: string } | { ok: false; error: string }> {
  const r =
    platform === 'smirk'
      ? await api.lookupSmirkName(username)
      : await api.lookupSocial(platform, username);
  if (r.error || !r.data) {
    return {
      ok: false,
      error: r.error ?? `Failed to look up recipient @${username} on ${platform}`,
    };
  }
  if (!r.data.registered) {
    return {
      ok: false,
      error: `@${username} isn't a Smirk user yet — they'd have nothing to claim with. Switch to a public tip and share the link?`,
    };
  }
  const btc = r.data.public_keys?.btc;
  if (!btc) {
    return {
      ok: false,
      error: `Recipient @${username} doesn't have a BTC key registered.`,
    };
  }
  return { ok: true, btcPubkeyHex: btc };
}

/**
 * Encrypt the tip's private key for either targeted (ECIES to
 * recipient's BTC pubkey) or public (URL-fragment-key) tips.
 *
 * Wire format mirrors v0.2.4 so existing claim paths stay compatible:
 * targeted → `ephemeralPubkey(66 hex chars) || ciphertext(hex)`,
 * public → `ciphertext(hex)` (fragment key lives in URL).
 */
function encryptTipKeyForBtcLtc(args: {
  tipPrivateKey: Uint8Array;
  isPublic: boolean;
  recipientBtcPubkeyHex: string | undefined;
}): {
  encryptedKey: string;
  ephemeralPubkey: string | undefined;
  claimKeyHash: string | undefined;
  urlFragmentEncoded: string | undefined;
} {
  if (args.isPublic) {
    const urlFragmentKey = generateUrlFragmentKey();
    const encryptedKey = createPublicTipPayload(args.tipPrivateKey, urlFragmentKey.bytes);
    return {
      encryptedKey,
      ephemeralPubkey: undefined,
      claimKeyHash: bytesToHex(sha256(urlFragmentKey.bytes)),
      urlFragmentEncoded: urlFragmentKey.encoded,
    };
  }

  if (!args.recipientBtcPubkeyHex) {
    throw new Error('Targeted tip is missing recipientBtcPubkeyHex');
  }
  const recipientPubkeyBytes = hexToBytes(args.recipientBtcPubkeyHex);
  const { encryptedKey, ephemeralPubkey } = createEncryptedTipPayload(
    args.tipPrivateKey,
    recipientPubkeyBytes,
  );
  // v0.2.4 wire format: concatenate ephemeralPubkey || ciphertext so
  // the backend stores a single `encrypted_key` string. Claimer
  // splits at 66 chars to recover both halves.
  return {
    encryptedKey: ephemeralPubkey + encryptedKey,
    ephemeralPubkey,
    claimKeyHash: undefined,
    urlFragmentEncoded: undefined,
  };
}

/**
 * Compose the claim URL for a public tip. The URL fragment carries
 * the symmetric key, which never reaches the server — only the
 * claimer (who has the URL) can decrypt.
 *
 * Format matches the existing claim.smirk.cash landing page that
 * v0.2.4 users have been clicking — keeps cross-version compat.
 */
function buildShareUrl(tipId: string, urlFragmentEncoded: string | undefined): string | null {
  if (!urlFragmentEncoded) return null;
  return `https://smirk.cash/tip/${tipId}#${urlFragmentEncoded}`;
}
