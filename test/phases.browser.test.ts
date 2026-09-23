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
const B_HTML = `<!doctype html><html><body><h1>Phase B</h1>
<form method="GET" action="/b-set"><input id="pw" name="pw" type="password" aria-label="New password"><button type="submit">Set</button></form>
</body></html>`;
const B_SET_HTML = `<!doctype html><html><body><p>Password accepted</p></body></html>`;

async function fixture(): Promise<{ server: Server; base: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(url.pathname + url.search);
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/a') res.end(A_HTML);
    else if (url.pathname === '/a-search') res.end(A_SEARCH_HTML(url.searchParams.get('q') ?? ''));
    else if (url.pathname === '/b') res.end(B_HTML);
    else if (url.pathname === '/b-set') res.end(B_SET_HTML);
    else res.end('<!doctype html><html><body>nothing</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const DONE: Decision = { operation: 'DONE', action: null, text: null, confidence: 1, latencyMs: 0, inputTokens: 0, alternatives: [], degraded: null };

// Per phase (history resets at a phase boundary): fill the one field with the phase's input,
// then click its submit button; once the form's result page is showing, DONE.
async function decide(obs: Observation, _goal: string, inputs: Record<string, string>, history: HistoryEntry[]): Promise<Decision> {
  const pick = (label: string, kind: string) => obs.actions.find((a) => a.label === label && a.kind === kind);
  const fills = history.filter((h) => h.kind === 'fill').length;
  const path = new URL(obs.url).pathname;
  if (path === '/a-search' || path === '/b-set') return DONE;
  if (path === '/a') {
    if (!fills) return { ...DONE, operation: 'TYPE_TEXT', action: pick('Email', 'fill')!, text: inputs.email };
    return { ...DONE, operation: 'CLICK', action: pick('Go', 'click')! };
  }
  if (path === '/b') {
    if (!fills) return { ...DONE, operation: 'TYPE_TEXT', action: pick('New password', 'fill')!, text: inputs.password };
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
      inputs: { email: 'qa-{{run}}@example.test' },
      expect: [{ url: '/a-search' }, { text: 'Registered:' }],
      then: [{ start: { check: { name: 'welcomeLink', args: { inbox: 'qa-{{run}}@example.test' } } }, goal: 'set the password', inputs: { password: 'Pw-{{run}}!' }, expect: [{ url: '/b-set' }, { text: 'Password accepted' }] }],
      secretInputs: ['password'],
    };
    const [r] = await runAll({ config, dir, envName: 'local', scenarios: [s], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide } });
    assert.equal(r.verdict, 'PASS', r.reason);
    assert.match(r.runId!, /^[a-z0-9]{8,16}$/);
    const email = `qa-${r.runId}@example.test`;
    const password = `Pw-${r.runId}!`;
    assert.deepEqual(checkArgs, [{ inbox: email }], 'the check received the run-substituted args');
    // A real <form> submission form-encodes its values (`!` → %21, space → +), so decode before comparing.
    const formValue = (u: string, key: string) => new URLSearchParams(u.split('?')[1] ?? '').get(key);
    assert.ok(seen.some((u) => u.startsWith('/a-search?') && formValue(u, 'q') === email), `the main phase submitted the per-run email; seen: ${seen.join(' ')}`);
    assert.ok(seen.some((u) => u.startsWith('/b-set?') && formValue(u, 'pw') === password), `the second phase submitted the per-run password; seen: ${seen.join(' ')}`);
    assert.ok(seen.includes('/b?token=abc'), 'the second phase started at the url the check returned');
    const phaseResults = (r.expectResults ?? []).filter((e) => e.phase === 'then #1');
    assert.equal(phaseResults.length, 2, 'both phase expectations were evaluated');
    assert.ok(phaseResults.every((e) => e.ok));
    assert.equal((r.expectResults ?? []).filter((e) => !e.phase).length, 2, 'main expectations kept, untagged');
    assert.ok(r.trail.some((t) => t.phase === 'then #1'), 'trail entries of the second phase are tagged');
    assert.ok(r.submitted.includes(email), 'a plain input stays readable in the certified list');
    assert.ok(r.submitted.includes('«password»'), 'the secret input is certified by key');
    const json = JSON.stringify(r);
    assert.equal(json.includes(password), false, 'the secret input value appears nowhere in the result');
    assert.ok(r.trail.some((t) => t.text === '«password»'), 'the trail shows the key in place of the typed secret');
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
    const results = await runAll({ config, dir, envName: 'local', scenarios: [failing, broken], concurrency: 1, repeat: 1, outDir: join(dir, 'out'), deps: { decide } });
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
