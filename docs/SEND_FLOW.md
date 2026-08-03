# Send flow: reference

How "user taps Send → tx lands on chain" works for each of Smirk's five
assets, as shipped in v0.3.

Send is implemented for all five assets on mainnet. BTC/LTC use a PSBT
path; XMR/WOW use LWS unspent outputs plus a wasm RingCT signer; Grin
runs the interactive slatepack ceremony.

## Smirk's single-address scheme: read this first

By default Smirk derives **exactly one address per chain** for every
user: no gap-limit receive-address rotation (BIP44-style), no separate
change index. Two opt-in paths relax that, both shipped dark: BTC/LTC
fresh receive plus `/1/j` change addresses behind
`ENABLE_BTCLTC_FRESH_ADDRS` (default off, `@smirk/core/utxo-addressbook`),
and XMR/WOW subaddress receive behind `ENABLE_SUBADDRESS_RECEIVE`
(default off, `popup/receive-subaddress-index.ts`). The v3 leaf paths
are fixed:

| Asset | Path                  | Encoding   | External-wallet import |
|-------|-----------------------|------------|-----------------------|
| BTC   | `m/84'/0'/0'/0/0`     | P2WPKH bech32 | Standard BIP84: any wallet's seed-phrase import works. |
| LTC   | `m/84'/2'/0'/0/0`     | P2WPKH bech32 | Standard BIP84: same. |
| XMR   | `m/44'/128'/0'/0/0`   | Cryptonote primary (not subaddress) | Cake-compatible (Cake's BIP39 mode). |
| WOW   | `m/44'/2086'/0'/0/0`  | Cryptonote primary | Cake-compatible by the same derivation. |
| Grin  | HMAC-SHA512 over BIP39 entropy with key `"IamVoldemort"` → ed25519 leaf | Slatepack | grin-wallet / Grim compatible. |

**Implication for Send:** with both flags off, change goes back to the
**same** address the funds came from. The `changeAddress` parameter in
`buildPsbt` (BTC/LTC) and the change recipient in the Monero signer
(XMR/WOW) are literally the user's own primary address. With
`ENABLE_BTCLTC_FRESH_ADDRS` on, BTC/LTC change instead goes to a
reserved `/1/j` change address; XMR/WOW change returns to the primary
address either way. Grin's slate protocol handles change at the kernel
level: no address needed.

This is also why the WASM `bitcoin.signPsbt` can take a `masterPath` at
the account level (`"m/84'/0'/0'"`): every input's `bip32_derivation`
entry points at the **same** leaf path `m/84'/coin'/0'/0/0`. The
`build_psbt` test fixtures use `m/84'/0'/0'/0/0`; popup callers pass
the same path matching what `deriveAddresses` produced at wallet
creation.

### BTC/LTC standardization to BIP84 (shipped 2026-05-11)

Pre-v0.3, Smirk shipped BTC/LTC at the BIP44 path `m/44'/coin'/0'/0/0`
with P2WPKH bech32 encoding: a non-standard combination industry
convention doesn't recognize (BIP44 → P2PKH; BIP84 → P2WPKH; Smirk did
neither cleanly). **Verified empirically:** for the abandon mnemonic,
Smirk's legacy v1/v2 derivation produces
`bc1qmxrw6qdh5g3ztfcwm0et5l8mvws4eva24kmp8m` while standard BIP84
produces `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`; Smirk seed
phrases imported into Sparrow / Electrum / Cake / Bitcoin Core showed
"0 balance" because each of them computed the BIP84 address instead.

**v0.3 standardizes BTC/LTC on BIP84** (`m/84'/coin'/0'/0/0`). New
wallets created after 2026-05-11 produce standard P2WPKH bech32
addresses that any wallet's seed-phrase import reproduces. XMR/WOW
remain at `m/44'/coin'/0'/0/0` since Cake's BIP39 mode uses that
exact path for its mod-ℓ derivation; switching XMR/WOW would break
Cake compat.

**Recovery for pre-v0.3 wallets:**

- `scripts/seed-to-keys/` is the recovery path for anyone who upgraded
  without sweeping first. It takes a mnemonic and prints the BTC/LTC
  hex private keys plus addresses at every derivation generation, so a
  legacy address's funds can be swept to the v3 address or imported
  straight into Sparrow / Electrum / Bitcoin Core. It covers the WOW
  holders from the v1/v2 → v3 derivation migration too.
- The legacy `m/44'/coin'/0'/0/0` BTC/LTC code path stays in
  `@smirk/core/hd.ts` as `deriveLegacyBtcLtcKey` (only `deriveAllKeys`
  v1/v2 still use it; v3 uses `deriveBip84Key`).
- `deriveLegacyBtcLtcKey` stays until affected users have moved funds
  out, then it is removed.

XMR/WOW Cake-compat is unaffected by this change (their derivation
path didn't move). Grin compat with grin-wallet/Grim also unchanged.

---

## Universal stages

Every send, regardless of asset, goes through five stages:

```
1. PREPARE        Build the unsigned transaction
                  (UTXO selection, decoy picking, slate initiation, etc.)
2. ESTIMATE       Compute fee + final atomic amounts
                  (depends on tx size: must come after PREPARE)
3. REVIEW         Show the user fee + recipient + amount, get confirmation
4. SIGN           Crypto operations using the unlocked seed
                  (PSBT signing / CLSAG / Schnorr / etc.)
5. BROADCAST      Push to the network
                  (via Smirk backend OR user's self-hosted RPC if in private mode)
```

The `SendWizard` covers stages 1–3 at the UI level (asset → address →
compose → review). PREPARE / SIGN / BROADCAST live per asset: BTC/LTC
and XMR/WOW in `packages/extension/src/popup/send-handler.ts`, Grin in
`packages/extension/src/popup/grin-flows.ts` over the wasm
orchestrators.

## Where each piece lives

```
@smirk/ui
├── SendWizard.tsx              UI scaffolding (asset, address, compose, review)
│                               ↓ onSubmit({ fromAssetId, amountAtomic, toAddress,
│                                            feeRateSatPerVb, sweep }) → SendSubmitResult
│                               Grin branch: onGrinBuildSlate / onGrinFinalize / onGrinCancel
└── GrinRequestWizard.tsx       Receiver-initiated invoice flow

packages/extension/src/popup/send-handler.ts:         generic dispatcher
└── send(wallet, fields, excludeInputs)
    fields = { fromAssetId, amountAtomic, toAddress, feeRateSatPerVb, sweep }
    excludeInputs = inputs already spent by still-pending sends
                    (`txid:vout` for UTXO chains, lowercase-hex key image
                    for CryptoNote)
    ├── sendBtcLtc              PREPARE via chainProviders.utxo(asset).listOutputs,
    │                           SIGN via wasm.bitcoin.buildPsbt + signPsbt + extractTx,
    │                           BROADCAST via chainProviders.utxo(asset).broadcast
    └── sendXmrWow              PREPARE via chainProviders.lws(asset).listOutputs
                                + .getRandomOutputs,
                                key-image filter for spent outputs,
                                SIGN via wasm.monero.signTransaction (fresh OVK per tx),
                                BROADCAST via chainProviders.lws(asset).broadcast
                                (LWS submit_raw_tx)

    The chain providers are backed by `@smirk/core/api`: `getUtxos` /
    `estimateFee` / `broadcastTx` for UTXO chains, `getUnspentOuts` /
    `getRandomOuts` / `submitLwsTx` for LWS.

packages/extension/src/popup/grin-flows.ts:           Grin orchestrator
└── startGrinSend / processGrinS2 / cancelGrinSend
    startGrinInvoice / signGrinInvoice / processGrinI2 / signIncomingGrinSlate
    Plus slatepack codec (armor / dearmor / inspect) and the greedy fee iterator.
    Each step calls into @smirk/wasm's grin namespace (which wraps the 6
    Rust orchestrators in crates/grin-ext/src/wallet_flows.rs).
```

Keep `@smirk/ui` pure presentation: all chain logic in
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
       (origin = our master xprv fingerprint + path **`m/84'/coin'/0'/0/0`**,
       native segwit BIP84; same path for every input, since Smirk uses
       a single-address scheme).
     - Outputs: `[recipient: amount, change: selected_sum - amount - fee]`
       where `change_address` = `fromAddress` (single-address scheme;
       no separate change-index derivation). Skip the change output if
       it would be below the P2WPKH dust limit (294 sat per BIP-376).
2. **ESTIMATE**
   - `api.estimateFee(asset)` → `{ fast, normal, slow }` sat/vB.
   - Compute virtual size: `inputs * 68 + outputs * 31 + 10` (rough P2WPKH
     estimator: fine for v0.3, can use exact later).
   - `fee = ceil(vsize * sat_per_vb)`.
   - If fee changes UTXO selection (e.g. adding inputs to cover fee adds
     more fee), iterate once. Coin-selection oscillation isn't a v0.3
     problem.
3. **REVIEW**: UI shows recipient, amount, fee (sat + USD), total.
4. **SIGN**: `wasm.bitcoin.signPsbt(mnemonic, '', network, masterPath, psbt)`.
   Returns finalized PSBT. Extract `tx_hex` from finalized PSBT via
   new `wasm.bitcoin.extractTx(psbt)` helper.
5. **BROADCAST**: `api.broadcastTx(asset, txHex)` → `{ txid }`.

### As shipped

Four layers:

- `crates/btc-ext/src/build.rs::build_psbt` + `build.rs::extract_tx`
- `crates/smirk-wasm/src/bitcoin.rs` exports `btc_build_psbt` + `btc_extract_tx`
- `@smirk/wasm` `bitcoin.buildPsbt` + `bitcoin.extractTx` TS facades
- `packages/extension/src/popup/send-handler.ts::sendBtcLtc`
- Greedy fee iterator + sweep mode + fee picker in `SendWizard`

### Edge cases for v0.3

- Replace-by-fee (RBF) signaling on by default (sequence = 0xfffffffd).
- Dust limit: skip change output if below 294 sat (P2WPKH per BIP-376);
  the excess goes to the miner as extra fee. `build_psbt` errors with
  `DustChange` rather than silently passing through.
- Address validation: `@smirk/core/address` already handles bech32 +
  P2TR + legacy. The send UI should reject obvious garbage at the form
  level; `build_psbt` does a final network-match check.
- **Single-address scheme**: with `ENABLE_BTCLTC_FRESH_ADDRS` off,
  every spend's change goes back to the same address the UTXOs came
  from. With the flag on, the send reserves a fresh `/1/j` change
  address before broadcast, and only when there actually is change, so
  a dust-dropped send never burns an index.

---

## XMR / WOW (CryptoNote / RingCT chains)

**Most complex non-Grin path.** Decoy selection has to come from the
LWS daemon; ring composition matters for both privacy and validity.

### Stages

1. **PREPARE**
   - `chainProviders.lws(asset).listOutputs(address, viewKey)` → list of
     unspent outputs we own.
   - Filter via `wasm.monero.computeKeyImage` to weed out
     decoy-false-positive matches (same pattern as balance fetch).
   - Greedy output selection by amount.
   - `chainProviders.lws(asset).getRandomOutputs(count)` (ring size 16
     for XMR / 22 for WOW) for each chosen real input: pull ring
     members.
2. **ESTIMATE**
   - LWS reports per-byte fee schedule + mask. Compute tx size from
     input count, ring size, and output count (1 recipient + 1 change).
3. **REVIEW**: UI shows recipient, amount, fee, total.
4. **SIGN**: `wasm.monero.signTransaction(paramsJson)` with everything
   the WASM signer needs: real outputs, decoys, recipient address, change
   address, OVK (fresh per-tx per `fresh_outgoing_view_key()`), fee,
   fee mask.
5. **BROADCAST**: `chainProviders.lws(asset).broadcast(txHex)` posts
   the signed tx hex to LWS `/submit_raw_tx`. Only the signed tx is
   sent: withholding recipient and amount denies the LWS operator a
   sender↔recipient↔amount link.

### As shipped

- `chainProviders.lws(asset).listOutputs` / `.getRandomOutputs` /
  `.broadcast`, backed by `@smirk/core/api`'s `getUnspentOuts` /
  `getRandomOuts` / `submitLwsTx`.
- `packages/extension/src/popup/send-handler.ts::sendXmrWow` glues
  prepare → sign → broadcast.
- Fresh OVK per tx via `fresh_outgoing_view_key()` (never hardcoded).
- Key-image filter pre-sign to weed out outputs the wallet has already
  spent (catches LWS lag after a tx hits mempool but before LWS rescans).

### Edge cases for v0.3

- Spend-all (no change) flows: smaller tx, but the change-address
  derivation should always be derivable as fallback for partial sends.
- Subaddress support: a subaddress destination is a valid recipient
  (`@smirk/core/address` carries the subaddress prefixes, XMR 42 and
  WOW 12208; the wasm signer parses `AddressType::Subaddress`). An
  output received on a subaddress is spent under its own
  `(major, minor)` index, threaded verbatim from the LWS unspent list
  into both the key image and the signing params, never re-derived.
  Absent or `(0,0)` means the primary address. Change always returns to
  the primary address. Handing out fresh receive subaddresses is gated
  behind `ENABLE_SUBADDRESS_RECEIVE`, default off; spending them is not
  gated.
- Locked output handling: skipped in selection; surfaced as the
  **locked** band of the tri-state UI. Reconciliation uses three
  signals (local input cache, input-identifier match vs
  `verifiedSpentInputs`, `locked_balance > 0` fallback) to decide when a
  `pendingOutgoing` entry has settled. Three signals rather than one
  because no single one of them is reliable on its own.

---

## Grin (Mimblewimble, interactive)

> **Update (2026-07, non-custodial):** Grin is now fully **non-custodial**
> and **scan-based**. The backend keeps no Grin outputs or wallet state; it
> exposes only `POST /wallet/grin/scan` + `GET /wallet/grin/height` +
> `POST /wallet/grin/broadcast` + `/relay/*`, and the client recomputes
> balance from a view-only rewind scan (plus a client-side pending overlay)
> on every refresh. The interactive ceremony below is otherwise unchanged,
> but the slatepack hand-off is no longer copy-out-of-band only; each leg
> now travels over one of three transports: **Nostr NIP-59 gift-wrap**
> (federated default), **manual** copy/paste, or a **same-instance backend
> relay** (`grin_slatepacks` mailbox). No transport assumes `api.smirk.cash`.
> See `docs/grin.md` for details.

**Hardest case.** Sender and receiver run an interactive ceremony where
they each contribute signing material before the kernel can be
finalized. Both directions of the ceremony exist: sender-driven **send**
(S1→S2→S3) and receiver-driven **invoice** (I1→I2→I3), plus a
paste-any-slatepack inbox that dispatches on leg (S1 / I1 / S2 / I2),
`cancelGrinSend`, and a compact-binary slatepack codec so we interop
with external `grin-wallet` and Grim users, not only other Smirk
wallets.

### Send (sender-driven, S1→S2→S3)

1. **PREPARE (S1)**: sender picks inputs (Pedersen commitments + their
   blinding factors), computes change blind, computes `sender_blind_excess
   = Σoutputs − Σinputs − offset` (cross-validated against
   `grin_wallet_libwallet` 5.4.0), creates the kernel nonce, and emits
   the S1 slate via `grin_create_send_transaction`.
2. **HAND-OFF**: S1 is wrapped in a slatepack (`SlatepackBin` v1.0 →
   ASCII armor `BEGINSLATEPACK. … . ENDSLATEPACK.`). The leg travels
   over Nostr NIP-59 gift-wrap, manual copy/paste, or a same-instance
   backend relay.
3. **SIGN (S2, receiver)**: receiver pastes S1, runs
   `grin_sign_incoming_send_slate` which adds their output (Pedersen
   commit + Bulletproof), their partial sig, and pubkeys. Returns S2 as
   another armored slatepack.
4. **FINALIZE (S3, sender)**: sender pastes S2, runs
   `grin_finalize_send_slate` which verifies the receiver's partial,
   aggregates partials → final Schnorr signature, verifies the kernel
   sig against `(sum_of_commitments − offset_G)`, and returns both the
   wire bytes and `tx_json`, the JSON-shaped Transaction.
5. **BROADCAST**: `chainProviders.grin().broadcast({ tx })`, backed by
   `api.broadcastGrinTransaction({ tx })`, where `tx` is the `tx_json`
   from `grin_finalize_send_slate`. Grin's `/v2/foreign
   push_transaction` takes the JSON Transaction object, not wire-format
   hex. Kernel excess from the final slate doubles as the on-chain
   identifier shown in the "Done" screen:
   `https://grincoin.org/kernel/${kernelExcess}`.

### Invoice (receiver-driven, I1→I2→I3)

Same primitives, inverse direction. Receiver picks an amount, runs
`grin_create_invoice` to emit I1 (which carries the receiver's output
commit + range proof + partial sig), hands the armored slatepack to the
payer. Payer runs `grin_sign_invoice` → I2 (adds inputs, fee, sender
partial). Receiver finalizes with `grin_finalize_invoice` → broadcastable
TX. UI surface is `GrinRequestWizard` reached from the Receive screen's
"Request specific amount" affordance.

### Where the code lives

```
crates/grin-ext/src/wallet_flows.rs:       6 Rust orchestrators
crates/smirk-wasm/src/grin/wallet_flows.rs:   wasm-bindgen wrappers + JSON DTOs
packages/wasm/src/index.ts:                typed TS facades (grin.* namespace)
packages/extension/src/popup/grin-flows.ts:   extension orchestrator:
  startGrinSend / processGrinS2 / cancelGrinSend
  startGrinInvoice / signGrinInvoice / processGrinI2 / signIncomingGrinSlate
  armorSlate / dearmorSlate / inspectSlatepack
  calcGrinFee:  (inputs×1 + outputs×21 + max(1, kernels)×3) × 500_000
                nanogrin, matching grin_core::global::DEFAULT_ACCEPT_FEE_BASE
  resolveGrinFee(total, amount, numInputs) decides fee vs change:
                a surplus above the 2-output fee produces a change
                output, otherwise the surplus is folded into the fee
                and no change output is emitted
packages/ui/src/components/SendWizard.tsx:   Grin Exchange step
packages/ui/src/components/GrinRequestWizard.tsx:   invoice wizard
```

### Cross-implementation interop

The slate v4 compact-binary codec (`crates/grin-ext/src/slate_bin.rs`,
ported from grin v4_bin.rs) is what makes Smirk↔grin-wallet interop work:
same wire bytes as `SlatepackBin` produced by grin-wallet 5.x. Verified
end-to-end by the round-trip cross-validation tests in
`crates/grin-ext/tests/grin_wallet_compat.rs` (S1→S2→S3 + I1→I2→I3
against `grin_wallet_libwallet` 5.4.0 as a dev-dep oracle). See
`docs/TESTING.md` Layer 2.

### Edge cases for v0.3

- **Persistence across popup close**: Mimblewimble's interactive flow
  *must* survive popup-close (the receiver may take hours to respond).
  Wizard state lives in session storage via `useWizard<GrinFields>`;
  resuming the wizard re-renders the Exchange step with the same
  pre-built S1 + same sender context.
- **Payment proofs**: Rust + WASM support exists (ed25519 receipt
  over `(amount, kernel_commitment, sender_address)`); not surfaced in
  the UI.
- **NRD kernels (relative timelocks)**: primitives exist; not used for
  normal sends. Reserved for swap-refund paths.
- **Slate expiry**: `cancelGrinSend` frees a pre-broadcast exchange's
  reserved inputs; a reservation left alone ages out on the overlay's
  backstop. A cancel after broadcast is refused, since freeing inputs
  that are genuinely spent in-flight would let a later send build a
  double-spend.

---

## Review-and-confirm screen

`SendWizard` is four steps: asset → address → compose → review. The
review step is read-only and shows Asset, Amount (or "Max (sweeps
balance)"), To, and either a fee tier in sat/vB or an estimated network
fee, then a single submit button:

```
┌─────────────────────────────┐
│  Review                     │
├─────────────────────────────┤
│  Asset:  Bitcoin (BTC)      │
│  Amount: 0.0123 BTC         │
│  To:     bc1q…7gm4          │
│  Fee tier: normal (12 sat/vB) │
├─────────────────────────────┤
│         [ Send 🔓 ]         │
└─────────────────────────────┘
```

The 🔓 marks this as the *crypto-execute* button, distinct from the
wizard's "Next" buttons. Grin takes an interactive Exchange step in
place of the one-shot Review, because the broadcast cannot happen until
the recipient returns a signed slatepack.

### Testing strategy: small mainnet amounts, no testnets

Smirk does not exercise testnet (BTC testnet3 / signet / LTC testnet /
XMR stagenet / Grin testnet); production has always been mainnet-only,
and that posture continues. Validation strategy:

1. **Send the smallest sensible amount**: e.g. 1000 sat (~\$0.001 at any
   recent BTC price), 0.0001 XMR, 0.001 GRIN. Total dollar exposure for
   a full 5-asset end-to-end sweep: under \$1.
2. **Receiver = dev's other wallet**: Cake / Sparrow / a second Smirk
   install, so a successful receive proves both sides of the path.
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
