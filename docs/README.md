# Smirk documentation

> Status: stable · Updated 2026-09-27 · Applies to: Smirk v0.3 client source

## Build and release

- [Build clients and collect source-bound candidates](BUILD.md)
- [Run unit, interoperability and release integration checks](TESTING.md)
- [Package and submit the extension](../packages/extension/RELEASE.md)
- [Desktop release requirements](../packages/desktop/RELEASE.md)
- [Store copy and disclosures](../packages/extension/store/LISTING.md)

## Use and integrate

- [Send, receive and recover chain transactions](SEND_FLOW.md)
- [Integrate a dapp](DAPP_INTEGRATION.md) and [API package reference](../packages/dapp-api/README.md)
- [Interaction and copy principles](UI_DESIGN.md)
- [Accessibility requirements](ACCESSIBILITY.md)
- [Privacy and light-wallet data boundaries](../PRIVACY.md)

## Understand and extend

- [Architecture and unlocked-session lifetime](ARCHITECTURE.md)
- [Developer and repository guide](../MONOREPO.md)
- [Asset registry and per-family adapters](MULTI_ASSET_ARCHITECTURE.md)
- [Embedded browser boundaries](EMBEDDED_BROWSER.md)
- [Monero and Wownero](monero-wownero.md), [Grin](grin.md), and [future atomic swaps](swap-core.md)
- [Core state, key and identity APIs](../packages/core/README.md)
- [Shared UI](../packages/ui/README.md), [Trocador swaps](../packages/swap/README.md), and [WASM bindings](../packages/wasm/README.md)

## Feature owners

| Surface | Behavior owner | Implementation |
| --- | --- | --- |
| Create/import, unlock, lock and grace period | [Architecture](ARCHITECTURE.md#wallet-unlock-lifetime) | core keystore; extension session cache/lock |
| Send, receive, estimates, tips and Grin exchange | [Send flow](SEND_FLOW.md) | shared UI and extension send/tip handlers |
| Optional send/sign password confirmation | [UI principles](UI_DESIGN.md#unlock-and-operation-confirmation) | extension operation-auth policy and gates |
| Backend selection and capability gating | [Architecture](ARCHITECTURE.md#backend-federation) | backend boot, core API and capability registry |
| Nostr identities, Feed, encrypted messages and app crypto | [Core package](../packages/core/README.md) and [dapp integration](DAPP_INTEGRATION.md) | core Nostr/messaging; extension routes |
| Per-origin website permissions | [Dapp API](../packages/dapp-api/README.md) | shared handler and platform approval executors |
| Swaps | [Swap package](../packages/swap/README.md) | Trocador implementation and native desktop transport |
| Themes and asset visibility | [UI principles](UI_DESIGN.md) | shared theme/asset registries |

The backend runtime belongs to the separate `smirk-backend-core` repository.
Infrastructure and production operations belong to Fleet. Private release
receipts, operational state and strategy belong in the journal. These client
docs describe source behavior; they do not establish production deployment.

## Documentation checklist

- [ ] Each changed behavior has one owner and an implementation reference.
- [ ] Build, verification and failure paths are documented.
- [ ] Implemented, planned and deployed status remain distinct.
- [ ] Generated references come from their source definitions.
- [ ] Private evidence and all credential values are absent.
