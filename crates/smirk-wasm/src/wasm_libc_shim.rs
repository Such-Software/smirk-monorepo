//! Minimal libc shims for `wasm32-unknown-unknown` so libsecp256k1-zkp's
//! C code finds `malloc` / `free` / etc. at link time and DOES NOT
//! emit them as `env` imports the JS host has to satisfy.
//!
//! ## Why this exists
//!
//! `crates/secp256k1zkp/wasm-sysroot/` forward-declares the libc symbols
//! the C source uses so clang's `--target=wasm32-unknown-unknown`
//! compiles without `<string.h>` / `<stdlib.h>`. The README there said
//! "malloc-using code paths are not exercised by Grin's BP / Pedersen /
//! aggsig usage"; that was true for the native unit tests, false at
//! browser runtime: `bullet_proof_create` allocates a scratch space
//! via `secp256k1_scratch_space_create` which calls `malloc`.
//!
//! Without these shims, the wasm-bindgen output ships `env.malloc`
//! imports that resolve to a JS stub that throws
//! "ENV.MALLOC INVOKED UNEXPECTEDLY". Caught when wiring the social-tip
//! Grin voucher path (the first thing that runs `bullet_proof_create`
//! through a real browser broadcast).
//!
//! ## How it works
//!
//! Each shim is `#[no_mangle] pub unsafe extern "C" fn`. The wasm-ld
//! linker sees the Rust-provided symbol first and uses it to satisfy
//! the C reference; the symbol stays internal to the wasm module
//! instead of becoming an `env` import. `wasm_bindgen --target
//! no-modules` no longer emits `require("env")` for these names, and
//! the postprocess script's `env` stub stops mattering.
//!
//! Allocation goes through Rust's global allocator (`std::alloc::*`).
//! We use a small header trick to remember the allocation size so
//! `free` can pass the correct `Layout` to `dealloc`.

use std::alloc::{alloc, dealloc, Layout};
use std::ffi::c_void;

/// Padding ahead of every allocation that stores the layout size.
/// 16 bytes is plenty for an `usize` and keeps the user pointer
/// 16-byte aligned, which is wider than the C99 minimum (8) and
/// matches what most platforms hand out: defensive for any vector
/// types the C lib might use under the hood.
const HEADER_SIZE: usize = 16;
const ALIGN: usize = 16;

fn user_layout(size: usize) -> Layout {
    // SAFETY: `size + HEADER_SIZE` is bounded by request size + 16; we
    // panic-abort on overflow rather than wrap.
    let total = size
        .checked_add(HEADER_SIZE)
        .expect("smirk_wasm_libc_shim: allocation size overflow");
    Layout::from_size_align(total, ALIGN).expect("smirk_wasm_libc_shim: invalid layout")
}

/// C-equivalent malloc. Returns NULL on size=0 (some C code treats
/// non-NULL return from `malloc(0)` as success; we follow the
/// permissive interpretation and never return NULL for tiny sizes).
#[no_mangle]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    if size == 0 {
        // Per POSIX, malloc(0) may return NULL or a unique pointer.
        // We return a non-NULL non-dereferenceable sentinel so C code
        // that checks `if (p)` doesn't fail. But we don't dereference,
        // and we tolerate `free` on this sentinel below.
        return ALIGN as *mut c_void;
    }
    let layout = user_layout(size);
    let raw = alloc(layout);
    if raw.is_null() {
        return std::ptr::null_mut();
    }
    // Store the original requested size in the header so free can
    // reconstruct the Layout.
    *(raw as *mut usize) = size;
    raw.add(HEADER_SIZE) as *mut c_void
}

/// C-equivalent free. Tolerates NULL and the malloc(0) sentinel.
#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    // malloc(0) sentinel: see above. Skipping dealloc is correct
    // since we never alloc'd via the global allocator in that path.
    if ptr as usize == ALIGN {
        return;
    }
    let raw = (ptr as *mut u8).sub(HEADER_SIZE);
    let size = *(raw as *mut usize);
    let layout = user_layout(size);
    dealloc(raw, layout);
}

/// C-equivalent calloc: zero-init buffer of `nmemb * size` bytes.
#[no_mangle]
pub unsafe extern "C" fn calloc(nmemb: usize, size: usize) -> *mut c_void {
    let total = nmemb
        .checked_mul(size)
        .expect("smirk_wasm_libc_shim: calloc multiplication overflow");
    let p = malloc(total);
    if !p.is_null() && total > 0 {
        std::ptr::write_bytes(p as *mut u8, 0, total);
    }
    p
}

/// C-equivalent realloc. Allocate-copy-free rather than try to
/// in-place resize: Rust's allocator doesn't expose a portable
/// realloc on wasm32 and the C lib's realloc usage in Grin's BP path
/// is rare enough that this is fine.
#[no_mangle]
pub unsafe extern "C" fn realloc(ptr: *mut c_void, new_size: usize) -> *mut c_void {
    if ptr.is_null() {
        return malloc(new_size);
    }
    if new_size == 0 {
        free(ptr);
        return std::ptr::null_mut();
    }
    if ptr as usize == ALIGN {
        return malloc(new_size);
    }
    // Recover the old size from the header to know how much to copy.
    let raw_old = (ptr as *mut u8).sub(HEADER_SIZE);
    let old_size = *(raw_old as *mut usize);
    let new_ptr = malloc(new_size);
    if new_ptr.is_null() {
        return std::ptr::null_mut();
    }
    let copy_len = old_size.min(new_size);
    std::ptr::copy_nonoverlapping(ptr as *const u8, new_ptr as *mut u8, copy_len);
    free(ptr);
    new_ptr
}

/// C `abort()`: never returns. We translate to a Rust panic that
/// surfaces in the JS console as an unhandled exception.
#[no_mangle]
pub extern "C" fn abort() -> ! {
    panic!("smirk-wasm: C abort() called — libsecp256k1-zkp tripped an internal assert")
}

/// C stdio sinks. The C lib only calls these when its own debug
/// asserts trip; we want them silent in browser builds so they
/// return success (0) without writing anywhere.
///
/// `fprintf` is variadic in C but Rust's stable surface doesn't
/// support `extern "C" fn …(...)`. We declare it with the first two
/// fixed args only; the C ABI on wasm32 pushes any additional args
/// to a stack the callee can ignore; since we never read them, no
/// harm. The linker resolves the symbol name (`fprintf`); the C
/// compiler's signature mismatch is benign at the wasm-symbol level.
#[no_mangle]
pub extern "C" fn fprintf(_stream: *mut c_void, _fmt: *const u8) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn fputs(_s: *const u8, _stream: *mut c_void) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn fflush(_stream: *mut c_void) -> i32 {
    0
}

/// `stderr` is referenced by the C lib's `fprintf(stderr, …)` debug
/// path. The pointer's never dereferenced (we no-op `fprintf`), but
/// the symbol has to exist so the linker resolves.
#[no_mangle]
pub static mut stderr: *mut c_void = std::ptr::null_mut();
