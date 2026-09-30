#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fullCommit = /^[0-9a-f]{40}$/;

export function admitDispatch(context) {
  if (context.event !== 'workflow_dispatch') throw new Error('Candidate builds require an explicit workflow dispatch');
  if (context.repository !== 'Builds/smirk-monorepo') throw new Error('Candidate builds require the declared Builds repository');
  if (context.ref !== 'refs/heads/main') throw new Error('Candidate builds require the protected main branch');
  if (!fullCommit.test(context.expectedSha ?? '')) throw new Error('expected_sha must be a full reviewed dispatch commit');
  if (context.sha !== context.expectedSha) throw new Error('Dispatch head changed from expected_sha');
}

export function proveBuildIdentity(build, source, expectedCommit) {
  if (!fullCommit.test(expectedCommit ?? '') || build?.sha !== expectedCommit) {
    throw new Error('Build commit does not match the expected dispatch head');
  }
  if (!Array.isArray(build.parents) || build.parents.length !== 2
      || build.parents.some(parent => !fullCommit.test(parent ?? ''))
      || build.parents.includes(build.sha) || build.parents[0] === build.parents[1]) {
    throw new Error('Build commit must be a two-parent ingress wrapper');
  }
  if (source?.sha !== build.parents[1]) throw new Error('Approved source must be the second wrapper parent');
  if (!fullCommit.test(build.tree ?? '') || source.tree !== build.tree) {
    throw new Error('Build wrapper tree differs from the approved source tree');
  }
  return {
    sourceCommit: build.sha,
    sourceTree: build.tree,
    approvedSourceCommit: source.sha,
    ingressBaseCommit: build.parents[0],
  };
}

export function inspectBuildIdentity(directory, expectedCommit) {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const sha = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  // Read the commit object: shallow traversal can hide parents in rev-list.
  const parents = git('cat-file', '-p', sha).split('\n\n', 1)[0].split('\n')
    .filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.length !== 2 || parents.some(parent => !fullCommit.test(parent))) {
    throw new Error('Build commit must be a two-parent ingress wrapper');
  }
  return proveBuildIdentity({ sha, tree, parents }, {
    sha: parents[1], tree: git('rev-parse', `${parents[1]}^{tree}`),
  }, expectedCommit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    admitDispatch({
      event: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
      expectedSha: process.env.EXPECTED_SHA,
    });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const identity = inspectBuildIdentity(root, process.env.EXPECTED_SHA);
    if (!process.env.GITHUB_OUTPUT) throw new Error('Workflow output path is missing');
    appendFileSync(process.env.GITHUB_OUTPUT,
      `build_commit=${identity.sourceCommit}\napproved_source_commit=${identity.approvedSourceCommit}\n`
      + `ingress_base_commit=${identity.ingressBaseCommit}\nsource_tree=${identity.sourceTree}\n`);
    console.log(`Admitted build ${identity.sourceCommit} from approved source ${identity.approvedSourceCommit}`);
  } catch (failure) {
    const cause = typeof failure?.status === 'number'
      ? 'Git could not read the exact build commit and source-parent tree' : failure.message;
    console.error(`release-admission: ${cause}`);
    process.exitCode = 1;
  }
}
