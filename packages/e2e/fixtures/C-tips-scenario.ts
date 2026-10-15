/**
 * C-tips scenario context shared by the live specs: what the backend under
 * test advertises, which recipient forms this run can address bob by, and the
 * operator's explicit acknowledgement of gaps the run cannot cover.
 *
 * Everything here is read lazily and cached per worker. A failed test restarts
 * the worker, so nothing a later test needs may live only in an earlier test's
 * module state: it is recomputed here, or read from the ledger.
 */
import { test } from '@playwright/test';
import { getCapabilities, type Capabilities } from './capabilities.js';
import { BACKEND_URL } from './extension.js';
import { FORGE_POW_BITS } from './nostr-forge.js';
import type { LiveWallet, TipLane } from './C-tips-live.js';
import { claimHandle, type TipAsset } from './C-tips-actions.js';
import { isLocalPublishRelay } from './relay-guard.js';

export const ASSETS: readonly TipAsset[] = ['btc', 'ltc', 'xmr', 'wow', 'grin'];

type Caps = Capabilities & {
  nip05_domain?: string;
  messaging?: { relay_url?: string; inbound_pow_bits?: number };
};

export async function liveCaps(): Promise<Caps> {
  return (await getCapabilities()) as Caps;
}

export async function disabledChains(): Promise<Set<TipAsset>> {
  const caps = await liveCaps();
  return new Set(ASSETS.filter((a) => !caps.chains[a]?.enabled));
}

/** The first-party relay the backend advertises for gift wraps, and its PoW floor. */
export async function relayInfo(): Promise<{ url: string | null; powBits: number }> {
  const caps = await liveCaps();
  return {
    url: caps.messaging?.relay_url ?? null,
    powBits: Math.max(FORGE_POW_BITS, caps.messaging?.inbound_pow_bits ?? 0),
  };
}

/** This instance's NIP-05 domain (what a bare username resolves on). */
export async function homeDomain(): Promise<string> {
  const caps = await liveCaps();
  return (caps.nip05_domain ?? new URL(BACKEND_URL).hostname.replace(/^api\./, '')).toLowerCase();
}

/** Resolve `name@domain` over NIP-05; null on any failure. */
export async function resolveNip05(address: string): Promise<string | null> {
  const [name, domain] = address.toLowerCase().split('@');
  if (!name || !domain) return null;
  try {
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { names?: Record<string, string> };
    return body.names?.[name]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Gaps the operator may acknowledge for a run that cannot cover them (E2E_LIVE_ACK_GAPS=a,b). */
export type Gap = 'federation';

function acknowledged(gap: Gap): boolean {
  return (process.env.E2E_LIVE_ACK_GAPS ?? '')
    .split(',')
    .map((g) => g.trim())
    .includes(gap);
}

/** A skip reason the live skip guard accepts as chosen (C-tips.live.config.ts lists the prefix). */
function gapReason(gap: Gap, what: string): string {
  return `acknowledged gap: ${gap}: ${what}`;
}

/**
 * A prerequisite this run lacks: skip with an "acknowledged gap" reason when the
 * operator acknowledged it (the live skip guard lists it as expected), else
 * fail with what to configure. Never a silent fallback.
 */
export function missing(gap: Gap, what: string): never {
  if (acknowledged(gap)) {
    test.skip(true, gapReason(gap, what));
  }
  throw new Error(`${what}. Configure it, or acknowledge the gap for this run with E2E_LIVE_ACK_GAPS=${gap}.`);
}

let bobHandleCache: Promise<string> | null = null;

/**
 * Bob's verified Smirk handle (`name@<home domain>`), proven over NIP-05 to
 * resolve to his active key. With none, the lane claims one only on the
 * operator's explicit E2E_CLAIM_BOB_HANDLE=<name> (a public production write);
 * otherwise the handle tests fail with the instruction. No silent npub fallback.
 */
export function bobHandle(lane: TipLane): Promise<string> {
  bobHandleCache ??= (async () => {
    const bob = lane.bob;
    const domain = await homeDomain();
    let handle = bob.handle;
    const wanted = (process.env.E2E_CLAIM_BOB_HANDLE ?? '').trim().toLowerCase();
    if (!handle && wanted) {
      if (!/^[a-z0-9._-]{2,32}$/.test(wanted)) throw new Error('E2E_CLAIM_BOB_HANDLE must be a plain username');
      await claimHandle(lane, bob, wanted);
      handle = `${wanted}@${domain}`;
    }
    if (!handle) {
      throw new Error(
        `bob has no verified Smirk handle on ${domain}, so the handle and username tips cannot run. ` +
          'Claim and link one in Settings > Nostr, or set E2E_CLAIM_BOB_HANDLE=<name> to let the lane claim it.',
      );
    }
    if (!handle.endsWith(`@${domain}`)) throw new Error('bob\'s handle is not on this instance\'s NIP-05 domain');
    if ((await resolveNip05(handle)) !== bob.pubkeyHex) {
      throw new Error('bob\'s handle does not resolve over NIP-05 to his active key');
    }
    return handle;
  })();
  bobHandleCache.catch(() => (bobHandleCache = null));
  return bobHandleCache;
}

/**
 * A NIP-05 address on a domain other than this instance's that resolves to
 * bob's key (E2E_FOREIGN_NIP05=name@domain), proving cross-domain resolution.
 */
export async function foreignAddress(bob: LiveWallet): Promise<string> {
  const address = (process.env.E2E_FOREIGN_NIP05 ?? '').trim().toLowerCase();
  const shortfall = foreignShortfall();
  if (shortfall) missing('federation', shortfall);
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)) throw new Error('E2E_FOREIGN_NIP05 must be name@domain');
  if (address.endsWith(`@${await homeDomain()}`)) throw new Error('E2E_FOREIGN_NIP05 must be on a domain other than this instance\'s');
  if ((await resolveNip05(address)) !== bob.pubkeyHex) {
    throw new Error('E2E_FOREIGN_NIP05 does not resolve over NIP-05 to bob\'s active key');
  }
  return address;
}

/** Why bob cannot be addressed at a foreign domain in this run, or null. */
function foreignShortfall(): string | null {
  return (process.env.E2E_FOREIGN_NIP05 ?? '').trim() ? null : 'no foreign NIP-05 address for bob (E2E_FOREIGN_NIP05=name@domain)';
}

/**
 * The second backend, and why it cannot prove cross-operator delivery in this
 * run (null when it can). A misconfigured or broken B throws instead: that is
 * not a gap to acknowledge.
 */
async function secondBackend(): Promise<{ url: string; relayUrl: string; shortfall: string | null }> {
  const url = (process.env.FED_BACKEND_URL ?? '').trim().replace(/\/$/, '');
  if (!url) return { url, relayUrl: '', shortfall: 'no second backend (FED_BACKEND_URL); none exists in production yet' };
  if (new URL(url).host === new URL(BACKEND_URL).host) throw new Error('FED_BACKEND_URL must be another instance');
  const res = await fetch(`${url}/capabilities`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the second backend's capabilities answered HTTP ${res.status}`);
  const caps = (await res.json()) as Caps & { features?: { targeted_tips?: boolean } };
  if (!caps.features?.tips) throw new Error('the second backend does not advertise tips');
  const relayUrl = caps.messaging?.relay_url;
  if (!relayUrl || !/^wss?:\/\//.test(relayUrl)) throw new Error('the second backend advertises no relay');
  // The sender publishes to the relays bob advertises (his kind-10050 on the
  // sender's relays) and to its own. A relay on a loopback or private address
  // is on nobody's list, so delivery to it cannot work (2026-10-15: a local B
  // at 127.0.0.1 never saw the wrap). The run config already acknowledged
  // this; the acknowledgement only applied when FED_BACKEND_URL was empty.
  if (isLocalPublishRelay(relayUrl)) {
    return { url, relayUrl, shortfall: 'the second backend\'s relay is on a loopback or private address, which no sender\'s relay list leads to' };
  }
  if (caps.features.targeted_tips === false) {
    return { url, relayUrl, shortfall: 'the second backend does not offer targeted tips' };
  }
  return { url, relayUrl, shortfall: null };
}

/** A second, independent backend (FED_BACKEND_URL) that serves tips and a relay a sender can reach. */
export async function federatedBackend(): Promise<{ url: string; relayUrl: string }> {
  const { url, relayUrl, shortfall } = await secondBackend();
  if (shortfall) missing('federation', shortfall);
  return { url, relayUrl };
}

/**
 * For a test that follows a federated send whose tip does not exist: the
 * acknowledged-gap reason that send skipped with, or null. Null when the gap
 * is not acknowledged or its prerequisites are met (the tip is then missing
 * for another reason), so every other missing tip still skips with a reason
 * the skip guard refuses.
 */
export async function federationGapSkip(form: string): Promise<string | null> {
  if (!acknowledged('federation')) return null;
  let shortfall: string | null = null;
  if (form === 'foreign') shortfall = foreignShortfall();
  else if (form === 'second-backend') shortfall = await secondBackend().then((b) => b.shortfall, () => null);
  return shortfall ? gapReason('federation', `its send was skipped: ${shortfall}`) : null;
}
