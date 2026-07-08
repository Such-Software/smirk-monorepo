import { useMemo } from 'preact/hooks';
import { TrocadorSwap } from '@smirk/swap';
import { api, type UnlockedWallet } from '@smirk/core';
import {
  SwapTab,
  useRoute,
  TROCADOR_WIZARD_ID,
  type SwapInFlight,
  type SwapQuoteSummary,
} from '@smirk/ui';
import { listAssets, mustGetAsset } from '@smirk/assets';
import { parseAmount, atomicToText, randomToken } from '../format';
import { validateAddress } from '../address';
import { resolveIcon } from '../icons';
import { store } from '../singletons';
import type { WalletSession } from '../types';

/**
 * SwapRouter — wires the @smirk/ui SwapTab to the TrocadorSwap library
 * and the wallet's send-handler. Single-provider for v0.3 (Trocador);
 * additional providers slot in by extending the wizard branch in
 * SwapTab and adding more handlers here.
 *
 * Client-direct architecture (V0_3_PLAN.md Decision 2): Trocador calls
 * go straight from this context to api.trocador.app. Backend
 * involvement is bookkeeping only — `POST /api/v1/swaps` so the
 * status mirror webhook has somewhere to write.
 */
export function SwapRouter({
  wallet,
  session,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
}) {
  const { navigate } = useRoute();
  const apiKey = import.meta.env.VITE_TROCADOR_API_KEY ?? '';
  // Webhook URL pointing at *our* backend's receiver. Trocador POSTs
  // status changes here; receiver authenticates via the per-swap
  // webhook_token passed in `passthrough`.
  const webhookBase =
    import.meta.env.VITE_SMIRK_BACKEND_URL ?? 'https://backend.smirk.cash';
  const webhookUrl = `${webhookBase}/api/v1/webhook/trocador`;

  // Instantiate TrocadorSwap once per mount with build-time config.
  // passthrough is set on a per-trade basis (random token), not here.
  const trocador = useMemo(
    () =>
      apiKey
        ? new TrocadorSwap({ apiKey, webhookUrl })
        : null,
    [apiKey, webhookUrl],
  );

  if (!trocador) {
    return (
      <div>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Swap</h2>
        <p class="muted" style={{ fontSize: 12 }}>
          Swap is disabled in this build (VITE_TROCADOR_API_KEY unset).
          Set it at build time to enable Trocador.
        </p>
      </div>
    );
  }

  return (
    <SwapTab
      fromAssets={listAssets()
        .filter((a) => a.sendable && trocador.isKnownAsset(a.id))
        .map((a) => a.id)}
      toAssets={listAssets()
        .filter((a) => a.receivable && trocador.isKnownAsset(a.id))
        .map((a) => a.id)}
      resolveBalance={(assetId) => {
        // Pull from the session's last-fetched balance snapshot.
        const b = session?.balances?.[
          assetId as keyof NonNullable<WalletSession['balances']>
        ];
        return b ? b.confirmed : null;
      }}
      parseAmount={(assetId, text) => parseAmount(assetId, text)}
      resolveIcon={resolveIcon}
      resolveAddress={(assetId) =>
        (wallet.addresses as unknown as Record<string, string | undefined>)[
          assetId
        ] ?? null
      }
      // Reuse the SendWizard's validator. The swap surface ignored
      // address format pre-2026-06-13 — any address the user pasted
      // was forwarded to /new_trade unchanged, opening the wrong-
      // chain refund hazard (XMR refunded to a BTC address, etc.).
      // `validateAddress` is the same helper SendWizard uses.
      validateAddress={validateAddress}
      onListRecentSwaps={async () => {
        // Surface any non-terminal swap whose wizard state was lost
        // (X-button cancel, popup-close during confirm, browser
        // restart). listSwaps already shipped in @smirk/core but
        // had zero consumers before today.
        const res = await api.listSwaps().catch(() => null);
        if (!res || res.error || !res.data) return [];
        return res.data.swaps.map((r) => ({
          id: r.trade_id,
          fromAsset: r.from_asset,
          toAsset: r.to_asset,
          fromAmountAtomic: r.amount_from_atomic,
          toAmountEstimateAtomic: r.amount_to_atomic ?? '0',
          depositAddress: r.deposit_address,
          status: r.status,
          createdAt: r.created_at,
        }));
      }}
      onResumeSwap={async (summary) => {
        // Rehydrate the trocador wizard state in one atomic write so
        // the user lands directly on StatusStep with live polling.
        // The state is set from the cached backend summary; the
        // real-time merge happens via onTrocadorFetchStatus on the
        // first 10s tick. Step is 3 (Status), not 2 (Deposit),
        // because resuming means "I already sent" — DepositStep
        // would offer to re-pre-fill the Send wizard, which is
        // wrong for a resumed swap.
        await store.update((s) => {
          const w = s.wizards[TROCADOR_WIZARD_ID];
          const inFlight: SwapInFlight = {
            id: summary.id,
            fromAsset: summary.fromAsset,
            toAsset: summary.toAsset,
            fromAmountAtomic: summary.fromAmountAtomic,
            toAmountEstimateAtomic: summary.toAmountEstimateAtomic,
            depositAddress: summary.depositAddress,
            state: { state: 'pending', reason: 'awaiting_deposit' },
          };
          if (w) {
            w.fields = { ...w.fields, inFlight, step: 3 };
          } else {
            s.wizards[TROCADOR_WIZARD_ID] = {
              step: 0,
              fields: { step: 3, inFlight },
              startedAt: Date.now(),
            };
          }
        });
      }}
      onTrocadorQuote={async (req) => {
        const q = await trocador.quote({
          fromAsset: req.fromAsset,
          toAsset: req.toAsset,
          fromAmount: req.fromAmountAtomic,
        });
        const impl = q.implementationData as
          | { tradeId?: string; provider?: string }
          | null;
        const sum: SwapQuoteSummary = {
          tradeId: impl?.tradeId ?? '',
          fromAsset: q.fromAsset,
          toAsset: q.toAsset,
          fromAmountAtomic: q.fromAmount,
          toAmountEstimateAtomic: q.toAmountEstimate,
          feeEstimateAtomic: q.feeEstimate,
          provider: impl?.provider ?? '',
          etaSeconds: q.etaSeconds,
          expiresAtMs: q.expiresAt.getTime(),
        };
        return sum;
      }}
      onTrocadorConfirm={async ({ quote, toAddress, refundAddress }) => {
        if (!quote.tradeId || !quote.provider) {
          throw new Error('Quote is missing trade context — please re-quote.');
        }
        // Per-swap shared-secret. Trocador echoes back as
        // passthrough on the webhook; backend verifies match.
        const webhookToken = randomToken(24);
        // Rebuild a SwapQuote from persisted fields. The Trocador
        // library only reads (tradeId, provider, amountFromDecimal,
        // amountToDecimal) from implementationData on /new_trade —
        // we don't need to round-trip the original quote object.
        const fromAsset = mustGetAsset(quote.fromAsset);
        const toAsset = mustGetAsset(quote.toAsset);
        const rebuiltQuote = {
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          fromAmount: quote.fromAmountAtomic,
          toAmountEstimate: quote.toAmountEstimateAtomic,
          feeEstimate: quote.feeEstimateAtomic,
          etaSeconds: quote.etaSeconds,
          expiresAt: new Date(quote.expiresAtMs),
          kind: 'aggregator' as const,
          implementationData: {
            tradeId: quote.tradeId,
            provider: quote.provider,
            amountFromDecimal: atomicToText(quote.fromAmountAtomic, fromAsset.id),
            amountToDecimal: atomicToText(quote.toAmountEstimateAtomic, toAsset.id),
          },
        };
        const started = await trocador.start({
          quote: rebuiltQuote,
          toAddress,
          refundAddress,
          // Per-trade webhook secret. Without this, Trocador delivers
          // every webhook with passthrough=null and the backend
          // rejects every one as a token mismatch — the 60s backup
          // poller would be the only finalization path. See the
          // 2026-06-13 swap-e2e review ship-blocker write-up.
          passthrough: webhookToken,
        });

        // Build the SwapInFlight up front so we can persist it to
        // the trocador wizard BEFORE awaiting backend createSwap.
        // Trocador's /new_trade is non-idempotent network state —
        // an MV3 popup-close between /new_trade success and the
        // wizard write strands the trade with no recovery
        // affordance. Writing inFlight first means the user always
        // has the deposit address + trade_id locally even if
        // backend createSwap fails or the popup closes mid-handler.
        const sw: SwapInFlight = {
          id: started.id,
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          fromAmountAtomic: quote.fromAmountAtomic,
          toAmountEstimateAtomic: quote.toAmountEstimateAtomic,
          depositAddress: started.depositAddress,
          state: { state: 'pending', reason: 'awaiting_deposit' },
        };
        await store.update((s) => {
          const w = s.wizards[TROCADOR_WIZARD_ID];
          if (w) {
            w.fields = { ...w.fields, inFlight: sw, step: 2 };
          }
        });

        // Persist to backend so the webhook receiver knows the token.
        // Best-effort — failure here means status updates from the
        // webhook won't be authenticated (rejected as 404), but the
        // UI's direct-poll-on-Trocador path still works.
        let backendTrackingOk = true;
        try {
          const res = await api.createSwap({
            trade_id: started.id,
            from_asset: quote.fromAsset,
            to_asset: quote.toAsset,
            amount_from_atomic: quote.fromAmountAtomic,
            deposit_address: started.depositAddress,
            recipient_address: toAddress,
            refund_address: refundAddress,
            provider: quote.provider,
            webhook_token: webhookToken,
          });
          backendTrackingOk = !res.error;
          if (res.error) {
            console.warn('[swap] backend createSwap returned error:', res.error);
          }
        } catch (e) {
          backendTrackingOk = false;
          console.warn('[swap] backend createSwap threw (non-fatal)', e);
        }
        void backendTrackingOk;
        return sw;
      }}
      onOpenSend={(deposit) => {
        // Pre-fill the SendWizard with the deposit address + amount so
        // the user lands directly on Compose with everything filled.
        // Also stash a `pendingContext` so the resulting
        // pendingOutgoing entry is tagged as a swap-deposit — the
        // AssetDetail Activity row then renders "Swap deposit → XMR
        // (CDNQ…)" with a tap-link back to the swap status, instead
        // of a generic "Sending to LTC1Q…".
        //
        // Guard against silently destroying an in-progress send
        // draft: pre-2026-06-13 this handler unconditionally
        // overwrote s.wizards.send, so a user with a half-typed
        // send to a friend would lose their draft on the prefill
        // click. Other update sites at lines 2067, 2454, 4321 all
        // use the safe `const w = s.wizards.send; if (w)` pattern;
        // only this handler nuked the slot. Now we check, prompt,
        // and bail if the user wants to keep their draft.
        void (async () => {
          const current = await store.load();
          const existing = current.wizards.send;
          // Heuristic: a populated draft has at least one of the
          // user-typed fields (fromAssetId at non-empty, toAddress,
          // amountText). An empty step=0 wizard from a previous
          // visit doesn't count.
          const f = existing?.fields as
            | { fromAssetId?: string; toAddress?: string; amountText?: string }
            | undefined;
          const isPopulated =
            !!f &&
            (!!f.toAddress ||
              !!f.amountText ||
              (!!f.fromAssetId && (existing?.step ?? 0) > 0));
          if (isPopulated) {
            const ok = window.confirm(
              'You have a Send draft in progress — replace it with this swap deposit?',
            );
            if (!ok) return;
          }
          await store.update((s) => {
            s.wizards.send = {
              step: 2, // skip Pick + Address; jump to Compose
              startedAt: Date.now(),
              fields: {
                fromAssetId: deposit.fromAsset,
                toAddress: deposit.depositAddress,
                amountText: atomicToText(
                  deposit.fromAmountAtomic,
                  deposit.fromAsset,
                ),
                pendingContext: {
                  kind: 'swap-deposit',
                  tradeId: deposit.id,
                  toAsset: deposit.toAsset,
                  provider: 'trocador',
                },
                // Stash the original prefill seed so the
                // popup-level onSubmit cross-checker (below) can
                // verify the user didn't mutate fromAsset/toAddress
                // mid-flow into something unrelated. Mismatch =
                // drop the pendingContext at write time so the
                // resulting Activity row says "Send" not the wrong
                // "Swap deposit → XMR (trade …)".
                pendingContextSeed: {
                  fromAssetId: deposit.fromAsset,
                  toAddress: deposit.depositAddress,
                },
              },
            };
          });
          await navigate('home/send');
        })();
      }}
      onTrocadorFetchStatus={async (id) => {
        // Hybrid: backend for identities (from/to/amount/address),
        // Trocador direct for state. v0.3.0 originally trusted the
        // backend's `status` column unconditionally — but the only
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
        const backend = await api.getSwap(id).catch(() => null);
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
            // outage shouldn't tank the polling loop — keep the
            // backend's state as a fallback.
            try {
              const live = await trocador.status(id);
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
        // Backend doesn't know about this swap — go direct.
        const s = await trocador.status(id);
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
      }}
    />
  );
}

/** Translate the backend's status string (a verbatim mirror of
 *  Trocador's lifecycle) into the SwapInFlight discriminated union
 *  the UI renders. Kept here so the popup is the only place that
 *  knows the Trocador-string ↔ structured-state mapping.
 *
 *  `extra` carries the parts of the persisted SwapRecord that the
 *  status alone can't supply — the final to-amount (Trocador stores
 *  this on the row at terminal-transition; pre-2026-06-13 the
 *  mapper hardcoded '0' so every completed swap showed
 *  "Completed — 0 LTC sent"), and the refund address (needed so the
 *  'expired' state can tell the user where their deposit will return
 *  to if they did broadcast). Both are optional — the caller may
 *  not have them yet — and the mapper falls back to neutral copy
 *  when they're absent. */
function mapBackendStatus(
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
      // Surface the refund destination when we have it — gives the
      // user a chain address to watch instead of "trust us, it's on
      // its way back."
      const reason = extra?.refundAddress
        ? `Refunded by provider to ${extra.refundAddress}`
        : 'Refunded by provider';
      return { state: 'refunded', refundTxId: '', reason };
    }
    case 'expired': {
      // Trocador's `expired` covers TWO real-world cases: (a) the
      // quote validity window elapsed before any deposit arrived —
      // no money moved — and (b) deposit landed but the underlying
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
      // exchanging" forever — that's how the 2026-06-04 audit
      // found a future-Trocador-status would manifest as a stuck
      // visual on a swap that actually completed.
      return {
        state: 'failed',
        reason: `Unknown provider status: ${status || '(empty)'}`,
      };
  }
}
