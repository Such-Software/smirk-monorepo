/**
 * Background DM delivery: an alarm-driven poll that COLLECTS encrypted NIP-17
 * gift-wraps for the user's npub and notifies. No private key here: collecting
 * needs only the PUBLIC npub (the seed stays in the popup process), so we store
 * the wraps still-encrypted and the popup decrypts them on unlock.
 *
 * Robust MV3: a periodic `querySync` (a quick REQ→EOSE), NOT a fragile
 * persistent WebSocket that would drop on service-worker eviction.
 *
 * PRIVACY: every poll tells the relay "this npub is online", so the watch is
 * self-limiting. Before each beacon (and before re-arming the alarm on a
 * service-worker restart) it re-checks that it is still ENTITLED to run: the
 * wallet is still unlocked, it is still the SAME wallet that armed this npub, and
 * the backend that named this relay has not been switched. When any of those
 * fails the config + alarm are dropped and the watch stops until the popup arms
 * it again. Polling therefore no longer continues across lock / forget-wallet:
 * the pre-2026-08 behaviour kept beaconing the user's npub forever after one
 * visit to Messages, because nothing ever sent `DM_WATCH_CLEAR`.
 *
 * The background holds no wallet state of its own, so the entitlement signal is
 * the dapp public cache (see `./dapp/provider`): the popup writes it on every
 * transition to unlocked and clears it on lock, "Forget this wallet", backend
 * switch, and browser restart.
 *
 * The relay comes from the popup, but the watch is armed only with the relay
 * the entitled backend itself advertises, checked against that backend's
 * capabilities when arming. It used to take the popup's relay on trust and bind
 * it to whichever backend the background saw: a window whose capabilities read
 * from the previous operator resolved during a reset armed {that operator's
 * relay, the default backend}, which passed every entitlement check and
 * beaconed the npub to the old relay every five minutes until lock.
 */

import {
  BACKEND_CONFIG_KEY,
  SmirkApi,
  fetchDmWraps,
  initSmirkMessaging,
  type BackendConfig,
  type GiftWrapEvent,
} from '@smirk/core';

import { PUBLIC_CACHE_KEY, type DappPublicCache } from './dapp/provider';

const ALARM = 'dm-poll';
/** The watch config the popup sets on unlock (see {@link WatchConfig}). Public
 *  data: safe to persist. */
const WATCH_KEY = 'dm.watch';
/** Collected raw (encrypted) gift-wraps, newest-first, capped. */
const WRAPS_KEY = 'dm.wraps';
/** Wrap ids we've already fired a notification for (bounded). */
const SEEN_KEY = 'dm.seenNotified';

const POLL_MINUTES = 5;
/** NIP-59 randomizes gift-wrap created_at up to ~2 days into the PAST, so a
 *  tight `since` would miss freshly-published-but-past-dated wraps; use a wide
 *  window + dedup by id. */
const WINDOW_SECS = 14 * 24 * 3600;
const MAX_WRAPS = 300;

interface WatchConfig {
  npubHex: string;
  relayUrl: string;
  /** Fingerprint of the wallet that armed this watch. A different wallet (or a
   *  re-import) must not inherit the previous one's npub beacon. Absent on a
   *  pre-2026-08 stored config, which is treated as unentitled: the user re-arms
   *  by opening Messages again. */
  fingerprint?: string;
  /** Backend whose capabilities advertised `relayUrl`. Switching backends must
   *  not keep the wallet talking to the previous operator's relay. */
  backendUrl?: string;
}

/** What the background can observe about the current session. */
interface Entitlement {
  fingerprint: string;
  backendUrl: string;
}

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T) ?? fallback;
}
async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * Read the current session as the background can see it, or null when there is
 * no unlocked wallet to beacon for. The dapp public cache is the popup's
 * unlock mirror: cleared on lock / forget / backend switch / browser restart,
 * and carrying its own auto-lock expiry for the case where the session timed out
 * while the popup was closed (the same rule `dapp/provider.ts readCache` uses).
 */
async function currentEntitlement(): Promise<Entitlement | null> {
  const res = await chrome.storage.local.get([PUBLIC_CACHE_KEY, BACKEND_CONFIG_KEY]);
  const cache = res[PUBLIC_CACHE_KEY] as DappPublicCache | undefined;
  if (!cache || typeof cache.fingerprint !== 'string') return null;
  if (
    typeof cache.sessionExpiresAtMs === 'number' &&
    Date.now() >= cache.sessionExpiresAtMs
  ) {
    return null;
  }
  // Durable selection first; a wallet on the build-time default has no stored
  // config, so fall back to the base URL the popup stamped into the cache. If
  // neither is readable we cannot tell a switch from a no-op, so report no
  // entitlement rather than arm a watch that can never be validated.
  const backend = res[BACKEND_CONFIG_KEY] as BackendConfig | undefined;
  const backendUrl = backend?.url ?? cache.backendUrl;
  if (!backendUrl) return null;
  return { fingerprint: cache.fingerprint, backendUrl };
}

/** Whether `watch` may still beacon. Fails CLOSED: anything we cannot confirm
 *  (no cache, no binding on a pre-2026-08 config) stops the watch. */
async function stillEntitled(watch: WatchConfig): Promise<boolean> {
  if (!watch.fingerprint || !watch.backendUrl) return false;
  const now = await currentEntitlement();
  if (!now) return false;
  return watch.fingerprint === now.fingerprint && watch.backendUrl === now.backendUrl;
}

/**
 * Why `requested` may not be watched for the entitled backend, or null when it
 * may. Cheap check first: the popup names the backend it read the relay from,
 * and a window still on another backend is refused without a request. Then the
 * entitled backend's own capabilities must advertise exactly that relay; a
 * read that fails refuses rather than trusting the popup.
 */
async function relayRefusal(
  backendUrl: string,
  requested: { relayUrl: unknown; backendUrl: unknown },
): Promise<string | null> {
  if (typeof requested.relayUrl !== 'string' || !requested.relayUrl) {
    return 'the request names no relay';
  }
  if (requested.backendUrl !== backendUrl) {
    return (
      `the relay was read from ${String(requested.backendUrl || 'an unnamed backend')}, ` +
      `but the wallet's backend is ${backendUrl}`
    );
  }
  let caps: Awaited<ReturnType<SmirkApi['getCapabilities']>>;
  try {
    caps = await new SmirkApi(backendUrl).getCapabilities();
  } catch (e) {
    return `could not read ${backendUrl}'s capabilities (${e instanceof Error ? e.message : String(e)})`;
  }
  if (caps.error || !caps.data) {
    return `could not read ${backendUrl}'s capabilities (${caps.error ?? 'empty response'})`;
  }
  const advertised = caps.data.features?.nostr_relay ? caps.data.messaging?.relay_url : undefined;
  if (advertised !== requested.relayUrl) {
    return `${backendUrl} does not advertise the relay ${requested.relayUrl}`;
  }
  return null;
}

/** Drop the config + alarm. The collected wraps are left alone: they are still
 *  encrypted, and dropping them would lose messages across a plain auto-lock. */
async function stopWatching(): Promise<void> {
  await chrome.storage.local.remove([WATCH_KEY]);
  chrome.alarms?.clear(ALARM);
}

async function poll(): Promise<void> {
  const watch = await getLocal<WatchConfig | null>(WATCH_KEY, null);
  if (!watch?.npubHex || !watch.relayUrl) return;
  // Check BEFORE the beacon, never after: this is the only thing standing
  // between a locked/forgotten wallet and a relay that keeps being told its
  // npub is online.
  if (!(await stillEntitled(watch))) {
    await stopWatching();
    return;
  }

  initSmirkMessaging({ relayUrl: watch.relayUrl, publicRelays: [] });
  const since = Math.floor(Date.now() / 1000) - WINDOW_SECS;

  let wraps: GiftWrapEvent[];
  try {
    wraps = await fetchDmWraps(watch.npubHex, since);
  } catch (e) {
    console.debug('[smirk] dm poll failed', e);
    return;
  }

  const stored = await getLocal<GiftWrapEvent[]>(WRAPS_KEY, []);
  const storedIds = new Set(stored.map((w) => w.id));
  const fresh = wraps.filter((w) => w.id && !storedIds.has(w.id));
  if (fresh.length === 0) return;

  const merged = [...fresh, ...stored]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_WRAPS);
  await setLocal(WRAPS_KEY, merged);

  // Notify once per wrap (bounded seen-set).
  const seen = new Set(await getLocal<string[]>(SEEN_KEY, []));
  const toNotify = fresh.filter((w) => !seen.has(w.id));
  if (toNotify.length > 0 && chrome.notifications) {
    chrome.notifications.create(`dm-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Smirk',
      message:
        toNotify.length === 1
          ? 'New encrypted message'
          : `${toNotify.length} new encrypted messages`,
    });
    for (const w of toNotify) seen.add(w.id);
    await setLocal(SEEN_KEY, [...seen].slice(-MAX_WRAPS));
  }
}

/** Wire the alarm + popup command handlers + re-arm on SW startup. */
export function installDmWatcher(): void {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void poll();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Start/refresh watching (popup calls this on unlock with its public npub).
    if (msg?.type === 'DM_WATCH_SET') {
      void (async () => {
        const ent = await currentEntitlement();
        if (!ent) {
          // No unlocked wallet visible from here, so there is nobody to
          // attribute this npub to. Refuse rather than beacon.
          await stopWatching();
          sendResponse({ ok: false });
          return;
        }
        const refusal = await relayRefusal(ent.backendUrl, {
          relayUrl: msg.relayUrl,
          backendUrl: msg.backendUrl,
        });
        if (refusal) {
          // Any watch already armed stays as it was: it was checked when armed
          // and is re-checked before every poll.
          console.warn(`[smirk] DM watch not armed: ${refusal}`);
          sendResponse({ ok: false, error: refusal });
          return;
        }
        const cfg: WatchConfig = {
          npubHex: String(msg.npubHex),
          relayUrl: String(msg.relayUrl),
          fingerprint: ent.fingerprint,
          backendUrl: ent.backendUrl,
        };
        await setLocal(WATCH_KEY, cfg);
        chrome.alarms?.create(ALARM, { periodInMinutes: POLL_MINUTES });
        await poll(); // fetch immediately, don't wait for the first alarm
        sendResponse({ ok: true });
      })();
      return true;
    }
    // Stop watching (popup calls this on lock / forget).
    if (msg?.type === 'DM_WATCH_CLEAR') {
      void (async () => {
        await stopWatching();
        sendResponse({ ok: true });
      })();
      return true;
    }
    // Hand the collected (still-encrypted) wraps to the popup to decrypt.
    if (msg?.type === 'DM_WRAPS_GET') {
      void getLocal<GiftWrapEvent[]>(WRAPS_KEY, []).then((wraps) => sendResponse({ wraps }));
      return true;
    }
    return false;
  });

  // Re-arm the alarm after a service-worker restart, but only while the watch is
  // still entitled: an eviction is exactly where a lock / forget / backend switch
  // that happened while we were gone becomes visible.
  void (async () => {
    const watch = await getLocal<WatchConfig | null>(WATCH_KEY, null);
    if (!watch?.npubHex) return;
    if (await stillEntitled(watch)) {
      chrome.alarms?.create(ALARM, { periodInMinutes: POLL_MINUTES });
    } else {
      await stopWatching();
    }
  })();
}
