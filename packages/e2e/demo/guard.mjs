/**
 * The demo-capture secret guard. `secretSurface` runs inside the page (it must
 * stay self-contained) and returns a short label for the first visible secret
 * surface, or null. Labels name the kind of surface, never its content.
 */
export const PRIVATE_TEXT = {
  testId: '(mnemonic|seed|recovery|backup|export|reveal|nsec|private|secret|password|unlock|onboarding|import-word)',
  text: '(nsec1[02-9ac-hj-np-z]{20,}|[xtyz]prv[1-9A-HJ-NP-Za-km-z]{20,})',
  // Buttons that only REQUEST a secret (behind a password prompt) are safe to
  // show. Anything they reveal is caught by the other rules.
  allowedButton: '^(nostr-reveal-[0-9a-f]{64}|nostr-export-backup)$',
  // Import fields are safe only while EMPTY; any content refuses.
  allowedEmptyInput: '^nostr-import-nsec$',
};

export function secretSurface(patterns) {
  const testId = new RegExp(patterns.testId, 'i');
  const text = new RegExp(patterns.text);
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const emptyAllowed = new RegExp(patterns.allowedEmptyInput);
  const password = [...document.querySelectorAll('input[type="password"]')].find((element) => visible(element)
    && !(element.value === '' && emptyAllowed.test(element.dataset.testid ?? '')));
  if (password) {
    const holder = password.dataset.testid ? password : password.closest('[data-testid]');
    return `a password field (${holder ? holder.dataset.testid.replace(/[^a-z-]/gi, '').slice(0, 40) : 'no test id'})`;
  }
  const allowedButton = new RegExp(patterns.allowedButton);
  const allowedEmptyInput = new RegExp(patterns.allowedEmptyInput);
  const marked = [...document.querySelectorAll('[data-testid]')].filter((element) => testId.test(element.dataset.testid) && visible(element)
    && !(element.tagName === 'BUTTON' && allowedButton.test(element.dataset.testid))
    && !(element.tagName === 'INPUT' && element.value === '' && allowedEmptyInput.test(element.dataset.testid)));
  if (marked.length) return `protected surfaces: ${marked.slice(0, 12).map((element) => `${element.tagName.toLowerCase()}#${element.dataset.testid.replace(/[^a-z-]/gi, '').slice(0, 40)}`).join(', ')}`;
  if (text.test(document.body?.innerText ?? '')) return 'private-key-like text';
  return null;
}
