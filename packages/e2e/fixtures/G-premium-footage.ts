/**
 * Guarded footage for the G-premium live lane.
 *
 * Playwright's own trace, screenshot and video stay off (PRIVATE_USE): they
 * cannot be guarded frame by frame. This recorder takes its own screenshots of
 * each wallet page and of every window the wallets open, about four a second,
 * and keeps a frame only when the guard (G-premium-guard.mjs) and the in-memory
 * canary agree before and after the shot:
 *
 *   - a phrase, key or claim-link surface, or a canary hit, becomes a static
 *     redaction card (no pixels kept);
 *   - password, tx-key and nsec fields are painted over by screenshot masks;
 *   - identical frames are stored once, with their time span, so long static
 *     holds cost no disk.
 *
 * The owner's VIDEO POLICY is enforced here, never by ad hoc sleeps in specs:
 * every tap is preceded by a static pause, settled screens and key results are
 * held, and every hold is written to the timeline so processing can refuse a
 * run whose holds are shorter than policy. Labels are static strings; they are
 * checked so a value or URL cannot slip into a caption.
 *
 * Recording is opt-in (FOOTAGE=guarded). Without it the helpers still run the
 * guard and keep the flow human-paced, but write nothing and shorten the holds.
 * `observe` is the exception: its length is part of what a spec checks (nothing
 * else happens for 40 s; a payment settles), so it waits the same either way.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { MASK_SELECTORS, PREMIUM_GUARD, frameVerdict, type FrameVerdictKind } from './G-premium-guard.mjs';
import { sleepAtLeast } from './hold-timer.mjs';
import { noteStep } from './failure-context.js';
import { RC_FOOTAGE_ROOT } from './release-candidate.mjs';

/** Static pause before every tap or entry, so each action reads on video. */
export const TAP_PAUSE_MS = 6_000;
/** Hold for every settled screen. */
export const SETTLED_HOLD_MS = 12_000;
/** Hold for key results: balances, confirmations, invoice states, activation. */
export const RESULT_HOLD_MS = 25_000;
/** About four frames a second per page; identical frames are deduplicated. */
export const FRAME_INTERVAL_MS = 250;
/** Clean guard passes needed before a secret scope gives the screen back. */
export const RESUME_CLEAN_PASSES = 2;
/** Without recording there is nothing to hold for; keep the flow human-paced. */
export const UNRECORDED_PAUSE_MS = 400;

export const AREA = 'G-premium';
export const DEFAULT_FOOTAGE_ROOT = RC_FOOTAGE_ROOT;

export type HoldKind = 'tap' | 'type' | 'close' | 'settled' | 'result';
/** Policy minimum per hold kind; the processor refuses anything shorter. */
export const HOLD_MINIMUM_MS: Readonly<Record<HoldKind, number>> = Object.freeze({
  tap: TAP_PAUSE_MS,
  type: TAP_PAUSE_MS,
  close: TAP_PAUSE_MS,
  settled: SETTLED_HOLD_MS,
  result: RESULT_HOLD_MS,
});

/** FOOTAGE=guarded turns recording on; anything else but unset refuses. */
export function footageRequested(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.FOOTAGE ?? '').trim();
  if (value === '' || value === 'off') return false;
  if (value === 'guarded') return true;
  throw new Error('FOOTAGE accepts only "guarded"; no other capture mode is reviewed for wallet runs.');
}

/**
 * A caption or chapter label must be a short static phrase: no URL, no long
 * token, no long number. Specs pass literals; this catches a value slipping in.
 */
export function assertStaticLabel(label: string): void {
  const ok = /^[A-Za-z][A-Za-z0-9 ,.'()&:+-]{0,79}$/.test(label)
    && !/:\/\//.test(label)
    && !/\d{5,}/.test(label)
    // An id: a long token, or a shorter one that mixes in digits.
    && !/[A-Za-z0-9_-]{24,}/.test(label)
    && !/\b(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{10,}/.test(label);
  if (!ok) throw new Error('Footage labels must be short static phrases, never values, ids or URLs.');
}

/** Track names become file paths and lane titles: lowercase words only. */
export function assertTrackName(name: string): void {
  if (!/^[a-z]+(-[a-z0-9]+){0,4}$/.test(name)) throw new Error('Footage track names are lowercase words joined by hyphens.');
}

/**
 * Known-secret canary, in memory only. The wallet password is compared as a
 * plain substring (the fixture needs it for unlocks anyway). A recovery phrase
 * is never kept: only salted hashes of its consecutive word triples, so any
 * three phrase words shown in order trip it, while ordinary words do not.
 */
export class SecretCanary {
  readonly #salt = randomBytes(16);
  readonly #grams = new Set<string>();
  readonly #values: string[] = [];
  readonly #recent = new Map<string, boolean>();

  #gram(a: string, b: string, c: string): string {
    return createHash('sha256').update(this.#salt).update(`${a} ${b} ${c}`).digest('base64');
  }

  addValue(value: string): void {
    if (value.length >= 8) this.#values.push(value);
  }

  addPhrase(words: readonly string[]): void {
    for (let i = 0; i + 2 < words.length; i++) this.#grams.add(this.#gram(words[i]!, words[i + 1]!, words[i + 2]!));
  }

  /** True when a known secret appears in the text or values. Never says which. */
  hit(text: string, values: readonly string[]): boolean {
    for (const secret of this.#values) {
      if (text.includes(secret) || values.some((value) => value.includes(secret))) return true;
    }
    if (this.#grams.size === 0) return false;
    const corpus = [text, ...values].join('\n').toLowerCase();
    const key = createHash('sha256').update(corpus).digest('base64');
    const cached = this.#recent.get(key);
    if (cached !== undefined) return cached;
    const tokens = corpus.match(/[a-z]+/g) ?? [];
    let found = false;
    for (let i = 0; i + 2 < tokens.length && !found; i++) found = this.#grams.has(this.#gram(tokens[i]!, tokens[i + 1]!, tokens[i + 2]!));
    if (this.#recent.size > 64) this.#recent.clear();
    this.#recent.set(key, found);
    return found;
  }

  clear(): void {
    this.#values.length = 0;
    this.#grams.clear();
    this.#recent.clear();
  }
}

export interface Segment {
  from: number;
  to: number;
  verdict: FrameVerdictKind;
  /** Frame image, relative to the run directory. Absent on a card. */
  file?: string;
  /** Redaction card caption (a static label). Present only on a card. */
  card?: string;
  hash?: string;
}

interface Track {
  name: string;
  /** Frame directory, fixed at attach time so a rename keeps its files. */
  dir: string;
  wallet: string;
  role: 'main' | 'secondary';
  page: Page;
  startedAt: number;
  endedAt?: number;
  segments: Segment[];
  seq: number;
  stopped: boolean;
  loop?: Promise<void> | undefined;
  inflight?: Promise<void> | undefined;
}

export interface Hold {
  kind: HoldKind;
  label: string;
  track: string;
  from: number;
  to: number;
  ms: number;
  /** Set on a tap whose pause came after it: a recorded policy exception. */
  after?: true;
}
/** Where the run departed from the order of the policy, and why. */
export interface PolicyException { label: string; track: string; at: number; rule: 'pause-after-tap' }
export interface Mark { label: string; wallet: string; at: number }

interface Inspection { kind: FrameVerdictKind; filledSecret: boolean }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export class GuardedFootage {
  readonly recording: boolean;
  readonly canary = new SecretCanary();
  readonly runDir: string | null;
  readonly startedAt = Date.now();
  #tracks = new Map<Page, Track>();
  #holds: Hold[] = [];
  #marks: Mark[] = [];
  #focus: Array<{ track: string; at: number }> = [];
  #evidence: Record<string, string | number | boolean> = {};
  #secretLabels: string[] = [];
  #secrets: Array<{ label: string; from: number; to: number }> = [];
  #exceptions: PolicyException[] = [];
  #dropped = 0;
  #closed = false;
  #flushTimer: NodeJS.Timeout | undefined;
  #tabCount = new Map<string, number>();

  constructor(options: { recording: boolean; root?: string }) {
    this.recording = options.recording;
    if (!this.recording) {
      this.runDir = null;
      return;
    }
    const root = options.root ?? process.env.FOOTAGE_DIR ?? DEFAULT_FOOTAGE_ROOT;
    const stamp = new Date(this.startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    privateDir(root);
    privateDir(join(root, AREA));
    this.runDir = join(root, AREA, stamp);
    privateDir(this.runDir);
    this.#flushTimer = setInterval(() => this.#writeTimeline(), 30_000);
    this.#flushTimer.unref();
  }

  // ── tracks ────────────────────────────────────────────────────────────────

  /** Record this page as `name`. Re-attaching renames (for a second window). */
  attach(page: Page, options: { name: string; wallet: string; role: 'main' | 'secondary' }): void {
    assertTrackName(options.name);
    assertTrackName(options.wallet);
    const existing = this.#tracks.get(page);
    if ([...this.#tracks.values()].some((track) => track.name === options.name && track !== existing)) {
      throw new Error('Footage track names must be unique within a run.');
    }
    if (existing) {
      existing.name = options.name;
      existing.role = options.role;
      return;
    }
    const track: Track = { ...options, dir: options.name, page, startedAt: Date.now(), segments: [], seq: 0, stopped: false };
    this.#tracks.set(page, track);
    this.#focus.push({ track: track.dir, at: track.startedAt });
    page.once('close', () => {
      track.stopped = true;
      track.endedAt = Date.now();
    });
    if (this.recording && this.runDir) {
      privateDir(join(this.runDir, track.dir));
      track.loop = this.#run(track);
    }
  }

  /** Every window a wallet opens later (checkout tabs, a second wallet window). */
  watch(context: BrowserContext, wallet: string): void {
    context.on('page', (page) => {
      if (this.#tracks.has(page)) return;
      const n = (this.#tabCount.get(wallet) ?? 0) + 1;
      this.#tabCount.set(wallet, n);
      this.attach(page, { name: `${wallet}-window-${n}`, wallet, role: 'secondary' });
    });
  }

  /** The lane composer follows the page acted on most recently. */
  focus(page: Page): void {
    const track = this.#tracks.get(page);
    if (track) this.#focus.push({ track: track.dir, at: Date.now() });
  }

  #trackName(page: Page): string {
    return this.#tracks.get(page)?.dir ?? 'untracked';
  }

  // ── capture loop ──────────────────────────────────────────────────────────

  async #inspect(page: Page): Promise<Inspection> {
    const seen = await page.evaluate(frameVerdict, PREMIUM_GUARD);
    if (seen.verdict === 'card' || this.canary.hit(seen.text, seen.values)) {
      return { kind: 'card', filledSecret: seen.filledSecret };
    }
    return { kind: seen.verdict, filledSecret: seen.filledSecret };
  }

  async #run(track: Track): Promise<void> {
    while (!track.stopped && !this.#closed) {
      const begun = Date.now();
      const capture = this.#captureOnce(track).catch(() => {
        if (!track.page.isClosed()) this.#dropped++;
      });
      track.inflight = capture;
      await capture;
      track.inflight = undefined;
      const wait = FRAME_INTERVAL_MS - (Date.now() - begun);
      if (wait > 0) await sleep(wait);
    }
    const last = track.segments.at(-1);
    if (last) last.to = track.endedAt ?? Date.now();
  }

  async #captureOnce(track: Track): Promise<void> {
    const at = Date.now();
    if (this.#secretLabels.length) return this.#pushCard(track, at, this.#secretLabels.at(-1)!);
    const before = await this.#inspect(track.page);
    if (before.kind === 'card') return this.#pushCard(track, at, 'Protected screen hidden');
    const shot = await track.page.screenshot({
      type: 'jpeg',
      quality: 85,
      mask: [track.page.locator(MASK_SELECTORS.join(', '))],
      maskColor: '#1b1b1f',
      caret: 'hide',
      timeout: 10_000,
    });
    // A secret scope that began while the shot was taken voids it.
    if (this.#secretLabels.length) return this.#pushCard(track, at, this.#secretLabels.at(-1)!);
    const after = await this.#inspect(track.page);
    if (after.kind !== before.kind) {
      this.#dropped++;
      return;
    }
    this.#pushFrame(track, at, shot, before.kind);
  }

  #pushFrame(track: Track, at: number, shot: Buffer, verdict: FrameVerdictKind): void {
    const hash = createHash('sha256').update(shot).digest('hex');
    const last = track.segments.at(-1);
    if (last && last.hash === hash && last.verdict === verdict) {
      last.to = at;
      return;
    }
    if (last) last.to = at;
    const file = join(track.dir, `${String(track.seq++).padStart(6, '0')}.jpg`);
    writeFileSync(join(this.runDir!, file), shot, { mode: 0o600 });
    track.segments.push({ from: at, to: at, verdict, file, hash });
  }

  #pushCard(track: Track, at: number, label: string): void {
    const last = track.segments.at(-1);
    if (last && last.verdict === 'card' && last.card === label) {
      last.to = at;
      return;
    }
    if (last) last.to = at;
    track.segments.push({ from: at, to: at, verdict: 'card', card: label });
  }

  // ── policy helpers (the only way specs act on a page) ─────────────────────

  async #pause(ms: number): Promise<number> {
    const from = Date.now();
    // Never a timer tick short: processing compares this with the policy.
    await sleepAtLeast(this.recording ? ms : UNRECORDED_PAUSE_MS);
    return Date.now() - from;
  }

  #hold(kind: HoldKind, label: string, page: Page, from: number, ms: number, after = false): void {
    if (!this.recording) return;
    this.#holds.push({ kind, label, track: this.#trackName(page), from, to: Date.now(), ms, ...(after ? { after: true as const } : {}) });
  }

  async #refuseOnSecret(page: Page, label: string): Promise<void> {
    if (this.#secretLabels.length) return;
    const seen = await this.#inspect(page);
    if (seen.kind === 'card') throw new Error(`Refusing "${label}": a protected surface is visible outside a secret scope.`);
  }

  /** Hold the screen still, check it, then tap. */
  async tap(target: Locator, label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    const page = target.page();
    await target.waitFor({ state: 'visible', timeout: 60_000 });
    this.focus(page);
    const from = Date.now();
    const ms = await this.#pause(TAP_PAUSE_MS);
    await this.#refuseOnSecret(page, label);
    this.#hold('tap', label, page, from, ms);
    await target.click({ timeout: 60_000 });
  }

  /**
   * Policy exception: tap at once, then hold the same pause after the tap.
   * Only for a control the app takes away on a timer (the send receipt closes
   * itself after 12 s), where a pause before the tap would lose the screen.
   * The hold is recorded with `after` and listed as an exception, so the
   * timeline shows where the order was reversed. Returns false, without
   * tapping, when the control is already gone.
   */
  async tapThenHold(target: Locator, label: string): Promise<boolean> {
    assertStaticLabel(label);
    noteStep(label);
    const page = target.page();
    if (!(await target.isVisible().catch(() => false))) return false;
    this.focus(page);
    await this.#refuseOnSecret(page, label);
    const tapped = await target.click({ timeout: 2_000 }).then(() => true, () => false);
    if (!tapped) return false;
    const from = Date.now();
    const ms = await this.#pause(TAP_PAUSE_MS);
    this.#hold('tap', label, page, from, ms, true);
    if (this.recording) this.#exceptions.push({ label, track: this.#trackName(page), at: from, rule: 'pause-after-tap' });
    return true;
  }

  /** Hold, then type non-secret text. A known secret here is a spec bug. */
  async type(target: Locator, text: string, label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    if (this.canary.hit(text, [])) throw new Error(`Refusing "${label}": that text is a known secret; use a secret scope.`);
    const page = target.page();
    await target.waitFor({ state: 'visible', timeout: 60_000 });
    this.focus(page);
    const from = Date.now();
    const ms = await this.#pause(TAP_PAUSE_MS);
    await this.#refuseOnSecret(page, label);
    this.#hold('type', label, page, from, ms);
    await target.fill(text, { timeout: 60_000 });
  }

  /** Hold, then close a window the run opened (a checkout tab, a second window). */
  async closePage(page: Page, label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    this.focus(page);
    const from = Date.now();
    const ms = await this.#pause(TAP_PAUSE_MS);
    this.#hold('close', label, page, from, ms);
    await page.close();
  }

  /** Wait for loading indicators to clear, then hold the settled screen. */
  async settled(page: Page, label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    this.focus(page);
    await page.locator('#root').filter({ hasText: /Updating…|Loading/ })
      .waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    const from = Date.now();
    const ms = await this.#pause(SETTLED_HOLD_MS);
    this.#hold('settled', label, page, from, ms);
  }

  /** Hold a key result on screen. */
  async result(page: Page, label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    this.focus(page);
    const from = Date.now();
    const ms = await this.#pause(RESULT_HOLD_MS);
    this.#hold('result', label, page, from, ms);
  }

  /**
   * Watch the screen for a fixed time, recorded or not. For waits that are
   * themselves the check, such as "nothing else is asked for 40 s" or one
   * round of waiting for a payment to settle, so neither the assertion nor
   * the load on the backend depends on FOOTAGE. Recorded as a result hold, at
   * least RESULT_HOLD_MS long.
   */
  async observe(page: Page, ms: number, label: string): Promise<void> {
    assertStaticLabel(label);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('An observation needs a positive duration.');
    this.focus(page);
    const from = Date.now();
    // sleepAtLeast, not a bare timer: Node's timers can fire a millisecond
    // before the wall clock agrees, and an observation that is itself the
    // check must not end short of the time it promised (hold-timer.mjs).
    await sleepAtLeast(this.recording ? Math.max(ms, RESULT_HOLD_MS) : ms);
    this.#hold('result', label, page, from, Date.now() - from);
  }

  /** A chapter and caption: the operation, and the wallet doing it. */
  mark(label: string, wallet: string): void {
    assertStaticLabel(label);
    assertTrackName(wallet);
    this.#marks.push({ label, wallet, at: Date.now() });
  }

  /** Non-secret run evidence (txid, amounts, invoice states), kept beside the timeline. */
  evidence(key: string, value: string | number | boolean): void {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) throw new Error('Evidence keys are lowercase identifiers.');
    if (typeof value === 'string' && this.canary.hit(value, [])) throw new Error('Refusing to record a known secret as evidence.');
    this.#evidence[key] = value;
  }

  /**
   * Every recorder shows a redaction card while `fn` runs (phrase entry,
   * password typing). The screen comes back only after two consecutive clean
   * guard passes on every open page; otherwise the card stays and this throws.
   */
  async secret<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    this.#secretLabels.push(label);
    const scope = { label, from: Date.now(), to: Date.now() };
    this.#secrets.push(scope);
    // A shot already in flight finishes (and is voided) before the secret appears.
    await Promise.all([...this.#tracks.values()].map((track) => track.inflight));
    let completed = false;
    try {
      const value = await fn();
      completed = true;
      return value;
    } finally {
      const clean = await this.#cleanPasses(completed ? 60_000 : 10_000);
      scope.to = Date.now();
      if (clean) this.#secretLabels.pop();
      else if (completed) throw new Error(`A protected surface stayed visible after "${label}"; the redaction card stays up.`);
    }
  }

  async #cleanPasses(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let passes = 0;
    while (Date.now() < deadline) {
      const pages = [...this.#tracks.values()].filter((track) => !track.stopped && !track.page.isClosed()).map((track) => track.page);
      let clean = true;
      for (const page of pages) {
        const seen = await this.#inspect(page).catch(() => ({ kind: 'card' as const, filledSecret: true }));
        if (seen.kind === 'card' || seen.filledSecret) clean = false;
      }
      passes = clean ? passes + 1 : 0;
      if (passes >= RESUME_CLEAN_PASSES) return true;
      await sleep(FRAME_INTERVAL_MS);
    }
    return false;
  }

  // ── output ────────────────────────────────────────────────────────────────

  #writeTimeline(): void {
    if (!this.runDir) return;
    const timeline = {
      area: AREA,
      schema: 1,
      version: process.env.LIVE_EXPECT_VERSION ?? '0.3.1',
      startedAt: this.startedAt,
      endedAt: Date.now(),
      policy: {
        tapPauseMs: TAP_PAUSE_MS,
        settledHoldMs: SETTLED_HOLD_MS,
        resultHoldMs: RESULT_HOLD_MS,
        frameIntervalMs: FRAME_INTERVAL_MS,
        holdMinimumMs: HOLD_MINIMUM_MS,
      },
      tracks: [...this.#tracks.values()].map((track) => ({
        name: track.name,
        dir: track.dir,
        wallet: track.wallet,
        role: track.role,
        startedAt: track.startedAt,
        endedAt: track.endedAt ?? null,
        segments: track.segments.map(({ hash: _hash, ...segment }) => segment),
      })),
      focus: this.#focus,
      holds: this.#holds,
      exceptions: this.#exceptions,
      secrets: this.#secrets,
      marks: this.#marks,
      dropped: this.#dropped,
    };
    const target = join(this.runDir, 'timeline.json');
    writeFileSync(`${target}.tmp`, JSON.stringify(timeline), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
    writeFileSync(join(this.runDir, 'evidence.json'), JSON.stringify(this.#evidence, null, 1), { mode: 0o600 });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    await Promise.all([...this.#tracks.values()].map((track) => track.loop));
    for (const track of this.#tracks.values()) track.endedAt ??= Date.now();
    this.#writeTimeline();
    this.canary.clear();
  }
}
