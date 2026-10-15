// The F footage reaches a self-closing Send receipt in time, and what it
// records passes the encoder's policy audit.
// Run: node --import tsx --test packages/e2e/fixtures/F-legacy-recovery-footage.test.mjs
//
// The page is a stand-in for Send's last steps with the real test ids and the
// receipt's real rule: it closes itself 12 s after it shows unless "Stay on
// this screen" is tapped (SendWizard.tsx AUTO_DISMISS_SECS). Recording is on,
// into a temporary directory; the holds are the real ones, so this takes about
// 20 s.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const footageDir = mkdtempSync(join(tmpdir(), 'f-legacy-footage-'));
process.env.FOOTAGE = 'guarded';
process.env.E2E_FOOTAGE_DIR = footageDir;
const { WalletFootage } = await import('./F-legacy-recovery-footage.ts');
const { createCanary } = await import('./F-legacy-recovery-guard.mjs');
const { auditTimeline } = await import('../scripts/F-legacy-recovery-encode.mjs');

const SEND = String.raw`<!doctype html><html><body><div id="root"></div><script>
window.__receiptShownAt = null;
const root = document.getElementById('root');
let timer = null;
function review() {
  root.innerHTML = '<p>Review</p><button data-testid="send-review-submit">Send</button>';
  root.querySelector('button').onclick = () => { root.innerHTML = '<p>Sending…</p>'; setTimeout(receipt, 300); };
}
function receipt() {
  window.__receiptShownAt = Date.now();
  root.innerHTML = '<p>Sent</p><span data-testid="send-done-txid">' + 'ab'.repeat(32) + '</span>'
    + '<button id="stay">Stay on this screen</button><button data-testid="send-done-close">Done</button>';
  timer = setTimeout(home, 12_000);
  document.getElementById('stay').onclick = () => { clearTimeout(timer); document.getElementById('stay').remove(); };
}
function home() { root.innerHTML = '<div data-testid="home-total-balance">$1</div>'; }
review();
</script></body></html>`;

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  rmSync(footageDir, { recursive: true, force: true });
});

test('a recorded send reaches its self-closing receipt, stops it in time, and the timeline passes the audit', async () => {
  const page = await browser.newPage();
  await page.setContent(SEND);
  const footage = new WalletFootage('alice', createCanary());
  footage.attach(page);
  try {
    await footage.tapIntoCountdown(page.getByTestId('send-review-submit'), 'Send: broadcast');
    const txid = page.getByTestId('send-done-txid');
    await txid.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match((await txid.textContent()) ?? '', /^[0-9a-f]{64}$/, 'the txid is read while the receipt shows');
    await footage.tapOnCountdown(page.getByRole('button', { name: 'Stay on this screen' }), 'Stay on the receipt');
    const shownAt = await page.evaluate(() => window.__receiptShownAt);
    assert.ok(Date.now() - shownAt > 12_000, 'the settled hold ran past the receipt countdown');
    assert.equal(await txid.isVisible(), true, 'the receipt stayed because its countdown was stopped');
  } finally {
    await footage.close();
    await page.close();
  }
  const [session] = readdirSync(join(footageDir, 'raw', 'F-legacy-recovery', 'alice'));
  const dir = join(footageDir, 'raw', 'F-legacy-recovery', 'alice', session);
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
  assert.deepEqual(timeline.steps.map((s) => s.urgent), ['countdown', 'countdown'], 'both countdown steps are recorded as such');
  assert.deepEqual(auditTimeline(timeline, dir), []);
});
