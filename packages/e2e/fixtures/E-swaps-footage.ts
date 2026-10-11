/**
 * Guarded footage for the E-swaps live lane.
 *
 * Playwright's own trace, screenshot and video stay off (capture-policy.mjs):
 * they cannot be checked frame by frame. This recorder takes its own frames
 * from each wallet page, about four a second, and decides every frame with
 * the guard in E-swaps-guard.mjs:
 *
 *   1. classify the page (frameSurface); a card surface takes no screenshot;
 *   2. screenshot with every MASK_SELECTORS element masked;
 *   3. classify again, and drop the frame if the two passes disagree;
 *   4. compare the visible text and input values outside the masks with the
 *      secrets this run knows (phrase three-word runs, the run password, any
 *      registered status link or key): a hit turns the interval into a card.
 *
 * Identical frames are stored once with the interval they cover, so the long
 * static holds the owner asked for cost no disk.
 *
 * A page's recorder takes no frame until `start()`. A wallet's first page
 * starts on Home, after the import and unlock, as the demo lane does; the
 * import is a redaction card in the timeline, never frames.
 *
 * DEAD AIR is enforced here, not by ad hoc sleeps in specs, with the numbers
 * in E-swaps-policy.mjs: `tap` and `fill` hold the screen still for
 * HOLD.preTapMs first; the screen any action leads to is held settled for
 * HOLD.settledMs before the next action (or the end of the test) whether or
 * not the spec asks for it; `result` holds HOLD.resultMs. Every hold is
 * written to the timeline with its measured length, and the encoder
 * (scripts/E-swaps-encode.mjs) refuses a timeline with a short hold or with a
 * screen that was never held.
 *
 * Labels are static strings chosen in source. `assertStaticLabel` refuses
 * anything that looks like a value: digits runs, URLs, addresses.
 *
 * With FOOTAGE unset nothing is recorded and holds are skipped, so the same
 * spec can run quickly as a plain live check.
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CARD_PATTERNS, Canary, MASK_SELECTORS, assertStaticLabel, frameSurface, type FrameSurface } from './E-swaps-guard.mjs';
import { loadingProbe } from './E-swaps-page.mjs';
import { AUTO_CLOSE_TAPS, HOLD } from './E-swaps-policy.mjs';
import { sleepAtLeast } from './hold-timer.mjs';
import { noteStep } from './failure-context.js';

export { Canary, HOLD, assertStaticLabel };

/** Target cadence of the frame loop (about four frames a second). */
export const FRAME_INTERVAL_MS = 250;

/**
 * Text that means a screen is still loading. A live provider card's leftover
 * "Checking NonLogs…" note does not count (see loadingProbe).
 */
const LOADING_TEXT = /Updating…|Loading|Checking THORChain…|Checking NonLogs…|Quoting…|Creating trade…|Sending…|Estimating…|Unlocking…/;

export type HoldKind = 'tap' | 'type' | 'settled' | 'result';
export type FrameVerdict = 'clean' | 'masked';

export interface FrameRun {
  file: string;
  role: string;
  from: number;
  until: number;
  verdict: FrameVerdict;
  masked: string[];
}

export interface HoldRecord {
  kind: HoldKind;
  label: string;
  from: number;
  until: number;
  requiredMs: number;
  /** A tap on a screen that closes itself (AUTO_CLOSE_TAPS): no settle first. */
  beforeAutoClose?: boolean;
}

export interface SegmentRecord {
  kind: 'secret' | 'card' | 'wait' | 'test';
  label: string;
  from: number;
  until: number;
}

export interface Timeline {
  version: 1;
  area: 'E-swaps';
  wallet: string;
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  policy: typeof HOLD & { frameIntervalMs: number };
  frames: FrameRun[];
  holds: HoldRecord[];
  segments: SegmentRecord[];
  markers: Array<{ label: string; at: number }>;
  /** Frames dropped because the two guard passes disagreed. */
  dropped: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

/** One wallet's timeline and frame directory. Shared by its pages' recorders. */
export class WalletTimeline {
  readonly data: Timeline;
  private readonly framesDir: string;
  private frameCount = 0;
  private openCard: SegmentRecord | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string, wallet: string, runId: string, readonly enabled: boolean) {
    this.framesDir = join(dir, 'frames');
    this.data = {
      version: 1,
      area: 'E-swaps',
      wallet,
      runId,
      startedAt: Date.now(),
      stoppedAt: null,
      policy: { ...HOLD, frameIntervalMs: FRAME_INTERVAL_MS },
      frames: [],
      holds: [],
      segments: [],
      markers: [],
      dropped: 0,
    };
    if (enabled) {
      mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      chmodSync(this.framesDir, 0o700);
      this.flushTimer = setInterval(() => this.flush(), 30_000);
      this.flushTimer.unref();
    }
  }

  /** Store a frame, or extend the previous one when nothing changed. */
  frame(role: string, jpeg: Buffer, hash: string, verdict: FrameVerdict, masked: string[], at: number): void {
    this.closeCard(at);
    const last = this.data.frames.at(-1);
    if (last && last.role === role && last.file.endsWith(`${hash.slice(0, 12)}.jpg`)) {
      last.until = at;
      return;
    }
    const file = `${String(this.frameCount++).padStart(6, '0')}-${hash.slice(0, 12)}.jpg`;
    writeFileSync(join(this.framesDir, file), jpeg, { mode: 0o600 });
    this.data.frames.push({ file, role, from: at, until: at, verdict, masked });
  }

  /** The screen could not be made safe: extend or open a card interval. */
  card(label: string, at: number): void {
    if (this.openCard && this.openCard.label === label) {
      this.openCard.until = at;
      return;
    }
    this.closeCard(at);
    this.openCard = { kind: 'card', label, from: at, until: at };
    this.data.segments.push(this.openCard);
  }

  private closeCard(at: number): void {
    if (this.openCard) this.openCard.until = Math.max(this.openCard.until, at);
    this.openCard = null;
  }

  hold(record: HoldRecord): void {
    this.data.holds.push(record);
  }

  segment(record: SegmentRecord): void {
    this.data.segments.push(record);
  }

  marker(label: string): void {
    this.data.markers.push({ label: assertStaticLabel(label), at: Date.now() });
  }

  dropped(): void {
    this.data.dropped++;
  }

  flush(): void {
    if (!this.enabled) return;
    writeJsonAtomic(join(this.dir, 'timeline.json'), this.data);
  }

  close(): void {
    this.closeCard(Date.now());
    this.data.stoppedAt = Date.now();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
  }
}

/** Classify a page. Throws when the page is navigating; callers retry. */
export async function surfaceOf(page: Page): Promise<FrameSurface> {
  return page.evaluate(frameSurface, { masks: MASK_SELECTORS, patterns: CARD_PATTERNS });
}

/** The frame loop for one page. Takes no frame until `start()`. */
export class PageRecorder {
  private stopped = false;
  private started = false;
  private pausedDepth = 0;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    private readonly page: Page,
    private readonly role: string,
    private readonly timeline: WalletTimeline,
    private readonly canary: Canary,
  ) {}

  /** Begin taking frames, once. A no-op when footage is off. */
  start(): void {
    if (this.started || this.stopped || !this.timeline.enabled) return;
    this.started = true;
    this.loop = this.run();
  }

  pause(): void {
    this.pausedDepth++;
  }

  resume(): void {
    this.pausedDepth = Math.max(0, this.pausedDepth - 1);
  }

  get paused(): boolean {
    return this.pausedDepth > 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    const masks = MASK_SELECTORS.map((selector) => this.page.locator(selector));
    while (!this.stopped && !this.page.isClosed()) {
      const started = Date.now();
      if (this.paused) {
        await sleep(100);
        continue;
      }
      try {
        const before = await surfaceOf(this.page);
        if (before.card || this.canary.hit(before)) {
          this.timeline.card(before.card ?? 'known secret', Date.now());
        } else {
          const jpeg = await this.page.screenshot({
            type: 'jpeg',
            quality: 85,
            mask: masks,
            maskColor: '#202024',
            caret: 'hide',
            timeout: 5_000,
          });
          const after = await surfaceOf(this.page);
          if (this.paused || after.card || this.canary.hit(after) || before.masked.join() !== after.masked.join()) {
            this.timeline.dropped();
          } else {
            const hash = createHash('sha1').update(jpeg).digest('hex');
            this.timeline.frame(this.role, jpeg, hash, before.masked.length ? 'masked' : 'clean', before.masked, Date.now());
          }
        }
      } catch {
        // Navigation or a closing page: no frame this tick.
      }
      await sleep(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
    }
  }
}

/**
 * What a spec drives: the wallet's current page plus the holds. `page()` is a
 * getter because reopening the popup replaces the page.
 */
export class WalletFootage {
  /**
   * The label of the last action whose screen has not been held settled yet.
   * The next action, or the end of the test, holds it first.
   */
  private unheld: string | null = null;

  constructor(
    private readonly timeline: WalletTimeline,
    private readonly canary: Canary,
    private readonly current: () => { page: Page; recorder: PageRecorder },
  ) {}

  get enabled(): boolean {
    return this.timeline.enabled;
  }

  private async hold(kind: HoldKind, label: string, requiredMs: number, extra: Pick<HoldRecord, 'beforeAutoClose'> = {}): Promise<void> {
    if (!this.enabled) return;
    const from = Date.now();
    // Never a timer tick short: the encoder compares this with the policy.
    await sleepAtLeast(requiredMs);
    this.timeline.hold({ kind, label, from, until: Date.now(), requiredMs, ...extra });
  }

  /** Fail closed when the screen shows something no mask can cover. */
  private async assertActionable(label: string): Promise<void> {
    const { page, recorder } = this.current();
    if (recorder.paused) return;
    const surface = await surfaceOf(page);
    if (surface.card || this.canary.hit(surface)) {
      throw new Error(`refusing "${label}": a secret surface is on screen outside a secret scope (${surface.card ?? 'known secret'})`);
    }
  }

  /**
   * Hold the screen the last action led to, if nothing has held it yet.
   * Called before every action and at the end of each test.
   */
  async settleIfUnheld(): Promise<void> {
    if (this.unheld === null) return;
    await this.settled(`screen after: ${this.unheld}`.slice(0, 80).trimEnd());
  }

  /**
   * Hold the previous screen settled if it was not, hold this one still, check
   * it, then tap. `beforeAutoClose` (only for AUTO_CLOSE_TAPS) skips the
   * settle on a screen that would close itself during it. `beforeClick` runs
   * after every check, immediately before the click.
   */
  async tap(
    label: string,
    target: Locator,
    options: { timeout?: number; beforeAutoClose?: boolean; beforeClick?: () => void } = {},
  ): Promise<void> {
    noteStep(label);
    assertStaticLabel(label);
    if (options.beforeAutoClose && !AUTO_CLOSE_TAPS.includes(label)) {
      throw new Error(`"${label}" is not a reviewed auto-close tap; it must wait for the settle`);
    }
    if (!options.beforeAutoClose) await this.settleIfUnheld();
    await target.waitFor({ state: 'visible', timeout: options.timeout ?? 60_000 });
    await this.hold('tap', label, HOLD.preTapMs, options.beforeAutoClose ? { beforeAutoClose: true } : {});
    await this.assertActionable(label);
    this.timeline.marker(label);
    options.beforeClick?.();
    await target.click({ timeout: options.timeout ?? 60_000 });
    this.unheld = label;
  }

  /** As `tap`, then type a public value (an amount, an address). */
  async fill(label: string, target: Locator, value: string): Promise<void> {
    noteStep(label);
    assertStaticLabel(label);
    await this.settleIfUnheld();
    await target.waitFor({ state: 'visible', timeout: 60_000 });
    await this.hold('type', label, HOLD.preTapMs);
    await this.assertActionable(label);
    this.timeline.marker(label);
    await target.fill(value, { timeout: 30_000 });
    this.unheld = label;
  }

  /** Wait for loading text to clear, then hold the settled screen. */
  async settled(label: string, options: { patienceMs?: number } = {}): Promise<void> {
    noteStep(label);
    assertStaticLabel(label);
    const { page } = this.current();
    const deadline = Date.now() + (options.patienceMs ?? 45_000);
    while (Date.now() < deadline) {
      const loading = await page.evaluate(loadingProbe, LOADING_TEXT.source).catch(() => true);
      if (!loading) break;
      await sleep(500);
    }
    await this.hold('settled', label, HOLD.settledMs);
    this.unheld = null;
  }

  /** Hold a key result on screen (it also counts as the settled hold). */
  async result(label: string): Promise<void> {
    noteStep(label);
    assertStaticLabel(label);
    this.timeline.marker(label);
    await this.hold('result', label, HOLD.resultMs);
    this.unheld = null;
  }

  mark(label: string): void {
    this.timeline.marker(label);
  }

  /**
   * Record a redaction card while `fn` handles a secret (phrase entry,
   * password typing). Capture resumes only after two consecutive clean guard
   * passes; if the screen never clears, recording stays off and this throws.
   * The screen left behind is held settled before the next action.
   */
  async secret<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    const first = this.current().recorder;
    first.pause();
    const from = Date.now();
    try {
      return await fn();
    } finally {
      this.unheld = label;
      // `fn` may have replaced the page; the scope ends on whichever is current.
      const now = this.current();
      if (now.recorder !== first) now.recorder.pause();
      try {
        await this.twoCleanPasses(now.page);
      } finally {
        this.timeline.segment({ kind: 'secret', label, from, until: Date.now() });
        first.resume();
        if (now.recorder !== first) now.recorder.resume();
      }
    }
  }

  private async twoCleanPasses(page: Page): Promise<void> {
    let clean = 0;
    const deadline = Date.now() + 60_000;
    while (clean < 2) {
      if (Date.now() > deadline) {
        this.current().recorder.pause(); // stays paused: fail closed
        throw new Error('the screen did not clear after a secret scope; recording stays off');
      }
      const surface = await surfaceOf(page).catch(() => null);
      clean = surface && !surface.card && !this.canary.hit(surface) ? clean + 1 : 0;
      await sleep(400);
    }
  }

  /** A long wait (confirmations). Frames keep flowing; dedupe keeps it cheap. */
  async wait<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    const from = Date.now();
    try {
      return await fn();
    } finally {
      this.timeline.segment({ kind: 'wait', label, from, until: Date.now() });
    }
  }

  /** Test boundaries, for chapters. Titles are static strings in the spec. */
  testSegment(title: string, from: number, until: number): void {
    this.timeline.segment({ kind: 'test', label: title.slice(0, 120), from, until });
  }
}
