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
    it yourself. To show a Monero, Wownero or Grin balance without downloading
    the whole chain, the wallet hands that server a view-only key: it can see
    payments coming in, it can never spend. Your seed and your spend keys stay
    on your device either way, so no server can move your money.

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
| `storage` | Stores the password-encrypted seed, wallet settings and per-site permission grants locally. The seed and the spend keys derived from it never leave the device, and neither do the permission grants; what the wallet does send to a backend is listed under Data disclosures below. |
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

A light wallet is not a zero-transmission extension, and answering as if it were
is a false declaration. Smirk does not custody funds and cannot spend them, but
it does send chain-lookup data to a Smirk backend, because that is how a light
wallet gets a balance without downloading the chain. Declare that plainly.
Reviewers compare these answers against the code, so each one below cites the
call that justifies it.

Tick these data types:

- **Financial and payment information** (`packages/core/src/api/wallet-lws.ts`,
  `wallet-utxo.ts`, `grin.ts`). To show balances and build transactions the
  wallet sends, per asset: the user's own public receive address; for
  Monero/Wownero, the account's private VIEW key; for Grin, a `rewind_hash`
  view credential. The backend runs the light-wallet servers that scan the chain
  with those credentials and return balance, transaction history and unspent
  outputs. It also sends already-signed transaction bytes for broadcast. A view
  key and a `rewind_hash` are read-only by construction: they reveal incoming
  transactions, they cannot authorize a spend.
- **Authentication information** (same files, plus
  `packages/core/src/api/auth.ts`). The Monero/Wownero view key and the Grin
  `rewind_hash` are credentials, so declare them here as well rather than
  arguing about which box they belong in. The wallet also holds a backend
  session token, and authenticates requests by signing them with a key that
  never leaves the device.
- **Personally identifiable information** (`packages/core/src/api/auth.ts`,
  `social.ts`). On first run the wallet registers a one-way SHA-256 **seed
  fingerprint** plus the per-chain **public** keys, which is what lets someone
  send the user a tip. Claiming a handle publishes a `name@domain` NIP-05
  address, and linking Telegram/Discord stores that link. The handle and the
  Nostr identity are public by design; the user chooses whether to have them.
- **Personal communications** (Nostr features). Nostr direct messages are
  end-to-end encrypted on the device and relayed as ciphertext; Feed posts are
  public by design. The wallet transmits both, so declare it.

Do NOT tick these, and the code backs that up:

- Health information: never touched.
- Location: no geolocation API, no location lookup. The backend sees request IPs
  as any server does and stores them only as a salted one-way hash for
  rate-limiting.
- Web history and user activity: the content script announces the wallet and
  relays only messages a page explicitly sends it. Per-site permission grants
  stay in local `storage`; no browsing data, page content or site list is
  transmitted.

Certifications, all three of which we can sign:

- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the single purpose.
  Everything above is used only to look up chain data for the user's own wallet,
  route tips to them, and deliver messages they chose to send.
- Not being used or transferred to determine creditworthiness or for lending.

What never leaves the device, and say so in the same breath so the disclosure
does not read as worse than it is: the seed phrase, every private SPEND key, the
Nostr secret key and the encryption password. All signing happens locally.
Nobody holding what the backend receives can move the user's funds. The backend
is open source and self-hostable, so a user who does not want to send this to us
can point the wallet at their own server (see the "RUN YOUR OWN SERVER"
paragraph in the detailed description).

Single purpose statement:

    Smirk is a cryptocurrency wallet. It stores the user's keys locally, shows
    balances, sends and receives payments, and lets websites request payments
    and signatures with the user's explicit approval.

### Firefox: `data_collection_permissions`

AMO asks the same question in the manifest rather than in a web form, so
`manifest.firefox.json` carries the same answer in Mozilla's vocabulary. The two
must never disagree:

    "data_collection_permissions": {
      "required": [
        "financialAndPaymentInfo",
        "authenticationInfo",
        "personallyIdentifyingInfo",
        "personalCommunications"
      ]
    }

One entry per ticked bullet above, in the same order. `"none"` is only for an
extension that transmits nothing, which a light wallet is not, and Mozilla
requires the key on new submissions. `technicalAndInteraction` is deliberately
absent: Mozilla accepts it only in `optional`, and everything listed above is
required for the wallet to function, so there is nothing here a user could
decline and still have working balances. The seed fingerprint is therefore
declared under `personallyIdentifyingInfo`, the stricter of the two readings.

## AMO: source code submission

AMO requires a source upload whenever the submitted files are minified or
bundled, which ours are. The reviewer has to rebuild `dist/` from that archive,
so the instructions must cover the Rust/WASM toolchain too, not just npm. The
archive is `git archive HEAD`, `crates/smirk-wasm/pkg/` is gitignored and so is
absent from it, and `@smirk/wasm`'s own `build` script is only `tsc`: the
compiled bundle comes from the root `Makefile`'s `wasm` target, which needs
cargo. A reviewer handed npm-only steps gets `[copy-monorepo-assets] WASM bundle
missing` from the vite plugin and the review stalls. Include a `README.md` at
the root of the source archive:

    Build environment
      Linux x86_64 (macOS arm64 also reproduces)
      Node 22.x (the workspace `engines` field requires >=20), npm as shipped
        with that Node release
      GNU make
      Rust 1.95.0 via rustup, with the wasm32-unknown-unknown target
      wasm-bindgen CLI 0.2.121, which MUST match the version in Cargo.lock

    Toolchain setup
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
      rustup toolchain install 1.95.0
      rustup default 1.95.0
      rustup target add wasm32-unknown-unknown
      cargo install wasm-bindgen-cli --version 0.2.121

    Build
      unzip smirk-wallet-source-v0.3.0.zip -d smirk
      cd smirk
      npm ci
      make ext-firefox

    `make ext-firefox` runs two steps and both are required, in this order.
    Run them by hand if you would rather not use make:

      1. make wasm, because crates/smirk-wasm/pkg/ is gitignored and is
         therefore NOT in this archive. It is exactly:

           RUSTFLAGS="--remap-path-prefix=$PWD=/smirk --remap-path-prefix=$HOME/.cargo=/cargo" \
             cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
           wasm-bindgen --target no-modules \
             --out-dir crates/smirk-wasm/pkg \
             target/wasm32-unknown-unknown/release/smirk_wasm.wasm
           node crates/smirk-wasm/postprocess.mjs

         The --remap-path-prefix flags keep the build directory and cargo home
         out of the binary, which is what makes the .wasm byte-identical no
         matter where it is built. The postprocess step replaces the
         require("env") C-import placeholders with no-ops and appends the ESM
         export, so it cannot be skipped.

      2. node scripts/build-workspaces.mjs firefox, which builds every
         workspace library in derived topological order and then runs
         build:firefox in @smirk/extension.

    Output
      packages/extension/dist/, which is what the submitted zip contains.

    Cargo.lock references two git sources (jwinterm/grin-wallet and
    mimblewimble/grin). They are DEV-ONLY cross-validation test deps of the
    grin-ext crate and are not compiled by this build: `cargo build -p
    smirk-wasm` resolves from crates.io plus the sibling path crates under
    crates/, which are all present in this archive, so nothing fetches them.

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
      (`node scripts/bump-version.mjs <semver> --check` exits 0 only when every
      shipped file, both manifests included, is already at that version)
- [ ] Tests and typecheck pass on the exact commit the zips were built from.
      There is no release-only build flag any more: `VITE_SMIRK_RELEASE` has no
      readers left in the source, so setting it changes nothing and its absence
      guards nothing
- [ ] The data disclosures above still match the code, and the Firefox
      `data_collection_permissions` list still matches those disclosures
- [ ] Screenshots captured against production, not a local backend
- [ ] Every caption describes what its own frame shows
- [ ] https://smirk.cash/privacy resolves
- [ ] AMO source archive rebuilds the submitted zip
