#!/usr/bin/env -S npx tsx
/**
 * seed-to-keys.mjs — standalone recovery tool for legacy Smirk wallets.
 *
 * Runs via `tsx` so it can import from `@smirk/core` source directly
 * without a build step. Run as `node --import tsx scripts/seed-to-keys/seed-to-keys.mjs`
 * or simply `./scripts/seed-to-keys/seed-to-keys.mjs` if tsx is on PATH.
 *
 * Takes a 12-word BIP39 mnemonic and prints addresses + private keys for
 * every supported asset, at every derivation generation Smirk has ever
 * shipped (v1, v2, v3). Lets users on pre-v3 derivations import their
 * funds into any compatible wallet (Cake for XMR/WOW, grin-wallet for
 * Grin, anything BIP39-aware for BTC/LTC).
 *
 * Why this exists: the v0.3 monorepo extension only supports v3
 * (Cake/grin-wallet compatible) derivation. Users on v1/v2 from the
 * legacy `smirk-extension` who skip the in-wallet migration before
 * uninstalling will see "0 balance" in v0.3. This script lets them
 * recover their funds from the seed alone — no Smirk infrastructure
 * needed.
 *
 * Usage:
 *   node scripts/seed-to-keys/seed-to-keys.mjs           # prompts for seed via stdin
 *   echo "twelve word phrase ..." | node scripts/seed-to-keys/seed-to-keys.mjs
 *
 * Security:
 * - Never accept the seed as a command-line argument (it would land in
 *   shell history). Use stdin only.
 * - Run on a trusted, offline machine if you can — this script does
 *   not phone home, but a compromised machine sees the seed regardless.
 * - The output contains private keys. Clear scrollback / close the
 *   terminal after you've recorded what you need.
 */

import readline from 'node:readline';
import {
  deriveAllKeys,
  computeSeedFingerprint,
  isValidMnemonic,
  btcAddress,
  ltcAddress,
  xmrAddress,
  wowAddress,
  grinSlatpackAddress,
} from '@smirk/core';

// ----- input -----

async function readSeedFromStdin() {
  // If stdin is a pipe, read it whole.
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // Interactive mode: prompt with hidden echo (best-effort — not all
  // terminals support this; the user is warned).
  console.error(
    'Enter your 12-word recovery phrase (input is visible — clear scrollback after):',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('> ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ----- helpers -----

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function renderVersion(version, keys) {
  console.log(`\n=== Derivation v${version} ${version === 3 ? '(current, Cake-compatible)' : version === 2 ? '(buggy SLIP-10, do not use for new wallets)' : '(legacy custom)'} ===\n`);

  // BTC + LTC — unchanged across versions, but printed in each block
  // for completeness. Skip in v2 since v2 is identical to v3 for
  // these assets.
  if (version !== 2) {
    console.log(`BTC address:        ${btcAddress(keys.btc.publicKey)}`);
    console.log(`BTC private key:    ${hex(keys.btc.privateKey)}`);
    console.log(`LTC address:        ${ltcAddress(keys.ltc.publicKey)}`);
    console.log(`LTC private key:    ${hex(keys.ltc.privateKey)}`);
    console.log('');
  } else {
    console.log('BTC/LTC: identical to v3 — see v3 block.\n');
  }

  // XMR / WOW — view + spend keys plus address
  console.log(`XMR address:        ${xmrAddress(keys.xmr.publicSpendKey, keys.xmr.publicViewKey)}`);
  console.log(`XMR private spend:  ${hex(keys.xmr.privateSpendKey)}`);
  console.log(`XMR private view:   ${hex(keys.xmr.privateViewKey)}`);
  console.log('');
  console.log(`WOW address:        ${wowAddress(keys.wow.publicSpendKey, keys.wow.publicViewKey)}`);
  console.log(`WOW private spend:  ${hex(keys.wow.privateSpendKey)}`);
  console.log(`WOW private view:   ${hex(keys.wow.privateViewKey)}`);
  console.log('');

  // Grin — slatepack address (= pubkey) + secret
  console.log(`GRIN slatepack:     ${grinSlatpackAddress(keys.grin.publicKey)}`);
  console.log(`GRIN private key:   ${hex(keys.grin.privateKey)}`);
}

// ----- main -----

const mnemonic = (await readSeedFromStdin()).toLowerCase().split(/\s+/).join(' ');

if (!mnemonic) {
  console.error('No seed provided. Aborting.');
  process.exit(1);
}

if (!isValidMnemonic(mnemonic)) {
  console.error('Invalid BIP39 mnemonic (failed checksum). Aborting.');
  process.exit(2);
}

console.log('=================================================================');
console.log('Smirk seed-to-keys recovery — DO NOT SHARE THIS OUTPUT');
console.log('=================================================================');
console.log(`\nSeed fingerprint (for cross-referencing with backend): ${computeSeedFingerprint(mnemonic).slice(0, 16)}…`);

// v1, v2, v3
for (const v of [1, 2, 3]) {
  const keys = deriveAllKeys(mnemonic, '', v);
  renderVersion(v, keys);
}

console.log('\n=================================================================');
console.log('To recover funds:');
console.log('  XMR / WOW → import the v3 (or v1/v2 if that\'s where your funds are)');
console.log('             spend + view keys into Cake Wallet ("Restore from keys").');
console.log('  GRIN     → import the slatepack private key into grin-wallet or Grim.');
console.log('  BTC / LTC → import the WIF/hex private key into any wallet');
console.log('             (Sparrow, Bitcoin Core, Electrum, etc.).');
console.log('=================================================================');
