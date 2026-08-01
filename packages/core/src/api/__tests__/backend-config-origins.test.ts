/**
 * A self-hoster must be able to point the wallet at their own instance.
 *
 * The https requirement (loopback exempt) meant "run your own backend" only
 * actually worked for someone with a public domain and a CA certificate. Two
 * common self-hosting shapes were rejected outright:
 *
 *  - `.onion`, which no CA will issue for, and which carries its own transport
 *    authentication and encryption; Tor Browser and arti treat http onions as
 *    secure origins.
 *  - a box on your own LAN (RFC1918 or `.local`), which is how most people run
 *    a home server.
 *
 * These assert the URL policy only, so `fetch` is stubbed to fail immediately:
 * an ACCEPTED url goes on to probe `/capabilities`, and a LAN address with
 * nothing listening would otherwise hang until the test timed out.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectBackend } from '../backend-config';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error('network disabled in this test');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Did it fail on URL validation, as opposed to getting far enough to probe? */
async function rejectedByPolicy(url: string): Promise<boolean> {
  const r = await connectBackend(url);
  return r.ok === false && /must use https/i.test(r.error ?? '');
}

test('origin policy: still rejects plain http on a public host', async () => {
  // The case the rule exists for: cleartext to a public domain.
  assert.equal(await rejectedByPolicy('http://example.com'), true);
});

test('origin policy: accepts onion addresses', async () => {
  assert.equal(
    await rejectedByPolicy(
      'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion',
    ),
    false,
  );
  assert.equal(await rejectedByPolicy('http://abcdefghijklmnop.onion:8080'), false);
});

test('origin policy: accepts RFC1918 LAN addresses', async () => {
  for (const host of ['http://192.168.1.50:8080', 'http://10.0.0.7', 'http://172.16.4.2:3000']) {
    assert.equal(await rejectedByPolicy(host), false, host);
  }
});

test('origin policy: does not treat 172.32.x as private (172.16/12 boundary)', async () => {
  assert.equal(await rejectedByPolicy('http://172.32.0.1'), true);
});

test('origin policy: accepts mDNS .local hosts', async () => {
  assert.equal(await rejectedByPolicy('http://smirk-box.local:8080'), false);
});

test('origin policy: still accepts loopback and https', async () => {
  assert.equal(await rejectedByPolicy('http://127.0.0.1:8080'), false);
  assert.equal(await rejectedByPolicy('https://api.example.org'), false);
});

test('origin policy: does not let an onion-lookalike domain through', async () => {
  // `.onion.example.com` is a normal public host and must not be exempted.
  assert.equal(await rejectedByPolicy('http://abcdefghijklmnop.onion.example.com'), true);
});
