#!/usr/bin/env node
// Gitea run-artifact API is the sole collection source. No version-tag fallback.
import { readFile, writeFile, mkdtemp, mkdir, rename, rm, readdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyArtifacts } from './release-artifacts.mjs';

export function selectCandidates(run, listing, version, commit) {
  if ((run.head_sha ?? run.commit_sha) !== commit) throw new Error('Workflow run source does not match --expect-commit');
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Workflow run has not completed successfully');
  if (!Array.isArray(listing.artifacts)) throw new Error('Workflow artifact listing is missing; candidate availability is unknown');
  return ['macos', 'linux', 'windows', 'extension'].map(platform => {
    const name = platform === 'extension' ? `smirk-extension-v${version}-${commit}` : `smirk-desktop-${platform}-v${version}-${commit}`;
    const candidates = listing.artifacts.filter(artifact => artifact.name === name);
    if (candidates.length !== 1) throw new Error(`Expected one ${platform} candidate in this run; found ${candidates.length}`);
    const candidate = candidates[0];
    if (candidate.expired || !Number.isSafeInteger(candidate.id) || candidate.id <= 0) throw new Error(`${platform} candidate is expired or has an invalid artifact ID`);
    return { platform, name, id: candidate.id, url: candidate.archive_download_url };
  });
}

export async function fetchSameOrigin(url, origin, token, fetchImpl = fetch) {
  let next = new URL(url);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (next.origin !== origin || next.protocol !== 'https:' || next.username || next.password) {
      throw new Error('Candidate API redirected outside the reviewed HTTPS Gitea host');
    }
    let response;
    try {
      response = await fetchImpl(next, { headers: { Authorization: `token ${token}` }, redirect: 'manual' });
    } catch (failure) {
      // Never echo URLs, headers, or a nested error that might contain credentials.
      const code = failure?.cause?.code;
      throw new Error(`Gitea request failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Gitea redirect has no destination');
      next = new URL(location, next);
      continue;
    }
    if (!response.ok) throw new Error(`Gitea candidate request returned HTTP ${response.status}`);
    return response;
  }
  throw new Error('Gitea candidate request exceeded the redirect limit');
}

async function main(argv) {
  const version = argv.shift();
  const options = {};
  while (argv.length) {
    const flag = argv.shift();
    if (!['--run-id', '--expect-commit', '--dest'].includes(flag) || !argv.length || options[flag]) throw new Error('Usage: fetch-release-artifacts.sh VERSION --run-id ID --expect-commit FULL_SHA [--dest DIR]');
    options[flag] = argv.shift();
  }
  const commit = options['--expect-commit'];
  const runId = options['--run-id'];
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(commit ?? '') || !/^[1-9][0-9]*$/.test(runId ?? '')) {
    throw new Error('A version, successful run ID, and full reviewed source commit are required');
  }
  const host = new URL(process.env.SMIRK_GITEA_HOST ?? 'https://git.such.software');
  if (host.protocol !== 'https:' || host.username || host.password || host.pathname !== '/' || host.search || host.hash) throw new Error('Gitea host must be a credential-free HTTPS origin');
  const repo = process.env.SMIRK_BUILDS_REPO ?? 'Builds/smirk-monorepo';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid Builds repository name');
  const dest = resolve(options['--dest'] ?? join(homedir(), `release-v${version}-${commit.slice(0, 12)}`));
  try { await access(dest); throw new Error('Candidate destination already exists; choose a new directory'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  const token = (await readFile(join(homedir(), '.config/gitea-token'), 'utf8')).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('Enrolled Gitea token file is empty or malformed');
  const api = `${host.origin}/api/v1/repos/${repo}`;
  const get = url => fetchSameOrigin(url, host.origin, token);
  const run = await (await get(`${api}/actions/runs/${runId}`)).json();
  const listing = await (await get(`${api}/actions/runs/${runId}/artifacts?limit=100`)).json();
  const candidates = selectCandidates(run, listing, version, commit);
  await mkdir(dirname(dest), { recursive: true });
  const temp = await mkdtemp(join(dirname(dest), '.smirk-candidate-'));
  const staged = join(temp, 'staged');
  await mkdir(staged);
  const extractor = join(dirname(fileURLToPath(import.meta.url)), 'extract-release-candidate.py');
  try {
    for (const candidate of candidates) {
      const response = await get(candidate.url || `${api}/actions/artifacts/${candidate.id}/zip`);
      const archive = join(temp, `${candidate.platform}.zip`);
      await writeFile(archive, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
      const unpacked = join(temp, `${candidate.platform}-upload`);
      execFileSync('python3', [extractor, archive, unpacked], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (candidate.platform === 'extension') {
        for (const file of await readdir(unpacked)) await rename(join(unpacked, file), join(staged, file));
      } else {
        const files = await readdir(unpacked);
        const expected = `${candidate.name}.tar.gz`;
        if (files.length !== 1 || files[0] !== expected) throw new Error(`${candidate.platform} upload does not contain its exact candidate archive`);
        execFileSync('python3', [extractor, join(unpacked, expected), join(staged, candidate.platform)], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
    }
    await verifyArtifacts(staged, version, commit);
    await rename(staged, dest);
    console.log(`Verified candidates from run ${runId}, source ${commit}, staged in ${dest}`);
    console.log(`Next, with SMIRK_SIGNING_KEY set to the full release subkey fingerprint: scripts/sign-release.sh ${version} --bundle-dir '${dest.replaceAll("'", "'\\''")}' --expect-commit ${commit}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(failure => { console.error(`fetch-release-artifacts: ${failure.message}`); process.exitCode = 1; });
}
