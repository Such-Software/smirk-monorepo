/**
 * Guarded footage for the F-legacy-recovery live lane.
 *
 * The owner's video policy, applied in the fixture and never by ad hoc sleeps
 * in a spec:
 *   - every tap, typed value and toggle waits for the screen to settle, then
 *     holds it static (`TAP_PAUSE_MS`) before acting;
 *   - after every action the resulting screen settles and is held static
 *     (`SETTLED_HOLD_MS`), so no screen the run passes through is shown for
 *     less than that, including screens the spec does not name;
 *   - every key result (balances, confirmations, a tip claimed, a scan, history
 *     detail) is held static (`RESULT_HOLD_MS`).
 * "Settled" means no loading or busy text is left on the page (bounded by
 * `SETTLE_PATIENCE_MS`, after which the hold runs anyway).
 *
 * Recording is opt-in (`FOOTAGE=guarded`). Playwright's own trace, screenshot
 * and video stay off: they cannot be guarded per frame. Instead one recorder
 * per wallet page takes about four frames a second, and for each frame:
 *   1. classifies the page's structure in the page, then decides in Node
 *      (`F-legacy-recovery-guard.mjs`): the known-secret canary never leaves
 *      this process, and a page outside the extension is redacted whole;
 *   2. if the screen is a secret, records a redaction card span and keeps no
 *      pixels;
 *   3. otherwise screenshots with every password field, share URL, tx key and
 *      filled claim-link input masked;
 *   4. classifies again and drops the frame if the two verdicts disagree.
 * Identical frames are deduplicated by hash, so long static holds cost no disk.
 * `secret(label, fn)` forces the card for a whole step (phrase import, password
 * entry, claim-link transfer) on every page, including a page that opens during
 * the step, and resumes only after two clean guard passes.
 *
 * Output: `<E2E_FOOTAGE_DIR>/raw/F-legacy-recovery/<wallet>/<session>/` (mode
 * 0700), one session per wallet import: a new worker (Playwright restarts it
 * after a failed test) or a later invocation never overwrites earlier footage.
 * Each session holds `page-N/` JPEG frames and `timeline.json` (frames with
 * their guard verdicts, card spans, dropped samples, every step and every hold
 * with planned and actual duration, and markers). Marker labels are a closed
 * set of static strings, so a value or URL can never become a label.
 * `scripts/F-legacy-recovery-encode.mjs` turns the timelines into video and
 * refuses one that breaks the policy.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  FRAME_GUARD_PATTERNS,
  classifyFrame,
  finalVerdict,
  maskSelectors,
  type Canary,
  type FrameVerdict,
} from './F-legacy-recovery-guard.mjs';
import { ACTION_TIMEOUT_MS, FOOTAGE_RUN, LANE_ID, footageEnabled, footageRoot } from './F-legacy-recovery-lane.mjs';

/** Static pause before every tap, typed value or toggle. */
export const TAP_PAUSE_MS = 6_000;
/** Static hold once a screen has settled, including after every action. */
export const SETTLED_HOLD_MS = 12_000;
/** Static hold on a key result. */
export const RESULT_HOLD_MS = 25_000;
/** Sampling interval: about four frames a second. */
export const FRAME_INTERVAL_MS = 250;
/** How long a settle waits for loading or busy text to clear before holding anyway. */
const SETTLE_PATIENCE_MS = 60_000;
/** Clean guard passes required before a secret scope ends. */
const CLEAN_PASSES_TO_RESUME = 2;
/** Text that means the screen is still changing. */
const BUSY_TEXT = /Updating…|Loading|Checking…|Asking the server…|Looking…|Preparing…|Claiming…|Sending…/;

export const FOOTAGE_POLICY = Object.freeze({
  tapPauseMs: TAP_PAUSE_MS,
  settledHoldMs: SETTLED_HOLD_MS,
  resultHoldMs: RESULT_HOLD_MS,
  frameIntervalMs: FRAME_INTERVAL_MS,
  holdAfterEveryStep: true,
});

/**
 * Every caption and marker this area may use. A closed set of literals: the
 * compiler refuses a dynamic string, so balances, addresses, txids and links
 * cannot reach the timeline or the video.
 */
export const FOOTAGE_LABELS = [
  'Wallet import and unlock (redacted)',
  'After the redacted step',
  'Home after import',
  'Home after unlock',
  'Home: no older-address notice',
  'Home: older-address notice',
  'Open Settings',
  'Settings: Older addresses and tips',
  'Settings: auto-lock',
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
  'After unlock: no second check',
  'Reopen the wallet window',
  'Reopened window: unlock needed',
  'Close the reopened window',
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
  'Move: cancel',
  'Move cancelled: nothing sent',
  'Move: confirm',
  'Move refused: still unlocking',
  'Password confirmation (redacted)',
  'Moved: result',
  'Older address empty after the move',
  'Open history detail',
  'Moved: history detail',
  'Moved: balance confirmed',
  'Finish claim',
  'Claim tip',
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
type StepEntry = { kind: 'tap' | 'enter' | 'check' | 'select' | 'secret'; label: FootageLabel; from: number; until: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const signature = (v: FrameVerdict) => `${v.kind}|${v.reasons.join(',')}`;

/** A unique, sortable directory name for one wallet session: time, worker, process. */
function sessionName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-w${process.env.TEST_WORKER_INDEX ?? '0'}-p${process.pid}`;
}

/** Wait for no loading or busy text on `page`, bounded; a closed page is settled. */
async function settle(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page
    .locator('#root')
    .filter({ hasText: BUSY_TEXT })
    .waitFor({ state: 'detached', timeout: SETTLE_PATIENCE_MS })
    .catch(() => {});
}

/** One recorder per page. Holds no secret: the canary stays in this process and is consulted here. */
class PageRecorder {
  readonly frames: FrameEntry[] = [];
  readonly cards: CardSpan[] = [];
  readonly dropped: { at: number; reason: string }[] = [];
  private stopped = false;
  private loop: Promise<void> | null = null;
  private seq = 0;

  constructor(
    private readonly page: Page,
    private readonly dir: string,
    private readonly canary: Canary,
    private secretLabel: string | null,
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
      const raw = await this.page.evaluate(classifyFrame, { patterns: FRAME_GUARD_PATTERNS });
      return finalVerdict(raw, this.canary);
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
          if (!shot || !after || signature(after) !== signature(before) || this.secretLabel) {
            this.dropped.push({ at: startedAt, reason: !shot ? 'no-screenshot' : this.secretLabel ? 'secret-began' : 'guard-disagreed' });
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
 * Footage for one wallet session. Every interaction in a live spec goes
 * through it, so a recorded run cannot skip a pause or a hold. With `FOOTAGE`
 * off nothing is captured and the holds are skipped, which keeps an unrecorded
 * rehearsal short; the steps, waits and assertions are identical.
 */
export class WalletFootage {
  readonly enabled: boolean;
  /** This session's directory (unique per import), or null when not recording. */
  readonly dir: string | null;
  private readonly recorders: PageRecorder[] = [];
  private readonly holds: HoldEntry[] = [];
  private readonly steps: StepEntry[] = [];
  private readonly marks: { label: FootageLabel; at: number; test: string }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private currentTest = '';
  private activeSecret: FootageLabel | null = null;
  private primary: Page | null = null;

  constructor(
    readonly wallet: string,
    private readonly canary: Canary,
  ) {
    this.enabled = footageEnabled();
    if (!this.enabled) {
      this.dir = null;
      return;
    }
    const walletDir = join(footageRoot(), 'raw', LANE_ID, wallet);
    let dir = join(walletDir, sessionName());
    for (let n = 2; existsSync(dir); n++) dir = join(walletDir, `${sessionName()}-${n}`);
    for (const d of [footageRoot(), join(footageRoot(), 'raw'), join(footageRoot(), 'raw', LANE_ID), walletDir, dir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    this.dir = dir;
    this.flushTimer = setInterval(() => this.flush(), 30_000);
  }

  /** Start recording a page (the wallet page, or any page the wallet opens). A page opened during a secret step starts redacted. */
  attach(page: Page): void {
    this.primary ??= page;
    if (!this.enabled || !this.dir) return;
    const frames = join(this.dir, `page-${this.recorders.length}`);
    mkdirSync(frames, { recursive: true, mode: 0o700 });
    const recorder = new PageRecorder(page, frames, this.canary, this.activeSecret);
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

  private async visible(target: Locator, label: FootageLabel): Promise<void> {
    await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS }).catch(() => {
      throw new Error(`footage step "${label}": its target was not visible within ${ACTION_TIMEOUT_MS / 1000} s`);
    });
  }

  /**
   * One action with the policy around it: wait for the target and a settled
   * screen, mark, hold still, act, then let the result settle and hold it.
   */
  private async step(kind: StepEntry['kind'], target: Locator, label: FootageLabel, act: () => Promise<void>): Promise<void> {
    await this.visible(target, label);
    const page = target.page();
    await settle(page);
    this.mark(label);
    const from = Date.now();
    await this.hold('pre-tap', label, TAP_PAUSE_MS);
    await act().catch((error: unknown) => {
      throw new Error(`footage step "${label}" could not act: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
    });
    if (this.enabled) this.steps.push({ kind, label, from, until: Date.now() });
    await settle(page);
    await this.hold('settled', label, SETTLED_HOLD_MS);
  }

  /** Static pause, the tap, then a held settled screen. */
  async tap(target: Locator, label: FootageLabel): Promise<void> {
    await this.step('tap', target, label, () => target.click({ timeout: ACTION_TIMEOUT_MS }));
  }

  /** Static pause, type a value that is NOT secret (an amount, an address), then hold. */
  async enter(target: Locator, value: string, label: FootageLabel): Promise<void> {
    await this.step('enter', target, label, () => target.fill(value, { timeout: ACTION_TIMEOUT_MS }));
  }

  /** Toggle a checkbox to a state, with the same pause and hold as a tap. */
  async setChecked(target: Locator, checked: boolean, label: FootageLabel): Promise<void> {
    await this.step('check', target, label, () => target.setChecked(checked, { timeout: ACTION_TIMEOUT_MS }));
  }

  /** Choose an option of a select, with the same pause and hold as a tap. */
  async select(target: Locator, value: string, label: FootageLabel): Promise<void> {
    await this.step('select', target, label, async () => {
      await target.selectOption({ value }, { timeout: ACTION_TIMEOUT_MS });
    });
  }

  /** Wait for loading text to clear on `page`, then hold the settled screen. */
  async settled(page: Page, label: FootageLabel): Promise<void> {
    await settle(page);
    this.mark(label);
    await this.hold('settled', label, SETTLED_HOLD_MS);
  }

  /** Hold a key result on screen, once the wallet page has settled. */
  async result(label: FootageLabel): Promise<void> {
    if (this.primary) await settle(this.primary);
    this.mark(label);
    await this.hold('result', label, RESULT_HOLD_MS);
  }

  /**
   * Run `fn` behind a redaction card on every recorded page, including one
   * opened meanwhile. Recording resumes only after two consecutive clean guard
   * passes, so a secret that lingers after `fn` stays redacted; then the
   * resulting screen settles and is held.
   */
  async secret<T>(label: FootageLabel, fn: () => Promise<T>): Promise<T> {
    this.mark(label);
    const from = Date.now();
    this.activeSecret = label;
    for (const r of this.recorders) r.enterSecret(label);
    let value: T;
    try {
      value = await fn();
    } finally {
      this.activeSecret = null;
      await Promise.all(this.recorders.map((r) => r.leaveSecret()));
    }
    if (this.enabled) this.steps.push({ kind: 'secret', label, from, until: Date.now() });
    if (this.primary) await settle(this.primary);
    // The card is down: caption the screen it left behind as what it is.
    this.mark('After the redacted step');
    await this.hold('settled', 'After the redacted step', SETTLED_HOLD_MS);
    return value;
  }

  private flush(): void {
    if (!this.enabled || !this.dir) return;
    const timeline = {
      area: LANE_ID,
      wallet: this.wallet,
      run: FOOTAGE_RUN,
      policy: FOOTAGE_POLICY,
      pages: this.recorders.map((r, i) => ({
        dir: `page-${i}`,
        frames: r.frames,
        cards: r.cards,
        dropped: r.dropped,
      })),
      steps: this.steps,
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
