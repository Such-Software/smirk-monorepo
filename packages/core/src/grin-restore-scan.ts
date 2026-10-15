/**
 * The one priced Grin scan. Every `POST /wallet/grin/scan` the wallet sends goes
 * through {@link pricedGrinScan}, the balance read and every spend-side caller
 * alike, so the two cannot drift apart again.
 *
 * They did drift once. The balance read learned to pay the restore
 * proof-of-work on 2026-08-24, while the spend resolver kept sending a bare
 * `grin.scan({ rewindHash })`. With no `start_height` the backend assumes its
 * deepest permitted scan, which production prices at 9 bits, so every Grin
 * send, tip and tip claim was refused with "this restore depth requires a 9-bit
 * proof-of-work nonce; upgrade to a newer Smirk client" while the balance above
 * the button read fine. That shipped in v0.3.0 and was caught by the v0.3.1
 * live run (rc-11599).
 */

import type { ApiResponse } from './api/client';
import type { GrinScanResult } from './chain/types';
import { loadCapabilities, type CapabilitiesApi } from './api/capabilities-cache';
import type { GrinChainProvider } from './chain/provider';
import { requiredRestorePowBits, solveRestorePow, type RestorePowPolicy } from './pow';

/** Grin targets 60s blocks; mirrors the backend's `blocks_per_day`. */
const GRIN_BLOCKS_PER_DAY = 1440;

/** What a priced scan sends: the wire params of `POST /wallet/grin/scan`. */
export interface GrinScanParams {
  rewindHash: string;
  startHeight?: number | undefined;
  restorePowNonce?: number | undefined;
}

/**
 * Scan params for this wallet at this tip under this restore policy.
 *
 * On an operator that prices restores (`pow_days_per_bit > 0`) we ask for the
 * deepest scan it allows and pay the advertised price. Asking for a shallower
 * window instead would silently drop older outputs and report a confidently
 * wrong balance, or hide spendable inputs. Nine bits is roughly 512 hashes,
 * about 8ms, run as awaited `crypto.subtle` digests like every other restore
 * proof-of-work in the wallet.
 *
 * An unpriced or absent policy leaves the depth to the backend, which is free.
 * Returns `null` when the policy prices restores but the tip is unknown: the
 * price is a function of depth, and an unpriced scan would only be refused.
 */
export async function grinScanParams(
  rewindHash: string,
  tip: number,
  restorePolicy: RestorePowPolicy | null | undefined,
): Promise<GrinScanParams | null> {
  if (!restorePolicy?.pow_days_per_bit) return { rewindHash };
  if (!(tip > 0)) return null;
  // `null` means unbounded; fall back to a year, which is what the backend
  // caps a bounded policy at anyway.
  const maxDepthDays = restorePolicy.max_depth_days ?? 365;
  const startHeight = Math.max(0, tip - maxDepthDays * GRIN_BLOCKS_PER_DAY);
  const bits = requiredRestorePowBits('grin', startHeight, tip, restorePolicy);
  const restorePowNonce = await solveRestorePow('grin', rewindHash, startHeight, bits);
  return { rewindHash, startHeight, ...(restorePowNonce !== undefined ? { restorePowNonce } : {}) };
}

/** A priced scan's result together with the tip that priced it. */
export interface PricedGrinScan {
  scan: ApiResponse<GrinScanResult>;
  height: Awaited<ReturnType<GrinChainProvider['getHeight']>>;
}

/**
 * Read the tip, price the scan against it, then scan.
 *
 * Tip first, because the restore price is a function of depth. The same tip is
 * handed back so maturity is judged against the height the scan was priced at.
 * A priced policy with no readable tip yields a scan error without sending the
 * scan, never a bare request the backend would refuse with a misleading
 * "upgrade to a newer Smirk client".
 */
export async function pricedGrinScan(
  grin: Pick<GrinChainProvider, 'scan' | 'getHeight'>,
  rewindHash: string,
  restorePolicy: RestorePowPolicy | null | undefined,
): Promise<PricedGrinScan> {
  const height = await grin.getHeight();
  const tip = height.data?.height ?? 0;
  const params = await grinScanParams(rewindHash, tip, restorePolicy);
  if (!params) {
    return {
      height,
      scan: {
        error: `could not read the Grin tip height to price the restore scan (${height.error ?? 'no height'})`,
        ...(height.status !== undefined ? { status: height.status } : {}),
      },
    };
  }
  return { height, scan: await grin.scan(params) };
}

/**
 * The backend's restore policy for a scan that must be priced correctly, or
 * `null` when it cannot be known.
 *
 * Awaits the cached `/capabilities` load rather than peeking: the popup loads
 * capabilities asynchronously, and a synchronous peek that saw `null` is what
 * once skipped the proof-of-work on the balance read. A cached `null` (a failed
 * or not yet answered fetch) gets one forced refetch before we give up, since a
 * transient failure is otherwise cached for the whole session.
 *
 * A backend that answers `/capabilities` without a `restore` block predates
 * restore pricing and prices nothing, so that maps to an empty policy, which
 * {@link grinScanParams} treats as free.
 */
export async function loadGrinRestorePolicy(api: CapabilitiesApi): Promise<RestorePowPolicy | null> {
  const caps = (await loadCapabilities(api)) ?? (await loadCapabilities(api, { force: true }));
  if (!caps) return null;
  return caps.restore ?? {};
}
