# Smirk Monorepo

Open-source client code for the Smirk multi-currency wallet ecosystem — browser extension, mobile app, and the underlying Rust + TypeScript libraries that power them.

The convenience-mode backend lives in a separate (private) repo. Everything that runs in the user's browser, phone, or terminal is here.

## Layout

```
smirk-monorepo/
├── crates/                 # Rust workspace
│   ├── monero-oxide/       # vendored fork — Monero + Wownero transaction library
│   │                       # 16 sub-crates published as wownero-* on crates.io
│   ├── smirk-wasm/         # wasm-bindgen wrapper exposing crypto to TypeScript
│   └── swap-core/          # adaptor signatures, atomic swap state machine (v0.4)
├── packages/               # npm workspace (TypeScript) — populated in session 2
│   ├── core/               # shared library: HD derivation, API client, address codecs
│   ├── wasm/               # thin TS wrapper around the smirk-wasm WASM output
│   ├── extension/          # Chrome MV3 + Firefox extension
│   └── mobile/             # Capacitor app (iOS + Android)
├── Cargo.toml              # Rust workspace root
├── package.json            # npm workspace root
├── Makefile                # cross-language build orchestration
└── MONOREPO.md             # developer guide — start here if you're new to the layout
```

## Quick start

```bash
# Build everything
make build

# Run all tests (Rust + TS)
make test

# Build only the WASM bundle
make wasm

# Clean all build outputs
make clean
```

See [MONOREPO.md](MONOREPO.md) for the developer guide and [crates/monero-oxide/README.md](crates/monero-oxide/README.md) for the vendored library docs.

## License

MIT — see [LICENSE](LICENSE).
