/**
 * Buy premium from the wallet: choose a plan, choose how to pay, pay at the
 * processor's checkout, then redeem.
 *
 * Until this existed the feed quoted prices and offered no way to pay them.
 *
 * The flow survives the popup closing, which it always does: opening the
 * checkout opens a tab. The invoice is remembered per wallet BEFORE the tab
 * opens. While this screen is open the wallet checks for the payment on its
 * own, on a backing-off schedule that ends an hour after the invoice was
 * minted; "Check now" does the same on demand. Redeeming asks the backend,
 * which asks the processor that minted the invoice; an unsettled invoice is
 * simply not yet redeemable and stays so, so retrying is always safe.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  planLabel,
  offeredRails,
  isPendingRedeemable,
  isCheckoutUrl,
  nextPremiumPollDelayMs,
  premiumActivationOutcome,
  type PremiumCapability,
  type PendingPremiumInvoice,
} from '@smirk/core';
import { CopyableNpub } from '@smirk/ui';

import {
  loadPendingPremium,
  savePendingPremium,
  clearPendingPremium,
} from '../premium-pending';

const muted = { fontSize: 12, opacity: 0.65, lineHeight: 1.5 } as const;

const button = (enabled: boolean) =>
  ({
    padding: '6px 12px',
    borderRadius: 8,
    border: 'none',
    cursor: enabled ? 'pointer' : 'default',
    background: 'var(--smirk-accent)',
    color: 'var(--smirk-accent-fg, #fff)',
    fontWeight: 600,
    fontSize: 13,
    opacity: enabled ? 1 : 0.5,
  }) as const;

const choice = (selected: boolean) =>
  ({
    padding: '5px 10px',
    borderRadius: 8,
    border: `1px solid ${selected ? 'var(--smirk-accent)' : 'var(--smirk-border)'}`,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: selected ? 600 : 400,
  }) as const;

export function PremiumPurchase({
  premium,
  fingerprint,
  onActivated,
}: {
  premium: PremiumCapability;
  fingerprint: string | undefined;
  /** Called once premium is active, so the caller can re-read posting rights. */
  onActivated: () => void;
}) {
  const plans = premium.plans ?? [];
  const rails = offeredRails(premium.rails);
  const apiBase = api.getBaseUrl();

  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [railIdx, setRailIdx] = useState(0);
  const [pending, setPending] = useState<PendingPremiumInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  /** Automatic checking: running, over (the hour is up), or ended because the
   *  invoice can never activate. */
  const [auto, setAuto] = useState<'running' | 'over' | 'final'>('running');
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const checking = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadPendingPremium(fingerprint).then((p) => {
      if (cancelled) return;
      setPending(isPendingRedeemable(p, apiBase, Date.now()) ? p : null);
    });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, apiBase]);

  if (plans.length === 0) return null;

  const pay = async () => {
    const rail = rails[railIdx];
    if (!planId || !rail) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.createPremiumInvoice(planId, rail.id ?? undefined);
      if (!r.data) {
        setMessage({ tone: 'error', text: r.error ?? 'Could not create an invoice. Try again.' });
        return;
      }
      const p: PendingPremiumInvoice = {
        invoiceId: r.data.invoice_id,
        planId,
        rail: rail.id,
        payTo: r.data.pay_to,
        apiBase,
        createdAt: Date.now(),
      };
      // Remember it BEFORE opening the checkout: opening a tab closes this popup.
      await savePendingPremium(fingerprint, p);
      setPending(p);
      if (isCheckoutUrl(p.payTo)) window.open(p.payTo, '_blank', 'noopener,noreferrer');
    } catch {
      setMessage({ tone: 'error', text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  /** One activation attempt. Automatic attempts stay quiet while the payment
   *  is merely unconfirmed; a manual one always reports. */
  const check = async (automatic: boolean) => {
    if (!pending || checking.current) return;
    checking.current = true;
    if (!automatic) setBusy(true);
    if (!automatic) setMessage(null);
    try {
      const r = await api.activatePremium(pending.invoiceId);
      setLastChecked(Date.now());
      if (r.data?.active) {
        await clearPendingPremium(fingerprint);
        setPending(null);
        setMessage({ tone: 'info', text: 'Premium is active. You can post now.' });
        onActivated();
      } else if (premiumActivationOutcome(r.error) === 'final') {
        setAuto('final');
        setMessage({ tone: 'error', text: r.error ?? 'This invoice cannot be used.' });
      } else if (!automatic) {
        // Not settled yet is the common case, and the server says so in words.
        setMessage({ tone: 'info', text: r.error ?? 'Payment not confirmed yet. Try again shortly.' });
      }
    } catch {
      if (!automatic) setMessage({ tone: 'error', text: 'Could not reach the server. Try again.' });
    } finally {
      checking.current = false;
      if (!automatic) setBusy(false);
      setPollTick((t) => t + 1);
    }
  };

  // Check for the payment on a backing-off schedule while this screen is open.
  useEffect(() => {
    if (!pending || auto === 'final') return;
    const delay = nextPremiumPollDelayMs(pending.createdAt, Date.now());
    if (delay === null) {
      setAuto('over');
      return;
    }
    setAuto('running');
    const timer = setTimeout(() => void check(true), delay);
    return () => clearTimeout(timer);
    // pollTick re-arms the timer after every attempt, manual or automatic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.invoiceId, pollTick, auto === 'final']);

  const abandon = async () => {
    await clearPendingPremium(fingerprint);
    setPending(null);
    setMessage(null);
    setAuto('running');
    setLastChecked(null);
  };

  const autoStatus =
    auto === 'running'
      ? `Checking for your payment automatically${
          lastChecked ? `; last checked ${new Date(lastChecked).toLocaleTimeString()}` : ''
        }.`
      : auto === 'over'
        ? 'Automatic checking has stopped. Use Check now once your payment has confirmed.'
        : null;

  return (
    <div data-testid="premium-purchase" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {pending ? (
        <>
          <p style={{ ...muted, margin: 0 }}>
            Finish paying at the checkout. Confirmation can take a few minutes for on-chain
            payments; keep this screen open and premium turns on by itself.
          </p>
          {autoStatus ? (
            <p style={{ ...muted, margin: 0 }} data-testid="premium-auto-status" aria-live="polite">
              {autoStatus}
            </p>
          ) : null}
          {isCheckoutUrl(pending.payTo) ? (
            <a
              href={pending.payTo}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...muted, opacity: 1, color: 'var(--smirk-accent)' }}
              data-testid="premium-checkout-link"
            >
              Open the checkout again
            </a>
          ) : (
            <span style={muted}>
              Pay to <CopyableNpub value={pending.payTo} label="address" />
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              data-testid="premium-redeem"
              disabled={busy}
              onClick={() => void check(false)}
              style={button(!busy)}
            >
              {busy ? 'Checking…' : 'Check now'}
            </button>
            <button
              type="button"
              data-testid="premium-abandon"
              disabled={busy}
              onClick={() => void abandon()}
              style={{ ...choice(false), border: 'none', opacity: 0.7 }}
            >
              Start over
            </button>
          </div>
        </>
      ) : (
        <>
          <div role="radiogroup" aria-label="Plan" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {plans.map((pl) => (
              <button
                key={pl.id}
                type="button"
                role="radio"
                aria-checked={pl.id === planId}
                data-testid={`premium-plan-${pl.id}`}
                onClick={() => setPlanId(pl.id)}
                style={choice(pl.id === planId)}
              >
                {planLabel(pl, premium.currency)}
              </button>
            ))}
          </div>
          {rails.length > 1 ? (
            <div
              role="radiogroup"
              aria-label="Pay with"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <span style={muted}>Pay with</span>
              {rails.map((r, i) => (
                <button
                  key={r.id ?? 'default'}
                  type="button"
                  role="radio"
                  aria-checked={i === railIdx}
                  data-testid={`premium-rail-${r.id ?? 'default'}`}
                  onClick={() => setRailIdx(i)}
                  style={choice(i === railIdx)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : rails[0]?.id ? (
            <span style={muted} data-testid="premium-rail-single">
              Pays in {rails[0].label}
            </span>
          ) : null}
          <div>
            <button
              type="button"
              data-testid="premium-buy"
              disabled={busy || !planId}
              onClick={() => void pay()}
              style={button(!busy && !!planId)}
            >
              {busy ? 'Creating invoice…' : 'Get premium'}
            </button>
          </div>
        </>
      )}
      {message ? (
        <p
          data-testid="premium-message"
          style={{
            ...muted,
            margin: 0,
            opacity: 1,
            color: message.tone === 'error' ? 'var(--smirk-negative)' : 'inherit',
          }}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
