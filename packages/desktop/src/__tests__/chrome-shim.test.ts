/**
 * Tripwire for the unshimmed-host-API class of bug.
 *
 * Desktop imports the *entire* extension popup tree but polyfills only a
 * narrow slice of `chrome.*`. When popup code starts calling a member the
 * shim does not provide, nothing fails at build time: `chrome.runtime`
 * exists, so `chrome.runtime.whatever(...)` type-checks and only blows up at
 * runtime, on desktop only, as a synchronous TypeError that aborts its whole
 * caller before any `.catch()` can attach. That is how Lock and
 * Forget-wallet silently stopped working on desktop.
 *
 * So instead of testing behaviour, this test reads the popup sources, pulls
 * out every `chrome.<a>.<b>` it calls, and asserts the shim answers each one.
 * A new unshimmed call fails here rather than on a user's machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installChromeShim } from '../chrome-shim';

const here = dirname(fileURLToPath(import.meta.url));
const popupRoot = join(here, '../../../extension/src/popup');
const uiRoot = join(here, '../../../ui/src');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Collect `chrome.a.b` where it is *called*: `chrome.runtime.sendMessage(`
 * or `chrome.runtime\n  .sendMessage(`. Bare property reads (`chrome.runtime.id`)
 * and mentions inside comments are handled by the caller filter below.
 */
function calledChromeMembers(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // `[\s\S]*?` spans the line breaks that prettier inserts mid-chain.
  const re = /\bchrome\s*\.\s*([A-Za-z]+)\s*\.\s*([A-Za-z]+)\s*(?:\(|\.\s*addListener)/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Strip comments so documentation of a limitation is not read as a call.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const key = `${m[1]}.${m[2]}`;
      const list = found.get(key) ?? [];
      if (!list.includes(file)) list.push(file);
      found.set(key, list);
    }
  }
  return found;
}

test('the desktop shim answers every chrome.* member the shared UI calls', () => {
  installChromeShim();
  const shim = (globalThis as { chrome?: Record<string, unknown> }).chrome;
  assert.ok(shim, 'shim did not install');

  const used = calledChromeMembers([...sourceFiles(popupRoot), ...sourceFiles(uiRoot)]);
  assert.ok(used.size > 0, 'regex found no chrome.* calls at all; it has rotted');

  const missing: string[] = [];
  for (const [member, files] of used) {
    const [ns = '', fn = ''] = member.split('.');
    const nsObj = shim[ns] as Record<string, unknown> | undefined;
    const target = nsObj?.[fn];
    // `storage.onChanged` is an object with addListener, not a function.
    const answered = typeof target === 'function' || typeof target === 'object';
    if (!answered) {
      const first = files[0] ?? '<unknown>';
      missing.push(
        `chrome.${member} is called in ${files.length} file(s), e.g. ` +
          `${first.slice(first.indexOf('packages/'))}, but the shim does not provide it`,
      );
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Unshimmed chrome.* members reachable on desktop:\n  ${missing.join('\n  ')}\n\n` +
      'Add them to packages/desktop/src/chrome-shim.ts (a no-op or a loud throw, ' +
      'whichever is honest for that API) rather than deleting this assertion.',
  );
});

test('runtime.sendMessage is a function that resolves rather than throwing', async () => {
  installChromeShim();
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome!;
  const runtime = chromeGlobal['runtime'] as { sendMessage: (m: unknown) => Promise<unknown> };

  // The regression this guards: `.catch()` must be reachable. If sendMessage
  // is undefined the call throws *before* the catch attaches, and the caller
  // (lockHandler, onForgetComplete, onBackendSwitched) dies with it.
  assert.equal(typeof runtime.sendMessage, 'function');
  await assert.doesNotReject(async () => {
    await runtime.sendMessage({ type: 'DM_WATCH_CLEAR' }).catch(() => undefined);
  });
});

test('runtime.connect throws loudly instead of returning a port that never answers', () => {
  installChromeShim();
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome!;
  const runtime = chromeGlobal['runtime'] as { connect: (i: unknown) => unknown };
  // A stub port would hang every jobs request forever; failing fast is the
  // lesser evil until the coordinator has a desktop-side implementation.
  assert.throws(() => runtime.connect({ name: 'jobs' }), /unavailable on desktop/);
});

test('installing over a host-provided chrome global keeps the host keys', () => {
  // WebView2 (Windows) defines `chrome.webview` for its own IPC. Clobbering it
  // takes Tauri's channel with it; merging is what keeps Windows booting.
  delete (globalThis as { chrome?: unknown }).chrome;
  const hostBridge = { postMessage() {} };
  (globalThis as { chrome?: unknown }).chrome = { webview: hostBridge };

  installChromeShim();

  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome!;
  assert.equal(chromeGlobal['webview'], hostBridge, 'host bridge was clobbered');
  assert.ok(
    (chromeGlobal['storage'] as { local?: unknown })?.local,
    'shim did not install over a host-provided chrome global',
  );
});
