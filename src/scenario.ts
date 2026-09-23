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
};

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
