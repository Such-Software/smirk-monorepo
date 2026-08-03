import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  capHasTips,
  peekCapabilities,
  capAllowsPrices,
  chainProviders,
  btcLtcFreshAddrsEnabled,
  UtxoAddressBook,
  buildUtxoScanRefs,
  type UnlockedWallet,
} from '@smirk/core';
import { storage } from '../singletons';
import {
  AssetDetailScreen,
  useRoute,
  useSessionState,
  type AssetDetailTxRow,
  type InboxTipItem,
  type SparklinePoint,
} from '@smirk/ui';
import { rowTimestamp, explorerUrlForRow, explorerUrlForPendingOutgoing } from '../explorer';
import { clawbackSocialTip } from '../tip-claim-handler';
import { listTipKeyBackups, removeTipKeyBackup } from '../tip-key-backup';
import { isTipStale } from '../tip-inbox';
import { bytesToHex } from '../format';
import { readGrinJournal, type GrinTxJournalEntry } from '../grin-tx-journal';
import type { WalletSession } from '../types';

/**
 * Asset-detail route. Pulls per-chain history + sparkline, normalizes
 * into AssetDetailTxRow, hands off to the @smirk/ui presentational
 * component. Per-chain adapters live in `loadAssetHistory` below.
 */
export function AssetDetailRoute({
  assetId,
  wallet,
  session,
  onRefresh,
  onBack,
  onSend,
  onReceive,
  onTip,
  onTipClaim,
  resolveIcon,
}: {
  assetId: string;
  wallet: UnlockedWallet;
  session: WalletSession | null;
  /** Trigger a balance refresh. Called after sweeping (claim or
   *  clawback) so the user sees recovered funds without manual
   *  intervention. */
  onRefresh: () => Promise<void>;
  onBack: () => void;
  onSend: () => void;
  onReceive: () => void;
  onTip: () => void;
  /** Claim a received tip from this asset's history. Reuses the
   *  popup-shell-level tip-claim handler; the AssetDetailScreen
   *  renders the per-row Claim button when this is wired. */
  onTipClaim?: (
    tipId: string,
    assetId: InboxTipItem['assetId'],
  ) => Promise<{ ok: boolean; error?: string }>;
  resolveIcon: (key: string) => string | undefined;
}) {
  const sessionState = useSessionState();
  const { navigate } = useRoute();
  const [history, setHistory] = useState<AssetDetailTxRow[]>([]);
  const [sparkline, setSparkline] = useState<SparklinePoint | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // assetId arrives as a freeform string from the `home/asset/<id>`
  // route segment. The router only ever navigates here with a valid
  // SmirkAsset id (see `home/asset/${a.id}` in the asset list), but
  // TS can't prove that across the route boundary. Narrow at the
  // indexing site.
  const balance = session?.balances?.[assetId as keyof typeof session.balances];

  // In-flight outgoing rows: pulled live from session state so they
  // disappear cleanly when the entry ages out or reconciles, without
  // forcing a history refetch. Renders at the top of Activity (any
  // chain-side row of the same tx will show up at its real block
  // height; the pending row stays a separate "still mempool" entry
  // until the entry is reaped).
  const pendingRows: AssetDetailTxRow[] = useMemo(() => {
    const entries = sessionState.pendingOutgoing ?? [];
    return entries
      .filter((e) => e.asset === assetId)
      .map((e) => {
        const row: AssetDetailTxRow = {
          kind: 'pending-outgoing',
          txid: e.txHash,
          amountAtomic: BigInt(e.amount),
          feeAtomic: BigInt(e.fee),
          recipient: e.recipient,
          submittedAt: new Date(e.submittedAt).toISOString(),
          ...(e.context ? { context: e.context } : {}),
        };
        return row;
      });
  }, [sessionState.pendingOutgoing, assetId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setHistory([]);
    setSparkline(undefined);
    void (async () => {
      const [chainRows, tipRows, spark] = await Promise.all([
        loadAssetHistory(assetId, wallet, session?.bootstrap?.userId).catch(
          (e) => {
            console.warn('[asset-detail] history failed:', e);
            return [] as AssetDetailTxRow[];
          },
        ),
        // Opt-in: only load the tip history when the backend runs social tips.
        capHasTips(peekCapabilities())
          ? loadAssetTipRows(assetId).catch((e) => {
              console.warn('[asset-detail] tips failed:', e);
              return [] as AssetDetailTxRow[];
            })
          : Promise.resolve([] as AssetDetailTxRow[]),
        // Sparkline only for a priced asset: skip the request (and its 404) for an
        // asset the feed carries no quote for (e.g. WOW) or a no-prices backend.
        capAllowsPrices(peekCapabilities()) &&
        (session?.prices as Record<string, number | null> | null | undefined)?.[assetId] != null
          ? api.getSparkline(assetId).then(
              (r) =>
                r.data
                  ? ({
                      prices: r.data.prices,
                      min: r.data.min,
                      max: r.data.max,
                      changePct: r.data.change_pct,
                    } as SparklinePoint)
                  : undefined,
              () => undefined,
            )
          : Promise.resolve(undefined),
      ]);
      if (!alive) return;
      // Merge + sort newest-first. Tips and chain rows both carry an
      // ISO timestamp (Grin / cryptonote / utxo-with-timestamp /
      // tip-{sent,received}). Rows without a timestamp (UTXO with
      // height-only) sort last.
      const merged = [...chainRows, ...tipRows].sort((a, b) => {
        const ta = rowTimestamp(a);
        const tb = rowTimestamp(b);
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      });
      setHistory(merged);
      setSparkline(spark);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [assetId, wallet, session?.bootstrap?.userId, reloadKey]);

  return (
    <AssetDetailScreen
      assetId={assetId}
      balanceAtomic={balance?.confirmed ?? 0n}
      {...(balance?.pending !== undefined && balance.pending > 0n
        ? { pendingAtomic: balance.pending }
        : {})}
      {...(balance?.locked !== undefined && balance.locked > 0n
        ? { lockedAtomic: balance.locked }
        : {})}
      {...(sparkline ? { sparkline } : {})}
      // Prepend in-flight outgoing rows so the user sees their just-
      // broadcast tx immediately; Home's `↑ X sending` subline and
      // this Activity row come from the same `pendingOutgoing` source.
      history={[...pendingRows, ...history]}
      loading={loading}
      onBack={onBack}
      onSend={onSend}
      onReceive={onReceive}
      onTip={onTip}
      onOpenExplorer={(row) => {
        // Tip rows are tracked by tip_id, not chain-level; no
        // explorer URL applies. Skip silently for those.
        if (row.kind === 'tip-sent' || row.kind === 'tip-received') return;
        // Pending-outgoing rows route by context: swap-deposit jumps
        // straight to the Swap tab so the user lands on the Trocador
        // status page they were probably trying to find. tip-fund
        // falls through to the chain explorer (the broadcast tx
        // exists on-chain even though the tip-detail surface doesn't
        // exist as a route yet). Plain sends → chain explorer.
        if (row.kind === 'pending-outgoing') {
          if (row.context?.kind === 'swap-deposit') {
            void navigate('swap');
            return;
          }
          const url = explorerUrlForPendingOutgoing(assetId, row.txid);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        const url = explorerUrlForRow(assetId, row);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }}
      onTipClawback={async (tipId) => {
        // Full on-chain clawback: decrypt local backup → sweep tip
        // address back into the sender's wallet → mark backend.
        // Pre-2026-06-04 this was a backend-only status flip; the
        // funds were left orphaned at the tip address. See
        // tip-claim-handler.ts::clawbackSocialTip.
        const userId = session?.bootstrap?.userId;
        if (!userId) return { ok: false, error: 'Wallet not bootstrapped' };
        const outcome = await clawbackSocialTip(wallet, userId, tipId);
        if (!outcome.ok) return { ok: false, error: outcome.error };
        await removeTipKeyBackup(tipId);
        // Refresh balances so the user sees the swept funds.
        void onRefresh();
        return { ok: true };
      }}
      onTipDiscard={async (tipId) => {
        const r = await api.cancelSocialTip(tipId);
        if (r.error || !r.data) {
          return { ok: false, error: r.error ?? 'Discard failed' };
        }
        await removeTipKeyBackup(tipId);
        return { ok: true };
      }}
      {...(onTipClaim
        ? {
            onTipClaim: (tipId: string) =>
              onTipClaim(tipId, assetId as InboxTipItem['assetId']),
          }
        : {})}
      onTipActionDone={() => setReloadKey((k) => k + 1)}
      resolveIcon={resolveIcon}
    />
  );
}

/** Pull sent + received tips and normalize into AssetDetailTxRow
 *  variants filtered to the given asset. Layers in local IndexedDB
 *  tip-key backups so sent-tip rows surface a 🔐 badge + an
 *  always-available clawback affordance even if the backend doesn't
 *  know about the tip (DR scenario). */
async function loadAssetTipRows(assetId: string): Promise<AssetDetailTxRow[]> {
  const [sentResp, recvResp, backups] = await Promise.all([
    api.getSentSocialTips(),
    api.getReceivedSocialTips().catch(() => ({ data: undefined, error: undefined })),
    listTipKeyBackups().catch(() => []),
  ]);
  const backupIds = new Set(backups.map((b) => b.tipId));
  const out: AssetDetailTxRow[] = [];

  if (sentResp.data?.tips) {
    for (const t of sentResp.data.tips) {
      if (t.asset !== assetId) continue;
      const counterparty = t.is_public
        ? 'public link'
        : `@${t.recipient_username ?? '?'}`;
      const row: Extract<AssetDetailTxRow, { kind: 'tip-sent' }> = {
        kind: 'tip-sent',
        tipId: t.id,
        amountAtomic: BigInt(t.amount),
        ticker: assetId.toUpperCase(),
        counterparty,
        ...(t.recipient_platform ? { platform: t.recipient_platform } : {}),
        timestamp: t.created_at,
        status: t.status,
        fundingConfirmations: t.funding_confirmations,
        confirmationsRequired: t.confirmations_required,
        ...(backupIds.has(t.id) ? { hasLocalBackup: true } : {}),
      };
      out.push(row);
    }
  }

  // Orphan local backups: backend has no row, user can still
  // recover (Sent Tips screen surfaces these via the asset-detail
  // tip-sent variant tagged hasLocalBackup).
  if (sentResp.data?.tips) {
    const serverIds = new Set(sentResp.data.tips.map((t) => t.id));
    for (const b of backups) {
      if (b.asset !== assetId) continue;
      if (serverIds.has(b.tipId)) continue;
      out.push({
        kind: 'tip-sent',
        tipId: b.tipId,
        amountAtomic: BigInt(b.amount),
        ticker: assetId.toUpperCase(),
        counterparty: 'recipient',
        timestamp: new Date(b.createdAt).toISOString(),
        status: 'pending',
        hasLocalBackup: true,
      });
    }
  }

  if (recvResp.data?.tips) {
    for (const t of recvResp.data.tips) {
      if (t.asset !== assetId) continue;
      // Mirror the InboxTab stale filter: abandoned 0-conf tips
      // older than the cutoff don't belong in the per-asset history
      // either. Claimed / clawed-back / claiming tips are NOT
      // subject to this: `claiming` rows are retry-eligible (see
      // InboxTab fetcher comment) and need to stay visible so the
      // user can take the retry action; terminal states stay so the
      // user sees full history.
      if (
        (t.status === 'pending' || t.status === 'pending_confirmation') &&
        isTipStale(t.funding_confirmations ?? 0, t.created_at)
      ) {
        continue;
      }
      // For public tips the counterparty is the share-URL stranger,
      // not a known sender; leave the "public link" label.
      // For targeted tips: show the sender's @handle when they opted
      // in AND have one set; otherwise "anonymous". Matches
      // InboxTipItem.senderDisplay rendering so the InboxTab and
      // asset-detail history always agree.
      const counterparty = t.is_public
        ? 'public link'
        : !t.sender_anonymous && t.sender_username
          ? `@${t.sender_username}`
          : 'anonymous';
      const row: Extract<AssetDetailTxRow, { kind: 'tip-received' }> = {
        kind: 'tip-received',
        tipId: t.id,
        amountAtomic: BigInt(t.amount),
        ticker: assetId.toUpperCase(),
        counterparty,
        ...(t.recipient_platform ? { platform: t.recipient_platform } : {}),
        timestamp: t.created_at,
        // Surface status + confs so the row can render the
        // confirmation progress + the Claim button on ready tips.
        // Matches the InboxTab plumbing.
        status: t.status,
        fundingConfirmations: t.funding_confirmations ?? 0,
        confirmationsRequired: t.confirmations_required ?? 1,
      };
      out.push(row);
    }
  }

  return out;
}

/**
 * Per-chain adapter. Pulls from whichever history endpoint the asset's
 * family supports, normalizes to the AssetDetailTxRow shape the UI
 * component renders.
 */
async function loadAssetHistory(
  assetId: string,
  wallet: UnlockedWallet,
  userId: string | undefined,
): Promise<AssetDetailTxRow[]> {
  // Grin (the only consumer of userId) is now scan-based with no server history;
  // kept in the signature for call-site stability.
  void userId;
  if (assetId === 'btc' || assetId === 'ltc') {
    const addr = wallet.addresses[assetId];
    if (!addr) return [];
    // Fresh-address mode (ENABLE_BTCLTC_FRESH_ADDRS): aggregate history across
    // the whole address book via the multi endpoint. With the flag off (or no
    // account xpub) this falls through to the single primary-address read:
    // identical to before, and index 0 is always in the scan set regardless.
    const accountXpub = (
      wallet.keys as unknown as Record<string, { accountXpub?: string }>
    )[assetId]?.accountXpub;
    if (btcLtcFreshAddrsEnabled() && typeof accountXpub === 'string') {
      const book = new UtxoAddressBook(storage, wallet.fingerprint, assetId);
      const refs = await buildUtxoScanRefs(book, assetId, accountXpub);
      const rm = await chainProviders.utxo(assetId).getHistoryMulti(refs.map((x) => x.address));
      if (rm.error || !rm.data) return [];
      return rm.data.transactions.map(utxoTxToRow);
    }
    const r = await chainProviders.utxo(assetId).getHistory(addr);
    if (r.error || !r.data) return [];
    return r.data.transactions.map(utxoTxToRow);
  }
  if (assetId === 'xmr' || assetId === 'wow') {
    const addr = wallet.addresses[assetId];
    const viewKeyHex = bytesToHex(wallet.keys[assetId].privateViewKey);
    if (!addr) return [];
    const r = await chainProviders.lws(assetId).getHistory(addr, viewKeyHex);
    if (r.error || !r.data) return [];
    return r.data.transactions.map((t): AssetDetailTxRow => {
      // Atomic amounts are strings (may exceed 2^53); compare + sum as BigInt.
      // total_received > 0 means we received; spent_outputs presence means we sent.
      // LWS rows can be both (change): direction = 'in' if net positive, else 'out'.
      const received = BigInt(t.total_received) > 0n;
      return {
        kind: 'cryptonote',
        direction: received ? 'in' : 'out',
        amountAtomic: received
          ? BigInt(t.total_received)
          : t.spent_outputs.reduce((s, o) => s + BigInt(o.amount), 0n),
        txid: t.txid,
        heightOrPending: t.is_pending ? 'pending' : t.height,
        timestamp: t.timestamp,
      };
    });
  }
  if (assetId === 'grin') {
    // Grin on v3 is non-custodial: `POST /wallet/grin/scan` returns the current
    // UTXO set only (no send/receive log) and Mimblewimble commitments carry no
    // amount/direction a third party could reconstruct. So history comes from the
    // client-side append-only tx journal (grin-tx-journal.ts), which records each
    // flow's metadata at build/finalize/sign/tip time. Purely DISPLAY (it never
    // gates spending) and best-effort: a bad journal yields [], never a throw.
    const entries = await readGrinJournal().catch(() => []);
    return entries.map(grinJournalEntryToRow);
  }
  return [];
}

/** Map an Electrum UTXO history row (single- or multi-address) to the UI row.
 *  Electrum returns total_received / total_sent in atomic units; direction is
 *  whichever is non-zero, amount is the absolute value. */
function utxoTxToRow(t: {
  txid: string;
  height: number;
  fee?: number;
  total_received?: number;
  total_sent?: number;
}): AssetDetailTxRow {
  return {
    kind: 'utxo',
    direction: (t.total_received ?? 0) > 0 ? 'in' : 'out',
    amountAtomic: BigInt(
      (t.total_received ?? 0) > 0 ? (t.total_received ?? 0) : (t.total_sent ?? 0),
    ),
    txid: t.txid,
    heightOrPending: t.height > 0 ? t.height : 'pending',
    ...(t.fee !== undefined ? { feeAtomic: BigInt(t.fee) } : {}),
  };
}

/** Map a client tx-journal entry onto the UI's `grin` history-row shape. */
function grinJournalEntryToRow(e: GrinTxJournalEntry): AssetDetailTxRow {
  return {
    kind: 'grin',
    direction: e.direction === 'send' ? 'out' : 'in',
    amountAtomic: BigInt(Math.max(0, Math.round(e.amountNanogrin))),
    feeAtomic: BigInt(Math.max(0, Math.round(e.fee ?? 0))),
    kernelExcess: e.kernelExcess ?? null,
    slateId: e.slateId,
    status: e.status,
    ...(e.counterparty ? { counterpartyUsername: e.counterparty } : {}),
    timestamp: new Date(e.createdAt).toISOString(),
  };
}
