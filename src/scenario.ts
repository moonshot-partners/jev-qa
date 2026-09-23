// Scenario type + loader. Scenarios are plain JSON files (one object or an
// array of objects) matched by config.scenarios glob(s).
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { glob } from './config.ts';

export type ExpectAssertion =
  | { url: string } // page.url() includes, or /regex/ when written as "/.../"
  | { text: string } // visible body text includes
  | { absentText: string }
  | { element: { role: string; name: string } } // getByRole(role, {name}) visible
  | { response: { method?: string; url: string; status: number; bodyIncludes?: string; jsonPath?: string; equals?: unknown } }
  | { check: { name: string; args?: unknown } };

// Where a later phase starts: a path/URL, or a config check that RETURNS one (`{ url }` on its
// result) — e.g. a check that reads a mailbox and returns the link in the message it found.
export type PhaseStart = string | { check: { name: string; args?: unknown } };

// A phase after the main one: same page/context (cookies, login carry over), a new start, goal,
// step budget and expectations. Runs only when the previous phase reached Jev DONE with every
// expectation met; a phase's own inputs add to (and can override) the scenario's.
export type Phase = {
  name?: string;
  start: PhaseStart;
  goal: string;
  inputs?: Record<string, string>;
  maxSteps?: number;
  expect?: ExpectAssertion[];
};

export type Scenario = {
  name: string;
  kind?: 'smoke' | 'adversarial' | 'acceptance';
  role: string | null;
  start: string;
  goal: string;
  inputs?: Record<string, string>;
  maxSteps?: number;
  expect?: ExpectAssertion[];
  mutates?: boolean;
  intent?: string;
  then?: Phase[];
  // Keys of `inputs` (or a phase's inputs) whose VALUE must not reach results.json / the report:
  // the trail, the certified list and the reason show «key» instead. (Every input value is
  // already kept out of Jev requests; this is about the run's own outputs.)
  secretInputs?: string[];
};

// The literal a scenario author writes wherever a per-run unique value belongs (an email, a
// name, a search term): replaced once per run, everywhere in the scenario except its `name`.
export const RUN_PLACEHOLDER = '{{run}}';

// Short, url/email-safe, unique per run: base-36 time (ms) + 4 random base-36 chars.
export function newRunId(): string {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${Date.now().toString(36)}${rand}`;
}

// PURE: a deep copy of the scenario with every occurrence of `{{run}}` in every string —
// start, goal, inputs, expect, phases (including check args) — replaced by `runId`. `name` is
// left alone: results are grouped and reported by it, and it must stay stable across runs.
export function applyRunId<T extends { name: string }>(scenario: T, runId: string): T {
  // Only plain JSON-shaped data is rebuilt; anything else (a Date, a RegExp, a class instance a
  // config's smoke() handed a check as args) is passed through untouched.
  const plain = (v: object) => {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(RUN_PLACEHOLDER).join(runId);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const { name, ...rest } = scenario;
  return { name, ...(walk(rest) as object) } as T;
}

// Every input value a run can type, across the scenario and all its phases, keyed by input key
// — a key reused by two phases with different values lists both. The verdict's "every input
// reached the server" rule, and the redaction of one phase's values while another phase runs,
// both need the whole set, not just the phase in hand.
export function scenarioInputs(s: Pick<Scenario, 'inputs' | 'then'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (inputs?: Record<string, string>) => {
    for (const [k, v] of Object.entries(inputs ?? {})) {
      (out[k] ??= []);
      if (!out[k].includes(v)) out[k].push(v);
    }
  };
  add(s.inputs);
  for (const p of s.then ?? []) add(p.inputs);
  return out;
}

// The phases a run executes in order: the scenario's own fields first, then each `then` entry
// (named "then #n" when unnamed).
export function scenarioPhases(s: Scenario): (Phase & { name: string })[] {
  return [
    { name: 'main', start: s.start, goal: s.goal, inputs: s.inputs, maxSteps: s.maxSteps, expect: s.expect },
    ...(s.then ?? []).map((p, i) => ({ ...p, name: p.name ?? `then #${i + 1}` })),
  ];
}

const EXPECT_KEYS = ['url', 'text', 'absentText', 'element', 'response', 'check'];

function inferKind(name: string): 'smoke' | 'adversarial' | 'acceptance' {
  if (name.startsWith('smoke/')) return 'smoke';
  if (name.startsWith('adversarial/')) return 'adversarial';
  return 'acceptance';
}

function validateExpect(file: string, scenarioName: string, expect: unknown): asserts expect is ExpectAssertion[] {
  if (!Array.isArray(expect)) {
    if (expect && typeof expect === 'object' && ('urlIncludes' in (expect as object) || 'textIncludes' in (expect as object))) {
      throw new Error(
        `${file}: scenario "${scenarioName}" uses the legacy expect: { urlIncludes, textIncludes } object form; ` +
          `use the list form instead, e.g. expect: [{ "url": "..." }, { "text": "..." }]`,
      );
    }
    throw new Error(`${file}: scenario "${scenarioName}".expect must be an array of single-key assertion objects`);
  }
  expect.forEach((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new Error(`${file}: scenario "${scenarioName}".expect[${i}] must be an object`);
    }
    const keys = Object.keys(a);
    if (keys.length !== 1 || !EXPECT_KEYS.includes(keys[0])) {
      throw new Error(
        `${file}: scenario "${scenarioName}".expect[${i}] must have exactly one key from [${EXPECT_KEYS.join(', ')}], got [${keys.join(', ')}]`,
      );
    }
  });
}

function validateInputs(file: string, scenarioName: string, inputs: unknown, where: string): void {
  const ok = inputs && typeof inputs === 'object' && !Array.isArray(inputs) && Object.values(inputs as object).every((v) => typeof v === 'string');
  if (!ok) throw new Error(`${file}: scenario "${scenarioName}"${where}.inputs must be an object of string values`);
}

function validatePhases(file: string, scenarioName: string, then: unknown, config: Config): asserts then is Phase[] {
  if (!Array.isArray(then)) throw new Error(`${file}: scenario "${scenarioName}".then must be an array of phases`);
  then.forEach((p, i) => {
    const where = `.then[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${file}: scenario "${scenarioName}"${where} must be an object`);
    const ph = p as Record<string, unknown>;
    if (ph.name !== undefined && (typeof ph.name !== 'string' || ph.name.length === 0)) {
      throw new Error(`${file}: scenario "${scenarioName}"${where}.name must be a non-empty string when present`);
    }
    const start = ph.start as unknown;
    const check = start && typeof start === 'object' && !Array.isArray(start) ? (start as { check?: unknown }).check : undefined;
    if (typeof start === 'string') {
      if (start.length === 0) throw new Error(`${file}: scenario "${scenarioName}"${where}.start must be a non-empty string or { check: { name, args? } }`);
    } else if (check && typeof check === 'object' && typeof (check as { name?: unknown }).name === 'string') {
      const name = (check as { name: string }).name;
      if (!config.checks?.[name]) {
        throw new Error(`${file}: scenario "${scenarioName}"${where}.start.check references unknown check "${name}" (not in config.checks)`);
      }
    } else {
      throw new Error(`${file}: scenario "${scenarioName}"${where}.start must be a non-empty string or { check: { name, args? } }`);
    }
    if (typeof ph.goal !== 'string' || ph.goal.length === 0) {
      throw new Error(`${file}: scenario "${scenarioName}"${where} is missing the required string field "goal"`);
    }
    if (ph.expect !== undefined) validateExpect(file, `${scenarioName}${where}`, ph.expect);
    if (ph.inputs !== undefined) validateInputs(file, scenarioName, ph.inputs, where);
    if (ph.maxSteps !== undefined && typeof ph.maxSteps !== 'number') {
      throw new Error(`${file}: scenario "${scenarioName}"${where}.maxSteps must be a number when present`);
    }
  });
}

function validateScenario(file: string, s: unknown, config: Config): asserts s is Scenario {
  if (!s || typeof s !== 'object') throw new Error(`${file}: each scenario entry must be an object`);
  const sc = s as Record<string, unknown>;
  if (typeof sc.name !== 'string' || sc.name.length === 0) {
    throw new Error(`${file}: a scenario is missing the required string field "name"`);
  }
  if (sc.role !== null && typeof sc.role !== 'string') {
    throw new Error(`${file}: scenario "${sc.name}".role must be a string (a key in config.roles) or null`);
  }
  if (typeof sc.role === 'string' && !(sc.role in config.roles)) {
    throw new Error(`${file}: scenario "${sc.name}" references unknown role "${sc.role}" (not in config.roles)`);
  }
  if (typeof sc.start !== 'string' || sc.start.length === 0) {
    throw new Error(`${file}: scenario "${sc.name}" is missing the required string field "start"`);
  }
  if (typeof sc.goal !== 'string' || sc.goal.length === 0) {
    throw new Error(`${file}: scenario "${sc.name}" is missing the required string field "goal"`);
  }
  if (sc.expect !== undefined) validateExpect(file, sc.name, sc.expect);
  if (sc.inputs !== undefined) validateInputs(file, sc.name, sc.inputs, '');
  if (sc.then !== undefined) validatePhases(file, sc.name, sc.then, config);
  if (sc.secretInputs !== undefined) {
    const known = new Set([
      ...Object.keys((sc.inputs as object) ?? {}),
      ...((sc.then as Phase[] | undefined) ?? []).flatMap((p) => Object.keys(p.inputs ?? {})),
    ]);
    if (!Array.isArray(sc.secretInputs) || !sc.secretInputs.every((k) => typeof k === 'string' && known.has(k))) {
      throw new Error(`${file}: scenario "${sc.name}".secretInputs must be an array of input keys (from inputs or a phase's inputs)`);
    }
  }

  // Round 7 (M5): a PRESENT but non-string kind (e.g. 0, true, {}) used to fall through to
  // inference below, silently swallowing an obviously-wrong scenario file — only an ABSENT
  // kind should ever infer; anything present must be exactly one of the three valid strings.
  if (sc.kind !== undefined && typeof sc.kind !== 'string') {
    throw new Error(`${file}: scenario "${sc.name}".kind must be a string ("smoke", "adversarial", or "acceptance") when present, got ${typeof sc.kind}`);
  }
  const kind = typeof sc.kind === 'string' ? sc.kind : inferKind(sc.name);
  if (kind !== 'smoke' && kind !== 'adversarial' && kind !== 'acceptance') {
    throw new Error(`${file}: scenario "${sc.name}" has an invalid kind "${kind}" (must be "smoke", "adversarial", or "acceptance")`);
  }
  if (kind === 'acceptance' && (!Array.isArray(sc.expect) || sc.expect.length === 0)) {
    throw new Error(`${file}: scenario "${sc.name}" has kind "acceptance" but no expect assertions (acceptance scenarios need at least one expect entry, or they can never do more than reach Jev DONE unverified)`);
  }
  if (kind === 'adversarial' && (!sc.inputs || typeof sc.inputs !== 'object' || Array.isArray(sc.inputs) || Object.keys(sc.inputs as object).length === 0)) {
    throw new Error(`${file}: scenario "${sc.name}" has kind "adversarial" but has no inputs (adversarial scenarios need at least one hostile input to submit)`);
  }
}

export function loadScenarios(config: Config, dir: string): Scenario[] {
  const patterns = Array.isArray(config.scenarios) ? config.scenarios : [config.scenarios];
  const files = [...new Set(patterns.flatMap((p) => glob(p, dir)))].sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : [raw];
    for (const s of list) {
      validateScenario(file, s, config);
      if (!s.kind) s.kind = inferKind(s.name);
      scenarios.push(s);
    }
  }
  if (config.smoke) {
    for (const s of config.smoke()) {
      s.kind = 'smoke';
      validateScenario('config.smoke()', s, config);
      scenarios.push(s);
    }
  }
  return scenarios;
}
