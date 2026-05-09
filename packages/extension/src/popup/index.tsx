/**
 * Smirk popup — skeleton.
 *
 * Verifies the build pipeline (Vite → @smirk/core + @smirk/assets +
 * @smirk/ui + @smirk/wasm → MV3 popup) wires up end-to-end. The
 * substantive UI rebuild against UI_DESIGN.md principles lands in
 * later commits.
 */

import { render } from 'preact';
import { CORE_PACKAGE_VERSION } from '@smirk/core';
import { listAssets } from '@smirk/assets';
import {
  ActionButton,
  ActionRow,
  BalanceCard,
  UI_PACKAGE_VERSION,
} from '@smirk/ui';

function App() {
  const assets = listAssets();

  return (
    <div>
      <span class="tag">Skeleton</span>
      <h1 style={{ marginTop: 12 }}>Smirk</h1>
      <p class="muted">
        <code>core@{CORE_PACKAGE_VERSION}</code> · <code>ui@{UI_PACKAGE_VERSION}</code>
      </p>

      <ActionRow class="actions">
        <ActionButton label="Tip" icon="🎁" onClick={() => console.log('tip')} />
        <ActionButton label="Send" icon="↗" onClick={() => console.log('send')} />
        <ActionButton label="Swap" icon="⇄" onClick={() => console.log('swap')} />
        <ActionButton label="Claim" icon="📥" onClick={() => console.log('claim')} />
      </ActionRow>

      <h2 style={{ fontSize: 13, marginTop: 20, color: 'rgba(255,255,255,0.5)' }}>
        Wallet ({assets.length} assets)
      </h2>
      <div>
        {assets.map((a) => (
          <BalanceCard key={a.id} assetId={a.id} balanceAtomic={0n} />
        ))}
      </div>

      <p class="muted" style={{ marginTop: 16, fontSize: 11 }}>
        Production extension still at <code>Such-Software/smirk-extension</code>
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
