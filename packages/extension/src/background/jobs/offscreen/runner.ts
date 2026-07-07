/**
 * Offscreen-document runner — receives `OffscreenJobRequest` messages
 * from the SW coordinator, dispatches to the matching handler in
 * `handlers/registry.ts`, and posts results back.
 *
 * The runner lives in an offscreen document (a hidden full-DOM page
 * Chrome lets MV3 extensions create) for two reasons:
 *
 *   1. **Survives SW eviction.** If the toolbar popup closes mid-
 *      job the SW's port disconnects and the SW becomes evictable.
 *      The offscreen document is a regular Chrome render process —
 *      it keeps running until the SW explicitly closes it.
 *   2. **Access to Web Crypto + Workers.** `crypto.subtle` is
 *      available inside the SW too, but `altcha-lib`'s solver
 *      sometimes wants Workers (and future handlers — Grin
 *      finalize, etc. — definitely will). The offscreen doc gets
 *      both.
 *
 * The runner is intentionally chatty about logging — it's the one
 * piece of the system the user can't see, so console output to its
 * own DevTools is the only way to debug a stuck solve.
 */

import { initSmirkApi } from '@smirk/core';

import { bootBackendSelection } from '../../../backend-boot';

import { HANDLERS } from '../handlers/registry';
import type {
  JobContext,
  JobKind,
  OffscreenJobRequest,
  OffscreenJobResponse,
} from '../types';

// The offscreen document is a SEPARATE JS context with its own `@smirk/core`
// `api` singleton, so it must be pointed at the configured backend exactly like
// the SW (background/index.ts) and the popup (popup/index.tsx). Without this,
// bootstrap-auth — which runs HERE — registers/authenticates against the
// production default (backend.smirk.cash) regardless of VITE_SMIRK_BACKEND_URL,
// which silently breaks every self-hosted / non-production deployment (the token
// it returns is then rejected by the actual configured backend). It happens to
// be masked in production only because the default already IS production.
bootBackendSelection();

// Track in-flight aborts so a 'cancel' from the SW (via a future
// message, not implemented today) can stop a running job.
const running = new Map<string, AbortController>();

function send(message: OffscreenJobResponse): void {
  chrome.runtime.sendMessage(message).catch((e: unknown) => {
    console.error('[smirk-jobs-offscreen] sendMessage failed:', e);
  });
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return false;
  const req = message as OffscreenJobRequest;
  if (req.type !== 'run') return false;

  // Point this offscreen context's api singleton at the backend the SW resolved
  // (forwarded on the request because the offscreen can't read chrome.storage).
  // Without this, bootstrap-auth would target the build default even on a
  // self-hosted backend and return a token the real backend rejects.
  if (req.backend?.url) {
    initSmirkApi({ baseUrl: req.backend.url, walletApiStyle: req.backend.apiStyle });
  }

  const handler = HANDLERS[req.kind as JobKind];
  if (!handler) {
    send({
      type: 'error',
      id: req.id,
      error: {
        code: 'UNKNOWN_KIND',
        message: `no handler registered for kind '${String(req.kind)}'`,
      },
    });
    return false;
  }

  const controller = new AbortController();
  running.set(req.id, controller);

  const ctx: JobContext = {
    id: req.id,
    signal: controller.signal,
    reportProgress(progress) {
      send({ type: 'progress', id: req.id, progress });
    },
  };

  // Cast is needed because `handler.run` is parameterised on the
  // specific `JobKind` but our message stream is the union; the
  // type system can't see that we just looked it up by exact kind.
  (handler.run as (input: unknown, ctx: JobContext) => Promise<unknown>)(
    req.input,
    ctx,
  )
    .then((result) => {
      running.delete(req.id);
      send({ type: 'done', id: req.id, result });
    })
    .catch((e: unknown) => {
      running.delete(req.id);
      const message = e instanceof Error ? e.message : String(e);
      send({
        type: 'error',
        id: req.id,
        error: { code: 'HANDLER_THREW', message },
      });
    });

  // Don't return true — we never use sendResponse here, only the
  // unsolicited messages above.
  return false;
});

console.debug('[smirk-jobs-offscreen] runner ready');
