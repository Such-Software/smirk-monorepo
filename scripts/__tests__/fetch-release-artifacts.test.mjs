import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectCandidates, fetchSameOrigin } from '../fetch-release-artifacts.mjs';

const commit = '1'.repeat(40);
const version = '0.3.0';
const run = { head_sha: commit, status: 'completed', conclusion: 'success' };
const listing = () => ({ artifacts: ['macos', 'linux', 'windows', 'extension'].map((platform, index) => ({
  name: `${platform === 'extension' ? 'smirk-extension' : `smirk-desktop-${platform}`}-v${version}-${commit}`,
  id: index + 1, expired: false,
})) });

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
