# Privacy Policy

The canonical Smirk privacy policy lives at **https://smirk.cash/privacy** and is
the authoritative version (it is what the browser-store listings link to).

## In short

Smirk is **non-custodial**: your seed phrase and private spend keys are generated
and stored on your device and are never transmitted to any backend. What the
backend does receive, to power balances and optional features:

- **Monero/Wownero view keys**, so the light-wallet-server can scan the chain for
  your incoming funds (a view key cannot spend).
- **Public addresses** (BTC/LTC) to look up balances via Electrum/Fulcrum, and
  **signed transaction bytes** to broadcast. Recipient address and amount are not
  transmitted on broadcast.
- A one-way **seed fingerprint** (SHA-256) as a stable, non-reversible identifier.
- An **optional** Nostr identity + `name@smirk.cash` handle (public by design) and
  **optional** end-to-end encrypted messaging (relays see only ciphertext).
- IP addresses only as a **salted one-way hash**, for rate-limiting.

See the full policy for the complete list, third parties, and your GDPR/CCPA rights.

## Self-hosting

The backend is open source and self-hostable. If you run your own instance (or use
another operator's), the backend data described in the policy goes to **that**
server, not to Such Software. Each operator is an independent data controller for
their own instance.
