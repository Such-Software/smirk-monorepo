// The E-swaps build proof: an unpacked build must be exactly its release zip.
// Run: node --test packages/e2e/fixtures/E-swaps-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { proveBuild, readZip } from './E-swaps-build.mjs';

/** A minimal zip writer (store or deflate, no CRC check on read). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const nameBytes = Buffer.from(name);
    const data = content === null ? Buffer.alloc(0) : Buffer.from(content);
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const MANIFEST = JSON.stringify({ name: 'Smirk Wallet', version: '0.3.1', manifest_version: 3 });
const ENTRIES = [
  ['manifest.json', MANIFEST, false],
  ['chunks/', null, false],
  ['chunks/app.js', 'console.log("app");'.repeat(50), true],
  ['wasm/core.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), false],
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'e-swaps-build-'));
  const dist = join(root, 'dist');
  for (const [name, content] of ENTRIES) {
    if (content === null) continue;
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), content);
  }
  const zipPath = join(root, 'release.zip');
  const bytes = zip(ENTRIES);
  writeFileSync(zipPath, bytes);
  return { root, dist, zipPath, sha: createHash('sha256').update(bytes).digest('hex') };
}

test('the reader returns every file of a store-and-deflate zip, skipping directories', () => {
  const files = readZip(zip(ENTRIES));
  assert.deepEqual([...files.keys()].sort(), ['chunks/app.js', 'manifest.json', 'wasm/core.wasm']);
  assert.equal(files.get('chunks/app.js').toString(), 'console.log("app");'.repeat(50));
});

test('an unpacked build that is exactly its zip is proved, with the zip hash', () => {
  const f = fixture();
  try {
    const proof = proveBuild({ distDir: f.dist, zipPath: f.zipPath, expectZipSha256: f.sha });
    assert.equal(proof.manifestVersion, '0.3.1');
    assert.equal(proof.zip?.sha256, f.sha);
    assert.equal(proof.zip?.matchesDist, true);
    // Host litter is not part of the build.
    writeFileSync(join(f.dist, '.DS_Store'), 'x');
    assert.ok(proveBuild({ distDir: f.dist, zipPath: f.zipPath }).zip);
    // Without a zip there is a manifest and a tree hash, and no zip proof.
    assert.equal(proveBuild({ distDir: f.dist }).zip, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a changed, missing or extra file, or another zip, is refused', () => {
  const cases = [
    ['a changed file', (f) => writeFileSync(join(f.dist, 'chunks', 'app.js'), 'tampered')],
    ['a missing file', (f) => rmSync(join(f.dist, 'wasm', 'core.wasm'))],
    ['an extra file', (f) => writeFileSync(join(f.dist, 'chunks', 'extra.js'), '1')],
  ];
  for (const [name, change] of cases) {
    const f = fixture();
    try {
      change(f);
      assert.throws(() => proveBuild({ distDir: f.dist, zipPath: f.zipPath }), undefined, name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const f = fixture();
  try {
    assert.throws(() => proveBuild({ distDir: f.dist, zipPath: f.zipPath, expectZipSha256: '0'.repeat(64) }));
    assert.throws(() => proveBuild({ distDir: f.dist, expectZipSha256: f.sha }), undefined, 'an expected hash needs the zip');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unsafe or unsupported zips are refused', () => {
  assert.throws(() => readZip(zip([['../escape.js', 'x', false]])));
  assert.throws(() => readZip(Buffer.from('not a zip at all, just bytes')));
});
