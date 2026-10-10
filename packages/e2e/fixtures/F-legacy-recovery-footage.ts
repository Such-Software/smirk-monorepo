/**
 * Guarded footage for the F-legacy-recovery live lane.
 *
 * The owner's video policy, applied in the fixture and never by ad hoc sleeps
 * in a spec:
 *   - every tap is preceded by a static pause (`TAP_PAUSE_MS`);
 *   - every settled screen is held static (`SETTLED_HOLD_MS`);
 *   - every key result (balances, confirmations, a tip claimed, a scan, history
 *     detail) is held static (`RESULT_HOLD_MS`).
 *
 * Recording is opt-in (`FOOTAGE=guarded`). Playwright's own trace, screenshot
 * and video stay off: they cannot be guarded per frame. Instead one recorder
 * per wallet page takes about four frames a second, and for each frame:
 *   1. classifies the page (`F-legacy-recovery-guard.mjs`);
 *   2. if the screen is a secret (phrase, key text, a known secret anywhere),
 *      records a redaction card span and keeps no pixels;
 *   3. otherwise screenshots with every password field, share URL, tx key and
 *      filled claim-link input masked;
 *   4. classifies again and drops the frame if the two verdicts disagree.
 * Identical frames are deduplicated by hash, so long static holds cost no disk.
 * `secret(label, fn)` forces the card for a whole step (phrase import, password
 * entry, claim-link transfer) and resumes only after two clean guard passes.
 *
 * Output: `<E2E_FOOTAGE_DIR>/raw/F-legacy-recovery/<wallet>/` (mode 0700),
 * JPEG frames and `timeline.json` (frames with their guard verdicts, card
 * spans, dropped samples, every hold with planned and actual duration, and
 * step markers). Marker labels are a closed set of static strings, so a value
 * or URL can never become a label. `scripts/F-legacy-recovery-encode.mjs`
 * turns a timeline into video and refuses one that breaks the policy.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  FRAME_GUARD_PATTERNS,
  classifyFrame,
  maskSelectors,
  type Canary,
  type FrameVerdict,
} from './F-legacy-recovery-guard.mjs';

/** Static pause before every tap. */
export const TAP_PAUSE_MS = 6_000;
/** Static hold once a screen has settled. */
export const SETTLED_HOLD_MS = 12_000;
/** Static hold on a key result. */
export const RESULT_HOLD_MS = 25_000;
/** Sampling interval: about four frames a second. */
export const FRAME_INTERVAL_MS = 250;
/** How long `settled` waits for loading text to clear before holding anyway. */
const SETTLE_PATIENCE_MS = 60_000;
/** Clean guard passes required before a secret scope ends. */
const CLEAN_PASSES_TO_RESUME = 2;

export const FOOTAGE_POLICY = Object.freeze({
  tapPauseMs: TAP_PAUSE_MS,
  settledHoldMs: SETTLED_HOLD_MS,
  resultHoldMs: RESULT_HOLD_MS,
  frameIntervalMs: FRAME_INTERVAL_MS,
});

/** Run identity, for the output path only. */
export const FOOTAGE_RUN = process.env.E2E_FOOTAGE_RUN ?? 'v0.3.1-run-11204';

/** True when this run records. Any other FOOTAGE value is refused, not ignored. */
export function footageEnabled(): boolean {
  const mode = (process.env.FOOTAGE ?? '').trim();
  if (mode === '' || mode === 'off') return false;
  if (mode === 'guarded') return true;
  throw new Error('FOOTAGE accepts only "guarded" (the per-frame guarded recorder) or "off".');
}

export function footageRoot(): string {
  return process.env.E2E_FOOTAGE_DIR ?? join(homedir(), 'Build', 'smirk-e2e', FOOTAGE_RUN, 'footage');
}

/**
 * Every caption and marker this area may use. A closed set of literals: the
 * compiler refuses a dynamic string, so balances, addresses, txids and links
 * cannot reach the timeline or the video.
 */
export const FOOTAGE_LABELS = [
  'Wallet import and unlock (redacted)',
  'Home after import',
  'Home: no older-address notice',
  'Home: older-address notice',
  'Open Settings',
  'Settings: Older addresses and tips',
  'Automatic check result',
  'Check older addresses',
  'Read-only check result',
  'Automatic check: turn off',
  'Automatic check: turn on',
  'Automatic check setting kept',
  'Lock wallet',
  'Unlock wallet (redacted)',
  'After unlock: automatic check off',
  'After unlock: automatic check ran',
  'Scan older Monero and Wownero addresses',
  'Scan registered with the server',
  'Look for tips',
  'Old-server tips',
  'Open asset',
  'Asset balance',
  'Back to Home',
  'Send to an older address',
  'Send: choose asset',
  'Send: recipient',
  'Send: amount',
  'Send: review',
  'Send: broadcast',
  'Funds still arriving at the older address',
  'Funds ready to move',
  'Open the notice',
  'Move to my wallet',
  'Move: amount and fee',
  'Move: confirm',
  'Password confirmation (redacted)',
  'Moved: result',
  'Open history detail',
  'Moved: history detail',
  'Moved: balance confirmed',
  'Finish claim',
  'Tip claimed',
  'Open Inbox',
  'Paste a tip link',
  'Claim link entry (redacted)',
  'Legacy link tip claimed',
  'Close detail',
] as const;
export type FootageLabel = (typeof FOOTAGE_LABELS)[number];

type CardSpan = { label: string; from: number; until: number; reasons: string[] };
type FrameEntry = { file: string; from: number; until: number; kind: 'clean' | 'mask'; reasons: string[]; sha256: string };
type HoldEntry = { kind: 'pre-tap' | 'settled' | 'result'; label: FootageLabel; plannedMs: number; from: number; until: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const signature = (v: FrameVerdict) => `${v.kind}|${v.reasons.join(',')}`;

/** One recorder per page. Holds no secret: the canary it sends is digests only. */
class PageRecorder {
  readonly frames: FrameEntry[] = [];
  readonly cards: CardSpan[] = [];
  readonly dropped: { at: number; reason: string }[] = [];
  private secretLabel: string | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private seq = 0;

  constructor(
    private readonly page: Page,
    private readonly dir: string,
    private readonly canary: Canary,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  enterSecret(label: string): void {
    this.secretLabel = label;
  }

  /** Leave a secret scope only after consecutive clean guard passes. */
  async leaveSecret(patienceMs = 10 * 60_000): Promise<void> {
    const until = Date.now() + patienceMs;
    let clean = 0;
    while (Date.now() < until && !this.page.isClosed()) {
      const verdict = await this.classify();
      clean = verdict && verdict.kind !== 'card' ? clean + 1 : 0;
      if (clean >= CLEAN_PASSES_TO_RESUME) {
        this.secretLabel = null;
        return;
      }
      await sleep(FRAME_INTERVAL_MS);
    }
    // Still secret: the card stays up, which is the safe direction.
  }

  private async classify(): Promise<FrameVerdict | null> {
    try {
      return await this.page.evaluate(classifyFrame, { patterns: FRAME_GUARD_PATTERNS, canary: this.canary.forPage() });
    } catch {
      return null;
    }
  }

  private card(label: string, reasons: string[], at: number): void {
    const last = this.cards.at(-1);
    if (last && last.label === label && at - last.until <= FRAME_INTERVAL_MS * 4) {
      last.until = at;
      for (const r of reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
      return;
    }
    this.cards.push({ label, from: at, until: at, reasons: [...reasons] });
  }

  private masks(): Locator[] {
    return [
      ...maskSelectors().map((selector) => this.page.locator(selector)),
      this.page.getByText(new RegExp(FRAME_GUARD_PATTERNS.claimLinkText)),
    ];
  }

  private async run(): Promise<void> {
    while (!this.stopped && !this.page.isClosed()) {
      const startedAt = Date.now();
      if (this.secretLabel) {
        this.card(this.secretLabel, ['secret-scope'], startedAt);
      } else {
        const before = await this.classify();
        if (!before) this.card('Unreadable screen (redacted)', ['unreadable'], startedAt);
        else if (before.kind === 'card') this.card('Secret on screen (redacted)', before.reasons, startedAt);
        else {
          const shot = await this.page
            .screenshot({ type: 'jpeg', quality: 90, mask: this.masks(), maskColor: '#202024', caret: 'hide', timeout: 5_000 })
            .catch(() => null);
          const after = await this.classify();
          if (!shot || !after || signature(after) !== signature(before)) {
            this.dropped.push({ at: startedAt, reason: !shot ? 'no-screenshot' : 'guard-disagreed' });
          } else {
            this.keep(shot, after, startedAt);
          }
        }
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < FRAME_INTERVAL_MS) await sleep(FRAME_INTERVAL_MS - elapsed);
    }
  }

  private keep(shot: Buffer, verdict: FrameVerdict, at: number): void {
    const sha256 = createHash('sha256').update(shot).digest('hex');
    const last = this.frames.at(-1);
    const lastCard = this.cards.at(-1);
    // A card since the last frame breaks the run: the next frame is new even if identical.
    if (last && last.sha256 === sha256 && signature({ kind: last.kind, reasons: last.reasons }) === signature(verdict)
      && !(lastCard && lastCard.from > last.until)) {
      last.until = at;
      return;
    }
    const file = `${String(this.seq++).padStart(7, '0')}.jpg`;
    writeFileSync(join(this.dir, file), shot, { mode: 0o600 });
    this.frames.push({ file, from: at, until: at, kind: verdict.kind as 'clean' | 'mask', reasons: verdict.reasons, sha256 });
  }
}

/**
 * Footage for one wallet. Every interaction in a live spec goes through it, so
 * a recorded run cannot skip a pause or a hold. With `FOOTAGE` off nothing is
 * captured and the holds are skipped, which keeps an unrecorded rehearsal
 * short; the steps and assertions are identical.
 */
export class WalletFootage {
  readonly enabled: boolean;
  private readonly recorders: PageRecorder[] = [];
  private readonly holds: HoldEntry[] = [];
  private readonly marks: { label: FootageLabel; at: number; test: string }[] = [];
  private readonly dir: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private currentTest = '';

  constructor(
    readonly wallet: string,
    private readonly canary: Canary,
  ) {
    this.enabled = footageEnabled();
    this.dir = join(footageRoot(), 'raw', 'F-legacy-recovery', wallet);
    if (this.enabled) {
      for (const d of [footageRoot(), join(footageRoot(), 'raw'), join(footageRoot(), 'raw', 'F-legacy-recovery'), this.dir]) {
        if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
      }
      this.flushTimer = setInterval(() => this.flush(), 30_000);
    }
  }

  /** Start recording a page (the wallet page, or any page the wallet opens). */
  attach(page: Page): void {
    if (!this.enabled) return;
    const frames = join(this.dir, `page-${this.recorders.length}`);
    mkdirSync(frames, { recursive: true, mode: 0o700 });
    const recorder = new PageRecorder(page, frames, this.canary);
    this.recorders.push(recorder);
    recorder.start();
  }

  /** Name the test the next markers belong to (a static title, never a value). */
  beginTest(title: string): void {
    this.currentTest = title;
  }

  mark(label: FootageLabel): void {
    this.marks.push({ label, at: Date.now(), test: this.currentTest });
  }

  private async hold(kind: HoldEntry['kind'], label: FootageLabel, plannedMs: number): Promise<void> {
    if (!this.enabled) return;
    const from = Date.now();
    await sleep(plannedMs);
    this.holds.push({ kind, label, plannedMs, from, until: Date.now() });
  }

  /** Static pause, then the tap. The recorder guards every frame either side. */
  async tap(target: Locator, label: FootageLabel): Promise<void> {
    await target.waitFor({ state: 'visible' });
    this.mark(label);
    await this.hold('pre-tap', label, TAP_PAUSE_MS);
    await target.click();
  }

  /** Static pause, then type a value that is NOT secret (an amount, an address). */
  async enter(target: Locator, value: string, label: FootageLabel): Promise<void> {
    await target.waitFor({ state: 'visible' });
    this.mark(label);
    await this.hold('pre-tap', label, TAP_PAUSE_MS);
    await target.fill(value);
  }

  /** Toggle a checkbox to a state, with the same pause as a tap. */
  async setChecked(target: Locator, checked: boolean, label: FootageLabel): Promise<void> {
    await target.waitFor({ state: 'visible' });
    this.mark(label);
    await this.hold('pre-tap', label, TAP_PAUSE_MS);
    await target.setChecked(checked);
  }

  /** Wait for loading text to clear on `page`, then hold the settled screen. */
  async settled(page: Page, label: FootageLabel): Promise<void> {
    await page
      .locator('#root')
      .filter({ hasText: /Updating…|Loading/ })
      .waitFor({ state: 'detached', timeout: SETTLE_PATIENCE_MS })
      .catch(() => {});
    this.mark(label);
    await this.hold('settled', label, SETTLED_HOLD_MS);
  }

  /** Hold a key result on screen. */
  async result(label: FootageLabel): Promise<void> {
    this.mark(label);
    await this.hold('result', label, RESULT_HOLD_MS);
  }

  /**
   * Run `fn` behind a redaction card on every recorded page. Recording resumes
   * only after two consecutive clean guard passes, so a secret that lingers
   * after `fn` stays redacted.
   */
  async secret<T>(label: FootageLabel, fn: () => Promise<T>): Promise<T> {
    this.mark(label);
    for (const r of this.recorders) r.enterSecret(label);
    try {
      return await fn();
    } finally {
      await Promise.all(this.recorders.map((r) => r.leaveSecret()));
    }
  }

  private flush(): void {
    if (!this.enabled) return;
    const timeline = {
      area: 'F-legacy-recovery',
      wallet: this.wallet,
      run: FOOTAGE_RUN,
      policy: FOOTAGE_POLICY,
      pages: this.recorders.map((r, i) => ({
        dir: `page-${i}`,
        frames: r.frames,
        cards: r.cards,
        dropped: r.dropped,
      })),
      holds: this.holds,
      marks: this.marks,
      writtenAt: Date.now(),
    };
    const file = join(this.dir, 'timeline.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(timeline), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await Promise.all(this.recorders.map((r) => r.stop()));
    this.flush();
  }
}
