/**
 * NonLogs pays out and refunds to addresses fixed at creation. The wallet
 * names only its own: anything else is refused before the swap is created.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownAddressesOnly } from '../nonlogs';

const own = { ownTo: 'WoOwnReceive', ownFrom: 'bc1ownrefund' };

test('the wallet own addresses pass', () => {
  assert.equal(ownAddressesOnly({ toAddress: 'WoOwnReceive', refundAddress: 'bc1ownrefund', ...own }), null);
});

test('a pasted payout address is refused', () => {
  assert.match(ownAddressesOnly({ toAddress: 'WoSomeoneElse', refundAddress: 'bc1ownrefund', ...own }) ?? '', /pay only to this wallet/);
});

test('a pasted refund address is refused', () => {
  assert.match(ownAddressesOnly({ toAddress: 'WoOwnReceive', refundAddress: 'bc1other', ...own }) ?? '', /refunds only to this wallet/);
});

test('a coin the wallet has no address for is refused', () => {
  assert.ok(ownAddressesOnly({ toAddress: 'x', refundAddress: 'y', ownTo: undefined, ownFrom: 'y' }));
});
