# Store listings: Smirk Wallet v0.3.0

Source of truth for what goes in the Chrome Web Store and addons.mozilla.org
listings. Edit here, paste from here, so the two stores cannot drift apart.

Screenshots are generated, not hand-made:

```
MARKETING_SHOTS=1 BACKEND_URL=https://api.smirk.cash/api/v1 \
  npx playwright test tests/marketing-shots.spec.ts        # popup shape
node scripts/make-store-shots.mjs                          # composite
```

Both from `packages/e2e`. Capture against PRODUCTION: a listing showing
`http://127.0.0.1:8080` on the backend screen is not shippable. Finished
canvases land in `~/Build/smirk-marketing/store/chrome/` at the required
1280x800.

Captions live in `CAPTIONS` in `make-store-shots.mjs` and must describe what is
visible in their own frame. Three of them once did not, and a caption a reader
disproves by looking at the picture is worse than no caption.

## Name

    Smirk Wallet

45 char limit on Chrome. Fine.

## Short description / summary

131 chars, inside Chrome's 132 limit and Mozilla's 250. Kept identical to the
`description` field in `manifest.json` and `manifest.firefox.json`, because
Chrome reads the listing summary from the manifest on first upload and a
mismatch is confusing later.

    Non-custodial Bitcoin, Litecoin, Monero, Wownero and Grin wallet with a
    built-in Nostr identity. Your keys never leave your device.

This replaced "Non-custodial multi-currency tip wallet for Telegram, Discord,
and more", which described v0.2.x. Tipping is still in the product; it is no
longer the whole of it.

## Detailed description

    Smirk is a non-custodial wallet for five chains, with a Nostr identity built
    in.

    Bitcoin, Litecoin, Monero, Wownero and Grin, in one extension, with a live
    fiat total across all of them.

    YOUR KEYS, YOUR COINS
    Your seed is generated on your device, encrypted with your password, and
    never sent anywhere. There is no signup, no email, no KYC and no account to
    freeze. Smirk cannot move your funds, and neither can anyone who runs a
    Smirk server.

    A NOSTR IDENTITY FROM THE SAME SEED
    Your Nostr key is derived from your wallet seed, so your identity travels
    with your backup. Keep separate burner identities for things you do not want
    linked, or import an nsec you already have. Send and receive end-to-end
    encrypted messages, and get paid over Nostr.

    WORKS WITH WEB APPS
    Smirk exposes a wallet API to sites that ask for it, so a web app can request
    a payment or a signature. Every request shows you exactly what you are
    approving before anything is signed, and a site gets access only after you
    grant it.

    RUN YOUR OWN SERVER
    Smirk talks to a backend for chain data. The default is ours; the wallet
    lets you point it at your own, and the server is open source so you can run
    it yourself. It never sees your seed or your keys either way.

    OPEN SOURCE
    https://github.com/Such-Software/smirk-monorepo

Keep the CAPS headers. Neither store renders markdown, and they are the only
structure a plain-text field allows.

## Category

- Chrome: Productivity  (there is no wallet or finance category; every other
  wallet extension lands here)
- AMO: Privacy & Security

## Screenshots

Chrome takes 1280x800 or 640x400, up to 5. AMO has no fixed size and takes the
same files. Use these five, in order, because the first is the one shown in
search results:

1. `01-home-balances`     five chains, one wallet
2. `06-nostr-identity`    a Nostr identity from your seed
3. `05-inbox`             tips and encrypted messages
4. `07-self-host-backend` run your own backend
5. `04-swap`              swap between chains

`02-receive-xmr`, `03-send-btc` and `08-settings` are built too and are fine as
substitutes; five is the cap.

## Promo tiles (Chrome only)

Required only for the featured collections, but the store looks unfinished
without the small tile:

- small marquee 440x280
- marquee 1400x560

Not generated yet. They need artwork rather than screenshots, so they come from
`~/src/such-graphics`, not from this pipeline.

## Permission justifications

Chrome asks for these in the Privacy tab, one per permission, and rejects empty
ones. AMO reviewers read the same reasoning. Answer literally; both stores
compare the answer against the code.

| Permission | Justification |
| --- | --- |
| `storage` | Stores the password-encrypted seed, wallet settings and per-site permission grants locally. Nothing in it is transmitted. |
| `alarms` | Wakes the service worker on a schedule to refresh balances and to enforce the auto-lock timeout. MV3 service workers are killed when idle, so a timer alone cannot do this. |
| `notifications` | Notifies the user when a payment arrives or a site is waiting on an approval. |
| `offscreen` | The wallet's cryptography runs in an offscreen document. Key derivation and signing need a DOM-bearing context that MV3 service workers do not provide. |
| `clipboardRead` | Pastes an address, a Grin slatepack or a tip link, all of which are far too long to retype. |
| `clipboardWrite` | Copies the user's receive address or slatepack to the clipboard. |
| `<all_urls>` | See below. |

### `<all_urls>`

The one that gets extensions rejected, so answer it precisely:

    Smirk injects a wallet provider (window.smirk) into pages so that web apps
    can request payments and signatures, in the same way an Ethereum wallet
    injects a provider. A wallet cannot know in advance which sites a user will
    use, so the content script must be able to run on any http/https page.

    The content script only announces that a wallet is present and relays
    messages the page explicitly sends to it. It does not read page content, and
    it does not act on any site the user has not granted. No site gets an
    address, a balance, a signature or a payment without an explicit approval
    the user sees and confirms.

    Users who do not want this at all can turn the injection off entirely in
    Settings ("Disable window.smirk on websites").

That last sentence matters to reviewers, and it is true: the toggle is on the
Settings screen and visible in screenshot 08.

## Data disclosures (Chrome Privacy tab)

Answer as follows, all of which the code supports:

- Does not collect or use personally identifiable information
- Does not collect health, financial or payment information (the wallet holds
  the user's own keys locally; nothing is collected)
- Does not collect authentication information
- Does not collect personal communications, location, web history or user
  activity
- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the single purpose
- Not being used or transferred to determine creditworthiness or for lending

Single purpose statement:

    Smirk is a cryptocurrency wallet. It stores the user's keys locally, shows
    balances, sends and receives payments, and lets websites request payments
    and signatures with the user's explicit approval.

## AMO: source code submission

AMO requires a source upload whenever the submitted files are minified or
bundled, which ours are. Reviewers must be able to reproduce the exact `.zip`
byte for byte. Include a `README.md` at the root of the source archive:

    Build environment
      Node 22.x, npm 10.x, Linux

    Build
      npm ci
      node scripts/build-workspaces.mjs libs
      VITE_SMIRK_RELEASE=true npm run build:firefox -w @smirk/extension

    Output
      packages/extension/dist/, which is what the submitted zip contains.

Note that `build:firefox` is `vite build && cp manifest.firefox.json
dist/manifest.json`: it writes to the SAME `dist/` as `build:chrome` and only
swaps the manifest afterwards. So a tree where Chrome was built last contains a
Chrome manifest, and a reviewer following the steps above on a clean checkout
gets the Firefox one. Do not hand a reviewer a build script that runs both.

Verify that these instructions actually reproduce the artifact before attaching
them. An unreproducible source upload is the most common cause of an AMO review
stalling for weeks.

## Support and legal

Both stores require these and reject placeholders:

- Homepage: https://smirk.cash
- Support: https://github.com/Such-Software/smirk-monorepo/issues
- Privacy policy: https://smirk.cash/privacy  (must resolve BEFORE submitting;
  both stores fetch it)
- License: MIT

## Pre-submit checklist

- [ ] `manifest.json` and `manifest.firefox.json` versions match the git tag
- [ ] Both zips built with `VITE_SMIRK_RELEASE=true`
- [ ] Screenshots captured against production, not a local backend
- [ ] Every caption describes what its own frame shows
- [ ] https://smirk.cash/privacy resolves
- [ ] AMO source archive rebuilds the submitted zip
