// Pure tests for phases (`then`), the per-run `{{run}}` value, `secretInputs` masking and the
// scenario validation around them — no browser, no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { maskSecrets } from '../src/runner.ts';
import { applyRunId, loadScenarios, newRunId, RUN_PLACEHOLDER, scenarioInputs, scenarioPhases, type Scenario } from '../src/scenario.ts';
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

test('applyRunId: non-plain objects in check args (a Date, a RegExp, a class instance) pass through untouched', () => {
  class Thing {
    v = '{{run}}';
  }
  const when = new Date('2026-01-02T03:04:05Z');
  const re = /x{{run}}/;
  const thing = new Thing();
  const s: Scenario = { name: 'x', role: null, start: '/', goal: 'g', then: [{ start: { check: { name: 'c', args: { when, re, thing, list: [when, 'a-{{run}}'] } } }, goal: 'h' }] };
  const out = applyRunId(s, 'zz');
  const args = (out.then![0].start as { check: { args: { when: Date; re: RegExp; thing: Thing; list: unknown[] } } }).check.args;
  assert.equal(args.when, when, 'same Date instance');
  assert.equal(args.re, re, 'same RegExp instance');
  assert.equal(args.thing, thing, 'same class instance, not rebuilt');
  assert.equal(args.list[0], when);
  assert.equal(args.list[1], 'a-zz');
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

test('maskSecrets: covers the encoded forms a request URL or an escaped page carries, and every value a reused key had', () => {
  const s = { inputs: { password: 'Pw-a1!' }, then: [{ start: '/x', goal: 'g', inputs: { password: 'Pw-b2 c' } }], secretInputs: ['password'] };
  // A GET <form> form-encodes: `!` → %21, space → +; a fetch may percent-encode; HTML/JSON escapes too.
  assert.equal(maskSecrets('/set?pw=Pw-a1%21&next=Pw-b2+c', s), '/set?pw=«password»&next=«password»');
  assert.equal(maskSecrets(encodeURIComponent('Pw-b2 c'), s), '«password»');
  assert.equal(maskSecrets('first Pw-a1! then Pw-b2 c', s), 'first «password» then «password»', 'both values of the reused key');
  assert.equal(maskSecrets(JSON.stringify({ v: 'Pw-a1!' }), s), '{"v":"«password»"}');
});

test('scenarioInputs: every key with every value it had across the scenario and its phases', () => {
  const s: Pick<Scenario, 'inputs' | 'then'> = { inputs: { email: 'e', password: 'p1' }, then: [{ start: '/x', goal: 'g', inputs: { password: 'p2', pin: '1' } }, { start: '/y', goal: 'h', inputs: { password: 'p1' } }] };
  assert.deepEqual(scenarioInputs(s), { email: ['e'], password: ['p1', 'p2'], pin: ['1'] });
  assert.deepEqual(scenarioInputs({}), {});
});

test('decideVerdict: a failed expectation fails a smoke or adversarial run too (a phase whose start check failed)', () => {
  const failedCheck = { assertion: { check: { name: 'link' } }, ok: false, expected: 'check "link" returns a start url', actual: 'no message', phase: 'then #1' };
  const smoke = decideVerdict({ kind: 'smoke', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings: [], expectResults: [failedCheck] });
  assert.equal(smoke.verdict, 'FAIL');
  assert.match(smoke.reason, /phase "then #1" expect #0 check/);
  const adversarial = decideVerdict({ kind: 'adversarial', jevDone: false, loopReason: 'x', inputs: { q: 'v' }, submitted: new Set(['v']), findings: [], expectResults: [failedCheck] });
  assert.equal(adversarial.verdict, 'FAIL');
  const clean = decideVerdict({ kind: 'smoke', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings: [], expectResults: [{ ...failedCheck, ok: true }] });
  assert.equal(clean.verdict, 'PASS');
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
