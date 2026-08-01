/**
 * Footage markers: make the demo capture editable.
 *
 * `CAPTURE_VIDEO=1` already records every page, but the raw output is not
 * usable as marketing material:
 *
 *   - files are named `page@39a6bef6…webm`, so nobody can tell which scenario
 *     or which window (popup? approval? dapp page?) a clip came from;
 *   - the whole test duration is captured, so the interesting two seconds are
 *     buried in waits, retries and teardown;
 *   - nothing says WHERE the key moment is.
 *
 * A spec calls `mark(...)` at each moment worth showing. On teardown we write a
 * sidecar manifest next to the videos with the scenario name, the video files,
 * and marker offsets measured from the start of recording. `scripts/process-
 * footage.mjs` then uses those offsets to trim dead air and emit named clips.
 *
 * Markers are cheap and always recorded, even when capture is off, so adding
 * one to a spec never depends on how the suite is being run.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TestInfo } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

const VIDEO_DIR =
  process.env.CAPTURE_VIDEO_DIR ??
  join(homedir(), 'Build', 'smirk-monorepo', 'e2e', 'videos');

export interface Marker {
  /** Short label for the moment, e.g. 'wallet-created' or 'payment-approved'. */
  name: string;
  /** Milliseconds since recording started. */
  tMs: number;
  /** Optional note for whoever edits the footage. */
  note?: string;
}

/** Collects markers for one test and writes the manifest on teardown. */
export class Footage {
  private readonly markers: Marker[] = [];
  private readonly startedAt = Date.now();
  /**
   * Every page the context opened. Tracked as they appear rather than read from
   * `context.pages()` at teardown: by then most pages have CLOSED, so that list
   * is usually empty and the manifest ends up with no videos at all. Holding the
   * Page reference works because `page.video().path()` still resolves after the
   * page closes (in fact it only resolves then).
   */
  private readonly seen: Page[] = [];

  constructor(private readonly testInfo: TestInfo) {}

  /** Last known URL per tracked page, so clips can be labelled by ROLE.
   *  Filtering on file size alone was too crude: it caught the blank 3-7KB
   *  pages but let through mid-sized ones that are still visually empty. */
  private readonly urls = new Map<Page, string>();

  /** Called by the fixture for each page the context opens. */
  track(page: Page): void {
    this.seen.push(page);
    this.urls.set(page, page.url());
    // A page usually opens on about:blank and navigates after, so keep the
    // latest URL rather than the one it happened to have at creation.
    page.on('framenavigated', (fr) => {
      if (!fr.parentFrame()) this.urls.set(page, fr.url());
    });
  }

  /**
   * Record a moment worth showing. Call it AFTER the assertion that proves the
   * moment actually happened, so a marker never points at a step that failed.
   */
  mark(name: string, note?: string): void {
    this.markers.push({
      name,
      tMs: Date.now() - this.startedAt,
      ...(note ? { note } : {}),
    });
  }

  /** Written on teardown; consumed by scripts/process-footage.mjs. */
  async writeManifest(context: BrowserContext): Promise<void> {
    if (!this.markers.length) return;

    // Video paths only resolve once the page has closed, so collect them here
    // rather than at mark() time.
    const videos: { path: string; url: string }[] = [];
    // Union of tracked pages and any still open, de-duplicated.
    const pages = [...new Set<Page>([...this.seen, ...context.pages()])];
    for (const page of pages) {
      try {
        const v = page.video();
        if (!v) continue;
        videos.push({ path: await v.path(), url: this.urls.get(page) ?? '' });
      } catch {
        /* page already gone; nothing to record */
      }
    }

    const safe = this.testInfo.titlePath
      .join(' - ')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120)
      .toLowerCase();

    mkdirSync(VIDEO_DIR, { recursive: true });
    writeFileSync(
      join(VIDEO_DIR, `${safe}.footage.json`),
      JSON.stringify(
        {
          scenario: this.testInfo.titlePath.join(' > '),
          file: this.testInfo.file.split('/').pop(),
          status: this.testInfo.status,
          durationMs: Date.now() - this.startedAt,
          markers: this.markers,
          videos,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}
