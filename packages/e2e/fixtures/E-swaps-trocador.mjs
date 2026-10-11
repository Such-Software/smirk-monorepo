/**
 * Guards for the E-swaps lane's real Trocador swap (LTC to XMR, alice to
 * alice). Pure, so scripts and the offline suite can test them without a
 * browser (E-swaps-trocador.test.mjs).
 *
 *   V031_TROCADOR_SWAP=yes        the owner's decision; anything else refuses.
 *   E_SWAPS_TROCADOR_LTC_LADDER   LTC amounts to try, smallest first
 *                                 (default 0.1,0.15,0.2,0.25,0.3). The lane
 *                                 sends the smallest one Trocador quotes.
 *   E_SWAPS_TROCADOR_LTC_CAP      never deposit more (default 0.3 LTC). It
 *                                 cannot be raised above TROCADOR_LTC_HARD_MAX.
 *
 * The evidence record keeps only public facts of the swap, each checked for
 * its shape; a status link, webhook token or anything else is dropped.
 */

export const TROCADOR_SWAP_DECISION = 'V031_TROCADOR_SWAP';
export const TROCADOR_LTC_LADDER_DEFAULT = '0.1,0.15,0.2,0.25,0.3';
export const TROCADOR_LTC_CAP_DEFAULT = '0.3';
/** No environment can lift the cap above this. */
export const TROCADOR_LTC_HARD_MAX = '0.5';

const LTC_DECIMALS = 8;

/** LTC decimal text to litoshi. Refuses anything that is not a plain positive amount. */
export function ltcAtomic(decimal) {
  const clean = String(decimal ?? '').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(clean)) throw new Error('an LTC amount is digits with at most 8 decimals');
  const [whole, frac = ''] = clean.split('.');
  return BigInt(whole) * 10n ** BigInt(LTC_DECIMALS) + BigInt((frac + '0'.repeat(LTC_DECIMALS)).slice(0, LTC_DECIMALS));
}

/** Why the real Trocador swap must not run, or null when the owner said yes. */
export function trocadorSwapRefusal(env) {
  const value = String(env?.[TROCADOR_SWAP_DECISION] ?? '').trim().toLowerCase();
  if (value === 'yes') return null;
  if (value === 'no') return `${TROCADOR_SWAP_DECISION}=no: the owner declined the real Trocador swap`;
  return `${TROCADOR_SWAP_DECISION} is ${value ? 'not yes or no' : 'unset'}: the real Trocador swap runs only on the owner's explicit yes`;
}

/**
 * The amounts to try and the cap, from the environment. Throws, naming the
 * setting at fault, when a step is malformed, out of order, above the cap, or
 * the cap is above the hard maximum.
 */
export function trocadorPlan(env) {
  const capText = String(env?.E_SWAPS_TROCADOR_LTC_CAP ?? TROCADOR_LTC_CAP_DEFAULT).trim();
  let capAtomic;
  try {
    capAtomic = ltcAtomic(capText);
  } catch {
    throw new Error('E_SWAPS_TROCADOR_LTC_CAP is not an LTC amount');
  }
  if (capAtomic <= 0n) throw new Error('E_SWAPS_TROCADOR_LTC_CAP must be above zero');
  if (capAtomic > ltcAtomic(TROCADOR_LTC_HARD_MAX)) {
    throw new Error(`E_SWAPS_TROCADOR_LTC_CAP is above the hard maximum of ${TROCADOR_LTC_HARD_MAX} LTC for the real Trocador swap`);
  }
  const steps = String(env?.E_SWAPS_TROCADOR_LTC_LADDER ?? TROCADOR_LTC_LADDER_DEFAULT)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length === 0) throw new Error('E_SWAPS_TROCADOR_LTC_LADDER names no amount');
  const ladder = steps.map((text, i) => {
    let atomic;
    try {
      atomic = ltcAtomic(text);
    } catch {
      throw new Error(`E_SWAPS_TROCADOR_LTC_LADDER step ${i + 1} is not an LTC amount`);
    }
    if (atomic <= 0n) throw new Error(`E_SWAPS_TROCADOR_LTC_LADDER step ${i + 1} must be above zero`);
    if (atomic > capAtomic) throw new Error(`E_SWAPS_TROCADOR_LTC_LADDER step ${i + 1} is above the cap E_SWAPS_TROCADOR_LTC_CAP`);
    return { text, atomic };
  });
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].atomic <= ladder[i - 1].atomic) throw new Error('E_SWAPS_TROCADOR_LTC_LADDER must rise strictly, smallest first');
  }
  return { ladder, capAtomic };
}

/** Why a deposit of `amountAtomic` litoshi must not be sent, or null. Checked again on the deposit step. */
export function trocadorAmountRefusal(amountAtomic, capAtomic) {
  if (typeof amountAtomic !== 'bigint' || typeof capAtomic !== 'bigint') return 'the Trocador deposit amount could not be read';
  if (amountAtomic <= 0n) return 'the Trocador deposit amount is not positive';
  if (capAtomic > ltcAtomic(TROCADOR_LTC_HARD_MAX)) return `the cap is above the hard maximum of ${TROCADOR_LTC_HARD_MAX} LTC`;
  if (amountAtomic > capAtomic) return 'the Trocador deposit is above the cap (E_SWAPS_TROCADOR_LTC_CAP); nothing was sent';
  return null;
}

/** Trocador trade ids are short alphanumeric strings (never a URL or a THORChain id). */
export const TROCADOR_TRADE_ID = /^[A-Za-z0-9]{6,64}$/;

const SHAPES = Object.freeze({
  tradeId: (v) => typeof v === 'string' && TROCADOR_TRADE_ID.test(v),
  exchange: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(v),
  depositLtc: (v) => typeof v === 'string' && /^\d+(\.\d{1,8})?$/.test(v),
  depositTxid: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v),
  finalStatus: (v) => typeof v === 'string' && /^(awaiting_deposit|confirming|exchanging|completed|refunded|failed|unknown)$/.test(v),
  completedXmrAtomic: (v) => typeof v === 'string' && /^\d{1,24}$/.test(v),
  xmrRiseAtomic: (v) => typeof v === 'string' && /^-?\d{1,24}$/.test(v),
});

/**
 * The public facts of the swap, for the run's evidence. Unknown keys are
 * dropped; a known key whose value has the wrong shape is replaced by a
 * marker and never written.
 */
export function trocadorEvidence(fields) {
  const out = {};
  for (const [key, ok] of Object.entries(SHAPES)) {
    if (!(key in (fields ?? {}))) continue;
    out[key] = ok(fields[key]) ? fields[key] : 'withheld: unexpected shape';
  }
  return out;
}
