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
import { listAssets } from '@smirk/assets';

function App() {
  const assets = listAssets();

  return (
    <div>
      <span class="tag">Skeleton</span>
      <h1 style={{ marginTop: 12 }}>Smirk</h1>
      <p class="muted">
        Monorepo build · <code>@smirk/core@{CORE_PACKAGE_VERSION}</code>
      </p>

      <h2 style={{ fontSize: 14, marginTop: 16 }}>Registered assets ({assets.length})</h2>
      <ul>
        {assets.map((a) => (
          <li key={a.id}>
            <strong>{a.ticker}</strong> · <code>{a.id}</code> · {a.family.family} ·{' '}
            decimals={a.decimals}
          </li>
        ))}
      </ul>

      <p class="muted" style={{ marginTop: 24, fontSize: 11 }}>
        Production extension: <code>Such-Software/smirk-extension</code>
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
