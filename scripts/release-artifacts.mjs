#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platforms = ['extension', 'macos', 'linux', 'windows'];
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const fail = (message) => { throw new Error(message); };
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const receiptName = (platform, version) => `RELEASE-PROVENANCE-${platform}-v${version}.json`;

function requiredArtifacts(platform, version) {
  switch (platform) {
    case 'extension': return ['chrome', 'firefox', 'source'].map((target) => ({
      label: `${target} extension archive`,
      matches: (name) => name === `smirk-wallet-${target}-v${version}.zip`,
    }));
    case 'macos': return [
      { label: 'macOS disk image', matches: (name) => name.endsWith('.dmg') },
      { label: 'macOS updater archive', matches: (name) => name.endsWith('.app.tar.gz') },
    ];
    case 'linux': return [
      { label: 'Linux AppImage', matches: (name) => name.endsWith('.AppImage') },
      { label: 'Linux Debian package', matches: (name) => name.endsWith('.deb') },
    ];
    case 'windows': return [
      { label: 'Windows signed installer', matches: (name) => name.endsWith('-setup.exe') },
      { label: 'Windows signed portable', matches: (name) => name.endsWith('-portable.exe') },
      { label: 'Windows unsigned installer', matches: (name) => name.endsWith('-setup-unsigned.exe') },
      { label: 'Windows unsigned portable', matches: (name) => name.endsWith('-portable-unsigned.exe') },
    ];
    default: return fail(`unsupported release platform: ${platform}`);
  }
}

function artifact(name) {
  return /(?:\.zip|\.dmg|\.app\.tar\.gz|\.AppImage|\.deb|\.rpm|\.msi|\.exe)(?:\.sig)?$/.test(name)
    || /^TOOLCHAIN-v[^/]+\.txt$/.test(name);
}

function filesIn(directory) {
  return readdirSync(directory).filter((name) => artifact(name)).sort();
}

function assertRequired(names, platform, version) {
  for (const requirement of requiredArtifacts(platform, version)) {
    const hits = names.filter(requirement.matches);
    if (hits.length !== 1) fail(`${requirement.label}: expected one artifact, found ${hits.length}`);
  }
  if (platform === 'extension' && !names.includes(`TOOLCHAIN-v${version}.txt`)) {
    fail('extension toolchain provenance is missing');
  }
}

function assertRegularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`release input is not a regular file: ${basename(path)}`);
}

/** Record only build output. Signing and the combined checksum list come later. */
export function recordArtifacts(directory, platform, version, sourceCommit, sourceTree) {
  if (!versionPattern.test(version)) fail('invalid release version');
  if (!commitPattern.test(sourceCommit) || !commitPattern.test(sourceTree)) fail('invalid source identity');
  const names = filesIn(directory);
  assertRequired(names, platform, version);
  const artifacts = names.map((name) => {
    const path = join(directory, name);
    assertRegularFile(path);
    return { name, sha256: digest(path) };
  });
  const receipt = {
    schema: 'smirk-release-artifacts-v1', version, platform,
    source_commit: sourceCommit, source_tree: sourceTree, artifacts,
  };
  writeFileSync(join(directory, receiptName(platform, version)), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/** Refuse mixed builds, incomplete platforms, changed bytes, or extra artifacts. */
export function verifyArtifacts(directory, version, expectedCommit) {
  if (!versionPattern.test(version)) fail('invalid release version');
  if (!commitPattern.test(expectedCommit)) fail('--expect-commit must be a full source commit');
  let sourceTree;
  for (const platform of platforms) {
    const platformDir = platform === 'extension' ? directory : join(directory, platform);
    const receiptPath = join(platformDir, receiptName(platform, version));
    if (!existsSync(receiptPath)) fail(`${platform} source provenance is missing; rebuild this release`);
    assertRegularFile(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.schema !== 'smirk-release-artifacts-v1' || receipt.platform !== platform || receipt.version !== version) {
      fail(`${platform} provenance does not describe the requested release`);
    }
    if (receipt.source_commit !== expectedCommit || !commitPattern.test(receipt.source_tree)) {
      fail(`${platform} provenance does not match the expected source commit`);
    }
    sourceTree ??= receipt.source_tree;
    if (receipt.source_tree !== sourceTree) fail(`${platform} source tree differs from the other platforms`);
    if (!Array.isArray(receipt.artifacts)) fail(`${platform} artifact evidence is missing`);
    const recorded = new Set();
    for (const entry of receipt.artifacts) {
      if (!entry || typeof entry.name !== 'string' || entry.name !== basename(entry.name)
          || entry.name.includes('\\') || !artifact(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        fail(`${platform} has an invalid artifact evidence entry`);
      }
      // The updater packager normalizes spaces before the public upload.
      const candidates = [...new Set([entry.name, entry.name.replaceAll(' ', '.')])]
        .filter((name) => existsSync(join(platformDir, name)));
      if (candidates.length !== 1) fail(`${platform}: ${entry.name} is missing or ambiguous`);
      const name = candidates[0];
      if (recorded.has(name)) fail(`${platform}: duplicate artifact evidence for ${name}`);
      recorded.add(name);
      const path = join(platformDir, name);
      assertRegularFile(path);
      if (digest(path) !== entry.sha256) fail(`${platform}: artifact digest differs for ${name}`);
    }
    assertRequired([...recorded], platform, version);
    for (const name of filesIn(platformDir)) {
      if (!recorded.has(name)) fail(`${platform}: unrecorded artifact ${name}`);
    }
    if (platform === 'extension') {
      const toolchain = readFileSync(join(platformDir, `TOOLCHAIN-v${version}.txt`), 'utf8');
      if (!toolchain.split('\n').includes(`# commit: ${expectedCommit}`)) {
        fail('extension toolchain record belongs to a different source commit');
      }
    }
  }
  return { sourceCommit: expectedCommit, sourceTree };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    while (args.length) {
      const key = args.shift();
      if (!['--dir', '--platform', '--version', '--expect-commit'].includes(key) || !args[0]) fail(`invalid argument: ${key}`);
      options[key] = args.shift();
    }
    const directory = resolve(options['--dir'] ?? fail('--dir is required'));
    const version = options['--version'] ?? fail('--version is required');
    if (command === 'record') {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const git = (...argv) => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8' }).trim();
      if (git('status', '--porcelain', '--', ':!packages/extension/releases')) fail('release source is dirty');
      const receipt = recordArtifacts(directory, options['--platform'], version, git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'));
      console.log(`Recorded ${receipt.platform} artifact evidence at source ${receipt.source_commit}`);
    } else if (command === 'verify') {
      const result = verifyArtifacts(directory, version, options['--expect-commit']);
      console.log(`Verified all release artifacts at source ${result.sourceCommit}`);
    } else {
      fail('use record or verify');
    }
  } catch (error) {
    console.error(`release-artifacts: ${error.message}`);
    process.exitCode = 1;
  }
}
