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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
