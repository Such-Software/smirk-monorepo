/**
 * Guarded footage for the live messaging and federation lane (area D).
 *
 * The wallet suite's capture lane stays closed: Playwright trace, screenshot and
 * video remain off, because none of them can be checked frame by frame. This
 * recorder is the reviewed exception the release run needs, and it records the
 * way the demo lane does (a screenshot loop on one wallet page), with three
 * changes the owner's video policy requires:
 *
 *  1. It redacts and continues instead of aborting. Before and after every
 *     screenshot it runs the demo guard (`demo/guard.mjs` secretSurface) and a
 *     known-secret canary. If either pass flags anything, or the two passes
 *     disagree, the frame is replaced by a static redaction card and no pixels
 *     are kept. Screenshots also mask every known secret-bearing element.
 *  2. `secret(label, fn)` switches the recorder to the card BEFORE a password
 *     or phrase is typed, and resumes only after two consecutive clean passes.
 *  3. Dead air is part of the fixture, never an ad hoc sleep in a spec:
 *     `tap` holds the screen static before every tap, `settled` holds a settled
 *     screen, and `result` holds a key result. Each hold is written to the
 *     timeline, and `assertHoldsMeetPolicy` fails a run whose holds fall short.
 *
 * What is never retained: values, URLs, page text or the canary's inputs.
 * Labels are static strings (checked at runtime), and the timeline names a
 * redaction by its static label only. The canary keeps SHA-256 digests of
 * three-word phrase shingles; the phrase words themselves are zeroed by the
 * wallet fixture after import.
 *
 * Recording is opt-in (`FOOTAGE=guarded`). Without it the holds still apply,
 * because the release run is paced for review; `E2E_LIVE_HOLDS=short` shortens
 * them for a local selector check and is refused together with footage.
 */

import type { Locator, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Hold durations required by the owner's video policy (milliseconds). */
export const D_HOLD = Object.freeze({
  /** Static screen before every tap or field entry. */
  BEFORE_TAP_MS: 6_000,
  /** A settled screen (no loading or updating text) held static. */
  SETTLED_MS: 12_000,
  /** Key results: a balance, a confirmation, a message received, a probe result. */
  RESULT_MS: 25_000,
});

/** About four frames a second; identical frames are deduplicated by hash. */
export const D_FRAME_INTERVAL_MS = 250;

/** Timeline schema written beside the frames. */
export const D_TIMELINE_FORMAT = 'smirk-e2e-guarded-footage/1';

/** Holds shortened for a local selector check (never with footage). */
const SHORT_HOLD_MS = 400;

export type HoldKind = 'tap' | 'settled' | 'result';

export interface HoldRecord {
  kind: HoldKind;
  label: string;
  startedAt: number;
  ms: number;
  policyMs: number;
}

export interface FrameRecord {
  at: number;
  verdict: 'clean' | 'redacted';
  /** Written JPEG (clean frames only). */
  file?: string;
  /** Same pixels as the previous frame: the encoder repeats it. */
  same?: true;
  /** Static redaction-card label (redacted frames only). */
  card?: string;
}

export interface MarkRecord {
  at: number;
  label: string;
}

/** Frame counts for the run summary; never values. */
export interface FootageCounters {
  written: number;
  repeated: number;
  redacted: number;
  dropped: number;
  canary: number;
}

/** Whether this run records (`FOOTAGE=guarded`). */
export function footageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FOOTAGE === 'guarded';
}

/** Whether holds are shortened for a selector check. Refused with footage. */
export function holdsShortened(env: Record<string, string | undefined> = process.env): boolean {
  const short = env.E2E_LIVE_HOLDS === 'short';
  if (short && footageEnabled(env)) {
    throw new Error('E2E_LIVE_HOLDS=short cannot be combined with FOOTAGE=guarded: recorded holds must meet the video policy.');
  }
  return short;
}

/**
 * Labels end up in the timeline and the caption bar, so they must be static
 * prose: never an npub, an address, a URL, a handle or a number that could be
 * an amount. A label that looks like a value is refused.
 */
export function assertStaticLabel(label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9 ,.'()>:-]{0,79}$/.test(label) ||
      /npub1|nsec1|:\/\/|@|\d{5,}/.test(label)) {
    throw new Error('footage labels must be short static text, never values or URLs');
  }
}

/**
 * Known-secret canary. Holds digests of every three-word shingle of each
 * wallet phrase, and exact in-memory values (wallet passwords, Node-side test
 * keys) that the fixture already holds. A hit redacts the frame; the value that
 * matched is never reported.
 */
export class SecretCanary {
  private readonly shingles = new Set<string>();
  private readonly exact: string[] = [];

  private static digest(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /** Register a phrase. Call before the caller zeroes its words. */
  addPhrase(words: readonly string[]): void {
    for (let i = 0; i + 3 <= words.length; i++) {
      this.shingles.add(SecretCanary.digest(words.slice(i, i + 3).join(' ').toLowerCase()));
    }
  }

  /** Register an exact value (eight characters or more) to watch for. */
  addExact(value: string): void {
    if (value.length >= 8) this.exact.push(value);
  }

  /** True when any text contains a registered secret. */
  hit(texts: readonly string[]): boolean {
    for (const text of texts) {
      if (!text) continue;
      for (const value of this.exact) if (text.includes(value)) return true;
      const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
      for (let i = 0; i + 3 <= words.length; i++) {
        if (this.shingles.has(SecretCanary.digest(`${words[i]} ${words[i + 1]} ${words[i + 2]}`))) return true;
      }
    }
    return false;
  }
}

/** The demo guard module, loaded from the reviewed lane (`demo/guard.mjs`). */
export interface GuardModule {
  secretSurface: (patterns: Record<string, string>) => string | null;
  PRIVATE_TEXT: Record<string, string>;
}

let guardModule: GuardModule | undefined;

/** Load the reviewed demo guard once per worker. */
export async function loadGuard(): Promise<GuardModule> {
  if (guardModule) return guardModule;
  const href = new URL('../demo/guard.mjs', import.meta.url).href;
  const loaded = (await import(href)) as GuardModule;
  if (typeof loaded.secretSurface !== 'function' || typeof loaded.PRIVATE_TEXT !== 'object') {
    throw new Error('demo guard did not load; refusing to record');
  }
  guardModule = loaded;
  return loaded;
}

/**
 * Elements masked in every screenshot, in addition to the guard. These hold or
 * accept secrets: passwords, revealed keys, tip claim links, pasted claim
 * material, and the revealed recovery phrase.
 */
const MASK_SELECTOR = [
  'input[type="password"]',
  '[data-testid="tip-share-url"]',
  '[data-testid^="nostr-nsec-"]',
  '[data-testid="tx-detail-tx-key"]',
  '[data-testid="paste-tip-input"]',
  '[data-testid="paste-dispatch-input"]',
  '[data-testid="nostr-import-nsec"]',
  '[data-testid="nostr-restore-input"]',
  '[data-testid="settings-revealed-phrase"]',
  '[data-testid^="onboarding-create-seed-word-"]',
  '[data-testid^="onboarding-verify-word-"]',
  '[data-testid^="onboarding-import-word-"]',
].join(', ');

/** A tip claim link carries its key in the fragment. */
const TIP_LINK = /\/tip\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{8,}/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Footage and pacing for ONE wallet page. Every tap, field entry and hold in a
 * live spec goes through this object, so the pacing policy is enforced in one
 * place and the static check (`scripts/D-messaging-federation-check-live-specs.mjs`)
 * can refuse a spec that bypasses it.
 */
export class DFootage {
  private readonly frames: FrameRecord[] = [];
  private readonly holdLog: HoldRecord[] = [];
  private readonly marks: MarkRecord[] = [];
  private loopDone: Promise<void> | null = null;
  private stopped = false;
  private seq = 0;
  private lastHash = '';
  private lastCard = '';
  private redacting: string | null = null;
  private resumeAfterCleanPasses = 0;
  private startedAt = 0;
  private readonly counters: FootageCounters = { written: 0, repeated: 0, redacted: 0, dropped: 0, canary: 0 };

  constructor(
    readonly wallet: string,
    private readonly page: Page,
    private readonly opts: {
      /** Frame directory (0700), or null when this run does not record. */
      dir: string | null;
      canary: SecretCanary;
      guard: GuardModule;
      shortHolds: boolean;
    },
  ) {}

  get recording(): boolean {
    return this.opts.dir !== null;
  }

  /** Begin recording this page (no-op without footage). */
  start(): void {
    if (!this.opts.dir || this.loopDone) return;
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.opts.dir, 0o700);
    this.startedAt = Date.now();
    this.loopDone = this.loop();
  }

  /** Stop recording and write the timeline. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopDone) await this.loopDone;
    this.loopDone = null;
    if (!this.opts.dir) return;
    const timeline = {
      format: D_TIMELINE_FORMAT,
      area: 'D-messaging-federation',
      wallet: this.wallet,
      policy: { ...D_HOLD, frameIntervalMs: D_FRAME_INTERVAL_MS },
      startedAt: this.startedAt,
      stoppedAt: Date.now(),
      counters: this.counters,
      marks: this.marks,
      holds: this.holdLog,
      frames: this.frames,
    };
    writeFileSync(join(this.opts.dir, 'timeline.json'), JSON.stringify(timeline), { mode: 0o600 });
  }

  /** Chapter marker shown in the caption bar (static label). */
  mark(label: string): void {
    assertStaticLabel(label);
    this.marks.push({ at: Date.now(), label });
  }

  /** Holds recorded so far (for the end-of-test policy check). */
  holds(): readonly HoldRecord[] {
    return this.holdLog;
  }

  /** Counts only; never values. */
  stats(): Readonly<FootageCounters> {
    return this.counters;
  }

  /** Hold the screen static, then tap. */
  async tap(locator: Locator, label: string): Promise<void> {
    assertStaticLabel(label);
    await locator.waitFor({ state: 'visible', timeout: 60_000 });
    await this.hold('tap', label, D_HOLD.BEFORE_TAP_MS);
    try {
      await locator.click();
    } catch (error) {
      // Name what sits on the target (test ids and tags only, never text), so
      // a blocked tap can be triaged from its first line.
      const cover = await locator
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          const owner = top?.closest('[data-testid]') as HTMLElement | null;
          const state = (el as HTMLButtonElement).disabled ? 'disabled' : 'enabled';
          return `${state}; on top: ${top ? top.tagName.toLowerCase() : 'nothing'}${owner?.dataset.testid ? ` in ${owner.dataset.testid}` : ''}`;
        })
        .catch(() => 'target gone');
      const first = String(error instanceof Error ? error.message : error).split('\n')[0];
      throw new Error(`tap "${label}" failed (${cover}): ${first}`);
    }
  }

  /**
   * Hold, then type visibly into a field. `secret: true` types inside a
   * redaction scope instead (passwords, phrases); the value never appears in a
   * frame, a label or the timeline.
   */
  async type(locator: Locator, text: string, label: string, opts: { secret?: boolean } = {}): Promise<void> {
    assertStaticLabel(label);
    await locator.waitFor({ state: 'visible', timeout: 60_000 });
    await this.hold('tap', label, D_HOLD.BEFORE_TAP_MS);
    if (opts.secret) {
      await this.secret(label, async () => {
        await locator.fill(text);
      });
      return;
    }
    await locator.fill('');
    await locator.pressSequentially(text, { delay: 30 });
  }

  /** Wait until nothing is loading or updating, then hold the settled screen. */
  async settled(label: string, patienceMs = 60_000): Promise<void> {
    assertStaticLabel(label);
    await this.page
      .locator('#root')
      .filter({ hasText: /Updating…|Loading/ })
      .waitFor({ state: 'detached', timeout: patienceMs })
      .catch(() => {});
    await this.hold('settled', label, D_HOLD.SETTLED_MS);
  }

  /** Hold a key result on screen. */
  async result(label: string): Promise<void> {
    assertStaticLabel(label);
    await this.hold('result', label, D_HOLD.RESULT_MS);
  }

  /**
   * Run `fn` with the recorder showing a redaction card. Recording resumes only
   * after two consecutive clean guard and canary passes.
   */
  async secret<T>(label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    this.redacting = label;
    this.resumeAfterCleanPasses = 0;
    try {
      return await fn();
    } finally {
      this.resumeAfterCleanPasses = 2;
      if (!this.recording) this.redacting = null;
    }
  }

  /** The static label of the most recent hold (a breadcrumb for triage). */
  get lastAction(): string {
    return this.holdLog.length ? this.holdLog[this.holdLog.length - 1]!.label : 'none yet';
  }

  private async hold(kind: HoldKind, label: string, policyMs: number): Promise<void> {
    const ms = this.opts.shortHolds ? SHORT_HOLD_MS : policyMs;
    const startedAt = Date.now();
    await sleep(ms);
    this.holdLog.push({ kind, label, startedAt, ms: Date.now() - startedAt, policyMs });
  }

  /** Guard plus canary. Returns a static reason label, or null when clean. */
  private async verdict(): Promise<string | null> {
    const guard = this.opts.guard;
    let surface: string | null;
    let texts: string[];
    try {
      // Bounded: a page that stops answering must not stall the recorder (or
      // the teardown that waits for it). No answer is a redaction, not a pass.
      [surface, texts] = await Promise.race([
        Promise.all([
          this.page.evaluate(guard.secretSurface, guard.PRIVATE_TEXT),
          this.page.evaluate(() => {
            const out = [document.body?.innerText ?? ''];
            for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
              const value = (el as HTMLInputElement).value;
              if (value) out.push(value);
            }
            return out;
          }),
        ]),
        sleep(10_000).then(() => {
          throw new Error('guard timed out');
        }),
      ]);
    } catch {
      return 'unreadable page';
    }
    if (surface) return 'guard';
    if (this.opts.canary.hit(texts)) {
      this.counters.canary++;
      return 'canary';
    }
    if (texts.some((t) => TIP_LINK.test(t))) return 'tip link';
    return null;
  }

  private pushCard(at: number, card: string): void {
    this.counters.redacted++;
    if (card === this.lastCard && this.frames.length && this.frames[this.frames.length - 1]!.verdict === 'redacted') {
      this.frames.push({ at, verdict: 'redacted', card, same: true });
      return;
    }
    this.lastCard = card;
    this.lastHash = '';
    this.frames.push({ at, verdict: 'redacted', card });
  }

  private async captureOnce(): Promise<void> {
    const at = Date.now();
    if (this.redacting) {
      const card = `secret: ${this.redacting}`;
      if (this.resumeAfterCleanPasses > 0) {
        if ((await this.verdict()) === null) {
          this.resumeAfterCleanPasses--;
          if (this.resumeAfterCleanPasses === 0) this.redacting = null;
        } else {
          this.resumeAfterCleanPasses = 2;
        }
      }
      this.pushCard(at, card);
      return;
    }
    const before = await this.verdict();
    if (before) {
      this.pushCard(at, before);
      return;
    }
    let shot: Buffer;
    try {
      shot = await this.page.screenshot({
        type: 'jpeg',
        quality: 85,
        mask: [this.page.locator(MASK_SELECTOR), this.page.getByText(TIP_LINK)],
        maskColor: '#111111',
        caret: 'hide',
        timeout: 5_000,
      });
    } catch {
      // Navigating or closing: no frame without a verdict.
      return;
    }
    const after = await this.verdict();
    if (after || this.redacting) {
      // The screen changed under the shot. Keep nothing from it.
      this.counters.dropped++;
      this.pushCard(at, after ?? 'guard');
      return;
    }
    const hash = createHash('sha256').update(shot).digest('hex');
    if (hash === this.lastHash) {
      this.counters.repeated++;
      this.frames.push({ at, verdict: 'clean', same: true });
      return;
    }
    const file = `${String(this.seq++).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.opts.dir!, file), shot, { mode: 0o600 });
    this.counters.written++;
    this.lastHash = hash;
    this.lastCard = '';
    this.frames.push({ at, verdict: 'clean', file });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const began = Date.now();
      if (this.page.isClosed()) break;
      await this.captureOnce().catch(() => {});
      const wait = D_FRAME_INTERVAL_MS - (Date.now() - began);
      if (wait > 0) await sleep(wait);
    }
  }
}

/**
 * Fail when any recorded hold fell short of its policy. Holds are measured
 * wall-clock sleeps, so only a shortened run (or a broken timer) trips this.
 * Returns the number of holds checked.
 */
export function assertHoldsMeetPolicy(footages: readonly DFootage[]): number {
  let checked = 0;
  for (const footage of footages) {
    for (const hold of footage.holds()) {
      checked++;
      if (hold.ms + 50 < hold.policyMs) {
        throw new Error(`a ${hold.kind} hold on ${footage.wallet} ("${hold.label}") was shorter than the video policy`);
      }
    }
  }
  return checked;
}
