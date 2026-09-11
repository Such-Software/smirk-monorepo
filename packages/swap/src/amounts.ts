/**
 * Amount and error helpers shared by the swap providers.
 *
 * Moved here verbatim from trocador.ts when a second provider needed them,
 * so the two cannot drift into converting the same amount two ways.
 */

import type { AtomicAmount, SwapError } from './types';

export function atomicToDecimal(atomic: AtomicAmount, decimals: number): string {
  // AtomicAmount is a decimal string in atomic units. Insert the
  // decimal point at the right place; trim trailing zeros so Trocador
  // doesn't reject as malformed.
  const n = BigInt(atomic);
  if (decimals === 0) return n.toString();
  const padded = n.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

export function decimalToAtomic(decimal: string, decimals: number): AtomicAmount {
  return decimalToAtomicString(decimal, decimals);
}

export function decimalToAtomicString(decimal: string, decimals: number): string {
  const [whole, fracRaw = ''] = decimal.split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const combined = (whole ?? '0') + frac;
  // Strip leading zeros, but keep at least one digit.
  const trimmed = combined.replace(/^0+/, '') || '0';
  return trimmed;
}

export function asSwapError(code: SwapError['code'], message: string): SwapError {
  const err = new Error(message) as SwapError;
  err.code = code;
  return err;
}
