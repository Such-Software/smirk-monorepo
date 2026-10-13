// Re-binding the live lanes to a release candidate: only from a staged release
// that verifies, matches its provenance and is stamped clean.
// Run: node --test packages/e2e/scripts/rebind-release-candidate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { parseReleaseCandidate } from '../fixtures/release-candidate.mjs';
import { RebindRefusal, candidateFromStaged, changes, main } from './rebind-release-candidate.mjs';

const SOURCE = '6ce080a5296b2fe1c9656a2c43c59d41501e1937';
const WRAPPER = '0e4aef95f9b653fdbb56484fa9f5401866f3b363';
const VERSION = '0.3.1';
const RUN = '12345';

/** A stored (uncompressed) zip of [name, text] files. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
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

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A staged release under a temp root; `tweak` changes one thing about it. */
function stage(tweak = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rebind-'));
  const dir = join(root, tweak.label ?? `v${VERSION}-run-${RUN}`, 'staged');
  mkdirSync(dir, { recursive: true });
  const stamp = tweak.stamp ?? WRAPPER.slice(0, 7);
  const chrome = makeZip([
    ['manifest.json', JSON.stringify({ version: tweak.chromeVersion ?? VERSION })],
    ['assets/popup.js', `const c=${JSON.stringify(stamp)};export{c};`],
  ]);
  const firefox = makeZip([['manifest.json', JSON.stringify({ version: VERSION })], ['assets/popup.js', 'export{};']]);
  writeFileSync(join(dir, `smirk-wallet-chrome-v${VERSION}.zip`), chrome);
  writeFileSync(join(dir, `smirk-wallet-firefox-v${VERSION}.zip`), firefox);
  writeFileSync(
    join(dir, `RELEASE-PROVENANCE-extension-v${VERSION}.json`),
    JSON.stringify({
      schema: 'smirk-release-artifacts-v2',
      version: VERSION,
      platform: 'extension',
      source_commit: WRAPPER,
      approved_source_commit: tweak.approved ?? SOURCE,
      artifacts: [
        { name: `smirk-wallet-chrome-v${VERSION}.zip`, sha256: tweak.chromeSha ?? sha(chrome) },
        { name: `smirk-wallet-firefox-v${VERSION}.zip`, sha256: sha(firefox) },
      ],
    }),
  );
  return { root, dir, chromeSha: sha(chrome), firefoxSha: sha(firefox) };
}

function withStage(tweak, fn) {
  const s = stage(tweak);
  try {
    fn(s);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
}

const verified = () => {
  const calls = [];
  const verify = (...args) => calls.push(args);
  return { verify, calls };
};

test('a verified, clean staged release becomes the candidate every lane reads', () => {
  withStage({}, ({ dir, chromeSha, firefoxSha }) => {
    const { verify, calls } = verified();
    const c = candidateFromStaged({ staged: dir, run: RUN, source: SOURCE, verify });
    assert.deepEqual(calls, [[dir, VERSION, WRAPPER]], 'the whole release is verified at its build commit');
    assert.equal(c.version, VERSION);
    assert.equal(c.run, RUN);
    assert.equal(c.sourceCommit, SOURCE);
    assert.equal(c.buildsWrapper, WRAPPER);
    assert.equal(c.chromeZip.sha256, chromeSha);
    assert.equal(c.firefoxZip.sha256, firefoxSha);
    const rc = parseReleaseCandidate(c);
    assert.ok(rc.stagedDir.endsWith(join(`v${VERSION}-run-${RUN}`, 'staged')));
    assert.deepEqual([...rc.stampCommits], [SOURCE.slice(0, 7), WRAPPER.slice(0, 7)]);
  });
  // The source stamp is as good as the wrapper's.
  withStage({ stamp: SOURCE.slice(0, 7) }, ({ dir }) => {
    assert.equal(candidateFromStaged({ staged: dir, run: RUN, source: SOURCE, verify: () => {} }).sourceCommit, SOURCE);
  });
});

test('every mismatch refuses, and says which', () => {
  const cases = [
    [{ stamp: `${WRAPPER.slice(0, 7)}-dirty` }, /dirty|modified tree/],
    [{ stamp: 'deadbee' }, /build stamp/],
    [{ approved: 'f'.repeat(40) }, /approved for source/],
    [{ chromeSha: '0'.repeat(64) }, /hashes to/],
    [{ chromeVersion: '0.3.0' }, /manifest/],
    [{ label: `v${VERSION}-run-999` }, /--staged must be/],
  ];
  for (const [tweak, why] of cases) {
    withStage(tweak, ({ dir }) => {
      assert.throws(() => candidateFromStaged({ staged: dir, run: RUN, source: SOURCE, verify: () => {} }), (e) => e instanceof RebindRefusal && why.test(e.message), JSON.stringify(tweak));
    });
  }
  withStage({}, ({ dir }) => {
    const fail = () => {
      throw new Error('macos source provenance is missing; rebuild this release');
    };
    assert.throws(() => candidateFromStaged({ staged: dir, run: RUN, source: SOURCE, verify: fail }), /does not verify: macos/);
    assert.throws(() => candidateFromStaged({ staged: dir, run: 'abc', source: SOURCE, verify: () => {} }), /--run/);
    assert.throws(() => candidateFromStaged({ staged: dir, run: RUN, source: SOURCE.slice(0, 12), verify: () => {} }), /--source/);
    assert.throws(() => candidateFromStaged({ staged: join(dir, 'absent'), run: RUN, source: SOURCE, verify: () => {} }), /--staged/);
  });
});

test('a dry run writes nothing; --write replaces only the candidate file, and the diff names the changes', () => {
  withStage({}, ({ root }) => {
    const file = join(root, 'release-candidate.json');
    const old = { version: VERSION, run: '11204', sourceCommit: 'a'.repeat(40), buildsWrapper: 'b'.repeat(40), chromeZip: { sha256: '1'.repeat(64) }, firefoxZip: { sha256: '2'.repeat(64) } };
    writeFileSync(file, JSON.stringify(old));
    const staged = join(root, `v${VERSION}-run-${RUN}`, 'staged');
    // The CLI verifies with the real verifier, which this fake release cannot pass.
    assert.throws(() => main(['--staged', staged, '--run', RUN, '--source', SOURCE, '--write'], file), /does not verify/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), old, 'a refusal leaves the file alone');
    const next = candidateFromStaged({ staged, run: RUN, source: SOURCE, verify: () => {} });
    const diff = changes(old, next);
    for (const field of ['run', 'sourceCommit', 'buildsWrapper', 'chromeZip.sha256', 'firefoxZip.sha256']) {
      assert.ok(diff.some((d) => d.startsWith(`${field}:`)), field);
    }
    assert.ok(!diff.some((d) => d.startsWith('version:')), 'an unchanged field is not listed');
    assert.throws(() => main(['--staged', staged, '--bogus'], file), /unknown argument/);
  });
});
