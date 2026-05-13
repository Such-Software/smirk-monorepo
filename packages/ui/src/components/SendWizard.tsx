/**
 * SendWizard — Send flow with a Compose step (amount / fee tier / Max
 * sweep) and a separate Review step.
 *
 * Steps:
 *   0. Asset       — pick which coin to send.
 *   1. Address     — recipient address.
 *   2. Compose     — amount + balance display + Max button + fee tier
 *                    picker. All inputs editable here.
 *   3. Review      — read-only summary; tapping Send commits.
 *   (4. Done       — success screen with txid.)
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
 *   Not inferred from "amount happens to equal balance" — deliberate.
 * - **Review is read-only.** Compose is where you edit; Review is where
 *   you commit. Back from Review preserves Compose state.
 */

import { useEffect, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import type { AssetDefinition } from '@smirk/assets';
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
  /** True iff the Max button is active — sweep mode. */
  sweep?: boolean;
  /** Filled in after a successful broadcast; surfaced on the Done step. */
  lastTxid?: string;
}

export type SendSubmitResult =
  | { ok: true; txid: string }
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
   * units. Synchronous — popup-side pulls from session state.
   */
  resolveBalance: (assetId: string) => bigint;

  /**
   * Fetch live fee tiers (sat/vB) for `assetId`. Called by Compose on
   * mount. UI shows a spinner / "—" until this resolves.
   */
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>;

  /**
   * Estimate the network fee in atomic units for one send of `assetId`
   * (assuming a 2-output tx — recipient + change — and 1 input — the
   * common case for Smirk's single-address scheme). Used by Compose to
   * preview the fee for assets that don't have a user-tunable fee
   * picker (XMR/WOW/Grin). Return `null` if the asset uses the picker
   * tiers instead, or if the estimate isn't available yet.
   */
  resolveSendFeeEstimate?: (assetId: string) => Promise<bigint | null>;

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

  onExit: () => void;
  resolveIcon?: (iconKey: string) => string | undefined;
  class?: string;
}

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

      {step === 2 && fields.fromAssetId && fields.toAddress && (
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
        fields.toAddress &&
        fields.amountText !== undefined &&
        fields.feeTier && (
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
    </div>
  );
}

// ============================================================================
// Step 0 — Pick asset
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
// Step 1 — Recipient address
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

  const handleContinue = async () => {
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
      <textarea
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
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton disabled={!text.trim() || validating} onClick={handleContinue}>
        {validating ? 'Validating…' : 'Continue'}
      </PrimaryButton>
    </div>
  );
}

// ============================================================================
// Step 2 — Compose (amount + Max + fee tier)
// ============================================================================

/**
 * Vsize estimator for fee preview. Mirrors `estimateVsize` in
 * `packages/extension/src/popup/send-handler.ts`. We assume 1 input —
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
 * Network-relay floor for the standard fee tiers (Fast/Normal/Slow),
 * applied to whatever Electrum's `estimatefee` returns. Bitcoin Core's
 * wallet does the same thing under the name `incrementalRelayFee`: when
 * the estimated rate equals the network's `minRelayTxFee` (1.0 sat/vB
 * on BTC/LTC), some real nodes round up the per-tx comparison and
 * reject the tx as "min relay fee not met" — observed 2026-05-12 with
 * 140-vbyte 0.001-LTC tx at 1.0 sat/vB rejected by every public LTC
 * Electrum server.
 *
 * 1.1 puts us safely above that boundary while costing the user a few
 * extra lits. Not a multiplier — the user sees this exact rate in the
 * tier picker (Fast/Normal/Slow show `Math.max(electrumRate, 1.1)`).
 *
 * **Does NOT apply to the Custom tier.** Custom is the explicit-knob;
 * if a user types 0.5 deliberately, they get 0.5.
 */
const RELAY_FLOOR_SAT_PER_VB = 1.1;

function applyFloor(rate: number): number {
  return Math.max(rate, RELAY_FLOOR_SAT_PER_VB);
}

/**
 * Compute fee in atomic units for a tier rate.
 *
 * For BTC/LTC: rate is sat/vB, vsize is vbytes → fee = ceil(vsize × rate).
 * For XMR/WOW/Grin: until those send-handlers land, this same function
 * is called but the asset-specific rates / sizes need their own
 * estimator. For v0.3 BTC/LTC scope: this is correct.
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
  resolveSendFeeEstimate?: (assetId: string) => Promise<bigint | null>;
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
  // Sweep depends on a known fee (so we can compute balance − fee). For
  // non-UTXO chains, force-disable until Phase 2 wires it through the
  // sendXmrWow / Grin handlers.
  const [sweep, setSweep] = useState(usesFeePicker ? initialSweep : false);
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

  // Load fee tiers on mount. Skip for non-UTXO assets — their fees
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

  // For non-picker assets, fetch a live fee estimate on mount via the
  // shell callback (popup hits LWS per_byte_fee + wasm.estimate_fee).
  // Estimate assumes 1 input + 2 outputs (recipient + change), which
  // is the typical case for Smirk's single-address scheme.
  useEffect(() => {
    if (usesFeePicker || !resolveSendFeeEstimate) return;
    let alive = true;
    setEstimatedFeeAtomic(null);
    resolveSendFeeEstimate(assetId).then(
      (fee) => {
        if (alive && fee !== null) setEstimatedFeeAtomic(fee);
      },
      () => {
        // Swallow estimate failures — fall back to the generic
        // "computed at send time" copy below. A failed estimate
        // shouldn't block the user from continuing.
      },
    );
    return () => {
      alive = false;
    };
  }, [assetId, usesFeePicker, resolveSendFeeEstimate]);

  // Selected rate for the standard tiers passes through `applyFloor` so
  // we never ship a rate at the protocol minimum that some nodes round
  // up against. Custom is verbatim — explicit override.
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
  const sweepAmountAtomic =
    sweep && selectedFeeSat !== null ? balanceAtomic - BigInt(selectedFeeSat) : null;

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

      {/* Amount field + Max. Max only renders for UTXO chains — for
          CryptoNote/Mimblewimble we don't know the fee at compose
          time so sweep is deferred to a Phase-2 handler. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <input
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
        {usesFeePicker && (
          <button
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

      {/* Recipient — read-only here, tap to edit goes back */}
      <ReviewRow label="To" value={truncateMiddle(toAddress, 24)} mono small />

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
              // Display the floored rate — it's what the tx will use.
              const displayRate =
                electrum !== null && electrum !== undefined ? applyFloor(electrum) : null;
              const active = tier === t;
              const fee = displayRate !== null ? feeForTier(displayRate, sweep) : null;
              return (
                <button
                  key={t}
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

      {/* Fee preview for non-picker assets. When the shell wires
          resolveSendFeeEstimate, show the live estimate (atomic →
          formatted); otherwise fall back to the generic copy so the
          user at least knows where the fee comes from. */}
      {!usesFeePicker && (
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
            {estimatedFeeAtomic !== null
              ? `${formatAmount(estimatedFeeAtomic, assetId, 8)} ${asset.ticker}`
              : '…'}
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
          Continue to review
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
 * Per-asset atomic-unit names are hardcoded here for v0.3 BTC/LTC.
 * Once XMR/WOW/Grin send-handlers land, the unit name belongs in the
 * `@smirk/assets` registry (alongside decimals, etc.).
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
// Step 3 — Review (read-only confirm)
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
  resolveSendFeeEstimate?: (assetId: string) => Promise<bigint | null>;
  onSubmit: (args: { amountAtomic: bigint; feeRateSatPerVb: number }) => Promise<SendSubmitResult>;
}) {
  const asset = mustGetAsset(assetId);
  const usesFeePicker = asset.family.family === 'utxo';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<FeeTiers | null>(null);
  const [estimatedFeeAtomic, setEstimatedFeeAtomic] = useState<bigint | null>(null);

  // Re-fetch the live fee estimate on mount for non-picker assets, same
  // pattern as Compose. Estimate may have shifted in the time it took
  // the user to review.
  useEffect(() => {
    if (usesFeePicker || !resolveSendFeeEstimate) return;
    let alive = true;
    resolveSendFeeEstimate(assetId).then((fee) => {
      if (alive && fee !== null) setEstimatedFeeAtomic(fee);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [assetId, usesFeePicker, resolveSendFeeEstimate]);

  // Re-fetch tiers on mount — rates may have shifted since Compose loaded
  // them. Cheap insurance against signing a stale fee. (Skipped for
  // custom tier — user explicitly set their rate; and for non-picker
  // assets — their fee comes from the handler, not a tier.)
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
  // verbatim. For non-picker assets the rate is meaningless — the
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
    rate !== null && rate !== undefined && (sweep || (amountAtomic !== null && amountAtomic > 0n));

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
      <ReviewRow label="To" value={toAddress} mono />
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
              : 'Estimating…'
          }
        />
      )}
      {error && <FieldError>{error}</FieldError>}
      <PrimaryButton disabled={submitting || !canSend} onClick={handleSubmit}>
        {submitting ? 'Sending…' : sweep ? 'Send Max 🔓' : 'Send 🔓'}
      </PrimaryButton>
    </div>
  );
}

// ============================================================================
// Done
// ============================================================================

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
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
      <div style={{ fontSize: 40 }}>✓</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>Sent</div>
      {txid && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Transaction ID
          </div>
          <div
            style={{
              fontFamily: 'var(--smirk-font-family-mono)',
              fontSize: 11,
              wordBreak: 'break-all',
              padding: '6px 10px',
              background: 'var(--smirk-bg-sunken)',
              borderRadius: 'var(--smirk-radius, 8px)',
            }}
          >
            {txid}
          </div>
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                marginTop: 8,
                fontSize: 12,
                color: 'var(--smirk-accent)',
                textDecoration: 'underline',
              }}
            >
              View on explorer ↗
            </a>
          )}
        </div>
      )}
      <PrimaryButton onClick={onClose}>Done</PrimaryButton>
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
}: {
  children: preact.ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <Button onClick={onClick} {...(disabled ? { disabled: true } : {})}>
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
