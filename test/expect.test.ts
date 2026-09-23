import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, getPath } from '../src/expect.ts';
import type { ExpectState } from '../src/expect.ts';
import type { ResponseRecord } from '../src/oracles.ts';

function baseState(overrides: Partial<ExpectState> = {}): ExpectState {
  return {
    url: () => 'https://example.com/dashboard',
    bodyText: async () => 'Welcome back\nNo results found',
    responses: [],
    isElementVisible: async () => false,
    runCheck: async () => ({ ok: false, detail: 'not stubbed' }),
    ...overrides,
  };
}

test('url assertion: substring match', async () => {
  const [r] = await evaluate([{ url: '/dashboard' }], baseState());
  assert.equal(r.ok, true);
});

test('url assertion: substring mismatch reports the actual url', async () => {
  const [r] = await evaluate([{ url: '/settings' }], baseState());
  assert.equal(r.ok, false);
  assert.equal(r.actual, 'https://example.com/dashboard');
});

test('url assertion: regex form (leading/trailing slash) with flags', async () => {
  const [r] = await evaluate([{ url: '/DASHBOARD$/i' }], baseState());
  assert.equal(r.ok, true);
});

test('text assertion: present and absent', async () => {
  const [present, absent] = await evaluate([{ text: 'Welcome back' }, { text: 'Goodbye' }], baseState());
  assert.equal(present.ok, true);
  assert.equal(absent.ok, false);
  assert.equal(absent.actual, 'absent');
});

test('absentText assertion: passes when the text is not on the page', async () => {
  const [r] = await evaluate([{ absentText: 'Error 500' }], baseState());
  assert.equal(r.ok, true);
});

test('absentText assertion: fails when the text is present', async () => {
  const [r] = await evaluate([{ absentText: 'No results found' }], baseState());
  assert.equal(r.ok, false);
  assert.equal(r.actual, 'present');
});

test('element assertion: uses the stub and reports visible=<bool>', async () => {
  const state = baseState({ isElementVisible: async (role, name) => role === 'button' && name === 'Save' });
  const [ok, fail] = await evaluate(
    [{ element: { role: 'button', name: 'Save' } }, { element: { role: 'button', name: 'Cancel' } }],
    state,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.actual, 'visible=true');
  assert.equal(fail.ok, false);
  assert.equal(fail.actual, 'visible=false');
});

const responses: ResponseRecord[] = [
  { step: 3, method: 'GET', url: 'https://example.com/api/items', status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 7 }, { id: 8 }], total: 2 }) },
  { step: 4, method: 'POST', url: 'https://example.com/api/items', status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) },
];

test('response assertion: matches by method + url regex + status', async () => {
  const [r] = await evaluate([{ response: { method: 'GET', url: '/api/items$', status: 200 } }], baseState({ responses }));
  assert.equal(r.ok, true);
});

test('response assertion: wrong status does not match, actual explains nothing was seen', async () => {
  const [r] = await evaluate([{ response: { method: 'GET', url: '/api/items$', status: 404 } }], baseState({ responses }));
  assert.equal(r.ok, false);
  assert.match(r.actual, /no matching response seen \(2 own-origin responses recorded\)/);
});

test('response assertion: bodyIncludes', async () => {
  const [ok, fail] = await evaluate(
    [
      { response: { method: 'POST', url: '/api/items$', status: 201, bodyIncludes: '"ok":true' } },
      { response: { method: 'POST', url: '/api/items$', status: 201, bodyIncludes: 'nope' } },
    ],
    baseState({ responses }),
  );
  assert.equal(ok.ok, true);
  assert.equal(fail.ok, false);
});

test('response assertion: jsonPath with dotted + numeric index, equals', async () => {
  const [ok, fail] = await evaluate(
    [
      { response: { method: 'GET', url: '/api/items$', status: 200, jsonPath: 'items.1.id', equals: 8 } },
      { response: { method: 'GET', url: '/api/items$', status: 200, jsonPath: 'items.1.id', equals: 999 } },
    ],
    baseState({ responses }),
  );
  assert.equal(ok.ok, true);
  assert.equal(fail.ok, false);
  assert.match(fail.actual, /jsonPath items\.1\.id = 8/);
});

test('response assertion: jsonPath present-only (no equals) just needs a defined value', async () => {
  const [r] = await evaluate([{ response: { method: 'GET', url: '/api/items$', status: 200, jsonPath: 'total' } }], baseState({ responses }));
  assert.equal(r.ok, true);
});

// --- round 7 (M4): url/bodyText are read lazily, at the moment each assertion runs ---------

test('url/text assertions each read state fresh — a later assertion sees what an earlier check changed', async () => {
  // Simulates a `check` assertion navigating the page between two other assertions: url()/
  // bodyText() are called freshly for EACH assertion, not captured once before evaluate() ran.
  let navigated = false;
  const state = baseState({
    url: () => (navigated ? 'https://example.com/crash' : 'https://example.com/dashboard'),
    bodyText: async () => (navigated ? 'Application error' : 'Welcome back'),
    runCheck: async () => {
      navigated = true;
      return { ok: true, detail: 'navigated' };
    },
  });
  const [beforeUrl, , afterUrl, afterText] = await evaluate(
    [{ url: '/dashboard' }, { check: { name: 'navigate' } }, { url: '/crash' }, { text: 'Application error' }],
    state,
  );
  assert.equal(beforeUrl.ok, true, 'the FIRST url assertion must see the pre-navigation url');
  assert.equal(afterUrl.ok, true, 'the LAST url assertion must see the POST-navigation url, not a stale snapshot');
  assert.equal(afterText.ok, true, 'the text assertion after the check must see the post-navigation body');
});

test('check assertion: delegates to runCheck and surfaces its detail', async () => {
  const state = baseState({ runCheck: async (name, args) => ({ ok: name === 'stockCount', detail: `checked ${name} with ${JSON.stringify(args)}` }) });
  const [ok, fail] = await evaluate([{ check: { name: 'stockCount', args: { min: 1 } } }, { check: { name: 'other' } }], state);
  assert.equal(ok.ok, true);
  assert.equal(ok.actual, 'checked stockCount with {"min":1}');
  assert.equal(fail.ok, false);
});

test('getPath: dotted path with a numeric array index', () => {
  assert.equal(getPath({ data: { items: [{ id: 1 }, { id: 2 }] } }, 'data.items.1.id'), 2);
});

test('getPath: missing path returns undefined instead of throwing', () => {
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(getPath(null, 'a.b'), undefined);
});
