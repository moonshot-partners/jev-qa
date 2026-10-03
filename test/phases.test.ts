// Pure tests for phases (`then`), the per-run `{{run}}` value, `secretInputs` masking and the
// scenario validation around them — no browser, no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { flattenInputs, maskDeep, maskSecrets } from '../src/runner.ts';
import { applyRunId, hintedTarget, loadScenarios, newRunId, RUN_PLACEHOLDER, scenarioInputs, scenarioPhases, type Scenario } from '../src/scenario.ts';
import { decideVerdict } from '../src/verdict.ts';
import { isPureAssertion, settleExpectations, type ExpectState } from '../src/expect.ts';

test('settleExpectations: waits for the pure assertions to come true, never polls a check, gives up at the deadline', async () => {
  assert.equal(isPureAssertion({ check: { name: 'x' } }), false);
  assert.equal(isPureAssertion({ text: 'x' }), true);
  let reads = 0;
  let checks = 0;
  const state: ExpectState = {
    url: () => 'http://x/',
    bodyText: async () => (++reads >= 3 ? 'Payment Details' : 'Processing...'),
    responses: [],
    isElementVisible: async () => false,
    runCheck: async () => { checks++; return { ok: true, detail: '' }; },
  };
  const waited = await settleExpectations([{ text: 'Payment Details' }, { check: { name: 'c' } }], state, 5_000, 10);
  assert.ok(reads >= 3 && waited < 5_000, `settled after ${reads} reads in ${waited}ms`);
  assert.equal(checks, 0, 'checks are never polled');
  reads = -100;
  const gaveUp = await settleExpectations([{ text: 'never' }], state, 60, 10);
  assert.ok(gaveUp >= 60, 'returns at the deadline');
  assert.equal(await settleExpectations([{ check: { name: 'c' } }], state, 5_000, 10), 0, 'nothing pure → no wait');
  reads = -100;
  assert.equal(await settleExpectations([{ check: { name: 'c' } }, { text: 'never' }], state, 60, 10), 0, 'an assertion after a check is not polled: the check may be what produces it');
  reads = -100;
  assert.ok((await settleExpectations([{ text: 'never' }, { check: { name: 'c' } }], state, 60, 10)) >= 60, 'an assertion before the first check is');
});

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

test('maskDeep: masks every string inside plain JSON data, leaves non-plain objects alone', () => {
  const mask = (t: string) => t.split('hunter2').join('«password»');
  const when = new Date(0);
  const out = maskDeep({ text: 'pw hunter2', list: ['hunter2', 1, { deep: 'x hunter2 y' }], when }, mask) as { text: string; list: unknown[]; when: Date };
  assert.equal(out.text, 'pw «password»');
  assert.deepEqual(out.list, ['«password»', 1, { deep: 'x «password» y' }]);
  assert.equal(out.when, when);
  assert.deepEqual(maskDeep({ equals: { hunter2: 1 } }, mask), { equals: { '«password»': 1 } }, 'object keys are masked too');
});

test('loadScenarios: an acceptance scenario may carry its only expectation on a phase', () => {
  const [s] = load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', then: [{ start: '/b', goal: 'h', expect: [{ url: '/done' }] }] }, configWith({}));
  assert.equal(s.expect, undefined);
  assert.throws(() => load({ name: 'acceptance/y', role: null, start: '/', goal: 'g', then: [{ start: '/b', goal: 'h' }] }, configWith({})), /no expect assertions/);
});

test('maskSecrets: the longest value is masked first, so a value that prefixes a longer one cannot expose its tail', () => {
  const s = { inputs: { password: 'Rain-2026' }, then: [{ start: '/x', goal: 'g', inputs: { password: 'Rain-2026-next' } }], secretInputs: ['password'] };
  assert.equal(maskSecrets('/set?pw=Rain-2026-next&old=Rain-2026', s), '/set?pw=«password»&old=«password»');
});

test('flattenInputs: a reused key gets #2, #3… without colliding with a real input of that name', () => {
  assert.deepEqual(flattenInputs({ p: ['A', 'B'], 'p#2': ['C'] }), { p: 'A', 'p#3': 'B', 'p#2': 'C' });
  assert.deepEqual(flattenInputs({ email: ['e'], password: ['p1', 'p2', 'p1'] }), { email: 'e', password: 'p1', 'password#2': 'p2', 'password#3': 'p1' });
});

test('applyRunId: a phase name is left alone too (it tags results and must never carry a run value)', () => {
  const s: Scenario = { name: 'x', role: null, start: '/', goal: 'g', then: [{ name: 'phase {{run}}', start: '/b?r={{run}}', goal: 'h {{run}}' }] };
  const out = applyRunId(s, 'zz');
  assert.equal(out.then![0].name, 'phase {{run}}');
  assert.equal(out.then![0].start, '/b?r=zz');
  assert.equal(out.then![0].goal, 'h zz');
});

test('hintedTarget: picks the offered fill target by label substring or /regex/, ignores clicks and bad regexes', () => {
  const actions = [
    { kind: 'click', label: 'ZIP Code (Required)' },
    { kind: 'fill', label: 'Country (Required)' },
    { kind: 'fill', label: 'ZIP Code (Required)' },
    { kind: 'click', label: 'Open ZIP Code (Required)' },
    { kind: 'fill', label: 'Card number', frame: 1 },
  ];
  assert.equal(hintedTarget('zip code', actions), actions[2]);
  assert.equal(hintedTarget('/^country/i', actions), actions[1]);
  assert.equal(hintedTarget('/card number/i', actions), actions[4], 'frame-hosted targets count');
  assert.equal(hintedTarget('nothing like it', actions), undefined);
  assert.equal(hintedTarget('/[/', actions), undefined, 'a broken regex hints nothing');
  assert.equal(hintedTarget(undefined, actions), undefined);
});

test('loadScenarios: inputFields must name existing inputs, on the scenario and on a phase', () => {
  const config = configWith({});
  const [ok] = load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', inputs: { zip: '1' }, inputFields: { zip: 'ZIP' }, expect: [{ text: 'a' }], then: [{ start: '/b', goal: 'h', inputs: { pw: 'p' }, inputFields: { pw: '/pass/i' } }] }, config);
  assert.deepEqual(ok.inputFields, { zip: 'ZIP' });
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', inputs: { zip: '1' }, inputFields: { nope: 'ZIP' }, expect: [{ text: 'a' }] }, config), /inputFields names "nope"/);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', inputs: { zip: '1' }, inputFields: { zip: '' }, expect: [{ text: 'a' }] }, config), /inputFields must be an object of non-empty strings/);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: '/b', goal: 'h', inputFields: { pw: 'x' } }] }, config), /then\[0\]\.inputFields names "pw"/);
  // A phase may hint an input it INHERITS from the scenario without redeclaring it.
  const [inh] = load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', inputs: { email: 'e' }, expect: [{ text: 'a' }], then: [{ start: '/login', goal: 'h', inputFields: { email: '/^Email address/i' } }] }, config);
  assert.deepEqual(inh.then![0].inputFields, { email: '/^Email address/i' });
});

test('loadScenarios: an adversarial scenario may carry its hostile inputs on a phase only', () => {
  const [s] = load({ name: 'adversarial/x', role: null, start: '/', goal: 'g', then: [{ start: '/form', goal: 'h', inputs: { sql: "' OR 1=1" } }] }, configWith({}));
  assert.equal(s.kind, 'adversarial');
  assert.throws(() => load({ name: 'adversarial/y', role: null, start: '/', goal: 'g', then: [{ start: '/form', goal: 'h' }] }, configWith({})), /has no inputs/);
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

test('loadScenarios: a phase without a start continues in place; an empty start string is rejected', () => {
  const [s] = load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ goal: 'continue here', expect: [{ text: 'b' }] }] }, configWith({}));
  assert.equal(s.then![0].start, undefined);
  assert.throws(() => load({ name: 'acceptance/x', role: null, start: '/', goal: 'g', expect: [{ text: 'a' }], then: [{ start: '', goal: 'h' }] }, configWith({})), /or absent to continue on the current page/);
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
