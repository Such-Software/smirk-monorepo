/**
 * Area H in-page guard. Both functions run INSIDE the page (Playwright
 * evaluate, or WebDriver executeScript after `String(fn)`), so each must stay
 * self-contained: no imports, no closures over module scope.
 *
 * `hSecretVerdict(rules)` answers with static labels only:
 *   { card: string[], mask: string[] }
 *   card: the whole frame must become a redaction card.
 *   mask: named surfaces the Chromium recorder masks (Firefox cards them).
 *
 * `hCanarySnapshot()` returns visible text and field values for the in-memory
 * canary in H-cross-browser-desktop-policy.mjs. The caller compares and
 * discards it; it is never written, logged or returned to a test report.
 */
export function hSecretVerdict(rules) {
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const card = new Set();
  const mask = new Set();
  const cardId = new RegExp(rules.cardTestId);
  const protectedId = new RegExp(rules.protectedTestId, 'i');
  const admitted = new RegExp(rules.admittedTestId);
  const privateKey = new RegExp(rules.privateKeyText);
  const claimLink = new RegExp(rules.claimLinkText);
  for (const element of document.querySelectorAll('[data-testid]')) {
    const id = element.getAttribute('data-testid') || '';
    if (!visible(element)) continue;
    if (cardId.test(id)) card.add(id.startsWith('settings-') ? 'Recovery phrase reveal' : 'Recovery phrase entry');
    else if (protectedId.test(id) && !admitted.test(id)) card.add('Protected surface');
  }
  for (const [kind, spec] of Object.entries(rules.masks)) {
    for (const element of document.querySelectorAll(spec.css)) {
      if (!visible(element)) continue;
      if (spec.whenFilled && !String(/** @type {HTMLInputElement} */ (element).value || '').length) continue;
      mask.add(kind);
      break;
    }
  }
  const text = document.body ? document.body.innerText || '' : '';
  if (privateKey.test(text)) card.add('Private key text');
  if (claimLink.test(text)) mask.add('Tip claim link text');
  for (const field of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input, textarea'))) {
    const value = String(field.value || '');
    if (value && visible(field) && (privateKey.test(value) || claimLink.test(value))) card.add('Secret-like field value');
  }
  // Most specific label first: it names the redaction card.
  const priority = ['Recovery phrase entry', 'Recovery phrase reveal', 'Private key text', 'Secret-like field value', 'Protected surface'];
  return { card: [...card].sort((a, b) => priority.indexOf(a) - priority.indexOf(b)), mask: [...mask].sort() };
}

export function hCanarySnapshot() {
  const values = [];
  for (const field of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input, textarea'))) {
    if (field.value) values.push(String(field.value));
  }
  return { text: document.body ? document.body.innerText || '' : '', values };
}

/**
 * Header hit test for the layout checks: every visible header (or sidebar)
 * button must sit on screen and receive a click at its centre. Labels are the
 * UI's own aria-labels; unlabeled buttons report a position index instead.
 */
export function hHeaderHitTest() {
  const shell = document.querySelector('[data-testid="app-shell-root"]');
  const layout = shell ? shell.getAttribute('data-layout') : null;
  const bar = document.querySelector('header') || document.querySelector('aside');
  const width = document.documentElement.clientWidth;
  const buttons = bar ? [...bar.querySelectorAll('button')] : [];
  const results = buttons
    .filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((button, index) => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hitElement = document.elementFromPoint(x, y);
      const label = (button.getAttribute('aria-label') || button.getAttribute('data-testid') || `button ${index + 1}`).replace(/[^A-Za-z0-9 -]/g, '').slice(0, 40);
      return {
        label,
        onScreen: box.left >= 0 && box.right <= width + 0.5 && box.top >= 0,
        hit: !!hitElement && (hitElement === button || button.contains(hitElement)),
      };
    });
  return { layout, bar: bar ? bar.tagName.toLowerCase() : null, width, buttons: results };
}
