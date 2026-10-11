import { nativeFetch } from '../native-fetch';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { TrocadorSwap, type NonlogsQuoteData } from '@smirk/swap';
import { api, type UnlockedWallet } from '@smirk/core';
import {
  SwapTab,
  TROCADOR_WIZARD_ID,
  THORCHAIN_WIZARD_ID,
  NONLOGS_WIZARD_ID,
  type ProviderHandlers,
  type SwapInFlight,
  type SwapQuoteSummary,
  type ThorchainHandlers,
} from '@smirk/ui';
import { listAssets, mustGetAsset } from '@smirk/assets';
import { parseAmount, atomicToText, randomToken } from '../format';
import { validateAddress } from '../address';
import { resolveIcon } from '../icons';
import { store } from '../singletons';
import type { WalletSession } from '../types';
import { confirmThorchainSwap, thorchainGatewayHost, thorchainOffered, thorchainQuoteSummary, thorchainSwap } from '../thorchain';
import { nonlogsOffered, nonlogsSwap, ownAddressesOnly } from '../nonlogs';
import { findSwapDeposit, journalKeyFor, recordSend } from '../send-journal';
import { swapOpenSendHandler } from '../swap-handoff';
import { fetchTrocadorSwapStatus, SWAP_TRACKED_AT } from '../swap-status';

/**
 * SwapRouter: wires the @smirk/ui SwapTab to the TrocadorSwap library
 * and the wallet's send-handler. Single-provider for v0.3 (Trocador);
 * additional providers slot in by extending the wizard branch in
 * SwapTab and adding more handlers here.
 *
 * Client-direct architecture: Trocador calls go straight from this
 * context to api.trocador.app, so the backend never proxies user
 * money. Backend involvement is bookkeeping only: `POST /api/v1/swaps` so the
 * status mirror webhook has somewhere to write.
 */
export function SwapRouter({
  wallet,
  session,
}: {
  wallet: UnlockedWallet;
  session: WalletSession | null;
}) {
  const apiKey = import.meta.env.VITE_TROCADOR_API_KEY ?? '';
  // Webhook URL pointing at *our* backend's receiver. Trocador POSTs
  // status changes here; receiver authenticates via the per-swap
  // webhook_token passed in `passthrough`.
  // Read the RESOLVED backend off the api singleton, the same source every other
  // call site here uses (api.createSwap / getSwap / listSwaps). Taking it from
  // the BUILD-TIME VITE_SMIRK_BACKEND_URL instead meant a user pointed at their
  // own instance still had every swap reported to the default backend, and the
  // webhook wrote to a backend that had no row for the trade.
  // The base already INCLUDES `/api/v1` (e.g. `https://api.smirk.cash/api/v1`),
  // while the webhook path below is absolute from the server root. Strip the
  // suffix before appending, or we emit `/api/v1/api/v1/webhook/trocador`.
  const backendBase = api.getBaseUrl();
  const webhookBase = backendBase.replace(/\/api\/v1\/?$/, '');
  const webhookUrl = `${webhookBase}/api/v1/webhook/trocador`;

  // Desktop installs its native transport before the popup mounts. Never
  // offer a quote through browser fetch while that transport is unavailable.
  const { trocador, connectionError } = useMemo(() => {
    if (!apiKey) return { trocador: null, connectionError: null };
    try {
      const transport = nativeFetch();
      return {
        trocador: new TrocadorSwap({
          apiKey,
          webhookUrl,
          ...(transport ? { fetch: transport } : {}),
        }),
        connectionError: null,
      };
    } catch (error) {
      return {
        trocador: null,
        connectionError: error instanceof Error
          ? error.message
          : 'The swap connection is unavailable. Restart Smirk and try again.',
      };
    }
  }, [apiKey, webhookUrl]);

  // THORChain needs no key. Which pairs it offers is decided live, from
  // THORChain's pools and halt flags plus our backend's policy (XMR only when
  // the backend opens it). It answers from a public gateway, a third party,
  // so nothing is asked until the user taps the THORChain card or resumes a
  // THORChain swap: opening the Swap tab sends no request there.
  const thor = useMemo(() => {
    try {
      return { swap: thorchainSwap(), error: null as string | null };
    } catch (e) {
      return { swap: null, error: e instanceof Error ? e.message : 'THORChain is unavailable in this app.' };
    }
  }, []);
  const thorAsk = `Tap to check whether THORChain is live. This asks its public gateway (${thorchainGatewayHost()}), which sees your IP address.`;
  // The wallet server's own switch for THORChain, read from our backend (a
  // first-party request), so the card can sit with the live providers or,
  // when the server turned THORChain off, last as paused.
  const [thorOffered, setThorOffered] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void thorchainOffered().then((v) => {
      if (alive) setThorOffered(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const [thorCheck, setThorCheck] = useState(0);
  const [thorChecking, setThorChecking] = useState(false);
  const [thorPairs, setThorPairs] = useState<{ from: string[]; to: string[]; reason?: string }>({
    from: [],
    to: [],
    reason: thorAsk,
  });
  useEffect(() => {
    if (!thor.swap) {
      setThorPairs({ from: [], to: [], reason: thor.error ?? 'Unavailable.' });
      return;
    }
    if (thorCheck === 0) return; // Not asked: no request leaves the wallet.
    let alive = true;
    setThorChecking(true);
    setThorPairs({ from: [], to: [], reason: 'Checking THORChain…' });
    thor.swap
      .availablePairs()
      .then((pairs) => {
        if (!alive) return;
        const held = (a: string) => !!(wallet.addresses as unknown as Record<string, string | undefined>)[a];
        const usable = pairs.filter((p) => held(p.from) && held(p.to));
        setThorPairs(
          usable.length > 0
            ? { from: [...new Set(usable.map((p) => p.from))], to: [...new Set(usable.map((p) => p.to))] }
            : { from: [], to: [], reason: 'THORChain has no live pair for this wallet right now. Tap to check again.' },
        );
      })
      .catch((e: unknown) => {
        if (alive) {
          setThorPairs({
            from: [],
            to: [],
            reason: `${e instanceof Error ? e.message : 'THORChain is unreachable.'} Tap to check again.`,
          });
        }
      })
      .finally(() => {
        if (alive) setThorChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [thor, wallet, thorCheck]);

  const thorLive = thorPairs.from.length > 0 && thorPairs.to.length > 0;
  const thorHandlers: ThorchainHandlers | undefined = thor.swap
    ? {
        fromAssets: thorPairs.from,
        toAssets: thorPairs.to,
        ...(thorPairs.reason ? { unavailableReason: thorPairs.reason } : {}),
        ...(thorOffered === false
          ? { offered: false, unavailableReason: 'Turned off by this wallet server.' }
          : !thorLive && !thorChecking
            ? { onCheck: () => setThorCheck((n) => n + 1) }
            : {}),
        onQuote: async (req) => {
          // Indicative: no destination yet, so no memo. Confirm quotes again
          // with the real destination, and that is the quote that is sent.
          const q = await thor.swap!.quote({ fromAsset: req.fromAsset, toAsset: req.toAsset, fromAmount: req.fromAmountAtomic });
          return thorchainQuoteSummary(q);
        },
        onConfirm: ({ quote, toAddress }) =>
          confirmThorchainSwap({
            swap: thor.swap!,
            quote,
            toAddress,
            ownAddress: (asset) => (wallet.addresses as unknown as Record<string, string | undefined>)[asset],
          }),
        onFetchStatus: async (id) => {
          const st = await store.load();
          const cur = (st.wizards[THORCHAIN_WIZARD_ID]?.fields as { inFlight?: SwapInFlight } | undefined)?.inFlight;
          const base: SwapInFlight =
            cur && cur.id === id
              ? cur
              : {
                  id,
                  fromAsset: '',
                  toAsset: '',
                  fromAmountAtomic: '',
                  toAmountEstimateAtomic: '',
                  depositAddress: '',
                  provider: 'thorchain',
                  state: { state: 'pending', reason: 'awaiting_deposit' },
                };
          const journalKey = journalKeyFor(wallet);
          const journal = journalKey ? await findSwapDeposit(id, journalKey) : null;
          const txid = base.depositTxid ?? journal?.txid;
          if (!txid) {
            if (base.depositBeforeMs !== undefined && Date.now() > base.depositBeforeMs) {
              return { ...base, state: { state: 'failed', reason: 'The quote expired before a deposit was sent. Nothing was spent.' } };
            }
            return base;
          }
          const state = await thor.swap!.status(txid);
          if (journal?.swap && journalKey) {
            void recordSend({
              ...journal,
              swap: {
                ...journal.swap,
                state: state.state,
                ...(state.state === 'completed' ? { outboundTxid: state.outboundTxId } : {}),
              },
            }, journalKey);
          }
          return { ...base, depositTxid: txid, state };
        },
      }
    : undefined;

  // NonLogs: offered only when our wallet server brokers it (it holds the
  // NonLogs key). Coins are the ones NonLogs lists as swappable now that
  // this wallet holds; any listed coin swaps to any other.
  const nonlogs = useMemo(() => nonlogsSwap(), []);
  // Hidden until our wallet server says it offers NonLogs, so a server that
  // does not (the public default) never flashes a NonLogs card.
  const [nlAssets, setNlAssets] = useState<{ assets: string[]; reason?: string; offered?: boolean }>({
    assets: [],
    reason: 'Checking NonLogs…',
    offered: false,
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!(await nonlogsOffered())) {
          if (alive) setNlAssets({ assets: [], reason: 'Not offered by this wallet server.', offered: false });
          return;
        }
        const listed = await nonlogs.availableAssets();
        const held = listed.filter((a) => !!(wallet.addresses as unknown as Record<string, string | undefined>)[a]);
        if (alive) {
          setNlAssets(
            held.length >= 2 ? { assets: held } : { assets: [], reason: 'NonLogs lists no pair for this wallet right now.' },
          );
        }
      } catch (e) {
        if (alive) setNlAssets({ assets: [], reason: e instanceof Error ? e.message : 'NonLogs is unreachable.' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [nonlogs, wallet]);

  const ownAddress = (asset: string) => (wallet.addresses as unknown as Record<string, string | undefined>)[asset];

  const nonlogsHandlers: ProviderHandlers = {
    fromAssets: nlAssets.assets,
    toAssets: nlAssets.assets,
    ...(nlAssets.reason ? { unavailableReason: nlAssets.reason } : {}),
    ...(nlAssets.offered === false ? { offered: false } : {}),
    onQuote: async (req) => {
      const q = await nonlogs.quote({ fromAsset: req.fromAsset, toAsset: req.toAsset, fromAmount: req.fromAmountAtomic });
      const data = q.implementationData as NonlogsQuoteData;
      return {
        tradeId: '',
        fromAsset: q.fromAsset,
        toAsset: q.toAsset,
        fromAmountAtomic: q.fromAmount,
        toAmountEstimateAtomic: q.toAmountEstimate,
        feeEstimateAtomic: q.feeEstimate,
        provider: 'nonlogs',
        etaSeconds: q.etaSeconds,
        expiresAtMs: q.expiresAt.getTime(),
        providerData: data,
        ...(data.analysis ? { bookAnalysis: data.analysis } : {}),
        notices: [
          'Prices float until NonLogs executes; nothing is reserved by this quote.',
          'After your deposit confirms, matching can take up to 12 hours.',
          'If only part fills, NonLogs pays out that part and refunds the rest to your refund address.',
          ...(data.minimum ? [`NonLogs minimum for this pair: ${data.minimum}.`] : []),
        ],
      };
    },
    onConfirm: async ({ quote, toAddress, refundAddress }) => {
      const refusal = ownAddressesOnly({
        toAddress,
        refundAddress,
        ownTo: ownAddress(quote.toAsset),
        ownFrom: ownAddress(quote.fromAsset),
      });
      if (refusal) throw new Error(refusal);
      const data = quote.providerData as NonlogsQuoteData | undefined;
      if (!data || data.provider !== 'nonlogs') throw new Error('This quote is not a NonLogs quote. Get a new quote.');
      // The persisted quote carries its request id, so confirming again after
      // a failure or a closed popup returns the same swap, never a second one.
      const started = await nonlogs.start({
        quote: {
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          fromAmount: quote.fromAmountAtomic,
          toAmountEstimate: quote.toAmountEstimateAtomic,
          feeEstimate: quote.feeEstimateAtomic,
          etaSeconds: quote.etaSeconds,
          expiresAt: new Date(quote.expiresAtMs),
          kind: 'aggregator',
          implementationData: data,
        },
        toAddress,
        refundAddress,
      });
      const sw: SwapInFlight = {
        id: started.id,
        fromAsset: quote.fromAsset,
        toAsset: quote.toAsset,
        fromAmountAtomic: quote.fromAmountAtomic,
        toAmountEstimateAtomic: quote.toAmountEstimateAtomic,
        depositAddress: started.depositAddress,
        provider: 'nonlogs',
        ...(started.statusUrl ? { statusUrl: started.statusUrl } : {}),
        state: { state: 'pending', reason: 'awaiting_deposit' },
      };
      return sw;
    },
    onFetchStatus: async (id) => {
      const st = await store.load();
      const cur = (st.wizards[NONLOGS_WIZARD_ID]?.fields as { inFlight?: SwapInFlight } | undefined)?.inFlight;
      const base: SwapInFlight =
        cur && cur.id === id
          ? cur
          : {
              id,
              fromAsset: '',
              toAsset: '',
              fromAmountAtomic: '',
              toAmountEstimateAtomic: '',
              depositAddress: '',
              provider: 'nonlogs',
              state: { state: 'pending', reason: 'awaiting_deposit' },
            };
      const state = base.toAsset ? await nonlogs.statusFor(id, base.toAsset) : await nonlogs.status(id);
      const journalKey = journalKeyFor(wallet);
      const journal = journalKey ? await findSwapDeposit(id, journalKey) : null;
      if (journal?.swap && journalKey) {
        void recordSend(
          {
            ...journal,
            swap: {
              ...journal.swap,
              state: state.state,
              ...(state.state === 'completed' ? { outboundTxid: state.outboundTxId } : {}),
            },
          },
          journalKey,
        );
      }
      return { ...base, ...(journal?.txid ? { depositTxid: journal.txid } : {}), state };
    },
  };

  // WOW and GRIN: live DEX prices from our Neroswap aggregator for the
  // link-out panel. Best-effort; the panel lists venues without them, and
  // asks for prices only when the user taps for them.
  const loadTradePrices = useMemo(
    () => async (): Promise<Array<{ pair: string; bestBid: number | null; bestAsk: number | null }>> => {
      let transport: typeof fetch | undefined;
      try {
        transport = nativeFetch();
      } catch {
        transport = undefined;
      }
      const get = transport ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
      const out: Array<{ pair: string; bestBid: number | null; bestAsk: number | null }> = [];
      for (const pair of ['WOW-BTC', 'WOW-XMR', 'GRIN-BTC']) {
        try {
          const res = await get(`https://neroswap.com/api/v1/best?pair=${pair}`);
          if (!res.ok) continue;
          const body = (await res.json()) as { consolidated?: { bestBid?: unknown; bestAsk?: unknown } };
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          out.push({ pair, bestBid: num(body.consolidated?.bestBid), bestAsk: num(body.consolidated?.bestAsk) });
        } catch {
          // One pair failing leaves the others.
        }
      }
      return out;
    },
    [],
  );

  if (!trocador && !thorHandlers && nlAssets.assets.length === 0) {
    return (
      <div>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Swap</h2>
        <p class="muted" style={{ fontSize: 12 }}>
          {connectionError ?? 'Swaps are currently unavailable in this app.'}
        </p>
      </div>
    );
  }

  return (
    <SwapTab
      fromAssets={trocador
        ? listAssets().filter((a) => a.sendable && trocador.isKnownAsset(a.id)).map((a) => a.id)
        : []}
      toAssets={trocador
        ? listAssets().filter((a) => a.receivable && trocador.isKnownAsset(a.id)).map((a) => a.id)
        : []}
      {...(thorHandlers ? { thorchain: thorHandlers } : {})}
      nonlogs={nonlogsHandlers}
      loadTradePrices={loadTradePrices}
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
      // address format pre-2026-06-13: any address the user pasted
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
        // because resuming means "I already sent"; DepositStep
        // would offer to re-pre-fill the Send wizard, which is
        // wrong for a resumed swap.
        // Listed by the backend this window is on, so recorded there.
        const trackedAt = api.getBaseUrl();
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
            w.fields = { ...w.fields, inFlight, step: 3, [SWAP_TRACKED_AT]: trackedAt };
          } else {
            s.wizards[TROCADOR_WIZARD_ID] = {
              step: 0,
              fields: { step: 3, inFlight, [SWAP_TRACKED_AT]: trackedAt },
              startedAt: Date.now(),
            };
          }
        });
      }}
      onTrocadorQuote={async (req) => {
        if (!trocador) throw new Error(connectionError ?? 'Trocador is unavailable in this app.');
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
        if (!trocador) throw new Error(connectionError ?? 'Trocador is unavailable in this app.');
        if (!quote.tradeId || !quote.provider) {
          throw new Error('Quote is missing trade context — please re-quote.');
        }
        // Per-swap shared-secret. Trocador echoes back as
        // passthrough on the webhook; backend verifies match.
        const webhookToken = randomToken(24);
        // Rebuild a SwapQuote from persisted fields. The Trocador
        // library only reads (tradeId, provider, amountFromDecimal,
        // amountToDecimal) from implementationData on /new_trade;
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
          // rejects every one as a token mismatch; the 60s backup
          // poller would be the only finalization path. See the
          // 2026-06-13 swap-e2e review ship-blocker write-up.
          passthrough: webhookToken,
        });

        // Build the SwapInFlight up front so we can persist it to
        // the trocador wizard BEFORE awaiting backend createSwap.
        // Trocador's /new_trade is non-idempotent network state:
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
        // The backend this trade is recorded at: the only one later asked
        // about it (see swap-status.ts).
        const trackedAt = api.getBaseUrl();
        await store.update((s) => {
          const w = s.wizards[TROCADOR_WIZARD_ID];
          if (w) {
            w.fields = { ...w.fields, inFlight: sw, step: 2, [SWAP_TRACKED_AT]: trackedAt };
          }
        });

        // Persist to backend so the webhook receiver knows the token.
        // Best-effort: failure here means status updates from the
        // webhook won't be authenticated (rejected as 404), but the
        // UI's direct-poll-on-Trocador path still works.
        let backendTrackingOk = true;
        try {
          // Not to a backend the window moved to after the write above: the
          // trade is tracked at `trackedAt`, and nowhere else learns of it.
          if (api.getBaseUrl() !== trackedAt) {
            throw new Error('the backend changed before the swap could be recorded');
          }
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
      // Send opens on Compose with the deposit's coin, address and exact
      // amount; the draft and the route are one write (swap-handoff.ts). A
      // Send draft in progress is replaced only if the user agrees, and a Grin
      // payment waiting for its reply never is. Resolves false when Send did
      // not open, so the swap stays on its deposit step.
      onOpenSend={swapOpenSendHandler(store, {
        confirm: (question) => window.confirm(question),
        alert: (message) => window.alert(message),
      })}
      onTrocadorFetchStatus={async (id) => {
        if (!trocador) throw new Error(connectionError ?? 'Trocador is unavailable in this app.');
        // The backend's record is consulted only at the backend that recorded
        // this trade (see swap-status.ts).
        const fields = (await store.load()).wizards[TROCADOR_WIZARD_ID]?.fields as
          | Partial<{ inFlight: { id?: string }; [SWAP_TRACKED_AT]: string }>
          | undefined;
        const trackedAt = fields?.inFlight?.id === id ? fields[SWAP_TRACKED_AT] : undefined;
        return fetchTrocadorSwapStatus({ api, trocador }, id, trackedAt);
      }}
    />
  );
}
