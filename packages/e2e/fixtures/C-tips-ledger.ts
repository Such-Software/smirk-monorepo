/**
 * C-tips ledger: every tip this run created, on disk, so funds are never
 * stranded by a failure.
 *
 * A failed test restarts the Playwright worker, which drops all module state
 * and the worker-scoped lane. The ledger survives that: it names each tip (id,
 * coin, amount, sender, recipient, dates) and the forged wraps published, so a
 * later test, a new worker, or a rescue run can find every tip that still holds
 * funds and settle it. It never holds a claim link, a key or a password: a
 * link tip's link is re-read from the sender's Sent tips, and its key backup
 * lives in the sender's browser profile, which the lane keeps while any tip is
 * unsettled (C-tips-live.ts).
 *
 * Settled means `claimed` or `clawed_back` on the backend's public record.
 * Every other status (pending, pending_confirmation, claiming, funding_mismatch,
 * cancelled) may still hold funds at the tip address.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TipAsset } from './C-tips-actions.js';

export type LedgerWalletName = 'alice' | 'bob' | 'carol' | 'bob-fed';

export interface LedgerTip {
  /** `link:<plan>` or `npub:<plan>`, unique within the run. */
  key: string;
  tipId: string;
  asset: TipAsset;
  amount: string;
  sender: LedgerWalletName;
  recipient?: LedgerWalletName;
  /** What the composer showed as the recipient (npub short form, @name or name@domain). */
  recipientDisplay?: string;
  memo?: string;
  expiryDays: 1 | 7 | 30;
  submittedAtMs: number;
  invocation: string;
  /**
   * Why the relay refused a person tip's private delivery, as the wallet said
   * it (never a key or a link). The tip is funded either way; its recipient
   * claims it through the fallback link instead of the Inbox.
   */
  deliveryRefused?: string;
}

export interface LedgerForgery {
  kind: 'reused-tip-id' | 'unknown-tip-id';
  tipId: string;
  burnerPubkeyHex: string;
  memo: string;
  eventId: string;
  publishedAtMs: number;
}

interface LedgerFile {
  version: 1;
  run: string;
  invocations: string[];
  tips: LedgerTip[];
  forged: LedgerForgery[];
}

export const SETTLED_STATUSES: ReadonlySet<string> = new Set(['claimed', 'clawed_back']);

export class TipLedger {
  private data: LedgerFile;
  private readonly file: string;

  constructor(
    stateDir: string,
    run: string,
    private readonly invocation: string,
  ) {
    this.file = join(stateDir, 'ledger.json');
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile)
      : { version: 1, run, invocations: [], tips: [], forged: [] };
    if (!this.data.invocations.includes(invocation)) {
      this.data.invocations.push(invocation);
      this.save();
    }
  }

  /** Re-read the file: another worker of this invocation may have written it. */
  reload(): void {
    if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Record a tip the moment its id is known; a second record of the same id is a no-op. */
  record(tip: Omit<LedgerTip, 'invocation'>): void {
    this.reload();
    const existing = this.data.tips.find((t) => t.tipId === tip.tipId);
    if (existing) return;
    if (this.data.tips.some((t) => t.key === tip.key)) {
      throw new Error(`the ledger already holds a tip for ${tip.key}; a run never pays for one plan twice`);
    }
    this.data.tips.push({ ...tip, invocation: this.invocation });
    this.save();
  }

  /** Note that a recorded person tip was funded but its delivery was refused. */
  markDeliveryRefused(tipId: string, reason: string): void {
    this.reload();
    const tip = this.data.tips.find((t) => t.tipId === tipId);
    if (!tip || tip.deliveryRefused) return;
    tip.deliveryRefused = reason;
    this.save();
  }

  tip(key: string): LedgerTip | undefined {
    this.reload();
    return this.data.tips.find((t) => t.key === key);
  }

  tips(prefix = ''): LedgerTip[] {
    this.reload();
    return this.data.tips.filter((t) => t.key.startsWith(prefix));
  }

  /** Tips created by an earlier invocation of this run (a rescue run settles them). */
  inheritedTips(): LedgerTip[] {
    this.reload();
    return this.data.tips.filter((t) => t.invocation !== this.invocation);
  }

  recordForgeries(forged: LedgerForgery[]): void {
    this.reload();
    this.data.forged = this.data.forged.concat(forged);
    this.save();
  }

  forgeries(): LedgerForgery[] {
    this.reload();
    return [...this.data.forged];
  }
}
