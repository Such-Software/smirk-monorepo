# Send flow — design doc

How "user taps Send → tx lands on chain" works for each of Smirk's five
assets. Captures the layer responsibilities so each new piece slots into
the same plumbing.

Status as of 2026-05-11: `SendWizard` UI exists in `@smirk/ui` but
`onSubmit` is wired to a `stubSubmit` placeholder in the extension
popup. This doc describes the v0.3 target.

## Smirk's single-address scheme — read this first

Smirk derives **exactly one address per chain** for every user. There's
no gap-limit receive-address rotation (BIP44-style), no separate change
index. The v3 (2026-05-11) leaf paths are fixed:

| Asset | Path                  | Encoding   | External-wallet import |
|-------|-----------------------|------------|-----------------------|
| BTC   | `m/84'/0'/0'/0/0`     | P2WPKH bech32 | Standard BIP84 — any wallet's seed-phrase import works. |
| LTC   | `m/84'/2'/0'/0/0`     | P2WPKH bech32 | Standard BIP84 — same. |
| XMR   | `m/44'/128'/0'/0/0`   | Cryptonote primary (not subaddress) | Cake-compatible (Cake's BIP39 mode). |
| WOW   | `m/44'/2086'/0'/0/0`  | Cryptonote primary | Cake-compatible by the same derivation. |
| Grin  | HMAC-SHA512 over BIP39 entropy with key `"IamVoldemort"` → ed25519 leaf | Slatepack | grin-wallet / Grim compatible. |

**Implication for Send:** change always goes back to the **same** address
the funds came from. No separate change-address derivation. The
`changeAddress` parameter in `buildPsbt` (BTC/LTC) and the change
recipient in the Monero signer (XMR/WOW) are literally the user's own
primary address. Grin's slate protocol handles change at the kernel
level — no address needed.

This is also why the WASM `bitcoin.signPsbt` can take a `masterPath` at
the account level (`"m/84'/0'/0'"`) — every input's `bip32_derivation`
entry points at the **same** leaf path `m/84'/coin'/0'/0/0`. The
`build_psbt` test fixtures use `m/84'/0'/0'/0/0`; popup callers pass
the same path matching what `deriveAddresses` produced at wallet
creation.

### BTC/LTC standardization to BIP84 (shipped 2026-05-11)

Pre-v0.3, Smirk shipped BTC/LTC at the BIP44 path `m/44'/coin'/0'/0/0`
with P2WPKH bech32 encoding — a non-standard combination industry
convention doesn't recognize (BIP44 → P2PKH; BIP84 → P2WPKH; Smirk did
neither cleanly). **Verified empirically:** for the abandon mnemonic,
Smirk's legacy v1/v2 derivation produces
`bc1qmxrw6qdh5g3ztfcwm0et5l8mvws4eva24kmp8m` while standard BIP84
produces `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` — Smirk seed
phrases imported into Sparrow / Electrum / Cake / Bitcoin Core showed
"0 balance" because each of them computed the BIP84 address instead.

**v0.3 standardizes BTC/LTC on BIP84** (`m/84'/coin'/0'/0/0`). New
wallets created after 2026-05-11 produce standard P2WPKH bech32
addresses that any wallet's seed-phrase import reproduces. XMR/WOW
remain at `m/44'/coin'/0'/0/0` since Cake's BIP39 mode uses that
exact path for its mod-ℓ derivation — switching XMR/WOW would break
Cake compat.

**Pre-release migration plan (gates v0.3 launch):**

1. Re-scan BTC/LTC addresses immediately before v0.3 launch. Initial
   2026-05-11 sweep found a small number of affected users.
2. DM affected users (out-of-band) with `scripts/seed-to-keys/`
   instructions: the script prints both their *legacy* and
   *v3-standard* addresses. They can sweep funds from legacy → v3
   themselves (or wait until after v0.3 ships and import the legacy
   hex private key into Sparrow/etc to spend).
3. Same script + outreach also covers the WOW-holding users from
   the v1/v2 → v3 derivation migration (separate concern from
   BTC/LTC but same channel of users).

**After v0.3 ships:**

- `seed-to-keys` continues to be the recovery path for any user who
  upgrades without sweeping first.
- The legacy `m/44'/coin'/0'/0/0` BTC/LTC code path stays in
  `@smirk/core/hd.ts` as `deriveLegacyBtcLtcKey` (only `deriveAllKeys`
  v1/v2 still use it; v3 uses `deriveBip84Key`).
- After all affected users have moved funds out, `deriveLegacyBtcLtcKey`
  can be removed from the monorepo. Tracked in
  `smirk-backend/docs/TECHNICAL_DEBT.md` item #15.

XMR/WOW Cake-compat is unaffected by this change (their derivation
path didn't move). Grin compat with grin-wallet/Grim also unchanged.

---

## Universal stages

Every send, regardless of asset, goes through five stages:

```
1. PREPARE        Build the unsigned transaction
                  (UTXO selection, decoy picking, slate initiation, etc.)
2. ESTIMATE       Compute fee + final atomic amounts
                  (depends on tx size — must come after PREPARE)
3. REVIEW         Show the user fee + recipient + amount, get confirmation
4. SIGN           Crypto operations using the unlocked seed
                  (PSBT signing / CLSAG / Schnorr / etc.)
5. BROADCAST      Push to the network
                  (via Smirk backend OR user's self-hosted RPC if in private mode)
```

The `SendWizard` already covers stages 1–3 at the UI level (asset →
amount → recipient → review). What's missing is the actual implementation
of PREPARE / SIGN / BROADCAST for each asset.

## Where each piece lives

```
@smirk/ui
└── SendWizard.tsx                        UI scaffolding (asset, amount, recipient, review)
                                          ↓ onSubmit({ assetId, atomic, recipient }) → SendSubmitResult

packages/extension/src/popup/send-handler.ts  (NEW — to be created)
└── buildSendHandler(wallet, api, wasm)   Dispatches to per-asset send function
    ├── sendBtc / sendLtc
    │     PREPARE via api.getUtxos, ESTIMATE via api.estimateFee,
    │     SIGN via wasm.bitcoin.signPsbt + wasm.bitcoin.buildPsbt (NEW),
    │     BROADCAST via api.broadcastTx
    ├── sendXmrWow
    │     PREPARE via api.getLwsUnspent + api.getLwsDecoys (NEW),
    │     SIGN via wasm.monero.signTransaction,
    │     BROADCAST via api.submitTx (NEW — LWS submit_raw_tx wrapper)
    └── sendGrin
          PREPARE via api.grin.initiateSlate (NEW),
          interactive S1 → S2 → S3 ceremony via api.grin.relay,
          BROADCAST automatic on slate finalization
```

Keep `@smirk/ui` pure presentation — all chain logic in
`@smirk/core` + per-platform handlers in the shell.

---

## BTC / LTC (UTXO chains)

**Simplest case.** Identical machinery, only network params differ.

### Stages

1. **PREPARE**
   - `api.getUtxos(asset, fromAddress)` → list of `{ txid, vout, value, height }`.
   - Greedy UTXO selection: sort by value descending, accumulate until
     `selected_sum >= amount + estimated_fee`. Reject if not enough.
   - Build unsigned PSBT (BIP174):
     - Inputs: each selected UTXO with `witness_utxo`, `bip32_derivation`
       (origin = our master xprv fingerprint + path **`m/44'/coin'/0'/0/0`**
       — same path for every input, since Smirk uses a single-address
       scheme).
     - Outputs: `[recipient: amount, change: selected_sum - amount - fee]`
       where `change_address` = `fromAddress` (single-address scheme;
       no separate change-index derivation). Skip the change output if
       it would be below the P2WPKH dust limit (294 sat per BIP-376).
2. **ESTIMATE**
   - `api.estimateFee(asset)` → `{ fast, normal, slow }` sat/vB.
   - Compute virtual size: `inputs * 68 + outputs * 31 + 10` (rough P2WPKH
     estimator — fine for v0.3, can use exact later).
   - `fee = ceil(vsize * sat_per_vb)`.
   - If fee changes UTXO selection (e.g. adding inputs to cover fee adds
     more fee), iterate once. Coin-selection oscillation isn't a v0.3
     problem.
3. **REVIEW** — UI shows: recipient, amount, fee (sat + USD), total.
4. **SIGN** — `wasm.bitcoin.signPsbt(mnemonic, '', network, masterPath, psbt)`.
   Returns finalized PSBT. Extract `tx_hex` from finalized PSBT via
   new `wasm.bitcoin.extractTx(psbt)` helper.
5. **BROADCAST** — `api.broadcastTx(asset, txHex)` → `{ txid }`.

### Gaps (what to build)

- **PSBT construction** in `crates/btc-ext/src/build.rs` — `build_psbt(
  network, inputs, outputs, master_xpub_origin) -> psbt_base64`. Inputs
  carry `witness_utxo` + `bip32_derivation` so the existing `sign_psbt`
  can resolve them.
- **PSBT extraction** — `crates/btc-ext/src/extract.rs` — `extract_tx(
  psbt_base64) -> tx_hex` after signing is complete.
- **TS facade** for both, exposed via `@smirk/wasm` `bitcoin.buildPsbt`
  + `bitcoin.extractTx`.
- **`sendBtc`/`sendLtc`** in `packages/extension/src/popup/send-handler.ts`.

### Edge cases for v0.3

- Replace-by-fee (RBF) signaling on by default (sequence = 0xfffffffd).
- Dust limit: skip change output if below 294 sat (P2WPKH per BIP-376);
  the excess goes to the miner as extra fee. `build_psbt` errors with
  `DustChange` rather than silently passing through.
- Address validation: `@smirk/core/address` already handles bech32 +
  P2TR + legacy. The send UI should reject obvious garbage at the form
  level; `build_psbt` does a final network-match check.
- **Single-address scheme**: every spend's change goes back to the same
  address the UTXOs came from. No privacy loss vs. the existing scheme;
  Smirk has never had per-address rotation.

---

## XMR / WOW (CryptoNote / RingCT chains)

**Most complex non-Grin path.** Decoy selection has to come from the
LWS daemon; ring composition matters for both privacy and validity.

### Stages

1. **PREPARE**
   - `api.getLwsUnspent(asset, address, view_key)` → list of unspent
     outputs we own.
   - Filter via `wasm.monero.computeKeyImage` to weed out
     decoy-false-positive matches (same pattern as balance fetch).
   - Greedy output selection by amount.
   - `api.getLwsDecoys(asset, ringSize: 16 for XMR / 22 for WOW)` for
     each chosen real input — pull ring members.
2. **ESTIMATE**
   - LWS reports per-byte fee schedule + mask. Compute tx size from
     input count, ring size, and output count (1 recipient + 1 change).
3. **REVIEW** — UI shows recipient, amount, fee, total.
4. **SIGN** — `wasm.monero.signTransaction(paramsJson)` with everything
   the WASM signer needs: real outputs, decoys, recipient address, change
   address, OVK (fresh per-tx per `fresh_outgoing_view_key()` —
   2026-05-10 fix), fee, fee mask.
5. **BROADCAST** — POST signed-tx-hex to LWS `/submit_raw_tx`. Backend
   needs a wrapper (`api.submitTx(asset, txHex)`).

### Gaps (what to build)

- **`getLwsUnspent` / `getLwsDecoys`** wrappers in `@smirk/core/api`.
  Backend likely has the endpoints already (used by balance fetch);
  expose them.
- **`api.submitTx`** wrapper to hit LWS `/submit_raw_tx` via backend.
  Backend endpoint may exist; if not, add it.
- **`sendXmrWow`** in `send-handler.ts`. Most of the inputs to
  `wasm.monero.signTransaction` come from the prepare step; this
  module's job is glue.
- **Per-tx OVK generation** is in `crates/smirk-wasm/src/signing.rs`
  (`fresh_outgoing_view_key()`) — but **callers must not pass a
  hardcoded OVK in the params JSON**. Document at the JS facade.

### Edge cases for v0.3

- Spend-all (no change) flows: smaller tx, but the change-address
  derivation should always be derivable as fallback for partial sends.
- Sub-address support: deferred. v0.3 sends only to/from the primary
  address.
- Locked output handling: skip locked outputs in selection; surface
  "available vs locked" in the UI.

---

## Grin (Mimblewimble — interactive)

**Hardest case.** Sender and receiver run an interactive ceremony
(slatepacks or compact-slates) where they each contribute signing
material before the kernel can be finalized.

### Stages

1. **PREPARE (S1)**
   - Pick our inputs (Pedersen commitments).
   - Compute blinding excess.
   - Generate S1 slate (slate JSON describing the tx so far).
2. **SEND S1 to receiver**
   - If `recipient = slatepack address`: send via Smirk's slatepack
     relay (`api.grin.relayPostSlate(s1)`).
   - If `recipient = file/copy-paste`: encode as base58-armored
     slatepack, hand to user.
3. **RECEIVE S2 (from receiver)**
   - Receiver does their part, hands back S2.
4. **FINALIZE (S3)**
   - `wasm.grin.senderFinalizeS3(s2, originalContext)` →
     final kernel signature + ready-to-submit tx bytes.
5. **BROADCAST**
   - `api.broadcastGrinTransaction(txHex)` → backend hits Grin node.

### Gaps (what to build)

- **Slate state machine** in `packages/core/src/grin-flow.ts` (NEW) —
  tracks `{ pending, signed, finalized }` slates per recipient.
- **Inbox integration** — S2 responses arrive via the slatepack relay;
  Inbox tab (UI_DESIGN principle 3) renders them as "Response to
  pending tx — finalize?" items.
- **`sendGrin`** in `send-handler.ts` only kicks off S1; the actual
  completion happens when the user opens an Inbox item.

### Edge cases for v0.3

- Receiver offline: S1 sits in the relay; user can re-send. Document
  expiry behavior (slatepack relay default TTL).
- Payment proofs: optional in v0.3 — record the kernel signature so
  the sender can later prove the tx existed.
- NRD kernels (relative timelocks): not used for normal sends in
  v0.3; only for swap-refund paths in v0.4+.

---

## Build order

Per `V0_3_PLAN.md` "Next-up build order":

1. **BTC + LTC first.** Same code, different network params. Validates
   the SendWizard → handler → wasm → broadcast → confirm-screen plumbing
   with the simplest possible asset model. Estimate: 5–7 days end-to-end.
2. **XMR + WOW second.** Reuse the same handler signature; the prepare
   step is more involved (decoy selection from LWS) but signing is
   already proven via the balance-fetch key-image verification.
   Estimate: 5–7 days.
3. **Grin last.** Genuinely interactive — depends on Inbox surface
   landing first since S2-finalize happens out-of-band. Estimate: 7–10
   days, partially gated on Inbox.

Total: ~17–24 days. Realistic for 3–4 weeks calendar with iteration.

## Review-and-confirm screen

`SendWizard` currently goes amount → recipient → submit. v0.3 adds a
review screen between "filled out" and "submit":

```
┌─────────────────────────────┐
│  Send  ↗                    │
├─────────────────────────────┤
│  0.0123 BTC                 │
│  ≈ $1,247.83                │
├─────────────────────────────┤
│  To: bc1q…7gm4              │
│  Fee: 1,420 sat (≈ $0.10)   │
│  Total: 0.01231420 BTC      │
├─────────────────────────────┤
│  [ Cancel ]   [ Send 🔓 ]   │
└─────────────────────────────┘
```

The 🔓 indicates this is the *crypto-execute* button — distinct from
the wizard's previous "Next" buttons. Tap requires holding briefly
(prevents accidental triple-tap on mobile). Per-asset variants:
- BTC/LTC: shows sat/vB and confirmation ETA from fee tier.
- XMR/WOW: shows ring size, decoy count, "private" badge.
- Grin: shows "interactive — awaits recipient" instead of "send" since
  the broadcast doesn't happen immediately.

## What goes in commits as this lands

- One PR per layer per asset family:
  1. Rust: `crates/btc-ext/src/build.rs` + tests — ✅ shipped 2026-05-11
  2. WASM facade: `btc_build_psbt` + `btc_extract_tx` — ✅ shipped 2026-05-11
  3. TS facade: `@smirk/wasm/src/index.ts` `bitcoin.buildPsbt` + `bitcoin.extractTx` — ✅ shipped 2026-05-11
  4. Handler: `packages/extension/src/popup/send-handler.ts` `sendBtc` (TODO)
  5. UI: review screen + wire `SendWizard.onSubmit` to handler (TODO)
- Same series for XMR/WOW, then Grin.

### Testing strategy: small mainnet amounts, no testnets

Smirk does not exercise testnet (BTC testnet3 / signet / LTC testnet /
XMR stagenet / Grin testnet) — production has always been mainnet-only,
and that posture continues. Validation strategy:

1. **Send the smallest sensible amount** — e.g. 1000 sat (~\$0.001 at any
   recent BTC price), 0.0001 XMR, 0.001 GRIN. Total dollar exposure for
   a full 5-asset end-to-end sweep: under \$1.
2. **Receiver = dev's other wallet** — Cake / Sparrow / a second Smirk
   install — so a successful receive proves both sides of the path.
3. **Watch mempool acceptance** + first confirmation on a public
   explorer. If the tx propagates and confirms, the signing + broadcast
   path is correct.
4. **Replay test**: send again, slightly different amount, different
   recipient. Catches any state leakage between sends.
5. Only after the small-amount path is solid does the asset get exposed
   in the SendWizard for real users.

Cost of this strategy: maybe \$5 in dust + fees across all 5 assets.
Cheaper than the engineering time to set up + maintain 5 testnet
configurations + their flakier infra.
