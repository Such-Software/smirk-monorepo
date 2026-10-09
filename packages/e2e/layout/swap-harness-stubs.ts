/**
 * Just enough of `chrome.storage` for the extension popup's singletons to run
 * in a plain page: an in-memory area per name, with change listeners. Imported
 * first by swap-harness.tsx, before any popup module reads `chrome`.
 */
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Listener = (changes: Changes, area: string) => void;

const listeners = new Set<Listener>();

function area(name: string) {
  const mem = new Map<string, unknown>();
  return {
    async get(keys?: string | string[] | null) {
      if (keys == null) return Object.fromEntries(mem);
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (mem.has(k)) out[k] = structuredClone(mem.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: mem.get(k), newValue: v };
        mem.set(k, structuredClone(v));
      }
      for (const l of listeners) l(changes, name);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
    },
  };
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: {
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
    },
  },
  runtime: { id: 'swap-harness', getURL: (p: string) => p },
};
