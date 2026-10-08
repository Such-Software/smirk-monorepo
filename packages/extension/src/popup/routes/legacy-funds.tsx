/**
 * Settings → Older addresses and tips.
 *
 * Shows what the older-address check found (see `legacy-funds.ts`), lets the
 * user move it into the wallet after seeing the amount and fee, offers the
 * explicit "scan on the server" step for older Monero/Wownero addresses the
 * server does not watch, and claims tips still waiting on the old Smirk server.
 */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { legacySourceLabel, type LegacyCheckRecord, type LegacyFinding, type UnlockedWallet } from '@smirk/core';
import { formatAmountWithTicker } from '@smirk/ui';
import { store } from '../singletons';
import {
  legacyAutoCheckEnabled,
  moveLegacyFunds,
  readLegacyCheck,
  runLegacyCheck,
} from '../legacy-funds';
import { claimLegacyTip, listLegacyTips, type LegacyTip } from '../legacy-tips';
import type { SweepSummary } from '../tip-claim-handler';
import type { WalletSession } from '../types';

const box: JSX.CSSProperties = {
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  marginTop: 10,
};
const btn: JSX.CSSProperties = {
  padding: '6px 12px',
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};
const muted: JSX.CSSProperties = { fontSize: 12, opacity: 0.7, lineHeight: 1.45, margin: '4px 0 0' };

function shortAddress(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

function amountText(f: LegacyFinding): string {
  const parts: string[] = [];
  if (BigInt(f.spendableAtomic) > 0n) parts.push(`${formatAmountWithTicker(BigInt(f.spendableAtomic), f.asset)} ready to move`);
  if (BigInt(f.pendingAtomic) > 0n) parts.push(`${formatAmountWithTicker(BigInt(f.pendingAtomic), f.asset)} still arriving`);
  return parts.join(' · ');
}

function stateText(f: LegacyFinding): string {
  switch (f.state) {
    case 'funds':
      return amountText(f);
    case 'empty':
      return 'Nothing here.';
    case 'scanning': {
      const s = f.scan;
      if (!s) return 'The server is scanning this address. Check again in a while.';
      const pct = Math.floor(
        (100 * Math.max(0, s.scannedHeight - s.startHeight)) / Math.max(1, s.blockchainHeight - s.startHeight),
      );
      return `The server is scanning this address (${pct}%). Check again in a while.`;
    }
    case 'not-scanned':
      return f.detail ?? 'Not checked yet.';
    case 'error':
      return f.detail ?? 'Could not check this address right now.';
  }
}

interface PendingConfirm {
  finding: LegacyFinding;
  summary: SweepSummary;
  resolve: () => void;
  reject: (e: Error) => void;
}

export function LegacyFundsRoute({
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
  const [record, setRecord] = useState<LegacyCheckRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [autoCheck, setAutoCheck] = useState(true);
  const [tips, setTips] = useState<LegacyTip[] | null>(null);
  const needsPhrase = !wallet.mnemonic;

  useEffect(() => {
    void readLegacyCheck(wallet.fingerprint).then(setRecord);
    void legacyAutoCheckEnabled().then(setAutoCheck);
  }, [wallet.fingerprint]);

  const check = async (mode: 'probe' | 'scan') => {
    setBusy(mode);
    setMessage(null);
    try {
      setRecord(await runLegacyCheck(wallet, { mode, userId: session?.bootstrap.userId ?? null }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The check failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const move = async (f: LegacyFinding) => {
    setBusy(`move:${f.address}`);
    setMessage(null);
    const outcome = await moveLegacyFunds(
      wallet,
      f,
      (summary) =>
        new Promise<void>((resolve, reject) => setConfirm({ finding: f, summary, resolve, reject })),
    );
    setConfirm(null);
    setBusy(null);
    if (outcome.ok) {
      setMessage(
        `Moved ${formatAmountWithTicker(outcome.summary.amountAtomic, f.asset)} to your wallet. It shows in your balance once the network confirms it.`,
      );
      setRecord(await readLegacyCheck(wallet.fingerprint));
      void onRefresh();
    } else if (outcome.error !== 'Not moved.') {
      setMessage(outcome.error);
    }
  };

  const findTips = async () => {
    setBusy('tips');
    setMessage(null);
    const r = await listLegacyTips(wallet);
    setBusy(null);
    if (r.error) setMessage(r.error);
    else setTips(r.data ?? []);
  };

  const claim = async (t: LegacyTip) => {
    setBusy(`tip:${t.id}`);
    setMessage(null);
    const r = await claimLegacyTip(wallet, t.id);
    setBusy(null);
    if (r.ok) {
      setMessage(`Claimed ${formatAmountWithTicker(t.amountAtomic, t.asset)}. It shows in your balance once the network confirms it.`);
      setTips((prev) => (prev ? prev.filter((x) => x.id !== t.id) : prev));
      void onRefresh();
    } else {
      setMessage(r.error);
    }
  };

  const toggleAuto = async (next: boolean) => {
    setAutoCheck(next);
    await store.update((s) => {
      s.ui.legacyFundsAutoCheck = next;
    });
  };

  const shown = (record?.findings ?? []).filter((f) => f.state !== 'empty');
  const allEmpty = !!record && shown.length === 0;
  const anyNotScanned = (record?.findings ?? []).some((f) => f.state === 'not-scanned');

  return (
    <div data-testid="legacy-funds-route">
      <button onClick={onBack} style={{ ...btn, marginBottom: 12 }}>
        Back
      </button>
      <h2 style={{ fontSize: 16, margin: 0 }}>Older addresses and tips</h2>
      <p style={muted}>
        Earlier versions of Smirk used different addresses for the same recovery phrase. Coins sent to those
        addresses are still yours. Smirk can check them and move anything it finds into your wallet.
      </p>

      {needsPhrase && (
        <p style={{ ...muted, opacity: 0.9 }} data-testid="legacy-needs-unlock">
          Lock Smirk and unlock it with your password to use this screen: it needs your recovery phrase in memory.
        </p>
      )}

      <section style={box}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btn} disabled={needsPhrase || !!busy} onClick={() => void check('probe')} data-testid="legacy-check">
            {busy === 'probe' ? 'Checking…' : record ? 'Check again' : 'Check older addresses'}
          </button>
          {(anyNotScanned || record?.mode === 'scan') && (
            <button style={btn} disabled={needsPhrase || !!busy} onClick={() => void check('scan')} data-testid="legacy-scan">
              {busy === 'scan' ? 'Asking the server…' : 'Scan older Monero and Wownero addresses'}
            </button>
          )}
        </div>
        {anyNotScanned && (
          <p style={muted}>
            Scanning asks the Smirk server to search past blocks for your older Monero and Wownero addresses. It
            shares those addresses' view keys with the server, the same way your current balance does. It can take a
            few hours.
          </p>
        )}
        {record && (
          <p style={muted}>Last checked {new Date(record.checkedAt).toLocaleString()}.</p>
        )}
        {allEmpty && <p style={{ ...muted, opacity: 0.9 }}>Nothing found at your older addresses.</p>}
        {shown.map((f) => (
          <div key={`${f.asset}:${f.address}`} style={{ ...box, marginTop: 8 }} data-testid={`legacy-finding-${f.asset}`}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {f.asset.toUpperCase()} · {legacySourceLabel(f)}
            </div>
            <div style={{ ...muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              {shortAddress(f.address)}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{stateText(f)}</div>
            {f.state === 'funds' && BigInt(f.spendableAtomic) > 0n && (
              <button
                style={{ ...btn, marginTop: 8 }}
                disabled={needsPhrase || !!busy}
                onClick={() => void move(f)}
                data-testid={`legacy-move-${f.asset}`}
              >
                {busy === `move:${f.address}` ? 'Preparing…' : 'Move to my wallet'}
              </button>
            )}
          </div>
        ))}
      </section>

      {confirm && (
        <section style={{ ...box, borderColor: 'var(--smirk-accent, #888)' }} data-testid="legacy-confirm">
          <div style={{ fontSize: 13, fontWeight: 600 }}>Move these funds?</div>
          <p style={muted}>
            {formatAmountWithTicker(confirm.summary.amountAtomic, confirm.finding.asset)} goes to your current wallet
            address. Network fee: {formatAmountWithTicker(confirm.summary.feeAtomic, confirm.finding.asset)}.
            {confirm.summary.unsettledAtomic > 0n
              ? ` ${formatAmountWithTicker(confirm.summary.unsettledAtomic, confirm.finding.asset)} is still arriving and stays where it is for now; move it later.`
              : ''}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={btn} onClick={() => confirm.resolve()} data-testid="legacy-confirm-move">
              Move
            </button>
            <button style={btn} onClick={() => confirm.reject(new Error('Not moved.'))}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section style={box}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Tips waiting on the old Smirk server</div>
        <p style={muted}>
          Tips sent with Smirk before v0.3 are kept by the old server. Smirk can claim them into this wallet.
        </p>
        <button style={{ ...btn, marginTop: 8 }} disabled={needsPhrase || !!busy} onClick={() => void findTips()} data-testid="legacy-find-tips">
          {busy === 'tips' ? 'Looking…' : 'Look for tips'}
        </button>
        {tips && tips.length === 0 && <p style={muted}>No tips are waiting for you there.</p>}
        {tips?.map((t) => (
          <div key={t.id} style={{ ...box, marginTop: 8 }} data-testid="legacy-tip-row">
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {formatAmountWithTicker(t.amountAtomic, t.asset)} from {t.senderLabel}
            </div>
            <div style={muted}>
              {t.status === 'claiming' ? 'A claim was started but not finished.' : 'Waiting to be claimed.'}
            </div>
            {t.asset === 'grin' ? (
              <p style={muted}>Grin tips from the old server cannot be claimed in this version of Smirk.</p>
            ) : t.status === 'claiming' || t.isClaimable ? (
              <button style={{ ...btn, marginTop: 8 }} disabled={!!busy} onClick={() => void claim(t)}>
                {busy === `tip:${t.id}` ? 'Claiming…' : t.status === 'claiming' ? 'Finish claim' : 'Claim'}
              </button>
            ) : (
              <p style={muted}>
                Still confirming ({t.fundingConfirmations}/{t.confirmationsRequired}).
              </p>
            )}
          </div>
        ))}
      </section>

      <section style={{ marginTop: 16 }}>
        <label style={{ display: 'flex', gap: 10, fontSize: 13, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(e) => void toggleAuto((e.target as HTMLInputElement).checked)}
            data-testid="legacy-auto-check"
          />
          <span>
            Check older addresses automatically
            <span style={{ ...muted, display: 'block' }}>
              Once per wallet, after you unlock. Only reads addresses the server already watches; scanning anything
              new always needs your tap.
            </span>
          </span>
        </label>
      </section>

      {message && (
        <p style={{ fontSize: 12, marginTop: 12, lineHeight: 1.45 }} data-testid="legacy-message">
          {message}
        </p>
      )}
    </div>
  );
}

/** Home notice: shown when the last check found funds at an older address. */
export function LegacyFundsBanner({ count, onView }: { count: number; onView: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      onClick={onView}
      data-testid="legacy-funds-banner"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 14px',
        marginBottom: 8,
        background: 'var(--smirk-bg-sunken)',
        border: '1px solid var(--smirk-accent, #888)',
        borderRadius: 8,
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      Funds found at an older Smirk address. Review and move them to your wallet.
    </button>
  );
}
