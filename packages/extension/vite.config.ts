import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { buildSync } from 'esbuild';

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
 * Bundle content.ts and inject.ts as standalone IIFE scripts.
 *
 * Chrome MV3 content scripts and `<script src=...>`-injected page
 * scripts are classic scripts — they CAN'T import ES modules. The
 * popup + background can use the regular Vite/Rollup ES-module
 * pipeline, but these two entries need a separate single-file IIFE
 * bundle each. We invoke esbuild directly (already a Vite transitive
 * dep) from a Vite plugin hook so the whole extension build is still
 * one `vite build` invocation.
 *
 * **Why not just add them to rollupOptions.input?** Vite/Rollup
 * support per-output formats but not per-entry formats in a single
 * build — adding them would either force the whole bundle to IIFE
 * (breaks popup chunking) or leak ES-module syntax into content.js.
 * A side esbuild call is the path of least breakage.
 */
function bundleClassicScripts() {
  return {
    name: 'bundle-classic-scripts',
    writeBundle() {
      const targets: Array<{ entry: string; outfile: string }> = [
        { entry: 'src/content/index.ts', outfile: 'dist/content.js' },
        { entry: 'src/inject/index.ts', outfile: 'dist/inject.js' },
      ];
      for (const t of targets) {
        try {
          buildSync({
            entryPoints: [t.entry],
            outfile: t.outfile,
            bundle: true,
            format: 'iife',
            platform: 'browser',
            target: 'chrome100',
            // Inject.js may end up in a CSP-restricted page — keep it
            // small and dependency-free. Same for content.js (runs in
            // every page's content-script world). Minify mostly for
            // size, not obfuscation.
            minify: true,
            // Resolve workspace imports (`@such-software/smirk-dapp-api`) via Node
            // resolution from the extension package root.
            absWorkingDir: resolve(__dirname),
          });
        } catch (e) {
          console.error(
            `[bundle-classic-scripts] failed to bundle ${t.entry}:`,
            e,
          );
          throw e;
        }
      }
    },
  };
}

/**
 * Copy WASM bundle from `crates/smirk-wasm/pkg/` into the dist tree
 * so the service worker / popup can `fetch()` it at runtime.
 *
 * The path traversal (`../../`) reaches up out of `packages/extension`
 * into the monorepo root, then back down into the Rust crate output.
 */
function copyMonorepoAssets() {
  return {
    name: 'copy-monorepo-assets',
    writeBundle() {
      const wasmPkgDir = '../../crates/smirk-wasm/pkg';
      const wasmDest = 'dist/wasm';
      mkdirSync(wasmDest, { recursive: true });
      try {
        copyFileSync(`${wasmPkgDir}/smirk_wasm.js`, `${wasmDest}/smirk_wasm.js`);
        copyFileSync(`${wasmPkgDir}/smirk_wasm_bg.wasm`, `${wasmDest}/smirk_wasm_bg.wasm`);
      } catch (e) {
        console.warn(
          '[copy-monorepo-assets] WASM bundle missing — run `make wasm` from the monorepo root first.',
          e,
        );
      }

      // Copy the Chrome MV3 manifest by default so the bare
      // `vite build` produces a loadable unpacked extension.
      // Firefox builds override this afterward via
      // `npm run build:firefox` (which does
      // `cp manifest.firefox.json dist/manifest.json` post-vite).
      if (existsSync('manifest.json')) {
        copyFileSync('manifest.json', 'dist/manifest.json');
      }

      // Copy icons if present.
      if (existsSync('icons')) {
        copyDirRecursive('icons', 'dist/icons');
      }

      // Copy bundled theme fonts (pixel + chunky display fonts the
      // built-in themes reference via @font-face). Loaded from a
      // chrome-extension:// path at runtime — same-origin to the popup.
      if (existsSync('assets/fonts')) {
        copyDirRecursive('assets/fonts', 'dist/fonts');
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Disable modulepreload polyfill — it touches `document`, which the
    // MV3 service worker doesn't have.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [bundleClassicScripts(), copyMonorepoAssets()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
});
