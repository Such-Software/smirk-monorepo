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

      // Copy icons if present.
      if (existsSync('icons')) {
        copyDirRecursive('icons', 'dist/icons');
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
  plugins: [copyMonorepoAssets()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
});
