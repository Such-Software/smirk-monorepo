import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showStartupError } from '../startup-error';

test('startup failure renders text nodes without parsing exception content as HTML', () => {
  const nodes: { textContent: string; children: unknown[]; style: { cssText: string } }[] = [];
  const document = { createElement() {
    const node = { textContent: '', children: [] as unknown[], style: { cssText: '' }, append(...children: unknown[]) { this.children.push(...children); } };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('HTML parsing must not occur'); } });
    nodes.push(node);
    return node;
  } };
  let displayed: unknown;
  const root = { ownerDocument: document, replaceChildren(panel: unknown) { displayed = panel; } };
  showStartupError(root as unknown as HTMLElement, 'wallet interface');
  assert.ok(displayed);
  assert.ok(nodes.some(node => node.textContent.includes('wallet interface')));
  assert.ok(nodes.some(node => node.textContent.includes('reopen')));
});
