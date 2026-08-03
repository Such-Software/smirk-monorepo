import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import {
  createPublicTipPayload,
  generatePrivateKey,
  getPublicKey,
  btcAddress,
  generateUrlFragmentKey,
} from '@smirk/core';

/**
 * Feature: tips, claiming a PUBLIC (URL-shared) tip end to end.
 *
 * Drives the REAL in-extension claim entry point: Inbox → "+ Paste tip link"
 * (routes/inbox.tsx `PasteTipLinkScreen`, route `home/inbox/paste-tip`) →
 * paste a `https://smirk.cash/tip/<id>#<fragment>` URL → Claim. That runs the
 * REAL receiver pipeline (index.tsx onClaim → tip-claim-handler.ts
 * ::claimPublicTip): getPublicSocialTip → decrypt with the URL fragment key →
 * claimSocialTip → per-asset on-chain sweep → confirmTipSweep.
 *
 * BTC is chosen so the sweep is a pure-JS P2WPKH sweep (@scure/btc-signer) the
 * harness can exercise without WASM: fetch UTXOs at the tip address → build →
 * sign with the decrypted tip key → broadcast.
 *
 * ─── Real crypto, stubbed network ───
 * The claim's decryption is NOT stubbable: claimPublicTip really decrypts the
 * backend `encrypted_key` with the fragment key from after the URL '#'. So we
 * MINT a genuine public-tip payload here with the SAME @smirk/core the
 * extension bundles: a fresh tip BTC key → `createPublicTipPayload(tipKey,
 * fragmentKey)` is the ciphertext the stub serves, and the fragment goes in the
 * share URL. The extension's `decryptPublicTipPayload` inverts it to recover
 * the tip key, which then signs the sweep. Everything ELSE is stubbed at the
 * network layer so nothing hits a live Electrum/node and no real sats move:
 *   - GET  /tips/social/:id/public   → a claimable public BTC tip
 *   - POST /tips/social/:id/claim    → returns the same encrypted_key + address
 *   - POST /wallet/utxo/{utxos,fee,broadcast} → the sweep tx build + broadcast
 *   - POST /tips/social/:id/confirm-sweep → settles claiming → claimed
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

// Deterministic stand-ins the stubbed backend hands back.
const TIP_ID = '22222222-3333-4444-8555-666666666666';
const TIP_AMOUNT_SAT = 50_000; // 0.0005 BTC: what the claim success screen shows.
// A confirmed UTXO sitting at the tip address. Segwit (P2WPKH) signing needs
// only txid/vout/value (no prev-tx), so a fabricated outpoint signs + the
// sweep tx builds without a live node.
const TIP_UTXO = { txid: 'c'.repeat(64), vout: 0, value: 200_000, height: 800_000 };
const SWEEP_TXID = 'd'.repeat(64);

// --- Mint a genuine public-tip payload (real crypto; see header). ---
// A fresh single-use tip key (what the sender would have generated), encrypted
// under a random URL fragment key. `btcAddress(pub)` is the on-chain tip
// address the sweep drains.
const tipPrivKey = generatePrivateKey();
const tipPubKey = getPublicKey(tipPrivKey, true);
const TIP_ADDRESS = btcAddress(tipPubKey);
const fragment = generateUrlFragmentKey();
const ENCRYPTED_KEY = createPublicTipPayload(tipPrivKey, fragment.bytes);
const SHARE_URL = `https://smirk.cash/tip/${TIP_ID}#${fragment.encoded}`;

test('paste a public BTC tip link → claim → swept success screen', async ({
  context,
  extensionId,
  footage,
}) => {
  // --- Stub the claim + sweep network surface (context-level). ---
  await context.route('**/api/v1/tips/social/*/public', async (route) => {
    // Unauthenticated public-tip lookup: a claimable, past-the-gate BTC tip.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TIP_ID,
        asset: 'btc',
        amount: TIP_AMOUNT_SAT,
        status: 'pending',
        created_at: new Date().toISOString(),
        is_public: true,
        encrypted_key: ENCRYPTED_KEY,
        tip_address: TIP_ADDRESS,
        funding_confirmations: 3,
        confirmations_required: 1,
        is_claimable: true,
      }),
    });
  });
  await context.route('**/api/v1/tips/social/*/claim', async (route) => {
    // Backend flips pending → claiming and echoes the encrypted key + address.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        encrypted_key: ENCRYPTED_KEY,
        tip_address: TIP_ADDRESS,
      }),
    });
  });
  await context.route('**/api/v1/tips/social/*/confirm-sweep', async (route) => {
    // Settle claiming → claimed. sweep_txid:null ⇒ no race-loss branch (a
    // non-null value !== our broadcast txid would render "claimed by someone
    // else"); null is the clean first-wins settle.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sweep_txid: null, status: 'claimed' }),
    });
  });
  // Sweep tx build + broadcast (the tip address' UTXOs → alice's BTC address).
  await context.route('**/api/v1/wallet/utxo/utxos', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ utxos: [TIP_UTXO] }),
    });
  });
  await context.route('**/api/v1/wallet/utxo/fee', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset: 'btc', fast: 8, normal: 5, slow: 2 }),
    });
  });
  await context.route('**/api/v1/wallet/utxo/broadcast', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ txid: SWEEP_TXID }),
    });
  });
  // Grin balance scan is irrelevant to a BTC claim, but the unstubbed local
  // scan 503s and its retries drag out the claimer's initial balance settle
  // (which is what populates session.bootstrap.userId; see the retry note
  // below). Stub it empty so bootstrap lands sooner and deterministically.
  await context.route('**/api/v1/wallet/grin/scan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ outputs: [], total_balance: 0, last_pmmr_index: 0 }),
    });
  });

  const page = await context.newPage();
  // Import alice: she's the CLAIMER. Needs an unlocked wallet (BTC key to
  // decrypt with + a BTC receive address to sweep into) and a bootstrapped
  // session (userId), both of which importAndUnlock establishes.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  // --- Navigate to the paste-tip-link claim screen ---
  await page.getByTestId('nav-tab-inbox').click();
  await expect(page.getByTestId('inbox-tab')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('inbox-paste-tip-link-btn').click();

  const input = page.getByTestId('paste-tip-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(SHARE_URL);

  // The claim requires the claimer's `session.bootstrap.userId`, which only
  // lands once the initial balance fetch (gated on the tunneled XMR/WOW LWS)
  // completes, a few tens of seconds after Home first paints, and AFTER
  // importAndUnlock returns (that only waits for the WOW balance to render).
  // The popup exposes no post-bootstrap UI signal (the header refresh control
  // is an unwired prop), so we poll by attempting the claim: before bootstrap
  // it returns a synchronous "wallet not bootstrapped" error WITHOUT any state
  // mutation and re-enables the button; once bootstrapped the same click
  // decrypts, sweeps, and reaches the success screen.
  const claim = page.getByTestId('paste-tip-claim-btn');
  await expect(async () => {
    if ((await page.getByTestId('paste-tip-success').count()) > 0) return;
    await expect(claim).toBeEnabled();
    await claim.click();
    await expect(page.getByTestId('paste-tip-success')).toBeVisible({ timeout: 6_000 });
  }).toPass({ timeout: 80_000, intervals: [2_000, 3_000, 3_000] });

  // --- Meaningful outcome: the claim reached its swept success state ---
  await expect(page.getByTestId('paste-tip-success')).toBeVisible();
  // The success card echoes the swept asset + amount (0.0005 BTC).
  await expect(page.getByTestId('paste-tip-success')).toContainText('BTC');
  await expect(page.getByTestId('paste-tip-success')).toContainText('0.0005');
  // No error surfaced on the way (decrypt + sweep + confirm all succeeded).
  await expect(page.getByTestId('paste-tip-error')).toHaveCount(0);
  // The "back to inbox" affordance is present → we're on the terminal screen.
  await expect(page.getByTestId('paste-tip-done-btn')).toBeVisible();
  footage.mark('tip-claimed', 'public BTC tip claimed and swept');
});
