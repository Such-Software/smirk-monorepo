/**
 * Minimal W3C WebDriver client for geckodriver, with a WebDriver BiDi fallback
 * for installing the extension. No dependencies: Node's fetch and WebSocket.
 *
 * Secret handling: values typed through `sendKeys` travel only over loopback
 * HTTP to geckodriver. geckodriver and Marionette run at log level "fatal",
 * their output is discarded, and errors raised here carry the WebDriver error
 * code and the command path, never a request body or a browser message.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export const KEYS = Object.freeze({ escape: '', enter: '', tab: '' });

export class WebDriverError extends Error {
  constructor(code, where) {
    super(`webdriver ${code} at ${where}`);
    this.code = code;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/** `<tool> --version` first line, for the version pins. Never throws. */
export function toolVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 ? String(result.stdout).split('\n')[0].trim() : null;
}

export class GeckoSession {
  /**
   * Start geckodriver and a Firefox session.
   * @param {{ geckodriver: string, firefox: string, prefs: Record<string, unknown>, headless: boolean, tmpDir: string }} options
   */
  static async start({ geckodriver, firefox, prefs, headless, tmpDir }) {
    const port = await freePort();
    const wsPort = await freePort();
    // TMPDIR: geckodriver creates the temporary profile there, inside the run's
    // owner-only directory, and the runner removes it afterwards.
    const driver = spawn(geckodriver, ['--port', String(port), '--websocket-port', String(wsPort), '--log', 'fatal'], {
      stdio: 'ignore',
      env: { ...process.env, TMPDIR: tmpDir, MOZ_LOG: '', MOZ_HEADLESS: headless ? '1' : '' },
    });
    const session = new GeckoSession(`http://127.0.0.1:${port}`, driver);
    for (let i = 0; i < 100; i++) {
      try {
        const status = await fetch(`${session.base}/status`);
        if (status.ok) break;
      } catch { /* not listening yet */ }
      await sleep(100);
    }
    const created = await session.cmd('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          acceptInsecureCerts: false,
          webSocketUrl: true,
          unhandledPromptBehavior: 'ignore',
          timeouts: { implicit: 0, pageLoad: 90_000, script: 120_000 },
          'moz:firefoxOptions': {
            binary: firefox,
            args: headless ? ['-headless'] : [],
            prefs,
            log: { level: 'fatal' },
          },
        },
      },
    }, { noSession: true });
    session.id = created.sessionId;
    session.capabilities = created.capabilities;
    return session;
  }

  constructor(base, driver) {
    this.base = base;
    this.driver = driver;
    this.id = null;
    this.capabilities = {};
  }

  async cmd(method, path, body, { noSession = false } = {}) {
    const url = noSession ? `${this.base}${path}` : `${this.base}/session/${this.id}${path}`;
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty body */ }
    const value = payload?.value;
    if (!response.ok || (value && typeof value === 'object' && 'error' in value && value.error)) {
      // Error code and command path only: a message may quote page content.
      const where = path.replace(/\/element\/[^/]+/, '/element/:id');
      throw new WebDriverError(value?.error ?? `http ${response.status}`, `${method} ${where}`);
    }
    return value;
  }

  /** Temporary install. Classic Marionette command first, BiDi webExtension.install if that is missing. */
  async installTemporaryAddon(zipPath) {
    try {
      return { via: 'classic', id: await this.cmd('POST', '/moz/addon/install', { path: zipPath, temporary: true }) };
    } catch (error) {
      if (!(error instanceof WebDriverError)) throw error;
      const url = this.capabilities?.webSocketUrl;
      if (!url) throw error;
      const reply = await bidi(url, 'webExtension.install', { extensionData: { type: 'archivePath', path: zipPath } });
      return { via: 'bidi', id: reply?.extension ?? null };
    }
  }

  navigate(url) { return this.cmd('POST', '/url', { url }); }
  currentUrl() { return this.cmd('GET', '/url'); }
  setWindowRect(width, height) { return this.cmd('POST', '/window/rect', { width, height }); }
  handles() { return this.cmd('GET', '/window/handles'); }
  handle() { return this.cmd('GET', '/window'); }
  switchTo(handle) { return this.cmd('POST', '/window', { handle }); }
  closeWindow() { return this.cmd('DELETE', '/window'); }
  async screenshot() { return Buffer.from(await this.cmd('GET', '/screenshot'), 'base64'); }

  /** Run a self-contained function in the page; promises are awaited by the protocol. */
  execute(fn, ...args) {
    return this.cmd('POST', '/execute/sync', { script: `return (${String(fn)}).apply(null, arguments);`, args });
  }

  async findAll(css) {
    const found = await this.cmd('POST', '/elements', { using: 'css selector', value: css });
    return found.map((reference) => reference[ELEMENT]);
  }

  async find(css) {
    const [first] = await this.findAll(css);
    if (!first) throw new WebDriverError('no such element', 'find');
    return first;
  }

  click(element) { return this.cmd('POST', `/element/${element}/click`, {}); }
  clear(element) { return this.cmd('POST', `/element/${element}/clear`, {}); }
  sendKeys(element, text) { return this.cmd('POST', `/element/${element}/value`, { text }); }
  text(element) { return this.cmd('GET', `/element/${element}/text`); }
  displayed(element) { return this.cmd('GET', `/element/${element}/displayed`); }
  enabled(element) { return this.cmd('GET', `/element/${element}/enabled`); }
  attribute(element, name) { return this.cmd('GET', `/element/${element}/attribute/${encodeURIComponent(name)}`); }
  property(element, name) { return this.cmd('GET', `/element/${element}/property/${encodeURIComponent(name)}`); }

  async pressKey(key) {
    await this.cmd('POST', '/actions', {
      actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: key }, { type: 'keyUp', value: key }] }],
    });
    await this.cmd('DELETE', '/actions');
  }

  async quit() {
    try { if (this.id) await this.cmd('DELETE', ''); } catch { /* already gone */ }
    this.driver.kill('SIGTERM');
    for (let i = 0; i < 50 && this.driver.exitCode === null; i++) await sleep(100);
    if (this.driver.exitCode === null) this.driver.kill('SIGKILL');
  }
}

/** One BiDi command over a short-lived WebSocket. */
async function bidi(url, method, params) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new WebDriverError('bidi connect failed', method)), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new WebDriverError('bidi timeout', method)), 60_000);
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.type === 'error') reject(new WebDriverError(message.error ?? 'bidi error', method));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}
