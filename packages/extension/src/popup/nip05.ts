/**
 * Extension NIP-05 resolver — a shared, TOFU-pinning resolver backed by a
 * chrome.storage-persisted pin store, so a name's key is pinned across sessions
 * and a later substitution is caught. Used by the send-by-name flow to confirm the
 * resolved key before paying (federation hardening — "follow the key, not the name").
 */

import { api, createNip05Resolver, homeDomainFromApiBase, type Nip05PinStore, type Nip05Resolver } from '@smirk/core';

import { storage } from './singletons';

const PIN_KEY = 'smirk_nip05_pins_v1';

/** Persist first-seen `name@domain → pubkey` pins as one JSON blob in local storage. */
const pinStore: Nip05PinStore = {
  async get(key) {
    const all = ((await storage.get(PIN_KEY)) as Record<string, string> | null) ?? {};
    return all[key] ?? null;
  },
  async set(key, pubkeyHex) {
    const all = ((await storage.get(PIN_KEY)) as Record<string, string> | null) ?? {};
    all[key] = pubkeyHex;
    await storage.set(PIN_KEY, all);
  },
};

/** The one resolver instance the popup shares (its memory cache lives for the
 *  popup's lifetime; pins survive in storage). */
export const nip05Resolver: Nip05Resolver = createNip05Resolver({ pins: pinStore });

/** This instance's NIP-05 home authority (its own domain), derived from the
 *  configured backend URL — so bare names + the bare-vs-foreign display rule use
 *  the instance's domain, not a hardcoded default. Read at call time so it tracks
 *  a backend switch. */
export function instanceHomeDomain(): string {
  return homeDomainFromApiBase(api.getBaseUrl());
}
