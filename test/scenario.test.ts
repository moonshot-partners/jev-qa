import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { loadScenarios } from '../src/scenario.ts';
import type { Scenario } from '../src/scenario.ts';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    environments: { local: { baseUrl: 'http://example.com', mutations: false } },
    roles: { anon: { login: async () => {} }, manager: { login: async () => {} } },
    ownOrigins: [/example\.com/],
    scenarios: 'scenarios/*.json',
    ...overrides,
  };
}

const OK_EXPECT = [{ url: '/x' }];
const OK_INPUTS = { hostile: '<script>' };

test('kind inference: smoke/ and adversarial/ prefixes, else acceptance', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(
    join(dir, 'scenarios.json'),
    JSON.stringify([
      { name: 'smoke/manager.dashboard', role: 'manager', start: '/dashboard', goal: 'load' },
      { name: 'adversarial/hostile-search', role: 'manager', start: '/x', goal: 'g', inputs: OK_INPUTS },
      { name: 'release/open-detail', role: 'manager', start: '/x', goal: 'g', expect: OK_EXPECT },
    ]),
  );
  const scenarios = loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir);
  assert.deepEqual(
    scenarios.map((s) => s.kind),
    ['smoke', 'adversarial', 'acceptance'],
  );
});

test('an explicit kind is left untouched', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', kind: 'smoke', role: 'manager', start: '/x', goal: 'g' }]));
  const [s] = loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir);
  assert.equal(s.kind, 'smoke');
});

test('a single scenario object (not wrapped in an array) loads fine', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify({ name: 'release/one', kind: 'smoke', role: 'manager', start: '/x', goal: 'g' }));
  const scenarios = loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir);
  assert.equal(scenarios.length, 1);
});

test('legacy expect: { urlIncludes, textIncludes } is rejected with a helpful message', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(
    join(dir, 'scenarios.json'),
    JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g', expect: { urlIncludes: '/done' } }]),
  );
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /legacy expect.*use the list form/s);
});

test('expect entries must have exactly one recognised key', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g', expect: [{ url: '/a', text: 'b' }] }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /exactly one key/);
});

test('a scenario referencing an unknown role is rejected', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'ghost', start: '/x', goal: 'g', expect: OK_EXPECT }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /unknown role "ghost"/);
});

test('role: null is accepted (anonymous, no config.roles lookup)', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', kind: 'smoke', role: null, start: '/x', goal: 'g' }]));
  const [s] = loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir);
  assert.equal(s.role, null);
});

test('a scenario missing "start" is rejected', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', goal: 'g', expect: OK_EXPECT }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /"start"/);
});

test('an acceptance-kind scenario with no expect assertions is rejected', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g' }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /kind "acceptance" but no expect assertions/);
});

test('an acceptance-kind scenario with an empty expect array is rejected too', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g', expect: [] }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /kind "acceptance" but no expect assertions/);
});

test('an adversarial-kind scenario with no inputs is rejected', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'adversarial/x', role: 'manager', start: '/x', goal: 'g' }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /kind "adversarial" but has no inputs/);
});

test('an adversarial-kind scenario with an empty inputs object is rejected too', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'adversarial/x', role: 'manager', start: '/x', goal: 'g', inputs: {} }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /kind "adversarial" but has no inputs/);
});

test('an explicit kind outside smoke/adversarial/acceptance is rejected, not silently accepted', () => {
  // A typo like "acceptanc" would otherwise skip the acceptance-needs-expect rule entirely and
  // fall into verdict.ts's acceptance branch anyway (kind is read with a loose `?? 'acceptance'`
  // fallback deep in the runner) — PASS on a bare Jev DONE with no assertions ever checked.
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', kind: 'acceptanc', role: 'manager', start: '/x', goal: 'g', expect: OK_EXPECT }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /invalid kind "acceptanc"/);
});

test('round 7 (M5): a PRESENT but non-string kind is rejected, not silently inferred', () => {
  // Before this fix, `typeof sc.kind === 'string' ? sc.kind : inferKind(sc.name)` treated a
  // present-but-wrong-type kind (e.g. a JSON number) exactly like an ABSENT one — it silently
  // fell through to inference and never reached the "invalid kind" check at all.
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', kind: 0, role: 'manager', start: '/x', goal: 'g', expect: OK_EXPECT }]));
  assert.throws(() => loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir), /\.kind must be a string .* got number/);
});

test('smoke and explicit-acceptance-without-expect stay unaffected by the new kind rules', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(
    join(dir, 'scenarios.json'),
    JSON.stringify([{ name: 'smoke/manager.dashboard', role: 'manager', start: '/dashboard', goal: 'load' }]),
  );
  const scenarios = loadScenarios(baseConfig({ scenarios: 'scenarios.json' }), dir);
  assert.equal(scenarios.length, 1);
});

test('config.smoke() results are appended with kind forced to smoke', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g', expect: OK_EXPECT }]));
  const generated: Scenario[] = [{ name: 'smoke/generated', kind: 'acceptance', role: 'manager', start: '/y', goal: 'load' }];
  const scenarios = loadScenarios(baseConfig({ scenarios: 'scenarios.json', smoke: () => generated }), dir);
  assert.equal(scenarios.length, 2);
  assert.equal(scenarios.find((s) => s.name === 'smoke/generated')?.kind, 'smoke');
});

test('config.smoke() output is validated too: a bad role is rejected, not silently loaded', () => {
  const dir = tmpDir('jevqa-scn-');
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify([{ name: 'release/x', role: 'manager', start: '/x', goal: 'g', expect: OK_EXPECT }]));
  const generated: Scenario[] = [{ name: 'smoke/generated', role: 'ghost', start: '/y', goal: 'load' }];
  assert.throws(
    () => loadScenarios(baseConfig({ scenarios: 'scenarios.json', smoke: () => generated }), dir),
    /unknown role "ghost"/,
  );
});
