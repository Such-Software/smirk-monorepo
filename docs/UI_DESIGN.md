# Smirk wallet UI principles

> Status: stable · Updated 2026-09-27 · Applies to: v0.3 extension and desktop clients

This document owns the wallet's interaction and copy principles. Component APIs
live in [the UI package](../packages/ui/README.md), send behavior in
[SEND_FLOW.md](SEND_FLOW.md), and platform boundaries in
[ARCHITECTURE.md](ARCHITECTURE.md). A design goal is not evidence that a feature
is implemented or deployed.

## Actions and navigation

Home presents balances, recent activity and Tip, Send, Receive and Swap actions.
Asset details are a drill-down from Home. The default navigation contains Home,
Swap, Inbox and Settings. Feed appears only when the backend advertises it;
Browse appears only when the desktop shell provides its browser controller.

General Send begins with an asset chooser. Send from an asset detail screen
already knows the asset and begins with the destination. An unfinished send or
Grin exchange retains its draft when the window reopens. A completed receipt
must not become a new send draft. Back from the initial destination screen
returns to the asset detail rather than making the user select that asset again.

Amount and review show the native amount and an approximate USD value when a
usable price exists. Missing prices show an unavailable state, never a fabricated
zero. USD is display-only: all transaction amounts, fee calculations and signing
inputs remain integer atomic units. Max uses the current fee-adjusted preview;
the review identifies it as an estimate because the actual fee can change.

## Unlock and operation confirmation

An unlocked wallet must hold the authority needed for its supported operations.
A one-hour or four-hour unlock preference survives popup reopening without
renewing its original deadline. Explicit Lock revokes other open wallet windows
and pending handoffs. Recovery-phrase display remains password protected.

Settings offers independent password confirmation for sends and for signing or
private-key requests. Both default off. When enabled, confirmation is per
operation and does not extend the unlock period. Background sign-in and incoming
message checks continue without these prompts. Cancellation or an incorrect
password prevents the requested operation. Lock during an asynchronous check
prevents later signing or broadcast; an already broadcast transaction remains
reported as sent.
See [the session architecture](ARCHITECTURE.md#wallet-unlock-lifetime).

## Balances and privacy

Keep confirmed, pending and locked amounts distinct. Unknown balance or price
information is unavailable, not healthy or zero. Balance masking applies across
the wallet's balance surfaces. Never suggest that a price estimate is a quote or
that a submitted transaction is confirmed.

Do not split assets into reassuring "private" and "public" vaults. Privacy
varies by operation: a Monero or Wownero light-wallet server receives a private
view key, while BTC/LTC addresses and transaction outputs are public chain data.
Explain the data shared at the relevant action. Spending keys remain on the
client; that statement does not mean that all keys remain there.

## Inbox, identities and messages

Inbox collects incoming tips and Grin slatepacks, with actions appropriate to
their actual state. Messages is an Inbox drill-down. Encrypted direct messages
use Nostr gift-wrap and the configured relay/provider interfaces. Slatepack
transport can use the backend relay or Nostr; these are separate protocols.
Do not claim that every inbox item shares one backend envelope.

Users can select derived, burner or imported Nostr identities. Every signing
surface must honor that selection. An unavailable identity must refuse rather
than silently switch to the primary identity. Burner and imported identities
require their own backup; restoring the wallet phrase alone does not recover
them. Publishing a handle-to-identity mapping requires explicit user consent.

A successful relay publish does not prove that a remote recipient received a
message. When inbox discovery fails, show the delivery limitation. Tip-gated
messaging, generalized contact moderation, group messaging and atomic-swap inbox
items are not v0.3 guarantees.

## Swaps and tips

Trocador supplies the implemented aggregator flow. Quote, deposit and completion
are separate stages. Show the selected pair, input amount, output estimate,
provider, deposit destination and refund destination before sending funds.
A quote error must identify the failed operation without exposing configuration
credentials. THORChain and native atomic swaps are not available in v0.3.

Tip Maker is a single composer with recipient, asset and amount. A funded tip is
not necessarily claimed. Sent Tips retains claim status and the available
clawback action. State changes must come from receipts or current backend data.

## Assets, grants and themes

The pure-data asset registry owns decimals, families and capabilities. Shared UI
uses those definitions and `visibleAssetIds` rather than repeating asset lists.
Hiding an asset changes its visibility, not its keys or on-chain funds. Backend
capabilities also gate availability; an absent advertisement never enables a
feature by inference.

Dapp grants are scoped to the verified origin and requested assets or operation.
Show the real origin prominently, separately from page-supplied names. Existing
grants may permit an operation without a fresh approval screen, but never bypass
a user's enabled operation-password policy.

Themes supply CSS tokens and optional theme styles. Keep balances, errors and
confirmation controls legible across themes. Layout must work in a narrow
extension popup and a desktop window. Mobile, Ethereum and Safari are future
release work; native atomic swaps follow later.

## Voice

Use precise, short sentences and familiar terms. Explain what happened and the
next available action. Avoid hype, absolute privacy claims, unnecessary jargon,
em dashes and promises about confirmation time. Use "we" for the product team;
use "you" for a user's deliberate action. Humor is optional and never belongs in
a loss, signing, recovery or error message.

Examples: "Get quote", "Review send", "USD estimate unavailable", and
"The wallet locked before signing. Unlock it to continue."

## Review checklist

- [ ] Entry context and persisted drafts survive navigation correctly.
- [ ] Display estimates cannot alter signed integer amounts.
- [ ] Unknown data, pending operations and confirmed results are distinct.
- [ ] Unlock preferences and optional password checks behave independently.
- [ ] The selected identity and verified origin remain visible and binding.
- [ ] Feature availability follows registry and backend evidence.
- [ ] Copy describes implemented behavior and its actual privacy boundary.
- [ ] Narrow layouts, themes, keyboard use and error recovery are checked.
