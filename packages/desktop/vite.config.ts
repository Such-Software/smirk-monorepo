import { defineConfig } from 'vite';
import type { ViteDevServer } from 'vite';
import { resolve } from 'path';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  createReadStream,
} from 'fs';
import { extname } from 'path';

/**
 * Recursively copy a directory.
 */
function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = `${src}/${entry}`;
    const destPath = `${dest}/${entry}`;
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Map an extension → Content-Type for the dev middleware. We only
 * need to cover the asset types the popup actually requests.
 */
const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.js': 'application/javascript',
};

/**
 * Serve a directory under a URL prefix in dev mode. Falls through to
 * the next middleware on a path miss so Vite's own handlers still get
 * a chance.
 */
function serveDir(prefix: string, fsRoot: string) {
  const root = resolve(fsRoot);
  return (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; statusCode: number; end: () => void }, next: () => void) => {
    if (!req.url || !req.url.startsWith(prefix)) return next();
    // Strip the prefix + any query string. `sub` never has a leading
    // slash; `resolve(root, sub)` joins it as a sub-path.
    const sub = req.url.slice(prefix.length).split('?')[0]!;
    if (!sub) return next();
    const path = resolve(root, sub);
    // Defence-in-depth: refuse paths that escape `root` via `..`.
    if (!path.startsWith(root + '/') && path !== root) return next();
    if (!existsSync(path) || statSync(path).isDirectory()) return next();
    const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(path).pipe(res as unknown as NodeJS.WritableStream);
  };
}

/**
 * Every bundled file the shared UI hard-codes a URL for, as a path
 * relative to `dist/`. The list is the build's tripwire, not its
 * input: the copy step below mirrors whole directories, and this only
 * asserts the result. Sources of each reference:
 *
 *  - `doge-mining.webp`, `icons/icon-128.png`, `icons/favicon-16.png`
 *    → `packages/extension/src/popup/index.tsx`
 *  - `icons/icon-128.png` → `packages/extension/src/popup/routes/approval.tsx`
 *  - `icons/coins/*.svg` → `packages/extension/src/popup/icons.ts`
 *  - `fonts/press-start-2p.woff2` → `@smirk/ui` themes amiga + gameboy
 *  - `fonts/lilita-one.ttf` → `@smirk/ui` theme n64
 *  - `wasm/*` → `packages/extension/src/popup/wasm-init.ts`
 */
const REQUIRED_DIST_ASSETS = [
  'doge-mining.webp',
  'icons/icon-128.png',
  'icons/favicon-16.png',
  'icons/coins/bitcoin.svg',
  'icons/coins/litecoin.svg',
  'icons/coins/monero.svg',
  'icons/coins/wownero.svg',
  'icons/coins/grin.svg',
  'fonts/press-start-2p.woff2',
  'fonts/lilita-one.ttf',
  'wasm/smirk_wasm.js',
  'wasm/smirk_wasm_bg.wasm',
];

/**
 * Copy WASM bundle + icons + fonts + images from the extension package
 * so the popup runs unmodified. The extension already maintains its own
 * copy (see `packages/extension/vite.config.ts::copyMonorepoAssets`); we
 * shadow it here for the desktop frontendDist tree because Tauri
 * serves from `packages/desktop/dist/` and won't reach across into
 * the extension's output.
 *
 * The layout has to match the extension's dist tree file for file. The
 * shared `@smirk/ui` components are host-agnostic: they receive asset
 * URLs the popup built with `chrome.runtime.getURL(...)`, which the
 * desktop shim passes through unchanged, so `dist/<x>` in the extension
 * means `dist/<x>` here. That's why the whole of `extension/assets/` is
 * copied rather than a hand-picked file list: v0.3.0 shipped a broken
 * image because the desktop side knew about fonts but not the sibling
 * `doge-mining.webp`, and a per-file list would just re-break on the
 * next shared asset.
 *
 * Runs in two modes:
 *  - `configureServer`: installs dev-mode middleware that serves the
 *    extension's icons/fonts/images + the monorepo's WASM bundle
 *    directly from their on-disk locations. `tauri dev` never produces
 *    a `dist/`, so a copy step wouldn't help here.
 *  - `writeBundle`: at production build time, copy everything into
 *    `dist/` so the AppImage / dmg / msi bundle has them.
 */
function copyAssetsForDesktop() {
  const wasmPkgDir = resolve(__dirname, '../../crates/smirk-wasm/pkg');
  const iconsDir = resolve(__dirname, '../extension/icons');
  const assetsDir = resolve(__dirname, '../extension/assets');
  const fontsDir = `${assetsDir}/fonts`;
  // Resolve against the package dir, not the cwd: vite resolves
  // `build.outDir` relative to the config root, so this is the real
  // output tree no matter where `vite build` was invoked from.
  const distDir = resolve(__dirname, 'dist');

  return {
    name: 'copy-assets-for-desktop',

    configureServer(server: ViteDevServer) {
      // Order matters: register before Vite's default 404 handler.
      if (existsSync(iconsDir)) {
        server.middlewares.use(serveDir('/icons/', iconsDir));
      }
      if (existsSync(fontsDir)) {
        server.middlewares.use(serveDir('/fonts/', fontsDir));
      }
      if (existsSync(wasmPkgDir)) {
        server.middlewares.use(serveDir('/wasm/', wasmPkgDir));
      }
      // Root-level images (`/doge-mining.webp`) live directly in the
      // extension's assets dir, so mount it at `/`. `serveDir` falls
      // through on a miss, which leaves Vite's own routes (`/src/...`,
      // `/@vite/...`) untouched: only a filename that also exists in
      // `assets/` could shadow one, and that would collide in the
      // production dist tree too.
      if (existsSync(assetsDir)) {
        server.middlewares.use(serveDir('/', assetsDir));
      }
    },

    writeBundle() {
      // WASM lives in the monorepo's smirk-wasm crate output.
      const wasmDest = `${distDir}/wasm`;
      mkdirSync(wasmDest, { recursive: true });
      try {
        copyFileSync(`${wasmPkgDir}/smirk_wasm.js`, `${wasmDest}/smirk_wasm.js`);
        copyFileSync(`${wasmPkgDir}/smirk_wasm_bg.wasm`, `${wasmDest}/smirk_wasm_bg.wasm`);
      } catch (e) {
        console.warn(
          '[copy-assets-for-desktop] WASM bundle missing — run `make wasm` from the monorepo root first.',
          e,
        );
      }

      // Icons + assets mirror the extension's bundle. Keep the same
      // relative paths so the popup's `chrome.runtime.getURL(...)`
      // calls (now shimmed to identity) resolve. Copying the contents
      // of `assets/` into `dist/` reproduces the extension's own
      // mapping: `assets/fonts/` → `dist/fonts/`, and every root-level
      // file (`doge-mining.webp`, plus whatever lands there next) →
      // `dist/`.
      if (existsSync(iconsDir)) {
        copyDirRecursive(iconsDir, `${distDir}/icons`);
      }
      if (existsSync(assetsDir)) {
        copyDirRecursive(assetsDir, distDir);
      }

      // Fail the build rather than ship a bundle that renders a
      // broken-image placeholder. A missing asset is invisible until
      // someone runs the packaged app on the one screen that uses it,
      // which is exactly how v0.3.0 went out.
      const missing = REQUIRED_DIST_ASSETS.filter(
        (rel) => !existsSync(`${distDir}/${rel}`),
      );
      if (missing.length > 0) {
        throw new Error(
          `[copy-assets-for-desktop] required asset(s) missing from ${distDir}: ` +
            `${missing.join(', ')}. Images and fonts come from ` +
            'packages/extension/assets/, icons from packages/extension/icons/, ' +
            'and the WASM bundle from `make wasm` at the monorepo root.',
        );
      }
    },
  };
}

export default defineConfig({
  // Tauri runs the dev server on its own port; vite needs to be told
  // which one. 1420 is Tauri's default.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // Tauri's bundler reads from `dist/` by default.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Tauri webview is modern Chromium/WebKit; targeting es2022 saves
    // bundle size vs the broader extension target.
    target: 'es2022',
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
  plugins: [copyAssetsForDesktop()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  // Resolve the popup import path. `@smirk/extension/popup` maps to
  // the popup's source entry so Vite picks it up via workspace
  // resolution.
  resolve: {
    alias: {
      '@smirk/extension/popup': resolve(__dirname, '../extension/src/popup/index.tsx'),
    },
  },
});
