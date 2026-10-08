import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPopoutViewport } from '../hooks';

// A window whose outer box reports the whole browser while its layout viewport
// is the popup, which is what a Firefox browser-action popup looks like.
function firefoxPopup(innerWidth: number) {
  return { innerWidth, outerWidth: 1440 } as unknown as Window;
}

test('a Firefox browser-action popup is not the pop-out layout', () => {
  // outerWidth is the main browser window; the popup's viewport is 380px.
  assert.equal(isPopoutViewport(firefoxPopup(380)), false);
});

test('a popup still sizing (zero viewport) is not the pop-out layout', () => {
  assert.equal(isPopoutViewport(firefoxPopup(0)), false);
});

test('a wide viewport (tab, desktop, wide window) is the pop-out layout', () => {
  assert.equal(isPopoutViewport({ innerWidth: 1024 } as Window), true);
});

test('the pop-out window opened at 480px wide keeps the popup layout', () => {
  // chrome.windows.create({ width: 480 }): unchanged from the outerWidth rule.
  assert.equal(isPopoutViewport({ innerWidth: 480 } as Window), false);
});

test('the threshold is exclusive and configurable', () => {
  assert.equal(isPopoutViewport({ innerWidth: 500 } as Window), false);
  assert.equal(isPopoutViewport({ innerWidth: 501 } as Window), true);
  assert.equal(isPopoutViewport({ innerWidth: 700 } as Window, 800), false);
});

test('no window (SSR) is not the pop-out layout', () => {
  assert.equal(isPopoutViewport(undefined), false);
});
