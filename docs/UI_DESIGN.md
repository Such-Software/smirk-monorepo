# Smirk Wallet — UI Design Principles

Direction document for the v0.3+ wallet UI overhaul. Captures the
architectural decisions that shape every screen so we don't drift back
into a generic asset-list paradigm as the wallet adds chains and
features.

This is a *principles* doc, not a screen-by-screen mockup. Visual
design (typography, color, motion) is downstream of the principles
here.

## What this is replacing

The current production extension at
[Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension)
ships an asset-centric UI: a list of supported coins on the home
screen, with each coin opening into a per-asset sub-view that gates
all actions (send, receive, swap, tip).

That model worked at five chains. It won't survive ten, and it
fights against three of Smirk's differentiators (social tipping
across platforms, Grin's interactive transactions, and cross-chain
swaps), all of which span multiple assets and don't fit neatly under
one coin's view.

The redesign starts from a different question: not "what coin is the
user looking at," but "what is the user trying to do."

## Principle 1 — Action-centric over asset-centric

Top-level navigation is **verbs**, not **nouns**:

| Tab          | Purpose                                                       |
|--------------|---------------------------------------------------------------|
| **Home**     | Total balance across assets, recent activity, quick actions   |
| **Wallet**   | Per-asset balances and addresses (the only asset-list view)   |
| **Swap**     | Cross-chain swap interface (THORChain v0.3, native v0.4+)     |
| **Activity** | Transaction history, pending Grin slatepacks, unclaimed tips  |

Asset selection is a sub-step *inside* each flow, never the entry
point. The user clicks "Send" and is then asked which asset; the user
clicks "Create Tip" and is then asked the amount and asset. This
inverts the legacy model where the user clicks "BTC" → then "Send" —
the action they wanted was Send, not BTC.

The Wallet tab still exists as a place to inspect per-asset state
(balance, address, view key, derivation path). It's a reference view,
not the primary navigation.

## Principle 2 — No transparent / shielded vault split

A natural-seeming idea is to visually divide assets into transparent
(BTC, LTC, …) and shielded (XMR, WOW, …) vaults. **We're not doing
that.**

Rationale: privacy is a per-flow property, not a per-asset property.
View keys make even "private" CryptoNote assets selectively
transparent — the user can hand a view key to a tax accountant, post
a public tip with a published address, or share an LWS endpoint.
Bitcoin can be made private with care. Splitting assets into two
vaults oversimplifies and gives the user a false sense of binary
classification.

Where privacy considerations *do* surface in the UI:

- At tip creation, choosing public-link vs encrypted-to-recipient.
- At connection grant, granting per-asset visibility to a site.
- At view-key export, with explicit consent flows.

Not in the asset list.

## Principle 3 — Grin gets a Message Center

Grin's interactive transaction model (slatepacks) breaks the standard
"address → amount → send" UX. A slatepack is an inbound message that
needs a response, more than it is a passive receive event.

Concretely, Grin transactions surface in the UI as:

- A **Pending Slatepacks** list under the Activity tab — items
  requiring the user to sign or finalize.
- **Clipboard auto-detect** — when the popup opens, scan the
  clipboard for a `BEGINSLATEPACK…ENDSLATEPACK` block and offer to
  process it via a non-modal toast (with explicit user consent before
  reading clipboard contents in flows where consent isn't already
  granted).
- An **Invoice flow** treated as a first-class peer to the standard
  Send flow — the user can request payment by generating an invoice
  slatepack, distinct from "give me your address."

The "interactive" flag on the asset registry (see Principle 6)
controls whether an asset uses the Address paradigm or the Slatepack
paradigm in send/receive flows. Grin is the only such asset today;
the design needs to accommodate at least one more in the future
(MWC, Beam, future MW chains).

## Principle 4 — Swaps are top-level, with a step tracker

Swap UX has its own physics: multiple network fees (inbound +
outbound), asymmetric confirmation times (10 min for BTC inbound vs
seconds for LTC), liquidity-dependent slippage, and a routing path
the user usually wants to inspect.

Burying swap inside a per-asset Send flow misrepresents what's
happening. Swap is a top-level tab.

Inside the Swap tab:

- **Asset pair selector** — from / to, with a search box (since the
  list of supported assets grows over time).
- **Quote panel** — output amount, slippage, route, fees.
- **Confirmation step** — explicit "yes, swap N BTC for M XMR" with
  the receiving address shown (it's *the user's own* address, but
  saying so explicitly avoids confusion).
- **Step tracker post-broadcast** — a visual progress indicator with
  states like *Broadcast → Awaiting Inbound Confirmation → Routed →
  Awaiting Outbound → Funds Available*. Each step shows estimated
  time remaining when known.

The same Swap tab eventually hosts native (P2P, adaptor-signature)
swaps in v0.4+. Same UI surface, different backend. Aggregator
(THORChain) vs Native (P2P) is a sub-toggle, not a separate tab.

## Principle 5 — Tip Maker as a wizard, not a form

Social tipping is the wallet's primary differentiator. The flow has
to feel slick.

A **two-step wizard** rather than a one-page form:

1. **Asset + Amount** — pick what to send and how much. Inline
   conversion to the user's reference fiat. Clear indicator of what
   this tip will look like to the recipient (encrypted-to-key vs
   public link).
2. **Generate** — produces the tip link with a copy button, share
   sheet (mobile), and QR code. Makes it satisfying to actually
   create a tip.

Pending tips (funded but unclaimed) live in the Activity tab with a
prominent **Clawback** button. Unclaimed tips are the user's funds in
limbo; recovering them shouldn't take three taps.

## Principle 6 — Asset registry, not hardcoded chains

Today: BTC, LTC, XMR, WOW, Grin. Tomorrow: probably more BTC forks,
Litecoin MWEB, additional CryptoNote chains, possibly an EVM chain or
two for ERC-20 tipping, possibly Beam or MWC for the Grin family.

The wallet has to scale to this without a flag day. Concretely:

```ts
// packages/core/src/assets/types.ts (sketch)
export interface AssetDefinition {
  id: string;                      // 'btc', 'ltc', 'xmr', 'wow', 'grin'
  displayName: string;             // 'Bitcoin', ...
  ticker: string;                  // 'BTC', ...
  decimals: number;                // 8, 8, 12, 11, 9
  iconPath: string;                // resolved by the UI layer

  // Derivation
  derivationPath: string;          // BIP32 path; null for non-BIP32 chains
  deriveAddress: (mnemonic: string, index: number) => string;

  // Address handling
  validateAddress: (address: string) => boolean;
  addressKind: 'address' | 'interactive'; // 'interactive' = slatepack-style

  // Confirmations / claim semantics
  confirmationsRequired: number;   // BTC/LTC = 0, WOW = 4, XMR/Grin = 10

  // Capabilities
  swapAggregator: 'thorchain' | 'native' | 'both' | 'none';
  paymentProofs: boolean;          // Grin payment proof support
  socialTipping: boolean;          // every chain we list supports this

  // Reserved for future flags as new chain capabilities surface
}
```

Adding asset N+1 is then **additive**: register the definition, drop
in the icon, plug in the derive/sign functions, done. UI components
iterate over the registry rather than running `if (asset === 'btc')`
branches.

This also gives us a single place to introduce per-chain quirks (the
Grin "pending balance includes locked outputs" thing, the Wownero
"4-confirmation requirement," the future "this chain requires
PSBT-signing instead of raw-tx-signing" thing) without leaking them
into UI code.

## Principle 7 — Granular per-asset connection grants

When a site calls `window.smirk.connect()`, the approval UI shouldn't
be all-or-nothing. A Monero-only shop should be able to ask for the
user's XMR address only, and the user should see exactly which assets
they're consenting to share.

The connection screen also needs to make the **origin** un-spoofable.
Big monospace `https://app.example.com` badge near the top, distinct
from the site's self-reported title or favicon. (The site's reported
metadata is shown alongside, but never as the primary identifier.)

Persisted grants live per-origin × per-asset. Revoking an asset's
grant for a site is a single click.

## Navigation summary

```
┌─────────────────────────────────────────────────────────┐
│  Home    Wallet    Swap    Activity              [⚙]   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  HOME:    total balance, quick actions, recent           │
│           social activity, pending claimable tips        │
│                                                          │
│  WALLET:  scrollable list of registered assets;          │
│           per-asset detail panel (balance, address,      │
│           derivation path, view key export)              │
│                                                          │
│  SWAP:    aggregator vs native toggle; from/to picker;   │
│           quote; step tracker for active swaps           │
│                                                          │
│  ACTIVITY: tx history; pending Grin slatepacks;          │
│            unclaimed tip links (with clawback)           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

The same nav structure works on extension popup (360–400px wide),
mobile (Capacitor full screen), and desktop (Tauri windowed). Shared
Preact components in `packages/ui/` (planned) keep visual consistency.

## Out of scope for this doc

- Visual design (color palette, typography, motion).
- Specific component library (Preact + which CSS approach).
- Onboarding flow (handled separately as part of v0.3 onboarding
  rework).
- Mobile-specific affordances (push notifications, haptics, deep
  linking) — covered in the Capacitor track.
- Auth / login (Telegram-based today; may evolve).

## Status

Direction set 2026-05-08. No code written against these principles
yet — the `packages/extension/` skeleton currently reflects the
legacy popup. Feature migration into the new UI structure begins
once `packages/core/src/assets/` (the registry from Principle 6) is
in place.
