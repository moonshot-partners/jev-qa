// Pure tests for phases (`then`), the per-run `{{run}}` value, `secretInputs` masking and the
// scenario validation around them — no browser, no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { maskSecrets } from '../src/runner.ts';
import { applyRunId, loadScenarios, newRunId, RUN_PLACEHOLDER, scenarioPhases, type Scenario } from '../src/scenario.ts';
import { decideVerdict } from '../src/verdict.ts';

test('newRunId: short, lowercase alphanumeric, unique across calls', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{8,16}$/);
});

test('applyRunId: substitutes {{run}} in start, goal, inputs, expect and phases (check args too), never in name', () => {
  const s: Scenario = {
    name: 'acceptance/signup-{{run}}',
    role: null,
    start: '/sign-up?ref={{run}}',
    goal: 'sign up as qa-{{run}}',
    inputs: { email: 'qa-{{run}}@example.test', company: 'Co {{run}} {{run}}' },
    expect: [{ text: 'Welcome Co {{run}}' }],
    then: [{ start: { check: { name: 'link', args: { inbox: 'qa-{{run}}@example.test' } } }, goal: 'finish {{run}}', inputs: { password: 'Pw-{{run}}!' } }],
  };
  const out = applyRunId(s, 'abc123');
  assert.equal(out.name, 'acceptance/signup-{{run}}', 'name is left alone');
  assert.equal(out.start, '/sign-up?ref=abc123');
  assert.equal(out.goal, 'sign up as qa-abc123');
  assert.deepEqual(out.inputs, { email: 'qa-abc123@example.test', company: 'Co abc123 abc123' });
  assert.deepEqual(out.expect, [{ text: 'Welcome Co abc123' }]);
  assert.deepEqual(out.then![0].start, { check: { name: 'link', args: { inbox: 'qa-abc123@example.test' } } });
  assert.equal(out.then![0].goal, 'finish abc123');
  assert.deepEqual(out.then![0].inputs, { password: 'Pw-abc123!' });
  assert.equal(JSON.stringify(s).includes('abc123'), false, 'the original is not mutated');
  assert.equal(RUN_PLACEHOLDER, '{{run}}');
});

test('scenarioPhases: main first, then each `then` entry, unnamed ones numbered', () => {
  const s: Scenario = { name: 'x', role: null, start: '/a', goal: 'g', maxSteps: 3, expect: [{ text: 'a' }], then: [{ start: '/b', goal: 'h' }, { name: 'last', start: '/c', goal: 'i' }] };
  const phases = scenarioPhases(s);
  assert.deepEqual(phases.map((p) => p.name), ['main', 'then #1', 'last']);
  assert.equal(phases[0].start, '/a');
  assert.equal(phases[0].maxSteps, 3);
  assert.deepEqual(phases[0].expect, [{ text: 'a' }]);
  assert.deepEqual(scenarioPhases({ name: 'y', role: null, start: '/', goal: 'g' }).map((p) => p.name), ['main']);
});

test('maskSecrets: replaces a secret input value (scenario or phase inputs) with its «key», leaves other inputs readable', () => {
  const s = { inputs: { email: 'a@b.test', password: 'Corr3ct-Horse!' }, then: [{ start: '/x', goal: 'g', inputs: { pin: '9876' } }], secretInputs: ['password', 'pin'] };
  assert.equal(maskSecrets('typed Corr3ct-Horse! then 9876 for a@b.test', s), 'typed «password» then «pin» for a@b.test');
  assert.equal(maskSecrets('nothing here', s), 'nothing here');
  assert.equal(maskSecrets('Corr3ct-Horse!', { inputs: s.inputs }), 'Corr3ct-Horse!', 'no secretInputs → untouched');
});

test('decideVerdict: a failed expectation names its phase', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings: [],
    expectResults: [{ assertion: { text: 'x' }, ok: true, expected: 'e', actual: 'a' }, { assertion: { text: 'set' }, ok: false, expected: 'body text includes "set"', actual: 'absent', phase: 'then #1' }],
  });
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /^phase "then #1" expect #1 text: /);
});

function configWith(checks: Config['checks']): Config {
  return { environments: { local: { baseUrl: 'http://127.0.0.1', mutations: true } }, roles: { u: { login: async () => {} } }, ownOrigins: [/127\.0\.0\.1/], scenarios: 'scenarios/*.json', checks };
}

function load(scenario: unknown, config: Config): Scenario[] {
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-phases-'));
  mkdirSync(join(dir, 'scenarios'), { recursive: true });
  writeFileSync(join(dir, 'scenarios', 's.json'), JSON.stringify(scenario));
  return loadScenarios(config, dir);
}

test('loadScenarios: accepts a valid `then` phase with a check start and secretInputs from a phase', () => {
  const [s] = load(
    { name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: { check: { name: 'link', args: 1 } }, goal: 'h', inputs: { password: 'p' }, expect: [{ url: '/done' }] }], secretInputs: ['password'] },
    configWith({ link: async () => ({ ok: true, detail: '', url: '/x' }) }),
  );
  assert.equal(s.then!.length, 1);
  assert.deepEqual(s.secretInputs, ['password']);
});

test('loadScenarios: rejects a phase whose check start is not in config.checks', () => {
  assert.throws(
    () => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: { check: { name: 'nope' } }, goal: 'h' }] }, configWith({})),
    /then\[0\]\.start\.check references unknown check "nope"/,
  );
});

test('loadScenarios: rejects a phase without a goal, a malformed start, and a secretInputs key that is not an input', () => {
  const config = configWith({});
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: '/b' }] }, config), /then\[0\] is missing the required string field "goal"/);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: { nope: 1 }, goal: 'h' }] }, config), /then\[0\]\.start must be a non-empty string or/);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], inputs: { a: '1' }, secretInputs: ['b'] }, config), /secretInputs must be an array of input keys/);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: 'no' }, config), /then must be an array of phases/);
});
