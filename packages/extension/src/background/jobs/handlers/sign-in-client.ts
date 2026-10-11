/**
 * The client a background sign-in talks through: one per job, bound to the
 * backend the job names, for every request the sign-in makes.
 *
 * The handler used to call the context's shared `api` singleton, and stamp the
 * job's result with where that singleton pointed before the first request.
 * Other work re-points that singleton while a sign-in is awaiting the network:
 * the service worker follows another window's switch or reset, and in Chrome's
 * offscreen document each later job request points the one singleton at its
 * own backend. A sign-in could then check restore state at one backend and
 * register at another, sending that backend this window's invite code, payment
 * invoice and backend-bound rotation proof, while its result named the first
 * backend as the one that minted the token. A client of its own cannot move.
 *
 * An object with a method rather than a bare function so tests can replace it
 * with `t.mock.method`.
 */
import { SmirkApi } from '@smirk/core';

import type { JobBackend } from '../types';

export const signInClients = {
  /** A new client bound to `backend` for the life of one sign-in. */
  for(backend: JobBackend): SmirkApi {
    const client = new SmirkApi(backend.url);
    client.setWalletApiStyle(backend.apiStyle);
    return client;
  },
};
