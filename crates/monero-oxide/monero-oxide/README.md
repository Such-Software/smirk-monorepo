# monero-oxide

A modern Monero transaction library. It provides a modern, Rust-friendly view of
the Monero protocol.

This library is usable under no-std when the `std` feature (on by default) is
disabled.

Recommended usage of the library is with `overflow-checks = true`, even for
release builds.

### Wownero Support

This version includes support for Wownero (WOW) transactions:

- **RCT Type 8**: Wownero uses `RCTTypeBulletproofPlus` (type 8), distinct from
  Monero's type 6. The `RctType::WowneroClsagBulletproofPlus` variant handles this.
- **Ring Size 22**: Wownero requires 22 ring members (21 decoys + 1 real output),
  compared to Monero's 16.
- **Commitment Scaling**: Type 8 stores outPk commitments as C/8 (scaled by
  `INV_EIGHT`). The verifier recovers full commitments via `scalarmult8(outPk)`.
  This scaling is applied in `transaction_without_signatures()` before signing.

The `RctPrunable::Clsag` variant includes an explicit `rct_type` field to ensure
correct serialization. This is necessary because the RCT type byte is part of
the signed message hash - using the wrong type would cause signature verification
to fail.

### Cargo Features

- `std` (on by default): Enables `std` (and with it, more efficient internal
  implementations).
- `compile-time-generators` (on by default): Derives the generators at
  compile-time so they don't need to be derived at runtime. This is recommended
  if program size doesn't need to be kept minimal.
- `multisig`: Enables the `multisig` feature for all dependencies.
