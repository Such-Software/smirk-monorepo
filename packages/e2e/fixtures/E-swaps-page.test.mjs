// The E-swaps page-side readers, in real Chromium, on markup shaped like the
// wallet's: Send's Review rows (CSS-uppercased labels), the swap pair step,
// and loading text on the Swap tab.
// Run: npm run test:e-swaps-guards -w @smirk/e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { armQuoteWatch, loadingProbe, quoteState, reviewRow } from './E-swaps-page.mjs';

const LOADING = 'Updating…|Loading|Checking THORChain…|Checking NonLogs…|Quoting…';
const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// As SendWizard's ReviewRow renders: a label span uppercased by CSS over a value span.
const row = (label, value) =>
  `<div style="display:flex;flex-direction:column"><span style="font-size:11px;text-transform:uppercase">${label}</span><span style="font-family:monospace;word-break:break-all">${value}</span></div>`;
const review = (...rows) => `<div><h2>Review</h2>${rows.join('')}<button data-testid="send-review-submit">Send</button></div>`;

async function withPage(fn) {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    await fn(await browser.newPage());
  } finally {
    await browser.close();
  }
}

test("Review rows are read by their own label, though CSS uppercases it", async () => {
  await withPage(async (page) => {
    await page.setContent(review(row('Asset', 'Bitcoin (BTC)'), row('Amount', '0.00015'), row('To', ADDRESS), row('Network fee', '~0.00000420 BTC')));
    // The reviewer's finding: innerText shows the label as CSS does.
    const shown = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(shown, /\nTo\s+\S+/, 'innerText does not carry the label as written');
    assert.equal(await page.evaluate(reviewRow, 'To'), ADDRESS);
    assert.equal(await page.evaluate(reviewRow, 'Amount'), '0.00015');
    assert.equal(await page.evaluate(reviewRow, 'Asset'), 'Bitcoin (BTC)');
    // Ambiguous or absent rows read as nothing, so the Send tap is refused.
    await page.setContent(review(row('To', ADDRESS), row('To', 'bc1qanother')));
    assert.equal(await page.evaluate(reviewRow, 'To'), null);
    await page.setContent(review(row('Amount', '0.00015')));
    assert.equal(await page.evaluate(reviewRow, 'To'), null);
  });
});

test('loading text is seen in text nodes, and a live card keeps no load open', async () => {
  await withPage(async (page) => {
    const cases = [
      ['plain loading text', '<p>Loading…</p>', true],
      ['loading text under CSS uppercase', '<span style="text-transform:uppercase">Updating…</span>', true],
      ['hidden loading text', '<p style="display:none">Loading…</p>', false],
      ['a settled screen', '<p>Balance 0.1 XMR</p>', false],
      ['NonLogs still checking', '<button data-testid="swap-provider-nonlogs"><div>Order-book exchange.</div><div>Checking NonLogs…</div></button>', true],
      ['a live NonLogs card with its first note left on', '<button data-testid="swap-provider-nonlogs"><div>Order-book exchange. Live now: BTC, XMR.</div><div>Checking NonLogs…</div></button>', false],
      [
        'THORChain checking while NonLogs is live',
        '<button data-testid="swap-provider-thorchain"><div>Cross-chain pools.</div><div>Checking THORChain…</div></button><button data-testid="swap-provider-nonlogs"><div>Live now: BTC, XMR.</div></button>',
        true,
      ],
    ];
    for (const [name, html, loading] of cases) {
      await page.setContent(html);
      assert.equal(await page.evaluate(loadingProbe, LOADING), loading, name);
    }
  });
});

test('a quote outcome is read from what the pair step did after the tap', async () => {
  await withPage(async (page) => {
    const pairStep = '<div data-testid="swap-wizard-step">1/4</div><div id="step"><div><span>To</span></div><button data-testid="swap-pair-get-quote">Get quote</button></div>';
    // Refused: the button went busy, came back, and an error sits above it.
    await page.setContent(pairStep);
    await page.evaluate(armQuoteWatch);
    assert.equal((await page.evaluate(quoteState)).started, false, 'nothing happened yet');
    await page.evaluate(() => {
      document.querySelector('[data-testid="swap-pair-get-quote"]').textContent = 'Quoting…';
    });
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="swap-pair-get-quote"]');
      const error = document.createElement('div');
      error.textContent = 'THORChain needs at least 21000 atomic units of BTC for this swap.';
      button.before(error);
      button.textContent = 'Get quote';
    });
    const refused = await page.evaluate(quoteState);
    assert.equal(refused.started, true);
    assert.equal(refused.button, 'Get quote');
    assert.match(refused.error ?? '', /needs at least \d+ atomic units/);
    // Quoted: the step moved on and the button is gone.
    await page.setContent(pairStep);
    await page.evaluate(armQuoteWatch);
    await page.evaluate(() => {
      document.querySelector('#step').remove();
      document.querySelector('[data-testid="swap-wizard-step"]').textContent = '2/4';
    });
    const quoted = await page.evaluate(quoteState);
    assert.equal(quoted.step, '2/4');
    assert.equal(quoted.started, true);
    // An element row above the button is not an error.
    await page.setContent(pairStep);
    assert.equal((await page.evaluate(quoteState)).error, null);
  });
});
