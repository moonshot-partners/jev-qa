// Pure evaluation of scenario `expect` assertions against a captured page
// state. No Playwright import: the runner builds `ExpectState` from a real
// page, but this module is testable without a browser.
import type { ExpectAssertion } from './scenario.ts';
import type { ResponseRecord } from './oracles.ts';

export type ExpectState = {
  // Round 7 (M4): read lazily, on demand — a `check` assertion earlier in the same list may
  // navigate the page, and a `url`/`text` assertion later in the list must see it as it is at
  // THAT point, not a value captured once before any assertion ran.
  url: () => string;
  bodyText: () => Promise<string>;
  responses: ResponseRecord[];
  // Only responses recorded at this step or later count (a phase's own window): a later phase's
  // `response` assertion must not be satisfied by an earlier phase's traffic.
  fromStep?: number;
  isElementVisible: (role: string, name: string) => Promise<boolean>;
  runCheck: (name: string, args?: unknown) => Promise<{ ok: boolean; detail: string }>;
};

export type ExpectResult = { assertion: ExpectAssertion; ok: boolean; expected: string; actual: string; phase?: string };

// PURE (no side effects): the assertions that only READ page/network state — safe to evaluate
// repeatedly. A `check` runs app code and may act (create a mailbox), so it is never polled.
export function isPureAssertion(a: ExpectAssertion): boolean {
  return 'url' in a || 'text' in a || 'absentText' in a || 'element' in a || 'response' in a;
}

// Waits until every pure assertion in the list holds, or the deadline passes — the page's last
// action (a submit that shows "Processing…") may still be in flight when Jev answers DONE, and
// its result is exactly what the expectations describe. Returns how long it waited.
export async function settleExpectations(expect: ExpectAssertion[], state: ExpectState, timeoutMs: number, intervalMs = 500): Promise<number> {
  const pure = expect.filter(isPureAssertion);
  if (!pure.length) return 0;
  const started = Date.now();
  for (;;) {
    const results = await Promise.all(pure.map((a) => evalOne(a, state)));
    if (results.every((r) => r.ok)) return Date.now() - started;
    if (Date.now() - started >= timeoutMs) return Date.now() - started;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function parseMaybeRegex(s: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

// Dotted path with numeric indexes, e.g. "data.items.0.id".
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc === undefined || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

async function evalOne(a: ExpectAssertion, state: ExpectState): Promise<ExpectResult> {
  if ('url' in a) {
    const url = state.url();
    const re = parseMaybeRegex(a.url);
    const ok = re ? re.test(url) : url.includes(a.url);
    return { assertion: a, ok, expected: `url ${re ? 'matches' : 'includes'} ${a.url}`, actual: url };
  }
  if ('text' in a) {
    const bodyText = await state.bodyText();
    const ok = bodyText.includes(a.text);
    return { assertion: a, ok, expected: `body text includes ${JSON.stringify(a.text)}`, actual: ok ? 'present' : 'absent' };
  }
  if ('absentText' in a) {
    const bodyText = await state.bodyText();
    const ok = !bodyText.includes(a.absentText);
    return { assertion: a, ok, expected: `body text does not include ${JSON.stringify(a.absentText)}`, actual: ok ? 'absent' : 'present' };
  }
  if ('element' in a) {
    const { role, name } = a.element;
    const visible = await state.isElementVisible(role, name);
    return { assertion: a, ok: visible, expected: `getByRole(${role}, {name: ${JSON.stringify(name)}}) visible`, actual: `visible=${visible}` };
  }
  if ('response' in a) {
    const { method, url, status, bodyIncludes, jsonPath, equals } = a.response;
    const re = new RegExp(url);
    const byShape = state.responses.filter((r) => r.step >= (state.fromStep ?? 0)).filter((r) => (!method || r.method.toUpperCase() === method.toUpperCase()) && re.test(r.url) && r.status === status);
    let match: ResponseRecord | undefined;
    let failDetail = '';
    for (const r of byShape) {
      if (bodyIncludes !== undefined && (r.body === undefined || !r.body.includes(bodyIncludes))) {
        failDetail = `bodyIncludes ${JSON.stringify(bodyIncludes)} not found in ${r.method} ${r.url}`;
        continue;
      }
      if (jsonPath !== undefined) {
        let value: unknown;
        try {
          value = getPath(JSON.parse(r.body ?? ''), jsonPath);
        } catch {
          value = undefined;
        }
        if (equals !== undefined ? !deepEqual(value, equals) : value === undefined) {
          failDetail = `jsonPath ${jsonPath} = ${JSON.stringify(value)} on ${r.method} ${r.url}`;
          continue;
        }
      }
      match = r;
      break;
    }
    const expectedParts = [`${method ?? 'ANY'} ${url} → ${status}`];
    if (bodyIncludes !== undefined) expectedParts.push(`bodyIncludes ${JSON.stringify(bodyIncludes)}`);
    if (jsonPath !== undefined) expectedParts.push(`${jsonPath}${equals !== undefined ? ` = ${JSON.stringify(equals)}` : ' present'}`);
    const ok = !!match;
    const actual = match
      ? `${match.method} ${match.url} → ${match.status}`
      : failDetail || `no matching response seen (${state.responses.length} own-origin responses recorded)`;
    return { assertion: a, ok, expected: expectedParts.join(', '), actual };
  }
  // check
  const { name, args } = a.check;
  const result = await state.runCheck(name, args);
  return { assertion: a, ok: result.ok, expected: `check "${name}" ok`, actual: result.detail };
}

export async function evaluate(assertions: ExpectAssertion[], state: ExpectState): Promise<ExpectResult[]> {
  const results: ExpectResult[] = [];
  for (const a of assertions) results.push(await evalOne(a, state));
  return results;
}
