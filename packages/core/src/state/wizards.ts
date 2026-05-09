/**
 * Multi-step wizard scaffold.
 *
 * Every multi-step UI flow (Tip Maker, Send, Onboarding, Native swap
 * negotiation) shares the same state machinery: a step counter,
 * accumulated form fields, a start timestamp. Different wizards
 * differ only in (a) their field shape and (b) the per-step render
 * logic. The state lives in the popup-state store, so closing
 * mid-wizard and reopening picks up exactly where we left off.
 *
 * Bitwarden-style "pop-out the popup mid-form and keep going" is
 * automatic: the pop-out window reads the same store, sees the same
 * wizard state.
 *
 * Generic over the field shape — callers parameterize by their own
 * typed fields. Steps are numeric (0..N-1); naming the steps is the
 * UI layer's job.
 */

import type { PopupStateStore, WizardState } from './popup-state';

/**
 * Typed wizard handle. Construct one per logical wizard (e.g. one
 * for `tip-maker`, one for `send`). Multiple users of the same
 * wizard id share state — useful for pop-out scenarios where two
 * windows view the same wizard, mutating-where-mutated.
 */
export class Wizard<TFields extends Record<string, unknown>> {
  constructor(
    private readonly store: PopupStateStore,
    /** Unique id, e.g. `"tip-maker"`. Must not collide with other wizards. */
    private readonly id: string,
    /** Default field values used when the wizard is first started. */
    private readonly defaults: TFields,
  ) {}

  // ---- Lifecycle ----

  /** True iff this wizard has an active in-progress state. */
  async isActive(): Promise<boolean> {
    const s = await this.store.load();
    return Object.prototype.hasOwnProperty.call(s.wizards, this.id);
  }

  /**
   * Start (or restart) the wizard. Discards any prior state for this
   * id. Returns the freshly-initialized state.
   */
  async start(): Promise<WizardState> {
    const next = await this.store.update((s) => {
      s.wizards[this.id] = {
        step: 0,
        fields: { ...(this.defaults as Record<string, unknown>) },
        startedAt: Date.now(),
      };
    });
    return next.wizards[this.id]!;
  }

  /** Cancel the wizard, removing its state. Idempotent. */
  async cancel(): Promise<void> {
    await this.store.update((s) => {
      delete s.wizards[this.id];
    });
  }

  // ---- Read ----

  /**
   * Snapshot of the current state, or `null` if the wizard isn't
   * active. The fields shape is unverified at runtime — callers
   * should be careful about reading state across schema changes
   * (consider versioning fields for long-running wizards).
   */
  async snapshot(): Promise<{ step: number; fields: TFields; startedAt: number } | null> {
    const s = await this.store.load();
    const w = s.wizards[this.id];
    if (!w) return null;
    return {
      step: w.step,
      fields: w.fields as TFields,
      startedAt: w.startedAt,
    };
  }

  // ---- Step navigation ----

  async next(): Promise<number> {
    const next = await this.store.update((s) => {
      const w = s.wizards[this.id];
      if (w) w.step += 1;
    });
    return next.wizards[this.id]?.step ?? 0;
  }

  async back(): Promise<number> {
    const next = await this.store.update((s) => {
      const w = s.wizards[this.id];
      if (w && w.step > 0) w.step -= 1;
    });
    return next.wizards[this.id]?.step ?? 0;
  }

  async goToStep(step: number): Promise<void> {
    if (step < 0) throw new Error(`wizard step must be >= 0, got ${step}`);
    await this.store.update((s) => {
      const w = s.wizards[this.id];
      if (w) w.step = step;
    });
  }

  // ---- Field updates ----

  async setField<K extends keyof TFields>(name: K, value: TFields[K]): Promise<void> {
    await this.store.update((s) => {
      const w = s.wizards[this.id];
      if (w) w.fields[name as string] = value as unknown;
    });
  }

  async patchFields(patch: Partial<TFields>): Promise<void> {
    await this.store.update((s) => {
      const w = s.wizards[this.id];
      if (!w) return;
      w.fields = { ...w.fields, ...(patch as Record<string, unknown>) };
    });
  }

  /** Read a single field; `undefined` if the wizard isn't active. */
  async getField<K extends keyof TFields>(name: K): Promise<TFields[K] | undefined> {
    const snap = await this.snapshot();
    return snap ? snap.fields[name] : undefined;
  }
}
