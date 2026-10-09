# Privacy Policy

> Status: stable · Updated 2026-10-09 · Applies to: Smirk client source

The canonical Smirk privacy policy lives at **https://smirk.cash/privacy** and is
the authoritative version (it is what the browser-store listings link to).

## Client data boundary

Smirk is **non-custodial**: your seed phrase and private spend keys are generated
and stored on your device and are never transmitted to any backend. What the
backend does receive, to power balances and optional features:

- **Monero/Wownero view keys**, sent together with the matching **public
  address**, so the light-wallet-server can scan the chain for your incoming
  funds and return your balance, history and spendable outputs (a view key can
  read your incoming transactions but cannot spend).
- A **Grin `rewind_hash`**, a view-only credential derived from your public root
  key, so the Grin light-wallet-server can rewind the UTXO set and return your
  outputs. It can read but never spend. Scanning **registers** it with the Grin
  light-wallet-server, which retains it and keeps scanning new blocks against it
  so later scans are fast; it stays on that server until the operator removes it.
- **Public addresses** (BTC/LTC) to look up balances via Electrum/Fulcrum, and
  **signed transaction bytes** to broadcast. Recipient address and amount are not
  separately submitted by the client, but are encoded in BTC/LTC transaction
  outputs and readable by the broadcaster and chain observers.
- A one-way **seed fingerprint** (SHA-256) as a stable, non-reversible identifier.
- An **optional** Nostr identity + a `name@domain` handle on whichever instance
  you use (public by design) and
  **optional** end-to-end encrypted messaging. Message content is encrypted;
  relays still see routing metadata, recipient public keys and connection IPs.
  Feed posts and published Nostr profiles are public.
- The backend sees the source IP of a request. Its application rate-limit
  records use a keyed hash. Proxy, infrastructure and third-party retention
  policies are separate from that application behavior.
- **Tips to a Nostr identity** travel as NIP-17 gift wraps on Nostr relays. The
  key that claims the tip is sealed a second time between sender and recipient,
  so neither the relay nor a website you have granted Nostr access can read it,
  and the wallet refuses to decrypt its own tip messages for websites.

## Swaps and other third parties

Opening the Swap tab contacts no swap provider. Each provider is contacted only
after you choose it, and directly from your device unless stated otherwise, so
it sees your IP address.

- **Trocador** (`api.trocador.app`), when you choose it: the pair and amount for
  a quote, and your receive and refund addresses when you confirm. Your wallet
  server records the swap so its status can be followed.
- **THORChain**, through Liquify's public gateway (`gateway.liquify.com`), when
  you tap the THORChain card: a pool and vault lookup. A quote sends the pair
  and amount; confirming sends your receive address and, for a Monero deposit,
  your refund address; status checks send the deposit's transaction id. This
  does not pass through your wallet server. The swap instruction, including
  those addresses, is also written into the deposit transaction itself.
- **NonLogs**, only when your wallet server offers it: the pair, amount, payout
  address and refund address pass through your wallet server to NonLogs, which
  keeps them under the server operator's NonLogs account. Your IP address does
  not reach NonLogs. The server keeps a record linking your account to the swap
  for 90 days, without addresses or amounts.
- **Neroswap** (`neroswap.com`) price lookups for WOW and GRIN, only when you tap
  for live prices.
- **The old Smirk server** (`backend.smirk.cash`), only when you tap to find tips
  sent to a v0.2 wallet: the wallet signs in there with your pre-v0.3 BTC key,
  which creates an empty account there if that key never had one.

See the full policy for the complete list, third parties, and your GDPR/CCPA rights.

## Self-hosting

The backend is open source and self-hostable. If you run your own instance (or use
another operator's), the backend data described in the policy goes to **that**
server, not to Such Software. Each operator is an independent data controller for
their own instance.

## Maintenance checklist

- [ ] Behavior and commands match the current source.
- [ ] Verification and failure conditions are described.
- [ ] Planned work is distinguished from available features.
- [ ] No private operational evidence or credential values are included.
