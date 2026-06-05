/**
 * Browsing history persistence interface + default in-memory impl.
 *
 * Controllers are expected to consult a `HistoryStore` to drive URL-
 * bar autocomplete and the optional History panel UI. The store is
 * pluggable so platform shells can use the right persistence — e.g.
 * SQLite on desktop, NSURLCache + Core Data on iOS — without the
 * controller knowing.
 *
 * The in-memory default is process-lifetime only; suitable for
 * tests and as a fallback when persistent storage hasn't been
 * configured yet.
 */

// ======================================================================
// Types
// ======================================================================

/**
 * One row of browsing history. We only record URL + title + timestamp
 * — no per-visit metadata (referrer, viewport, etc.) by design,
 * because privacy.
 */
export interface HistoryEntry {
  readonly url: string;
  readonly title: string;
  /** Unix ms when the user navigated to this URL. */
  readonly visitedAt: number;
}

/**
 * Persistence contract for browsing history. Implementations are free
 * to apply quotas, retention windows, and private-mode policies as
 * long as the public surface honors the documented semantics.
 */
export interface HistoryStore {
  /** Record a visit. Stores append-only; readers see the latest snapshot. */
  record(entry: HistoryEntry): Promise<void>;

  /**
   * List the most recent N entries, newest-first. If `query` is set,
   * filter to entries whose URL or title contains the substring
   * (case-insensitive).
   */
  recent(limit: number, query?: string): Promise<readonly HistoryEntry[]>;

  /**
   * Remove all entries for the given URL (across all visits). Used by
   * the History panel's "Forget this page" affordance.
   */
  forget(url: string): Promise<void>;

  /** Remove all entries. Used by Settings → Clear browsing history. */
  clear(): Promise<void>;
}

// ======================================================================
// In-memory default
// ======================================================================

/**
 * Process-lifetime history store. Drops everything when the process
 * exits. Suitable for tests and as a fallback before a persistent
 * adapter is wired in.
 *
 * Linear scan on read — fine for tests and for the small N typical
 * of a session, not appropriate for production with thousands of
 * entries (consider IndexedDB / SQLite there).
 */
export class InMemoryHistoryStore implements HistoryStore {
  private readonly entries: HistoryEntry[] = [];

  async record(entry: HistoryEntry): Promise<void> {
    this.entries.push(entry);
  }

  async recent(limit: number, query?: string): Promise<readonly HistoryEntry[]> {
    if (limit <= 0) return [];
    const needle = query?.toLowerCase();
    const filtered = needle
      ? this.entries.filter(
          (e) =>
            e.url.toLowerCase().includes(needle) ||
            e.title.toLowerCase().includes(needle),
        )
      : this.entries;
    // Newest-first.
    return filtered.slice(-limit).reverse();
  }

  async forget(url: string): Promise<void> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.url === url) this.entries.splice(i, 1);
    }
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
  }
}
