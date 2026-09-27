import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { requiredChecks, requireSourceChecks } from '../ci/source-gate.mjs';

const green = () => Object.fromEntries(requiredChecks.map(name => [name, { result: 'success' }]));

test('source aggregation requires successful evidence from every dependency', () => {
  assert.doesNotThrow(() => requireSourceChecks(green()));
  for (const name of requiredChecks) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined, 'unknown']) {
      const needs = green(); needs[name] = { result };
      assert.throws(() => requireSourceChecks(needs), /result is/);
    }
    const missing = green(); delete missing[name];
    assert.throws(() => requireSourceChecks(missing), /no result/);
  }
  assert.throws(() => requireSourceChecks({ ...green(), future: { result: 'failure' } }), /future/);
  for (const absent of [undefined, null, [], {}]) assert.throws(() => requireSourceChecks(absent));
});

test('CI always aggregates every source job even when a dependency did not succeed', () => {
  const workflow = yaml.load(readFileSync(new URL('../../.gitea/workflows/ci.yml', import.meta.url), 'utf8'));
  const gate = workflow.jobs['source-gate'];
  assert.ok(gate);
  assert.match(gate.if, /always\(\)/);
  for (const name of Object.keys(workflow.jobs).filter(name => name !== 'source-gate')) {
    assert.ok(gate.needs.includes(name), `${name} must contribute to the source gate`);
  }
  for (const name of requiredChecks) assert.ok(gate.needs.includes(name), `${name} must produce evidence`);
  const step = gate.steps.find(item => item.run?.includes('scripts/ci/source-gate.mjs'));
  assert.ok(step);
  assert.equal(step.env.NEEDS_JSON, '${{ toJSON(needs) }}');
});
