import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { admitDispatch, inspectBuildIdentity, proveBuildIdentity } from '../release-admission.mjs';

const buildCommit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);
const baseCommit = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const context = { event: 'workflow_dispatch', repository: 'Builds/smirk-monorepo',
  ref: 'refs/heads/main', sha: buildCommit, expectedSha: buildCommit };

test('GitHub publication cannot execute a second workflow lane', () => {
  const directory = new URL('../../.github/workflows/', import.meta.url);
  if (!existsSync(directory)) return;
  for (const path of readdirSync(directory, { recursive: true })) {
    assert.equal(/\.ya?ml$/i.test(path), false,
      `${path} introduces executable GitHub automation outside the Gitea build lane`);
  }
});

test('candidate admission refuses any changed dispatch boundary', () => {
  assert.doesNotThrow(() => admitDispatch(context));
  for (const change of [
    { event: 'push' }, { event: 'pull_request' },
    { repository: 'Such-Software/smirk-monorepo' }, { ref: 'refs/tags/v0.3.0' },
    { expectedSha: '' }, { expectedSha: buildCommit.slice(0, 8) }, { sha: sourceCommit },
  ]) assert.throws(() => admitDispatch({ ...context, ...change }), /require|expected_sha|changed/);
});

test('wrapper proof preserves build, source and previous ingress identities', () => {
  const build = { sha: buildCommit, tree, parents: [baseCommit, sourceCommit] };
  const source = { sha: sourceCommit, tree };
  assert.deepEqual(proveBuildIdentity(build, source, buildCommit), {
    sourceCommit: buildCommit, sourceTree: tree,
    approvedSourceCommit: sourceCommit, ingressBaseCommit: baseCommit,
  });
  for (const changed of [
    { sha: baseCommit }, { parents: [] }, { parents: [sourceCommit] },
    { parents: [baseCommit, sourceCommit, buildCommit] }, { parents: [baseCommit, baseCommit] },
    { parents: [buildCommit, sourceCommit] },
    { parents: [sourceCommit, baseCommit] }, { tree: 'e'.repeat(40) },
  ]) assert.throws(() => proveBuildIdentity({ ...build, ...changed }, source, buildCommit));
  assert.throws(() => proveBuildIdentity(build, { ...source, sha: baseCommit }, buildCommit));
});

test('real shallow checkout retains exact source-parent proof and rejects a dirty wrapper tree', t => {
  const temp = mkdtempSync(join(tmpdir(), 'smirk-admission-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'source');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.name', 'Release test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'source.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'test: base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'source.txt'), 'reviewed source'); git('add', '.'); git('commit', '-qm', 'test: source');
  const source = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const wrapper = git('commit-tree', sourceTree, '-p', base, '-p', source, '-m', 'test: ingress wrapper');
  git('update-ref', 'refs/heads/main', wrapper);
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  const clone = join(temp, 'checkout');
  execFileSync('git', ['clone', '-q', '--depth=2', `file://${repo}`, clone]);
  const binding = inspectBuildIdentity(clone, wrapper);
  assert.equal(binding.approvedSourceCommit, source);
  assert.equal(binding.ingressBaseCommit, base);
  assert.equal(binding.sourceTree, sourceTree);
  assert.throws(() => inspectBuildIdentity(clone, source), /expected dispatch/);
  const changed = git('commit-tree', git('rev-parse', `${base}^{tree}`), '-p', base, '-p', source, '-m', 'test: wrong tree');
  git('update-ref', 'refs/heads/main', changed);
  assert.throws(() => inspectBuildIdentity(repo, changed), /tree differs/);
});

test('candidate workflow requires admission before any platform or secret consumer', () => {
  const workflow = yaml.load(readFileSync(new URL('../../.gitea/workflows/desktop-build.yml', import.meta.url), 'utf8'));
  assert.ok(workflow.on.workflow_dispatch.inputs.expected_sha.required);
  assert.equal(workflow.on.push, undefined);
  const admission = workflow.jobs.admission;
  assert.ok(admission);
  const serializedAdmission = JSON.stringify(admission);
  assert.equal(serializedAdmission.includes('secrets.'), false);
  assert.ok(admission.steps.some(step => step.run?.includes('scripts/release-admission.mjs')));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'admission') continue;
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes('admission'), `${name} must wait for admission`);
    for (const checkout of job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))) {
      assert.equal(checkout.with.ref, '${{ needs.admission.outputs.build_commit }}');
      assert.ok(checkout.with['fetch-depth'] >= 2);
    }
  }
});
