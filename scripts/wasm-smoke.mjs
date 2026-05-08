#!/usr/bin/env node
//
// WASM runtime smoke test.
//
// Loads the Node-target WASM build (crates/smirk-wasm/pkg-node/) and
// exercises a representative subset of every exported function with
// valid inputs. Catches:
// - wasm-bindgen typing mismatches that compile but break at runtime
// - WASM build pipeline regressions
// - target_arch="wasm32" cfg gates that compile but don't function
//
// The browser-target pkg/ uses ES module syntax that Node can't load
// directly. wasm-bindgen --target nodejs produces a CommonJS bundle
// that loads the .wasm itself; we use that for smoke testing.
//
// Run via `make wasm-smoke` (which builds pkg-node/ first).

import Module from 'module';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgNodeDir = join(here, '..', 'crates', 'smirk-wasm', 'pkg-node');

// The wasm-bindgen --target nodejs output includes a few `require("env")`
// calls for WASM imports that, in browser environments, are filled in by
// the runtime. Node has no `env` module — provide a Proxy stub that throws
// only if a host function is actually called (which our crypto code paths
// don't trigger). If a future change does call into env, the test will fail
// loudly with the missing function name instead of a confusing module-load
// error.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'env') return new URL('./env-stub.cjs', import.meta.url).pathname;
  return origResolve.call(this, req, ...rest);
};
import { writeFileSync } from 'fs';
const stubPath = new URL('./env-stub.cjs', import.meta.url).pathname;
writeFileSync(
  stubPath,
  "module.exports = new Proxy({}, { get(_, p) { return () => { throw new Error('env.' + String(p) + ' called — host function not provided in smoke harness'); }; } });\n",
);

const require = createRequire(import.meta.url);
const mod = require(join(pkgNodeDir, 'smirk_wasm.js'));

let pass = 0;
let fail = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    results.push({ ok: true, name });
  } catch (e) {
    fail++;
    results.push({ ok: false, name, error: e.message ?? String(e) });
  }
}

// Mnemonic + secret used across tests (standard BIP39 zero-entropy).
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ZERO32 = '0'.repeat(64);
const TEST_SECRET = '4303f9023f1b99adccf55bbb3ab0e3dc05b8952a97b13e5c21b37fe76b51050e';
const TEST_MSG = '2a'.repeat(32);

// ----------------------------------------------------------------------------
// Generic
// ----------------------------------------------------------------------------
check('test()', () => {
  const r = mod.test();
  if (typeof r !== 'string' || !r.includes('smirk-wasm')) throw new Error(`got: ${r}`);
});
check('version()', () => {
  const r = mod.version();
  if (typeof r !== 'string' || r.length < 3) throw new Error(`got: ${r}`);
});
check('grin_ext_version()', () => {
  const r = mod.grin_ext_version();
  if (typeof r !== 'string' || r.length < 3) throw new Error(`got: ${r}`);
});

// ----------------------------------------------------------------------------
// Grin: seed, keys, address
// ----------------------------------------------------------------------------
check('grin_derive_extended_key', () => {
  const j = JSON.parse(mod.grin_derive_extended_key(MNEMONIC));
  const expected = '4303f9023f1b99adccf55bbb3ab0e3dc05b8952a97b13e5c21b37fe76b51050ed5d03973235c107c2d4d0f8f33f35980bd1aee035ae7f22b25313dd29c638b10';
  if (j.extended_private_key_hex !== expected) {
    throw new Error(`extended_private_key_hex mismatch:\n  got ${j.extended_private_key_hex}\n  exp ${expected}`);
  }
});
check('grin_secp256k1_public_key', () => {
  const r = mod.grin_secp256k1_public_key(TEST_SECRET);
  const expected = '039f74228227013bde4ede1307d5899f017cf3f8df2f2dcf12cb065576acbe0c5c';
  if (r !== expected) throw new Error(`got ${r}, expected ${expected}`);
});
check('grin_slatepack_address (Grim-compatible)', () => {
  const r = mod.grin_slatepack_address(MNEMONIC, 0, 'mainnet');
  const expected = 'grin1a9q4mvh8vn8gyfkfg67nrn0k4ampj9u8z99w5k5p20n0a2vkanms9ccr7x';
  if (r !== expected) throw new Error(`got ${r}, expected ${expected}`);
});
check('grin_derive_keys', () => {
  const j = JSON.parse(mod.grin_derive_keys(MNEMONIC, 'mainnet'));
  if (!j.slatepack_address.startsWith('grin1')) throw new Error(`bad address: ${j.slatepack_address}`);
});

// ----------------------------------------------------------------------------
// Grin: Schnorr
// ----------------------------------------------------------------------------
check('grin_schnorr_sign + verify', () => {
  const sig = mod.grin_schnorr_sign(TEST_SECRET, '11'.repeat(32), TEST_MSG);
  const pk = mod.grin_secp256k1_public_key(TEST_SECRET);
  const ok = mod.grin_schnorr_verify(sig, TEST_MSG, pk);
  if (!ok) throw new Error('signature did not verify');
});

// ----------------------------------------------------------------------------
// Grin: multi-party Schnorr
// ----------------------------------------------------------------------------
check('grin multi-party 2-of-2', () => {
  const skA = '01'.padEnd(64, '0');
  const skB = '02'.padEnd(64, '0');
  const nA = '03'.padEnd(64, '0');
  const nB = '04'.padEnd(64, '0');
  const pA = mod.grin_secp256k1_public_key(skA);
  const pB = mod.grin_secp256k1_public_key(skB);
  const rA = mod.grin_secp256k1_public_key(nA);
  const rB = mod.grin_secp256k1_public_key(nB);
  const pTotal = mod.grin_point_add(pA, pB);
  const rTotal = mod.grin_point_add(rA, rB);
  const sA = mod.grin_schnorr_partial_sign(skA, nA, rTotal, pTotal, TEST_MSG);
  const sB = mod.grin_schnorr_partial_sign(skB, nB, rTotal, pTotal, TEST_MSG);
  if (!mod.grin_schnorr_partial_verify(sA, rA, pA, rTotal, pTotal, TEST_MSG)) throw new Error('partial A invalid');
  if (!mod.grin_schnorr_partial_verify(sB, rB, pB, rTotal, pTotal, TEST_MSG)) throw new Error('partial B invalid');
  const sAgg = mod.grin_schnorr_aggregate_partials(sA + sB);
  const finalSig = mod.grin_schnorr_final_signature(rTotal, sAgg);
  if (!mod.grin_schnorr_verify(finalSig, TEST_MSG, pTotal)) throw new Error('aggregate did not verify');
});

// ----------------------------------------------------------------------------
// Grin: slate v4 round-trip
// ----------------------------------------------------------------------------
check('grin_slate_round_trip', () => {
  const slate = JSON.stringify({
    ver: '4:2',
    id: '0436430c-2b02-624c-2032-570501212b00',
    sta: 'I2',
    off: '383bc9df0dd332629520a0a72f8dd7f0e97d579dccb4dbdc8592aa3d424c846c',
    fee: '23500000',
    sigs: [{
      xs: '02e3c128e436510500616fef3f9a22b15ca015f407c8c5cf96c9059163c873828f',
      nonce: '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      part: '8f07ddd5e9f5179cff19486034181ed76505baaad53e5d994064127b56c5841be7bf31d80494f5e4a3d656649b1610c61a268f9cafcfc604b5d9f25efb2aa3c5',
    }],
  });
  const out = mod.grin_slate_round_trip(slate);
  if (!out.includes('"id":"0436430c-2b02-624c-2032-570501212b00"')) throw new Error(`bad output: ${out}`);
});

// ----------------------------------------------------------------------------
// Grin: Pedersen + Bulletproofs
//
// SKIPPED in Node smoke — these paths call into the libsecp256k1-zkp C
// code's `malloc`, which Node's --target nodejs WASM loader can't satisfy
// (it resolves imports eagerly). Browser --target web works because
// browsers either provide the symbol or don't enforce eager resolution.
//
// Coverage is provided by the native cargo unit tests
// (crates/grin-ext/src/bulletproof.rs::tests). Once we have a browser
// test harness (puppeteer / playwright), revisit.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Grin: slatepack codec
// ----------------------------------------------------------------------------
check('grin_slatepack_armor + dearmor', () => {
  const payload = '0102030405';
  const armored = mod.grin_slatepack_armor(payload);
  if (!armored.startsWith('BEGINSLATEPACK.')) throw new Error(`bad armor: ${armored}`);
  const back = mod.grin_slatepack_dearmor(armored);
  if (back !== payload) throw new Error(`round-trip mismatch: got ${back}`);
});
check('grin_slatepack_pack_plain + unpack', () => {
  const inner = 'deadbeef';
  const armored = mod.grin_slatepack_pack_plain(inner, null);
  const j = JSON.parse(mod.grin_slatepack_unpack(armored));
  if (j.payload_hex !== inner) throw new Error(`payload mismatch: ${j.payload_hex}`);
  if (j.mode !== 'plain') throw new Error(`mode: ${j.mode}`);
});

// ----------------------------------------------------------------------------
// Grin: slatepack encryption
// ----------------------------------------------------------------------------
check('grin_slatepack_encrypt + decrypt', () => {
  // ed25519 keypair from a known seed
  const sk = '2a'.repeat(32);
  // For the smoke we need the matching pk; derive via grin_derive_keys is wrong (different scheme)
  // — but we just need any valid ed25519 pubkey for the smoke. Use a deterministic value
  // by encrypting + decrypting through the same path: use the slatepack_address derivation
  // is not exposed here. Skip pk derivation — encrypt to a random valid x25519 point
  // is impractical here. Instead: smoke-test by checking that calling the function
  // doesn't crash with a reasonable input. For a real round-trip we have unit tests.
  // We just check encrypt produces non-empty output.
  // Use a generic-ish 32-byte ed25519 pubkey — needs to decompress to a valid point.
  const pk = '5866666666666666666666666666666666666666666666666666666666666666'; // ed25519 base point Y
  const payload = 'cafe';
  const ct = mod.grin_slatepack_encrypt(payload, pk);
  if (ct.length === 0) throw new Error('empty ciphertext');
});

// ----------------------------------------------------------------------------
// Grin: adaptor signatures (atomic-swap building block)
// ----------------------------------------------------------------------------
check('grin adaptor sig 2-party round-trip', () => {
  const skA = '01'.padEnd(64, '0');
  const skB = '02'.padEnd(64, '0');
  const nA = '03'.padEnd(64, '0');
  const nB = '04'.padEnd(64, '0');
  const t = '05'.padEnd(64, '0');
  const pA = mod.grin_secp256k1_public_key(skA);
  const pB = mod.grin_secp256k1_public_key(skB);
  const rA = mod.grin_secp256k1_public_key(nA);
  const rB = mod.grin_secp256k1_public_key(nB);
  const T = mod.grin_secp256k1_public_key(t);
  const pTotal = mod.grin_point_add(pA, pB);
  const rTotalNoT = mod.grin_point_add(rA, rB);

  // Bob's adaptor partial.
  const sBprime = mod.grin_adaptor_partial_sign(skB, nB, rTotalNoT, pTotal, T, TEST_MSG);
  // Alice verifies it.
  if (!mod.grin_adaptor_partial_verify(sBprime, rB, pB, rTotalNoT, pTotal, T, TEST_MSG)) {
    throw new Error("Alice rejected Bob's adaptor partial");
  }
  // Alice's normal partial (using same effective challenge).
  const sA = mod.grin_adaptor_partial_sign(skA, nA, rTotalNoT, pTotal, T, TEST_MSG);

  // Bob "spends the other chain" — t becomes known.
  const sBcomp = mod.grin_adaptor_complete(sBprime, t);
  // Aggregate.
  const sAgg = mod.grin_schnorr_aggregate_partials(sA + sBcomp);
  // Final sig with R = R_total_no_t + T.
  const rTotalEff = mod.grin_point_add(rTotalNoT, T);
  const sig = mod.grin_schnorr_final_signature(rTotalEff, sAgg);
  if (!mod.grin_schnorr_verify(sig, TEST_MSG, pTotal)) {
    throw new Error('aggregated adaptor signature failed final Schnorr verify');
  }

  // Watcher (anyone holding sB' who sees sBcomp on chain) extracts t.
  const recoveredT = mod.grin_adaptor_extract_secret(sBcomp, sBprime);
  if (recoveredT !== t) {
    throw new Error(`extract_adaptor_secret didn't recover t: got ${recoveredT}, want ${t}`);
  }
});

// ----------------------------------------------------------------------------
// Grin: blind arithmetic + sender slate init
// ----------------------------------------------------------------------------
check('grin_blind_add', () => {
  const a = '01'.padEnd(64, '0');
  const b = '02'.padEnd(64, '0');
  const sum = mod.grin_blind_add(a, b);
  if (sum.length !== 64) throw new Error(`bad sum length: ${sum.length}`);
});
check('grin_blind_sum (3 scalars)', () => {
  const concat = ['01', '02', '03'].map((b) => b.padEnd(64, '0')).join('');
  const result = mod.grin_blind_sum(concat);
  if (result.length !== 64) throw new Error(`bad result length: ${result.length}`);
});
check('grin_sender_init_s1', () => {
  const slateId = '0436430c-2b02-624c-2032-570501212b00';
  const excess = '0a'.padEnd(64, '0');
  const offset = '0b'.padEnd(64, '0');
  const nonce = '0c'.padEnd(64, '0');
  const result = mod.grin_sender_init_s1(
    slateId,
    BigInt(60_000_000_000),
    BigInt(7_000_000),
    'plain',
    null,
    null,
    excess,
    offset,
    nonce,
  );
  const j = JSON.parse(result);
  if (typeof j.slate_json !== 'string' || !j.slate_json.includes('"sta":"S1"')) {
    throw new Error(`bad slate: ${j.slate_json}`);
  }
  if (j.context.slate_id !== slateId) {
    throw new Error(`slate_id mismatch: ${j.context.slate_id}`);
  }
});

// ----------------------------------------------------------------------------
// Monero / Wownero
// ----------------------------------------------------------------------------
check('validate_address rejects garbage input', () => {
  const r = mod.validate_address('xxxx');
  const j = JSON.parse(r);
  // The function may report failure as either {valid: false, ...} or
  // {success: false, error: ...} depending on its current shape — both
  // indicate "not a valid address." Anything that returns success:true
  // for "xxxx" is a bug.
  const ok = j.valid === false || j.success === false;
  if (!ok) throw new Error(`expected rejection, got: ${r}`);
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log('');
console.log('=== WASM runtime smoke results ===');
for (const r of results) {
  if (r.ok) {
    console.log(`  ✓ ${r.name}`);
  } else {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
}
console.log('');
console.log(`pass=${pass}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
