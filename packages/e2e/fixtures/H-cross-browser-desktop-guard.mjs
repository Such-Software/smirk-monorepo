/**
 * Area H in-page guard. Both functions run INSIDE the page (Playwright
 * evaluate, or WebDriver executeScript after `String(fn)`), so each must stay
 * self-contained: no imports, no closures over module scope.
 *
 * `hSecretVerdict(rules)` answers with static labels only:
 *   { card: string[], mask: string[] }
 *   card: the whole frame must become a redaction card. Rendered anywhere in
 *         the page counts, on screen or not (fail closed).
 *   mask: named surfaces that intersect the viewport. Chromium masks them in
 *         the screenshot; Firefox covers them with hMaskOverlay and proves the
 *         cover with hMaskCovered. A surface scrolled out of the viewport is
 *         not in the screenshot, so it needs no mask (the Settings root always
 *         renders its reveal password field, usually below the fold).
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
  const inViewport = (element) => {
    const box = element.getBoundingClientRect();
    return box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight;
  };
  const card = new Set();
  const mask = new Set();
  const cardId = new RegExp(rules.cardTestId);
  const protectedId = new RegExp(rules.protectedTestId, 'i');
  const admitted = new RegExp(rules.admittedTestId);
  const privateKey = new RegExp(rules.privateKeyText);
  const keyPanel = new RegExp(rules.privateKeyPanelText, 'i');
  const longHex = new RegExp(rules.settingsHexText, 'i');
  const claimLink = new RegExp(rules.claimLinkText);
  let settingsShown = false;
  for (const element of document.querySelectorAll('[data-testid]')) {
    const id = element.getAttribute('data-testid') || '';
    if (!visible(element)) continue;
    if (id.startsWith('settings-')) settingsShown = true;
    if (cardId.test(id)) card.add(id.startsWith('settings-') ? 'Recovery phrase reveal' : 'Recovery phrase entry');
    else if (protectedId.test(id) && !admitted.test(id)) card.add('Protected surface');
  }
  for (const [kind, spec] of Object.entries(rules.masks)) {
    for (const element of document.querySelectorAll(spec.css)) {
      if (!visible(element) || !inViewport(element)) continue;
      if (spec.whenFilled && !String(/** @type {HTMLInputElement} */ (element).value || '').length) continue;
      mask.add(kind);
      break;
    }
  }
  const text = document.body ? document.body.innerText || '' : '';
  if (privateKey.test(text)) card.add('Private key text');
  if (keyPanel.test(text)) card.add('Private key panel');
  if (settingsShown && longHex.test(text)) card.add('Long hex in Settings');
  if (claimLink.test(text)) mask.add('Tip claim link text');
  for (const field of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input, textarea'))) {
    const value = String(field.value || '');
    if (value && visible(field) && (privateKey.test(value) || claimLink.test(value))) card.add('Secret-like field value');
  }
  // Most specific label first: it names the redaction card.
  const priority = ['Recovery phrase entry', 'Recovery phrase reveal', 'Private key text', 'Private key panel', 'Long hex in Settings', 'Secret-like field value', 'Protected surface'];
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
 * Firefox (WebDriver) has no screenshot masks, so the recorder covers each
 * masked surface with an opaque box for the one screenshot and removes it
 * after. `hMaskOverlay(selectors, color, token)` draws the boxes (and drops
 * any left over from an earlier frame); `hMaskCovered(selectors, token)` then
 * proves every in-viewport match is under a box, by geometry and by asking
 * the page what is topmost at its centre and corners (a top-layer dialog would
 * win there, and the frame becomes a card); `hMaskRemove(token)` takes them
 * away. The boxes take pointer events only for the instant they exist, inside
 * the recorder's exclusive section, so no action can land on them.
 */
export function hMaskOverlay(selectors, color, token) {
  for (const old of document.querySelectorAll('[data-h-mask]')) old.remove();
  const host = document.createElement('div');
  host.setAttribute('data-h-mask', token);
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  let boxes = 0;
  for (const css of selectors) {
    for (const element of document.querySelectorAll(css)) {
      const r = element.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;`
        + `background:${color};opacity:1;pointer-events:auto;margin:0;padding:0;border:0;transform:none;z-index:2147483647;`;
      host.appendChild(box);
      boxes++;
    }
  }
  document.documentElement.appendChild(host);
  return boxes;
}

export function hMaskCovered(selectors, token) {
  const host = document.querySelector(`[data-h-mask="${token}"]`);
  if (!host) return false;
  const boxes = [...host.children].map((box) => box.getBoundingClientRect());
  const width = window.innerWidth;
  const height = window.innerHeight;
  for (const css of selectors) {
    for (const element of document.querySelectorAll(css)) {
      const r = element.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= width || r.top >= height) continue;
      if (!boxes.some((b) => b.left <= r.left && b.top <= r.top && b.right >= r.right && b.bottom >= r.bottom)) return false;
      const clampX = (x) => Math.min(Math.max(x, 0), width - 1);
      const clampY = (y) => Math.min(Math.max(y, 0), height - 1);
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1],
      ];
      for (const [x, y] of points) {
        const top = document.elementFromPoint(clampX(x), clampY(y));
        if (!top || !host.contains(top)) return false;
      }
    }
  }
  return true;
}

export function hMaskRemove(token) {
  for (const host of document.querySelectorAll(token ? `[data-h-mask="${token}"]` : '[data-h-mask]')) host.remove();
  return document.querySelectorAll('[data-h-mask]').length === 0;
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
