/**
 * `OriginPermissionStore` backed by `chrome.storage.local`. Each
 * origin gets its own key so concurrent reads/writes don't fight
 * over a single JSON blob.
 *
 * **MV3 storage semantics.** `chrome.storage.local` survives SW
 * eviction (unlike in-memory Maps), so granted permissions persist
 * across browser restarts. Quota is 10 MiB total; each permission
 * record is ~200 bytes, supports ~50k origins before that matters.
 */

import type {
  OriginPermission,
  OriginPermissionStore,
} from '@such-software/smirk-dapp-api';

const KEY_PREFIX = 'smirk:dapp:origin:';

function keyFor(origin: string): string {
  return `${KEY_PREFIX}${origin}`;
}

export function chromeStoragePermissionStore(): OriginPermissionStore {
  return {
    async get(origin) {
      const key = keyFor(origin);
      const result = await chrome.storage.local.get(key);
      return (result[key] as OriginPermission | undefined) ?? null;
    },

    async set(perm) {
      // Preserve grantedAt on upsert: the wallet-handler computes
      // the new value but a paranoia layer here guards against
      // accidental "regrant resets the timer" bugs in future
      // adapter code.
      const existing = await this.get(perm.origin);
      const merged: OriginPermission = existing
        ? { ...perm, grantedAt: existing.grantedAt }
        : perm;
      await chrome.storage.local.set({ [keyFor(perm.origin)]: merged });
    },

    async remove(origin) {
      await chrome.storage.local.remove(keyFor(origin));
    },

    async list() {
      const all = await chrome.storage.local.get(null);
      const out: OriginPermission[] = [];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(KEY_PREFIX)) continue;
        out.push(v as OriginPermission);
      }
      // Most-recently-used first: matches the Settings UI's expected
      // sort order without forcing every caller to re-sort.
      out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      return out;
    },
  };
}
