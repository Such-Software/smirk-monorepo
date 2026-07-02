/**
 * Background DM delivery — an alarm-driven poll that COLLECTS encrypted NIP-17
 * gift-wraps for the user's npub and notifies. No private key here: collecting
 * needs only the PUBLIC npub (the seed stays in the popup process), so we store
 * the wraps still-encrypted and the popup decrypts them on unlock.
 *
 * Robust MV3: a periodic `querySync` (a quick REQ→EOSE), NOT a fragile
 * persistent WebSocket that would drop on service-worker eviction. Polling
 * continues while the wallet is LOCKED (wraps accumulate encrypted; the
 * notification says only "you have messages"); the popup decrypts on unlock.
 */

import { fetchDmWraps, initSmirkMessaging, type GiftWrapEvent } from '@smirk/core';

const ALARM = 'dm-poll';
/** `{ npubHex, relayUrl }` the popup sets on unlock. Public data — safe to persist. */
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
}

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T) ?? fallback;
}
async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function poll(): Promise<void> {
  const watch = await getLocal<WatchConfig | null>(WATCH_KEY, null);
  if (!watch?.npubHex || !watch.relayUrl) return;

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
        await setLocal(WATCH_KEY, {
          npubHex: String(msg.npubHex),
          relayUrl: String(msg.relayUrl),
        });
        chrome.alarms?.create(ALARM, { periodInMinutes: POLL_MINUTES });
        await poll(); // fetch immediately, don't wait for the first alarm
        sendResponse({ ok: true });
      })();
      return true;
    }
    // Stop watching (popup calls this on lock / forget).
    if (msg?.type === 'DM_WATCH_CLEAR') {
      void (async () => {
        await chrome.storage.local.remove([WATCH_KEY]);
        chrome.alarms?.clear(ALARM);
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

  // Re-arm the alarm after a service-worker restart if watching is configured.
  void (async () => {
    const watch = await getLocal<WatchConfig | null>(WATCH_KEY, null);
    if (watch?.npubHex) {
      chrome.alarms?.create(ALARM, { periodInMinutes: POLL_MINUTES });
    }
  })();
}
