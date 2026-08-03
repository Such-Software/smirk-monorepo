/**
 * v0.2 -> v0.3 wallet migration (FUND-CRITICAL).
 *
 * A v0.2 user upgrading in place must not lose funds or identity. The seed +
 * Nostr identity are seed-derived and carry automatically; only two things
 * differ: (1) the keystore envelope (legacy `walletState` -> `smirk_keystore_v1`)
 * and (2) BTC/LTC derivation (legacy `m/44'` -> v0.3 `m/84'`), so legacy coins
 * sit at an address the v0.3 wallet doesn't watch.
 *
 * Crypto note (verified, load-bearing): the legacy v0.2 seal is
 * **XChaCha20-Poly1305 + PBKDF2-SHA256**, BYTE-IDENTICAL to v0.3 core's
 * `decryptPrivateKey`. So the migrator REUSES core crypto: no AES-GCM, ever.
 * The only value that crosses the version boundary is the iteration count
 * (absent => the 100k legacy cohort, NOT 600k).
 *
 * Design = CONVERGENCE, not a one-shot: the keystore reseal is one-shot
 * (detect-gated), but the identity-link and the BTC/LTC sweep are idempotent
 * post-unlock steps that no-op when already done, so a fresh v0.2 wallet, a
 * half-migrated wallet, and an intermediate dev-build wallet all converge to the
 * same end state.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { Transaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { decryptPrivateKey, PBKDF2_ITERATIONS_LEGACY } from './crypto';
import { btcAddress, ltcAddress } from './address';
import { deriveLegacyBtcLtcKey, isValidMnemonic, mnemonicToSeed } from './hd';
import { chainProviders } from './chain/registry';
import { resolveFeeRateOrFallback } from './fees';
import type { UnlockedWallet, WalletKeystore } from './keystore';
import type { PlatformStorage } from './state/platform';

/** chrome.storage.local key the LEGACY v0.2 wallet persisted under. */
export const LEGACY_WALLET_KEY = 'walletState';
/** chrome.storage.local key the v0.3 keystore persists under. */
export const V03_KEYSTORE_KEY = 'smirk_keystore_v1';

/**
 * Read-only view of the legacy v0.2 `walletState` fields this migration reads.
 * The `encryptedSeed` plaintext IS the mnemonic PHRASE (v0.2 sealed the phrase),
 * so we decrypt it and re-seal that phrase, never the raw bip39 seed.
 */
export interface LegacyWalletState {
  /** Hex XChaCha20-Poly1305 ciphertext of the mnemonic phrase (nonce||ct||tag). */
  encryptedSeed?: string;
  /** Hex 16-byte PBKDF2 salt (the single master salt). */
  seedSalt?: string;
  /** PBKDF2 iterations. ABSENT => 100000 (legacy cohort); else the stored count. */
  pbkdf2Iterations?: number;
  /** XMR/WOW/Grin key version (informational; identity carries via the seed). */
  derivationVersion?: 1 | 2 | 3;
  /** Sealed 64-byte bip39 seed. Unused for the reseal (we re-derive from the phrase). */
  encryptedBip39Seed?: string;
}

/**
 * Detect an UPGRADING v0.2 user: a legacy `walletState` with a sealed seed AND
 * no v0.3 keystore yet. Idempotent, no writes. The moment the v0.3 keystore is
 * durably written the predicate flips false, so a crash-retry re-enters as a
 * normal v0.3 locked wallet and never re-migrates.
 */
export async function detectLegacyWallet(
  storage: PlatformStorage,
): Promise<boolean> {
  const legacy = await storage.get<LegacyWalletState>(LEGACY_WALLET_KEY);
  const ks = await storage.get<unknown>(V03_KEYSTORE_KEY);
  return (
    typeof legacy?.encryptedSeed === 'string' &&
    legacy.encryptedSeed.length > 0 &&
    ks == null
  );
}

/**
 * Decrypt the legacy v0.2 seed to its mnemonic PHRASE. Reuses v0.3 core
 * `decryptPrivateKey` (byte-identical to the legacy seal). The iterations
 * selector is LOAD-BEARING: an absent `pbkdf2Iterations` means the 100k cohort,
 * NOT 600k; hardcoding 600k rejects every pre-upgrade wallet. Throws on a wrong
 * password / corruption (AEAD tag verify) or an invalid decoded mnemonic.
 */
export async function decryptLegacyMnemonic(
  legacy: LegacyWalletState,
  password: string,
): Promise<string> {
  if (!legacy.encryptedSeed || !legacy.seedSalt) {
    throw new Error('legacy wallet has no sealed seed');
  }
  const iterations = legacy.pbkdf2Iterations ?? PBKDF2_ITERATIONS_LEGACY;
  const bytes = await decryptPrivateKey(
    legacy.encryptedSeed,
    legacy.seedSalt,
    password,
    iterations,
  );
  const mnemonic = new TextDecoder().decode(bytes).trim().replace(/\s+/g, ' ');
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('decrypted data is not a valid BIP-39 mnemonic');
  }
  return mnemonic;
}

/**
 * One-shot keystore migration: decrypt the legacy seed and RE-SEAL it under the
 * v0.3 keystore (600k), returning the unlocked wallet. Fund-critical ordering:
 *
 *  - `createWallet` writes `smirk_keystore_v1` and verify-unlocks. That write is
 *    THE crash-safe commit point: once durable, `detectLegacyWallet` flips
 *    false, so any crash-retry re-enters as a normal v0.3 wallet and never
 *    re-migrates. `createWallet` also throws if a v0.3 keystore already exists
 *    (idempotent guard against a double-seal).
 *  - The legacy `walletState` is intentionally **kept**: cleanup is a separate
 *    step after the user confirms the new wallet works AND any pending
 *    recoverable funds (unclaimed tips / Grin slates) are resolved. Never delete
 *    it in the same step as the keystore write.
 *
 * Reuses the caller's v0.2 password for the reseal (one prompt). Throws on a
 * wrong password (AEAD verify), a missing legacy wallet, or an existing keystore.
 */
export async function migrateLegacyWallet(
  keystore: WalletKeystore,
  storage: PlatformStorage,
  password: string,
): Promise<UnlockedWallet> {
  const legacy = await storage.get<LegacyWalletState>(LEGACY_WALLET_KEY);
  if (!legacy?.encryptedSeed) {
    throw new Error('no legacy wallet to migrate');
  }
  const mnemonic = await decryptLegacyMnemonic(legacy, password);
  return keystore.createWallet({ mnemonic, password });
}

/** SLIP-44 coin types for the UTXO chains the sweep touches. */
const COIN_TYPE = { btc: 0, ltc: 2 } as const;

/**
 * The legacy (pre-v0.3) BTC/LTC key + P2WPKH address at `m/44'/coin'/0'/0/0`,
 * the Smirk-specific combination v0.2.x used. For MIGRATION only: detect funds
 * sitting at the old address and sweep them to the v0.3 `m/84'` address. This is
 * a DIFFERENT child key than v0.3, so it must be derived on the `m/44'` path
 * explicitly (never via `deriveAllKeys`, which would also touch buggy v2
 * XMR/WOW keys).
 */
export function legacyBtcLtcKey(
  mnemonic: string,
  asset: 'btc' | 'ltc',
): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeed(mnemonic);
  const key = deriveLegacyBtcLtcKey(seed, COIN_TYPE[asset]);
  const address =
    asset === 'btc' ? btcAddress(key.publicKey) : ltcAddress(key.publicKey);
  return { ...key, address };
}

/** P2WPKH output dust threshold (sats), per Bitcoin Core policy. A single
 *  output below this is non-standard and broadcast rejects it. Enforced on the
 *  sole sweep output; the change-drop threshold (294) is irrelevant to a
 *  no-change sweep. Not exported from the extension, so inlined here. */
const DUST_SAT = 546;

/** Durable per-asset key recording a completed legacy sweep (its broadcast
 *  txid). Presence is the re-entry guard that makes the sweep idempotent across
 *  restarts, so a non-retryable broadcast is never re-issued. */
const legacySweepKey = (asset: 'btc' | 'ltc') => `smirk_legacy_sweep_${asset}`;

/** @scure/btc-signer ships `NETWORK` = Bitcoin mainnet only. Litecoin needs its
 *  own network struct (values from litecoin-core). Lifted from the proven
 *  tip-claim sweep (`sweepUtxo`) so LTC bech32/p2wpkh encode correctly. */
const LTC_NETWORK = {
  bech32: 'ltc',
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
} as const;

/** Outcome of a legacy BTC/LTC sweep attempt. `swept` = a fresh broadcast this
 *  call; `already-swept` = a durable txid record existed (no-op); `skipped` =
 *  nothing to do or a non-fatal precondition failed (retried on a later
 *  unlock). Never throws for expected states: the migration must never be
 *  blocked by a dust balance, a locked wallet, or a transient scan error. */
export interface LegacySweepResult {
  status: 'swept' | 'skipped' | 'already-swept';
  txid?: string;
  reason?: string;
}

/**
 * Sweep a v0.2 wallet's legacy `m/44'` BTC/LTC balance to its v0.3 `m/84'`
 * receive address. The seed is unchanged across the upgrade, so the old coins
 * are still ours; they just sit at an address the v0.3 wallet doesn't watch.
 * This packs every UTXO at the `m/44'` address into a single-output tx paying
 * `wallet.addresses[asset]` (the `m/84'` receive address), fee subtracted from
 * the swept amount.
 *
 * **Idempotent + convergent** (per this file's header): safe to call on every
 * post-unlock. A durable txid record (`smirk_legacy_sweep_<asset>`) short-
 * circuits any re-entry so the non-retryable broadcast never double-fires; an
 * empty legacy address short-circuits before any tx work; a dust or fee-
 * uncoverable balance returns `skipped` (never throws) so it can't block the
 * migration. A session-cache-restored wallet (no `.mnemonic`) also returns
 * `skipped` and is retried after a full password unlock.
 *
 * **Signing note (load-bearing):** the m/44' UTXOs are P2WPKH locked to the raw
 * m/44' secp256k1 key, NOT to the m/84' HD path the WASM signer hardwires, so
 * this uses pure-JS raw-key signing (`@scure/btc-signer`), exactly like the
 * proven tip-claim `sweepUtxo`. `p2wpkh(pubKey)` reproduces the exact
 * scriptPubKey those UTXOs are locked to.
 *
 * @param storage MUST be a DURABLE backend (chrome.storage.local / mobile
 *   preferences / localStorage), NEVER `storage.session`: a session store dies
 *   on browser close and would defeat the cross-restart double-broadcast guard.
 */
export async function sweepLegacyBtcLtc(
  asset: 'btc' | 'ltc',
  wallet: UnlockedWallet,
  storage: PlatformStorage,
): Promise<LegacySweepResult> {
  // 1. Re-entry guard: a durable txid record means this already broadcast.
  //    Never rebuild/rebroadcast (broadcast is a non-retryable POST).
  const prior = await storage.get<{ txid: string }>(legacySweepKey(asset));
  if (prior?.txid) {
    return { status: 'already-swept', txid: prior.txid };
  }

  // 2. Need the mnemonic to derive the raw m/44' key. A session-cache restore
  //    drops it (keystore omits the phrase); retry after a full unlock.
  if (!wallet.mnemonic) {
    return { status: 'skipped', reason: 'wallet locked; re-unlock required' };
  }

  // 3. Destination is ALWAYS the v0.3 m/84' receive address, never the m/44'
  //    legacy address (that would defeat the migration).
  const recipientAddress = wallet.addresses[asset];
  if (!recipientAddress) {
    return { status: 'skipped', reason: 'v0.3 receive address not derived yet' };
  }

  // 4. Derive the legacy m/44' key + its P2WPKH source address.
  const legacy = legacyBtcLtcKey(wallet.mnemonic, asset);

  // 5. Scan UTXOs AT the legacy address. Confirmed-only: a one-shot fund move
  //    must not chase an unconfirmed (reorg/RBF-able) legacy deposit; the
  //    convergent design sweeps it on a later unlock once it confirms.
  const utxosResp = await chainProviders.utxo(asset).listOutputs(legacy.address);
  if (utxosResp.error || !utxosResp.data) {
    return { status: 'skipped', reason: utxosResp.error ?? 'utxo fetch failed' };
  }
  const utxos = utxosResp.data.utxos.filter((u) => u.height > 0);
  if (utxos.length === 0) {
    return { status: 'skipped', reason: 'no confirmed legacy funds' };
  }

  // 6. Fee rate, clamped to the relay floor. applyRelayFloor is MANDATORY: an
  //    at-floor Electrum estimate (1.0 sat/vB) broadcasts as "rejected by
  //    network rules" and Smirk has no own BTC/LTC node to fall back on.
  const feeRates = await chainProviders.utxo(asset).estimateFee();
  const tiers =
    feeRates.data?.model === 'rate-estimate' ? feeRates.data : undefined;
  const feeRate = resolveFeeRateOrFallback(tiers?.normal);

  // 7. Size for ALL inputs -> one output. Fee scales with input count; never
  //    hardcode a 1-in vsize. 68 vB/P2WPKH input, 31 vB/output, ~11 vB header.
  const estimatedVsize = 11 + 68 * utxos.length + 31;
  const feeSat = Math.max(
    Math.ceil(estimatedVsize * feeRate) + 1, // +1 clears minrelaytxfee rounding
    estimatedVsize, // floor of 1 sat/vB
  );

  // 8. Sweep amount + the two sanity gates.
  const totalSat = utxos.reduce((s, u) => s + u.value, 0);
  const sweepSat = totalSat - feeSat;
  if (sweepSat <= 0) {
    return {
      status: 'skipped',
      reason: `total ${totalSat} <= fee ${feeSat} at ${feeRate} sat/vB`,
    };
  }
  if (sweepSat < DUST_SAT) {
    return {
      status: 'skipped',
      reason: `swept ${sweepSat} below dust ${DUST_SAT}`,
    };
  }

  // 9. Build the 1-output P2WPKH sweep with the raw m/44' key.
  const pubKey = secp256k1.getPublicKey(legacy.privateKey, true);
  const network = asset === 'btc' ? NETWORK : LTC_NETWORK;
  const payment = p2wpkh(pubKey, network);

  const tx = new Transaction();
  for (const utxo of utxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) },
    });
  }
  tx.addOutputAddress(recipientAddress, BigInt(sweepSat), network);
  tx.sign(legacy.privateKey);
  tx.finalize();
  const txHex = hex.encode(tx.extract());

  // 10. Broadcast, then PERSIST-FIRST: record the txid durably BEFORE returning
  //     success so any crash-retry hits the step-1 guard. On broadcast failure
  //     leave NO record, so a later unlock retries cleanly.
  const broadcast = await chainProviders.utxo(asset).broadcast(txHex);
  if (broadcast.error || !broadcast.data) {
    return {
      status: 'skipped',
      reason: `broadcast failed: ${broadcast.error ?? 'unknown'}`,
    };
  }
  await storage.set(legacySweepKey(asset), {
    txid: broadcast.data.txid,
    at: Date.now(),
  });
  return { status: 'swept', txid: broadcast.data.txid };
}
