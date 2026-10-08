import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActionPopup } from '../surface';

const self = { name: 'this window' };
const other = { name: 'another view' };

test('the toolbar popup is an action popup', () => {
  assert.equal(isActionPopup(self, { getViews: () => [other, self] }), true);
});

test('a tab or pop-out window is not an action popup', () => {
  // getViews({ type: 'popup' }) lists action popups only; a window from
  // chrome.windows.create({ type: 'popup' }) is not among them.
  assert.equal(isActionPopup(self, { getViews: () => [other] }), false);
  assert.equal(isActionPopup(self, { getViews: () => [] }), false);
});

test('hosts without extension.getViews (desktop shim, tests) are not an action popup', () => {
  assert.equal(isActionPopup(self, undefined), false);
  assert.equal(isActionPopup(self, {}), false);
  assert.equal(isActionPopup(undefined, { getViews: () => [self] }), false);
});

test('a throwing getViews fails toward the measured layout', () => {
  assert.equal(
    isActionPopup(self, {
      getViews: () => {
        throw new Error('not available in this context');
      },
    }),
    false,
  );
});
