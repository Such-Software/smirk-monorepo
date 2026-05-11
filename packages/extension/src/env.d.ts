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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
