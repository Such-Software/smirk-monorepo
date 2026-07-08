import { useEffect, useState } from 'preact/hooks';
import { api, type UnlockedWallet } from '@smirk/core';
import { SentTipsScreen, type SentTipRow } from '@smirk/ui';
import { listTipKeyBackups, removeTipKeyBackup } from '../tip-key-backup';
import { clawbackSocialTip } from '../tip-claim-handler';
import { resolveIcon } from '../icons';
import type { WalletSession } from '../types';

/**
 * Sent Tips cross-asset surface. Loads the user's sent tips from
 * the backend and overlays local IndexedDB backups so rows that
 * survived a backend incident still show up + can be clawed back
 * via the local key material.
 */
export function SentTipsRoute({
  wallet,
  session,
  onRefresh,
  onBack,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
  onRefresh: () => Promise<void>;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<SentTipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [resp, backups] = await Promise.all([
        api.getSentSocialTips(),
        listTipKeyBackups().catch(() => []),
      ]);
      const backupsById = new Map(backups.map((b) => [b.tipId, b]));
      const serverTips = resp.data?.tips ?? [];
      const serverIds = new Set(serverTips.map((t) => t.id));
      const out: SentTipRow[] = [];
      for (const t of serverTips) {
        const backup = backupsById.get(t.id);
        // Reconstruct the share URL only for public tips that have
        // (a) buried funding and (b) a local backup carrying the URL
        // fragment. Pre-2026-06-04 backups lack the fragment field —
        // those tips show no Copy link button (but can still be
        // clawed back; the funds are recoverable, just the URL
        // isn't). The fragment is the secret that decrypts the
        // backend's `encrypted_key`, must never leave the client.
        const fundingReady =
          (t.funding_confirmations ?? 0) >=
          (t.confirmations_required ?? 1);
        const shareUrl =
          t.is_public &&
          t.status === 'pending' &&
          fundingReady &&
          backup?.urlFragmentEncoded
            ? `https://smirk.cash/tip/${t.id}#${backup.urlFragmentEncoded}`
            : undefined;
        out.push({
          id: t.id,
          asset: t.asset,
          amount: t.amount,
          recipientPlatform: t.recipient_platform ?? null,
          recipientUsername: t.recipient_username ?? null,
          isPublic: t.is_public,
          status: t.status,
          createdAt: t.created_at,
          fundingConfirmations: t.funding_confirmations,
          confirmationsRequired: t.confirmations_required,
          ...(backup ? { hasLocalBackup: true } : {}),
          ...(shareUrl ? { shareUrl } : {}),
        });
      }
      // Orphan local backups — server lost the row but we can still
      // clawback locally via the stored key material.
      for (const b of backups) {
        if (serverIds.has(b.tipId)) continue;
        out.push({
          id: b.tipId,
          asset: b.asset,
          amount: b.amount,
          recipientPlatform: null,
          recipientUsername: null,
          isPublic: b.isPublic,
          status: 'pending',
          createdAt: new Date(b.createdAt).toISOString(),
          fundingConfirmations: 0,
          confirmationsRequired: 0,
          hasLocalBackup: true,
        });
      }
      setRows(out);
      if (resp.error) setError(resp.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sent tips');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <SentTipsScreen
      rows={rows}
      loading={loading}
      {...(error ? { error } : {})}
      onBack={onBack}
      onRefresh={load}
      onClawback={async (tipId) => {
        // Full on-chain clawback — see tip-claim-handler.ts.
        // Decrypts local backup, sweeps tip address back to sender's
        // wallet, marks backend as clawed_back, refreshes balances.
        const userId = session?.bootstrap?.userId;
        if (!userId) return { ok: false, error: 'Wallet not bootstrapped' };
        const outcome = await clawbackSocialTip(wallet, userId, tipId);
        if (!outcome.ok) return { ok: false, error: outcome.error };
        await removeTipKeyBackup(tipId);
        // Drop the row from local state — refresh will reflect new
        // backend state on next load.
        setRows((rs) => rs.filter((row) => row.id !== tipId));
        void onRefresh();
        return { ok: true };
      }}
      onDiscardDraft={async (tipId) => {
        const r = await api.cancelSocialTip(tipId);
        if (r.error || !r.data) {
          return { ok: false, error: r.error ?? 'Discard failed' };
        }
        await removeTipKeyBackup(tipId);
        setRows((rs) => rs.filter((row) => row.id !== tipId));
        return { ok: true };
      }}
      resolveIcon={resolveIcon}
    />
  );
}
