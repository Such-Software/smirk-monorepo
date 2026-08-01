/**
 * A connected site must not be able to mint a login token for the user's own
 * wallet backend through `signEvent`.
 *
 * `POST /auth/nostr` mints a full session from a kind-27235 (NIP-98) event whose
 * `u` tag matches the server's canonical URL. There is no nonce and the window is
 * 30 seconds, so the signed event IS the credential. Nothing inspected the kind
 * or tags before signing, so a site holding an ordinary `nostr` grant could ask
 * for "a Nostr event", receive a valid sign-in token for the user's account, and
 * replay it. The BTC surface has refused the equivalent (`smirk-auth-*` messages)
 * since the auth-replay hardening; this is the same boundary on the Nostr side.
 *
 * The guard is deliberately narrow: NIP-98 for a THIRD-PARTY service is a normal
 * thing for a dapp to request and must keep working. Only our own backend's host
 * is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, deriveNostrIdentity } from '@smirk/core';
import { signNostrEventWith } from '../signers';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const identity = deriveNostrIdentity(TEST_MNEMONIC, 0);

/** Point the api singleton at a known backend so `getBaseUrl()` is deterministic. */
api.setBaseUrl('https://api.smirk.cash/api/v1');

const ev = (kind: number, tags: string[][]) => ({
  kind,
  tags,
  content: '',
  created_at: Math.floor(Date.now() / 1000),
});

test('refuses a NIP-98 token aimed at our own backend host', () => {
  assert.throws(
    () =>
      signNostrEventWith(
        identity,
        ev(27235, [
          ['u', 'https://api.smirk.cash/auth/nostr'],
          ['method', 'POST'],
        ]),
      ),
    /sign-in token/i,
  );
});

test('refuses regardless of path, since the host is what the backend binds', () => {
  assert.throws(
    () => signNostrEventWith(identity, ev(27235, [['u', 'https://api.smirk.cash/anything']])),
    /sign-in token/i,
  );
});

test('refuses a NIP-98 event with no `u` tag rather than signing blind', () => {
  // Without a `u` tag we cannot prove it is not aimed at us, so fail closed.
  assert.throws(
    () => signNostrEventWith(identity, ev(27235, [['method', 'GET']])),
    /no `u` tag/i,
  );
});

test('refuses an unparseable `u` tag rather than letting it through', () => {
  assert.throws(
    () => signNostrEventWith(identity, ev(27235, [['u', 'not a url']])),
    /unparseable/i,
  );
});

test('still signs NIP-98 for a third-party service', () => {
  // The legitimate case the guard must not break.
  const signed = signNostrEventWith(
    identity,
    ev(27235, [
      ['u', 'https://someone-else.example/api/login'],
      ['method', 'POST'],
    ]),
  );
  assert.ok(signed.sig);
  assert.equal(signed.kind, 27235);
});

test('leaves ordinary event kinds alone', () => {
  const signed = signNostrEventWith(identity, ev(1, []));
  assert.ok(signed.sig);
});
