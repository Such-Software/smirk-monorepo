/**
 * Smirk popup — skeleton.
 *
 * This is the monorepo skeleton entry point. It exists to verify that
 * the build pipeline (Vite → @smirk/core + @smirk/wasm → MV3 popup)
 * works end-to-end. The substantive UI migrates in over multiple
 * commits from `Such-Software/smirk-extension/src/popup/`.
 */

import { render } from 'preact';
import { CORE_PACKAGE_VERSION } from '@smirk/core';

function App() {
  return (
    <div>
      <span class="tag">Skeleton</span>
      <h1 style={{ marginTop: 12 }}>Smirk</h1>
      <p class="muted">
        Monorepo build · <code>@smirk/core@{CORE_PACKAGE_VERSION}</code>
      </p>

      <ul>
        <li>
          <strong>Crypto:</strong> Rust crates (<code>monero-oxide</code>,{' '}
          <code>grin-ext</code>, <code>btc-ext</code>) → WASM
        </li>
        <li>
          <strong>HTTP / state:</strong> <code>@smirk/core</code>
        </li>
        <li>
          <strong>UI:</strong> migration in progress
        </li>
      </ul>

      <p class="muted" style={{ marginTop: 24, fontSize: 11 }}>
        Production extension: <code>Such-Software/smirk-extension</code>
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
