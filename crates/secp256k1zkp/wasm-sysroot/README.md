# wasm-sysroot

Minimal libc forward-declaration stubs to let `libsecp256k1-zkp` (a C library)
cross-compile to `wasm32-unknown-unknown`, which has no libc by default.

Each header declares only the functions/types referenced inline by the C code.
Implementations are not provided here — the symbols resolve at link time:
- `memcpy`, `memset`, `memcmp` → LLVM compiler-rt builtins for wasm32
- `malloc`, `free`, `realloc`, `abort`, `fprintf`, `stderr` → wasm-bindgen-style
  imports the bundler/host runtime is expected to satisfy. In practice
  libsecp256k1's malloc-using code paths are not exercised by Grin's BP /
  Pedersen / aggsig usage, but we keep the declarations so the build succeeds.

The pattern is borrowed from the upstream `secp256k1-zkp-sys` crate's
`wasm-sysroot/` directory. Without these stubs, `clang --target=wasm32-unknown-unknown`
fails because freestanding wasm32 has no `<string.h>`, `<stdlib.h>`, or
`<stdio.h>` available.
