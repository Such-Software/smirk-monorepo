# Send flow — reference

How "user taps Send → tx lands on chain" works for each of Smirk's five
assets, as shipped in v0.3.

Status as of 2026-05-13: end-to-end send is working for **all five
assets** on mainnet. BTC/LTC PSBT path shipped 2026-05-11 (9b4c395),
XMR/WOW + tri-state balance reconciliation shipped 2026-05-12 (bf3ad28,
b2ec790), Grin Phase 3.1 (SendWizard interactive Exchange step +
clipboard-mode wiring) shipped 2026-05-13 (0f21587). Phase 3.2–3.5
(invoice flow, Inbox, paste-incoming, cancel/expire) is the remaining
Grin work — see `crates/grin-ext/` notes + the v0.3 plan in
`smirk-backend/docs/V0_3_PLAN.md`.

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
├── SendWizard.tsx              UI scaffolding (asset, amount, recipient, review)
│                               ↓ onSubmit({ assetId, atomic, recipient }) → SendSubmitResult
│                               Grin branch: onGrinBuildSlate / onGrinFinalize / onGrinCancel
└── GrinRequestWizard.tsx       Receiver-initiated invoice flow (Phase 3.2)

packages/extension/src/popup/send-handler.ts        — generic dispatcher
└── buildSendHandler(wallet, api, wasm)
    ├── sendBtc / sendLtc       PREPARE via api.getUtxos, ESTIMATE via api.estimateFee,
    │                           SIGN via wasm.bitcoin.buildPsbt + signPsbt + extractTx,
    │                           BROADCAST via api.broadcastTx
    └── sendXmrWow              PREPARE via api.getLwsUnspent + api.getLwsDecoys,
                                key-image filter for spent outputs,
                                SIGN via wasm.monero.signTransaction (fresh OVK per tx),
                                BROADCAST via api.submitRawTx (LWS submit_raw_tx)

packages/extension/src/popup/grin-flows.ts          — Grin orchestrator
└── startGrinSend / processGrinS2 / cancelGrinSend
    startGrinInvoice / signGrinInvoice / processGrinI2 / signIncomingGrinSlate
    Plus slatepack codec (armor / dearmor / inspect) and the greedy fee iterator.
    Each step calls into @smirk/wasm's grin namespace (which wraps the 6
    Rust orchestrators in crates/grin-ext/src/wallet_flows.rs).
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
       (origin = our master xprv fingerprint + path **`m/84'/coin'/0'/0/0`**
       — native segwit BIP84; same path for every input, since Smirk uses
       a single-address scheme).
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

### As shipped

All four BTC/LTC layers landed 2026-05-11 (ad46ce6, 0d29947, 20c510a,
9b4c395):

- `crates/btc-ext/src/build.rs::build_psbt` + `extract.rs::extract_tx`
- `crates/smirk-wasm/src/bitcoin.rs` exports `btc_build_psbt` + `btc_extract_tx`
- `@smirk/wasm` `bitcoin.buildPsbt` + `bitcoin.extractTx` TS facades
- `packages/extension/src/popup/send-handler.ts::sendBtc` / `sendLtc`
- Greedy fee iterator + sweep mode + fee picker in `SendWizard`

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

### As shipped

bf3ad28 (handler + fee preview + spent-output filter) and b2ec790
(Phase 2 — tri-state balance, pendingOutgoing, 3-signal reconciliation):

- `api.getLwsUnspent` + `api.getLwsDecoys` + `api.submitRawTx` wrappers
  in `@smirk/core/api`.
- `packages/extension/src/popup/send-handler.ts::sendXmrWow` glues
  prepare → sign → broadcast.
- Fresh OVK per tx via `fresh_outgoing_view_key()` (never hardcoded).
- Key-image filter pre-sign to weed out outputs the wallet has already
  spent (catches LWS lag after a tx hits mempool but before LWS rescans).

### Edge cases for v0.3

- Spend-all (no change) flows: smaller tx, but the change-address
  derivation should always be derivable as fallback for partial sends.
- Sub-address support: deferred. v0.3 sends only to/from the primary
  address.
- Locked output handling: skipped in selection; surfaced as the
  **locked** band of the tri-state UI (Phase 2, b2ec790). Reconciliation
  uses three signals (local input cache, input-identifier match vs
  `verifiedSpentInputs`, `locked_balance > 0` fallback) to decide when a
  `pendingOutgoing` entry has settled — avoids the four bugs we hit in
  the legacy extension (commits 839e001, 15661ba, 1266671, ad46ce6).

---

## Grin (Mimblewimble — interactive)

> **Update (2026-07 — non-custodial):** Grin is now fully **non-custodial**
> and **scan-based**. The backend keeps no Grin outputs or wallet state; it
> exposes only `POST /wallet/grin/scan` + `GET /wallet/grin/height` +
> `POST /wallet/grin/broadcast` + `/relay/*`, and the client recomputes
> balance from a view-only rewind scan (plus a client-side pending overlay)
> on every refresh. The interactive ceremony below is otherwise unchanged,
> but the slatepack hand-off is no longer copy-out-of-band only — each leg
> now travels over one of three transports: **Nostr NIP-59 gift-wrap**
> (federated default), **manual** copy/paste, or a **same-instance backend
> relay** (`grin_slatepacks` mailbox). No transport assumes `api.smirk.cash`.
> See `docs/grin.md` for details.

**Hardest case.** Sender and receiver run an interactive ceremony where
they each contribute signing material before the kernel can be
finalized. v0.3 ships both directions of the ceremony — sender-driven
**send** (S1→S2→S3) and receiver-driven **invoice** (I1→I2→I3) — plus a
compact-binary slatepack codec so we interop with external `grin-wallet`
and Grim users, not only other Smirk wallets.

### Send (sender-driven, S1→S2→S3)

1. **PREPARE (S1)** — sender picks inputs (Pedersen commitments + their
   blinding factors), computes change blind, computes `sender_blind_excess
   = Σoutputs − Σinputs − offset` (sign convention fix in c78aff0;
   cross-validated against `grin_wallet_libwallet` 5.4.0), creates the
   kernel nonce, and emits the S1 slate via `grin_create_send_transaction`.
2. **HAND-OFF** — S1 is wrapped in a slatepack (`SlatepackBin` v1.0 →
   ASCII armor `BEGINSLATEPACK. … . ENDSLATEPACK.`). User copies it out
   of band (Smirk-to-Smirk relay auto-detect is Phase 3.3).
3. **SIGN (S2 — receiver)** — receiver pastes S1, runs
   `grin_sign_incoming_send_slate` which adds their output (Pedersen
   commit + Bulletproof), their partial sig, and pubkeys. Returns S2 as
   another armored slatepack.
4. **FINALIZE (S3 — sender)** — sender pastes S2, runs
   `grin_finalize_send_slate` which verifies the receiver's partial,
   aggregates partials → final Schnorr signature, verifies the kernel
   sig against `(sum_of_commitments − offset_G)`, assembles
   broadcastable TX bytes via `grin_slate_to_transaction_bytes`.
5. **BROADCAST** — `api.broadcastGrinTransaction(txHex)`. Kernel excess
   from the final slate doubles as the on-chain identifier shown in the
   "Done" screen — `https://grinexplorer.net/kernel/${excess_hex}`.

### Invoice (receiver-driven, I1→I2→I3) — Phase 3.2

Same primitives, inverse direction. Receiver picks an amount, runs
`grin_create_invoice` to emit I1 (which carries the receiver's output
commit + range proof + partial sig), hands the armored slatepack to the
payer. Payer runs `grin_sign_invoice` → I2 (adds inputs, fee, sender
partial). Receiver finalizes with `grin_finalize_invoice` → broadcastable
TX. UI surface is `GrinRequestWizard` reached from the Receive screen's
"Request specific amount" affordance.

### Where the code lives

```
crates/grin-ext/src/wallet_flows.rs      — 6 Rust orchestrators
crates/smirk-wasm/src/grin/wallet_flows.rs  — wasm-bindgen wrappers + JSON DTOs
packages/wasm/src/index.ts               — typed TS facades (grin.* namespace)
packages/extension/src/popup/grin-flows.ts  — extension orchestrator:
  startGrinSend / processGrinS2 / cancelGrinSend
  startGrinInvoice / signGrinInvoice / processGrinI2 / signIncomingGrinSlate
  armorSlate / dearmorSlate / inspectSlatepack
  calcGrinFee — BASE_FEE × max(1, 4×outputs − inputs + kernels)
packages/ui/src/components/SendWizard.tsx  — Grin Exchange step
packages/ui/src/components/GrinRequestWizard.tsx  — invoice wizard
```

### Cross-implementation interop

The slate v4 compact-binary codec (`crates/grin-ext/src/slate_bin.rs`,
ported from grin v4_bin.rs) is what makes Smirk↔grin-wallet interop work
— same wire bytes as `SlatepackBin` produced by grin-wallet 5.x. Verified
end-to-end by the round-trip cross-validation tests in
`crates/grin-ext/tests/grin_wallet_compat.rs` (S1→S2→S3 + I1→I2→I3
against `grin_wallet_libwallet` 5.4.0 as a dev-dep oracle). See
`docs/TESTING.md` Layer 2.

### Edge cases for v0.3

- **Persistence across popup close** — Mimblewimble's interactive flow
  *must* survive popup-close (the receiver may take hours to respond).
  Wizard state lives in session storage via `useWizard<GrinFields>`;
  resuming the wizard re-renders the Exchange step with the same
  pre-built S1 + same sender context.
- **Payment proofs** — Rust + WASM support shipped (ed25519 receipt
  over `(amount, kernel_commitment, sender_address)`); not yet
  surfaced in UI. Phase 3.5.
- **NRD kernels (relative timelocks)** — primitives shipped; not used
  for normal sends in v0.3. Reserved for swap-refund paths in v0.4+.
- **Slate expiry** — Phase 3.5 adds 1h warning + 24h drop with a Cancel
  affordance per pending exchange.

---

## Build order — as shipped

1. **BTC + LTC** — shipped 2026-05-11 (ad46ce6, 0d29947, 20c510a, 9b4c395).
2. **XMR + WOW** — shipped 2026-05-12 (bf3ad28 send-handler, b2ec790
   Phase 2 reconciliation).
3. **Grin Phase 1 (primitives)** — pre-existing; battery of cross-validation
   tests added 2026-05-13 (c78aff0, 78aac0e, 4734707).
4. **Grin Phase 2 (orchestrators)** — shipped 2026-05-13 (f46e96e, a61a620,
   7e72f78 in Rust; 2a832ee binary slate codec; ef3bcdf wasm exposure;
   f65440e TS wrappers).
5. **Grin Phase 3.1 (SendWizard Exchange step + popup wiring)** —
   shipped 2026-05-13 (0f21587).
6. **Grin Phase 3.2 (invoice / Receive Request)** — in flight.
7. **Grin Phase 3.3 (Inbox surface, Smirk-to-Smirk relay auto-detect)** — pending.
8. **Grin Phase 3.4 (paste-incoming-slatepack)** — pending.
9. **Grin Phase 3.5 (cancel + 1h/24h expiry)** — pending.
10. **Grin Phase 4 (mainnet round-trip + interop test against grin-wallet CLI)** — pending.

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
