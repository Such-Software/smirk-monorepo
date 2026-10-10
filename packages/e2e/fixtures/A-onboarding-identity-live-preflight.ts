/**
 * Live lane preflight (globalSetup of playwright.live.config.ts).
 *
 * Every refusal names its cause before anything expensive starts. In order:
 * the lane is opted into, capture is closed except for the guarded recorder,
 * the reporters are the private pair, no live spec clicks or types outside the
 * footage helpers, the custody file holds alice, bob and carol, the extension
 * is the hash-verified release candidate, its bundle targets the backend under
 * test, and that backend answers as a v3 API.
 *
 * Kept in an area-prefixed file so the per-area branches merge cleanly; it is
 * the lane's shared preflight, not area A's alone.
 */
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import { assertPrivateCapture } from '../capture-policy.mjs';
import { DEFAULT_FOOTAGE_DIR, footageMode } from './guarded-footage.js';
import { DEMO_WALLETS, RELEASE_CANDIDATE, custodyStatus } from './live-wallets.js';
import { baselineFor, loadBaseline } from './A-onboarding-identity-baseline.js';

const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_REPORTER = join(E2E_ROOT, 'fixtures', 'A-onboarding-identity-live-reporter.ts');
const PRIVATE_REPORTER = join(E2E_ROOT, 'private-reporter.ts');

const INTERACTION = /\.\s*(click|dblclick|fill|check|uncheck|setChecked|selectOption|press|pressSequentially|type|tap|setInputFiles|screenshot)\s*\(/g;

/**
 * Line numbers where a live spec interacts with a page outside the footage
 * helpers. Every click, fill, selection and key press must go through
 * `footage.*` so the pre-tap hold applies and secret entry happens in a scope.
 * `screenshot` is refused outright: frames come only from the guarded recorder.
 */
export function rawInteractions(source: string): number[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  const offending: number[] = [];
  stripped.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(INTERACTION)) {
      const before = line.slice(0, match.index);
      if (match[1] === 'screenshot' || !/\bfootage\s*$/.test(before)) offending.push(index + 1);
    }
  });
  return offending;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function manifestDir(root: string): string | null {
  if (existsSync(join(root, 'manifest.json'))) return root;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json'))) return join(root, entry.name);
  }
  return null;
}

function bundleSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/**
 * Refuse with the cause. The private reporter withholds runner errors, so the
 * reason is also written here; preflight messages never carry a secret.
 */
function refuse(message: string): never {
  const line = `[live preflight] ${message}`;
  process.stderr.write(`${line}\n`);
  throw new Error(line);
}

export default async function livePreflight(config: FullConfig): Promise<void> {
  if (process.env.E2E_LIVE !== '1') {
    refuse('The live lane is opt-in. Set E2E_LIVE=1: it drives the owner-approved demo wallets against production.');
  }
  assertPrivateCapture();
  for (const project of config.projects) assertPrivateCapture(project.use);
  const mode = footageMode();

  const reporters = config.reporter.map(([name]) => name);
  if (reporters.length !== 2 || !reporters.includes(PRIVATE_REPORTER) || !reporters.includes(LIVE_REPORTER)) {
    refuse('The live lane requires exactly its private reporter and its skip guard; other reporters may retain secrets.');
  }

  const specDir = join(E2E_ROOT, 'tests', 'live');
  if (existsSync(specDir)) {
    for (const file of readdirSync(specDir).filter((name) => name.endsWith('.live.spec.ts'))) {
      const lines = rawInteractions(readFileSync(join(specDir, file), 'utf8'));
      if (lines.length) {
        refuse(`${file} interacts outside the footage helpers at line(s) ${lines.join(', ')}. Use footage.tap, footage.choose, footage.type or footage.secretFill.`);
      }
    }
  }

  for (const [name, variable] of Object.entries(DEMO_WALLETS)) {
    const status = custodyStatus(variable);
    if (!status.ok) refuse(`${name} (${variable}): ${status.reason}.`);
  }

  let baselineAsOf = '';
  try {
    baselineAsOf = loadBaseline().asOf;
  } catch (error) {
    refuse(`The demo wallet baseline cannot be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const withoutBaseline = Object.keys(DEMO_WALLETS).filter((name) => !baselineFor(name));

  const zip = process.env.E2E_EXTENSION_ZIP ?? (process.env.EXTENSION_DIST ? undefined : RELEASE_CANDIDATE.chromeZip);
  let verified = 'unpacked directory supplied by EXTENSION_DIST (not hash-verified here)';
  if (zip) {
    if (!existsSync(zip)) refuse(`The release candidate zip ${basename(zip)} is not at the expected path; set E2E_EXTENSION_ZIP.`);
    const expected = (process.env.E2E_EXTENSION_SHA256 ?? RELEASE_CANDIDATE.chromeZipSha256).toLowerCase();
    const actual = await sha256(zip);
    if (actual !== expected) refuse(`${basename(zip)} hashes to ${actual}, not the release candidate's ${expected}.`);
    const out = mkdtempSync(join(tmpdir(), 'smirk-e2e-extension-'));
    chmodSync(out, 0o700);
    const unzip = spawnSync('unzip', ['-q', zip, '-d', out], { encoding: 'utf8' });
    if (unzip.status !== 0) refuse(`unzip could not unpack ${basename(zip)}: ${(unzip.stderr || unzip.error?.message || 'no detail').trim().slice(0, 200)}`);
    const dir = manifestDir(out);
    if (!dir) refuse(`${basename(zip)} holds no manifest.json at its root or one level down.`);
    process.env.EXTENSION_DIST = dir;
    verified = `${basename(zip)} sha256 ${actual}`;
  }
  const dist = process.env.EXTENSION_DIST;
  if (!dist || !existsSync(join(dist, 'manifest.json'))) refuse('No unpacked extension: set E2E_EXTENSION_ZIP or EXTENSION_DIST.');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as { version?: string };
  const expectedVersion = process.env.E2E_EXPECT_VERSION ?? RELEASE_CANDIDATE.version;
  if (manifest.version !== expectedVersion) refuse(`The extension is version ${manifest.version ?? 'unknown'}, not ${expectedVersion}.`);

  const backend = process.env.BACKEND_URL;
  if (!backend) refuse('BACKEND_URL is not set; the live config defaults it to production.');
  const bundle = bundleSources(dist).map((file) => readFileSync(file, 'utf8')).join('\n');
  if (!bundle.includes(backend)) refuse(`The extension bundle does not target ${backend}, so the wallet and the specs would talk to different servers.`);
  // Not a refusal: the run still tests these bytes. The settings tour fails on
  // a dirty stamp unless the owner accepts it, and this says so up front.
  const dirtyStamp = RELEASE_CANDIDATE.commits.map((commit) => bundle.match(new RegExp(`\\b${commit}[0-9a-f]*-dirty\\b`))?.[0]).find(Boolean);
  let capabilities: Response;
  try {
    capabilities = await fetch(`${backend.replace(/\/$/, '')}/capabilities`, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    refuse(`Cannot reach ${backend}/capabilities: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!capabilities.ok) refuse(`${backend}/capabilities answered HTTP ${capabilities.status}, so it is not serving the v3 API.`);
  await capabilities.json().catch(() => refuse(`${backend}/capabilities did not return JSON.`));

  if (mode === 'guarded' && process.env.FOOTAGE_ENCODE !== '0' && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    refuse('FOOTAGE=guarded encodes each recorded page with ffmpeg, which is not on PATH. Install it, or set FOOTAGE_ENCODE=0 to keep frames and the timeline only.');
  }
  process.env.E2E_LIVE_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-');
  const footageRoot = process.env.E2E_FOOTAGE_DIR ?? DEFAULT_FOOTAGE_DIR;
  mkdirSync(footageRoot, { recursive: true, mode: 0o700 });

  console.log([
    `[live preflight] extension ${manifest.version}: ${verified}`,
    `[live preflight] backend ${backend}`,
    `[live preflight] footage ${mode}${mode === 'guarded' ? ` into ${join(footageRoot, process.env.E2E_LIVE_RUN_ID)}` : ''}`,
    `[live preflight] production writes ${process.env.ALLOW_PROD_WRITES === '1' ? 'allowed' : 'not allowed (those scenarios skip, as declared)'}`,
    `[live preflight] demo wallet baseline ${baselineAsOf} (${process.env.E2E_BASELINE_FILE ? 'E2E_BASELINE_FILE' : 'shipped'})${withoutBaseline.length ? `; none for ${withoutBaseline.join(', ')}, whose baseline scenarios skip as declared` : ''}`,
    ...(dirtyStamp
      ? [`[live preflight] build stamp ${dirtyStamp}: built from a modified tree; the settings tour fails on it unless E2E_ACCEPT_DIRTY_BUILD=1${process.env.E2E_ACCEPT_DIRTY_BUILD === '1' ? ' (set)' : ''}`]
      : []),
  ].join('\n'));
}
