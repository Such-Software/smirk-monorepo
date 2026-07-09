/**
 * Side-effect test shim: install a minimal in-memory `chrome.storage.local` on
 * globalThis so importing extension modules that eagerly construct the
 * `@smirk/core` `ChromeLocalStorage` singleton (via `singletons.ts`) doesn't throw
 * at module-load time under `node --test`. Import this FIRST (before any module
 * that transitively pulls `singletons.ts`).
 */
type Listener = (...args: unknown[]) => void;

function memArea() {
  const mem = new Map<string, unknown>();
  return {
    get: async (key?: string | string[] | null) => {
      if (key == null) return Object.fromEntries(mem);
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) mem.set(k, v);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) mem.delete(k);
    },
  };
}

if (!(globalThis as { chrome?: unknown }).chrome) {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: memArea(),
      session: memArea(),
      onChanged: { addListener: (_l: Listener) => undefined, removeListener: (_l: Listener) => undefined },
    },
  };
}
