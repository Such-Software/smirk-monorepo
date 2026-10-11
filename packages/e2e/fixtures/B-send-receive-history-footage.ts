/**
 * Guarded footage for the send, receive and history lane.
 *
 * VIDEO POLICY (owner requirement), enforced here and nowhere else:
 *   - 6 s of static screen before every tap or field entry (HOLD_BEFORE_TAP_MS);
 *   - every settled screen held for 12 s (HOLD_SETTLED_MS);
 *   - key results (balances, confirmations, history detail, a received
 *     payment) held for 25 s (HOLD_RESULT_MS);
 *   - no secret ever reaches a frame.
 *
 * Specs never sleep or click directly; they call `tap`, `fill`, `settled`,
 * `result`, `secret` and `pollWait`, so the dead air is a property of the
 * fixture and the timeline records every hold for the encoder to verify
 * (scripts/B-send-receive-history-footage.mjs refuses a hold shorter than
 * policy, and a tap whose screen was never held).
 *
 * Every screen a tap or entry acts on is held first: if nothing called
 * `settled` or `result` since the previous tap (or since the recorder or a
 * secret scope started), `tap` and `fill` hold the screen as settled before
 * their own 6 s pause. Specs still call `settled` where a screen has a name
 * worth a caption; the hooks guarantee the rest.
 *
 * One exception, and only one: a screen that counts itself down (the send
 * receipt's "Done (12)") cannot be held static, so its "Stay on this screen"
 * tap is `urgent: 'countdown'`: no pause before it, recorded as such, and the
 * screen it leaves behind is then held as settled. The encoder accepts an
 * urgent tap only with that reason and only when a settled hold follows.
 *
 * Recording is a screenshot loop per page, not Playwright video or trace
 * (both stay off, because neither can be guarded frame by frame). Each frame:
 * guard, screenshot with masks, guard again, known-secret canary. Any refusal
 * or disagreement writes a redaction card instead of the frame. Identical
 * frames are deduplicated by hash, so long holds cost no disk. `secret(label,
 * fn)` switches the page to a card before a password or phrase is typed and
 * resumes only after two consecutive clean guard passes.
 *
 * Recording is opt-in: FOOTAGE=guarded. Without it the hooks still act (taps,
 * fills, busy waits) but skip the video holds and write no frames. Poll waits
 * (`pollWait`, the pause between two looks at the chain) are not video holds
 * and always apply, so FOOTAGE=off polls at the same pace as a recorded run.
 *
 * Labels are static strings. `assertStaticLabel` refuses anything that looks
 * like an address, a transaction id or a URL, so a value can never become a
 * caption.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  B_EXTRA,
  B_PATTERNS,
  MASK_SELECTORS,
  canarySnapshot,
  extraSecretSurface,
  secretSurface,
} from './B-send-receive-history-guard.mjs';
import { noteStep } from './failure-context.js';

export const HOLD_BEFORE_TAP_MS = 6_000;
export const HOLD_SETTLED_MS = 12_000;
export const HOLD_RESULT_MS = 25_000;
/** Consecutive clean guard passes required before a secret scope resumes recording. */
export const SECRET_CLEAN_PASSES = 2;
export const CAPTURE_FPS = 4;
/** How long `settled` waits for busy indicators to clear before holding anyway. */
export const SETTLE_PATIENCE_MS = 45_000;
/** A heartbeat row while frames are identical, so the encoder can tell a hold from a dead recorder. */
const HEARTBEAT_MS = 1_000;

/** Text the wallet shows while it is still working; a settled screen shows none of it. */
export const BUSY_TEXT =
  /Updating…|Loading…|Loading address…|Loading fee rates…|Refreshing…|Estimating…|Inspecting…|Validating…|Building slate…|Broadcasting…|Signing…|Sending…|Unlocking…|Checking…|Preparing…/;

export function footageEnabled(): boolean {
  return process.env.FOOTAGE === 'guarded';
}

/** Refuse a caption that could carry a value: long alphanumeric runs, URLs, or odd characters. */
export function assertStaticLabel(label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9 ,.:;()'/+&-]{0,90}$/.test(label) || /[A-Za-z0-9]{16,}/.test(label) || label.includes('://')) {
    throw new Error('footage labels must be short static text, never a value');
  }
}

/**
 * In-memory known-secret canary. Phrase words are kept only as keyed hashes
 * of every 4-word window (single BIP39 words are ordinary English and would
 * match constantly); passwords are compared exactly. Nothing is ever printed.
 */
export class SecretCanary {
  private readonly key = randomBytes(32);
  private readonly grams = new Set<string>();
  private readonly exact: string[] = [];

  private mac(text: string): string {
    return createHmac('sha256', this.key).update(text).digest('hex');
  }

  addPhrase(words: readonly string[]): void {
    for (let i = 0; i + 4 <= words.length; i++) this.grams.add(this.mac(words.slice(i, i + 4).join(' ')));
  }

  addExact(value: string): void {
    if (value.length >= 8) this.exact.push(value);
  }

  /** True when `value` (something about to be typed or shown) contains a known secret. */
  isSecret(value: string): boolean {
    return this.hits({ text: value, values: [] });
  }

  hits(snapshot: { text: string; values: string[] }): boolean {
    const all = [snapshot.text, ...snapshot.values];
    if (this.exact.some((secret) => all.some((v) => v.includes(secret)))) return true;
    if (this.grams.size === 0) return false;
    const tokens = all.join(' ').toLowerCase().match(/[a-z]+/g) ?? [];
    for (let i = 0; i + 4 <= tokens.length; i++) {
      if (this.grams.has(this.mac(tokens.slice(i, i + 4).join(' ')))) return true;
    }
    return false;
  }
}

function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function appendLine(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TimelineKind =
  | 'session'
  | 'step'
  | 'tap'
  | 'fill'
  | 'settled'
  | 'result'
  | 'hold'
  | 'secret-start'
  | 'secret-end'
  | 'secret-span'
  | 'mark';

/** The one reason a tap may skip its pause: the screen counts itself down. */
export type UrgentReason = 'countdown';

/** One recorder's timeline: what happened and how long each hold actually lasted. */
export class Timeline {
  constructor(private readonly file: string | null) {}

  add(
    kind: TimelineKind,
    label: string,
    extra: { holdMs?: number; from?: number; to?: number; urgent?: UrgentReason } = {},
  ): void {
    if (!this.file) return;
    appendLine(this.file, { at: Date.now(), kind, label, ...extra });
  }
}

/**
 * Names this worker's recorders apart from an earlier worker's in the same
 * run directory: a failed test restarts the worker, whose recorders append to
 * the same folders, and frame files must never overwrite earlier ones.
 */
export function recorderSession(): string {
  return `w${process.env.TEST_WORKER_INDEX ?? '0'}-${Date.now().toString(36)}`;
}

/**
 * Screenshot loop for one page. Frames land in `<dir>/frames/NNNNNN.jpg`
 * (0600) and `<dir>/frames.jsonl` indexes every tick: a new frame, a repeat of
 * the previous one, or a redaction card with a static label.
 */
export class PageRecorder {
  private stopped = false;
  private loop: Promise<void> | null = null;
  private lastHash = '';
  private lastRowAt = 0;
  private count = 0;
  private secretLabel: string | null = null;
  private readonly framesDir: string;
  private readonly index: string;

  constructor(
    readonly name: string,
    private readonly page: Page,
    dir: string,
    private readonly canary: SecretCanary,
    private readonly session: string,
  ) {
    privateDir(dir);
    this.framesDir = privateDir(join(dir, 'frames'));
    this.index = join(dir, 'frames.jsonl');
  }

  start(): void {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.stopped && !this.page.isClosed()) {
        const started = Date.now();
        try {
          await this.tick();
        } catch {
          this.card('Unreadable page state');
        }
        const wait = 1000 / CAPTURE_FPS - (Date.now() - started);
        if (wait > 0) await sleep(wait);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** Switch to a redaction card immediately; frames stay suppressed until `resume`. */
  suppress(label: string): void {
    this.secretLabel = label;
    this.card(label);
  }

  resume(): void {
    this.secretLabel = null;
  }

  /** Guard verdict for the page as it is now; null means clean. A page that cannot answer is refused. */
  async verdict(): Promise<string | null> {
    if (this.page.isClosed()) return 'closed page';
    const check = async (): Promise<string | null> => {
      const a = await this.page.evaluate(secretSurface, B_PATTERNS);
      if (a) return a;
      const b = await this.page.evaluate(extraSecretSurface, B_EXTRA);
      if (b) return b;
      const snap = await this.page.evaluate(canarySnapshot);
      return this.canary.hits(snap) ? 'a known secret' : null;
    };
    return Promise.race([check(), sleep(10_000).then(() => 'an unresponsive page')]);
  }

  private card(label: string): void {
    this.lastHash = `card:${label}`;
    this.lastRowAt = Date.now();
    appendLine(this.index, { at: this.lastRowAt, kind: 'card', label, verdict: 'redacted' });
  }

  private async tick(): Promise<void> {
    if (this.secretLabel) {
      if (Date.now() - this.lastRowAt >= HEARTBEAT_MS) this.card(this.secretLabel);
      return;
    }
    if (await this.verdict()) {
      this.card('Protected screen');
      return;
    }
    const image = await this.page.screenshot({
      type: 'jpeg',
      quality: 85,
      mask: MASK_SELECTORS.map((selector) => this.page.locator(selector)),
      maskColor: '#1d1b26',
      timeout: 10_000,
    });
    // The page may have changed while the screenshot was taken: a second
    // verdict that disagrees with the first drops the frame.
    if (this.secretLabel || (await this.verdict())) {
      this.card('Protected screen');
      return;
    }
    const hash = createHash('sha256').update(image).digest('hex');
    const at = Date.now();
    if (hash === this.lastHash) {
      if (at - this.lastRowAt >= HEARTBEAT_MS) {
        this.lastRowAt = at;
        appendLine(this.index, { at, kind: 'same', verdict: 'clean' });
      }
      return;
    }
    this.count += 1;
    const file = `${this.session}-${String(this.count).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.framesDir, file), image, { mode: 0o600 });
    this.lastHash = hash;
    this.lastRowAt = at;
    appendLine(this.index, { at, kind: 'frame', file, verdict: 'clean' });
  }
}

/** The caption of the hold `tap` and `fill` add when a spec did not hold the screen itself. */
function heldBefore(label: string): string {
  return `Screen before: ${label}`.slice(0, 90).trimEnd();
}

/**
 * The hooks a live spec drives one wallet page through. Video holds apply
 * only when recording; the waits for busy indicators and actionability, and
 * the poll waits between looks at the chain, always apply.
 */
export class WalletFootage {
  private secretDepth = 0;
  /** True once the screen on show has been held (settled or result) since the last tap or entry. */
  private held = false;

  constructor(
    readonly name: string,
    readonly page: Page,
    private readonly canary: SecretCanary,
    private readonly recorder: PageRecorder | null,
    private readonly timeline: Timeline,
  ) {
    this.timeline.add('session', 'Recorder started');
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** A video hold: static screen on camera, skipped when nothing records. */
  private async holdFor(ms: number): Promise<number> {
    if (!this.recording) return 0;
    const started = Date.now();
    await this.page.waitForTimeout(ms);
    return Date.now() - started;
  }

  mark(label: string): void {
    assertStaticLabel(label);
    this.timeline.add('mark', label);
  }

  /** Record a span that happened before this recorder started, shown as a card (wallet import). */
  spanBefore(label: string, from: number, to: number): void {
    assertStaticLabel(label);
    this.timeline.add('secret-span', label, { from, to });
  }

  async stop(): Promise<void> {
    await this.recorder?.stop();
  }

  /**
   * The pause between two looks at the chain. Not a video hold: it always
   * runs, recorded or not, so polling never turns into a tight loop. On video
   * it is static screen like any hold.
   */
  async pollWait(ms: number, label: string): Promise<void> {
    assertStaticLabel(label);
    const started = Date.now();
    await sleep(ms);
    this.timeline.add('hold', label, { holdMs: Date.now() - started });
  }

  /**
   * Wait until `locator` is actionable, make sure the screen was held, pause
   * 6 s on it, then tap. `position` taps a point inside the element (a history
   * row's arrow, so the row opens rather than its copy control).
   * `urgent: 'countdown'` is for a screen that counts itself down and so can
   * never be held: no pause, recorded as urgent; the caller holds what follows.
   */
  async tap(
    locator: Locator,
    label: string,
    opts: { timeout?: number; position?: { x: number; y: number }; urgent?: UrgentReason } = {},
  ): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    const timeout = opts.timeout ?? 60_000;
    const where = opts.position ? { position: opts.position } : {};
    // Logged before waiting, so a stalled run shows what it was waiting for.
    this.timeline.add('step', label);
    await locator.click({ trial: true, timeout, ...where });
    if (opts.urgent) {
      if (opts.urgent !== 'countdown') throw new Error('the only urgent tap is a countdown screen');
      this.timeline.add('tap', label, { holdMs: 0, urgent: opts.urgent });
    } else {
      if (!this.held) await this.settled(heldBefore(label));
      const held = await this.holdFor(HOLD_BEFORE_TAP_MS);
      this.timeline.add('tap', label, { holdMs: held });
    }
    await locator.click({ timeout, ...where });
    this.held = false;
  }

  /**
   * Hold, then enter a NON-secret value (an address, an amount, a slatepack).
   * Refuses a value the canary knows; secrets go through `typeSecret`.
   */
  async fill(locator: Locator, value: string, label: string, opts: { timeout?: number } = {}): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    if (this.canary.isSecret(value)) throw new Error('refusing to type a known secret outside a secret scope');
    const timeout = opts.timeout ?? 60_000;
    this.timeline.add('step', label);
    await locator.waitFor({ state: 'visible', timeout });
    if (!this.held) await this.settled(heldBefore(label));
    const held = await this.holdFor(HOLD_BEFORE_TAP_MS);
    this.timeline.add('fill', label, { holdMs: held });
    await locator.fill(value, { timeout });
    this.held = false;
  }

  /** Type a secret. Only inside `secret()`, where the recorder shows a card. */
  async typeSecret(locator: Locator, value: string): Promise<void> {
    if (this.secretDepth === 0) throw new Error('secrets are typed only inside a secret scope');
    await locator.fill(value);
  }

  /** Wait for the wallet to stop showing busy text, then hold the settled screen. */
  async settled(label: string, opts: { patience?: number } = {}): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    this.timeline.add('step', label);
    const deadline = Date.now() + (opts.patience ?? SETTLE_PATIENCE_MS);
    let clean = 0;
    while (Date.now() < deadline && clean < 2) {
      const text = await Promise.race([
        this.page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
        sleep(10_000).then(() => ''),
      ]);
      clean = BUSY_TEXT.test(text) ? 0 : clean + 1;
      if (clean < 2) await this.page.waitForTimeout(500);
    }
    const held = await this.holdFor(HOLD_SETTLED_MS);
    this.timeline.add('settled', label, { holdMs: held });
    this.held = true;
  }

  /** Hold a key result on screen. */
  async result(label: string): Promise<void> {
    assertStaticLabel(label);
    noteStep(label);
    const held = await this.holdFor(HOLD_RESULT_MS);
    this.timeline.add('result', label, { holdMs: held });
    this.held = true;
  }

  /**
   * Run `fn` behind a redaction card: password entry, a lock screen, any
   * screen the guard would refuse anyway. Recording resumes only after the
   * page passes the guard twice in a row.
   */
  async secret<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    this.secretDepth += 1;
    this.recorder?.suppress(label);
    this.timeline.add('secret-start', label);
    try {
      return await fn();
    } finally {
      this.secretDepth -= 1;
      // The scope changed the screen (an unlock, a confirmed password): the
      // next tap holds what it left behind first.
      this.held = false;
      if (this.secretDepth === 0 && this.recorder) {
        let clean = 0;
        const deadline = Date.now() + 60_000;
        while (clean < SECRET_CLEAN_PASSES && Date.now() < deadline) {
          clean = (await this.recorder.verdict().catch(() => 'unreadable')) ? 0 : clean + 1;
          if (clean < SECRET_CLEAN_PASSES) await sleep(250);
        }
        // Still unclean: stay suppressed. The recorder refuses such frames
        // anyway, and the next clean scope end resumes.
        if (clean >= SECRET_CLEAN_PASSES) this.recorder.resume();
      }
      this.timeline.add('secret-end', label);
    }
  }
}

/** Where a recorder for `name` writes, under the lane's footage directory. */
export function recorderDir(footageRoot: string, name: string): string {
  return join(footageRoot, name.replace(/[^a-z0-9-]/gi, '-'));
}

/** Write the run's footage manifest: the policy the encoder verifies against. */
export function writeFootageManifest(footageRoot: string, info: Record<string, unknown>): void {
  privateDir(footageRoot);
  writeFileSync(
    join(footageRoot, 'manifest.json'),
    JSON.stringify(
      {
        lane: 'B-send-receive-history',
        policy: {
          holdBeforeTapMs: HOLD_BEFORE_TAP_MS,
          holdSettledMs: HOLD_SETTLED_MS,
          holdResultMs: HOLD_RESULT_MS,
          captureFps: CAPTURE_FPS,
        },
        ...info,
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );
}

/**
 * Build the per-page footage pair (recorder plus hooks) for one recorder name.
 * Without footage, `traceRoot` still receives the timeline (static labels and
 * times only), so a failed run shows the last step each page reached.
 */
export function createFootage(opts: {
  name: string;
  page: Page;
  canary: SecretCanary;
  footageRoot: string | null;
  traceRoot?: string;
  session: string;
}): WalletFootage {
  const dir = opts.footageRoot ? recorderDir(opts.footageRoot, opts.name) : null;
  const recorder = dir ? new PageRecorder(opts.name, opts.page, dir, opts.canary, opts.session) : null;
  const traceDir = dir ?? (opts.traceRoot ? privateDir(recorderDir(opts.traceRoot, opts.name)) : null);
  const timeline = new Timeline(traceDir ? join(traceDir, 'timeline.jsonl') : null);
  recorder?.start();
  return new WalletFootage(opts.name, opts.page, opts.canary, recorder, timeline);
}
