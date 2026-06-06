# @smirk/ui

Shared Preact components for the Smirk Wallet UI.

This package answers one question:

> What Preact components render the wallet's chrome and
> happy-path flows, identically across browser extension, desktop
> (Tauri), and mobile (Capacitor)?

Components are presentational — they take props and emit
callbacks. State, persistence, and platform integration belong
in the consuming shell. That keeps `@smirk/ui` free of `chrome.*`,
`window.__TAURI__`, or any other host-API entanglement.

## Layout

```
src/components/
├── HomeTab.tsx              # Asset list + actions
├── UnifiedBalance.tsx       # Header total + hide toggle
├── BalanceCard.tsx          # Per-asset row
├── SendWizard.tsx           # Compose / review / confirm
├── ReceiveScreen.tsx        # Address QR + share
├── SwapTab.tsx              # Aggregator routing
├── InboxTab.tsx             # Claimable + pending tips
├── AssetDetailScreen.tsx    # Per-asset history + price
├── OnboardingWizard.tsx     # First-run create/import
├── LockScreen.tsx           # Unlock prompt
├── ApprovalScreen.tsx       # Dapp-side approval window
├── TipMaker.tsx             # Send a social tip
├── GrinPayInvoiceWizard.tsx # Grin pay-by-invoice flow
└── browser/                 # Embedded-browser chrome
    ├── BrowserShell.tsx
    ├── BrowserTabStrip.tsx
    └── BrowserUrlBar.tsx
```

The `browser/` components compose against the
`DappBrowserController` abstraction from `@smirk/dapp-browser`.

## Accessibility

Components target WCAG 2.2 AA. The conventions and patterns live
in [docs/ACCESSIBILITY.md](../../docs/ACCESSIBILITY.md); the most
substantive in-component a11y notes live in the file header of
`BrowserShell.tsx`.

## Use

```ts
import { HomeTab, UnifiedBalance, BalanceCard } from '@smirk/ui';

<HomeTab
  balance={{ totalDisplay: '$2,134.27', denominationLabel: 'USD' }}
  actions={{ onTip, onSend, onReceive, onSwap }}
  assets={rows}
  resolveIcon={key => `/icons/${key}.svg`}
/>
```

## Testing

Static-render tests run via `node --test --import tsx` against
`preact-render-to-string`. Interactive tests are deferred to a
focused jsdom + `@testing-library/preact` pass.

```sh
npm test --workspace @smirk/ui
```

## License

MIT OR Apache-2.0.
