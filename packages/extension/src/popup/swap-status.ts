/**
 * Status of the in-flight Trocador swap, and which backend may be asked.
 *
 * The in-flight swap lives in the wallet's wizard store, which does not change
 * with the backend. Its status poll asked whatever backend the window pointed
 * at, with that backend's session token: after a switch, a trade recorded at
 * one operator was looked up at another, telling it the trade id (and, through
 * it, the deposit and amounts), while the operator that holds the record was no
 * longer consulted. The trade now remembers the backend that recorded it
 * (`SWAP_TRACKED_AT` in the wizard fields), and only that backend is asked.
 * Elsewhere, and for a trade recorded before this was kept, the status comes
 * from Trocador directly, which is the source of truth for state anyway.
 */
import type { SmirkApi } from '@smirk/core';
import type { SwapInFlight } from '@smirk/ui';

/** Wizard field naming the backend that recorded the in-flight trade. */
export const SWAP_TRACKED_AT = 'trackedAt';

export interface SwapStatusDeps {
  api: Pick<SmirkApi, 'getBaseUrl' | 'getSwap'>;
  trocador: { status(id: string): Promise<SwapInFlight['state']> };
}

/**
 * The current status of trade `id`. `trackedAt` is the backend that recorded
 * it, when known.
 */
export async function fetchTrocadorSwapStatus(
  deps: SwapStatusDeps,
  id: string,
  trackedAt: string | undefined,
): Promise<SwapInFlight> {
  // Hybrid: backend for identities (from/to/amount/address),
  // Trocador direct for state. v0.3.0 originally trusted the
  // backend's `status` column unconditionally, but the only
  // signal that flips it is Trocador's webhook into
  // `/api/v1/webhook/trocador`, and there's no backend poller
  // to backstop a missed delivery. Real failure mode dogfooded
  // 2026-06-04: LTC→XMR swap completed on Trocador's side, no
  // webhook landed, backend stayed at `status='new'`, wallet
  // showed "Waiting for your deposit" forever.
  //
  // Fix: when backend has a record but its status is
  // non-terminal, ALSO query Trocador direct and prefer the
  // direct state. Terminal backend statuses (finished /
  // refunded / expired / error) are trusted as-is because the
  // backend mirror won't regress past those. If both calls
  // fail, fall through to whichever returned data.
  // A trade recorded at another backend is not looked up here: asking this
  // backend would tell its operator about a trade made while on another one,
  // with this backend's session, and that record is not here anyway.
  const backend =
    trackedAt !== undefined && trackedAt === deps.api.getBaseUrl()
      ? await deps.api.getSwap(id).catch(() => null)
      : null;
  if (backend && backend.data) {
    const r = backend.data;
    const backendTerminal =
      r.status === 'finished' ||
      r.status === 'refunded' ||
      r.status === 'expired' ||
      r.status === 'error';
    // Take the backend's identities + last-known state as the
    // baseline. `mapBackendStatus` uses these to render real
    // copy on terminal states (final to-amount on `finished`,
    // refund-address hint on `refunded`/`expired`).
    let state = mapBackendStatus(r.status, {
      ...(r.amount_to_atomic ? { amountToAtomic: r.amount_to_atomic } : {}),
      ...(r.refund_address ? { refundAddress: r.refund_address } : {}),
    });
    if (!backendTerminal) {
      // Augment with Trocador direct. Best-effort: a Trocador
      // outage shouldn't tank the polling loop; keep the
      // backend's state as a fallback.
      try {
        const live = await deps.trocador.status(id);
        state = live;
      } catch (e) {
        console.warn(
          '[swap] Trocador direct status fallback failed; using backend state',
          e,
        );
      }
    }
    return {
      id,
      fromAsset: r.from_asset,
      toAsset: r.to_asset,
      fromAmountAtomic: r.amount_from_atomic,
      toAmountEstimateAtomic: r.amount_to_atomic ?? '0',
      depositAddress: r.deposit_address,
      state,
    };
  }
  // Backend doesn't know about this swap; go direct.
  const s = await deps.trocador.status(id);
  return {
    id,
    // Identity fields aren't available from Trocador's /trade
    // response in a stable shape; the wizard merges via
    // onUpdate which preserves the persisted fields and only
    // overwrites `state` with the values we return.
    fromAsset: '',
    toAsset: '',
    fromAmountAtomic: '0',
    toAmountEstimateAtomic: '0',
    depositAddress: '',
    state: s,
  };
}

/** Translate the backend's status string (a verbatim mirror of
 *  Trocador's lifecycle) into the SwapInFlight discriminated union
 *  the UI renders. Kept here so the popup is the only place that
 *  knows the Trocador-string ↔ structured-state mapping.
 *
 *  `extra` carries the parts of the persisted SwapRecord that the
 *  status alone can't supply: the final to-amount (Trocador stores
 *  this on the row at terminal-transition; pre-2026-06-13 the
 *  mapper hardcoded '0' so every completed swap reported 0 LTC
 *  sent), and the refund address (needed so the
 *  'expired' state can tell the user where their deposit will return
 *  to if they did broadcast). Both are optional (the caller may
 *  not have them yet) and the mapper falls back to neutral copy
 *  when they're absent. */
export function mapBackendStatus(
  status: string,
  extra?: { amountToAtomic?: string; refundAddress?: string },
): SwapInFlight['state'] {
  switch (status) {
    case 'new':
    case 'waiting':
      return { state: 'pending', reason: 'awaiting_deposit' };
    case 'confirming':
      return { state: 'pending', reason: 'awaiting_confirmations' };
    case 'exchanging':
    case 'sending':
      return { state: 'pending', reason: 'in_progress' };
    case 'finished':
      return {
        state: 'completed',
        outboundTxId: '',
        toAmount: extra?.amountToAtomic ?? '0',
      };
    case 'refunded': {
      // Surface the refund destination when we have it: gives the
      // user a chain address to watch instead of "trust us, it's on
      // its way back."
      const reason = extra?.refundAddress
        ? `Refunded by provider to ${extra.refundAddress}`
        : 'Refunded by provider';
      return { state: 'refunded', refundTxId: '', reason };
    }
    case 'expired': {
      // Trocador's `expired` covers TWO real-world cases: (a) the
      // quote validity window elapsed before any deposit arrived
      // (no money moved), and (b) deposit landed but the underlying
      // provider couldn't complete in time, refund in flight. We
      // don't have a reliable backend signal to discriminate (we'd
      // need historical state transitions or amount-observed
      // logging), so the copy here informs both cases honestly
      // rather than asserting "Quote expired before deposit" which
      // is actively wrong half the time. Refund address is surfaced
      // when we know it, so case (b) users can watch the right
      // chain.
      const refundHint = extra?.refundAddress
        ? ` If you deposited, funds will be returned to ${extra.refundAddress}.`
        : ' If you deposited, funds will be returned to your refund address.';
      return {
        state: 'failed',
        reason: `Quote expired or provider could not complete in time.${refundHint}`,
      };
    }
    case 'error':
      return { state: 'failed', reason: 'Provider reported error' };
    default:
      // Unknown status from the backend mirror. Surface it as a
      // failure with the raw value so the user (and Smirk support)
      // can act on it, rather than silently parking on
      // "in_progress" which the wizard renders as "Provider
      // exchanging" forever: that's how the 2026-06-04 audit
      // found a future-Trocador-status would manifest as a stuck
      // visual on a swap that actually completed.
      return {
        state: 'failed',
        reason: `Unknown provider status: ${status || '(empty)'}`,
      };
  }
}
