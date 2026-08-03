import { useEffect, useState } from 'preact/hooks';
import {
  connectBackend,
  readBackendConfig,
  writeBackendConfig,
  clearBackendConfig,
  applyBackendConfig,
  type WalletApiStyle,
} from '@smirk/core';
import { BackendPicker, type BackendProbeInfo } from '@smirk/ui';
import { storage } from '../singletons';
import { DEFAULT_BACKEND } from '../../backend-boot';

/**
 * Validate + probe a candidate backend, mapping core `connectBackend`
 * (+ `/capabilities`) into the presentational `BackendProbeInfo` the
 * `BackendPicker` renders. Shared by the Settings screen and onboarding.
 */
export async function probeBackend(
  url: string,
): Promise<{ ok: boolean; info?: BackendProbeInfo; error?: string }> {
  const r = await connectBackend(url);
  if (!r.ok || !r.apiStyle) {
    return { ok: false, ...(r.error ? { error: r.error } : {}) };
  }
  const caps = r.capabilities;
  const chains = caps
    ? Object.entries(caps.chains)
        .filter(([, c]) => c.enabled)
        .map(([id]) => id)
    : [];
  // `/capabilities` advertises no operator instance name yet, so leave it unset
  // (the picker falls back to the URL). A future backend field can populate it.
  const info: BackendProbeInfo = {
    url: r.url,
    apiStyle: r.apiStyle,
    chains,
    ...(caps?.restore?.policy ? { restorePolicy: caps.restore.policy } : {}),
    relay: !!caps?.features?.nostr_relay,
  };
  return { ok: true, info };
}

/**
 * Settings -> Backend. Reads the durable backend selection, lets the user probe
 * + switch to another smirk-backend (self-hosted or another operator's), and
 * re-points every JS context. The probe/commit glue maps core `connectBackend`
 * (+ `/capabilities`) to the presentational `BackendPicker`.
 */
export function BackendRoute({
  onSwitched,
  onBack,
}: {
  onSwitched: () => Promise<void>;
  onBack: () => void;
}) {
  const [current, setCurrent] = useState<
    { url: string; instanceName?: string; isDefault: boolean } | undefined
  >(undefined);

  useEffect(() => {
    let stale = false;
    void readBackendConfig(storage).then((cfg) => {
      if (stale) return;
      setCurrent(
        cfg
          ? {
              url: cfg.url,
              ...(cfg.instanceName ? { instanceName: cfg.instanceName } : {}),
              isDefault: cfg.url === DEFAULT_BACKEND.url,
            }
          : { url: DEFAULT_BACKEND.url, isDefault: true },
      );
    });
    return () => {
      stale = true;
    };
  }, []);

  const onUse = async (info: BackendProbeInfo) => {
    const apiStyle = info.apiStyle as WalletApiStyle;
    await writeBackendConfig(storage, {
      url: info.url,
      apiStyle,
      ...(info.instanceName ? { instanceName: info.instanceName } : {}),
      chosenAt: Date.now(),
    });
    applyBackendConfig({ url: info.url, apiStyle });
    await onSwitched();
    onBack();
  };

  const onResetDefault = async () => {
    await clearBackendConfig(storage);
    applyBackendConfig(DEFAULT_BACKEND);
    await onSwitched();
    onBack();
  };

  return (
    <div data-testid="settings-backend-screen">
      <BackendPicker
        context="settings"
        {...(current ? { current } : {})}
        defaultUrl={DEFAULT_BACKEND.url}
        probe={probeBackend}
        onUse={onUse}
        onResetDefault={onResetDefault}
        onBack={onBack}
      />
    </div>
  );
}
