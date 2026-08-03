# @smirk/ui

Shared Preact components for the Smirk Wallet UI.

This package answers one question:

> What Preact components render the wallet's chrome and
> happy-path flows, identically across browser extension, desktop
> (Tauri), and mobile (Capacitor)?

Screen components are presentational: they take props and emit
callbacks. The shell components (`AppShell`, `BottomNav`) read routing
state from the `StateProvider` hooks instead, so render them inside a
provider. The store and router are still injected by the consuming
shell, which keeps `@smirk/ui` free of persistence, `chrome.*`,
`window.__TAURI__`, or any other host-API entanglement.

## Layout

```
src/components/
├── ActionButton.tsx           # Home verb tile (Tip / Send / Swap / Claim)
├── ApprovalScreen.tsx         # Dapp-side approval window
├── AssetDetailScreen.tsx      # Per-asset history + price
├── AssetIcon.tsx              # Chain logo; host resolves the image path
├── BackendPicker.tsx          # Which smirk-backend the wallet talks to
├── BalanceCard.tsx            # Per-asset row
├── Button.tsx                 # Full-width primary / secondary CTA
├── ClaimableTipsBanner.tsx    # Home notice: tips ready to sweep in
├── FreshnessCue.tsx           # "Are these balances live?" indicator
├── GrinPasteIncomingWizard.tsx # Receiver side of an inbound S1 slate
├── GrinPayInvoiceWizard.tsx   # Grin pay-by-invoice flow
├── GrinRequestWizard.tsx      # Receiver-initiated Grin invoice (I1/I2/I3)
├── HomeTab.tsx                # Asset list + actions
├── IdentityPicker.tsx         # Which Nostr identity to act as
├── InboxTab.tsx               # Claimable + pending tips
├── LockScreen.tsx             # Unlock prompt
├── MigrationWizard.tsx        # v0.2 wallet upgrade to v0.3
├── OnboardingWizard.tsx       # First-run create/import
├── ReadyToShareTipsBanner.tsx # Home notice: sent tip is safe to share
├── ReceiveScreen.tsx          # Address QR + share
├── RevealKeysPanel.tsx        # Seed-derived identifiers behind a reveal gate
├── SendWizard.tsx             # Compose / review / confirm
├── SentTipsScreen.tsx         # Sent tips + clawback
├── SwapTab.tsx                # Aggregator routing
├── TipMaker.tsx               # Send a social tip
├── UnifiedBalance.tsx         # Header total + hide toggle
├── browser/                   # Embedded-browser chrome
│   ├── BrowserShell.tsx
│   ├── BrowserTabStrip.tsx
│   ├── BrowserUrlBar.tsx
│   └── IframeBrowserContent.tsx
└── shell/                     # App chrome
    ├── AppShell.tsx           # Header + scrollable body + nav
    └── BottomNav.tsx          # Four-tab nav (bottom bar / sidebar)
```

The `browser/` components compose against the
`DappBrowserController` abstraction from `@smirk/dapp-browser`.

## Accessibility

Components target WCAG 2.2 AA. The conventions and patterns live
in [docs/ACCESSIBILITY.md](../../docs/ACCESSIBILITY.md); the most
substantive in-component a11y notes live in the file header of
`BrowserShell.tsx`.

## Use

```tsx
import { HomeTab, UnifiedBalance, BalanceCard } from '@smirk/ui';

<HomeTab
  balance={{ totalDisplay: '$2,134.27', denominationLabel: 'USD', hidden, onToggleHidden }}
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
