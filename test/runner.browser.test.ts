// Real-browser boundary test: a local node:http server + a real Chromium
// page + a scripted fake `decide` (no Jev network call, no LLM) drive the
// actual runner/oracle/submission pipeline end to end. Skipped entirely when
// JEV_QA_NO_BROWSER is set (e.g. an environment with no cached Chromium).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { Decision, HistoryEntry, Observation } from '../src/jev.ts';
import { runAll } from '../src/runner.ts';
import type { Scenario } from '../src/scenario.ts';

const SKIP = process.env.JEV_QA_NO_BROWSER ? 'JEV_QA_NO_BROWSER is set' : false;

const PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
<a id="unrelated" href="#" onclick="return false;">Unrelated</a>
<script>
let t;
document.getElementById('q').addEventListener('input', (e) => {
  clearTimeout(t);
  const v = e.target.value;
  t = setTimeout(() => { fetch('/api/echo?q=' + encodeURIComponent(v)); }, 300);
});
</script>
</body></html>`;

// No debounce script: the BLOCKED scenario must prove that typing + an inert click produces NO
// own-origin request and NO page change at all — sharing PAGE_HTML's auto-echo would certify
// "alpha" through its own debounced fetch regardless of what the click does.
const BLOCKED_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
<a id="unrelated" href="#" onclick="return false;">Unrelated</a>
</body></html>`;

// Also no debounce — the ONLY request that can ever carry a typed value on this fixture is the
// native <form> submission itself, so it isolates (mutation-checks) the mid-loop auto-Enter and
// the end-of-run rescue: neither guard firing means neither "alpha" nor "beta" is ever certified.
const MUTATION_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/mutation-search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
<a id="unrelated" href="#" onclick="document.getElementById('q').focus(); return false;">Unrelated</a>
</body></html>`;

// A bare input with no enclosing <form> at all: pressing Enter here succeeds (no exception) but
// submits nothing anywhere — the "press succeeds, nothing happens" boundary case.
const NOFORM_PAGE_HTML = `<!doctype html>
<html><body>
<input id="q" type="text" placeholder="Search">
<div id="results">no results</div>
</body></html>`;

// J1: the LAST action navigates here — a real crash screen with no pageerror/5xx of its own
// (a client-side render, not a thrown exception or a failed request).
const CRASHSTART_PAGE_HTML = `<!doctype html><html><body><a id="gonext" href="/crash-target">Next</a></body></html>`;
const CRASH_TARGET_HTML = `<!doctype html><html><body>Application error: a client-side exception has occurred</body></html>`;

// L2: a debounced search whose results render a clickable result once the request lands — proves
// certifiedKeys() itself (the runner's own computation, recomputed each step from live oracle
// events), not just buildBody()'s internal pruning (covered directly in jev.test.ts).
const PRUNE_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/prune-search">
  <input id="q" name="q" type="text" placeholder="Search tags…">
  <button type="submit">Go</button>
</form>
<div id="results"></div>
<script>
let t;
document.getElementById('q').addEventListener('input', (e) => {
  clearTimeout(t);
  const v = e.target.value;
  t = setTimeout(() => {
    fetch('/api/prune-search?q=' + encodeURIComponent(v))
      .then((r) => r.json())
      .then((data) => {
        document.getElementById('results').innerHTML =
          '<a id="result1" href="#" onclick="return false;">' + data.q + ' — open</a>';
      });
  }, 300);
});
</script>
</body></html>`;

// L2 harness fallback: no debounce at all — the ONLY way "alpha" can ever be certified on this
// fixture is a real Enter/submit, and the follow-up page (with a clickable result) only exists
// past that navigation — isolates the "not certified → press Enter instead of retyping" branch
// from the end-of-run adversarial rescue (guard 13), which this `acceptance`-kind scenario never
// reaches (its verdict strictly requires jevDone, reached only via the normal loop).
const FALLBACK_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/fallback-search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
</body></html>`;
const FALLBACK_RESULT_HTML = `<!doctype html><html><body><div id="results"><a id="result1" href="#" onclick="return false;">alpha result — open</a></div></body></html>`;

// N6 (round 8): a second, unrelated input steals keyboard focus 300ms after typing — well
// within act()'s own 600ms settle wait, so focus has already moved by the time the runner's
// next decision runs. No debounce either — the ONLY way "alpha" can ever be certified is a real
// Enter landing in the SEARCH field specifically, not wherever focus happens to be.
const FOCUS_STEAL_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/focus-steal-search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<input id="distraction" type="text" placeholder="Distraction (steals focus, outside any form)">
<div id="results">no results</div>
<script>
document.getElementById('q').addEventListener('input', () => {
  setTimeout(() => document.getElementById('distraction').focus(), 300);
});
</script>
</body></html>`;

// O7 (round 9): the field wipes its OWN value the instant it regains focus (a real pattern —
// some "clear on refocus" search boxes do exactly this) — proves focusAndVerify's NEW value
// re-check, not just N6's focus re-check, is what gates the Enter press. The initial fill still
// lands correctly (the handler clears BEFORE insertText types the real text in); only a LATER
// re-click with no follow-up typing (the harness's own re-focus, never Jev's) sees it wiped.
const VALUE_CLEAR_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/value-clear-search">
  <input id="q" name="q" type="text" placeholder="Search" onfocus="this.value=''">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
<a id="unrelated" href="#" onclick="return false;">Unrelated</a>
</body></html>`;

// O10 (round 9): a 1s debounce — longer than act()'s own fixed 600ms fill-settle wait, so the
// FIRST fill's own in-fill networkidle check can plausibly resolve BEFORE the debounced request
// ever fires. Proves the mid-loop REPLACE guard's own debounce-grace poll (up to 1.5s, 250ms
// steps), not luck or act()'s unrelated wait, is what lets "alpha" certify without any Enter.
const DEBOUNCE_GRACE_PAGE_HTML = `<!doctype html>
<html><body>
<form method="GET" action="/debounce-grace-search">
  <input id="q" name="q" type="text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<div id="results">no results</div>
<script>
let t;
document.getElementById('q').addEventListener('input', (e) => {
  clearTimeout(t);
  const v = e.target.value;
  t = setTimeout(() => { fetch('/api/debounce-grace?q=' + encodeURIComponent(v)); }, 1000);
});
</script>
</body></html>`;

// R5 (round 11): a page that fires 350 own-origin fetches on load — proves the persisted
// `requests`/`responses` cap end to end through the REAL runOne() → Result path (not just
// persistedTimeline()/capRecent() in isolation, which a removed call in runOne() would slip past).
const MANY_REQUESTS_PAGE_HTML = `<!doctype html>
<html><body>
<div id="results">many requests</div>
<script>
for (let i = 0; i < 350; i++) fetch('/api/echo?q=n' + i);
</script>
</body></html>`;

// N7 (round 8): a search box filtered ENTIRELY client-side (no fetch/XHR at all) — the exact
// "page change with no request" shape the old (round 7) unit-level test couldn't actually
// construct any more once ChangeEvent was removed from the type system; a real page is the only
// way left to reproduce it.
const CLIENT_FILTER_PAGE_HTML = `<!doctype html>
<html><body>
<input id="q" type="text" placeholder="Filter">
<ul id="list"><li>apple</li><li>banana</li><li>cherry</li></ul>
<script>
document.getElementById('q').addEventListener('input', (e) => {
  const v = e.target.value.toLowerCase();
  for (const li of document.querySelectorAll('#list li')) {
    li.style.display = li.textContent.toLowerCase().includes(v) ? '' : 'none';
  }
});
</script>
</body></html>`;

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/' || url.pathname === '/search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE_HTML);
      } else if (url.pathname === '/blocked') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(BLOCKED_PAGE_HTML);
      } else if (url.pathname === '/mutation' || url.pathname === '/mutation-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(MUTATION_PAGE_HTML);
      } else if (url.pathname === '/noform') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(NOFORM_PAGE_HTML);
      } else if (url.pathname === '/crashstart') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(CRASHSTART_PAGE_HTML);
      } else if (url.pathname === '/crash-target') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(CRASH_TARGET_HTML);
      } else if (url.pathname === '/prune' || url.pathname === '/prune-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PRUNE_PAGE_HTML);
      } else if (url.pathname === '/api/prune-search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ q: url.searchParams.get('q') ?? null }));
      } else if (url.pathname === '/fallback') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FALLBACK_PAGE_HTML);
      } else if (url.pathname === '/fallback-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FALLBACK_RESULT_HTML);
      } else if (url.pathname === '/focus-steal' || url.pathname === '/focus-steal-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FOCUS_STEAL_PAGE_HTML);
      } else if (url.pathname === '/client-filter') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(CLIENT_FILTER_PAGE_HTML);
      } else if (url.pathname === '/value-clear' || url.pathname === '/value-clear-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(VALUE_CLEAR_PAGE_HTML);
      } else if (url.pathname === '/debounce-grace' || url.pathname === '/debounce-grace-search') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(DEBOUNCE_GRACE_PAGE_HTML);
      } else if (url.pathname === '/many-requests') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(MANY_REQUESTS_PAGE_HTML);
      } else if (url.pathname === '/api/debounce-grace') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ q: url.searchParams.get('q') ?? null }));
      } else if (url.pathname === '/api/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ q: url.searchParams.get('q') ?? null }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function decision(partial: Partial<Decision>): Decision {
  return { operation: 'DONE', action: null, text: null, confidence: 1, latencyMs: 1, inputTokens: 0, alternatives: [], degraded: null, ...partial };
}

// Scripts three distinct behaviours by inspecting the goal text (a stand-in for
// "which fixture scenario is this") and what HAS ALREADY HAPPENED in `history` —
// content-based, not a raw step count, because the runner can insert its own
// synthetic history entries (e.g. the mid-loop auto-Enter's own "Press Enter"
// entry) between two of this script's decisions.
async function fakeDecide(
  obs: Observation,
  goal: string,
  inputs: Record<string, string>,
  history: HistoryEntry[],
  certified: Set<string> = new Set(),
): Promise<Decision> {
  const fillAction = obs.actions.find((a) => a.kind === 'fill') ?? null;
  const linkAction = obs.actions.find((a) => a.role === 'link') ?? null;
  const filled = history.filter((h) => h.kind === 'fill').map((h) => h.text);

  if (goal.includes('ADVERSARIAL_TEST')) {
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    // Replaces the field's text WITHOUT ever pressing Enter itself — the mid-loop
    // auto-Enter rule must fire here to submit "alpha" before it is overwritten.
    if (!filled.includes(inputs.b)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.b });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('ACCEPTANCE_TEST')) {
    if (!filled.includes('alpha')) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: 'alpha' });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('BLOCKED_TEST')) {
    if (!filled.includes('alpha')) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: 'alpha' });
    // The link's onclick returns false: no navigation, no request, no page change.
    // Jev never reaches DONE, so this scenario must end BLOCKED regardless.
    if (!history.some((h) => h.kind === 'click')) return decision({ operation: 'CLICK', action: linkAction });
    return decision({ operation: 'BLOCKED', action: null });
  }
  if (goal.includes('MUTATION_TEST')) {
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!filled.includes(inputs.b)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.b });
    // No debounce on this fixture: unlike "a", the mid-loop rule never fires for "b" (nothing
    // ever replaces it) — it needs its OWN explicit Enter to reach the server at all.
    if (!history.some((h) => h.kind === 'key')) {
      const enterAction = obs.actions.find((a) => a.kind === 'key') ?? null;
      return decision({ operation: 'PRESS_ENTER', action: enterAction, text: null });
    }
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('RESCUE_TEST')) {
    // maxSteps cuts this off right after the click — the end-of-run rescue must fire because,
    // unlike the (already-fixed) old heuristic, the inert click does not itself certify anything.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!history.some((h) => h.kind === 'click')) return decision({ operation: 'CLICK', action: linkAction });
    return decision({ operation: 'BLOCKED', action: null }); // unreachable: maxSteps stops it first
  }
  if (goal.includes('NOFOCUS_TEST')) {
    // maxSteps cuts this off right after the fill; the page has no <form> at all, so the rescue's
    // Enter press succeeds (no exception) but submits nothing anywhere.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    return decision({ operation: 'BLOCKED', action: null }); // unreachable: maxSteps stops it first
  }
  if (goal.includes('CRASH_TEST')) {
    // maxSteps=1: this click is the only, and therefore the LAST, action the loop ever takes —
    // no further iteration ever re-observes the page it navigates to.
    return decision({ operation: 'CLICK', action: linkAction });
  }
  if (goal.includes('BLOCKED_GAP_TEST')) {
    // Exactly one BLOCKED response between the two fills — the runner's own settle-retry pushes
    // a 'wait' history entry, the gap the mid-loop auto-Enter guard used to lose "alpha" across.
    const blockedWaits = history.filter((h) => h.kind === 'wait').length;
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!filled.includes(inputs.b) && blockedWaits === 0) return decision({ operation: 'BLOCKED', action: null });
    if (!filled.includes(inputs.b)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.b });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('CHECK_DRAIN_TEST')) {
    // Nothing to fill or click — the whole point is the `expect` list's check + response pair.
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('CRASH_CHECK_TEST')) {
    // Nothing to fill or click — the whole point is the `expect` list's check navigating away.
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('PRUNE_TEST')) {
    // Dispatches on `certified` itself, not on history content like every branch above — this is
    // what actually exercises the RUNNER's own certifiedKeys() (recomputed each step from live
    // submission events), not just decide()/buildBody()'s internal pruning. Disabling the
    // pruning (mutation-check) always leaves `certified` empty, so this never advances past
    // TYPE_TEXT and the run's own repeat-loop detection ends it BLOCKED/stuck.
    if (!certified.has('query')) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.query });
    // Deliberately stubborn ONE more time even once certified — simulating Jev not having "gotten
    // the memo" that pruning already removed this input — to prove the harness-level no-op
    // fallback (not Jev's own good behaviour) is what stops a second, wasted real retype.
    if (!history.some((h) => h.kind === 'wait' && h.action.includes('already certified'))) {
      return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.query });
    }
    // Action ids are always synthetic (snapshot.js's own 'e1'/'e2'/...), never the DOM id — the
    // injected result is the only <a> on this fixture, so `linkAction` (found generically above)
    // is it, once the debounced fetch has rendered it.
    if (linkAction && !history.some((h) => h.kind === 'click')) return decision({ operation: 'CLICK', action: linkAction });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('FALLBACK_TEST')) {
    // No debounce at all on this fixture: "alpha" is genuinely NOT certified until something
    // actually submits it, and the result page (with something to click) only exists past that
    // navigation. Deliberately re-answers TYPE_TEXT with the SAME already-filled value once,
    // WITHOUT ever pressing Enter itself, then clicks the result once one appears — proving the
    // "not certified → press Enter instead of retyping" branch, not Jev's own good behaviour, is
    // what gets this scenario anywhere at all: without it, no key press ever happens, the result
    // page is never reached, and (this being `acceptance`, whose PASS strictly requires jevDone —
    // never rescued by the adversarial-only end-of-run rescue, guard 13) the run can only BLOCK.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!history.some((h) => h.kind === 'key')) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (linkAction && !history.some((h) => h.kind === 'click')) return decision({ operation: 'CLICK', action: linkAction });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('FOCUS_STEAL_TEST')) {
    // The page steals focus to a DIFFERENT, unrelated input 300ms after typing — well within
    // act()'s own 600ms settle wait, so focus has already moved by the time this decision runs.
    // Deliberately retypes the SAME value, never pressing Enter itself — proving the harness's
    // OWN re-focus-and-verify (N6), not luck, is what lands the Enter in the RIGHT field.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!history.some((h) => h.kind === 'key')) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('VALUE_CLEAR_TEST')) {
    // maxSteps cuts this off right after the click, mirroring RESCUE_TEST — but this field's OWN
    // onfocus handler wipes its value the instant the end-of-run rescue's own re-click refocuses
    // it (no follow-up typing this time), so the rescue's focusAndVerify must see a mismatch and
    // skip the Enter — proving O7's value re-check, not just N6's focus re-check, gates the press.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!history.some((h) => h.kind === 'click')) return decision({ operation: 'CLICK', action: linkAction });
    return decision({ operation: 'BLOCKED', action: null }); // unreachable: maxSteps stops it first
  }
  if (goal.includes('DEBOUNCE_GRACE_TEST')) {
    // No explicit Enter ever offered for either value — "a" can ONLY be certified by the mid-loop
    // REPLACE guard's own debounce-grace poll (O10) catching the 1s-delayed request before it
    // commits to an Enter press; "b" is left for the run's own post-loop settle to catch.
    if (!filled.includes(inputs.a)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.a });
    if (!filled.includes(inputs.b)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.b });
    return decision({ operation: 'DONE' });
  }
  if (goal.includes('CLIENT_FILTER_TEST')) {
    // No request of any kind ever fires on this fixture — a pure client-side filter. Reaches
    // DONE regardless (a client-rendered "result" IS visible), but the value must never certify.
    if (!filled.includes(inputs.term)) return decision({ operation: 'TYPE_TEXT', action: fillAction, text: inputs.term });
    return decision({ operation: 'DONE' });
  }
  return decision({ operation: 'DONE' });
}

test('runner boundary: real browser + http server + injected decide', { skip: SKIP }, async () => {
  const { server, port } = await startServer();
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-runner-'));
  const outDir = join(dir, 'run1');
  try {
    const config: Config = {
      environments: { local: { baseUrl: `http://127.0.0.1:${port}`, mutations: true } },
      roles: { anon: { login: async () => {} } },
      ownOrigins: [/127\.0\.0\.1/],
      scenarios: [],
      checks: {
        // J5: fires a page-initiated fetch and waits for the client-side promise to settle —
        // the ORACLE's own body read (kicked off inside its response handler) is a separate,
        // async race that the runner must drain before the next `response` assertion evaluates.
        pageFetch: async (ctx) => {
          await ctx.page.evaluate(() => fetch('/api/echo?q=checked').then(() => undefined));
          return { ok: true, detail: 'triggered a page fetch' };
        },
        // M4 (round 7): a check assertion navigating to a crash page — the pre-`expect` final
        // crash inspection ran BEFORE this, so only the post-`expect` one (added this round) can
        // ever catch it.
        navigateToCrash: async (ctx) => {
          await ctx.page.goto(ctx.env.baseUrl + '/crash-target');
          return { ok: true, detail: 'navigated to the crash target' };
        },
      },
    };

    const adversarial: Scenario = {
      name: 'test/adversarial', kind: 'adversarial', role: 'anon', start: '/',
      goal: 'ADVERSARIAL_TEST: fill a then b (replacing without Enter) then done',
      inputs: { a: 'alpha', b: 'beta' }, maxSteps: 10,
    };
    const acceptance: Scenario = {
      name: 'test/acceptance', kind: 'acceptance', role: 'anon', start: '/',
      goal: 'ACCEPTANCE_TEST: fill alpha then done', maxSteps: 10,
      expect: [{ response: { url: '/api/echo', status: 200, jsonPath: 'q', equals: 'alpha' } }],
    };
    const blocked: Scenario = {
      name: 'test/blocked', kind: 'acceptance', role: 'anon', start: '/blocked',
      goal: 'BLOCKED_TEST: fill alpha then click an unrelated (no-op) link then never reach DONE',
      maxSteps: 10,
      expect: [{ text: 'no results' }],
    };
    // Mutation-checks the mid-loop auto-Enter + its reportStep attribution: on this debounce-free
    // fixture, the ONLY way "alpha" is ever certified is that guard firing correctly.
    const mutation: Scenario = {
      name: 'test/mutation', kind: 'adversarial', role: 'anon', start: '/mutation',
      goal: 'MUTATION_TEST: fill a then b (replacing without Enter, mid-loop auto-Enter must fire), then Enter, then done',
      inputs: { a: 'alpha', b: 'beta' }, maxSteps: 10,
    };
    // The inert click does not itself certify "alpha" — this proves the end-of-run rescue fires
    // on genuine non-certification (H1), not on the old "was there any event at all" heuristic.
    const rescue: Scenario = {
      name: 'test/rescue', kind: 'adversarial', role: 'anon', start: '/mutation',
      goal: 'RESCUE_TEST: fill alpha, click an unrelated inert link, run out of budget — the end-of-run rescue must still certify it',
      inputs: { a: 'alpha' }, maxSteps: 2,
    };
    const noFocus: Scenario = {
      name: 'test/nofocus', kind: 'adversarial', role: 'anon', start: '/noform',
      goal: 'NOFOCUS_TEST: fill alpha on a page with no form — the rescue Enter succeeds but submits nothing, must stay BLOCKED',
      inputs: { a: 'alpha' }, maxSteps: 1,
    };
    // J1: the ONLY action (maxSteps=1) navigates to a crash screen; no later iteration ever
    // re-observes to catch it via the per-step check — only the post-loop final check can.
    const crash: Scenario = {
      name: 'test/crash', kind: 'smoke', role: 'anon', start: '/crashstart',
      goal: 'CRASH_TEST: click the link (the resulting page crashes; must still FAIL, not smoke-PASS)',
      maxSteps: 1,
    };
    // J4: one BLOCKED response sits between the two fills — proves the mid-loop auto-Enter
    // survives that gap (was lost via the immediately-previous-history-entry check), and
    // directly asserts the resulting request's step (not just that the run passes) —
    // load-bearing on this fixture, unlike round 3's inconclusive reportStep mutation-check.
    const blockedGap: Scenario = {
      name: 'test/blocked-gap', kind: 'adversarial', role: 'anon', start: '/mutation',
      goal: 'BLOCKED_GAP_TEST: fill a, hit one BLOCKED retry, replace with b (auto-Enter must survive the gap), then done',
      inputs: { a: 'alpha', b: 'beta' }, maxSteps: 10,
    };
    // J5: a `check` assertion triggers a page fetch; the following `response` assertion must
    // see its body, not race an oracle read still in flight.
    const checkDrain: Scenario = {
      name: 'test/check-drain', kind: 'acceptance', role: 'anon', start: '/mutation',
      goal: 'CHECK_DRAIN_TEST: nothing to do but reach done',
      maxSteps: 3,
      expect: [{ check: { name: 'pageFetch' } }, { response: { url: '/api/echo', status: 200, jsonPath: 'q', equals: 'checked' } }],
    };
    // L2: the round-4 → round-6 regression, reproduced — a debounced search whose result renders
    // asynchronously. fakeDecide keeps offering TYPE_TEXT 'flower' until the runner's own
    // certifiedKeys() reports it certified; it must certify after exactly one fill, never retype.
    const prune: Scenario = {
      name: 'test/prune', kind: 'acceptance', role: 'anon', start: '/prune',
      goal: 'PRUNE_TEST: type the query, then click the result once certified, then done',
      inputs: { query: 'flower' }, maxSteps: 10,
    };
    // L2 harness fallback: no debounce here at all — "alpha" can ONLY ever be certified by an
    // actual Enter/submit, and the clickable result only exists past that navigation. `acceptance`
    // (not `adversarial`, unlike test/prune) so its PASS strictly requires jevDone — the
    // adversarial-only end-of-run rescue (guard 13) can never paper over a missing mid-loop guard.
    const fallback: Scenario = {
      name: 'test/fallback-enter', kind: 'acceptance', role: 'anon', start: '/fallback',
      goal: 'FALLBACK_TEST: fill a, retype the SAME value again without ever pressing Enter, click the result, then done',
      inputs: { a: 'alpha' }, maxSteps: 6,
      expect: [{ text: 'alpha result' }],
    };
    // M4 (round 7): a `check` assertion navigates to a real crash page. The pre-`expect` final
    // crash inspection ran before this ever happened; only the post-`expect` one (this round)
    // can catch it — must FAIL with a crash-screen finding, not smoke/acceptance-PASS.
    const crashCheck: Scenario = {
      name: 'test/crash-check', kind: 'acceptance', role: 'anon', start: '/',
      goal: 'CRASH_CHECK_TEST: nothing to do but reach done',
      maxSteps: 3,
      expect: [{ check: { name: 'navigateToCrash' } }],
    };
    // N6 (round 8): a second, unrelated input steals focus after typing — proves the runner
    // re-resolves and re-clicks the INTENDED field before pressing Enter into it, rather than
    // blindly pressing Enter wherever focus happens to be.
    const focusSteal: Scenario = {
      name: 'test/focus-steal', kind: 'adversarial', role: 'anon', start: '/focus-steal',
      goal: 'FOCUS_STEAL_TEST: fill a, let focus get stolen by a distraction, retype the SAME value without ever pressing Enter, then done',
      inputs: { a: 'alpha' }, maxSteps: 6,
    };
    // N7 (round 8): a fill that only filters the page client-side — no request of any kind ever
    // fires — replaces the round-7 unit-level "page change alone" test, which became vacuous
    // (impossible to even construct) once ChangeEvent was removed from the type system entirely.
    const clientFilter: Scenario = {
      name: 'test/client-filter', kind: 'adversarial', role: 'anon', start: '/client-filter',
      goal: 'CLIENT_FILTER_TEST: type the term into the client-side filter, then done',
      inputs: { term: 'banana' }, maxSteps: 3,
    };
    // O7 (round 9): the field clears itself on refocus — the end-of-run rescue's re-click wipes
    // it (no retype follows), so focusAndVerify's value check must fail and the Enter must never
    // be pressed; must stay BLOCKED, never silently "rescue" an input that was never truly there.
    const valueClear: Scenario = {
      name: 'test/value-clear', kind: 'adversarial', role: 'anon', start: '/value-clear',
      goal: 'VALUE_CLEAR_TEST: fill alpha, click an unrelated inert link, run out of budget — the field wipes its own value on refocus, so the rescue must skip the Enter and stay BLOCKED',
      inputs: { a: 'alpha' }, maxSteps: 2,
    };
    // O10 (round 9): a 1s debounce, longer than act()'s own fixed 600ms fill-settle wait — proves
    // the mid-loop REPLACE guard's own debounce-grace poll, not act()'s unrelated wait, is what
    // lets "alpha" certify without ever forcing an Enter into the field.
    const debounceGrace: Scenario = {
      name: 'test/debounce-grace', kind: 'adversarial', role: 'anon', start: '/debounce-grace',
      goal: 'DEBOUNCE_GRACE_TEST: fill a then b (replacing without ever pressing Enter) then done — a 1s debounce must certify both without any auto-Enter',
      inputs: { a: 'alpha', b: 'beta' }, maxSteps: 10,
    };

    // R5 (round 11): 350 own-origin fetches on load; fakeDecide's default branch answers DONE. The
    // persisted `requests`/`responses` must come back capped at 300 with the omitted counts set.
    const capResults: Scenario = {
      name: 'smoke/cap-results', kind: 'smoke', role: 'anon', start: '/many-requests',
      goal: 'CAP_RESULTS_TEST: nothing to do but reach done', maxSteps: 2,
    };

    const results = await runAll({
      config, dir, envName: 'local',
      scenarios: [
        adversarial, acceptance, blocked, mutation, rescue, noFocus, crash, blockedGap, checkDrain,
        prune, fallback, crashCheck, focusSteal, clientFilter, valueClear, debounceGrace, capResults,
      ],
      concurrency: 17, repeat: 1, outDir, deps: { decide: fakeDecide },
    });

    const adv = results.find((r) => r.name === 'test/adversarial');
    assert.ok(adv, 'adversarial result present');
    assert.equal(adv!.verdict, 'PASS', adv!.reason);
    assert.deepEqual(new Set(adv!.submitted), new Set(['alpha', 'beta']));

    const acc = results.find((r) => r.name === 'test/acceptance');
    assert.ok(acc, 'acceptance result present');
    assert.equal(acc!.verdict, 'PASS', acc!.reason);
    assert.ok(acc!.expectResults?.every((e) => e.ok), 'every acceptance expect assertion passed');

    const blk = results.find((r) => r.name === 'test/blocked');
    assert.ok(blk, 'blocked result present');
    assert.equal(blk!.verdict, 'BLOCKED', blk!.reason);
    assert.deepEqual(blk!.submitted, []);

    const mut = results.find((r) => r.name === 'test/mutation');
    assert.ok(mut, 'mutation result present');
    assert.equal(mut!.verdict, 'PASS', mut!.reason);
    assert.deepEqual(new Set(mut!.submitted), new Set(['alpha', 'beta']));
    // Two trail entries decide "fill beta": the first, on /mutation, gets re-observed away by the
    // mid-loop auto-Enter (its label notes the navigation); the LAST one is where it actually ran.
    const betaFillEntries = mut!.trail.filter((t) => t.text === 'beta');
    assert.ok(betaFillEntries.length >= 1, 'at least one trail entry recorded the "beta" fill');
    const betaFillEntry = betaFillEntries.at(-1)!;
    assert.ok(betaFillEntry.url.includes('/mutation-search'), `expected the last "beta" fill decision to happen on /mutation-search, got ${betaFillEntry.url}`);

    const res = results.find((r) => r.name === 'test/rescue');
    assert.ok(res, 'rescue result present');
    assert.equal(res!.verdict, 'PASS', res!.reason);
    assert.deepEqual(res!.submitted, ['alpha']);

    const nf = results.find((r) => r.name === 'test/nofocus');
    assert.ok(nf, 'nofocus result present');
    assert.equal(nf!.verdict, 'BLOCKED', nf!.reason);
    assert.deepEqual(nf!.submitted, []);

    const crashResult = results.find((r) => r.name === 'test/crash');
    assert.ok(crashResult, 'crash result present');
    assert.equal(crashResult!.verdict, 'FAIL', crashResult!.reason);
    assert.ok(crashResult!.findings.some((f) => f.kind === 'crash-screen'), 'expected a crash-screen finding from the final-page check');

    const gap = results.find((r) => r.name === 'test/blocked-gap');
    assert.ok(gap, 'blocked-gap result present');
    assert.equal(gap!.verdict, 'PASS', gap!.reason);
    assert.deepEqual(new Set(gap!.submitted), new Set(['alpha', 'beta']));
    const alphaRequest = gap!.requests.find((r) => r.url.includes('q=alpha'));
    assert.ok(alphaRequest, 'expected a recorded request carrying "alpha"');
    assert.equal(alphaRequest!.step, 1, `expected the auto-Enter's request to be attributed to step 1 (alpha's original fill step), got step ${alphaRequest!.step}`);

    const cd = results.find((r) => r.name === 'test/check-drain');
    assert.ok(cd, 'check-drain result present');
    assert.equal(cd!.verdict, 'PASS', cd!.reason);
    assert.ok(cd!.expectResults?.every((e) => e.ok), `expected both the check and the response assertion to pass: ${JSON.stringify(cd!.expectResults)}`);

    const pr = results.find((r) => r.name === 'test/prune');
    assert.ok(pr, 'prune result present');
    assert.equal(pr!.verdict, 'PASS', pr!.reason);
    assert.deepEqual(pr!.submitted, ['flower']);
    // fakeDecide deliberately asks TYPE_TEXT 'flower' TWICE — once for real, once stubbornly
    // after certification — so exactly one trail entry must be a genuine (non-intercepted) fill.
    const fillEntries = pr!.trail.filter((t) => t.op === 'TYPE_TEXT');
    const genuineFills = fillEntries.filter((t) => !t.label.includes('already certified'));
    assert.equal(genuineFills.length, 1, `expected exactly one genuine TYPE_TEXT fill of "flower" (no retyping after certification), got ${genuineFills.length}: ${JSON.stringify(fillEntries)}`);
    assert.ok(fillEntries.some((t) => t.label.includes('already certified, no-op')), `expected the stubborn second retype to be caught as a no-op, got ${JSON.stringify(fillEntries)}`);
    assert.ok(pr!.trail.some((t) => t.op === 'CLICK'), 'expected the certified-query result to be clicked');

    const fb = results.find((r) => r.name === 'test/fallback-enter');
    assert.ok(fb, 'fallback-enter result present');
    assert.equal(fb!.verdict, 'PASS', fb!.reason);
    assert.deepEqual(fb!.submitted, ['alpha']);
    assert.ok(
      fb!.trail.some((t) => t.label.includes('auto-submitted: field already holds this value')),
      `expected the second (stubborn) TYPE_TEXT decision to be caught and auto-submitted via Enter, got ${JSON.stringify(fb!.trail)}`,
    );
    assert.ok(fb!.trail.some((t) => t.op === 'CLICK'), 'expected the result (reached only past the Enter-triggered navigation) to be clicked');
    assert.ok(fb!.expectResults?.every((e) => e.ok), `expected the "alpha result" text assertion to pass: ${JSON.stringify(fb!.expectResults)}`);

    const cc = results.find((r) => r.name === 'test/crash-check');
    assert.ok(cc, 'crash-check result present');
    assert.equal(cc!.verdict, 'FAIL', cc!.reason);
    assert.ok(cc!.findings.some((f) => f.kind === 'crash-screen'), `expected a crash-screen finding from the post-expect final check, got ${JSON.stringify(cc!.findings)}`);

    const fs_ = results.find((r) => r.name === 'test/focus-steal');
    assert.ok(fs_, 'focus-steal result present');
    assert.equal(fs_!.verdict, 'PASS', fs_!.reason);
    assert.deepEqual(fs_!.submitted, ['alpha']);
    const focusStealRequest = fs_!.requests.find((r) => r.url.includes('q=alpha'));
    assert.ok(focusStealRequest, `expected the Enter press to land in the search field (not the distraction), producing a request carrying "alpha", got ${JSON.stringify(fs_!.requests)}`);

    const cf = results.find((r) => r.name === 'test/client-filter');
    assert.ok(cf, 'client-filter result present');
    assert.equal(cf!.verdict, 'BLOCKED', cf!.reason);
    assert.deepEqual(cf!.submitted, []);
    assert.match(cf!.reason, /inputs not submitted: term/);

    const vc = results.find((r) => r.name === 'test/value-clear');
    assert.ok(vc, 'value-clear result present');
    assert.equal(vc!.verdict, 'BLOCKED', vc!.reason);
    assert.deepEqual(vc!.submitted, []);
    assert.match(vc!.reason, /inputs not submitted: a/);
    // The verdict alone doesn't distinguish "the Enter was correctly skipped" from "the Enter was
    // pressed anyway, into the now-empty field" (either way "alpha" ends up unsubmitted) — assert
    // directly that no request EVER reached the server at all: proof the rescue's focusAndVerify
    // genuinely refused to press Enter, rather than pressing it into a blank query string.
    assert.ok(
      !vc!.requests.some((r) => r.url.includes('/value-clear-search')),
      `expected the Enter press to be skipped entirely (value mismatch), but a request reached the server: ${JSON.stringify(vc!.requests)}`,
    );

    const dg = results.find((r) => r.name === 'test/debounce-grace');
    assert.ok(dg, 'debounce-grace result present');
    assert.equal(dg!.verdict, 'PASS', dg!.reason);
    assert.deepEqual(new Set(dg!.submitted), new Set(['alpha', 'beta']));
    assert.ok(
      !dg!.trail.some((t) => t.label.includes('auto-submitted previous value')),
      `expected no auto-Enter at all — the 1s debounce must certify "alpha" on its own before the guard commits to a press, got ${JSON.stringify(dg!.trail)}`,
    );
    assert.ok(
      dg!.trail.some((t) => t.label.includes('auto-submit skipped: value already certified by a debounced request')),
      `expected the debounce-grace poll's own trail note, got ${JSON.stringify(dg!.trail)}`,
    );

    const cap = results.find((r) => r.name === 'smoke/cap-results');
    assert.ok(cap, 'cap-results result present');
    assert.equal(cap!.verdict, 'PASS', cap!.reason);
    // 350 fetches + the page's own document request = 351 own-origin requests/responses; only the
    // most recent 300 of each are persisted, the rest counted, never silently dropped.
    assert.equal(cap!.requests.length, 300, `expected the persisted requests capped at 300, got ${cap!.requests.length}`);
    assert.equal(cap!.responses.length, 300, `expected the persisted responses capped at 300, got ${cap!.responses.length}`);
    assert.ok((cap!.requestsOmitted ?? 0) >= 50, `expected requestsOmitted >= 50, got ${cap!.requestsOmitted}`);
    assert.ok((cap!.responsesOmitted ?? 0) >= 50, `expected responsesOmitted >= 50, got ${cap!.responsesOmitted}`);

    assert.equal(existsSync(join(outDir, 'results.json')), true);
    assert.equal(existsSync(join(outDir, 'report.html')), true);
  } finally {
    server.close();
  }
});
