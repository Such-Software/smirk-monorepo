/**
 * C-tips guarded footage: the live tip lane's recorder and dead-air policy.
 *
 * Playwright's own trace, screenshot and video stay off (capture-policy.mjs):
 * they cannot be guarded frame by frame. Instead each wallet page gets a
 * screenshot loop, and every frame passes the guard in C-tips-guard.mjs twice,
 * before and after the screenshot. A frame is kept clean, kept with masks over
 * claim links and key material, or replaced by a static card. A frame is
 * dropped when the two verdicts disagree, or when any element the mask rules
 * select lacks this capture's nonce afterwards (the app re-created it between
 * the survey and the screenshot, so it may have been captured unmasked).
 * Identical consecutive frames are deduplicated by hash and stored once with a
 * time span, so long static holds cost no disk.
 *
 * POLICY NOTE: capture-policy.mjs says the wallet suite has no capture lane, and
 * fixtures/footage.ts says a new lane needs a separate secret-free fixture. This
 * recorder is a new capture lane over live wallet sessions. It is closed unless
 * FOOTAGE=guarded and runs only through C-tips.live.config.ts; it still needs
 * the owner's explicit sign-off against that policy before its output is used.
 *
 * Dead air is enforced here, never with ad hoc sleeps in a spec. Every hold
 * waits until the RECORDED frame has stayed identical for the whole policy
 * time, so a screen that changes mid-hold (a balance refresh) restarts the
 * hold instead of passing it:
 *   - tap():     the screen holds still `tap` ms, the guard runs, the click
 *                lands, and the resulting screen holds `settled` ms.
 *   - fill(), select(), secretFill(): the same, around typing or choosing.
 *   - settled(): waits for loading indicators to clear, then holds `settled` ms.
 *   - result():  holds `result` ms on a key result (balance, confirmation,
 *                tip claimed, message received, status, detail).
 *   - secret():  shows a redaction card around phrase, password and claim-link
 *                entry, and resumes only after two clean guard passes.
 * A hold that cannot find a still screen within its patience is recorded as
 * not static rather than failing a money flow halfway; the run's teardown
 * (scripts/C-tips-encode.mjs) fails the run for it. Marker labels are static
 * strings (assertStaticLabel).
 *
 * Output: footage/raw/C-tips/<invocation>/<session>/<page>/ (directories 0700,
 * files 0600), see C-tips-run.mjs. Nothing is uploaded or promoted from here.
 */
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  C_TIPS_RULES,
  PRIVATE_TEXT,
  assertStaticLabel,
  cTipsSurvey,
  findLeak,
  maskSelectorFor,
  secretSurface,
} from './C-tips-guard.mjs';
import { OWNER_POLICY, footageRoot, invocationId, privateDir, rawRoot } from './C-tips-run.mjs';
import { noteStep } from './failure-context.js';

/** Static pause before every tap. */
export const HOLD_BEFORE_TAP_MS = OWNER_POLICY.tap;
/** Every settled screen holds at least this long. */
export const HOLD_SETTLED_MS = OWNER_POLICY.settled;
/** Key results hold at least this long. */
export const HOLD_RESULT_MS = OWNER_POLICY.result;
/** About four frames a second per wallet page. */
export const CAPTURE_INTERVAL_MS = 250;
/** A secret scope ends only after this many consecutive clean guard passes. */
export const CLEAN_PASSES_TO_RESUME = 2;
/** Upper bound on waiting for loading indicators before a settled hold. */
export const SETTLE_PATIENCE_MS = 60_000;
/** How much longer than its policy a hold may wait for the screen to go still. */
export const STATIC_PATIENCE_MS = 180_000;
/** How often timelines and the lane file are rewritten during a session. */
const FLUSH_INTERVAL_MS = 30_000;
/** Upper bound on a tap target appearing and accepting the click. */
export const TAP_PATIENCE_MS = 90_000;

/**
 * Applied to each screenshot only (never to the app): the balance refresh
 * every 25 s shows an "Updating…" cue and dims the header's refresh button,
 * which would break every long hold on a screen whose content did not change.
 * Only the in-flight state is neutralized; a warning or error cue still shows,
 * and a changed balance still changes the frame (and restarts a hold).
 */
export const CAPTURE_STYLE =
  '[data-testid="balance-freshness-cue"][data-freshness="updating"]{visibility:hidden !important}' +
  'button[aria-label="Refresh balances"]{opacity:.75 !important}';

/** Loading text that means a screen is not settled yet, when it is visible. */
const BUSY_TEXT = /Updating…|Loading…|Refreshing…|Setting up wallet/;

export const VIEWPORT = { width: 380, height: 600 } as const;
export const DEVICE_SCALE = 2;

export type HoldType = 'tap' | 'settled' | 'result';
export interface HoldPolicy {
  tap: number;
  settled: number;
  result: number;
}

/** `FOOTAGE=guarded` records; unset (or off) records nothing and skips holds. */
export function footageMode(env: Record<string, string | undefined> = process.env): 'guarded' | 'off' {
  const value = (env.FOOTAGE ?? '').trim().toLowerCase();
  if (value === 'guarded') return 'guarded';
  if (['', '0', 'off', 'false', 'no'].includes(value)) return 'off';
  throw new Error(
    'FOOTAGE accepts only "guarded" (the C-tips guarded recorder, a new capture lane pending owner sign-off) or off.',
  );
}

export { footageRoot };

type Verdict =
  | { kind: 'card'; card: string }
  | { kind: 'ok'; masked: number; unmarked: number; signature: string };

interface FrameEntry {
  file: string;
  from: number;
  to: number;
  verdict: 'clean' | 'masked' | 'card';
  card?: string;
}

export interface HoldEntry {
  type: HoldType;
  label: string;
  wallet: string;
  /** When the hold was asked for. */
  requestedAt: number;
  /** The still window: one recorded frame covered all of [from, to]. */
  from: number;
  to: number;
  policyMs: number;
  /** False when no still window of `policyMs` appeared within the patience. */
  static: boolean;
}

/** Card labels name the kind of surface, never its content. */
const CARD = {
  strict: 'Protected screen hidden',
  phrase: 'Recovery phrase hidden',
  leak: 'Private value hidden',
  unreadable: 'Screen changing',
} as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class PageRecorder {
  readonly frames: FrameEntry[] = [];
  dropped = 0;
  /** When the frame now on record started (epoch ms). */
  frameSince = 0;
  /** The last capture that confirmed the frame now on record (epoch ms). */
  confirmedAt = 0;
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
      let flushedAt = Date.now();
      while (!this.stopped && !this.page.isClosed()) {
        const started = Date.now();
        await this.captureOnce().catch(() => {
          this.dropped += 1;
        });
        // A worker killed mid-run still leaves a usable timeline.
        if (started - flushedAt > FLUSH_INTERVAL_MS) {
          this.writeTimeline();
          flushedAt = started;
        }
        const wait = CAPTURE_INTERVAL_MS - (Date.now() - started);
        if (wait > 0) await sleep(wait);
      }
    })();
  }

  writeTimeline(): void {
    writeFileSync(join(this.dir, 'timeline.json'), JSON.stringify(this.timeline(), null, 1), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    const last = this.frames.at(-1);
    if (last) last.to = Math.max(last.to, this.confirmedAt);
  }

  force(card: string | null): void {
    this.forced = card;
  }

  /** One guard verdict: strict guard, then the C-tips survey and canary. */
  async verdict(mode: 'scan' | 'mark' | 'verify', nonce: string | null): Promise<Verdict> {
    if (this.page.isClosed()) return { kind: 'card', card: CARD.unreadable };
    try {
      const strict = await this.page.evaluate(secretSurface, PRIVATE_TEXT);
      if (strict) return { kind: 'card', card: CARD.strict };
      const survey = await this.page.evaluate(cTipsSurvey, { rules: C_TIPS_RULES, nonce, mode });
      if (survey.card) return { kind: 'card', card: CARD.phrase };
      if (findLeak(survey.segments, this.lane.knownSecrets())) return { kind: 'card', card: CARD.leak };
      return { kind: 'ok', masked: survey.masked, unmarked: survey.unmarked, signature: survey.signature };
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
    const nonce = randomBytes(8).toString('hex');
    const before = await this.verdict('mark', nonce);
    if (before.kind === 'card') {
      await this.keep(await this.lane.cardImage(before.card, this.name), at, 'card', before.card);
      return;
    }
    const masks: Locator[] = [
      this.page.locator(maskSelectorFor(nonce)),
      this.page.locator(C_TIPS_RULES.maskSelectors.join(', ')),
    ];
    const image = await this.page.screenshot({
      type: 'jpeg',
      quality: 85,
      mask: masks,
      maskColor: '#1b1726',
      caret: 'hide',
      // Frozen CSS animation keeps a still screen byte-identical between captures.
      animations: 'disabled',
      style: CAPTURE_STYLE,
      timeout: 10_000,
    });
    const after = await this.verdict('verify', nonce);
    // Kept only when nothing that must be hidden changed while it was captured,
    // and every masked element is still the one this capture marked.
    if (after.kind !== 'ok' || after.unmarked > 0 || after.signature !== before.signature || this.forced) {
      this.dropped += 1;
      return;
    }
    await this.keep(image, at, before.masked > 0 ? 'masked' : 'clean');
  }

  private async keep(image: Buffer, at: number, verdict: FrameEntry['verdict'], card?: string): Promise<void> {
    const previous = this.frames.at(-1);
    if (previous) previous.to = at;
    const hash = createHash('sha256').update(image).digest('hex');
    if (previous && hash === this.lastHash) {
      this.confirmedAt = at;
      return;
    }
    this.lastHash = hash;
    const file = `${String(this.seq++).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, file), image, { mode: 0o600 });
    this.frames.push({ file, from: at, to: at, verdict, ...(card ? { card } : {}) });
    this.frameSince = at;
    this.confirmedAt = at;
  }

  timeline(): object {
    return {
      page: this.name,
      area: 'C-tips',
      viewport: VIEWPORT,
      scale: DEVICE_SCALE,
      captureIntervalMs: CAPTURE_INTERVAL_MS,
      dropped: this.dropped,
      frames: this.frames,
    };
  }
}

export interface FootageOptions {
  /** Hold lengths; the live lane always uses OWNER_POLICY (offline tests shorten it). */
  policy?: HoldPolicy;
  /** Extra time a hold may wait for a still screen. */
  staticPatienceMs?: number;
}

export interface FootageSummary {
  dir: string | null;
  holds: number;
  nonStaticHolds: number;
}

/**
 * One recorder per wallet page plus this session's lane timeline. With FOOTAGE
 * off it records nothing and every hold returns at once.
 */
export class GuardedFootage {
  readonly mode = footageMode();
  readonly policy: HoldPolicy;
  readonly session = `s${Date.now().toString(36)}-${process.pid}`;
  private readonly startedAt = Date.now();
  private readonly staticPatienceMs: number;
  private readonly recorders = new Map<Page, PageRecorder>();
  private readonly retired: PageRecorder[] = [];
  private readonly holds: HoldEntry[] = [];
  private readonly chapters: { label: string; at: number }[] = [];
  private readonly guardChecks: { label: string; page: string; at: number; verdict: string }[] = [];
  private readonly exactSecrets = new Set<string>();
  private phraseWords: string[] = [];
  private cardBrowser: Browser | null = null;
  private readonly cards = new Map<string, Buffer>();
  private readonly dir: string | null;
  private laneWrittenAt = 0;

  constructor(options: FootageOptions = {}) {
    this.policy = { ...(options.policy ?? OWNER_POLICY) };
    this.staticPatienceMs = options.staticPatienceMs ?? STATIC_PATIENCE_MS;
    if (this.mode === 'guarded') {
      privateDir(footageRoot());
      privateDir(join(footageRoot(), 'raw'));
      const invocation = privateDir(join(privateDir(rawRoot()), invocationId()));
      this.dir = privateDir(join(invocation, this.session));
    } else {
      this.dir = null;
    }
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
    const taken = new Set([...this.recorders.values(), ...this.retired].map((r) => r.name));
    let unique = safe;
    for (let i = 2; taken.has(unique); i++) unique = `${safe}-${i}`;
    const recorder = new PageRecorder(unique, page, privateDir(join(this.dir, unique)), this);
    this.recorders.set(page, recorder);
    page.once('close', () => {
      // A closed page's frames stay in the session; its recorder stops by itself.
      this.recorders.delete(page);
      this.retired.push(recorder);
    });
    recorder.start();
  }

  isRecorded(page: Page): boolean {
    return this.recorders.has(page);
  }

  chapter(label: string): void {
    this.chapters.push({ label: assertStaticLabel(label), at: Date.now() });
  }

  /**
   * Hold until the recorded frame of `page` has stayed identical for the
   * policy time. A change restarts the window. Records the still window, or a
   * non-static entry once the patience runs out.
   */
  private async hold(type: HoldType, page: Page, label: string): Promise<void> {
    assertStaticLabel(label);
    if (!this.recording) return;
    const recorder = this.recorders.get(page);
    if (!recorder) throw new Error(`a ${type} hold was asked for on a page the recorder is not attached to`);
    const policyMs = this.policy[type];
    const requestedAt = Date.now();
    const deadline = requestedAt + policyMs + this.staticPatienceMs;
    for (;;) {
      const since = Math.max(requestedAt, recorder.frameSince);
      if (recorder.confirmedAt - since >= policyMs) {
        this.holds.push({ type, label, wallet: recorder.name, requestedAt, from: since, to: recorder.confirmedAt, policyMs, static: true });
        this.maybeFlushLane();
        return;
      }
      if (Date.now() > deadline || page.isClosed()) {
        this.holds.push({ type, label, wallet: recorder.name, requestedAt, from: requestedAt, to: Date.now(), policyMs, static: false });
        this.maybeFlushLane();
        return;
      }
      await sleep(100);
    }
  }

  /** Run the guard once (read only) and note its verdict (kind only) in the lane timeline. */
  async check(page: Page, label: string): Promise<void> {
    const recorder = this.recorders.get(page);
    if (!recorder) return;
    const verdict = await recorder.verdict('scan', null);
    this.guardChecks.push({
      label,
      page: recorder.name,
      at: Date.now(),
      verdict: verdict.kind === 'card' ? `card: ${verdict.card}` : verdict.masked > 0 ? 'masked' : 'clean',
    });
  }

  /**
   * Hold still, run the guard, click, then hold the resulting screen. The only
   * way a live spec taps. Pass `settle: false` when the tap starts a long
   * operation whose outcome the caller waits for and holds itself.
   */
  async tap(locator: Locator, label: string, options: { settle?: boolean } = {}): Promise<void> {
    noteStep(label);
    const page = locator.page();
    await locator.waitFor({ state: 'visible', timeout: TAP_PATIENCE_MS });
    await this.hold('tap', page, label);
    await this.check(page, label);
    await locator.click({ timeout: TAP_PATIENCE_MS });
    if (options.settle !== false) await this.settled(page, label);
  }

  /** Tap a field, type a NON-secret value (an amount, an npub, a message), and hold the result. */
  async fill(locator: Locator, value: string, label: string): Promise<void> {
    await this.tap(locator, label, { settle: false });
    await locator.fill(value, { timeout: TAP_PATIENCE_MS });
    await this.settled(locator.page(), label);
  }

  /** Type a secret into a field behind a redaction card, then hold the (masked) result. */
  async secretFill(locator: Locator, value: string, label: string): Promise<void> {
    noteStep(label);
    await this.secret(locator.page(), label, async () => {
      await locator.waitFor({ state: 'visible', timeout: TAP_PATIENCE_MS });
      await locator.fill(value, { timeout: TAP_PATIENCE_MS });
    });
    await this.settled(locator.page(), label);
  }

  /** Choose a select option (a non-secret setting), and hold the result. */
  async select(locator: Locator, value: string, label: string): Promise<void> {
    await this.tap(locator, label, { settle: false });
    await locator.selectOption(value, { timeout: TAP_PATIENCE_MS });
    await this.settled(locator.page(), label);
  }

  /**
   * Wait for VISIBLE loading text to clear, then hold the settled screen. (The
   * balance cue keeps its "Updating…" label mounted but hidden between
   * refreshes, so text presence alone would mean waiting out the patience.)
   */
  async settled(page: Page, label: string): Promise<void> {
    noteStep(label);
    const busy = page.getByText(BUSY_TEXT).filter({ visible: true });
    const deadline = Date.now() + SETTLE_PATIENCE_MS;
    while (Date.now() < deadline && !page.isClosed() && (await busy.count().catch(() => 0)) > 0) await sleep(250);
    await this.hold('settled', page, label);
  }

  /** Hold a key result on screen. */
  async result(page: Page, label: string): Promise<void> {
    noteStep(label);
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
        const verdict = await recorder.verdict('scan', null);
        clean = verdict.kind === 'ok' ? clean + 1 : 0;
        if (clean < CLEAN_PASSES_TO_RESUME) await sleep(CAPTURE_INTERVAL_MS);
      }
      // Each later frame is still guarded on its own, so releasing the card
      // after a timeout never records an unguarded frame.
      this.guardChecks.push({
        label,
        page: recorder.name,
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

  /**
   * Stop every recorder and write the timelines and this session's lane file.
   * Never throws for a non-static hold: the run's teardown judges the footage.
   */
  async close(): Promise<FootageSummary> {
    const recorders = [...this.recorders.values(), ...this.retired];
    await Promise.all(recorders.map((r) => r.stop()));
    this.recorders.clear();
    await this.cardBrowser?.close().catch(() => undefined);
    this.cardBrowser = null;
    this.phraseWords.fill('');
    this.phraseWords = [];
    this.exactSecrets.clear();
    const nonStatic = this.holds.filter((h) => !h.static).length;
    if (!this.dir) return { dir: null, holds: 0, nonStaticHolds: 0 };
    for (const recorder of recorders) recorder.writeTimeline();
    this.writeLane(recorders);
    return { dir: this.dir, holds: this.holds.length, nonStaticHolds: nonStatic };
  }

  private writeLane(recorders: PageRecorder[] = [...this.recorders.values(), ...this.retired]): void {
    if (!this.dir) return;
    this.laneWrittenAt = Date.now();
    writeFileSync(
      join(this.dir, 'lane.json'),
      JSON.stringify(
        {
          area: 'C-tips',
          invocation: invocationId(),
          session: this.session,
          startedAt: this.startedAt,
          endedAt: Date.now(),
          policy: this.policy,
          pages: recorders.map((r) => r.name),
          chapters: this.chapters,
          holds: this.holds,
          guardChecks: this.guardChecks,
          nonStaticHolds: this.holds.filter((h) => !h.static).length,
        },
        null,
        1,
      ),
      { mode: 0o600 },
    );
  }

  /** Rewrite the lane file now and then, so a killed worker leaves its holds behind. */
  private maybeFlushLane(): void {
    if (Date.now() - this.laneWrittenAt > FLUSH_INTERVAL_MS) this.writeLane();
  }
}
