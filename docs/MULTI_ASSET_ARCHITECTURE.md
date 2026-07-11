# Multi-Asset Architecture

> Where Smirk's asset surface is today (5 chains, ~6 capability flags,
> one visibility helper) and where it goes when we add ETH, Trocador,
> future stablecoins, future EVM L2s. This doc is the
> opinionated map: what we're doing now, what we're deliberately NOT
> doing now, and what the natural evolution looks like.

## Status quo (v0.3.0)

Five built-in assets — BTC, LTC, XMR, WOW, Grin — each registered
statically at module load via `@smirk/assets`. The registry already
has:

- **Family discriminant** (`utxo` / `cryptonote` / `mimblewimble`)
  with per-family feature data (UTXO subtypes, RingCT params, slatepack
  semantics).
- **Capability flags** for runtime feature inclusion:
  - `sendable` — show in the Send chooser
  - `receivable` — show in the Receive screen
  - `dappBridge` — exposed through `window.smirk` signing surfaces
  - `socialTipping` — show in the Tip composer
  - `defaultVisible` — included in new wallets' default visible set
- **User visibility** layered on top — `ui.hiddenAssets: string[]`
  in session state, surfaced through `visibleAssetIds(state, assets)`
  in `@smirk/core/state/visibility`.

This gives us **registry-driven feature inclusion** (capability flags)
+ **user-curated visibility** (hidden-set). Surfaces filter by both:

```ts
const tippable = visibleAssetIds(state, listAssets())
  .filter((a) => a.socialTipping);
```

No `['btc', 'ltc', 'xmr', 'wow', 'grin'].includes(...)` inclusion
tables anywhere. Adding ETH eventually means one new file in
`@smirk/assets/src/assets/eth.ts` with the flags set appropriately —
*every existing UI surface that respects capability + visibility
inherits the right behaviour for free*.

## The spaghetti we have NOT yet untangled

Three places where v0.3 code still has per-family branching that
will get expensive as we scale past 5 assets:

1. **`fetchAllBalances` in `wallet-flow.ts`** — a hand-rolled
   `Promise.all` over five named asset functions
   (`fetchUtxoBalance`, `fetchLwsBalance` × 2, `fetchGrinBalance`).
   Adding a chain = edit this function + add a new helper. No
   registry binding. We've patched in visibility-aware skipping
   (`options.visibleAssetIds`) but the per-asset branch list is
   still hand-rolled.

2. **`send-handler.ts` / `tip-handler.ts` in the popup** — top-level
   `sendBtcLtc` vs `sendXmrWow` vs Grin (handled separately in
   `grin-flows.ts`). Dispatch is a switch on `asset.family`. Adding
   a 4th family = new function + new branch.

3. **`@smirk/wasm` namespaces** — `bitcoin`, `monero`, `grin`
   per-family. JS callers reach into the right namespace for the
   asset family they're working with. ETH would need a new
   namespace + corresponding Rust crate.

These are functional. They are NOT going to be fixed by a Big-Bang
refactor — that's how you ship architectural debt with a new coat of
paint.

## Where this goes — staged, not rewritten

### Stage 1 (done in v0.3.0)

- ✅ Capability flags on the registry.
- ✅ `visibleAssetIds(state, assets)` as the sole visibility check.
- ✅ `fetchAllBalances` accepts `visibleAssetIds` to short-circuit
  hidden-asset round-trips.
- ✅ All UI choosers (`SendWizard`, `ReceiveScreen`, `TipMaker`,
  `HomeTab`) filter by `visibleAssetIds + capability`.
- ✅ Settings → Assets panel.
- ✅ Auto-unhide on tip claim.

### Stage 2 (v0.3.1, alongside ETH)

When we add a new asset family (EVM), introduce the
`AssetAdapter` interface — one adapter per family, asset-specific
config read from the registry entry:

```ts
// @smirk/core/adapters/types.ts (sketch — NOT YET IMPLEMENTED)
interface AssetAdapter<TProvider = unknown> {
  family: AssetFamily;

  // Identity
  deriveAddress(wallet: UnlockedWallet, asset: AssetDef): string;

  // Balance polling
  getBalance(
    wallet: UnlockedWallet,
    asset: AssetDef,
    provider: TProvider,
  ): Promise<AssetBalance>;

  // Sending
  buildSend(
    wallet: UnlockedWallet,
    asset: AssetDef,
    params: SendParams,
  ): Promise<SignedTx>;
  broadcast(
    tx: SignedTx,
    provider: TProvider,
  ): Promise<{ txid: string }>;

  // Tipping — optional, gated by AssetDef.socialTipping
  generateTipKeys?(): TipKeyMaterial;
  buildTipSweep?(
    wallet: UnlockedWallet,
    asset: AssetDef,
    tipKey: Uint8Array,
  ): Promise<SignedTx>;
}
```

Then refactor `fetchAllBalances` to iterate visible assets and
delegate to `adapterFor(asset.family).getBalance(...)`. Similarly
for send / tip. The branch in `popup/index.tsx` becomes
`adapterFor(asset).` instead of `if family === 'utxo' ... else if
family === 'cryptonote' ...`.

**Why wait?** Designing an adapter interface from 3 implementations
always gets the abstraction wrong. We need a 4th implementation
(EVM) to validate that the interface actually generalises. Locking
in `AssetAdapter` before seeing how EVM stresses it would force a
v0.3.2 redesign.

### Stage 3 (v0.4+ or later, only if needed)

- Per-family adapter packages (`@smirk/adapter-utxo`,
  `@smirk/adapter-evm`, etc.) so consumers can install only the
  families they need. Matters for tree-shaking / bundle size when
  the wallet supports 15+ assets across 6+ families.
- Dynamic asset registration at runtime — host applications register
  custom asset definitions on top of the static built-ins. Already
  supported by `AssetRegistry.register(def)` but not yet exercised.
- Per-asset provider configuration (RPC URLs, indexer endpoints)
  hot-swappable from Settings → Networks. Necessary once we support
  multiple EVM L2s and users want to point at their own nodes.

## Conventions for new asset PRs

When adding asset N+1 (v0.3.1's ETH or anything later), the diff
should look like:

1. **New file** in `@smirk/assets/src/assets/<id>.ts` with the
   registry entry. Set capability flags honestly: `sendable` and
   `receivable` should be `true` once basic flow works;
   `socialTipping` only when the per-asset tip key derivation +
   sweep are wired; `dappBridge` only when the signing primitives
   are exposed. `defaultVisible: false` for any post-v0.3.0 addition
   so existing users don't get a surprise row in their Home tab.

2. **If new family**: new file in `@smirk/core/adapters/<family>.ts`
   implementing `AssetAdapter`. This is the point where stage 2
   kicks in — the first new-family PR introduces the interface,
   subsequent ones add adapters.

3. **If existing family**: just the registry entry. The family
   adapter (once stage 2 lands) already knows how to handle it.

4. **NO changes to `popup/index.tsx`**. If you find yourself editing
   it to add an asset, you're doing it wrong — the registry +
   adapter pattern should have absorbed the new asset transparently.
   The exception during stage 1 is the hand-rolled `fetchAllBalances`
   branch list, which is the *explicitly* known piece of debt the
   adapter pattern unwinds.

5. **NO `if (asset.id === 'xxx')` branches**. Use capability flags.
   If a capability doesn't exist for what you need, add it to the
   registry types — that's a one-line change that benefits every
   future asset.

## Cost-of-poll accounting

A useful mental model when adding chains:

| Asset / family | Per-popup-open cost (visible asset)                    |
|---|---|
| UTXO (BTC, LTC, future BCH/DOGE) | 1 HTTP call to indexer per asset |
| CryptoNote (XMR, WOW)             | 1 LWS register (idempotent) + 1 balance fetch per asset |
| Mimblewimble (Grin)               | 1 backend scan/rewind of the UTXO set per asset; backend stores nothing |
| EVM (ETH, future L2s)             | 1 RPC `eth_getBalance` per asset, possibly multiple if multi-token |
| Future: stablecoin tokens         | 1 contract call per token per asset, multiplied by chain count |

The point: **adding 1 visible asset doesn't add 1 round-trip — it
can add several depending on family.** Visibility is the user's
escape valve, but the architecture should let users default-hide
high-cost assets so they only "wake up" when explicitly needed.
Hence `defaultVisible: false` for additions after v0.3.0.

## Related

- [`UI_DESIGN.md`](./UI_DESIGN.md) Principle 6 + 6a — registry-driven
  feature inclusion and user-curated visibility as design rules.
- [`packages/assets/src/types.ts`](../packages/assets/src/types.ts) —
  the canonical `AssetDefinition` shape + capability flags.
- [`packages/core/src/state/visibility.ts`](../packages/core/src/state/visibility.ts) —
  visibility helpers.
