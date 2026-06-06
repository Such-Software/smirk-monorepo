# @smirk/swap

Swap orchestration layer for Smirk Wallet.

This package answers one question:

> How does the wallet swap asset A for asset B without the UI
> having to know whether it's going through an aggregator (today)
> or a native peer-to-peer adaptor-signature flow (later)?

The UI talks to a `Swap`. The `Swap` decides whether to drive an
aggregator round-trip or, in v0.4+, an end-to-end cryptographic
exchange.

## Implementations

| Implementation | Kind         | Status                                            |
|----------------|--------------|---------------------------------------------------|
| `ThorchainSwap`| aggregator   | quote / start / status — implementation in flight |
| `TrocadorSwap` | aggregator   | quote / start / status against trocador.app       |
| `NativeSwap`   | adaptor sigs | planned v0.4 (Grin ↔ BTC/LTC, WOW ↔ XMR)          |

Aggregator implementations call out to a third-party service for
the route + escrow address. Native implementations will run the
crypto in-wallet via `swap-core` (Rust) exposed through
`@smirk/wasm`.

## Use

```ts
import { ThorchainSwap } from '@smirk/swap';

const swap = new ThorchainSwap();
if (swap.supports('btc', 'ltc')) {
  const quote = await swap.quote({
    fromAsset: 'btc',
    toAsset: 'ltc',
    fromAmount: '100000',          // atomic units (sats)
    toAddress: 'ltc1q...',
  });
  const started = await swap.start({ quote, toAddress: 'ltc1q...' });
  // Wallet sends `quote.fromAmount` to `started.depositAddress`,
  // then polls `swap.status(started.id)` until terminal state.
}
```

## Add a new aggregator

1. Implement the `Swap` interface from `src/types.ts`.
2. Declare your supported pairs from `supports(from, to)`.
3. Return shaped data from `quote`, `start`, `status`. The errors
   you throw should be `SwapError` instances so the UI surfaces
   them consistently.

## License

MIT OR Apache-2.0.
