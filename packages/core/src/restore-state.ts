import type { SmirkApi } from './api';

/** A failed lookup cannot establish a new wallet or choose a fresh scan birthday. */
export async function requireRestoreState(
  api: Pick<SmirkApi, 'checkRestore'>,
  params: Parameters<SmirkApi['checkRestore']>[0],
) {
  let result: Awaited<ReturnType<SmirkApi['checkRestore']>>;
  try { result = await api.checkRestore(params); }
  catch (error) {
    throw new Error(`Could not check wallet history: ${error instanceof Error ? error.message : 'request failed'}. Retry before registering.`);
  }
  if (result.error || !result.data || typeof result.data.exists !== 'boolean') {
    const detail = result.error || (result.status ? `HTTP ${result.status}, missing restore result` : 'missing restore result');
    throw new Error(`Could not check wallet history: ${detail}. Retry before registering.`);
  }
  if (result.data.error || result.data.keysValid === false) {
    throw new Error(`Wallet history could not be verified: ${result.data.error || 'registered keys do not match this wallet'}.`);
  }
  if (result.data.exists && result.data.keysValid !== true) {
    throw new Error('Wallet history could not be verified: the backend did not confirm the registered keys. Retry before registering.');
  }
  for (const name of ['xmrStartHeight', 'wowStartHeight'] as const) {
    const height = result.data[name];
    if (height != null && (!Number.isSafeInteger(height) || height < 0)) {
      throw new Error(`Wallet history contains an invalid ${name}. Registration was stopped.`);
    }
  }
  return result.data;
}
