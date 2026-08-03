#!/usr/bin/env node
// Post-process the wasm-bindgen no-modules output:
//
// 1. wasm-bindgen 0.2.95+ emits `require("env")` placeholders for any
//    WASM imports that come from C dependencies (libsecp256k1-zkp, in
//    our case). These are never resolvable at runtime: in a browser
//    `require` is undefined; in Node they'd throw MODULE_NOT_FOUND.
//    Per crates/secp256k1zkp/wasm-sysroot/README.md, the C functions
//    declared (malloc/free/calloc/abort/fprintf) are not exercised by
//    Grin's bulletproof/Pedersen/aggsig code paths; they only need to
//    satisfy the WASM import table at instantiate time so the module
//    loads. We replace the broken `require("env")` calls with a single
//    stub object whose entries are no-op functions.
//
// 2. Append `export { wasm_bindgen };` so `@smirk/wasm` can import the
//    IIFE-bound symbol as a plain ES module export.
//
// Run automatically by `make wasm` and `crates/smirk-wasm/build.sh`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'pkg', 'smirk_wasm.js');

let src = readFileSync(target, 'utf8');

// (1) Replace `const importN = require("env");` lines with a single stub.
// These C functions are not exercised in our codepaths but must be
// callable so WebAssembly.instantiate doesn't throw a LinkError.
const envStub = `\
const __smirk_env_stub = {
    malloc: () => { throw new Error('smirk-wasm: env.malloc invoked unexpectedly'); },
    free: () => {},
    calloc: () => { throw new Error('smirk-wasm: env.calloc invoked unexpectedly'); },
    realloc: () => { throw new Error('smirk-wasm: env.realloc invoked unexpectedly'); },
    abort: () => { throw new Error('smirk-wasm: env.abort invoked'); },
    fprintf: () => 0,
    printf: () => 0,
    sprintf: () => 0,
    snprintf: () => 0,
    vfprintf: () => 0,
    fputs: () => 0,
    fflush: () => 0,
    exit: () => { throw new Error('smirk-wasm: env.exit invoked'); },
    stderr: 0,
    stdout: 0,
    stdin: 0,
};
const import1 = __smirk_env_stub;
const import2 = __smirk_env_stub;
const import3 = __smirk_env_stub;
const import4 = __smirk_env_stub;
const import5 = __smirk_env_stub;
`;

// Replace any `const importN = require("env");` block(s) if present.
// Once `crates/smirk-wasm/src/wasm_libc_shim.rs` (added 2026-05-14)
// resolves libsecp256k1-zkp's malloc/free/etc. via Rust shims, the
// wasm-bindgen output stops emitting these `env` imports entirely
// and this replace becomes a no-op; that's fine, the env-stub
// isn't needed anymore. We only error if we see require("env") but
// the replace fails to consume it (would indicate a regex / output
// format change we'd want to know about).
if (src.includes('require("env")')) {
  const beforeReplace = src;
  src = src.replace(
    /(?:\s+const import\d+ = require\("env"\);)+/,
    '\n' + envStub.replace(/\n/g, '\n    '),
  );
  if (src === beforeReplace) {
    console.error('postprocess: saw `require("env")` but the replace pattern did not match.');
    process.exit(1);
  }
}

// (2) Append ESM export shim if not already present.
if (!src.includes('export { wasm_bindgen };')) {
  src += '\nexport { wasm_bindgen };\n';
}

writeFileSync(target, src);
console.log('postprocess: patched env imports and added ESM export.');
