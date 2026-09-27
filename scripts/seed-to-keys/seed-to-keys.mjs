#!/usr/bin/env -S npx tsx
/**
 * seed-to-keys.mjs: standalone recovery tool for legacy Smirk wallets.
 *
 * Imports the built `@smirk/core` package. Read README.md before use.
 *
 * Takes a 12-word BIP39 mnemonic and prints addresses + private keys for
 * every supported asset, at every derivation generation Smirk has ever
 * shipped (v1, v2, v3). Lets users on pre-v3 derivations import their
 * inspect the derivation holding their funds. An external wallet must support
 * the exact coin, derivation and private-key format.
 *
 * Why this exists: the v0.3 monorepo extension only supports v3
 * (Cake/grin-wallet compatible) derivation. Users on v1/v2 from the
 * legacy `smirk-extension` who skip the in-wallet migration before
 * uninstalling will see "0 balance" in v0.3. This script lets them
 * recover their funds from the seed alone: no Smirk infrastructure
 * needed.
 *
 * Security:
 * - Never accept the seed as a command-line argument (it would land in
 *   shell history). Use stdin only.
 * - Run on a trusted, offline machine if you can; this script does
 *   not phone home, but a compromised machine sees the seed regardless.
 * - Input is visible and output contains private keys. Do not run this in
 *   agent sessions, CI, support logs or recorded terminals. Clearing
 *   scrollback does not remove external copies.
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
  // Interactive input is visible. See README.md for the execution boundary.
  console.error(
    'Enter your 12-word recovery phrase (input is visible; use only an unrecorded private terminal):',
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
  const label =
    version === 3
      ? '(current — BTC/LTC standard BIP84, XMR/WOW Cake-compatible, Grin grin-wallet-compatible)'
      : version === 2
        ? '(legacy — BTC/LTC Smirk-specific BIP44 path + P2WPKH; XMR/WOW buggy SLIP-10)'
        : '(legacy — BTC/LTC Smirk-specific BIP44 path + P2WPKH; XMR/WOW custom SHA256 v1)';
  console.log(`\n=== Derivation v${version} ${label} ===\n`);

  // BTC + LTC: v1 and v2 share the legacy Smirk-specific path (BIP44 +
  // P2WPKH encoding, unique to Smirk pre-2026-05-11); v3 is standard BIP84
  // that a matching BIP39/BIP84 import reproduces. Print both per version so
  // users on legacy wallets see where their funds actually are.
  console.log(`BTC address:        ${btcAddress(keys.btc.publicKey)}`);
  console.log(`BTC private key:    ${hex(keys.btc.privateKey)}`);
  console.log(`LTC address:        ${ltcAddress(keys.ltc.publicKey)}`);
  console.log(`LTC private key:    ${hex(keys.ltc.privateKey)}`);
  console.log('');

  // XMR / WOW: view + spend keys plus address
  console.log(`XMR address:        ${xmrAddress(keys.xmr.publicSpendKey, keys.xmr.publicViewKey)}`);
  console.log(`XMR private spend:  ${hex(keys.xmr.privateSpendKey)}`);
  console.log(`XMR private view:   ${hex(keys.xmr.privateViewKey)}`);
  console.log('');
  console.log(`WOW address:        ${wowAddress(keys.wow.publicSpendKey, keys.wow.publicViewKey)}`);
  console.log(`WOW private spend:  ${hex(keys.wow.privateSpendKey)}`);
  console.log(`WOW private view:   ${hex(keys.wow.privateViewKey)}`);
  console.log('');

  // Grin: slatepack address (= pubkey) + secret
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
console.log('  GRIN     → the slatepack key alone is not a complete spend-wallet export.');
console.log('  BTC / LTC → For pre-v0.3 Smirk wallets, funds are at the v1/v2 address');
console.log('             above (Smirk-specific path). The target wallet must support');
console.log('             the key format and matching P2WPKH address type.');
console.log('             For v0.3+ primary addresses, select the matching coin and');
console.log('             account in a BIP39/BIP84-compatible wallet.');
console.log('=================================================================');
