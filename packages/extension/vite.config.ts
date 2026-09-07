import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { execSync } from 'child_process';

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
 * scripts are classic scripts: they CAN'T import ES modules. The
 * popup + background can use the regular Vite/Rollup ES-module
 * pipeline, but these two entries need a separate single-file IIFE
 * bundle each. We invoke esbuild directly (already a Vite transitive
 * dep) from a Vite plugin hook so the whole extension build is still
 * one `vite build` invocation.
 *
 * **Why not just add them to rollupOptions.input?** Vite/Rollup
 * support per-output formats but not per-entry formats in a single
 * build; adding them would either force the whole bundle to IIFE
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
            // Inject.js may end up in a CSP-restricted page; keep it
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
      // chrome-extension:// path at runtime, same-origin to the popup.
      if (existsSync('assets/fonts')) {
        copyDirRecursive('assets/fonts', 'dist/fonts');
      }

      // Copy the doge-mining animated WebP used in the PoW solve
      // status. Mirrored from wowne.ro-idp's `public/` so the asset
      // ships with the extension binary instead of phoning home.
      if (existsSync('assets/doge-mining.webp')) {
        copyFileSync('assets/doge-mining.webp', 'dist/doge-mining.webp');
      }
    },
  };
}


/**
 * Stamp the build with the commit it came from.
 *
 * `package.json` version alone cannot answer "is this the build I just
 * installed": it changes on release, not on every build, so three weeks of
 * binaries all called themselves 0.3.0 and a stale one was twice mistaken for
 * a code bug. The commit changes whenever the bytes do.
 *
 * Falls back to `unknown` rather than failing the build. A tarball with no git
 * directory is a legitimate way to build this, and a missing stamp must never
 * be the reason a release cannot be produced.
 */
function buildStamp(): { commit: string; date: string; version: string } {
  let commit = 'unknown';
  let date = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    // The commit is the clock, exactly as scripts/pack-release.sh already says.
    // A wall-clock date makes every build of the same source a different
    // artifact: pack-release.sh builds once, records the hashes, then rebuilds
    // to verify, and those runs straddling UTC midnight would embed different
    // dates and fail a checksum that is supposed to prove the source.
    date = execSync('git log -1 --format=%cd --date=format:%Y-%m-%d', {
      encoding: 'utf8',
    }).trim();
    // Scoped to build inputs. pack-release.sh writes SHA256SUMS and TOOLCHAIN
    // into packages/extension/releases DURING the release, so an unscoped probe
    // sees the release's own output and stamps the verify rebuild '-dirty',
    // changing bytes that were just checksummed.
    const dirty = execSync(
      "git status --porcelain -- ':!packages/extension/releases'",
      { encoding: 'utf8' },
    ).trim();
    // A dirty tree is a different artefact from the commit it claims. Say so,
    // because "it reproduces at that sha" is exactly what a reader will assume.
    if (dirty) commit += '-dirty';
  } catch {
    // no git available; `unknown` is the honest answer
  }
  const version = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ).version as string;
  // Fail the build rather than ship an unidentifiable one. A silent
  // degradation to "unknown" reproduces the exact problem this stamp exists to
  // prevent: a binary that cannot say which build it is. `unknown` is the right
  // answer when there is genuinely no git (a tarball build), so only an empty
  // or malformed value is treated as a fault.
  if (!commit || !date || !version) {
    throw new Error(
      `[buildStamp] refusing to build without an identity: commit=${commit} ` +
        `date=${date} version=${version}. The stamp is what makes a bug report ` +
        'answerable; a build that cannot name itself is the failure mode this ' +
        'guards against.',
    );
  }
  return { commit, date, version };
}

const stamp = buildStamp();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(stamp.version),
    __BUILD_COMMIT__: JSON.stringify(stamp.commit),
    __BUILD_DATE__: JSON.stringify(stamp.date),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Disable modulepreload polyfill: it touches `document`, which the
    // MV3 service worker doesn't have.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        // Offscreen document for the background job runner. Chrome
        // MV3 creates this via `chrome.offscreen.createDocument`;
        // Vite emits it alongside popup.html.
        'jobs-offscreen': resolve(__dirname, 'jobs-offscreen.html'),
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
