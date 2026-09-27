import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { selectCandidates, fetchSameOrigin, treeObjectId, readRunBinding } from '../fetch-release-artifacts.mjs';

const commit = '1'.repeat(40);
const version = '0.3.0';
const run = { head_sha: commit, status: 'completed', conclusion: 'success' };
const listing = () => ({ artifacts: ['macos', 'linux', 'windows', 'extension'].map((platform, index) => ({
  name: `${platform === 'extension' ? 'smirk-extension' : `smirk-desktop-${platform}`}-v${version}-${commit}`,
  id: index + 1, expired: false,
})) });

test('complete API tree entries reproduce Git identity without trusting the API sha label', t => {
  const temp = mkdtempSync(join(tmpdir(), 'smirk-api-tree-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', temp, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(temp, 'a')); writeFileSync(join(temp, 'a', 'child'), 'directory');
  writeFileSync(join(temp, 'a.c'), 'sort before directory');
  writeFileSync(join(temp, 'z run'), 'executable', { mode: 0o755 });
  symlinkSync('a.c', join(temp, 'link'));
  git('add', '.');
  const expected = git('write-tree');
  const entries = git('ls-tree', expected).split('\n').map(line => {
    const [metadata, path] = line.split('\t');
    const [mode, type, sha] = metadata.split(' ');
    return { mode, type, sha, path };
  });
  const response = { sha: commit, tree: entries.reverse(), truncated: false, page: 1, total_count: entries.length };
  assert.equal(treeObjectId(response), expected);
  assert.notEqual(expected, commit);
  for (const changed of [
    { truncated: true }, { total_count: entries.length + 1 }, { page: 2 },
    { tree: [...entries, entries[0]], total_count: entries.length + 1 },
    { tree: [{ ...entries[0], path: '../escape' }], total_count: 1 },
    { tree: [{ ...entries[0], type: 'unknown' }], total_count: 1 },
  ]) assert.throws(() => treeObjectId({ ...response, ...changed }), /evidence/);
});

test('collection verifies exact workflow, wrapper parents and independent tree readbacks', async () => {
  const source = '2'.repeat(40); const base = '3'.repeat(40);
  const tree = { sha: commit, page: 1, total_count: 1, truncated: false,
    tree: [{ path: 'app', type: 'blob', mode: '100644', sha: '4'.repeat(40) }] };
  const admittedRun = { ...run, event: 'workflow_dispatch', head_branch: 'main', path: 'desktop-build.yml@refs/heads/main' };
  const get = async url => {
    if (url.includes('/trees/')) return tree;
    if (url.endsWith(commit)) return { sha: commit, parents: [{ sha: base }, { sha: source }] };
    if (url.endsWith(source)) return { sha: source };
    throw new Error('unexpected API request');
  };
  const binding = await readRunBinding(admittedRun, '/api', commit, get);
  assert.equal(binding.sourceCommit, commit);
  assert.equal(binding.approvedSourceCommit, source);
  assert.equal(binding.ingressBaseCommit, base);
  assert.equal(binding.sourceTree, treeObjectId(tree));
  await assert.rejects(readRunBinding({ ...admittedRun, event: 'push' }, '/api', commit, get), /workflow dispatch/);
  await assert.rejects(readRunBinding(admittedRun, '/api', commit, async url => {
    const body = await get(url);
    return url.includes(`/trees/${source}`) ? { ...tree, tree: [{ ...tree.tree[0], sha: '5'.repeat(40) }] } : body;
  }), /tree differs/);
});

test('collection selects all exact-source candidates from one successful run', () => {
  const selected = selectCandidates(run, listing(), version, commit);
  for (const platform of ['macos', 'linux', 'windows', 'extension']) assert.ok(selected.some(item => item.platform === platform));
});

test('collection refuses stale source, unsuccessful runs, and absent evidence', () => {
  assert.throws(() => selectCandidates({ ...run, head_sha: '2'.repeat(40) }, listing(), version, commit), /source/);
  assert.throws(() => selectCandidates({ ...run, conclusion: 'failure' }, listing(), version, commit), /success/);
  assert.throws(() => selectCandidates({ ...run, status: 'in_progress' }, listing(), version, commit), /success/);
  assert.throws(() => selectCandidates(run, {}, version, commit), /unknown/);
  assert.throws(() => selectCandidates(run, { artifacts: [] }, version, commit), /macos/);
  const missing = listing(); missing.artifacts = missing.artifacts.filter(item => !item.name.includes('linux'));
  assert.throws(() => selectCandidates(run, missing, version, commit), /linux/);
  const duplicate = listing(); duplicate.artifacts.push(duplicate.artifacts[0]);
  assert.throws(() => selectCandidates(run, duplicate, version, commit), /macos/);
  const expired = listing(); expired.artifacts[0].expired = true;
  assert.throws(() => selectCandidates(run, expired, version, commit), /expired/);
});

test('authenticated candidate requests never follow an external redirect', async () => {
  const contacted = [];
  await assert.rejects(fetchSameOrigin('https://forge.test/api', 'https://forge.test', 'test-only', async (url) => {
    contacted.push(url.origin);
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.test/archive' } });
  }), /outside/);
  assert.deepEqual(contacted, ['https://forge.test']);
  await assert.rejects(fetchSameOrigin('http://forge.test/api', 'https://forge.test', 'test-only', () => { throw new Error('must not run'); }), /HTTPS/);
});

test('same-host redirects work and TLS refusal preserves the cause code without credentials', async () => {
  let calls = 0;
  const response = await fetchSameOrigin('https://forge.test/api', 'https://forge.test', 'test-only', async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { location: '/archive' } }) : new Response('candidate');
  });
  assert.equal(await response.text(), 'candidate');
  await assert.rejects(fetchSameOrigin('https://forge.test/api', 'https://forge.test', 'test-only', async () => {
    throw new Error('private request diagnostics', { cause: { code: 'CERT_HAS_EXPIRED' } });
  }), failure => failure.message.includes('CERT_HAS_EXPIRED') && !failure.message.includes('private'));
});

test('safe extraction preserves bytes and refuses traversal, links, and duplicates', () => {
  const temp = mkdtempSync(join(tmpdir(), 'smirk-extract-test-'));
  const extractor = resolve('scripts/extract-release-candidate.py');
  try {
    const create = spawnSync('python3', ['-c', `import zipfile, tarfile, io, sys
from pathlib import Path
root=Path(sys.argv[1])
with zipfile.ZipFile(root/'good.zip','w') as z: z.writestr('payload.txt','candidate bytes')
with zipfile.ZipFile(root/'traversal.zip','w') as z: z.writestr('../outside','bad')
with zipfile.ZipFile(root/'duplicate.zip','w') as z:
 z.writestr('payload','first'); z.writestr('payload','second')
with tarfile.open(root/'link.tar.gz','w:gz') as t:
 entry=tarfile.TarInfo('link'); entry.type=tarfile.SYMTYPE; entry.linkname='/outside'; t.addfile(entry)
`, temp], { encoding: 'utf8' });
    assert.equal(create.status, 0);
    const good = spawnSync('python3', [extractor, join(temp, 'good.zip'), join(temp, 'good')], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(join(temp, 'good/payload.txt'), 'utf8'), 'candidate bytes');
    for (const name of ['traversal.zip', 'duplicate.zip', 'link.tar.gz']) {
      const bad = spawnSync('python3', [extractor, join(temp, name), join(temp, `${name}-out`)], { encoding: 'utf8' });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /unsafe|duplicate|link|special/);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
