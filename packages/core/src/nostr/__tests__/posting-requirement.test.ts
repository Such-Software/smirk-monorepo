/**
 * `postingRequirement` must not re-derive posting rights the server already decided.
 *
 * The shipped version computed rights from `write_policy` + premium alone. That
 * is strictly less informed than the relay's own admission check
 * (`infra/relay/policy.rs` `decide`), which permits an operator write-allowlisted
 * npub to publish ANY kind regardless of policy or premium. The consequence was
 * reported from production: the instance operator, sitting on
 * `RELAY_WRITE_ALLOWLIST_NPUBS`, opened the Feed and was told "Posting to this
 * feed needs a premium subscription" with the composer hidden, while the relay
 * would have accepted the post. Client and server disagreed, and the client won.
 *
 * The fix publishes the DECISION (`can_post_general`) instead of the inputs. The
 * legacy derivation stays as a fallback so an older backend, which omits the
 * field, still behaves as before rather than failing open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postingRequirement } from '../notes';

const RELAY = 'wss://relay.example.test';

test('postingRequirement: reports no-relay when the operator serves no relay, whatever else is set', () => {
    assert.deepEqual(postingRequirement({ hasPremium: true, canPostGeneral: true }), {
      kind: 'no-relay',
    });
  });

test('postingRequirement: honours the server decision over the locally derived one', () => {
    // The regression: premium-post + no premium locally derives "needs-premium",
    // but the server says yes because the author is write-allowlisted.
    assert.deepEqual(postingRequirement({
        relayUrl: RELAY,
        writePolicy: 'premium-post',
        hasPremium: false,
        canPostGeneral: true,
      }), { kind: 'allowed' });
  });

test('postingRequirement: honours a server NO even when the client thinks premium is held', () => {
    // The mirror case: a lapsed or revoked subscription the client has cached as
    // active must not unlock a composer whose posts the relay will reject.
    assert.deepEqual(postingRequirement({
        relayUrl: RELAY,
        writePolicy: 'premium-post',
        hasPremium: true,
        canPostGeneral: false,
      }), { kind: 'needs-premium' });
  });

test('postingRequirement: falls back to the legacy derivation when the backend omits the decision', () => {
    // Federation: an older self-hosted backend does not send `can_post_general`.
    // Behaviour must be unchanged there, not fail-open.
    assert.deepEqual(postingRequirement({ relayUrl: RELAY, writePolicy: 'premium-post', hasPremium: false }), { kind: 'needs-premium' });
    assert.deepEqual(postingRequirement({ relayUrl: RELAY, writePolicy: 'premium-post', hasPremium: true }), { kind: 'allowed' });
    assert.deepEqual(postingRequirement({ relayUrl: RELAY, writePolicy: 'open', hasPremium: false }), 
      { kind: 'allowed' },
    );
  });

test('postingRequirement: treats an explicit false as a decision, not as "unset"', () => {
    // Guards the `!== undefined` check against being written as a truthiness
    // test, which would silently drop every server NO.
    assert.deepEqual(postingRequirement({
        relayUrl: RELAY,
        writePolicy: 'open',
        hasPremium: true,
        canPostGeneral: false,
      }), { kind: 'needs-premium' });
  });
