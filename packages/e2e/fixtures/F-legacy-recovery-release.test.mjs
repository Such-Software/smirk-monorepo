// The release pin must accept exactly the unpacked zip it was given and refuse
// any other build: a different zip, a changed file, a missing file or an extra
// one. Builds its own small zips (stored and deflated entries), no fixtures:
//   node --test packages/e2e/fixtures/F-legacy-recovery-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { readZipEntries, verifyUnpackedRelease } from './F-legacy-recovery-release.mjs';

/** A minimal zip writer: one local header and one central entry per file. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text);
    const body = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const FILES = [
  ['manifest.json', JSON.stringify({ version: '0.3.1' }), false],
  ['background.js', 'self.addEventListener("install", () => {});\n'.repeat(40), true],
  ['chunks/popup.js', 'export const x = 1;\n', true],
];

function unpack(root, files) {
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

test('the zip reader returns every file entry, stored or deflated', () => {
  const entries = readZipEntries(makeZip(FILES));
  assert.deepEqual(entries.map((e) => e.name), FILES.map(([n]) => n));
  for (const [name, text] of FILES) assert.equal(entries.find((e) => e.name === name)?.data.toString(), text);
});

test('the release pin accepts the unpacked zip and refuses anything else', () => {
  const work = mkdtempSync(join(tmpdir(), 'f-legacy-release-'));
  try {
    const zip = join(work, 'smirk-wallet-chrome-v0.3.1.zip');
    const bytes = makeZip(FILES);
    writeFileSync(zip, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dir = join(work, 'unpacked');
    unpack(dir, FILES);

    const facts = verifyUnpackedRelease({ dir, zip, expectedSha256: sha });
    assert.equal(facts.version, '0.3.1');
    assert.equal(facts.files, FILES.length);

    assert.throws(() => verifyUnpackedRelease({ dir, zip, expectedSha256: '0'.repeat(64) }), /not the pinned/);

    writeFileSync(join(dir, 'chunks/popup.js'), 'export const x = 2;\n');
    assert.throws(() => verifyUnpackedRelease({ dir, zip, expectedSha256: sha }), /differs chunks\/popup\.js/);
    unpack(dir, FILES);

    writeFileSync(join(dir, 'injected.js'), 'alert(1)');
    assert.throws(() => verifyUnpackedRelease({ dir, zip, expectedSha256: sha }), /extra injected\.js/);
    rmSync(join(dir, 'injected.js'));

    rmSync(join(dir, 'background.js'));
    assert.throws(() => verifyUnpackedRelease({ dir, zip, expectedSha256: sha }), /missing background\.js/);
    unpack(dir, FILES);

    // Provenance beside the zip must name the same hash.
    writeFileSync(join(work, 'RELEASE-PROVENANCE-extension-v0.3.1.json'), JSON.stringify({ artifacts: [{ name: 'smirk-wallet-chrome-v0.3.1.zip', sha256: '1'.repeat(64) }] }));
    assert.throws(() => verifyUnpackedRelease({ dir, zip, expectedSha256: sha }), /does not name/);
    writeFileSync(
      join(work, 'RELEASE-PROVENANCE-extension-v0.3.1.json'),
      JSON.stringify({ source_commit: 'b615d731', artifacts: [{ name: 'smirk-wallet-chrome-v0.3.1.zip', sha256: sha }] }),
    );
    assert.equal(verifyUnpackedRelease({ dir, zip, expectedSha256: sha }).sourceCommit, 'b615d731');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
