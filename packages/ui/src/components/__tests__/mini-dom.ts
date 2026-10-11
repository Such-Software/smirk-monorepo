/**
 * A minimal DOM that Preact can render into, for component tests that need
 * effects, state and clicks without a jsdom dependency.
 *
 * It models only what Preact's diff touches (create, insert, remove, text,
 * attributes, inline style, listeners) plus the read helpers the tests use.
 * One browser rule is modelled on purpose: a click on a disabled button does
 * nothing, so a test cannot press a Send the user could not press.
 *
 * Not a general DOM. Anything outside that surface is absent rather than
 * faked, so a component that reaches for more fails loudly in the test.
 */

type Listener = (this: MiniNode, event: MiniEvent) => unknown;

export interface MiniEvent {
  type: string;
  target: MiniNode;
  currentTarget: MiniNode;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export class MiniNode {
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  constructor(readonly nodeType: number) {}

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  insertBefore(node: MiniNode, ref: MiniNode | null): MiniNode {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node: MiniNode): MiniNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: MiniNode): MiniNode {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
}

export class MiniText extends MiniNode {
  constructor(public data: string) {
    super(3);
  }

  override get textContent(): string {
    return this.data;
  }
}

export class MiniElement extends MiniNode {
  readonly attributes: Array<{ name: string; value: string }> = [];
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void; cssText: string };
  readonly listeners = new Map<string, Set<Listener>>();
  // Present so Preact lower-cases these handler names, as it does in a browser.
  onclick = null;
  oninput = null;
  onchange = null;
  onkeydown = null;
  onsubmit = null;

  constructor(
    readonly localName: string,
    readonly namespaceURI: string | null = 'http://www.w3.org/1999/xhtml',
  ) {
    super(1);
    const style = {} as Record<string, string>;
    Object.defineProperty(style, 'setProperty', {
      value: (k: string, v: string) => {
        style[k] = v;
      },
    });
    Object.defineProperty(style, 'cssText', { value: '', writable: true });
    this.style = style as MiniElement['style'];
  }

  get nodeName(): string {
    return this.localName.toUpperCase();
  }

  setAttribute(name: string, value: unknown): void {
    const text = String(value);
    const existing = this.attributes.find((a) => a.name === name);
    if (existing) existing.value = text;
    else this.attributes.push({ name, value: text });
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.some((a) => a.name === name);
  }

  removeAttribute(name: string): void {
    const at = this.attributes.findIndex((a) => a.name === name);
    if (at >= 0) this.attributes.splice(at, 1);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
}

export const miniDocument = {
  createElement: (tag: string) => new MiniElement(tag),
  createElementNS: (ns: string | null, tag: string) => new MiniElement(tag, ns),
  createTextNode: (data: string) => new MiniText(String(data)),
  documentElement: new MiniElement('html'),
};

/** Install the mini DOM as `globalThis.document`; returns the restore function. */
export function installMiniDom(): () => void {
  const g = globalThis as { document?: unknown };
  const had = 'document' in g;
  const previous = g.document;
  g.document = miniDocument;
  return () => {
    if (had) g.document = previous;
    else delete g.document;
  };
}

function* walk(node: MiniNode): Generator<MiniNode> {
  yield node;
  for (const child of node.childNodes) yield* walk(child);
}

export function byTestId(root: MiniNode, testid: string): MiniElement | null {
  for (const node of walk(root)) {
    if (node instanceof MiniElement && node.getAttribute('data-testid') === testid) return node;
  }
  return null;
}

/** Buttons whose visible text matches, in document order. */
export function buttonsByText(root: MiniNode, text: RegExp): MiniElement[] {
  const out: MiniElement[] = [];
  for (const node of walk(root)) {
    if (node instanceof MiniElement && node.localName === 'button' && text.test(node.textContent)) out.push(node);
  }
  return out;
}

/** The value text of a Review row, found by its label. */
export function reviewRowValue(root: MiniNode, label: string): string | null {
  for (const node of walk(root)) {
    if (!(node instanceof MiniElement) || node.localName !== 'div') continue;
    const kids = node.childNodes.filter((c): c is MiniElement => c instanceof MiniElement);
    if (kids.length === 2 && kids.every((k) => k.localName === 'span') && kids[0]!.textContent.trim() === label) {
      return kids[1]!.textContent.trim();
    }
  }
  return null;
}

export function isDisabled(el: MiniElement): boolean {
  return el.hasAttribute('disabled') && el.getAttribute('disabled') !== 'false';
}

/**
 * Click like a browser: nothing happens on a disabled control, otherwise the
 * event bubbles from the target to the root. Returns whether it was delivered.
 */
export function click(el: MiniElement): boolean {
  if (isDisabled(el)) return false;
  let stopped = false;
  const event: MiniEvent = {
    type: 'click',
    target: el,
    currentTarget: el,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  for (let node: MiniNode | null = el; node && !stopped; node = node.parentNode) {
    if (!(node instanceof MiniElement)) continue;
    event.currentTarget = node;
    for (const listener of node.listeners.get('click') ?? []) listener.call(node, event);
  }
  return true;
}
