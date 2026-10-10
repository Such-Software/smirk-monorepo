/**
 * Area H balance reference: the Chromium lane reads alice's Home balances as
 * the LAST thing it does and writes them here; the macOS desktop smoke reads
 * the file right after it reads its own Home and compares.
 *
 * Other areas move alice's funds between runs, and every Chromium run
 * rewrites the file, so an unbounded exact comparison passes or fails on
 * scheduling. The comparison is deterministic instead: it runs only when the
 * two reads are comparable (the reference was read at most maxAgeMs before the
 * desktop read, never after it, and no funds were moving on either side), and
 * otherwise fails with the reason it cannot compare. The result never depends
 * on how much the balances happened to move.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ASSETS } from './H-cross-browser-desktop-policy.mjs';

/** Run the chromium lane right before the desktop smoke: its final read must be this fresh. */
export const REFERENCE_MAX_AGE_MS = 30 * 60_000;

/** A Home row line that shows funds in motion: "+0.1 XMR pending", "0.1 XMR sending", "locked". */
export const MOVING_TEXT = /\b(pending|sending|locked)\b/i;

export function amount(text) {
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(String(text ?? ''));
  return match ? Number(match[1].replace(/,/g, '')) : Number.NaN;
}

/** Atomic owner-only write: a reader never sees half a file. */
export function writeReference(path, reference) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(reference, null, 1), { mode: 0o600 });
  renameSync(temporary, path);
}

export function readReference(path) {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * @param {any} reference what writeReference stored: { readAt, balances, moving }
 * @param {{ balances: Record<string, string>, moving?: string[], readAt: number }} desktop
 * @returns {{ ok: boolean, reason: string | null, ageMs: number | null, differ: string[] }}
 */
export function compareWithReference(reference, { balances, moving = [], readAt }, { maxAgeMs = REFERENCE_MAX_AGE_MS } = {}) {
  const refused = (reason, ageMs = null) => ({ ok: false, reason, ageMs, differ: [] });
  const referenceAt = Date.parse(reference?.readAt ?? '');
  if (!reference?.balances || !Number.isFinite(referenceAt)) return refused('no usable Chromium balance reference; run the chromium lane of h-firefox.live.mjs first');
  const ageMs = readAt - referenceAt;
  if (ageMs < 0) return refused('the Chromium reference was read after the desktop read (a concurrent run); rerun one after the other', ageMs);
  if (ageMs > maxAgeMs) {
    return refused(`the Chromium reference is ${Math.round(ageMs / 60_000)} min old, past the ${Math.round(maxAgeMs / 60_000)} min limit; run the chromium lane right before the desktop smoke`, ageMs);
  }
  const referenceMoving = Array.isArray(reference.moving) ? reference.moving : ['unknown'];
  if (referenceMoving.length) return refused(`funds were moving when Chromium read its reference (${referenceMoving.join(', ')}); rerun when they settle`, ageMs);
  if (moving.length) return refused(`funds are moving on the desktop Home (${moving.join(', ')}); rerun when they settle`, ageMs);
  const differ = ASSETS.filter((asset) => amount(reference.balances[asset]) !== amount(balances[asset]));
  if (differ.length) {
    return { ok: false, reason: `desktop and Chromium differ on ${differ.map((asset) => `${asset} (${balances[asset]} vs ${reference.balances[asset]})`).join(', ')}`, ageMs, differ };
  }
  return { ok: true, reason: null, ageMs, differ: [] };
}
