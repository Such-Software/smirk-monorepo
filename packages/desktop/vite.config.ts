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
 * Copy WASM bundle + icons + fonts from the extension package so the
 * popup runs unmodified. The extension already maintains its own copy
 * (see `packages/extension/vite.config.ts::copyMonorepoAssets`); we
 * shadow it here for the desktop frontendDist tree because Tauri
 * serves from `packages/desktop/dist/` and won't reach across into
 * the extension's output.
 *
 * Runs in two modes:
 *  - `configureServer`: installs dev-mode middleware that serves the
 *    extension's icons/fonts + the monorepo's WASM bundle directly from
 *    their on-disk locations. `tauri dev` never produces a `dist/`, so
 *    a copy step wouldn't help here.
 *  - `writeBundle`: at production build time, copy everything into
 *    `dist/` so the AppImage / dmg / msi bundle has them.
 */
function copyAssetsForDesktop() {
  const wasmPkgDir = resolve(__dirname, '../../crates/smirk-wasm/pkg');
  const iconsDir = resolve(__dirname, '../extension/icons');
  const fontsDir = resolve(__dirname, '../extension/assets/fonts');

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
    },

    writeBundle() {
      // WASM lives in the monorepo's smirk-wasm crate output.
      const wasmDest = 'dist/wasm';
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

      // Icons + fonts mirror the extension's bundle. Keep the same
      // relative paths so the popup's `chrome.runtime.getURL(...)`
      // calls (now shimmed to identity) resolve.
      if (existsSync(iconsDir)) {
        copyDirRecursive(iconsDir, 'dist/icons');
      }
      if (existsSync(fontsDir)) {
        copyDirRecursive(fontsDir, 'dist/fonts');
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
