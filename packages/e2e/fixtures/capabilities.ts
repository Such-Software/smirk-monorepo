import { BACKEND_URL } from './extension.js';

/**
 * Shape of GET /capabilities (smirk-backend-core `src/api/capabilities.rs`).
 * Only the fields the suite branches on are typed narrowly; the rest are kept
 * loose so a contract bump doesn't break compilation.
 */
export interface Capabilities {
  version: string;
  contract_version: number;
  chains: Record<string, { enabled: boolean; network: string | null }>;
  features: {
    grin_relay: boolean;
    prices: boolean;
    nostr_identity: boolean;
    tips: boolean;
  };
  restore: {
    policy: 'create-only' | 'restore-allowed' | string;
    max_depth_days: number | null;
    pow_free_days: number;
    pow_days_per_bit: number;
    pow_max_bits: number;
  };
  registration: {
    invite_required: boolean;
    pow_required: boolean;
    payment_required: boolean;
    payment_amount: string | null;
    payment_currency: string | null;
  };
}

let cached: Capabilities | undefined;

/**
 * Fetch (and cache) the running backend's /capabilities so a spec can self-skip
 * when the instance's OPERATOR CONFIG doesn't match its precondition — e.g. the
 * pay-to-register scenario needs the payment gate ON, while a full create-new-
 * wallet needs it OFF. One suite run then adapts to whatever backend is up
 * instead of hard-coding a config assumption (and silently red/greening on it).
 *
 * Runs in the Node test process (not the extension), so it hits the backend
 * directly over global fetch.
 */
export async function getCapabilities(): Promise<Capabilities> {
  if (cached) return cached;
  const res = await fetch(`${BACKEND_URL}/capabilities`);
  if (!res.ok) {
    throw new Error(`GET ${BACKEND_URL}/capabilities → ${res.status}`);
  }
  cached = (await res.json()) as Capabilities;
  return cached;
}
