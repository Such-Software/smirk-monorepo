import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, type ApiResponse, type WalletApiStyle } from '../api/client';
import { createWalletLwsMethods } from '../api/wallet-lws';

class ReplyClient extends ApiClient {
  constructor(style: WalletApiStyle, private reply: unknown) {
    super('https://wallet.invalid/api/v1');
    this.setWalletApiStyle(style);
  }
  override async request<T>(): Promise<ApiResponse<T>> {
    return { data: this.reply as T, status: 200 };
  }
}

for (const style of ['flat', 'namespaced'] as const) {
  test(`${style} registration normalizes only an explicit backend acknowledgement`, async () => {
    const field = style === 'flat' ? 'success' : 'ok';
    for (const flag of [undefined, false, 'false', 'true', 1, null]) {
      const client = new ReplyClient(style, { [field]: flag });
      const result = await createWalletLwsMethods(client).registerLws('user', 'xmr', 'address', '', 0);
      assert.ok(result.error);
      assert.ok(result.data === undefined);
    }
    for (const startHeight of [0, null, undefined]) {
      const client = new ReplyClient(style, { [field]: true, start_height: startHeight });
      const result = await createWalletLwsMethods(client).registerLws('user', 'xmr', 'address', '', 0);
      assert.equal(result.data?.success, true);
      assert.equal(result.data?.start_height, startHeight ?? undefined);
    }
  });
}
