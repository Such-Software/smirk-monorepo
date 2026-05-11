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
| **Home**     | Total balance, action row, asset list, recent activity        |
| **Swap**     | Cross-chain swap interface (THORChain v0.3, native v0.4+)     |
| **Inbox**    | Slatepacks, swap rounds, incoming tips with notes, e2ee DMs   |
| **Settings** | Wallet config, custom RPC servers, view-key export, seed      |

Four tabs total. Per-asset detail (address, view key, per-chain
history, RPC override) lives as a drill-down screen *from* Home, not
as its own tab — modern wallet pattern (Phantom, Trust, Cake) where
the asset list IS the wallet view.

Asset selection is a sub-step *inside* each action flow, never the
entry point. The user clicks "Send" and is then asked which asset;
the user clicks "Create Tip" and is then asked the amount and asset.
This inverts the legacy model where the user clicks "BTC" → then
"Send" — the action they wanted was Send, not BTC.

The action row on Home contains the four universal verbs:
**Tip · Send · Receive · Swap**. "Claim" is contextual — it appears
only when there's a claimable tip, and it lives where the tip lives
(Inbox), not as a top-level action.

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

## Principle 3 — Unified Inbox for everything that arrives

Slatepacks aren't the only thing that flows in. Atomic-swap rounds
(v0.4+) need responses. Incoming tips can carry notes. Free-form
e2ee messages between users (v0.4+) ride the same relay. Lumping
all of these into one tab — **Inbox** — gives users a single
"what needs my attention" surface and re-uses one backend primitive
across four item kinds.

| Kind | Source | Visual / actions |
|---|---|---|
| 📝 Slatepack | Grin sender | "Sign" / "Finalize" / "Cancel" |
| ⇄ Swap round | v0.4 atomic-swap counterparty | "Respond" / "Cancel" |
| 🎁 Tip | Incoming tip with optional note | "Claim" + read note |
| 💬 Message | Free text, ≤240 chars, e2ee | Read + "Reply" + "Block" |

All four ride the same backend envelope — the existing slatepack
relay endpoint generalizes to take a `kind` field plus an
encrypted-to-recipient payload. Backend stores ciphertext + metadata
+ TTL only; never sees plaintext. Same relay primitive for all
four = one schema to maintain, one code path to harden.

**Versioning:**
- v0.3 — Inbox surface ships with slatepacks (existing) + tips with
  optional notes.
- v0.4 — adds swap-round items.
- v0.4 (or v0.5) — adds free-form e2ee messages.

**Slatepack-specific behaviors:**

- **Clipboard auto-detect** — when the popup opens, scan for
  `BEGINSLATEPACK…ENDSLATEPACK` and offer to ingest via a non-modal
  toast (with explicit consent for clipboard read).
- **Invoice flow** as a first-class peer to standard Send — the
  user can request payment by generating an invoice slatepack,
  distinct from "give me your address."

The `addressKind: 'interactive'` flag on the asset registry (Principle
6) is what flips an asset out of the Send-to-address flow into the
slatepack paradigm. Grin is the only such asset today; design has
to accommodate future MW chains (Beam, MWC).

**Anti-spam for free-form messages.** Three modes the user picks
from in Settings:

1. **Tip-gated** (default) — accept only from users you've previously
   tipped, or who've previously tipped you. Social graph as filter.
2. **Open** — any registered Smirk user can DM. Power users / public
   tip-link recipients.
3. **Closed** — only people in your contacts (manually allowed).

Plus per-sender rate limit (default 3 / hour) and a per-recipient
block list at every level. Block lists are encrypted blobs the
backend stores — server has zero plaintext access.

**Strategic posture.** End-to-end-encrypted messages sit Signal/Matrix
shape (operator is a relay, never sees plaintext, can't moderate).
That carries no MTL or chat-platform classification — Cash App and
Venmo carry tx notes without messaging-specific licensing. The
moderation-as-implicit-liability angle that bites unencrypted
platforms doesn't apply here because we structurally cannot read
content. Block + report just deletes the relayed ciphertext.

What we do **NOT** ship:
- A general /messages tab with contact list. Messages render in
  context (alongside the tip in Inbox, alongside the slate in
  Inbox), never as a standalone messenger app.
- Group chat.
- Any image / file / link surface. Text-only at 240 chars
  trivially eliminates CSAM and spam-file vectors.
- Search / indexing. Backend can't index ciphertext.

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

## Principle 8 — Unified balance, with denomination + hide

The Home tab leads with a single large total balance — the answer to
"how much do I have?" — rather than a stack of per-asset numbers.
Per-asset balances are still visible (one row each in the asset
list below), but the headline number is the sum.

**Denomination is configurable.** Default to the user's reference
fiat (USD picked at onboarding; switchable to EUR / GBP / etc.).
Bitcoiners often want totals shown in BTC, not dollars; satoshi /
nanogrin / atomic-WOW modes follow naturally. Tap the total to
cycle, long-press to open the picker. Settings carries the
permanent choice.

**Pending is shown but separated.** The big number is *confirmed*
balance. A small "+\$X.XX pending" line beneath surfaces incoming
tips, mempool tx, swap-in-progress amounts. Different visual weight
makes the distinction unmissable.

**Hide toggle is mandatory.** An eye-icon next to the total masks
all balance fields ("●●●●") for screen-share / coffee-shop /
shared-laptop scenarios. This is a privacy expectation, not a
nice-to-have — Coinbase, Trust, and most modern wallets ship it
because users learned to expect it.

**Failure states.** When the price feed is stale or unavailable,
the fiat denomination renders as `—` with a tooltip ("Rate
unavailable, last fetched 12m ago"). The native-denomination total
(BTC mode, sat mode) keeps working since it's just summed atomic
units divided by registered decimals — no network dependency.

**Implementation note.** Atomic-units math is BigInt end-to-end;
fiat conversion happens at the display layer only. Asset registry
provides decimals, price feed provides USD-per-asset, denomination
picker translates. No floating-point on consensus-critical values.

## Principle 9 — Themable surface, registry-driven (added 2026-05-11)

The wallet ships with a theme registry in `@smirk/ui/themes/` that mirrors
the asset-registry pattern from Principle 6. A theme is pure data:

```ts
interface Theme {
  id: string;
  name: string;
  description?: string;
  tokens: ThemeTokens;   // colors, typography, geometry, effects
  css?: string;          // optional theme-specific selectors (bevels, etc.)
}
```

`@smirk/ui` components consume themes **only** via CSS custom properties
(`var(--smirk-bg)`, `var(--smirk-accent)`, …) — they never import a theme
object. That keeps the component library theme-agnostic and lets shells
(extension / mobile / desktop) register their own themes (e.g. macOS Aqua,
material-mobile) without rebuilding `@smirk/ui`.

**Built-ins:**
- `defaultTheme` — dark "Smirk Bauhaus" look, the fallback for missing
  tokens.
- `win95Theme` — chunky bevels, MS Sans Serif, gray system palette.
  Demonstrates the registry's coverage of variants the default doesn't
  hint at.

**Apply path:** at boot (and on every change) the shell calls
`applyTheme(theme)`, which sets `--smirk-*` custom properties on `<html>`,
swaps the `smirk-theme-<id>` class, and injects the theme's optional CSS
payload into a stable `<style>` element.

**Persistence:** the active theme id lives in `SessionState.ui.theme`
(schema v3). Survives session restart via the platform's persistent
storage tier.

**Token coverage** (canonical set as of 2026-05-11): `bg`, `bgElevated`,
`bgSunken`, `fg`, `fgMuted`, `accent`, `accentHover`, `accentFg`, `border`,
`borderStrong`, `positive`, `negative`, `warning`, `fontFamily`,
`fontFamilyMono`, `fontSizeBase`, `fontSizeSmall`, `radius`, `radiusSm`,
`radiusLg`, `shadowRaised`, `shadowSunken`.

**Migration debt:** v0.3 components are *progressively* moving from
hardcoded `rgba(255,...)` inline styles to `var(--smirk-*)` consumption.
ActionButton, BalanceCard, UnifiedBalance, BottomNav done as of
2026-05-11; settings page, send/receive flows, lock screen still inline.
Touch as you go — no big-bang sweep planned.

## Navigation summary

```
┌─────────────────────────────────────────────────────────┐
│  Home          Swap          Inbox          Settings    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  HOME:    total balance (denomination toggle, hide);    │
│           action row (Tip · Send · Receive · Swap);     │
│           asset list (BalanceCard per chain →           │
│             asset detail screen);                       │
│           recent activity strip                          │
│                                                          │
│  SWAP:    aggregator vs native toggle; from/to picker;  │
│           quote; step tracker for active swaps          │
│                                                          │
│  INBOX:   unified item list — slatepacks, swap rounds,  │
│           incoming tips with notes, e2ee DMs (v0.4+);   │
│           per-item action verbs (Sign / Claim / Reply)  │
│                                                          │
│  SETTINGS: wallet config, per-asset RPC overrides,      │
│            view-key export, seed reveal,                │
│            inbox-spam mode, denomination, etc.           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

Asset detail (balance, address, view key, per-chain history, RPC
override) is a drill-down screen *from* Home — tap any asset row.

The same nav structure works on extension popup (360–400px wide),
mobile (Capacitor full screen), and desktop (Tauri windowed). Shared
Preact components in `packages/ui/` keep visual consistency.

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
