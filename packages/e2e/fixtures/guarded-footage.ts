/**
 * Guarded footage: the one recorder the wallet suite admits, used by the live
 * lane (playwright.live.config.ts). Playwright's own trace, screenshot and video
 * stay off, because they cannot be checked frame by frame.
 *
 * How a frame is taken, per page, about four times a second:
 *   1. Inside `footage.secret(...)` nothing is captured; a labelled card stands
 *      in for the frame.
 *   2. Otherwise the in-page guard (demo/guard.mjs `liveFrameVerdict`) runs.
 *      A `card` verdict, or a hit by the in-memory canary of known secrets,
 *      replaces the frame with a card. Nothing is captured.
 *   3. A `clean` or `mask` verdict takes a screenshot with every mask rule
 *      resolved again at capture time, then runs the guard a second time. If
 *      the two verdicts disagree, or a secret scope opened meanwhile, the frame
 *      is dropped before it reaches disk.
 *   4. After any card, capture resumes only after two consecutive clean passes.
 *   5. Identical frames are written once; the timeline keeps the timestamps, so
 *      a 25 second static hold costs one JPEG.
 *
 * Dead air is policy, not a habit, and it is measured on the recorded frames,
 * not on a clock. A hold ends only once its page's recording has shown no new
 * frame for the hold's length: HOLD_MS.settled on a settled screen, HOLD_MS.result
 * on a key outcome, HOLD_MS.preTap before every tap. Every interaction (tap,
 * choice, typing, key press) first settles the screen if it changed since its
 * last settled hold, then pauses. `settleAll` holds every changed page at the
 * end of a step. `stop` replays the timeline and fails the run, with the cause,
 * if any tap followed less than HOLD_MS.preTap of unchanged frames, if any
 * screen was left by a tap without a settled hold of its current frame, or if
 * any hold ended on a screen that had not been static for its length. Labels
 * are short static phrases; values, URLs and keys are refused.
 *
 * Output (0700 directories, 0600 files) goes to E2E_FOOTAGE_DIR, by default
 * ~/Build/smirk-e2e/<the candidate's run label>/footage. Nothing is promoted or uploaded.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  LIVE_CARD_CAPTIONS,
  LIVE_MASK_ATTRIBUTE,
  LIVE_RULES,
  createSecretCanary,
  liveFrameVerdict,
  type LiveFrameVerdict,
  type SecretCanary,
} from '../demo/guard.mjs';
import {
  HOLD_MS,
  POLICY_TOLERANCE_MS,
  checkHoldPolicy,
  describeViolations,
  type HoldKind,
} from './footage-policy.mjs';
import { noteStep } from './failure-context.js';
import { RC_FOOTAGE_ROOT } from './release-candidate.mjs';

/** The owner's dead-air policy and its timeline check live in footage-policy.mjs. */
export { HOLD_MS, type HoldKind };

/** About four frames a second per recorded page. */
export const FRAME_INTERVAL_MS = 250;
/**
 * How much longer than its policy a hold may wait for a screen that keeps
 * changing. Past that the hold gives up and `stop` reports it.
 */
export const HOLD_OVERRUN_MS = 60_000;
/** Settle-then-pause rounds before an interaction proceeds on a restless screen. */
const SETTLE_ROUNDS = 3;
/**
 * The longest a footage helper waits for its target. The runner's default is
 * no limit at all, so one renamed element would otherwise stall a live run for
 * the whole test timeout.
 */
export const ACTION_TIMEOUT_MS = 60_000;
/** Clean guard passes required before capture resumes after a card. */
export const RESUME_CLEAN_PASSES = 2;
/** The default output root for this release candidate's run. */
export const DEFAULT_FOOTAGE_DIR = RC_FOOTAGE_ROOT;

/** Output frame rate of the per-page videos. */
const ENCODE_FPS = 10;
const LOADING = /Updating…|Loading…/;
const CARD_BACKGROUND = '0x15151d';
const MASK_COLOR = '#2a2a36';

export type FootageMode = 'guarded' | 'off';

/** FOOTAGE=guarded turns the recorder on; anything else but "off" refuses. */
export function footageMode(env: Record<string, string | undefined> = process.env): FootageMode {
  const value = (env.FOOTAGE ?? '').trim().toLowerCase();
  if (value === 'guarded') return 'guarded';
  if (['', '0', 'off', 'no', 'false'].includes(value)) return 'off';
  throw new Error('FOOTAGE accepts only "guarded" (the reviewed redacting recorder) or "off". Raw capture is not admitted in the wallet suite.');
}

const LABEL = /^[A-Za-z][A-Za-z0-9 ,.'()&:#+-]{0,99}$/;

/**
 * A footage label is a short static phrase. A run of 24 or more letters and
 * digits is refused because that is what an address, npub, key or token looks
 * like, and a slash because that is what a URL looks like.
 */
export function assertStaticLabel(label: string): void {
  if (!LABEL.test(label) || /[A-Za-z0-9]{24,}/.test(label)) {
    throw new Error('Footage labels must be short static phrases, never values, URLs or keys.');
  }
}

/**
 * Check a step's label, then note it for the private failure log. The check
 * comes first, so a label this guard refuses is never kept as the step that
 * was running.
 */
function noteStaticStep(label: string): void {
  assertStaticLabel(label);
  noteStep(label);
}

/** Where a page is, by kind only. The URL itself is never recorded. */
export type Surface = 'wallet' | 'approval' | 'site' | 'local' | 'blank';
export function surfaceOf(url: string): Surface {
  if (url.startsWith('chrome-extension://')) return url.includes('#approval/') ? 'approval' : 'wallet';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return 'local';
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'site';
  } catch {
    /* about:blank and friends */
  }
  return 'blank';
}

export type FootageEntry =
  | { kind: 'recorder'; t: number; recorder: string; wallet: string; width: number; height: number }
  | { kind: 'frame'; t: number; recorder: string; file: string; verdict: 'clean' | 'mask'; masks: number; surface: Surface }
  | { kind: 'card'; t: number; recorder: string; caption: string; surface: Surface }
  | { kind: 'drop'; t: number; recorder: string; reason: string }
  | { kind: 'gap'; t: number; recorder: string }
  | { kind: 'stop'; t: number; recorder: string }
  | {
    kind: 'hold'; t: number; end: number; hold: HoldKind; label: string; recorder: string | null;
    /** How long the recording had shown the same frame when the hold ended; null for an unrecorded page. */
    static?: number | null;
  }
  | { kind: 'tap'; t: number; label: string; recorder: string | null; action?: InteractionKind }
  | { kind: 'secret'; t: number; end: number; label: string }
  | { kind: 'chapter'; t: number; label: string };

/** What an interaction entry records; each one gets the same settle-then-pause. */
export type InteractionKind = 'tap' | 'choose' | 'type' | 'press';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signature(verdict: LiveFrameVerdict): string {
  return `${verdict.mode}|${verdict.reasons.join(',')}|${verdict.masks}`;
}

function captionFor(verdict: LiveFrameVerdict): string {
  for (const reason of verdict.reasons) {
    const caption = LIVE_CARD_CAPTIONS[reason];
    if (caption) return caption;
  }
  return LIVE_CARD_CAPTIONS['protected surface'] ?? 'Protected screen hidden';
}

async function verdictOf(page: Page): Promise<LiveFrameVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(liveFrameVerdict, LIVE_RULES),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('guard timed out')), 5_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function maskLocators(page: Page): Locator[] {
  return [
    ...LIVE_RULES.maskSelectors.map((selector) => page.locator(selector)),
    page.locator(`[${LIVE_MASK_ATTRIBUTE}]`),
    page.getByText(new RegExp(LIVE_RULES.claimLinkText)),
  ];
}

class PageRecorder {
  private seq = 0;
  private lastHash = '';
  private carded: string | null = null;
  private cleanPasses = 0;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();
  readonly done: Promise<void>;
  /**
   * When the recording last changed: the timestamp of the newest frame or card
   * written for this page, or the attach time before the first. Holds measure
   * dead air from here, so they measure what the video shows.
   */
  lastChange: number;

  constructor(
    private readonly footage: GuardedFootage,
    readonly page: Page,
    readonly id: string,
    private readonly dir: string,
    readonly attachedAt: number,
  ) {
    this.lastChange = attachedAt;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    page.once('close', () => { this.stopped = true; });
    this.done = this.loop();
  }

  get isCarded(): boolean { return this.carded !== null; }
  get isLive(): boolean { return !this.stopped && !this.page.isClosed(); }

  /** Resolves once the frame in flight (if any) has finished. */
  idle(): Promise<void> { return this.inFlight; }

  stop(): Promise<void> {
    this.stopped = true;
    return this.done;
  }

  private async loop(): Promise<void> {
    while (this.isLive) {
      const started = Date.now();
      this.inFlight = this.frame().catch(() => {
        // An unreadable page (navigating, closing, busy) yields no frame. The
        // previous frame stands; nothing unguarded is ever written.
        this.footage.record({ kind: 'gap', t: Date.now(), recorder: this.id });
      });
      await this.inFlight;
      const rest = FRAME_INTERVAL_MS - (Date.now() - started);
      if (rest > 0) await sleep(rest);
    }
    this.footage.record({ kind: 'stop', t: Date.now(), recorder: this.id });
  }

  private card(caption: string, surface: Surface): void {
    this.cleanPasses = 0;
    if (this.carded === caption) return;
    this.carded = caption;
    this.lastHash = '';
    const t = Date.now();
    this.lastChange = t;
    this.footage.record({ kind: 'card', t, recorder: this.id, caption, surface });
  }

  private async frame(): Promise<void> {
    const surface = surfaceOf(this.page.url());
    const scope = this.footage.secretCaption();
    if (scope) return this.card(scope, surface);

    const first = await verdictOf(this.page);
    if (first.mode === 'card') return this.card(captionFor(first), surface);
    if (this.footage.canary.hit(first)) return this.card(LIVE_CARD_CAPTIONS['known secret'] ?? 'Secret hidden', surface);
    if (this.carded !== null) {
      this.cleanPasses += 1;
      if (this.cleanPasses < RESUME_CLEAN_PASSES) return;
      this.carded = null;
      this.cleanPasses = 0;
    }

    const t = Date.now();
    // Animations are paused for the shot, so a spinner or shimmer does not turn
    // a settled screen into a stream of new frames and eat its dead air.
    const shot = await this.page.screenshot({
      type: 'jpeg', quality: 85, timeout: 5_000, caret: 'hide', animations: 'disabled',
      mask: maskLocators(this.page), maskColor: MASK_COLOR,
    });
    const second = await verdictOf(this.page);
    if (this.footage.secretCaption() || signature(first) !== signature(second) || this.footage.canary.hit(second)) {
      this.footage.record({ kind: 'drop', t, recorder: this.id, reason: 'verdict changed during capture' });
      return;
    }
    const hash = createHash('sha256').update(shot).digest('hex');
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    this.seq += 1;
    const file = join(this.dir, `${String(this.seq).padStart(6, '0')}.jpg`);
    writeFileSync(file, shot, { mode: 0o600 });
    this.lastChange = t;
    this.footage.record({
      kind: 'frame', t, recorder: this.id, file: relative(this.footage.runDir, file),
      verdict: first.mode === 'mask' ? 'mask' : 'clean', masks: first.masks, surface,
    });
  }
}

export interface GuardedFootageOptions {
  mode: FootageMode;
  /** Output root; this run writes under `<root>/<runId>/<worker>`. */
  root: string;
  runId: string;
  worker: number;
  /** Device scale factor of the recorded contexts, for card sizes. */
  scale: number;
}

export class GuardedFootage {
  /** In-memory canary of known secrets. Holds keyed hashes only. */
  readonly canary: SecretCanary = createSecretCanary();
  readonly recording: boolean;
  readonly runDir: string;
  private readonly entries: FootageEntry[] = [];
  private readonly recorders: PageRecorder[] = [];
  private readonly attached = new WeakSet<Page>();
  private readonly perWallet = new Map<string, number>();
  private readonly facts: Record<string, string | number | boolean> = {};
  private readonly scopes: string[] = [];
  /** When each recorder's current frame last completed a settled or result hold. */
  private readonly settledAt = new Map<PageRecorder, number>();
  private readonly startedAt = Date.now();
  private stopped = false;

  constructor(private readonly options: GuardedFootageOptions) {
    this.recording = options.mode === 'guarded';
    this.runDir = join(options.root, options.runId, `worker-${options.worker}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
  }

  static fromEnv(worker: number, scale: number): GuardedFootage {
    return new GuardedFootage({
      mode: footageMode(),
      root: process.env.E2E_FOOTAGE_DIR ?? DEFAULT_FOOTAGE_DIR,
      runId: process.env.E2E_LIVE_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-'),
      worker,
      scale,
    });
  }

  /** @internal Recorders append here. */
  record(entry: FootageEntry): void {
    this.entries.push(entry);
  }

  /** Record every page this context has and opens, labelled with its wallet. */
  watch(context: BrowserContext, wallet: string): void {
    assertStaticLabel(wallet);
    for (const page of context.pages()) this.attach(page, wallet);
    context.on('page', (page) => this.attach(page, wallet));
  }

  attach(page: Page, wallet: string): void {
    if (!this.recording || this.stopped || this.attached.has(page)) return;
    this.attached.add(page);
    const n = (this.perWallet.get(wallet) ?? 0) + 1;
    this.perWallet.set(wallet, n);
    const id = `${wallet}-${n}`;
    const viewport = page.viewportSize() ?? { width: 380, height: 600 };
    const t = Date.now();
    this.record({
      kind: 'recorder', t, recorder: id, wallet,
      width: Math.round(viewport.width * this.options.scale), height: Math.round(viewport.height * this.options.scale),
    });
    this.recorders.push(new PageRecorder(this, page, id, join(this.runDir, 'frames', id), t));
  }

  private recorderFor(page: Page | undefined): PageRecorder | undefined {
    if (!page) return undefined;
    return this.recorders.find((recorder) => recorder.page === page);
  }

  private recorderOf(page: Page | undefined): string | null {
    return this.recorderFor(page)?.id ?? null;
  }

  /** True when the page's current frame has not yet been held for a settled period. */
  private needsSettle(recorder: PageRecorder): boolean {
    const at = this.settledAt.get(recorder);
    return at === undefined || recorder.lastChange > at;
  }

  /** The caption of the innermost open secret scope, or null. */
  secretCaption(): string | null {
    return this.scopes.length ? this.scopes[this.scopes.length - 1]! : null;
  }

  /**
   * Run `fn` with every recorder showing a card. Use it around phrase entry,
   * phrase reveal, password typing and claim-link transfer. Capture resumes
   * after the scope only once each page passes the guard twice in a row.
   */
  async secret<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    const t = Date.now();
    this.scopes.push(`${label} hidden`);
    // A frame already in flight finishes, and its second guard pass sees the
    // scope and drops it, before the caller can put a secret on screen.
    await Promise.all(this.recorders.map((recorder) => recorder.idle()));
    try {
      return await fn();
    } finally {
      this.scopes.pop();
      this.record({ kind: 'secret', t, end: Date.now(), label });
      await this.awaitResume();
    }
  }

  private async awaitResume(patience = 30_000): Promise<void> {
    if (!this.recording) return;
    const deadline = Date.now() + patience;
    while (Date.now() < deadline && this.recorders.some((recorder) => recorder.isLive && recorder.isCarded)) {
      await sleep(FRAME_INTERVAL_MS);
    }
    // A page still carded after the patience stays carded: that is the safe side.
  }

  /** A chapter marker for the composed video, e.g. the test title. */
  chapter(label: string): void {
    assertStaticLabel(label);
    this.record({ kind: 'chapter', t: Date.now(), label });
  }

  /** A non-secret fact about the run (a created user id, a claimed handle). */
  fact(key: string, value: string | number | boolean): void {
    assertStaticLabel(key);
    if (typeof value === 'string' && this.canary.hit({ text: value })) {
      throw new Error(`Refusing to record ${key}: it matches a known secret.`);
    }
    this.facts[key] = value;
    writeFileSync(join(this.runDir, 'run-facts.json'), `${JSON.stringify(this.facts, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Hold the page's recording static for the policy length of `kind`. The hold
   * lasts at least that long and ends only once the recording has shown one
   * unchanged frame for that long, so a screen that changes during the hold
   * starts its dead air again. It waits at most HOLD_OVERRUN_MS past the policy
   * for a screen that keeps changing, then gives up and `stop` reports it.
   * No-op when not recording.
   */
  async hold(kind: HoldKind, label: string, page?: Page): Promise<void> {
    assertStaticLabel(label);
    if (!this.recording) return;
    const required = HOLD_MS[kind];
    const recorder = this.recorderFor(page);
    const t = Date.now();
    const deadline = t + required + HOLD_OVERRUN_MS;
    let quietFor: number | null = null;
    for (;;) {
      const now = Date.now();
      const elapsed = now - t;
      if (!recorder?.isLive) {
        // An unrecorded or closed page: nothing to measure, so a plain pause.
        quietFor = null;
        if (elapsed >= required) break;
        await sleep(Math.min(required - elapsed, FRAME_INTERVAL_MS));
        continue;
      }
      const quiet = now - recorder.lastChange;
      if (elapsed >= required && quiet >= required) {
        // A frame still in flight carries an earlier timestamp. Let it land,
        // then decide, so the timeline never shows a change inside the hold.
        await recorder.idle();
        quietFor = Date.now() - recorder.lastChange;
        if (quietFor >= required) break;
        continue;
      }
      if (now >= deadline) {
        quietFor = quiet;
        break;
      }
      await sleep(Math.min(Math.max(required - elapsed, required - quiet, 50), FRAME_INTERVAL_MS));
    }
    const end = Date.now();
    if (recorder && quietFor !== null && quietFor >= required && kind !== 'preTap') this.settledAt.set(recorder, end);
    this.record({ kind: 'hold', t, end, hold: kind, label, recorder: recorder?.id ?? null, static: quietFor });
  }

  /** Wait for loading text to clear, then hold for the settled period. */
  async settled(page: Page, label: string): Promise<void> {
    noteStaticStep(label);
    await waitForQuiet(page);
    await this.hold('settled', label, page);
  }

  /** Wait for loading text to clear, then hold a key result on screen. */
  async result(page: Page, label: string): Promise<void> {
    noteStaticStep(label);
    await waitForQuiet(page);
    await this.hold('result', label, page);
  }

  /**
   * Hold every open page whose current frame has not had its settled period,
   * all at once. The live lane calls this at the end of every test, so the last
   * screen of a step gets its dead air even when no tap follows it.
   */
  async settleAll(label = 'last screen of the step'): Promise<void> {
    if (!this.recording || this.stopped) return;
    const pending = this.recorders.filter((recorder) => recorder.isLive && this.needsSettle(recorder));
    await Promise.all(pending.map((recorder) => this.settled(recorder.page, label)));
  }

  /**
   * Before any interaction: settle the screen if its current frame has not been
   * held for the settled period, then the pre-tap pause. A screen that changes
   * during the pause is settled again, a bounded number of times.
   */
  private async beforeInteraction(page: Page, label: string): Promise<void> {
    if (!this.recording) return;
    const recorder = this.recorderFor(page);
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      if (recorder?.isLive && this.needsSettle(recorder)) await this.settled(page, 'screen settled before a tap');
      await this.hold('preTap', label, page);
      if (!recorder?.isLive || !this.needsSettle(recorder)) return;
    }
  }

  private interaction(action: InteractionKind, page: Page, label: string): void {
    this.record({ kind: 'tap', t: Date.now(), label, recorder: this.recorderOf(page), action });
  }

  /** The only way a live spec clicks: wait for the target, settle, pause, then click. */
  async tap(target: Locator, label: string, options: { force?: boolean } = {}): Promise<void> {
    noteStaticStep(label);
    await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await target.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    await this.beforeInteraction(target.page(), label);
    this.interaction('tap', target.page(), label);
    await target.click({ timeout: ACTION_TIMEOUT_MS, ...(options.force ? { force: true } : {}) });
  }

  /** Tap a checkbox only when its state differs. Returns whether it changed. */
  async setChecked(target: Locator, checked: boolean, label: string): Promise<boolean> {
    await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    if ((await target.isChecked({ timeout: ACTION_TIMEOUT_MS })) === checked) return false;
    await this.tap(target, label);
    return true;
  }

  /** Choose an option of a select element, after the settle and the pre-tap pause. */
  async choose(target: Locator, value: string, label: string): Promise<void> {
    noteStaticStep(label);
    await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await this.beforeInteraction(target.page(), label);
    this.interaction('choose', target.page(), label);
    await target.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
  }

  /** Type ordinary, non-secret text (a handle). Refuses a known secret. */
  async type(target: Locator, text: string, label: string): Promise<void> {
    noteStaticStep(label);
    if (this.canary.hit({ values: [text], text })) {
      throw new Error('Refusing to type a known secret in the open; use footage.secret with secretFill.');
    }
    await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await this.beforeInteraction(target.page(), label);
    this.interaction('type', target.page(), label);
    await target.fill(text, { timeout: ACTION_TIMEOUT_MS });
  }

  /** Fill a secret. Allowed only inside `secret(...)`, so no frame shows it. */
  async secretFill(target: Locator, value: string, label: string): Promise<void> {
    noteStaticStep(label);
    if (!this.secretCaption()) throw new Error('secretFill runs only inside footage.secret(...).');
    await target.fill(value, { timeout: ACTION_TIMEOUT_MS });
  }

  /** Press a key on the page, after the settle and the pre-tap pause. */
  async press(page: Page, key: string, label: string): Promise<void> {
    noteStaticStep(label);
    await this.beforeInteraction(page, label);
    this.interaction('press', page, label);
    await page.keyboard.press(key);
  }

  /** Card captions written while any recorder was carded. */
  cardsSince(t: number): string[] {
    return this.entries.filter((entry): entry is Extract<FootageEntry, { kind: 'card' }> => entry.kind === 'card' && entry.t >= t)
      .map((entry) => entry.caption);
  }

  /** Frames captured since `t` while a recorder showed `surface`. */
  framesSince(t: number): number {
    return this.entries.filter((entry) => entry.kind === 'frame' && entry.t >= t).length;
  }

  /**
   * Stop every recorder, write the timeline, check the dead-air policy on the
   * recorded frames and encode one video per recorded page. Throws after
   * writing, with the cause, if the policy was broken or a video is not real time.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all(this.recorders.map((recorder) => recorder.stop()));
    const policy = checkHoldPolicy(this.entries);
    writeFileSync(join(this.runDir, 'timeline.json'), `${JSON.stringify({
      version: 2,
      policy: {
        holdMs: HOLD_MS, frameIntervalMs: FRAME_INTERVAL_MS, resumeCleanPasses: RESUME_CLEAN_PASSES,
        holdOverrunMs: HOLD_OVERRUN_MS, toleranceMs: POLICY_TOLERANCE_MS,
      },
      startedAt: this.startedAt,
      stoppedAt: Date.now(),
      entries: this.entries,
    }, null, 1)}\n`, { mode: 0o600 });
    writeFileSync(join(this.runDir, 'policy.json'), `${JSON.stringify(policy, null, 1)}\n`, { mode: 0o600 });
    this.writeChapters();
    const problems: string[] = [];
    if (policy.violations.length) problems.push(describeViolations(policy.violations));
    if (this.recording && process.env.FOOTAGE_ENCODE !== '0') {
      const failed = encodeRecorders(this.runDir, this.entries).filter((result) => !result.realTime);
      if (failed.length) {
        problems.push(`${failed.length} page video(s) did not encode at real time (${failed.map((result) => result.recorder).join(', ')}); frames and the timeline are kept`);
      }
    }
    // One line, tagged, so the live reporter can show it: the private reporter
    // withholds runner errors, and these carry only static labels and counts.
    if (problems.length) throw new Error(`[guarded footage] ${problems.join('; ')}.`);
  }

  private writeChapters(): void {
    const stamp = (t: number) => {
      const s = Math.max(0, Math.round((t - this.startedAt) / 1000));
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const lines = this.entries.filter((entry): entry is Extract<FootageEntry, { kind: 'chapter' }> => entry.kind === 'chapter')
      .map((entry) => `${stamp(entry.t)} ${entry.label}`);
    writeFileSync(join(this.runDir, 'chapters.txt'), `${lines.join('\n')}\n`, { mode: 0o600 });
  }
}

/** Wait (bounded, never throwing) for the page's loading text to clear. */
export async function waitForQuiet(page: Page, patience = 60_000): Promise<void> {
  if (page.isClosed()) return;
  await page.locator('#root').filter({ hasText: LOADING })
    .waitFor({ state: 'detached', timeout: patience }).catch(() => {});
}

const FONTS = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf',
];

function ffmpeg(args: string[]): boolean {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  return result.status === 0;
}

/**
 * One MP4 per recorded page at real time (1.0x, nothing trimmed): each frame
 * lasts until the next change, a card lasts until capture resumed. The
 * three-column composition with captions is scripts/process-footage.mjs's job;
 * these per-page files are its inputs and a usable review copy on their own.
 */
function encodeRecorders(runDir: string, entries: FootageEntry[]): EncodeResult[] {
  const report: EncodeResult[] = [];
  const font = FONTS.find((file) => existsSync(file));
  const videoDir = join(runDir, 'video');
  const cardDir = join(runDir, 'cards');
  mkdirSync(videoDir, { recursive: true, mode: 0o700 });
  mkdirSync(cardDir, { recursive: true, mode: 0o700 });
  const cards = new Map<string, string>();
  const cardImage = (caption: string, width: number, height: number): string => {
    const key = `${caption}|${width}x${height}`;
    const known = cards.get(key);
    if (known) return known;
    // Same codec, size and pixel format as the frames (JPEG, 4:2:0). The concat
    // demuxer decodes every entry with the first file's codec, so a PNG card is
    // dropped; and a format change reinitialises the filter graph, which resets
    // the fps filter and shifts every later frame.
    const file = join(cardDir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.jpg`);
    const text = caption.replace(/[\\':]/g, ' ');
    const draw = font ? `,drawtext=fontfile='${font}':text='${text}':fontcolor=0xd8d8e0:fontsize=${Math.round(width / 18)}:x=(w-text_w)/2:y=(h-text_h)/2` : '';
    const source = ['-f', 'lavfi', '-i', `color=c=${CARD_BACKGROUND}:s=${width}x${height}`, '-frames:v', '1'];
    if (!ffmpeg([...source, '-vf', `format=rgb24${draw},format=yuvj420p`, '-q:v', '2', file])) {
      ffmpeg([...source, '-vf', 'format=yuvj420p', '-q:v', '2', file]);
    }
    if (existsSync(file)) chmodSync(file, 0o600);
    cards.set(key, file);
    return file;
  };
  for (const recorder of entries.filter((entry): entry is Extract<FootageEntry, { kind: 'recorder' }> => entry.kind === 'recorder')) {
    const timeline = entries
      .filter((entry) => (entry.kind === 'frame' || entry.kind === 'card') && entry.recorder === recorder.recorder)
      .sort((a, b) => a.t - b.t) as Array<Extract<FootageEntry, { kind: 'frame' | 'card' }>>;
    if (!timeline.length) continue;
    const end = entries.find((entry) => entry.kind === 'stop' && entry.recorder === recorder.recorder)?.t ?? timeline[timeline.length - 1]!.t + 1_000;
    const lines = ['ffconcat version 1.0'];
    let last = '';
    timeline.forEach((entry, i) => {
      const image = entry.kind === 'frame' ? join(runDir, entry.file) : cardImage(entry.caption, recorder.width, recorder.height);
      const until = i + 1 < timeline.length ? timeline[i + 1]!.t : end;
      lines.push(`file '${image.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.04, (until - entry.t) / 1000).toFixed(3)}`);
      last = image;
    });
    lines.push(`file '${last.replace(/'/g, "'\\''")}'`);
    const list = join(videoDir, `${recorder.recorder}.ffconcat`);
    writeFileSync(list, `${lines.join('\n')}\n`, { mode: 0o600 });
    const { width: w, height: h } = recorder;
    const video = join(videoDir, `${recorder.recorder}.mp4`);
    // The last file is listed twice (older ffmpeg needs that to honour its
    // duration; newer ffmpeg then adds it twice), so cap the output at the
    // timeline's exact length: real time on either version.
    const seconds = Math.max(0.1, (end - timeline[0]!.t) / 1000);
    // Constant 10 fps: capture runs at about 4 fps, so no timing is lost, and a
    // twelve-hour page encodes in minutes rather than the better part of an hour
    // at 30 fps. Variable frame rate would be smaller still, but the concat
    // demuxer drops the last segment's duration there, so it is not real time.
    const encoded = ffmpeg(['-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${CARD_BACKGROUND},fps=${ENCODE_FPS},format=yuv420p`,
      '-t', seconds.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20',
      '-movflags', '+faststart', video]);
    if (existsSync(video)) chmodSync(video, 0o600);
    rmSync(list, { force: true });
    // Evidence from the file itself, not from ffmpeg's exit status.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' });
    const videoSeconds = encoded && probe.status === 0 ? Number(probe.stdout.trim()) : null;
    report.push({
      recorder: recorder.recorder,
      expectedSeconds: Number(seconds.toFixed(3)),
      videoSeconds,
      realTime: videoSeconds !== null && Math.abs(videoSeconds - seconds) <= 1,
    });
  }
  writeFileSync(join(videoDir, 'encode.json'), `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
  return report;
}

export interface EncodeResult {
  recorder: string;
  expectedSeconds: number;
  videoSeconds: number | null;
  realTime: boolean;
}

/** Read back a run's timeline (for tests and the composer). */
export function readTimeline(runDir: string): { entries: FootageEntry[] } {
  return JSON.parse(readFileSync(join(runDir, 'timeline.json'), 'utf8')) as { entries: FootageEntry[] };
}
