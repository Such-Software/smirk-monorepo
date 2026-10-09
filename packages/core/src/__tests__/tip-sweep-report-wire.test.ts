/**
 * Wire format of the tip sweep report (`POST /tips/social/{id}/confirm-sweep`).
 *
 * The backend settles an XMR/WOW tip on the sweep a claimer reports. A txid
 * alone cannot tell the real sweep from a stranger's transaction that sampled
 * the tip output as a ring decoy, so v0.3.1 adds `key_images`: the key image
 * of each tip output the sweep spent, with a proof only the tip's spend key can
 * make. These pin the body the backend's `ConfirmSweepRequest` deserializes:
 * snake_case keys, and no `key_images` at all when there are none, which is
 * exactly what v0.3.0 sent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiClient } from '../api/client';
import { createSocialMethods, type TipSweepKeyImage } from '../api/social';

async function captureReport(
  call: (social: ReturnType<typeof createSocialMethods>) => Promise<unknown>,
): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; method: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured = {
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    };
    return new Response(JSON.stringify({ sweep_txid: 'ab'.repeat(32), status: 'claiming' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    await call(createSocialMethods(new ApiClient('http://test.local/api/v1')));
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!captured) throw new Error('fetch was never called');
  return captured;
}

const PROOF: TipSweepKeyImage = {
  output_key: '85'.repeat(32),
  key_image: '15'.repeat(32),
  proof: '66'.repeat(64),
};

test('a report with key images sends them under key_images', async () => {
  const { url, method, body } = await captureReport((social) =>
    social.confirmTipSweep('tip-1', 'ab'.repeat(32), [PROOF]),
  );
  assert.equal(method, 'POST');
  assert.equal(url, 'http://test.local/api/v1/tips/social/tip-1/confirm-sweep');
  assert.deepEqual(body, { sweep_txid: 'ab'.repeat(32), key_images: [PROOF] });
});

test('a report without key images is the v0.3.0 body, byte for byte in shape', async () => {
  for (const keyImages of [undefined, []]) {
    const { body } = await captureReport((social) =>
      social.confirmTipSweep('tip-1', 'cd'.repeat(32), keyImages),
    );
    assert.deepEqual(body, { sweep_txid: 'cd'.repeat(32) });
  }
});
