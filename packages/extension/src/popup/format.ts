/**
 * Pure formatting + parsing helpers for the popup: number/amount/time/string
 * conversions with no React and no module state. Extracted verbatim from index.tsx
 * so they can be unit-tested and reused without dragging the 7k-line entry point in.
 */

import { mustGetAsset } from '@smirk/assets';

/** Format a USD number as `$1,234.56`, or an em dash for non-finite input. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Parse a decimal string into atomic units using the asset's registered
 * decimals. Pure BigInt math: no floating point. Returns null on any malformed
 * input (empty, non-numeric, too many fractional digits, or absurdly long).
 */
export function parseAmount(assetId: string, text: string): bigint | null {
  const asset = mustGetAsset(assetId);
  const decimals = asset.decimals;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Cap input length to prevent multi-megabyte BigInt construction from
  // a pasted-junk amount field (UI hang, not a security bug). 32 chars
  // covers any sane amount: 21M satoshis is 16 chars, full-precision XMR
  // (12 decimals) tops out around 26.
  if (trimmed.length > 32) return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) return null;
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  if (intPart === '' && fracPart === '') return null;
  if (fracPart.length > decimals) return null;
  const padded = fracPart.padEnd(decimals, '0');
  try {
    const intBig = BigInt(intPart || '0');
    const fracBig = padded === '' ? 0n : BigInt(padded);
    const result = intBig * 10n ** BigInt(decimals) + fracBig;
    if (result < 0n) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Normalize a dapp payment-approval request's amount to atomic units. Dapps quote a
 * HUMAN decimal amount (e.g. "9" WOW); website operators should not have to compute
 * per-asset atomic units (8-12 decimals across chains), which is a foot-gun. The
 * wallet owns each asset's decimals and converts here, ONCE, so the confirmation
 * display and the executed transaction agree and `BigInt()` downstream never sees a
 * decimal. Non-payment requests pass through unchanged; a malformed amount returns an
 * `amountError` so the caller blocks the approval instead of crashing.
 */
export function normalizePaymentAmount<T>(request: T): { request: T; amountError?: string } {
  const r = request as { kind?: string; asset?: string; amount?: string };
  if (r.kind !== 'requestPayment' || typeof r.asset !== 'string' || typeof r.amount !== 'string') {
    return { request };
  }
  const atomic = parseAmount(r.asset, r.amount);
  // Reject zero as well as malformed/negative: a 0-value "payment" is not a real
  // request and would drive a confusing fee-only "Send 0" approval.
  if (atomic === null || atomic <= 0n) {
    return { request, amountError: `This site requested an invalid amount ("${r.amount}").` };
  }
  return { request: { ...(request as object), amount: atomic.toString() } as T };
}

/** Inverse of {@link parseAmount}: atomic-unit string → trimmed decimal text. */
export function atomicToText(atomic: string, assetId: string): string {
  const asset = mustGetAsset(assetId);
  const decimals = asset.decimals;
  const n = BigInt(atomic);
  if (decimals === 0) return n.toString();
  const padded = n.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/** Compact relative age (`45s`, `12m`, `3h`, `2d`) from a unix-seconds timestamp. */
export function feedTimeAgo(createdAtSec: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - createdAtSec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Lowercase hex encoding of a byte array. */
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** Decode a hex string to bytes (inverse of {@link bytesToHex}). */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A random base64url token of `byteLen` bytes, URL-safe (survives a passthrough
 *  round-trip without percent-encoding surprises). */
export function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
