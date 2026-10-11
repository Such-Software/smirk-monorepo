import { test as base } from '@playwright/test';
import { assertPrivateCapture, sanitizeTestErrors } from '../capture-policy.mjs';
import { attachPrivateContext } from './failure-context.js';

// Playwright otherwise creates an accessibility snapshot after a failed test,
// even with trace, screenshots and video disabled. Regression-test this hook.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export const test = base.extend<{ privateOutput: void }>({
  privateOutput: [async ({ trace, screenshot, video }, use, testInfo) => {
    assertPrivateCapture({ trace, screenshot, video });
    try {
      await use();
    } finally {
      // The value-free explanation (error class, step label, screen test ids,
      // request shapes, recoveries) is read before the errors are withheld,
      // and goes only to the private reporter's log.
      try {
        await attachPrivateContext(testInfo);
      } finally {
        sanitizeTestErrors(testInfo);
      }
    }
  }, { auto: true }],
});
