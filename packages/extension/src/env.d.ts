/// <reference types="vite/client" />

/**
 * Custom build-time env vars exposed to the extension.
 *
 * - `VITE_SMIRK_RELEASE`: set to `"true"` only by the release pipeline.
 *   Triggers the stub-detection guard in `popup/index.tsx`.
 *   Unset (or any other value) during normal `npm run build:chrome`.
 */
interface ImportMetaEnv {
  readonly VITE_SMIRK_RELEASE?: string;
  /**
   * Trocador affiliate API key (set at build time). Ships in the
   * bundle by design (client-direct architecture, V0_3_PLAN.md
   * Decision 2). When unset, the SwapTab disables the Trocador entry
   * with a "key missing" status rather than 401-ing at runtime.
   */
  readonly VITE_TROCADOR_API_KEY?: string;
  /**
   * Backend URL used for the Trocador webhook receiver and the
   * /api/v1/swaps bookkeeping endpoints. Falls back to the default
   * smirk-backend URL when unset.
   */
  readonly VITE_SMIRK_BACKEND_URL?: string;
  /**
   * Seed-only Grin recovery, build-time gated (OFF in public builds):
   * - `VITE_RECOVER_GRIN_DEFAULT="true"` enables it for every wallet.
   * - `VITE_RECOVER_GRIN_ALLOWLIST` is a comma-separated list of canonical
   *   Grin slatepack addresses allowed to recover even when the default is off.
   * - `VITE_RECOVER_GRIN_BIRTHDAY` is the block-height floor for the scan
   *   (unset = full scan from genesis).
   */
  readonly VITE_RECOVER_GRIN_DEFAULT?: string;
  readonly VITE_RECOVER_GRIN_ALLOWLIST?: string;
  readonly VITE_RECOVER_GRIN_BIRTHDAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
