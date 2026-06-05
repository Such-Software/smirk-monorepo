/**
 * Bookmark persistence interface + default in-memory impl.
 *
 * Bookmarks are the primary surface for "I want to come back here"
 * and the most common entry point for repeat dapp visits. The
 * persistence interface is intentionally small — flat list, no
 * folders — because the alternative (full folder tree, drag-and-
 * drop reorder) is a project of its own and not a v0.3 must-have.
 */

// ======================================================================
// Types
// ======================================================================

/**
 * A single bookmark. Bookmarks are user-visible, so URL + title +
 * favicon is the entire model.
 */
export interface Bookmark {
  /** Stable, opaque id assigned by the store on insert. */
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly faviconUrl?: string;
  /** Unix ms when the user added this bookmark. */
  readonly createdAt: number;
}

/** Persistence contract for bookmarks. */
export interface BookmarkStore {
  /** Add a new bookmark. Returns the stored entry (with assigned id). */
  add(entry: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark>;

  /** Remove a bookmark by id. No-op if id is unknown. */
  remove(id: string): Promise<void>;

  /** All bookmarks, in insertion order. */
  list(): Promise<readonly Bookmark[]>;

  /**
   * Replace the title and/or favicon of an existing bookmark. URL is
   * immutable — to change URL, remove and re-add. Throws if id is
   * unknown.
   */
  update(
    id: string,
    patch: Partial<Pick<Bookmark, 'title' | 'faviconUrl'>>,
  ): Promise<void>;
}

// ======================================================================
// In-memory default
// ======================================================================

/**
 * Process-lifetime bookmark store. As with `InMemoryHistoryStore`,
 * suitable for tests and as a fallback before a persistent adapter
 * is wired in.
 */
export class InMemoryBookmarkStore implements BookmarkStore {
  private readonly entries: Bookmark[] = [];
  private nextId = 1;

  async add(entry: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark> {
    const stored: Bookmark = {
      ...entry,
      id: String(this.nextId++),
      createdAt: Date.now(),
    };
    this.entries.push(stored);
    return stored;
  }

  async remove(id: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) this.entries.splice(idx, 1);
  }

  async list(): Promise<readonly Bookmark[]> {
    return [...this.entries];
  }

  async update(
    id: string,
    patch: Partial<Pick<Bookmark, 'title' | 'faviconUrl'>>,
  ): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`Unknown bookmark id: ${id}`);
    const existing = this.entries[idx]!;
    this.entries[idx] = { ...existing, ...patch };
  }
}
