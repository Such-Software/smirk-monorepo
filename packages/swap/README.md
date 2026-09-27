# @smirk/swap

> Status: stable · Updated 2026-09-27 · Applies to: Smirk client source

Swap orchestration layer for Smirk Wallet.

The shared swap interface separates quote and trade lifecycle from the UI.
Trocador is the implemented provider; native peer-to-peer swaps are future work.

The UI talks to a `Swap`. The `Swap` decides whether to drive an
aggregator round-trip or, in a future release, an end-to-end cryptographic
exchange.

## Implementations

| Implementation | Kind         | Status                                            |
|----------------|--------------|---------------------------------------------------|
| `ThorchainSwap`| aggregator   | stub: `supports()` only; every call throws `not_implemented` |
| `TrocadorSwap` | aggregator   | quote / start / status against trocador.app       |
| `NativeSwap`   | adaptor sigs | not implemented; no release commitment |

Aggregator implementations call out to a third-party service for
the route + escrow address. Native implementations will run the
crypto in-wallet via `swap-core` (Rust) exposed through
`@smirk/wasm`.

## Use

```ts
import { TrocadorSwap } from '@smirk/swap';

const swap = new TrocadorSwap({ apiKey: TROCADOR_API_KEY });
if (swap.supports('btc', 'ltc')) {
  const quote = await swap.quote({
    fromAsset: 'btc',
    toAsset: 'ltc',
    fromAmount: '100000',          // atomic units (sats)
  });
  // `start` needs both: where the output lands, and where the
  // provider returns funds if the trade fails.
  const started = await swap.start({
    quote,
    toAddress: 'ltc1q...',
    refundAddress: 'bc1q...',
  });
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

## Maintenance checklist

- [ ] Behavior and commands match the current source.
- [ ] Verification and failure conditions are described.
- [ ] Planned work is distinguished from available features.
- [ ] No private operational evidence or credential values are included.
