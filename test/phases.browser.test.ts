// Real-browser boundary test for phases: a scenario whose main phase submits a per-run email,
// then continues at the URL a config check returns (the stand-in for "read the welcome link
// from a mailbox"), sets a password there, and asserts on the resulting page. A scripted fake
// `decide` drives the real runner; no Jev, no LLM. Skipped when JEV_QA_NO_BROWSER is set.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { Decision, HistoryEntry, Observation } from '../src/jev.ts';
import { runAll } from '../src/runner.ts';
import type { Scenario } from '../src/scenario.ts';

const SKIP = process.env.JEV_QA_NO_BROWSER ? 'JEV_QA_NO_BROWSER is set' : false;

const A_HTML = `<!doctype html><html><body><h1>Phase A</h1>
<form method="GET" action="/a-search"><input id="q" name="q" type="text" aria-label="Email"><button type="submit">Go</button></form>
</body></html>`;
const A_SEARCH_HTML = (q: string) => `<!doctype html><html><body><p>Registered: <span id="echo">${q}</span></p></body></html>`;
const B_HTML = (registered: string) => `<!doctype html><html><body><h1>Phase B</h1><p>Registered as ${registered}</p>
<form method="GET" action="/b-set"><input id="em" name="em" type="text" aria-label="Email"><input id="pw" name="pw" type="password" aria-label="New password"><button type="submit">Set</button></form>
</body></html>`;
const B_SET_HTML = `<!doctype html><html><body><p>Password accepted</p></body></html>`;

async function fixture(): Promise<{ server: Server; base: string; seen: string[] }> {
  const seen: string[] = [];
  let registered = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(url.pathname + url.search);
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/a') res.end(A_HTML);
    else if (url.pathname === '/a-search') {
      registered = url.searchParams.get('q') ?? '';
      res.end(A_SEARCH_HTML(registered));
    } else if (url.pathname === '/b') res.end(B_HTML(registered));
    else if (url.pathname === '/b-set') res.end(B_SET_HTML);
    else res.end('<!doctype html><html><body>nothing</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const DONE: Decision = { operation: 'DONE', action: null, text: null, confidence: 1, latencyMs: 0, inputTokens: 0, alternatives: [], degraded: null };

// Per phase (history resets at a phase boundary): fill the fields with the phase's inputs,
// then click the submit button; once the form's result page is showing, DONE. Records what the
// runner offered each call (inputs, certified keys, redaction secrets) for the assertions.
type Call = { path: string; inputs: Record<string, string>; certified: string[]; secrets: string[] };
const calls: Call[] = [];
async function decide(obs: Observation, _goal: string, inputs: Record<string, string>, history: HistoryEntry[], certified: Set<string> = new Set(), secrets: string[] = []): Promise<Decision> {
  const pick = (label: string, kind: string) => obs.actions.find((a) => a.label === label && a.kind === kind);
  const fills = history.filter((h) => h.kind === 'fill').length;
  const path = new URL(obs.url).pathname;
  calls.push({ path, inputs, certified: [...certified], secrets });
  if (path === '/a-search' || path === '/b-set') return DONE;
  if (path === '/a') {
    if (!fills) return { ...DONE, operation: 'TYPE_TEXT', action: pick('Email', 'fill')!, text: inputs.email };
    return { ...DONE, operation: 'CLICK', action: pick('Go', 'click')! };
  }
  if (path === '/b') {
    if (fills === 0) return { ...DONE, operation: 'TYPE_TEXT', action: pick('Email', 'fill')!, text: inputs.email };
    if (fills === 1) return { ...DONE, operation: 'TYPE_TEXT', action: pick('New password', 'fill')!, text: inputs.password };
    return { ...DONE, operation: 'CLICK', action: pick('Set', 'click')! };
  }
  return { ...DONE, operation: 'BLOCKED' };
}

function configFor(base: string, checks: Config['checks']): Config {
  return { environments: { local: { baseUrl: base, mutations: true } }, roles: {}, ownOrigins: [/127\.0\.0\.1/], scenarios: [], checks };
}

test('phases: the second phase starts at the url a check returns, its inputs and expectations are its own, and the run id threads through', { skip: SKIP }, async () => {
  const { server, base, seen } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-phases-'));
  const checkArgs: unknown[] = [];
  try {
    const config = configFor(base, {
      welcomeLink: async (_ctx, args) => {
        checkArgs.push(args);
        return { ok: true, detail: 'message found', url: '/b?token=abc' };
      },
    });
    const s: Scenario = {
      name: 'acceptance/phases', kind: 'acceptance', role: null, start: '/a', goal: 'register with the email',
      // The intent and an assertion quote the secret: both must come out masked in the result.
      intent: 'set the password Pw-{{run}}! and log in',
      inputs: { email: 'qa-{{run}}@example.test' },
      expect: [{ url: '/a-search' }, { text: 'Registered:' }],
      then: [{ start: { check: { name: 'welcomeLink', args: { inbox: 'qa-{{run}}@example.test' } } }, goal: 'set the password', inputs: { password: 'Pw-{{run}}!' }, expect: [{ url: '/b-set' }, { text: 'Password accepted' }, { absentText: 'Pw-{{run}}!' }] }],
      secretInputs: ['password'],
    };
    calls.length = 0;
    const [r] = await runAll({ config, dir, envName: 'local', scenarios: [s], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide } });
    assert.equal(r.verdict, 'PASS', r.reason);
    assert.match(r.runId!, /^[a-z0-9]{8,16}$/);
    const email = `qa-${r.runId}@example.test`;
    const password = `Pw-${r.runId}!`;
    assert.deepEqual(checkArgs, [{ inbox: email }], 'the check received the run-substituted args');
    // A real <form> submission form-encodes its values (`!` → %21, space → +), so decode before comparing.
    const formValue = (u: string, key: string) => new URLSearchParams(u.split('?')[1] ?? '').get(key);
    assert.ok(seen.some((u) => u.startsWith('/a-search?') && formValue(u, 'q') === email), `the main phase submitted the per-run email; seen: ${seen.join(' ')}`);
    assert.ok(seen.some((u) => u.startsWith('/b-set?') && formValue(u, 'pw') === password && formValue(u, 'em') === email), `the second phase submitted the email AGAIN plus the per-run password; seen: ${seen.join(' ')}`);
    // Certification is per phase: the email certified by the main phase is offered again on /b.
    const firstOnB = calls.find((c) => c.path === '/b')!;
    assert.deepEqual(firstOnB.certified, [], 'nothing is pre-certified when a phase starts, even a value an earlier phase submitted');
    assert.equal(firstOnB.inputs.email, email, 'the scenario email is offered to the second phase');
    // The main phase's values are redacted while the second phase runs even though it never types them
    // (its page echoes the registered email): the password of phase 2 is not a secret for phase 1 either way.
    assert.ok(firstOnB.secrets.length === 0 || !firstOnB.secrets.includes(email), 'the email is offered here, so it is redacted by key, not as a bare secret');
    const onA = calls.find((c) => c.path === '/a')!;
    assert.ok(onA.secrets.includes(password), 'a later phase\'s input value is redacted as a secret while the main phase runs');
    assert.ok(seen.includes('/b?token=abc'), 'the second phase started at the url the check returned');
    const phaseResults = (r.expectResults ?? []).filter((e) => e.phase === 'then #1');
    assert.equal(phaseResults.length, 3, 'all phase expectations were evaluated');
    assert.equal(r.intent, 'set the password «password» and log in', 'the intent is masked');
    assert.deepEqual(phaseResults[2].assertion, { absentText: '«password»' }, 'the assertion itself is masked');
    assert.ok(phaseResults.every((e) => e.ok));
    assert.equal((r.expectResults ?? []).filter((e) => !e.phase).length, 2, 'main expectations kept, untagged');
    assert.ok(r.trail.some((t) => t.phase === 'then #1'), 'trail entries of the second phase are tagged');
    assert.ok(r.submitted.includes(email), 'a plain input stays readable in the certified list');
    assert.ok(r.submitted.includes('«password»'), 'the secret input is certified by key');
    const json = JSON.stringify(r);
    assert.equal(json.includes(password), false, 'the secret input value appears nowhere in the result');
    // The GET form carried it form-encoded in a request URL (`!` → %21): masked in every persisted form too.
    for (const form of [encodeURIComponent(password), encodeURIComponent(password).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), password.replace(/!/g, '%21')]) {
      assert.equal(json.includes(form), false, `encoded form ${form} appears nowhere in the result`);
    }
    assert.ok(r.requests.some((q) => q.url.includes('/b-set?') && q.url.includes('«password»')), 'the persisted request url carries the key in place of the value');
    assert.ok(json.includes(email), 'a plain input stays readable');
    assert.ok(r.trail.some((t) => t.text === '«password»'), 'the trail shows the key in place of the typed secret');
  } finally {
    server.close();
  }
});

const TWO_FIELDS_HTML = `<!doctype html><html><body>
<form method="GET" action="/two-done"><input id="a" name="a" type="text" aria-label="Alpha"><input id="b" name="b" type="text" aria-label="Beta"><button type="submit">Go</button></form>
</body></html>`;

test('a field that already holds another scenario input is never overwritten: the next empty fill target is used instead', { skip: SKIP }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(url.pathname + url.search);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(url.pathname === '/two-done' ? '<!doctype html><html><body><p>Done two</p></body></html>' : TWO_FIELDS_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-two-'));
  try {
    // Types alpha into Alpha, then (wrongly) beta into Alpha again, offering Beta as the alternative.
    const wrongDecide = async (obs: Observation, _goal: string, inputs: Record<string, string>, history: HistoryEntry[]): Promise<Decision> => {
      if (new URL(obs.url).pathname === '/two-done') return DONE;
      const alpha = obs.actions.find((a) => a.label === 'Alpha' && a.kind === 'fill')!;
      const beta = obs.actions.find((a) => a.label === 'Beta' && a.kind === 'fill')!;
      const fills = history.filter((h) => h.kind === 'fill').length;
      if (fills === 0) return { ...DONE, operation: 'TYPE_TEXT', action: alpha, text: inputs.alpha };
      if (fills === 1) return { ...DONE, operation: 'TYPE_TEXT', action: alpha, text: inputs.beta, alternatives: [beta] };
      return { ...DONE, operation: 'CLICK', action: obs.actions.find((a) => a.label === 'Go' && a.kind === 'click')! };
    };
    const s: Scenario = { name: 'acceptance/two', kind: 'acceptance', role: null, start: '/two', goal: 'fill both', inputs: { alpha: 'one', beta: 'two' }, maxSteps: 6, expect: [{ url: '/two-done' }] };
    const [r] = await runAll({ config: configFor(base, {}), dir, envName: 'local', scenarios: [s], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide: wrongDecide } });
    assert.equal(r.verdict, 'PASS', r.reason);
    assert.ok(hits.some((h) => h.startsWith('/two-done?') && new URLSearchParams(h.split('?')[1]).get('a') === 'one' && new URLSearchParams(h.split('?')[1]).get('b') === 'two'), `Alpha kept "one" and Beta got "two"; hits: ${hits.join(' ')}`);
    assert.ok(r.trail.some((t) => t.label.includes('holds another input, not overwritten: Beta')), 'the guard redirected the fill to the empty field');
  } finally {
    server.close();
  }
});

test('a REFUSED run masks a secret quoted in its intent; a phase response assertion sees only its own phase\'s traffic', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-refused-'));
  try {
    const config: Config = { ...configFor(base, { link: async () => ({ ok: true, detail: '', url: '/b?token=abc' }) }), environments: { ro: { baseUrl: base, mutations: false }, rw: { baseUrl: base, mutations: true } } };
    const refused: Scenario = { name: 'acceptance/refused', kind: 'acceptance', role: null, start: '/a', goal: 'g', mutates: true, intent: 'uses password Pw-{{run}}!', inputs: { password: 'Pw-{{run}}!' }, expect: [{ url: '/a' }], secretInputs: ['password'] };
    const [r] = await runAll({ config, dir, envName: 'ro', scenarios: [refused], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide } });
    assert.equal(r.verdict, 'REFUSED');
    assert.equal(r.intent, 'uses password «password»');
    assert.equal(JSON.stringify(r).includes(`Pw-${r.runId ?? '§'}!`), false);

    // Phase 1 sends GET /a-search → 200; phase 2 never does. A `response` assertion for /a-search
    // on phase 2 must FAIL, not ride on phase 1's response.
    const windowed: Scenario = {
      name: 'acceptance/response-window', kind: 'acceptance', role: null, start: '/a', goal: 'register', inputs: { email: 'qa-{{run}}@example.test' },
      expect: [{ response: { method: 'GET', url: '/a-search', status: 200 } }],
      then: [{ start: { check: { name: 'link' } }, goal: 'set', inputs: { password: 'Pw-{{run}}!' }, expect: [{ response: { method: 'GET', url: '/a-search', status: 200 } }] }],
    };
    calls.length = 0;
    const [w] = await runAll({ config, dir, envName: 'rw', scenarios: [windowed], concurrency: 1, repeat: 1, outDir: join(dir, 'out2'), deps: { decide } });
    assert.equal(w.verdict, 'FAIL', w.reason);
    assert.match(w.reason, /phase "then #1" expect #1 response: /);
    assert.equal(w.expectResults![0].ok, true, 'the main phase\'s own response assertion passes');
  } finally {
    server.close();
  }
});

const NOSCROLL_HTML = `<!doctype html><html><head><style>html,body{overflow:hidden;height:100%}</style></head><body>
<div style="height:3000px">tall but the root cannot scroll</div>
</body></html>`;

test('BLOCKED auto-scroll stops as soon as a scroll moves nothing, leaving the settle retries their turn', { skip: SKIP }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(NOSCROLL_HTML); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-noscroll-'));
  try {
    const blocked = async (): Promise<Decision> => ({ ...DONE, operation: 'BLOCKED' });
    const s: Scenario = { name: 'smoke/noscroll', kind: 'smoke', role: null, start: '/', goal: 'x', maxSteps: 10 };
    const [r] = await runAll({ config: configFor(base, {}), dir, envName: 'local', scenarios: [s], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide: blocked } });
    const scrolls = r.trail.filter((t) => t.label.includes('auto-scrolled')).length;
    assert.ok(scrolls <= 1, `at most one ineffective scroll, got ${scrolls}`);
    assert.match(r.reason, /no operation can progress/);
    assert.ok(r.steps <= 4, `the settle retries ran and the run ended early (${r.steps} steps)`);
  } finally {
    server.close();
  }
});

const TALL_HTML = `<!doctype html><html><body>
<form method="GET" action="/tall-done"><input id="q" name="q" type="text" aria-label="Email"><div style="height:1600px"></div><button type="submit">Go</button></form>
</body></html>`;

test('BLOCKED with more page below scrolls before giving up, so a control under the fold is reached', { skip: SKIP }, async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(url.pathname === '/tall-done' ? '<!doctype html><html><body><p>Done tall</p></body></html>' : TALL_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-tall-'));
  try {
    const tallDecide = async (obs: Observation, _goal: string, inputs: Record<string, string>, history: HistoryEntry[]): Promise<Decision> => {
      if (new URL(obs.url).pathname === '/tall-done') return DONE;
      const go = obs.actions.find((a) => a.label === 'Go' && a.kind === 'click');
      const email = obs.actions.find((a) => a.label === 'Email' && a.kind === 'fill');
      if (email && !history.some((h) => h.kind === 'fill')) return { ...DONE, operation: 'TYPE_TEXT', action: email, text: inputs.email };
      if (go) return { ...DONE, operation: 'CLICK', action: go };
      return { ...DONE, operation: 'BLOCKED' }; // cannot see the button: it is below the fold
    };
    const s: Scenario = { name: 'acceptance/tall', kind: 'acceptance', role: null, start: '/tall', goal: 'submit', inputs: { email: 'a@b.test' }, maxSteps: 8, expect: [{ url: '/tall-done' }] };
    const [r] = await runAll({ config: configFor(base, {}), dir, envName: 'local', scenarios: [s], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide: tallDecide } });
    assert.equal(r.verdict, 'PASS', r.reason);
    assert.ok(r.trail.some((t) => t.label.includes('auto-scrolled')), 'the second BLOCKED chance scrolled instead of waiting');
  } finally {
    server.close();
  }
});

test('phases: a start check that reports ok:false fails the run naming the phase; one that returns no url is an error', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-phases-'));
  try {
    const config = configFor(base, {
      noLink: async () => ({ ok: false, detail: 'no message arrived' }),
      noUrl: async () => ({ ok: true, detail: 'found but forgot the url' }),
    });
    const main = { kind: 'acceptance' as const, role: null, start: '/a', goal: 'register', inputs: { email: 'qa-{{run}}@example.test' }, expect: [{ url: '/a-search' }] };
    const failing: Scenario = { ...main, name: 'acceptance/phase-check-fails', then: [{ name: 'welcome', start: { check: { name: 'noLink' } }, goal: 'set the password', expect: [{ url: '/b-set' }] }] };
    const broken: Scenario = { ...main, name: 'acceptance/phase-check-no-url', then: [{ start: { check: { name: 'noUrl' } }, goal: 'set the password' }] };
    // A smoke scenario is held to a failed phase too (its own kind rule would otherwise PASS on DONE).
    const smoke: Scenario = { name: 'smoke/phase-check-fails', kind: 'smoke', role: null, start: '/a', goal: 'render', maxSteps: 1, then: [{ name: 'welcome', start: { check: { name: 'noLink' } }, goal: 'x' }] };
    const smokeDecide = async (): Promise<Decision> => DONE;
    const results = await runAll({ config, dir, envName: 'local', scenarios: [failing, broken], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide } });
    const [sm] = await runAll({ config, dir, envName: 'local', scenarios: [smoke], concurrency: 1, repeat: 1, outDir: join(dir, 'out2'), deps: { decide: smokeDecide } });
    assert.equal(sm.verdict, 'FAIL', sm.reason);
    assert.match(sm.reason, /phase "welcome" expect #0 check: .*no message arrived/);
    const f = results.find((r) => r.name === failing.name)!;
    assert.equal(f.verdict, 'FAIL', f.reason);
    assert.match(f.reason, /phase "welcome" expect #1 check: .*no message arrived/);
    const b = results.find((r) => r.name === broken.name)!;
    assert.equal(b.verdict, 'ERROR', b.reason);
    assert.match(b.reason, /phase "then #1": start check "noUrl" reported ok but returned no url/);
  } finally {
    server.close();
  }
});
