/**
 * Offline checks of the v0.3.1 release runner (scripts/live-v031.mjs): the
 * order, the gates, the owner's decisions and what each lane receives. No
 * browser, wallet, backend or funds.
 *
 *   node --test scripts/live-v031.test.mjs
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DECISIONS,
  PHASES,
  REQUIRED_GATES,
  Refusal,
  custodyProblems,
  decisionProblems,
  gateProblems,
  newDirs,
  offlineEnv,
  parseArgs,
  phaseCommands,
  phaseEnv,
  planPhases,
  readDecisions,
  secretEnvProblems,
} from './live-v031.mjs';

const E2E = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = PHASES.map((p) => p.id);
const before = (a, b) => ids.indexOf(a) < ids.indexOf(b);

const ALL_YES = Object.fromEntries(DECISIONS.map((d) => [d.key, true]));
const ALL_NO = Object.fromEntries(DECISIONS.map((d) => [d.key, false]));

function ctx(decisions, env = {}) {
  return {
    runDir: '/run/v031',
    runId: 'v031-test',
    walletFile: '/custody/file',
    backend: 'https://api.example.test/api/v1',
    stagedDir: '/staged',
    chromeZip: '/staged/chrome.zip',
    firefoxZip: '/staged/firefox.zip',
    chromeDir: '/run/v031/release/chrome',
    decisions,
    font: '/font.ttf',
    env,
    attemptId: '1',
    attemptStartedAt: Date.UTC(2026, 9, 10, 12),
  };
}
const phase = (id) => PHASES.find((p) => p.id === id);

test('the run order keeps every dependency the survey names', () => {
  assert.equal(ids[0], 'baseline', 'the baseline is read before any money moves');
  assert.equal(ids.at(-1), 'closeout', 'the final balances are read last');
  assert.ok(before('A', 'E') && before('E', 'B'), 'A, then the slow swap first, then the first send hops');
  assert.ok(before('E', 'G'), "G's LTC purchase comes after E's LTC to BTC swap lands");
  assert.ok(before('B', 'F'), "F's seeded moves come after B's hops");
  assert.ok(before('B', 'D') && before('D', 'C'), "D's exact balance check runs before any tip claim can be confirming into carol");
  for (const money of ['B', 'C', 'E', 'G', 'F']) assert.ok(before(money, 'H-firefox'), `area H runs after ${money}`);
  assert.equal(new Set(ids).size, ids.length, 'phase ids are unique');
});

test('every live spec belongs to exactly one lane config, and every Playwright phase names a config that exists', () => {
  const configs = readdirSync(E2E).filter((f) => /\.config\.ts$/.test(f) && /live/.test(f));
  const matchers = configs.map((file) => {
    const text = readFileSync(join(E2E, file), 'utf8');
    const literal = text.match(/testMatch:\s*\/(.+?)\/([a-z]*)\s*[,}]/);
    assert.ok(literal, `${file} declares a testMatch`);
    return { file, re: new RegExp(literal[1], literal[2]) };
  });
  const specs = readdirSync(join(E2E, 'tests', 'live')).filter((f) => f.endsWith('.live.spec.ts'));
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    const owners = matchers.filter((m) => m.re.test(join(E2E, 'tests', 'live', spec))).map((m) => m.file);
    assert.equal(owners.length, 1, `${spec} is collected by exactly one lane config (got ${owners.join(', ') || 'none'})`);
  }
  for (const p of PHASES.filter((p) => p.kind === 'playwright')) {
    assert.ok(configs.includes(p.config), `${p.id} runs ${p.config}, which exists`);
  }
});

test('arguments: unknown flags and phases refuse, selections compose', () => {
  assert.throws(() => parseArgs(['--fast']), Refusal);
  assert.throws(() => parseArgs(['--only']), Refusal);
  assert.throws(() => planPhases(parseArgs(['--only', 'Z']), 'linux'), Refusal);
  const only = planPhases(parseArgs(['--only', 'C,A']), 'linux').map((p) => p.id);
  assert.deepEqual(only, ids.filter((id) => id === 'A' || id === 'C'), '--only keeps the run order');
  const from = planPhases(parseArgs(['--from', 'D', '--except', 'H-macos']), 'linux').map((p) => p.id);
  assert.equal(from[0], 'D');
  assert.ok(!from.includes('H-macos'));
});

test('a phase bound to another host refuses unless excluded, and --list plans everything', () => {
  assert.throws(() => planPhases(parseArgs([]), 'linux'), Refusal);
  assert.ok(planPhases(parseArgs(['--except', 'H-macos']), 'linux').length === PHASES.length - 1);
  assert.equal(planPhases(parseArgs([]), 'darwin').length, PHASES.length);
  assert.equal(planPhases(parseArgs(['--list']), null).length, PHASES.length);
});

test('every owner decision must be answered yes or no; none is defaulted', () => {
  assert.equal(readDecisions({}).problems.length, DECISIONS.length);
  const odd = readDecisions(Object.fromEntries(DECISIONS.map((d) => [d.env, 'maybe'])));
  assert.equal(odd.problems.length, DECISIONS.length);
  const answered = readDecisions(Object.fromEntries(DECISIONS.map((d, i) => [d.env, i % 2 ? 'no' : 'YES'])));
  assert.equal(answered.problems.length, 0);
  DECISIONS.forEach((d, i) => assert.equal(answered.decisions[d.key], i % 2 === 0));
  assert.ok(decisionProblems({ ...ALL_YES }, {}).length >= 2, 'a yes that needs a host or URL refuses without it');
  assert.equal(decisionProblems({ ...ALL_NO }, {}).length, 0);
});

test('gates: each one is required, and switches that weaken the recording refuse', () => {
  const open = { ...REQUIRED_GATES, E2E_WALLET_FILE: '/custody/file' };
  assert.equal(gateProblems(open).length, 0);
  for (const name of Object.keys(REQUIRED_GATES)) {
    const { [name]: _, ...without } = open;
    assert.equal(gateProblems(without).length, 1, `${name} missing refuses`);
  }
  assert.equal(gateProblems({ ...open, FOOTAGE: 'raw' }).length, 1);
  for (const weaker of [{ FOOTAGE_ENCODE: '0' }, { E2E_LIVE_HOLDS: 'short' }, { HEADED: '1' }, { PWDEBUG: '1' }]) {
    assert.equal(gateProblems({ ...open, ...weaker }).length, 1, `${Object.keys(weaker)[0]} refuses`);
  }
});

test('a phrase or key in the environment refuses by name, never echoing its value', () => {
  const value = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const problems = secretEnvProblems({ SMOKE_ALICE_MNEMONIC: value, PATH: '/bin' });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('SMOKE_ALICE_MNEMONIC'));
  assert.ok(!problems[0].includes('abandon'));
  assert.equal(secretEnvProblems({ SMOKE_ALICE_MNEMONIC: '' }).length, 0);
});

test('custody file: owner-only, one line per demo wallet, and no value in any message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v031-custody-'));
  try {
    const file = join(dir, 'custody.env');
    const secret = 'zebra zone zoo';
    writeFileSync(file, ['SMOKE_ALICE_MNEMONIC', 'SMOKE_BOB_MNEMONIC', 'SMOKE_CAROL_MNEMONIC'].map((n) => `${n}=${secret}`).join('\n'));
    chmodSync(file, 0o644);
    assert.equal(custodyProblems(file).length, 1, 'group or world access refuses');
    chmodSync(file, 0o600);
    assert.equal(custodyProblems(file).length, 0);
    writeFileSync(file, `SMOKE_ALICE_MNEMONIC=${secret}\nSMOKE_ALICE_MNEMONIC=${secret}\n`);
    const problems = custodyProblems(file);
    assert.equal(problems.length, 3, 'a duplicate and two missing wallets');
    assert.ok(problems.every((p) => !p.includes('zebra')));
    assert.ok(custodyProblems(join(dir, 'absent')).length === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lane state never leaks between phases, and every output lands under the run directory', () => {
  const inherited = { E2E_MIN_EXECUTED: '1', C_TIPS_INVOCATION: 'old', EXTENSION_DIST: '/elsewhere', FOOTAGE_DIR: '/elsewhere', E2E_LANE: 'x' };
  for (const p of PHASES) {
    const env = phaseEnv(p, ctx(ALL_YES), inherited);
    assert.notEqual(env.C_TIPS_INVOCATION, 'old', `${p.id} does not inherit another invocation`);
    assert.notEqual(env.E2E_LANE, 'x');
    assert.notEqual(env.E2E_MIN_EXECUTED, '1', `${p.id} sets its own execution floor or leaves it to its config`);
    for (const name of ['EXTENSION_DIST', 'FOOTAGE_DIR', 'E2E_FOOTAGE_DIR', 'E2E_RUN_DIR', 'E2E_LIVE_RUN_DIR', 'E2E_REPORTS_DIR']) {
      if (env[name] !== undefined) assert.ok(env[name].startsWith('/run/v031/'), `${p.id}: ${name} is under the run directory`);
    }
    assert.equal(env.BACKEND_URL, 'https://api.example.test/api/v1');
    for (const cmd of [...phaseCommands(p, ctx(ALL_YES)), ...p.encode(ctx(ALL_YES))]) {
      const out = cmd.args.flatMap((a, i) => (['--out', '--out-root', '--run', '--footage', '--area'].includes(cmd.args[i - 1]) && a.startsWith('/') ? [a] : []));
      for (const path of out) assert.ok(path.startsWith('/run/v031/'), `${p.id}: ${cmd.label} writes under the run directory`);
    }
  }
});

test('lanes that verify the zip themselves get the zip, the others the verified unpacked copy', () => {
  for (const id of ['baseline', 'A', 'B', 'C', 'closeout']) {
    assert.equal(phaseEnv(phase(id), ctx(ALL_YES), { EXTENSION_DIST: '/x' }).EXTENSION_DIST, undefined, `${id} unpacks its verified zip itself`);
  }
  for (const id of ['D', 'E', 'F', 'G']) {
    assert.equal(phaseEnv(phase(id), ctx(ALL_YES), {}).EXTENSION_DIST, '/run/v031/release/chrome');
  }
});

test("each decision opens exactly the lane behaviour it names, and a no closes it", () => {
  const passThrough = { FED_BACKEND_URL: 'https://b.example.test/api/v1', E2E_LIVE_CAROL_HANDLE: 'c', E2E_CLAIM_BOB_HANDLE: 'b', ALLOW_PROD_WRITES: '1', E2E_LIVE_MONEY: '1', G_PREMIUM_CHECKOUT_HOST: 'pay.example.test' };
  const yes = (id) => phaseEnv(phase(id), ctx(ALL_YES, passThrough), passThrough);
  const no = (id) => phaseEnv(phase(id), ctx(ALL_NO, passThrough), passThrough);

  assert.equal(yes('A').ALLOW_PROD_WRITES, '1');
  assert.equal(no('A').ALLOW_PROD_WRITES, undefined, 'no identity writes: A writes nothing to production');
  assert.equal(no('D').E2E_LIVE_LINK, undefined);
  assert.equal(no('D').E2E_LIVE_CAROL_HANDLE, undefined);
  assert.equal(no('C').E2E_CLAIM_BOB_HANDLE, undefined);

  for (const id of ['C', 'D']) {
    assert.ok(yes(id).FED_BACKEND_URL);
    assert.equal(no(id).FED_BACKEND_URL, undefined);
    assert.ok((no(id).E2E_LIVE_ACK_GAPS ?? '').split(',').includes('federation'), `${id}: a declined backend B is an acknowledged gap`);
    assert.ok(!(yes(id).E2E_LIVE_ACK_GAPS ?? '').split(',').includes('federation'));
  }

  const eYes = phaseCommands(phase('E'), ctx(ALL_YES))[0].args;
  const eNo = phaseCommands(phase('E'), ctx(ALL_NO))[0].args;
  assert.ok(!eYes.includes('--grep-invert'));
  assert.ok(eNo.includes('--grep-invert'), 'no NonLogs swap: that one test is deselected');
  assert.equal(Number(yes('E').E2E_MIN_EXECUTED) - Number(no('E').E2E_MIN_EXECUTED), 1, 'and the floor drops by exactly that test');

  assert.equal(yes('G').E2E_PREMIUM_PURCHASE, '1');
  for (const name of ['E2E_PREMIUM_PURCHASE', 'E2E_LIVE_MONEY', 'E2E_PREMIUM_POST']) assert.equal(no('G')[name], undefined);
  assert.equal(yes('F').E2E_LIVE_MONEY, '1');
  assert.equal(no('F').E2E_LIVE_MONEY, undefined, 'no legacy fixture: F moves nothing');
  assert.equal(no('D').E2E_LIVE_FEED_POST, undefined);
  assert.equal(yes('D').E2E_LIVE_FEED_POST, '1');
});

test('the offline guard suites see no gate, decision or custody path of the run', () => {
  const env = offlineEnv({ ...REQUIRED_GATES, E2E_WALLET_FILE: '/f', V031_FEED_POST: 'yes', PATH: '/bin' });
  for (const name of [...Object.keys(REQUIRED_GATES), 'E2E_WALLET_FILE', 'V031_FEED_POST']) assert.equal(env[name], undefined);
  assert.equal(env.PATH, '/bin');
});

test("G's encoder is given only the run directories this attempt created", () => {
  const root = mkdtempSync(join(tmpdir(), 'v031-g-'));
  try {
    for (const name of ['20261010T110000Z', '20261010T120005Z', 'notes']) mkdirSync(join(root, name));
    const dirs = newDirs(root, Date.UTC(2026, 9, 10, 12));
    assert.deepEqual(dirs.map((d) => d.split('/').pop()), ['20261010T120005Z']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
