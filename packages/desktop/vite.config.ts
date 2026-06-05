import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';

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
 * Copy WASM bundle + icons + fonts from the extension package so the
 * popup runs unmodified. The extension already maintains its own copy
 * (see `packages/extension/vite.config.ts::copyMonorepoAssets`); we
 * shadow it here for the desktop frontendDist tree because Tauri
 * serves from `packages/desktop/dist/` and won't reach across into
 * the extension's output.
 */
function copyAssetsForDesktop() {
  return {
    name: 'copy-assets-for-desktop',
    writeBundle() {
      // WASM lives in the monorepo's smirk-wasm crate output.
      const wasmPkgDir = '../../crates/smirk-wasm/pkg';
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
      if (existsSync('../extension/icons')) {
        copyDirRecursive('../extension/icons', 'dist/icons');
      }
      if (existsSync('../extension/assets/fonts')) {
        copyDirRecursive('../extension/assets/fonts', 'dist/fonts');
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
