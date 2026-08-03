/**
 * SendWizard: Send flow with a Compose step (amount / fee tier / Max
 * sweep) and a separate Review step.
 *
 * Steps:
 *   0. Asset       : pick which coin to send.
 *   1. Address     : recipient address.
 *   2. Compose     : amount + balance display + Max button + fee tier
 *                    picker. All inputs editable here.
 *   3. Review      : read-only summary; tapping Send commits.
 *   (4. Done       : success screen with txid.)
 *
 * State persists via `@smirk/core`'s Wizard primitive, so closing the
 * popup mid-flow and reopening picks up where the user left off.
 *
 * Architecture choices, intentional:
 *
 * - **No hidden fee multipliers.** The rate the user picks is the rate
 *   the tx ships with. The Compose screen shows real-time fee, total,
 *   and "available after fee" so there are no off-by-one surprises.
 * - **Sweep is explicit.** Tapping Max sets a `sweep: boolean` flag
 *   carried all the way through to the send-handler. The send-handler
 *   produces a 1-output tx with no change; source address ends at 0.
 *   Not inferred from "amount happens to equal balance": deliberate.
 * - **Review is read-only.** Compose is where you edit; Review is where
 *   you commit. Back from Review preserves Compose state.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import type { AssetDefinition } from '@smirk/assets';
import { applyRelayFloor } from '@smirk/core';
import { useWizard } from '../state/hooks';
import { AssetIcon } from './AssetIcon';
import { Button } from './Button';
import { formatAmount, formatAmountWithAsset } from '../format';

export type FeeTier = 'fast' | 'normal' | 'slow' | 'custom';

export interface SendFields extends Record<string, unknown> {
  fromAssetId?: string;
  toAddress?: string;
  /** Amount as user-entered string (decimal). Empty when in sweep mode. */
  amountText?: string;
  /** Selected fee tier (radio selection on Compose). */
  feeTier?: FeeTier;
  /**
   * When `feeTier === 'custom'`, the rate the user entered (sat/vB).
   * Ignored otherwise.
   */
  customFeeRate?: number;
  /** True iff the Max button is active: sweep mode. */
  sweep?: boolean;
  /** Filled in after a successful broadcast; surfaced on the Done step. */
  lastTxid?: string;

  // ----- Grin-specific persistent state -----
  //
  // Mimblewimble's interactive flow is multi-step: sender builds S1,
  // sends to recipient, waits for S2 response, finalizes S3, broadcasts.
  // The wizard's step counter advances through Compose → GrinExchange
  // → Done. While in Exchange, these fields hold the slate state so
  // closing + reopening the popup picks up where the user left off.

  /** S1 slatepack armored string the user displays/copies to recipient. */
  grinArmoredOutgoing?: string;
  /** Opaque sender context JSON: passed back to `onGrinFinalize`. */
  grinSenderContextJson?: string;
  /** Slate UUID for backend bookkeeping. */
  grinSlateId?: string;
  /** Backend relay entry id, set when recipient is a Smirk user. */
  grinRelayId?: string;
  /** Serialized GrinUnspentOutput[] used to fund this send: needed at
   *  finalize to build the broadcastable tx bytes. */
  grinSenderInputsJson?: string;
  /** Serialized GrinChangeOutputInfo, present iff this tx has change. */
  grinChangeOutputJson?: string;
  /** Last paste/finalize error to surface in the Exchange step. */
  grinExchangeError?: string;
  /** S2 slatepack pre-pasted by the Inbox dispatcher (when the user
   *  pastes a slate with sta=S2 in Inbox, we deep-link here with the
   *  S2 ready for one-tap finalize instead of forcing another paste). */
  grinPastedS2?: string;

  /**
   * Pre-baked `pendingOutgoing.context` for this send. Set when the
   * Send was opened from a non-vanilla flow (Trocador swap deposit,
   * tip funding, etc.) so the resulting `pendingOutgoing` entry can
   * carry that origin through to the per-asset Activity row and the
   * row's tap-routing. Optional: vanilla sends from the Home action
   * bar leave this undefined and the popup treats them as
   * `{kind: 'send'}`. Stored as a plain object so it round-trips
   * through `chrome.storage.session` without bespoke serialization.
   */
  pendingContext?: import('@smirk/core').PendingOutgoingContext;

  /**
   * Snapshot of the prefill seed at the moment a non-vanilla entry
   * point (Trocador "Open Send → pre-filled", tip funding, etc.)
   * stashed the pendingContext above. The popup-level onSubmit
   * cross-checks this against the actual submitted fromAssetId +
   * toAddress and drops the pendingContext on mismatch; that way
   * a user who back-navigates and switches to an unrelated asset/
   * recipient doesn't end up with a vanilla send tagged as a swap-
   * deposit in Activity. Optional; absence means "no seed → no
   * cross-check needed".
   */
  pendingContextSeed?: {
    fromAssetId?: string;
    toAddress?: string;
  };
}

export type SendSubmitResult =
  | {
      ok: true;
      txid: string;
      /**
       * Atomic-unit amount sent to recipient. Optional for backward
       * compat (the wizard core doesn't use it). The popup uses it
       * when present to write a pendingOutgoing entry for instant
       * post-send balance feedback.
       */
      amountAtomic?: bigint;
      /** Atomic-unit fee paid. Same optional semantics as amountAtomic. */
      feeAtomic?: bigint;
      /**
       * Sum of input atomic amounts consumed by this tx. Lets the
       * popup compute the expected locked change (inputsTotal −
       * amount − fee) for CryptoNote/Grin during the in-flight
       * window, displayed as a `🔒 X.XX locked` preview until LWS
       * reflects the actual change output.
       */
      inputsTotalAtomic?: bigint;
      /**
       * Chain-appropriate identifiers of the inputs this tx spent.
       * Used by the popup to populate `pendingOutgoing.inputs` so a
       * subsequent send can exclude them from selection (preventing
       * mempool double-spend) and so balance refresh can reconcile
       * the entry as soon as the network reflects the spend. Format
       * matches `PendingOutgoingTx.inputs` in `@smirk/core`.
       */
      inputs?: string[];
    }
  | { ok: false; error: string };

/**
 * Fee rates in **sat/vB** (or asset-equivalent atomic-per-vbyte). The
 * Compose screen renders one row per tier; null means "not available".
 */
export interface FeeTiers {
  fast: number | null;
  normal: number | null;
  slow: number | null;
}

export interface SendWizardProps {
  assetIds: string[];

  /**
   * Validate an address for the chosen asset. Return `null` if valid,
   * or a short human-readable error if not. Async OK.
   */
  validateAddress: (assetId: string, address: string) => string | null | Promise<string | null>;

  /**
   * Convert the user-entered decimal string into atomic units for the
   * chosen asset. Returns `null` if unparseable.
   */
  parseAmount: (assetId: string, amountText: string) => bigint | null;

  /**
   * Read the wallet's current confirmed balance for `assetId` in atomic
   * units. Synchronous: popup-side pulls from session state.
   */
  resolveBalance: (assetId: string) => bigint;

  /**
   * Fetch live fee tiers (sat/vB) for `assetId`. Called by Compose on
   * mount. UI shows a spinner / "—" until this resolves.
   */
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>;

  /**
   * Estimate the network fee in atomic units for one send of `assetId`.
   * Used by Compose to preview the fee for assets that don't have a
   * user-tunable fee picker (XMR/WOW/Grin).
   *
   * `options.sweep` lets the caller request a fee for "sweep N inputs"
   * vs the default "1-input typical" estimate: sweep TXs with many
   * inputs run noticeably larger and the fee scales linearly, so a
   * 1-input estimate underestimates by a significant margin for users
   * with fragmented balances. The shell looks up the actual spendable
   * output count from LWS / Electrum and feeds it in.
   *
   * Return `null` if the asset uses the picker tiers instead, or if
   * the estimate isn't available yet.
   */
  resolveSendFeeEstimate?: (
    assetId: string,
    options?: { sweep?: boolean; amountAtomic?: bigint },
  ) => Promise<bigint | null>;

  /**
   * Build, sign, and broadcast. Wizard advances to "done" on success.
   * `sweep: true` → 1-output tx, `amountAtomic` is the final recipient
   * amount the Compose screen computed (= balance − fee).
   */
  onSubmit: (fields: {
    fromAssetId: string;
    amountAtomic: bigint;
    toAddress: string;
    feeRateSatPerVb: number;
    sweep: boolean;
  }) => Promise<SendSubmitResult>;

  /**
   * Grin: build the sender's S1 slate. Lock outputs on backend,
   * record the pending tx, optionally drop the slatepack at the
   * Smirk relay if the recipient is also a Smirk user. Returns the
   * armored S1 slatepack the user shares with the recipient + the
   * sender context the wizard persists for finalize.
   *
   * Only called when the chosen asset's family is `mimblewimble`.
   * Other asset families use the one-shot `onSubmit` path.
   */
  onGrinBuildSlate?: (args: {
    amountAtomic: bigint;
    toAddress: string;
  }) => Promise<GrinBuildSlateOutcome>;

  /**
   * Grin: receiver returned S2; finalize and broadcast. Spends
   * inputs server-side, marks tx finalized, stamps the kernel
   * excess. Returns the slate id (used as Grin's "txid") + the
   * on-chain kernel commitment.
   */
  onGrinFinalize?: (args: {
    s2: string;
    senderContextJson: string;
    senderInputsJson: string;
    changeOutputJson: string | undefined;
    relayId: string | undefined;
  }) => Promise<GrinFinalizeOutcome>;

  /**
   * Grin: user-cancel mid-exchange. Unlocks outputs on backend,
   * deletes relay entry if any, marks tx cancelled.
   */
  onGrinCancel?: (args: {
    slateId: string;
    relayId: string | undefined;
  }) => Promise<void>;

  onExit: () => void;
  resolveIcon?: (iconKey: string) => string | undefined;
  class?: string;
}

export interface GrinBuildSlateResult {
  ok: true;
  slate_id: string;
  /** Armored slatepack to display to the user. */
  armored: string;
  /** Opaque JSON the wizard persists for the finalize step. */
  sender_context_json: string;
  /** Serialized GrinUnspentOutput[]. */
  sender_inputs_json: string;
  /** Serialized GrinChangeOutputInfo. Omitted/empty when no change. */
  change_output_json?: string;
  /** Backend relay id, set whenever the slatepack was posted to the
   *  Smirk relay. The relay accepts any well-formed slatepack; whether
   *  the recipient (a registered Smirk user vs. an external wallet)
   *  picks it up is independent of this id existing. */
  relay_id?: string;
  /** Actual fee committed to in the S1 slate, in atomic units. The
   *  Compose-step preview is an estimate; this is the real number
   *  the receiver will see, exposed so the Share-slatepack view can
   *  confirm "you're about to send X with fee Y" before the sender
   *  hands the slatepack to the counterparty. */
  fee_atomic?: number;
}
export type GrinBuildSlateOutcome = GrinBuildSlateResult | { ok: false; error: string };

export interface GrinFinalizeResult {
  ok: true;
  slate_id: string;
  /** 33-byte kernel commitment hex: Grin's analog of a txid. */
  kernel_excess_hex: string;
}
export type GrinFinalizeOutcome = GrinFinalizeResult | { ok: false; error: string };

const WIZARD_ID = 'send';
const TOTAL_STEPS = 4; // 0=asset 1=address 2=compose 3=review (success at step >=4)

export function SendWizard(props: SendWizardProps) {
  const wizard = useWizard<SendFields>(WIZARD_ID, {});
  const fields = wizard.fields;

  // Start the wizard once on mount. eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!wizard.active) void wizard.start();
  }, []);

  if (!wizard.active) {
    return <FullPageStatus>Loading…</FullPageStatus>;
  }

  const step = wizard.step;

  if (step >= TOTAL_STEPS) {
    return (
      <DoneStep
        {...(fields.lastTxid ? { txid: fields.lastTxid } : {})}
        {...(fields.fromAssetId ? { assetId: fields.fromAssetId } : {})}
        onClose={() => void exit(wizard, props.onExit)}
      />
    );
  }

  return (
    <div class={props.class} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Header
        step={step}
        totalSteps={TOTAL_STEPS}
        onCancel={() => void exit(wizard, props.onExit)}
        {...(step > 0 ? { onBack: () => void wizard.back() } : {})}
      />

      {step === 0 && (
        <PickAsset
          assetIds={props.assetIds}
          {...(fields.fromAssetId ? { selected: fields.fromAssetId } : {})}
          {...(props.resolveIcon ? { resolveIcon: props.resolveIcon } : {})}
          onPick={async (id) => {
            await wizard.setField('fromAssetId', id);
            await wizard.next();
          }}
        />
      )}

      {step === 1 && fields.fromAssetId && (
        <EnterAddress
          assetId={fields.fromAssetId}
          {...(fields.toAddress ? { initial: fields.toAddress } : {})}
          validateAddress={props.validateAddress}
          onContinue={async (addr) => {
            await wizard.setField('toAddress', addr);
            await wizard.next();
          }}
        />
      )}

      {step === 2 && fields.fromAssetId && fields.toAddress !== undefined && (
        <Compose
          assetId={fields.fromAssetId}
          toAddress={fields.toAddress}
          initialAmountText={fields.amountText ?? ''}
          initialTier={fields.feeTier ?? 'normal'}
          initialCustomRate={fields.customFeeRate}
          initialSweep={fields.sweep ?? false}
          parseAmount={props.parseAmount}
          resolveBalance={props.resolveBalance}
          resolveFeeRates={props.resolveFeeRates}
          {...(props.resolveSendFeeEstimate
            ? { resolveSendFeeEstimate: props.resolveSendFeeEstimate }
            : {})}
          onChange={(state) => {
            // Persist on every edit so closing the popup mid-Compose
            // doesn't lose what was typed. Re-mount reads from the same
            // wizard.fields keys via the `initial*` props.
            void wizard.patchFields({
              amountText: state.amountText,
              feeTier: state.tier,
              ...(state.customRate !== undefined ? { customFeeRate: state.customRate } : {}),
              sweep: state.sweep,
            });
          }}
          onContinue={async (state) => {
            await wizard.patchFields({
              amountText: state.amountText,
              feeTier: state.tier,
              ...(state.customRate !== undefined ? { customFeeRate: state.customRate } : {}),
              sweep: state.sweep,
            });
            await wizard.next();
          }}
        />
      )}

      {step === 3 &&
        fields.fromAssetId &&
        fields.toAddress !== undefined &&
        fields.amountText !== undefined &&
        fields.feeTier &&
        mustGetAsset(fields.fromAssetId).family.family !== 'mimblewimble' && (
          <Review
            assetId={fields.fromAssetId}
            amountText={fields.amountText}
            toAddress={fields.toAddress}
            feeTier={fields.feeTier}
            customFeeRate={fields.customFeeRate}
            sweep={fields.sweep ?? false}
            parseAmount={props.parseAmount}
            resolveFeeRates={props.resolveFeeRates}
            {...(props.resolveSendFeeEstimate
              ? { resolveSendFeeEstimate: props.resolveSendFeeEstimate }
              : {})}
            onSubmit={async ({ amountAtomic, feeRateSatPerVb }) => {
              const result = await props.onSubmit({
                fromAssetId: fields.fromAssetId!,
                amountAtomic,
                toAddress: fields.toAddress!,
                feeRateSatPerVb,
                sweep: fields.sweep ?? false,
              });
              if (result.ok) {
                await wizard.patchFields({ lastTxid: result.txid });
                await wizard.goToStep(TOTAL_STEPS);
              }
              return result;
            }}
          />
        )}

      {/* Step 3, Grin: interactive Exchange step instead of one-shot Review.
          Sender already chose amount + recipient. We build S1, show it to
          the user (clipboard / relay drop), wait for the recipient's S2,
          then finalize + broadcast. State persists in wizard.fields so a
          popup-close mid-flow recovers when the user comes back. */}
      {step === 3 &&
        fields.fromAssetId &&
        fields.toAddress !== undefined &&
        fields.amountText !== undefined &&
        mustGetAsset(fields.fromAssetId).family.family === 'mimblewimble' && (
          <GrinExchange
            assetId={fields.fromAssetId}
            toAddress={fields.toAddress}
            amountText={fields.amountText}
            parseAmount={props.parseAmount}
            {...(fields.grinArmoredOutgoing ? { armoredOutgoing: fields.grinArmoredOutgoing } : {})}
            {...(fields.grinSenderContextJson ? { senderContextJson: fields.grinSenderContextJson } : {})}
            {...(fields.grinSlateId ? { slateId: fields.grinSlateId } : {})}
            {...(fields.grinRelayId ? { relayId: fields.grinRelayId } : {})}
            {...(fields.grinSenderInputsJson ? { senderInputsJson: fields.grinSenderInputsJson } : {})}
            {...(fields.grinChangeOutputJson ? { changeOutputJson: fields.grinChangeOutputJson } : {})}
            {...(fields.grinExchangeError ? { error: fields.grinExchangeError } : {})}
            {...(fields.grinPastedS2 ? { pastedS2: fields.grinPastedS2 } : {})}
            {...(typeof fields.grinFeeAtomic === 'number'
              ? { feeAtomic: BigInt(fields.grinFeeAtomic) }
              : {})}
            onBuild={async ({ amountAtomic, toAddress }) => {
              if (!props.onGrinBuildSlate) {
                return {
                  ok: false,
                  error: 'Grin send unavailable: no onGrinBuildSlate callback wired',
                };
              }
              const result = await props.onGrinBuildSlate({ amountAtomic, toAddress });
              if (result.ok) {
                await wizard.patchFields({
                  grinArmoredOutgoing: result.armored,
                  grinSenderContextJson: result.sender_context_json,
                  grinSlateId: result.slate_id,
                  grinSenderInputsJson: result.sender_inputs_json,
                  ...(result.change_output_json
                    ? { grinChangeOutputJson: result.change_output_json }
                    : {}),
                  ...(result.relay_id ? { grinRelayId: result.relay_id } : {}),
                  ...(result.fee_atomic !== undefined
                    ? { grinFeeAtomic: result.fee_atomic }
                    : {}),
                  grinExchangeError: '',
                });
              } else {
                await wizard.patchFields({ grinExchangeError: result.error });
              }
              return result;
            }}
            onFinalize={async ({ s2 }) => {
              if (!props.onGrinFinalize) {
                return {
                  ok: false,
                  error: 'Grin finalize unavailable: no onGrinFinalize callback wired',
                };
              }
              if (!fields.grinSenderContextJson || !fields.grinSenderInputsJson) {
                return {
                  ok: false,
                  error: 'Missing sender state — was the wizard reset mid-flow?',
                };
              }
              const result = await props.onGrinFinalize({
                s2,
                senderContextJson: fields.grinSenderContextJson,
                senderInputsJson: fields.grinSenderInputsJson,
                changeOutputJson: fields.grinChangeOutputJson,
                relayId: fields.grinRelayId,
              });
              if (result.ok) {
                // Use kernel_excess as the on-chain identifier shown on
                // the Done step. Grin block explorers index by kernel.
                await wizard.patchFields({
                  lastTxid: result.kernel_excess_hex,
                  grinExchangeError: '',
                });
                await wizard.goToStep(TOTAL_STEPS);
              } else {
                await wizard.patchFields({ grinExchangeError: result.error });
              }
              return result;
            }}
            onCancel={async () => {
              if (props.onGrinCancel && fields.grinSlateId) {
                await props.onGrinCancel({
                  slateId: fields.grinSlateId,
                  relayId: fields.grinRelayId,
                });
              }
              // Clear the Grin-specific persisted state before exiting.
              await wizard.patchFields({
                grinArmoredOutgoing: '',
                grinSenderContextJson: '',
                grinSlateId: '',
                grinRelayId: '',
                grinSenderInputsJson: '',
                grinChangeOutputJson: '',
                grinExchangeError: '',
              });
              await exit(wizard, props.onExit);
            }}
          />
        )}
    </div>
  );
}

// ============================================================================
// Step 0: Pick asset
// ============================================================================

function PickAsset({
  assetIds,
  selected,
  onPick,
  resolveIcon,
}: {
  assetIds: string[];
  selected?: string;
  onPick: (assetId: string) => void;
  resolveIcon?: (iconKey: string) => string | undefined;
}) {
  return (
    <div>
      <StepTitle>Send what?</StepTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {assetIds.map((id) => {
          const asset = mustGetAsset(id);
          const active = selected === id;
          return (
            <button
              key={id}
              data-testid={`send-asset-${id}`}
              onClick={() => onPick(id)}
              style={rowButtonStyle(active)}
            >
              <AssetIcon assetId={id} size={32} {...(resolveIcon ? { resolveIcon } : {})} />
              <span style={{ marginLeft: 12, flex: 1, textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{asset.ticker}</div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{asset.displayName}</div>
              </span>
              <span style={{ fontSize: 18, opacity: 0.4 }}>›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Step 1: Recipient address
// ============================================================================

function EnterAddress({
  assetId,
  initial,
  validateAddress,
  onContinue,
}: {
  assetId: string;
  initial?: string;
  validateAddress: (assetId: string, addr: string) => string | null | Promise<string | null>;
  onContinue: (addr: string) => void;
}) {
  const asset = mustGetAsset(assetId);
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  // Grin supports a no-address "manual slatepack" mode: sender builds
  // the S1, hands the armored blob to the receiver out-of-band (any
  // grin-wallet / Grim user can decode + sign it). For other chains
  // address is always required; toggle is hidden.
  const supportsManualSlatepack = assetId === 'grin';
  const [manualSlatepack, setManualSlatepack] = useState(false);

  const handleContinue = async () => {
    if (manualSlatepack) {
      // Skip validation: emit empty string. Downstream handler treats
      // empty `toAddress` as "no recipient address; armor plain + skip
      // relay drop".
      onContinue('');
      return;
    }
    setValidating(true);
    setError(null);
    const result = await validateAddress(assetId, text.trim());
    setValidating(false);
    if (result === null) {
      onContinue(text.trim());
    } else {
      setError(result);
    }
  };

  return (
    <div>
      <StepTitle>Where to?</StepTitle>
      {supportsManualSlatepack && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 8,
            background: 'var(--smirk-bg-sunken)',
            padding: 2,
            borderRadius: 'var(--smirk-radius, 8px)',
          }}
        >
          <button
            type="button"
            onClick={() => setManualSlatepack(false)}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 11,
              border: 'none',
              borderRadius: 'var(--smirk-radius, 6px)',
              cursor: 'pointer',
              background: !manualSlatepack ? 'var(--smirk-accent)' : 'transparent',
              color: !manualSlatepack ? 'var(--smirk-bg)' : 'var(--smirk-fg)',
              fontFamily: 'var(--smirk-font-family-mono)',
              fontWeight: !manualSlatepack ? 700 : 400,
            }}
          >
            Address
          </button>
          <button
            type="button"
            onClick={() => setManualSlatepack(true)}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 11,
              border: 'none',
              borderRadius: 'var(--smirk-radius, 6px)',
              cursor: 'pointer',
              background: manualSlatepack ? 'var(--smirk-accent)' : 'transparent',
              color: manualSlatepack ? 'var(--smirk-bg)' : 'var(--smirk-fg)',
              fontFamily: 'var(--smirk-font-family-mono)',
              fontWeight: manualSlatepack ? 700 : 400,
            }}
          >
            Slatepack only
          </button>
        </div>
      )}
      {manualSlatepack ? (
        <div
          style={{
            padding: '8px 10px',
            fontSize: 11,
            background: 'var(--smirk-bg-sunken)',
            borderRadius: 'var(--smirk-radius, 8px)',
            color: 'var(--smirk-fg-muted)',
            lineHeight: 1.5,
          }}
        >
          You'll get an armored slatepack to copy + paste to the
          recipient out-of-band. They'll send back a signed slatepack
          which you'll paste on the next step to finalize.
        </div>
      ) : (
        <textarea
          data-testid="send-address-input"
          value={text}
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            setError(null);
          }}
          placeholder={`${asset.displayName} address`}
          // 5 rows so 95-char cryptonote addresses fit without scrolling
          // even in pixel themes (DMG, Workbench) where Press Start 2P
          // wraps to ~25 chars per row.
          rows={5}
          autoFocus
          style={textareaStyle}
        />
      )}
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton
        testid="send-address-continue"
        disabled={(!manualSlatepack && !text.trim()) || validating}
        onClick={handleContinue}
      >
        {validating ? 'Validating…' : 'Continue'}
      </PrimaryButton>
    </div>
  );
}

// ============================================================================
// Step 2: Compose (amount + Max + fee tier)
// ============================================================================

/**
 * Vsize estimator for fee preview. Mirrors `estimateVsize` in
 * `packages/extension/src/popup/send-handler.ts`. We assume 1 input:
 * the typical case for Smirk's single-address scheme. The real
 * selection in the send-handler uses the actual input count; for the
 * Compose-screen fee preview, 1-input is a reasonable estimate.
 *
 * sweep mode → 1 output (no change), non-sweep → 2 outputs.
 */
function estimateVsize(numOutputs: number): number {
  return 1 * 68 + numOutputs * 31 + 10;
}

/**
 * Network-relay floor for the standard fee tiers (Fast/Normal/Slow).
 * Now sourced from `@smirk/core` (`applyRelayFloor`) so every BTC/LTC
 * broadcast path (wizard, tip funding, tip-claim sweep, dapp) shares
 * one floor; see that module for the full rationale (1.0 sat/vB at the
 * relay minimum is rejected by public LTC Electrum servers).
 *
 * **Does NOT apply to the Custom tier.** Custom is the explicit-knob;
 * if a user types 0.5 deliberately, they get 0.5.
 */
const applyFloor = applyRelayFloor;

/**
 * Compute fee in atomic units for a tier rate.
 *
 * For BTC/LTC: rate is sat/vB, vsize is vbytes → fee = ceil(vsize × rate).
 * XMR/WOW/Grin never reach this estimator: `usesFeePicker` is UTXO-only,
 * and their fee comes from `resolveSendFeeEstimate` and the send-handler
 * at sign time.
 */
function feeForTier(ratePerVb: number, sweep: boolean): number {
  return Math.ceil(estimateVsize(sweep ? 1 : 2) * ratePerVb);
}

function Compose({
  assetId,
  toAddress,
  initialAmountText,
  initialTier,
  initialCustomRate,
  initialSweep,
  parseAmount,
  resolveBalance,
  resolveFeeRates,
  resolveSendFeeEstimate,
  onChange,
  onContinue,
}: {
  assetId: string;
  toAddress: string;
  initialAmountText: string;
  initialTier: FeeTier;
  initialCustomRate: number | undefined;
  initialSweep: boolean;
  parseAmount: (assetId: string, text: string) => bigint | null;
  resolveBalance: (assetId: string) => bigint;
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>;
  resolveSendFeeEstimate?: (
    assetId: string,
    options?: { sweep?: boolean; amountAtomic?: bigint },
  ) => Promise<bigint | null>;
  /**
   * Fires on every state change (amount text, fee tier, custom rate,
   * sweep toggle). Parent uses this to persist Compose state into
   * `wizard.fields` so popup-close + reopen restores what was typed.
   */
  onChange: (state: {
    amountText: string;
    tier: FeeTier;
    customRate: number | undefined;
    sweep: boolean;
  }) => void;
  onContinue: (state: {
    amountText: string;
    tier: FeeTier;
    customRate: number | undefined;
    sweep: boolean;
  }) => void;
}) {
  const asset = mustGetAsset(assetId);
  const balanceAtomic = resolveBalance(assetId);
  // UTXO chains (BTC/LTC) let the user pick a fee tier; CryptoNote
  // (XMR/WOW) and Mimblewimble (Grin) take the fee from the network /
  // wallet logic and don't surface a picker.
  const usesFeePicker = asset.family.family === 'utxo';
  const [amountText, setAmountText] = useState(initialAmountText);
  const [tier, setTier] = useState<FeeTier>(initialTier);
  const [customRateText, setCustomRateText] = useState<string>(
    initialCustomRate !== undefined ? String(initialCustomRate) : '',
  );
  // Sweep needs a knowable fee (so we can compute balance − fee).
  //  - UTXO: selectedFeeSat from the tier picker.
  //  - CryptoNote (XMR/WOW): estimatedFeeAtomic from
  //    resolveSendFeeEstimate; the handler honors `sweep: true` and
  //    consumes every spendable output, paying (sum − real_fee) to
  //    the recipient.
  //  - Mimblewimble (Grin): handler doesn't yet support sweep, so we
  //    suppress the toggle below until that lands.
  const sweepSupported = usesFeePicker || asset.family.family === 'cryptonote';
  const [sweep, setSweep] = useState(sweepSupported ? initialSweep : false);
  const [tiers, setTiers] = useState<FeeTiers | null>(null);
  const [tiersError, setTiersError] = useState<string | null>(null);
  // For non-picker assets: live fee estimate fetched on mount via the
  // shell-supplied callback. `null` = no callback wired or still
  // loading; otherwise a bigint atomic-units estimate.
  const [estimatedFeeAtomic, setEstimatedFeeAtomic] = useState<bigint | null>(null);

  // Persist Compose state to wizard.fields on every change so the
  // popup-close + reopen path restores exactly what was typed.
  // Otherwise the React-local state above is destroyed on unmount and
  // the user re-mounts to an empty Compose screen.
  const parsedCustom = parseFloat(customRateText);
  const customForPersist =
    !isNaN(parsedCustom) && parsedCustom > 0 && customRateText.trim() !== ''
      ? parsedCustom
      : undefined;
  useEffect(() => {
    onChange({ amountText, tier, customRate: customForPersist, sweep });
    // We want this to fire on every state change, but not when
    // `onChange` itself re-instantiates (parent re-render). Depending
    // on the closed-over values keeps the effect cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, tier, customForPersist, sweep]);

  // Load fee tiers on mount. Skip for non-UTXO assets: their fees
  // come from the send-handler at sign-time, not a Compose-screen
  // picker.
  useEffect(() => {
    if (!usesFeePicker) return;
    let alive = true;
    setTiers(null);
    setTiersError(null);
    resolveFeeRates(assetId).then(
      (t) => {
        if (alive) setTiers(t);
      },
      (e) => {
        if (alive) setTiersError(e instanceof Error ? e.message : 'Failed to load fee rates');
      },
    );
    return () => {
      alive = false;
    };
  }, [assetId, resolveFeeRates, usesFeePicker]);

  // For non-picker assets, fetch a live fee estimate via the shell
  // callback (popup hits LWS per_byte_fee + wasm.estimate_fee). For
  // normal sends we use the 1-input estimate (typical case for
  // Smirk's single-address scheme). For sweep mode we pass
  // `{ sweep: true }` so the shell sizes the estimate against the
  // user's actual spendable-output count; wallets with fragmented
  // balances would otherwise display a sweep amount that's larger
  // than what they actually receive after the per-input fee scaling.
  // Re-runs when `sweep` toggles so the displayed amount tracks the
  // actual fee that will get applied.
  // Re-run on amount change so the resolver can size the estimate
  // against the actual amount (Grin needs real input count, which is a
  // function of the entered amount). Until the user has typed a parseable
  // non-zero amount, leave the estimate null so the UI shows nothing;
  // previously we showed a phantom 1-input estimate before the user had
  // entered anything, which was misleading on inputs ≠ 1.
  const parsedAmountForEstimate = useMemo(
    () => parseAmount(assetId, amountText),
    [assetId, amountText, parseAmount],
  );
  useEffect(() => {
    if (usesFeePicker || !resolveSendFeeEstimate) return;
    let alive = true;
    setEstimatedFeeAtomic(null);
    // Don't ask the resolver for an estimate when there's nothing to
    // estimate against. Sweep is a special case: it's "pay whatever
    // is spendable" and the resolver can size against full balance.
    if (!sweep && (parsedAmountForEstimate === null || parsedAmountForEstimate <= 0n)) {
      return;
    }
    const opts: { sweep?: boolean; amountAtomic?: bigint } = { sweep };
    if (parsedAmountForEstimate !== null && parsedAmountForEstimate > 0n) {
      opts.amountAtomic = parsedAmountForEstimate;
    }
    resolveSendFeeEstimate(assetId, opts).then(
      (fee) => {
        if (alive && fee !== null) setEstimatedFeeAtomic(fee);
      },
      () => {
        // Swallow estimate failures: fall back to the generic
        // "computed at send time" copy below. A failed estimate
        // shouldn't block the user from continuing.
      },
    );
    return () => {
      alive = false;
    };
  }, [assetId, usesFeePicker, resolveSendFeeEstimate, sweep, parsedAmountForEstimate]);

  // Selected rate for the standard tiers passes through `applyFloor` so
  // we never ship a rate at the protocol minimum that some nodes round
  // up against. Custom is verbatim: explicit override.
  const customRateNum = parseFloat(customRateText);
  const customRateValid =
    !isNaN(customRateNum) && customRateNum > 0 && customRateText.trim() !== '';
  const electrumRate: number | null = tier === 'custom' ? null : (tiers?.[tier] ?? null);
  const selectedRate: number | null =
    tier === 'custom'
      ? customRateValid
        ? customRateNum
        : null
      : electrumRate !== null
        ? applyFloor(electrumRate)
        : null;
  const selectedFeeSat =
    selectedRate !== null ? feeForTier(selectedRate, sweep) : null;

  // In sweep mode, amount is implicit: balance − fee.
  //  - UTXO: fee comes from the user-picked tier (selectedFeeSat).
  //  - Non-UTXO (XMR/WOW): fee comes from the live estimate we
  //    fetched via resolveSendFeeEstimate. The estimate is for 1
  //    input but the actual sweep may consume more; the handler
  //    recomputes against real N and pays the difference out of the
  //    sweep amount, so the user receives slightly less than the
  //    preview if their wallet has many small outputs. Honest
  //    framing: it's "approximately your balance", not "exactly".
  const sweepFee = usesFeePicker
    ? selectedFeeSat !== null
      ? BigInt(selectedFeeSat)
      : null
    : estimatedFeeAtomic;
  const sweepAmountAtomic =
    sweep && sweepFee !== null && balanceAtomic > sweepFee
      ? balanceAtomic - sweepFee
      : null;

  // Effective amount the user is trying to send (atomic):
  //  - sweep mode: balance − fee
  //  - manual mode: parseAmount(input)
  const effectiveAtomic = sweep
    ? sweepAmountAtomic
    : amountText
      ? parseAmount(assetId, amountText)
      : null;

  // Validation: insufficient funds if amount + fee > balance.
  let validationError: string | null = null;
  if (effectiveAtomic === null && !sweep && amountText.trim() !== '') {
    validationError = 'Invalid amount';
  } else if (effectiveAtomic !== null && effectiveAtomic <= 0n) {
    validationError = sweep
      ? 'Balance too low to cover fee at this tier'
      : 'Amount must be positive';
  } else if (
    !sweep &&
    effectiveAtomic !== null &&
    selectedFeeSat !== null &&
    effectiveAtomic + BigInt(selectedFeeSat) > balanceAtomic
  ) {
    validationError = 'Insufficient funds (amount + fee exceeds balance)';
  } else if (
    !usesFeePicker &&
    effectiveAtomic !== null &&
    effectiveAtomic > balanceAtomic
  ) {
    // For non-UTXO chains we don't know the fee at Compose time; the
    // handler computes it. The picker-floor check above is skipped, so
    // do a coarse `amount > balance` check here. The handler will still
    // return a precise "Insufficient funds: have X need amount + fee"
    // if the fee pushes us over.
    validationError = 'Insufficient funds';
  }

  // For UTXO assets, gate Continue on a picked fee. For others, the
  // fee is computed at sign-time, so amount-only validation is enough.
  const canContinue = usesFeePicker
    ? selectedFeeSat !== null && effectiveAtomic !== null && effectiveAtomic > 0n && !validationError
    : effectiveAtomic !== null && effectiveAtomic > 0n && !validationError;

  const totalAtomic =
    effectiveAtomic !== null && selectedFeeSat !== null
      ? sweep
        ? effectiveAtomic + BigInt(selectedFeeSat) // = balance
        : effectiveAtomic + BigInt(selectedFeeSat)
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
        Send {asset.ticker}
      </h2>

      {/* Balance line */}
      <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
        Balance: <strong>{formatAmount(balanceAtomic, assetId, 8)}</strong> {asset.ticker}
      </div>

      {/* Amount field + Max. Max only renders for UTXO chains: for
          CryptoNote/Mimblewimble we don't know the fee at compose
          time so sweep is deferred to a Phase-2 handler. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <input
          data-testid="send-amount-input"
          type="text"
          inputMode="decimal"
          value={
            sweep && sweepAmountAtomic !== null && sweepAmountAtomic > 0n
              ? formatAmount(sweepAmountAtomic, assetId, 8)
              : amountText
          }
          onInput={(e) => {
            if (!sweep) setAmountText((e.target as HTMLInputElement).value);
          }}
          placeholder={`0.00 ${asset.ticker}`}
          disabled={sweep}
          style={{
            ...amountInputStyle,
            opacity: sweep ? 0.7 : 1,
            cursor: sweep ? 'not-allowed' : 'text',
          }}
        />
        {sweepSupported && (
          <button
            data-testid="send-max-button"
            onClick={() => setSweep((s) => !s)}
            aria-pressed={sweep}
            style={{
              ...maxButtonStyle,
              background: sweep
                ? 'color-mix(in srgb, var(--smirk-accent) 30%, var(--smirk-bg-elevated))'
                : 'var(--smirk-bg-elevated)',
              color: sweep ? 'var(--smirk-accent)' : 'var(--smirk-fg)',
            }}
          >
            MAX
          </button>
        )}
      </div>

      {validationError && <FieldError>{validationError}</FieldError>}

      {/* Recipient: read-only here, tap to edit goes back. Empty
          string is the Grin "manual slatepack" sentinel; show a
          label instead of an empty value. */}
      <ReviewRow
        label="To"
        value={toAddress ? truncateMiddle(toAddress, 24) : '— slatepack only —'}
        mono
        small
      />

      {/* Fee tier picker (UTXO chains only) */}
      {usesFeePicker && <div style={{ marginTop: 4 }}>
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Network fee
        </div>
        {tiersError && <FieldError>Fee estimate failed: {tiersError}</FieldError>}
        {!tiers && !tiersError && (
          <div style={{ fontSize: 11, opacity: 0.5, padding: '4px 0' }}>Loading fee rates…</div>
        )}
        {tiers && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {(['fast', 'normal', 'slow'] as const).map((t) => {
              const electrum = tiers[t];
              // Display the floored rate: it's what the tx will use.
              const displayRate =
                electrum !== null && electrum !== undefined ? applyFloor(electrum) : null;
              const active = tier === t;
              const fee = displayRate !== null ? feeForTier(displayRate, sweep) : null;
              return (
                <button
                  key={t}
                  data-testid={`send-fee-tier-${t}`}
                  onClick={() => setTier(t)}
                  disabled={displayRate === null}
                  aria-pressed={active}
                  style={tierRowStyle(active, displayRate === null)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <RadioDot active={active} />
                    <span style={{ fontWeight: 500, textTransform: 'capitalize', fontSize: 12 }}>{t}</span>
                  </span>
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{tierEta(t)}</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--smirk-font-family-mono)' }}>
                    {displayRate !== null
                      ? `${displayRate.toFixed(1)} sat/vB · ${fee !== null ? formatFeeShort(fee, asset) : '—'}`
                      : '—'}
                  </span>
                </button>
              );
            })}

            {/* Custom tier: user-controlled rate. Useful when the
                network is calm and Electrum collapses fast/normal/slow
                to the same value (often 1.0 sat/vB), which lands at
                some nodes' minrelay edge and gets rejected. */}
            <button
              onClick={() => setTier('custom')}
              aria-pressed={tier === 'custom'}
              style={tierRowStyle(tier === 'custom', false)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RadioDot active={tier === 'custom'} />
                <span style={{ fontWeight: 500, fontSize: 12 }}>Custom</span>
              </span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>sat/vB</span>
              <input
                data-testid="send-custom-fee-rate-input"
                type="number"
                min="0"
                step="0.1"
                value={customRateText}
                onInput={(e) => {
                  setCustomRateText((e.target as HTMLInputElement).value);
                  setTier('custom');
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder="2.0"
                style={customRateInputStyle}
              />
            </button>
            {tier === 'custom' && !customRateValid && (
              <FieldError>Enter a positive number for the custom fee rate.</FieldError>
            )}
          </div>
        )}
      </div>}

      {/* Fee preview: only render once we have a real number. Before
          the user has entered an amount the estimate is null (the
          shell can't size against zero inputs); rendering a phantom
          placeholder there is misleading on assets where input count
          actually changes the fee (Grin: each extra input adds
          500_000 nanogrin). */}
      {!usesFeePicker && estimatedFeeAtomic !== null && (
        <div
          style={{
            marginTop: 4,
            padding: '6px 10px',
            background: 'var(--smirk-bg-sunken)',
            borderRadius: 'var(--smirk-radius, 8px)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--smirk-fg-muted)' }}>Network fee (est.)</span>
          <strong style={{ fontFamily: 'var(--smirk-font-family-mono)' }}>
            {`${formatAmount(estimatedFeeAtomic, assetId, 8)} ${asset.ticker}`}
          </strong>
        </div>
      )}

      {/* Total. For non-picker assets we don't know the fee yet, so the
          "amount + fee" total row is suppressed; the Review screen will
          display the final fee once the handler has computed it. */}
      {usesFeePicker && (
        <div
          style={{
            marginTop: 4,
            padding: '6px 10px',
            background: 'var(--smirk-bg-sunken)',
            borderRadius: 'var(--smirk-radius, 8px)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--smirk-fg-muted)' }}>Total (amount + fee)</span>
          <strong style={{ fontFamily: 'var(--smirk-font-family-mono)' }}>
            {totalAtomic !== null ? formatAmount(totalAtomic, assetId, 8) : '—'} {asset.ticker}
          </strong>
        </div>
      )}

      <div style={{ marginTop: 4 }}>
        <Button
          testid="send-compose-continue"
          onClick={() =>
            onContinue({
              amountText,
              tier,
              customRate: tier === 'custom' && customRateValid ? customRateNum : undefined,
              sweep,
            })
          }
          {...(!canContinue ? { disabled: true } : {})}
        >
          {asset.family.family === 'mimblewimble'
            ? 'Continue to slatepack'
            : 'Continue to review'}
        </Button>
      </div>
    </div>
  );
}

function tierEta(tier: 'fast' | 'normal' | 'slow'): string {
  if (tier === 'fast') return '~5 min';
  if (tier === 'normal') return '~15 min';
  return '~30 min';
}

/**
 * Short fee display: `120 lits` for small fees, `0.005 LTC` once the
 * fee is large enough that coin units read naturally. Always labeled so
 * a glance at the tier picker tells the user both rate + absolute fee
 * with units (e.g. `1.1 sat/vB · 120 lits`).
 *
 * Per-asset atomic-unit names are hardcoded here for BTC/LTC; they
 * belong in the `@smirk/assets` registry alongside decimals.
 */
function formatFeeShort(atomicFee: number, asset: AssetDefinition): string {
  // Threshold: switch from atomic units to coin units when the fee
  // would be more than `cap` of a coin (0.001).
  const cutoff = 10 ** (asset.decimals - 3);
  if (atomicFee < cutoff) {
    return `${atomicFee} ${atomicUnitName(asset)}`;
  }
  return formatAmountWithAsset(BigInt(atomicFee), asset, 8);
}

function atomicUnitName(asset: AssetDefinition): string {
  switch (asset.id) {
    case 'btc':
      return 'sat';
    case 'ltc':
      return 'lits';
    default:
      return 'atomic';
  }
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

// ============================================================================
// Step 3: Review (read-only confirm)
// ============================================================================

function Review({
  assetId,
  amountText,
  toAddress,
  feeTier,
  customFeeRate,
  sweep,
  parseAmount,
  resolveFeeRates,
  resolveSendFeeEstimate,
  onSubmit,
}: {
  assetId: string;
  amountText: string;
  toAddress: string;
  feeTier: FeeTier;
  customFeeRate: number | undefined;
  sweep: boolean;
  parseAmount: (assetId: string, text: string) => bigint | null;
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>;
  resolveSendFeeEstimate?: (
    assetId: string,
    options?: { sweep?: boolean },
  ) => Promise<bigint | null>;
  onSubmit: (args: { amountAtomic: bigint; feeRateSatPerVb: number }) => Promise<SendSubmitResult>;
}) {
  const asset = mustGetAsset(assetId);
  const usesFeePicker = asset.family.family === 'utxo';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<FeeTiers | null>(null);
  const [estimatedFeeAtomic, setEstimatedFeeAtomic] = useState<bigint | null>(null);
  // For CryptoNote (XMR/WOW) the fee is computed server-side, so `rate`
  // is a constant 0 and can't gate the Send button. Track whether the
  // display estimate has settled so we don't let the user commit while
  // the review still reads "Estimating…". Falls back to settled after a
  // timeout / on failure; the send-handler computes the real fee
  // regardless, so a slow estimate must never permanently block Send.
  const [feeEstimatePending, setFeeEstimatePending] = useState(!usesFeePicker);

  // Re-fetch the live fee estimate on mount for non-picker assets, same
  // pattern as Compose. Estimate may have shifted in the time it took
  // the user to review; in sweep mode the input count is significant
  // so we tell the shell to size the estimate for the actual spendable
  // output count.
  useEffect(() => {
    if (usesFeePicker || !resolveSendFeeEstimate) {
      setFeeEstimatePending(false);
      return;
    }
    let alive = true;
    setFeeEstimatePending(true);
    setEstimatedFeeAtomic(null);
    const settle = () => {
      if (alive) setFeeEstimatePending(false);
    };
    // Safety valve: never block Send forever if the estimate hangs.
    const fallback = setTimeout(settle, 12_000);
    resolveSendFeeEstimate(assetId, { sweep }).then(
      (fee) => {
        if (!alive) return;
        if (fee !== null) setEstimatedFeeAtomic(fee);
        clearTimeout(fallback);
        settle();
      },
      () => {
        if (!alive) return;
        clearTimeout(fallback);
        settle();
      },
    );
    return () => {
      alive = false;
      clearTimeout(fallback);
    };
  }, [assetId, usesFeePicker, resolveSendFeeEstimate, sweep]);

  // Re-fetch tiers on mount: rates may have shifted since Compose loaded
  // them. Cheap insurance against signing a stale fee. (Skipped for
  // custom tier: user explicitly set their rate; and for non-picker
  // assets: their fee comes from the handler, not a tier.)
  useEffect(() => {
    if (!usesFeePicker || feeTier === 'custom') return;
    let alive = true;
    resolveFeeRates(assetId).then((t) => {
      if (alive) setTiers(t);
    });
    return () => {
      alive = false;
    };
  }, [assetId, feeTier, resolveFeeRates, usesFeePicker]);

  // Same rate-resolution as Compose: standard tiers get the relay floor
  // (so 'normal' at 1.0 sat/vB displays + ships as 1.1); Custom is
  // verbatim. For non-picker assets the rate is meaningless: the
  // dispatcher ignores feeRateSatPerVb for XMR/WOW/Grin.
  const electrumRate = feeTier === 'custom' ? null : (tiers?.[feeTier] ?? null);
  const rate: number | null = !usesFeePicker
    ? 0
    : feeTier === 'custom'
      ? (customFeeRate ?? null)
      : electrumRate !== null
        ? applyFloor(electrumRate)
        : null;
  // amountAtomic for the OUTGOING tx (what the recipient receives).
  // In sweep mode the send-handler computes it from balance − fee on
  // its side; here we just pass 0 since it's ignored. (Caller knows.)
  const amountAtomic = sweep ? 0n : parseAmount(assetId, amountText);

  const canSend =
    rate !== null &&
    rate !== undefined &&
    (sweep || (amountAtomic !== null && amountAtomic > 0n)) &&
    // CryptoNote: don't allow commit until the fee estimate has settled.
    !feeEstimatePending;

  const handleSubmit = async () => {
    if (!canSend || rate === null || rate === undefined) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      amountAtomic: amountAtomic ?? 0n,
      feeRateSatPerVb: rate,
    });
    setSubmitting(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <div>
      <StepTitle>Review</StepTitle>
      <ReviewRow label="Asset" value={`${asset.displayName} (${asset.ticker})`} />
      <ReviewRow
        label="Amount"
        value={
          sweep
            ? `Max (sweeps balance)`
            : amountAtomic !== null
              ? formatAmountWithAsset(amountAtomic, asset, 8)
              : '—'
        }
      />
      <ReviewRow
        label="To"
        value={toAddress || '— slatepack only —'}
        mono
      />
      {usesFeePicker ? (
        <ReviewRow
          label="Fee tier"
          value={`${feeTier} (${rate !== null && rate !== undefined ? `${rate} sat/vB` : 'loading…'})`}
        />
      ) : (
        <ReviewRow
          label="Network fee"
          value={
            estimatedFeeAtomic !== null
              ? `~${formatAmountWithAsset(estimatedFeeAtomic, asset, 8)} ${asset.ticker}`
              : feeEstimatePending
                ? 'Estimating…'
                : 'computed at send'
          }
        />
      )}
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton testid="send-review-submit" disabled={submitting || !canSend} onClick={handleSubmit}>
        {submitting ? 'Sending…' : sweep ? 'Send Max 🔓' : 'Send 🔓'}
      </PrimaryButton>
    </div>
  );
}

// ============================================================================
// Done
// ============================================================================

// ============================================================================
// GrinExchange: interactive S1↔S2 step for Mimblewimble sends.
// ============================================================================
//
// Replaces the one-shot Review step for Grin. Phases:
//   1. Not yet built: auto-build S1 on mount via `onBuild`.
//   2. Built: display the armored slatepack (copy / share) + paste
//      box for the receiver's S2 response.
//   3. Paste received: call `onFinalize` → on success, wizard advances
//      to Done with kernel_excess as the displayed "txid".
//
// All state lives in wizard.fields so a popup-close mid-exchange
// resumes here on reopen.

interface GrinExchangeProps {
  assetId: string;
  toAddress: string;
  amountText: string;
  parseAmount: (assetId: string, text: string) => bigint | null;

  armoredOutgoing?: string;
  senderContextJson?: string;
  slateId?: string;
  relayId?: string;
  senderInputsJson?: string;
  changeOutputJson?: string;
  error?: string;
  /** S2 slatepack pre-filled by the Inbox dispatcher. When present the
   *  textarea opens already populated and the user just confirms the
   *  finalize. */
  pastedS2?: string;
  /** Actual atomic fee committed to in the built S1. Renders a
   *  read-only amount/fee/total summary on the Share-slatepack view
   *  so the sender can verify the slate before handing it over. */
  feeAtomic?: bigint;

  onBuild: (args: { amountAtomic: bigint; toAddress: string }) => Promise<GrinBuildSlateOutcome>;
  onFinalize: (args: { s2: string }) => Promise<GrinFinalizeOutcome>;
  onCancel: () => void | Promise<void>;
}

function GrinExchange(props: GrinExchangeProps) {
  const asset = mustGetAsset(props.assetId);
  const [building, setBuilding] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  // Synchronous re-entrancy guard. React state updates are batched:
  // two click events on the same tick both see `finalizing === false`
  // and both call onFinalize, producing a double-spend attempt against
  // the same locked inputs. The ref flips atomically inside the click
  // handler so the second click is dropped before any await fires.
  const finalizingRef = useRef(false);
  const [s2Text, setS2Text] = useState(props.pastedS2 ?? '');
  const [copied, setCopied] = useState(false);

  // If the Inbox dispatcher arrives with a pasted S2 after this
  // component is already mounted (e.g. user switches tabs and back),
  // pick it up. The dispatcher writes to wizard.fields.grinPastedS2
  // which flows through props.pastedS2.
  useEffect(() => {
    if (props.pastedS2 && !s2Text) {
      setS2Text(props.pastedS2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pastedS2]);

  // Trigger S1 build on first mount if we don't already have one.
  // The wizard's state persists across popup close; if the user
  // already built S1 and closed the popup, we skip rebuilding.
  useEffect(() => {
    if (props.armoredOutgoing) return;
    let alive = true;
    const amountAtomic = props.parseAmount(props.assetId, props.amountText);
    if (amountAtomic === null || amountAtomic <= 0n) return;
    setBuilding(true);
    props
      .onBuild({ amountAtomic, toAddress: props.toAddress })
      .finally(() => {
        if (alive) setBuilding(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.armoredOutgoing]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const handleFinalize = async () => {
    if (!s2Text.trim()) return;
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    setFinalizing(true);
    try {
      await props.onFinalize({ s2: s2Text.trim() });
    } finally {
      setFinalizing(false);
      finalizingRef.current = false;
    }
  };

  // ----- Building phase -----
  if (building && !props.armoredOutgoing) {
    return (
      <div>
        <StepTitle>Building slate…</StepTitle>
        <FullPageStatus>
          Selecting inputs, signing your half of the kernel, and locking
          outputs on the server.
        </FullPageStatus>
      </div>
    );
  }

  // ----- Broadcasting phase -----
  // Same full-page treatment as the build phase so the UI is
  // unambiguously busy. Without this the only feedback during the
  // ~5s push_transaction → JSON-RPC roundtrip was the button text
  // flipping to "Broadcasting…": easy to miss, leading to second-
  // click confusion (the synchronous `finalizingRef` swallows the
  // second click but the user has no idea why it "didn't do
  // anything").
  if (finalizing) {
    return (
      <div>
        <StepTitle>Broadcasting…</StepTitle>
        <FullPageStatus>
          Pushing the signed kernel to the Grin node. This usually
          completes in a few seconds; closing the popup is fine — the
          wizard resumes on reopen.
        </FullPageStatus>
      </div>
    );
  }

  // ----- Build-failed (no slatepack to show, with error) -----
  if (!props.armoredOutgoing && props.error) {
    return (
      <div>
        <StepTitle>Couldn't build slate</StepTitle>
        <FieldError>{props.error}</FieldError>
        <PrimaryButton onClick={() => void props.onCancel()}>
          Cancel
        </PrimaryButton>
      </div>
    );
  }

  // ----- Awaiting S2 -----
  // Two-action layout: top half is "send the slatepack out", bottom
  // half is "paste their response and broadcast". Previously the
  // full slatepack hex was rendered inline (max-height scroll box +
  // wall of paragraph text + relay sentence), which crowded the
  // popup and buried the Paste textarea below the fold.
  const slatepackLen = props.armoredOutgoing?.length ?? 0;
  const parsedAmount = props.parseAmount(props.assetId, props.amountText);
  const totalAtomic =
    parsedAmount !== null && props.feeAtomic !== undefined
      ? parsedAmount + props.feeAtomic
      : null;
  return (
    <div>
      <StepTitle>Share slatepack</StepTitle>

      {/* Fee/total summary: read-only confirmation that the built
          S1 matches what the user intended. Renders only once we
          have a real fee from the build step (compose preview was an
          estimate; this is the real number committed to the slate). */}
      {(parsedAmount !== null || props.feeAtomic !== undefined) && (
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--smirk-bg-sunken)',
            border: '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            marginBottom: 8,
          }}
        >
          {parsedAmount !== null && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--smirk-fg-muted)' }}>Amount</span>
              <strong style={{ fontFamily: 'var(--smirk-font-family-mono)' }}>
                {formatAmountWithAsset(parsedAmount, asset, 8)}
              </strong>
            </div>
          )}
          {props.feeAtomic !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--smirk-fg-muted)' }}>Network fee</span>
              <strong style={{ fontFamily: 'var(--smirk-font-family-mono)' }}>
                {formatAmountWithAsset(props.feeAtomic, asset, 8)}
              </strong>
            </div>
          )}
          {totalAtomic !== null && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                paddingTop: 3,
                borderTop: '1px solid var(--smirk-border)',
              }}
            >
              <span style={{ color: 'var(--smirk-fg-muted)' }}>Total deducted</span>
              <strong style={{ fontFamily: 'var(--smirk-font-family-mono)' }}>
                {formatAmountWithAsset(totalAtomic, asset, 8)}
              </strong>
            </div>
          )}
        </div>
      )}

      {/* Action 1: copy the slatepack out. Single-row card; the full
          hex is one click away ("Show") but doesn't dominate the
          screen by default. */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          padding: '8px 10px',
          background: 'var(--smirk-bg-sunken)',
          border: '1px solid var(--smirk-border)',
          borderRadius: 'var(--smirk-radius, 8px)',
        }}
      >
        <div style={{ flex: 1, fontSize: 11, lineHeight: 1.3 }}>
          <div style={{ fontWeight: 600 }}>📦 Slatepack ready</div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              fontFamily: 'var(--smirk-font-family-mono)',
            }}
          >
            {slatepackLen} chars · send to{' '}
            {props.toAddress
              ? truncateMiddle(props.toAddress, 16)
              : 'recipient'}
          </div>
        </div>
        <Button onClick={() => copy(props.armoredOutgoing ?? '')}>
          {copied ? '✓' : '⧉ Copy'}
        </Button>
      </div>

      {props.relayId && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: 'var(--smirk-positive)',
            background: 'var(--smirk-bg-sunken)',
            border: '1px solid var(--smirk-positive)',
            borderRadius: 'var(--smirk-radius, 8px)',
            fontFamily: 'var(--smirk-font-family-mono)',
            letterSpacing: '0.04em',
          }}
          title="If the recipient is a Smirk user, the slatepack appears in their Inbox automatically."
        >
          ● relay posted
        </div>
      )}

      <details style={{ marginTop: 6, fontSize: 11 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--smirk-fg-muted)' }}>
          Show full slatepack
        </summary>
        <button
          onClick={() => copy(props.armoredOutgoing ?? '')}
          data-no-uppercase
          title="Click to copy"
          style={{
            fontFamily: 'var(--smirk-font-family-mono)',
            fontSize: 10,
            wordBreak: 'break-all',
            padding: '8px 10px',
            marginTop: 4,
            background: 'var(--smirk-bg-sunken)',
            border: '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            color: 'inherit',
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
            maxHeight: 140,
            overflowY: 'auto',
            lineHeight: 1.2,
          }}
        >
          {props.armoredOutgoing}
        </button>
      </details>

      {/* Action 2: paste their response and broadcast. */}
      <div
        style={{
          fontSize: 10,
          color: 'var(--smirk-fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginTop: 18,
          marginBottom: 4,
        }}
      >
        Paste their signed response
      </div>
      <textarea
        value={s2Text}
        onInput={(e) => setS2Text((e.target as HTMLTextAreaElement).value)}
        placeholder="BEGINSLATEPACK…"
        rows={4}
        style={textareaStyle}
      />
      {props.error && <FieldError>{props.error}</FieldError>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => void props.onCancel()}
          style={{
            flex: 1,
            fontSize: 12,
            padding: '10px 12px',
            background: 'var(--smirk-bg-elevated)',
            border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
            borderRadius: 'var(--smirk-radius, 8px)',
            color: 'inherit',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Cancel send
        </button>
        <Button
          onClick={handleFinalize}
          {...(!s2Text.trim() || finalizing ? { disabled: true } : {})}
        >
          {finalizing ? 'Broadcasting…' : 'Finalize & broadcast'}
        </Button>
      </div>

      <div
        style={{
          fontSize: 10,
          color: 'var(--smirk-fg-muted)',
          marginTop: 10,
          textAlign: 'center',
        }}
      >
        {props.amountText} {asset.ticker} locked · cancel to unlock
      </div>
    </div>
  );
}

function DoneStep({
  txid,
  assetId,
  onClose,
}: {
  txid?: string;
  assetId?: string;
  onClose: () => void;
}) {
  const explorerUrl = txid && assetId ? explorerTxUrl(assetId, txid) : null;
  const [copied, setCopied] = useState(false);
  const copyTxid = () => {
    if (!txid) return;
    void navigator.clipboard.writeText(txid).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  // Diagnostic: if we render the Done step without a txid, log so
  // the next time this bug shows up we can read the cause from the
  // console rather than guess. The wizard's inner onSubmit only
  // patches `lastTxid` on result.ok, so an absent txid here means
  // the wizard advanced without going through the success path
  // (or the send-handler returned ok:true with a falsy txid).
  if (!txid && typeof console !== 'undefined') {
    console.warn('[smirk send] DoneStep rendered without txid', { assetId });
  }
  // Grin-specific: the "sent" state really means "broadcast: kernel
  // is in the node's pool". On-chain confirmation takes ~10 minutes
  // (10 blocks at the conservative confirmation threshold). Make this
  // explicit so the user doesn't refresh-loop expecting an instant
  // confirmation. Other chains finalize faster and "Sent" is accurate.
  const isGrin = assetId === 'grin';
  const headline = isGrin ? 'Broadcast' : 'Sent';
  const sublabel = isGrin
    ? 'Awaiting on-chain confirmation. Refresh in a few minutes.'
    : null;
  const fieldLabel = isGrin ? 'Kernel ID' : 'Transaction ID';

  return (
    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
      <div style={{ fontSize: 40 }}>✓</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>{headline}</div>
      {sublabel && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--smirk-fg-muted)',
            lineHeight: 1.4,
          }}
        >
          {sublabel}
        </div>
      )}
      {!txid && (
        <div
          style={{
            marginTop: 14,
            fontSize: 12,
            color: 'var(--smirk-fg-muted)',
            lineHeight: 1.4,
          }}
        >
          Transaction submitted, but the wizard didn't capture the txid.
          <br />
          Check the asset's history or the recipient address to confirm
          it landed.
        </div>
      )}
      {txid && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              textTransform: 'uppercase',
              marginBottom: 4,
              letterSpacing: '0.06em',
            }}
          >
            {fieldLabel}
          </div>
          {/* Click to copy. The data-no-uppercase attribute is the
              opt-out hook for pixel themes (DMG/Workbench) that
              uppercase everything; the hex itself should stay
              mixed case so users can match against block explorers
              that round-trip it verbatim. */}
          <button
            data-testid="send-done-txid"
            onClick={copyTxid}
            data-no-uppercase
            title="Click to copy"
            style={{
              fontFamily: 'var(--smirk-font-family-mono)',
              fontSize: 11,
              wordBreak: 'break-all',
              padding: '8px 10px',
              background: 'var(--smirk-bg-sunken)',
              border: '1px solid var(--smirk-border)',
              borderRadius: 'var(--smirk-radius, 8px)',
              color: 'inherit',
              cursor: 'pointer',
              width: '100%',
              textAlign: 'center',
              lineHeight: 1.3,
            }}
          >
            {txid}
          </button>
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={copyTxid}
              style={{
                fontSize: 12,
                padding: '6px 12px',
                background: 'var(--smirk-bg-elevated)',
                border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
                borderRadius: 'var(--smirk-radius, 8px)',
                color: 'inherit',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {copied ? '✓ Copied' : '⧉ Copy'}
            </button>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  background: 'var(--smirk-accent)',
                  color: 'var(--smirk-accent-fg)',
                  borderRadius: 'var(--smirk-radius, 8px)',
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                Open in Explorer ↗
              </a>
            )}
          </div>
        </div>
      )}
      <PrimaryButton testid="send-done-close" onClick={onClose}>Done</PrimaryButton>
    </div>
  );
}

/**
 * Public block-explorer URLs for verifying broadcast txs. Per-asset
 * mainnet only (testnet flows aren't in v0.3). When a chain isn't
 * listed, the Done step omits the link rather than guessing.
 */
function explorerTxUrl(assetId: string, txid: string): string | null {
  switch (assetId) {
    case 'btc':
      return `https://mempool.space/tx/${txid}`;
    case 'ltc':
      return `https://litecoinspace.org/tx/${txid}`;
    case 'xmr':
      return `https://xmrchain.net/tx/${txid}`;
    case 'wow':
      return `https://explore.wownero.com/tx/${txid}`;
    case 'grin':
      // `kernel_excess_hex` from WASM `finalize_send_slate`/`finalize_invoice`
      // is already in canonical Pedersen commitment form (08/09 prefix),
      // matching what grincoin.org indexes by and what's on-chain in
      // `kernel.excess`. No prefix swap needed.
      return `https://grincoin.org/kernel/${txid}`;
    default:
      return null;
  }
}

// ============================================================================
// Shared chrome
// ============================================================================

async function exit(wizard: ReturnType<typeof useWizard<SendFields>>, onExit: () => void) {
  await wizard.cancel();
  onExit();
}

function Header({
  step,
  totalSteps,
  onCancel,
  onBack,
}: {
  step: number;
  totalSteps: number;
  onCancel: () => void;
  onBack?: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 12,
      }}
    >
      <button
        data-testid="send-wizard-header-back"
        onClick={onBack ?? onCancel}
        aria-label={onBack ? 'Back' : 'Cancel'}
        style={iconButtonStyle}
      >
        {onBack ? '‹ Back' : 'Cancel'}
      </button>
      <span style={{ opacity: 0.5 }}>
        Step {Math.min(step + 1, totalSteps)} / {totalSteps}
      </span>
      <span style={{ width: 60 }} />
    </header>
  );
}

function StepTitle({ children }: { children: preact.ComponentChildren }) {
  return (
    <h2 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 14px' }}>{children}</h2>
  );
}

function ReviewRow({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: small ? '6px 0' : '8px 0',
        borderBottom: '1px solid var(--smirk-border)',
      }}
    >
      <span style={{ fontSize: 11, opacity: 0.5, textTransform: 'uppercase' }}>{label}</span>
      <span style={mono ? { fontFamily: 'var(--smirk-font-family-mono)', fontSize: 12, wordBreak: 'break-all' } : undefined}>
        {value}
      </span>
    </div>
  );
}

function FieldError({ children }: { children: preact.ComponentChildren }) {
  return (
    <div style={{ color: 'var(--smirk-negative)', fontSize: 12, padding: '4px 0' }}>{children}</div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  testid,
}: {
  children: preact.ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <Button
        onClick={onClick}
        {...(disabled ? { disabled: true } : {})}
        {...(testid ? { testid } : {})}
      >
        {children}
      </Button>
    </div>
  );
}

function FullPageStatus({ children }: { children: preact.ComponentChildren }) {
  return (
    <div style={{ padding: '40px 16px', textAlign: 'center', opacity: 0.6 }}>{children}</div>
  );
}

// ============================================================================
// Inline styles
// ============================================================================

const iconButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 8px',
} as const;

const amountInputStyle = {
  flex: 1,
  fontSize: 18,
  fontWeight: 700,
  padding: '6px 10px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box' as const,
  minWidth: 0,
};

const maxButtonStyle = {
  padding: '0 14px',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.05em',
  cursor: 'pointer',
  boxSizing: 'border-box' as const,
};

const customRateInputStyle = {
  width: 56,
  padding: '4px 6px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius-sm, 4px)',
  color: 'inherit',
  fontFamily: 'var(--smirk-font-family-mono)',
  fontSize: 11,
  textAlign: 'right' as const,
  outline: 'none',
  boxSizing: 'border-box' as const,
};

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        border: `2px solid var(--smirk-${active ? 'accent' : 'fg-muted'})`,
        background: active ? 'var(--smirk-accent)' : 'transparent',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    />
  );
}

const textareaStyle = {
  width: '100%',
  fontSize: 13,
  fontFamily: 'var(--smirk-font-family-mono)',
  padding: '10px 12px',
  background: 'var(--smirk-bg-sunken)',
  border: '1px solid var(--smirk-border)',
  borderRadius: 'var(--smirk-radius, 8px)',
  color: 'inherit',
  outline: 'none',
  resize: 'vertical' as const,
  boxSizing: 'border-box' as const,
};

function rowButtonStyle(active: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '10px 12px',
    background: active
      ? 'color-mix(in srgb, var(--smirk-accent) 15%, var(--smirk-bg-elevated))'
      : 'var(--smirk-bg-elevated)',
    border: '1px solid var(--smirk-border)',
    borderRadius: 'var(--smirk-radius, 8px)',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const;
}

function tierRowStyle(active: boolean, disabled: boolean) {
  return {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '4px 10px',
    background: active
      ? 'color-mix(in srgb, var(--smirk-accent) 15%, var(--smirk-bg-elevated))'
      : 'var(--smirk-bg-elevated)',
    border: '1px solid var(--smirk-border)',
    borderRadius: 'var(--smirk-radius, 8px)',
    color: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.45 : 1,
    textAlign: 'left' as const,
    minHeight: 30,
  } as const;
}
