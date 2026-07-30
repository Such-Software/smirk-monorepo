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
import type { BrowserContext } from '@playwright/test';

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

  constructor(private readonly testInfo: TestInfo) {}

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
    const videos: string[] = [];
    for (const page of context.pages()) {
      try {
        const v = page.video();
        if (v) videos.push(await v.path());
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
