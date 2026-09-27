import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

// Execute the bundled browser code. A source-only import would miss a package
// specifier left unresolved in the shipped webview, the original failure.
const bundle = await build({
  stdin: {
    contents: `
      export { installDesktopHttp } from '../native-http';
      export { nativeFetch } from '../../../extension/src/popup/native-fetch';
      export { TrocadorSwap } from '../../../swap/src/trocador';
    `,
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  globalName: 'probe',
  write: false,
});

type Probe = {
  installDesktopHttp(): void;
  nativeFetch(): typeof fetch | undefined;
  TrocadorSwap: typeof import('../../../swap/src/trocador').TrocadorSwap;
};

function bundledProbe(invoke?: (command: string, args: any) => Promise<unknown>) {
  let browserRequests = 0;
  const context = createContext({
    Headers, Request, Response, ReadableStream, URLSearchParams, Uint8Array,
    fetch: async () => {
      browserRequests += 1;
      throw new Error('Webview fetch is blocked by CORS.');
    },
  });
  context.window = context;
  if (invoke) context.__TAURI_INTERNALS__ = { invoke };
  runInContext(bundle.outputFiles[0]!.text, context);
  return { probe: context.probe as Probe, browserRequests: () => browserRequests };
}

test('extension keeps its browser transport without importing Tauri at runtime', () => {
  const { probe } = bundledProbe();
  assert.equal(probe.nativeFetch(), undefined);
});

test('desktop refuses quotes when its native transport was not installed', () => {
  const { probe, browserRequests } = bundledProbe(async () => undefined);
  assert.throws(() => probe.nativeFetch(), /connection.+start/i);
  assert.equal(browserRequests(), 0);
});

test('the first desktop quote uses the bundled native transport', async () => {
  let request: { method: string; url: string; headers: [string, string][] } | undefined;
  let bodySent = false;
  const response = JSON.stringify({
    trade_id: 'test-trade',
    quotes: {
      quotes: [{
        provider: 'test-provider', amount_to: '0.25', eta: 3,
        amount_from_USD: '75', amount_to_USD: '74',
      }],
    },
  });
  const { probe, browserRequests } = bundledProbe(async (command, args) => {
    switch (command) {
      case 'plugin:http|fetch':
        request = args.clientConfig;
        return 1;
      case 'plugin:http|fetch_send':
        return {
          status: 200, statusText: 'OK', url: request!.url,
          headers: [['content-type', 'application/json']], rid: 2,
        };
      case 'plugin:http|fetch_read_body':
        if (bodySent) return [1];
        bodySent = true;
        return [...new TextEncoder().encode(response), 0];
      default:
        throw new Error(`Unexpected native command: ${command}`);
    }
  });

  probe.installDesktopHttp();
  const native = probe.nativeFetch();
  assert.ok(native);
  const swap = new probe.TrocadorSwap({ apiKey: 'test-affiliate', fetch: native });
  const quote = await swap.quote({ fromAsset: 'ltc', toAsset: 'xmr', fromAmount: '100000000' });

  assert.ok(request);
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://api.trocador.app');
  assert.equal(url.pathname, '/new_rate');
  assert.equal(url.searchParams.get('amount_from'), '1');
  assert.equal(request.method, 'GET');
  assert.equal(new Headers(request.headers).get('API-Key'), 'test-affiliate');
  assert.equal(quote.toAmountEstimate, '250000000000');
  assert.equal(quote.implementationData && (quote.implementationData as { provider: string }).provider, 'test-provider');
  assert.equal(browserRequests(), 0);
});
