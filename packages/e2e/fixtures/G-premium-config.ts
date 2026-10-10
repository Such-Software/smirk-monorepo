/**
 * The G-premium lane's own settings, read once when the spec loads.
 *
 * Cheap guards run before expensive ones: a purchase that could pay anywhere
 * but the owner's pinned BTCPay host, or from the wallet the browsing
 * scenarios need unpaid, is refused here, before any wallet is imported. A
 * refusal names the setting at fault and never echoes a value.
 */

export type LaneWallet = 'alice' | 'bob' | 'carol';
const WALLETS: readonly LaneWallet[] = ['alice', 'bob', 'carol'];

export interface PremiumPurchase {
  /** The wallet that pays; it holds premium for a year afterwards. */
  wallet: LaneWallet;
  /** The owner's BTCPay host: the only place funds may go. */
  checkoutHost: string;
  /** Refuse a checkout asking more than this many LTC. */
  maxLtc: string;
  /** Refuse to buy a plan priced above this, in the backend's currency (USD). */
  maxPlanUsd: number;
  /** The owner's separate approval to publish one public note afterwards. */
  postApproved: boolean;
}

export interface PremiumLaneConfig {
  /** The wallet that mints and abandons invoices (scenarios 1 to 3). */
  browse: LaneWallet;
  /** When set, the checkout must open on exactly this host. Required to buy. */
  checkoutHost: string | null;
  /** Null unless the real purchase is flagged on. */
  purchase: PremiumPurchase | null;
}

function wallet(value: string | undefined, fallback: LaneWallet, setting: string): LaneWallet {
  const name = (value ?? '').trim() || fallback;
  if (!(WALLETS as readonly string[]).includes(name)) throw new Error(`${setting} must be alice, bob or carol.`);
  return name as LaneWallet;
}

/** A bare host name, optionally with a port: no scheme, path, credentials or spaces. */
function host(value: string | undefined, setting: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i.test(raw)) {
    throw new Error(`${setting} must be a bare host name, such as pay.example.org, with no scheme or path.`);
  }
  return raw.toLowerCase();
}

export function premiumLaneConfig(env: Record<string, string | undefined>, backendUrl: string): PremiumLaneConfig {
  const browse = wallet(env.G_PREMIUM_BROWSE_WALLET, 'carol', 'G_PREMIUM_BROWSE_WALLET');
  const checkoutHost = host(env.G_PREMIUM_CHECKOUT_HOST, 'G_PREMIUM_CHECKOUT_HOST');
  const backendHost = new URL(backendUrl).host.toLowerCase();
  if (checkoutHost && checkoutHost === backendHost) {
    throw new Error('G_PREMIUM_CHECKOUT_HOST names the wallet backend, not a BTCPay checkout.');
  }
  const money = env.E2E_LIVE_MONEY === '1';
  const buy = env.E2E_PREMIUM_PURCHASE === '1';
  const post = env.E2E_PREMIUM_POST === '1';
  if (!(money && buy)) {
    if (buy || post) throw new Error('E2E_PREMIUM_PURCHASE and E2E_PREMIUM_POST need E2E_LIVE_MONEY=1 and E2E_PREMIUM_PURCHASE=1 together.');
    return { browse, checkoutHost, purchase: null };
  }
  const payer = wallet(env.G_PREMIUM_PURCHASE_WALLET, 'alice', 'G_PREMIUM_PURCHASE_WALLET');
  if (payer === browse) {
    throw new Error('G_PREMIUM_PURCHASE_WALLET must differ from G_PREMIUM_BROWSE_WALLET: a wallet with premium has no purchase screen to browse.');
  }
  if (!checkoutHost) {
    throw new Error('A real purchase needs G_PREMIUM_CHECKOUT_HOST, the owner BTCPay host; without it the lane would pay any checkout the backend names.');
  }
  const maxLtc = (env.G_PREMIUM_MAX_LTC ?? '0.12').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(maxLtc) || Number(maxLtc) <= 0) throw new Error('G_PREMIUM_MAX_LTC must be a positive LTC amount with at most 8 decimals.');
  const maxPlanUsd = Number((env.G_PREMIUM_MAX_USD ?? '5').trim());
  if (!Number.isFinite(maxPlanUsd) || maxPlanUsd <= 0) throw new Error('G_PREMIUM_MAX_USD must be a positive number.');
  return { browse, checkoutHost, purchase: { wallet: payer, checkoutHost, maxLtc, maxPlanUsd, postApproved: post } };
}

/**
 * The config for a spec at load time. The suite's private reporter withholds
 * error text, so a refusal is also written to stderr: it is a static sentence
 * that names a setting, never its value.
 */
export function loadPremiumLaneConfig(env: Record<string, string | undefined>, backendUrl: string): PremiumLaneConfig {
  try {
    return premiumLaneConfig(env, backendUrl);
  } catch (error) {
    process.stderr.write(`G-premium refused before any wallet work: ${(error as Error).message}\n`);
    throw error;
  }
}
