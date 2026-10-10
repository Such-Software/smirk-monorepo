/**
 * Area H browser adapters: one small surface over Firefox (geckodriver) and
 * Chromium (Playwright), so the live runner drives both with the same flow.
 *
 * Targets:
 *   'test-id'                 → [data-testid="test-id"]
 *   { css: 'selector' }       → that selector
 *   { aria: 'Lock wallet' }   → button[aria-label="Lock wallet"]
 *
 * `maskMode` tells the recorder what a mask-level guard hit means: Chromium
 * masks the named surfaces in the screenshot; Firefox cannot, so it cards the
 * whole frame.
 */
import { KEYS, WebDriverError } from './H-cross-browser-desktop-webdriver.mjs';
import { CLAIM_LINK_TEXT, MASKS } from './H-cross-browser-desktop-policy.mjs';

export function selector(target) {
  if (typeof target === 'string') return `[data-testid="${target}"]`;
  if (target?.css) return target.css;
  if (target?.aria) return `button[aria-label="${target.aria}"]`;
  throw new Error('unknown target');
}

/** Visible-only filter, run in the page. */
function visibleIndexes(css) {
  return [...document.querySelectorAll(css)].map((element, index) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' ? index : -1;
  }).filter((index) => index >= 0);
}

/** Set a <select> to a value and fire the change event Preact listens for. */
function chooseInPage(css, value) {
  const element = document.querySelector(css);
  if (!element || element.tagName !== 'SELECT') return false;
  if (![...element.options].some((option) => option.value === value)) return false;
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return element.value === value;
}

function rootTextInPage() {
  const root = /** @type {HTMLElement | null} */ (document.querySelector('#root') || document.body);
  return root ? root.innerText || '' : '';
}

export class FirefoxAdapter {
  kind = 'firefox';
  maskMode = 'card';
  imageExt = 'png';
  /** @type {{ width: number, height: number } | null} */
  popup = null;
  /** The CSS viewport the popup emulation achieved (evidence). */
  viewport = null;

  constructor(session, origin) {
    this.session = session;
    this.origin = origin;
  }

  /**
   * Open a wallet page by navigating from inside an extension page (same
   * origin), adopting the setup tab the extension opens on install when the
   * current tab is not one. Classic navigation of a content tab to
   * moz-extension:// is refused without system access, and with it the tab's
   * viewport stops following window resizes, which breaks the popup
   * emulation; it is only the last resort.
   */
  async goto(path) {
    const url = `${this.origin}/${path}`;
    if (!String(await this.session.currentUrl()).startsWith(this.origin)) {
      let adopted = false;
      for (const handle of await this.session.handles()) {
        await this.session.switchTo(handle);
        if (String(await this.session.currentUrl()).startsWith(this.origin)) { adopted = true; break; }
      }
      if (!adopted) {
        try {
          await this.session.navigate(url);
          return this.#applyPopup();
        } catch (error) {
          if (error instanceof WebDriverError) throw new Error('no wallet tab to navigate from');
          throw error;
        }
      }
    }
    const token = `h${Date.now()}`;
    await this.session.execute((mark, target) => {
      document.documentElement.setAttribute('data-h-nav', mark);
      location.assign(target);
    }, token, url);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const state = await this.session.execute(() => [document.readyState, document.documentElement.getAttribute('data-h-nav'), location.href]).catch(() => null);
      if (state && state[0] === 'complete' && state[1] !== token && String(state[2]).startsWith(url)) return this.#applyPopup();
      if (Date.now() > deadline) throw new Error('the wallet page did not load');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  evaluate(fn, arg) { return arg === undefined ? this.session.execute(fn) : this.session.execute(fn, arg); }
  rootText() { return this.session.execute(rootTextInPage); }
  screenshot() { return this.session.screenshot(); }
  async url() { return this.session.currentUrl(); }

  async #visible(target) {
    const css = selector(target);
    const indexes = await this.session.execute(visibleIndexes, css);
    if (!indexes.length) return null;
    const all = await this.session.findAll(css);
    return all[indexes[0]] ?? null;
  }

  async count(target) { return (await this.session.execute(visibleIndexes, selector(target))).length; }
  async visible(target) { return (await this.count(target)) > 0; }

  /** Like Playwright's auto-wait: up to 15 s for the target to be visible. */
  async #waitVisible(target) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const element = await this.#visible(target).catch(() => null);
      if (element || Date.now() > deadline) return element;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async click(target) {
    const element = await this.#waitVisible(target);
    if (!element) throw new Error('target not visible');
    await this.session.click(element);
  }

  async fill(target, value) {
    const element = await this.#waitVisible(target);
    if (!element) throw new Error('field not visible');
    await this.session.clear(element);
    await this.session.sendKeys(element, value);
  }

  async choose(target, value) {
    if (!(await this.session.execute(chooseInPage, selector(target), value))) throw new Error('select option not available');
  }

  async text(target) {
    const element = await this.#visible(target);
    return element ? String(await this.session.text(element)) : null;
  }

  async attribute(target, name) {
    const element = await this.#visible(target);
    return element ? this.session.attribute(element, name) : null;
  }

  async enabled(target) {
    const element = await this.#visible(target);
    return element ? Boolean(await this.session.enabled(element)) : false;
  }

  press(key) { return this.session.pressKey(KEYS[key] ?? key); }
  handles() { return this.session.handles(); }
  current() { return this.session.handle(); }
  switchTo(handle) { return this.session.switchTo(handle); }
  async closeCurrent() { await this.session.closeWindow(); }
  /**
   * Emulate the action popup. Firefox will not make a window narrower than
   * 500 CSS px, so the window is 500 wide and the page is zoomed by 500/380:
   * the wallet then lays out in exactly a 380x600 CSS viewport, as in the
   * real popup. Zoom is reapplied after every navigation (resistFingerprinting
   * turns off site-specific zoom).
   */
  async setSize(width, height) {
    this.popup = { width, height };
    await this.#applyPopup();
  }

  async #applyPopup() {
    if (!this.popup) return;
    const { width, height } = this.popup;
    const windowWidth = Math.max(width, 500);
    const zoom = windowWidth / width;
    let windowHeight = Math.round(height * zoom) + 86;
    await this.session.setWindowRect(windowWidth, windowHeight);
    await this.session.setContext('chrome');
    try {
      await this.session.execute((value) => { /** @type {any} */ (window).gBrowser.selectedBrowser.fullZoom = value; }, zoom);
    } finally {
      await this.session.setContext('content');
    }
    // Headless Firefox relayouts a moment after a resize or zoom; wait for it.
    const viewport = () => this.session.execute(() => [document.documentElement.getBoundingClientRect().width, document.documentElement.clientHeight]);
    const settle = async () => {
      let last = await viewport();
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const next = await viewport();
        if (next[0] === last[0] && next[1] === last[1] && Math.abs(next[0] - width) <= 4) return next;
        last = next;
      }
      return last;
    };
    let [actualWidth, actualHeight] = await settle();
    // One correction for the window chrome, whose height varies by platform.
    if (Math.abs(actualHeight - height) > 2) {
      windowHeight += Math.round((height - actualHeight) * zoom);
      await this.session.setWindowRect(windowWidth, windowHeight);
      [actualWidth, actualHeight] = await settle();
    }
    this.viewport = { width: actualWidth, height: actualHeight };
  }
}

export class ChromiumAdapter {
  kind = 'chromium';
  maskMode = 'mask';
  imageExt = 'jpg';

  constructor(context, page, origin) {
    this.context = context;
    this.page = page;
    this.origin = origin;
  }

  /**
   * The page being driven. The wallet closes its own window after handing off
   * to a tab or a pop-out; when that happens, follow the newest wallet page.
   */
  get live() {
    if (this.page.isClosed()) {
      const open = this.context.pages().filter((page) => !page.isClosed() && page.url().startsWith(this.origin));
      if (open.length) this.page = open.at(-1);
    }
    return this.page;
  }

  goto(path) { return this.live.goto(`${this.origin}/${path}`); }
  evaluate(fn, arg) { return this.live.evaluate(fn, arg); }
  rootText() { return this.live.evaluate(rootTextInPage); }
  async url() { return this.live.url(); }

  #locator(target) { return this.live.locator(selector(target)).filter({ visible: true }).first(); }

  screenshot(maskKinds = []) {
    const mask = maskKinds.map((kind) => (MASKS[kind] ? this.live.locator(MASKS[kind].css) : this.live.getByText(new RegExp(CLAIM_LINK_TEXT))));
    return this.live.screenshot({ type: 'jpeg', quality: 90, mask, maskColor: '#1b1726', animations: 'allow', caret: 'initial', timeout: 15_000 });
  }

  count(target) { return this.live.locator(selector(target)).filter({ visible: true }).count(); }
  async visible(target) { return (await this.count(target)) > 0; }
  click(target) { return this.#locator(target).click({ timeout: 15_000 }); }
  fill(target, value) { return this.#locator(target).fill(value, { timeout: 15_000 }); }

  async choose(target, value) {
    if (!(await this.live.evaluate(([css, v]) => {
      const element = document.querySelector(css);
      if (!element || element.tagName !== 'SELECT' || ![...element.options].some((option) => option.value === v)) return false;
      element.value = v;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === v;
    }, [selector(target), value]))) throw new Error('select option not available');
  }

  async text(target) {
    const locator = this.#locator(target);
    return (await locator.count()) ? locator.innerText({ timeout: 5_000 }) : null;
  }

  async attribute(target, name) {
    const locator = this.#locator(target);
    return (await locator.count()) ? locator.getAttribute(name) : null;
  }

  async enabled(target) {
    const locator = this.#locator(target);
    return (await locator.count()) ? locator.isEnabled() : false;
  }

  press(key) { return this.live.keyboard.press(key === 'escape' ? 'Escape' : key === 'enter' ? 'Enter' : key); }

  /** Pages stand in for window handles. */
  #ids = new WeakMap();
  #next = 0;
  #id(page) {
    if (!this.#ids.has(page)) this.#ids.set(page, `page-${this.#next++}`);
    return this.#ids.get(page);
  }

  async handles() { return this.context.pages().map((page) => this.#id(page)); }
  async current() { return this.#id(this.page); }
  async switchTo(handle) {
    const page = this.context.pages().find((candidate) => this.#id(candidate) === handle);
    if (!page) throw new Error('no such page');
    this.page = page;
    await page.bringToFront();
  }
  async closeCurrent() { await this.live.close(); }
  async setSize(width, height) { await this.live.setViewportSize({ width, height }); }
}
