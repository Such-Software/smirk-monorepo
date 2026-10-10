/**
 * C-tips guarded footage: the live tip lane's recorder and dead-air policy.
 *
 * Playwright's own trace, screenshot and video stay off (capture-policy.mjs):
 * they cannot be guarded frame by frame. Instead each wallet page gets a
 * screenshot loop, and every frame passes the guard in C-tips-guard.mjs twice,
 * before and after the screenshot. A frame is kept clean, kept with masks over
 * claim links and key material, or replaced by a static card; a frame whose two
 * verdicts disagree is dropped. Identical consecutive frames are deduplicated
 * by hash and stored once with a time span, so long static holds cost no disk.
 *
 * Dead air is enforced here, never with ad hoc sleeps in a spec:
 *   - tap():     the screen holds still HOLD_BEFORE_TAP_MS, the guard runs, then the click.
 *   - settled(): waits for loading indicators to clear, then holds HOLD_SETTLED_MS.
 *   - result():  holds HOLD_RESULT_MS on a key result (balance, confirmation,
 *                tip claimed, message received, status, detail).
 *   - secret():  switches the page to a redaction card around phrase, password
 *                and claim-link entry, and resumes only after two clean guard passes.
 * Every hold is written to the lane timeline, and a hold shorter than its policy
 * throws. Marker labels are static strings (assertStaticLabel).
 *
 * Output: ~/Build/smirk-e2e/<run>/footage/raw/C-tips/<wallet>/ (directories
 * 0700, files 0600). Nothing is uploaded or promoted from here.
 */
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  C_TIPS_RULES,
  MASK_SELECTOR,
  PRIVATE_TEXT,
  assertStaticLabel,
  cTipsSurvey,
  findLeak,
  secretSurface,
} from './C-tips-guard.mjs';

/** Static pause before every tap. */
export const HOLD_BEFORE_TAP_MS = 6_000;
/** Every settled screen holds at least this long. */
export const HOLD_SETTLED_MS = 12_000;
/** Key results hold at least this long. */
export const HOLD_RESULT_MS = 25_000;
/** About four frames a second per wallet page. */
export const CAPTURE_INTERVAL_MS = 250;
/** A secret scope ends only after this many consecutive clean guard passes. */
export const CLEAN_PASSES_TO_RESUME = 2;
/** Upper bound on waiting for loading indicators before a settled hold. */
export const SETTLE_PATIENCE_MS = 60_000;
/** Upper bound on a tap target appearing and accepting the click. */
export const TAP_PATIENCE_MS = 90_000;

export const VIEWPORT = { width: 380, height: 600 } as const;
export const DEVICE_SCALE = 2;

const HOLD_POLICY = {
  tap: HOLD_BEFORE_TAP_MS,
  settled: HOLD_SETTLED_MS,
  result: HOLD_RESULT_MS,
} as const;
type HoldType = keyof typeof HOLD_POLICY;

/** `FOOTAGE=guarded` records; unset (or off) records nothing and skips holds. */
export function footageMode(env: Record<string, string | undefined> = process.env): 'guarded' | 'off' {
  const value = (env.FOOTAGE ?? '').trim().toLowerCase();
  if (value === 'guarded') return 'guarded';
  if (['', '0', 'off', 'false', 'no'].includes(value)) return 'off';
  throw new Error('FOOTAGE accepts only "guarded" (the reviewed guarded recorder) or off.');
}

export function footageRoot(env: Record<string, string | undefined> = process.env): string {
  const run = (env.E2E_RUN_LABEL ?? 'v0.3.1-run-11204').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(run)) throw new Error('E2E_RUN_LABEL must be a short file-name-safe label.');
  return (env.FOOTAGE_DIR ?? '').trim() || join(homedir(), 'Build', 'smirk-e2e', run, 'footage');
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

type Verdict =
  | { kind: 'card'; card: string }
  | { kind: 'ok'; masked: number; signature: string };

interface FrameEntry {
  file: string;
  from: number;
  to: number;
  verdict: 'clean' | 'masked' | 'card';
  card?: string;
}

interface HoldEntry {
  type: HoldType;
  label: string;
  wallet: string;
  from: number;
  to: number;
  policyMs: number;
}

/** Card labels name the kind of surface, never its content. */
const CARD = {
  strict: 'Protected screen hidden',
  phrase: 'Recovery phrase hidden',
  leak: 'Private value hidden',
  unreadable: 'Screen changing',
} as const;

class PageRecorder {
  readonly frames: FrameEntry[] = [];
  dropped = 0;
  private stopped = false;
  private forced: string | null = null;
  private lastHash: string | null = null;
  private seq = 0;
  private loop: Promise<void> | null = null;

  constructor(
    readonly name: string,
    readonly page: Page,
    private readonly dir: string,
    private readonly lane: GuardedFootage,
  ) {}

  start(): void {
    this.loop = (async () => {
      while (!this.stopped && !this.page.isClosed()) {
        const started = Date.now();
        await this.captureOnce().catch(() => {
          this.dropped += 1;
        });
        const wait = CAPTURE_INTERVAL_MS - (Date.now() - started);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    const last = this.frames.at(-1);
    if (last) last.to = Date.now();
  }

  force(card: string | null): void {
    this.forced = card;
  }

  /** One guard verdict: strict guard, then the C-tips survey and canary. */
  async verdict(): Promise<Verdict> {
    if (this.page.isClosed()) return { kind: 'card', card: CARD.unreadable };
    try {
      const strict = await this.page.evaluate(secretSurface, PRIVATE_TEXT);
      if (strict) return { kind: 'card', card: CARD.strict };
      const survey = await this.page.evaluate(cTipsSurvey, C_TIPS_RULES);
      if (survey.card) return { kind: 'card', card: CARD.phrase };
      if (findLeak(survey.segments, this.lane.knownSecrets())) return { kind: 'card', card: CARD.leak };
      return { kind: 'ok', masked: survey.masked, signature: survey.signature };
    } catch {
      return { kind: 'card', card: CARD.unreadable };
    }
  }

  private async captureOnce(): Promise<void> {
    const at = Date.now();
    if (this.forced) {
      await this.keep(await this.lane.cardImage(this.forced, this.name), at, 'card', this.forced);
      return;
    }
    const before = await this.verdict();
    if (before.kind === 'card') {
      await this.keep(await this.lane.cardImage(before.card, this.name), at, 'card', before.card);
      return;
    }
    const masks: Locator[] = [
      this.page.locator(MASK_SELECTOR),
      this.page.locator(C_TIPS_RULES.maskSelectors.join(', ')),
    ];
    const image = await this.page.screenshot({
      type: 'jpeg',
      quality: 85,
      mask: masks,
      maskColor: '#1b1726',
      caret: 'hide',
      timeout: 10_000,
    });
    const after = await this.verdict();
    // A frame is kept only when the page did not change what must be hidden
    // while it was being captured.
    if (after.kind !== 'ok' || after.signature !== before.signature || this.forced) {
      this.dropped += 1;
      return;
    }
    await this.keep(image, at, before.masked > 0 ? 'masked' : 'clean');
  }

  private async keep(image: Buffer, at: number, verdict: FrameEntry['verdict'], card?: string): Promise<void> {
    const previous = this.frames.at(-1);
    if (previous) previous.to = at;
    const hash = createHash('sha256').update(image).digest('hex');
    if (previous && hash === this.lastHash) return;
    this.lastHash = hash;
    const file = `${String(this.seq++).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, file), image, { mode: 0o600 });
    this.frames.push({ file, from: at, to: at, verdict, ...(card ? { card } : {}) });
  }

  timeline(): object {
    return {
      wallet: this.name,
      area: 'C-tips',
      viewport: VIEWPORT,
      scale: DEVICE_SCALE,
      captureIntervalMs: CAPTURE_INTERVAL_MS,
      dropped: this.dropped,
      frames: this.frames,
    };
  }
}

/**
 * One recorder per wallet page plus the lane timeline. With FOOTAGE off it
 * records nothing and every hold returns at once.
 */
export class GuardedFootage {
  readonly mode = footageMode();
  private readonly recorders = new Map<Page, PageRecorder>();
  private readonly holds: HoldEntry[] = [];
  private readonly chapters: { label: string; at: number }[] = [];
  private readonly guardChecks: { label: string; wallet: string; at: number; verdict: string }[] = [];
  private readonly exactSecrets = new Set<string>();
  private phraseWords: string[] = [];
  private cardBrowser: Browser | null = null;
  private readonly cards = new Map<string, Buffer>();
  private readonly dir: string | null;

  constructor() {
    this.dir = this.mode === 'guarded' ? privateDir(join(privateDir(footageRoot()), 'raw', 'C-tips')) : null;
    if (this.dir) privateDir(join(footageRoot(), 'raw'));
  }

  get recording(): boolean {
    return this.mode === 'guarded';
  }

  /** Register a value that must never appear unmasked: a claim fragment, a password. */
  registerSecret(value: string): void {
    if (value.length >= 8) this.exactSecrets.add(value);
  }

  /** Register phrase words for the three-consecutive-words canary. */
  registerPhraseWords(words: readonly string[]): void {
    this.phraseWords = this.phraseWords.concat(words);
  }

  knownSecrets(): { exact: string[]; phraseWords: string[] } {
    return { exact: [...this.exactSecrets], phraseWords: this.phraseWords };
  }

  /** Start recording a page under a wallet name (alice, bob, carol, or a second tab). */
  attach(name: string, page: Page): void {
    if (!this.dir || this.recorders.has(page)) return;
    const safe = name.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'page';
    let unique = safe;
    for (let i = 2; [...this.recorders.values()].some((r) => r.name === unique); i++) unique = `${safe}-${i}`;
    const recorder = new PageRecorder(unique, page, privateDir(join(this.dir, unique)), this);
    this.recorders.set(page, recorder);
    recorder.start();
  }

  private walletOf(page: Page): string {
    return this.recorders.get(page)?.name ?? 'unrecorded';
  }

  chapter(label: string): void {
    this.chapters.push({ label: assertStaticLabel(label), at: Date.now() });
  }

  private async hold(type: HoldType, page: Page, label: string): Promise<void> {
    assertStaticLabel(label);
    if (!this.recording) return;
    const policyMs = HOLD_POLICY[type];
    const from = Date.now();
    await page.waitForTimeout(policyMs);
    const to = Date.now();
    if (to - from < policyMs) throw new Error(`a ${type} hold ran shorter than its policy`);
    this.holds.push({ type, label, wallet: this.walletOf(page), from, to, policyMs });
  }

  /** Run the guard once and note its verdict (kind only) in the lane timeline. */
  async check(page: Page, label: string): Promise<void> {
    const recorder = this.recorders.get(page);
    if (!recorder) return;
    const verdict = await recorder.verdict();
    this.guardChecks.push({
      label,
      wallet: recorder.name,
      at: Date.now(),
      verdict: verdict.kind === 'card' ? `card: ${verdict.card}` : verdict.masked > 0 ? 'masked' : 'clean',
    });
  }

  /** Hold still, run the guard, then click. The only way a live spec taps. */
  async tap(locator: Locator, label: string): Promise<void> {
    const page = locator.page();
    await locator.waitFor({ state: 'visible', timeout: TAP_PATIENCE_MS });
    await this.hold('tap', page, label);
    await this.check(page, label);
    await locator.click({ timeout: TAP_PATIENCE_MS });
  }

  /** Tap a field and type a NON-secret value (an amount, an npub, a message). */
  async fill(locator: Locator, value: string, label: string): Promise<void> {
    await this.tap(locator, label);
    await locator.fill(value, { timeout: TAP_PATIENCE_MS });
  }

  /** Type a secret into a field behind a redaction card. */
  async secretFill(locator: Locator, value: string, label: string): Promise<void> {
    await this.secret(locator.page(), label, async () => {
      await locator.waitFor({ state: 'visible', timeout: TAP_PATIENCE_MS });
      await locator.fill(value, { timeout: TAP_PATIENCE_MS });
    });
  }

  /** Choose a select option (a non-secret setting). */
  async select(locator: Locator, value: string, label: string): Promise<void> {
    await this.tap(locator, label);
    await locator.selectOption(value, { timeout: TAP_PATIENCE_MS });
  }

  /** Wait for loading indicators to clear, then hold the settled screen. */
  async settled(page: Page, label: string): Promise<void> {
    await page
      .locator('#root')
      .filter({ hasText: /Updating…|Loading…|Refreshing…|Setting up wallet/ })
      .waitFor({ state: 'detached', timeout: SETTLE_PATIENCE_MS })
      .catch(() => undefined);
    await this.hold('settled', page, label);
  }

  /** Hold a key result on screen. */
  async result(page: Page, label: string): Promise<void> {
    await this.hold('result', page, label);
  }

  /**
   * Show a redaction card on this page while `fn` runs, then resume only after
   * consecutive clean guard passes. With no recorder it just runs `fn`.
   */
  async secret<T>(page: Page, label: string, fn: () => Promise<T>): Promise<T> {
    assertStaticLabel(label);
    const recorder = this.recorders.get(page);
    if (!recorder) return fn();
    recorder.force(label);
    this.chapters.push({ label: `Hidden: ${label}`, at: Date.now() });
    try {
      return await fn();
    } finally {
      let clean = 0;
      const deadline = Date.now() + 30_000;
      while (clean < CLEAN_PASSES_TO_RESUME && Date.now() < deadline) {
        const verdict = await recorder.verdict();
        clean = verdict.kind === 'ok' ? clean + 1 : 0;
        if (clean < CLEAN_PASSES_TO_RESUME) await new Promise((resolve) => setTimeout(resolve, CAPTURE_INTERVAL_MS));
      }
      // Each later frame is still guarded on its own, so releasing the card
      // after a timeout never records an unguarded frame.
      this.guardChecks.push({
        label,
        wallet: recorder.name,
        at: Date.now(),
        verdict: clean >= CLEAN_PASSES_TO_RESUME ? 'resumed after clean passes' : 'resumed with per-frame guard only',
      });
      recorder.force(null);
    }
  }

  /** A static card frame, rendered in a separate wallet-free browser. */
  async cardImage(label: string, wallet: string): Promise<Buffer> {
    const key = `${wallet}\u0000${label}`;
    const cached = this.cards.get(key);
    if (cached) return cached;
    this.cardBrowser ??= await chromium.launch({ headless: true });
    const page = await this.cardBrowser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    try {
      await page.setContent(
        `<body style="margin:0;background:#0d0b14;color:#f5f3ff;font:600 18px system-ui,sans-serif;display:grid;place-items:center;height:100vh;text-align:center">` +
          `<div><div style="font-size:42px;margin-bottom:16px">&#128274;</div><div id="l"></div>` +
          `<div id="w" style="margin-top:10px;font-weight:400;font-size:13px;opacity:.6"></div></div></body>`,
      );
      await page.evaluate(
        ([l, w]) => {
          document.getElementById('l')!.textContent = l;
          document.getElementById('w')!.textContent = w;
        },
        [label, `${wallet}: hidden for privacy`] as const,
      );
      const image = await page.screenshot({ type: 'jpeg', quality: 85 });
      this.cards.set(key, image);
      return image;
    } finally {
      await page.close();
    }
  }

  /** Stop every recorder and write the timelines. Holds are re-checked here. */
  async close(): Promise<void> {
    const recorders = [...this.recorders.values()];
    await Promise.all(recorders.map((r) => r.stop()));
    this.recorders.clear();
    await this.cardBrowser?.close().catch(() => undefined);
    this.cardBrowser = null;
    this.phraseWords.fill('');
    this.phraseWords = [];
    this.exactSecrets.clear();
    if (!this.dir) return;
    for (const recorder of recorders) {
      writeFileSync(join(this.dir, recorder.name, 'timeline.json'), JSON.stringify(recorder.timeline(), null, 1), {
        mode: 0o600,
      });
    }
    const short = this.holds.filter((h) => h.to - h.from < h.policyMs);
    writeFileSync(
      join(this.dir, 'lane.json'),
      JSON.stringify(
        {
          area: 'C-tips',
          policy: { tapMs: HOLD_BEFORE_TAP_MS, settledMs: HOLD_SETTLED_MS, resultMs: HOLD_RESULT_MS },
          wallets: recorders.map((r) => r.name),
          chapters: this.chapters,
          holds: this.holds,
          guardChecks: this.guardChecks,
          shortHolds: short.length,
        },
        null,
        1,
      ),
      { mode: 0o600 },
    );
    if (short.length) throw new Error(`${short.length} footage hold(s) ran shorter than policy`);
  }
}
