/**
 * Which build is this?
 *
 * Every desktop binary for three weeks reported version `0.3.0`, because the
 * version comes from `package.json` and only changes when someone bumps it.
 * That is fine for "what release line is this" and useless for "is this the
 * build I just installed", which is the question you actually ask when a bug
 * report and the source disagree.
 *
 * It cost a full debugging round trip: a three-week-old app was diagnosed as a
 * code defect, twice, because nothing on screen could distinguish it from the
 * build under test. The commit is the only identifier that changes every time
 * the bytes change.
 *
 * The values are injected at build time by each package's vite config (see the
 * `define` block in packages/extension/vite.config.ts and
 * packages/desktop/vite.config.ts). They are compile-time constants, not reads:
 * an un-injected build falls back to `unknown` rather than throwing, because a
 * missing build stamp must never be the thing that stops a wallet opening.
 */

declare const __APP_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_DATE__: string | undefined;

/** Release line, from the package version at build time. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0';

/** Short commit the bytes were built from, or `unknown`. */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__ ? __BUILD_COMMIT__ : 'unknown';

/** ISO date the bundle was built, or `unknown`. */
export const BUILD_DATE: string =
  typeof __BUILD_DATE__ === 'string' && __BUILD_DATE__ ? __BUILD_DATE__ : 'unknown';

/**
 * One line identifying this exact build, for display and for bug reports.
 *
 * Deliberately includes the version too: the version answers "which release",
 * the commit answers "which build of it", and a report carrying only one of
 * them sends someone reading the wrong source.
 */
export function buildIdentity(version: string): string {
  const commit = BUILD_COMMIT === 'unknown' ? 'unknown build' : BUILD_COMMIT;
  return BUILD_DATE === 'unknown'
    ? `v${version} (${commit})`
    : `v${version} (${commit}, ${BUILD_DATE})`;
}
