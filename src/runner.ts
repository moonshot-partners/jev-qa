// Parallel scenario runner. One Chromium, one isolated context per scenario
// run. Verdict comes from decideVerdict() (code-owned oracles + expect
// assertions), never from Jev's DONE alone. Ported from the spike's run.ts
// with every guard intact (see MORNING.md "Harness lessons", README "Guards").
import { existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { act, focusAndVerify, observe } from './browser.ts';
import { resolveBaseUrl, type Config } from './config.ts';
import { evaluate, type ExpectResult } from './expect.ts';
import { decide as realDecide, newPseudonyms, redactValue, type Action, type Decision, type HistoryEntry, type Observation } from './jev.ts';
import { DEFAULT_CRASH_TEXT, drainPending, newSink, record, watch, type Finding, type RequestRecord, type ResponseRecord } from './oracles.ts';
import { renderReport } from './report.ts';
import { applyRunId, newRunId, scenarioInputs, scenarioPhases, type Scenario } from './scenario.ts';
import { needsRescue, partialMatch, submittedInputs, uninspectableRequest, type SubmissionEvent } from './submission.ts';
import { decideVerdict, refusedByEnvironment, type Verdict } from './verdict.ts';

export type Result = {
  name: string;
  kind: 'smoke' | 'adversarial' | 'acceptance';
  run: number;
  verdict: Verdict;
  reason: string;
  steps: number;
  seconds: number;
  jevCalls: number;
  jevMsAvg: number;
  inputTokens: number;
  findings: Finding[];
  trail: { op: string; label: string; text?: string | null; conf: number; ms: number; url: string; phase?: string }[];
  // The per-run unique value substituted for `{{run}}` (see scenario.ts) — recorded so a human
  // can find what this run created (an account, a record) by the value it typed.
  runId?: string;
  // Trimmed (no body/postData) so results.json stays small; grounds a scenario author's
  // jsonPath/status facts without needing a live probe run to read them back. Round 10 (Q3):
  // also CAPPED to the most recent 300 entries each on a long/chatty run — the in-memory
  // timeline `submittedInputs()`/etc. actually certify against is never capped, only this
  // persisted copy; `*Omitted` carries how many older entries were dropped (absent/0 if none).
  responses: { step: number; method: string; url: string; status: number }[];
  requests: { step: number; method: string; url: string }[];
  responsesOmitted?: number;
  requestsOmitted?: number;
  video?: string;
  // What the settled final page SAID (visible text, clipped, masked): a failed run's reason
  // names the assertion that missed, but the page's own error banner is what explains it.
  finalText?: string;
  intent?: string;
  expectResults?: ExpectResult[];
  submitted: string[];
};

// Injectable for tests: a fake `decide` lets test/runner.browser.test.ts drive a real
// browser/context/oracle pipeline against a scripted decision sequence, with no Jev
// network call and no LLM. Production code never passes this; it defaults to the real one.
export type RunnerDeps = { decide?: typeof realDecide };

function emptyResult(s: Scenario, kind: Result['kind'], run: number, verdict: Verdict, reason: string): Result {
  return {
    name: s.name, kind, run, verdict, reason: maskSecrets(reason, s),
    steps: 0, seconds: 0, jevCalls: 0, jevMsAvg: 0, inputTokens: 0,
    findings: [], trail: [], responses: [], requests: [], submitted: [],
    intent: s.intent === undefined ? undefined : maskSecrets(s.intent, s),
  };
}

// PURE: replaces every occurrence of a `secretInputs` value with its «key» — applied to the
// run's own outputs (trail text, certified list, reason). Jev requests never carried the value
// in the first place (jev.ts redact()); this keeps it out of results.json and the report too.
export function maskSecrets(text: string, s: Pick<Scenario, 'inputs' | 'then' | 'secretInputs'>): string {
  if (!s.secretInputs?.length) return text;
  const values = scenarioInputs(s);
  let out = text;
  // Every value the key ever had (a phase may reuse a key with a new value), in every form the
  // Jev-side redaction covers (raw, percent/form-encoded — a GET form carries it that way in a
  // request URL — HTML-escaped, JSON-escaped): redactValue() is the same routine buildBody() uses.
  // Longest value first: a shorter value that prefixes a longer one would otherwise be replaced
  // first and leave the longer one's tail exposed.
  const pairs = s.secretInputs.flatMap((key) => (values[key] ?? []).map((v) => ({ key, v }))).sort((a, b) => b.v.length - a.v.length);
  for (const { key, v } of pairs) out = redactValue(out, v, `«${key}»`);
  return out;
}

// PURE: every input across every phase, flattened for the verdict's "each input reached the
// server" rule: a key reused with a second value in a later phase appears again as `key#2`
// (`#3`, … — skipping any name a real input already uses).
export function flattenInputs(byKey: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, vs] of Object.entries(byKey)) {
    vs.forEach((v, i) => {
      let name = i ? `${k}#${i + 1}` : k;
      for (let n = i + 1; name in out || (name !== k && name in byKey); n++) name = `${k}#${n + 1}`;
      out[name] = v;
    });
  }
  return out;
}

// PURE: applies a string mask to every string inside plain JSON-shaped data (an expectation's
// own assertion can quote a secret input's value, e.g. `{ text: "Welcome <password>" }`).
export function maskDeep(value: unknown, mask: (s: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, mask)]));
  }
  return value;
}

// PURE (round 10, Q3): keeps only the most recent `max` entries of an already-chronological
// array (requests/responses are pushed in step order as the run proceeds), reporting how many
// older ones were dropped — a long/chatty run's `results.json` would otherwise grow unbounded.
export function capRecent<T>(items: T[], max = 300): { kept: T[]; omitted: number } {
  if (items.length <= max) return { kept: items, omitted: 0 };
  return { kept: items.slice(items.length - max), omitted: items.length - max };
}

// PURE (round 11, R5): the persisted, human-facing request/response timeline a Result carries —
// trimmed (no body/postData) AND capped to the most recent 300 entries each via capRecent().
// Split out of runOne()'s return statement so a unit test drives the SAME code runOne() runs, not
// just capRecent() in isolation: removing the capRecent() calls here (or this function's call
// from runOne()) fails a test either way.
export function persistedTimeline(
  requests: RequestRecord[],
  responses: ResponseRecord[],
): Pick<Result, 'requests' | 'responses' | 'requestsOmitted' | 'responsesOmitted'> {
  const cappedRequests = capRecent(requests);
  const cappedResponses = capRecent(responses);
  return {
    requests: cappedRequests.kept.map((r) => ({ step: r.step, method: r.method, url: r.url })),
    responses: cappedResponses.kept.map((r) => ({ step: r.step, method: r.method, url: r.url, status: r.status })),
    requestsOmitted: cappedRequests.omitted || undefined,
    responsesOmitted: cappedResponses.omitted || undefined,
  };
}

async function runOne(browser: Browser, config: Config, envName: string, scenario: Scenario, run: number, outDir: string, deps: RunnerDeps = {}): Promise<Result> {
  const decide = deps.decide ?? realDecide;
  // One unique value per run, substituted for `{{run}}` everywhere in the scenario but its name.
  const runId = newRunId();
  const s = applyRunId(scenario, runId);
  const phases = scenarioPhases(s);
  const mask = (text: string) => maskSecrets(text, s);
  // Every input across every phase, flattened for the verdict's "each input reached the server"
  // rule: a key reused with a second value in a later phase appears again as `key#2`.
  const allInputs: Record<string, string> = flattenInputs(scenarioInputs(s));
  const kind = s.kind ?? 'acceptance';
  const env = config.environments[envName];
  if (refusedByEnvironment(s, env)) {
    return emptyResult(s, kind, run, 'REFUSED', `scenario mutates; environment "${envName}" has mutations disabled`);
  }

  const videosDir = join(outDir, 'videos');
  const started = performance.now();
  const sink = newSink();
  const trail: Result['trail'] = [];
  const history: HistoryEntry[] = [];
  const submissionEvents: SubmissionEvent[] = [];
  const crashText = [...DEFAULT_CRASH_TEXT, ...(config.crashText ?? [])];
  let step = 0;
  let lastExecutedStep = 0;
  // What the oracle tags own-origin requests/responses/findings with. Usually equal to `step`,
  // but an auto-Enter press (mid-loop or end-of-run) submits a PREVIOUS fill's value while the
  // loop is already on a later step — its own resulting request must be attributed to the fill
  // it submits, not the step it happened to fire on, or it falls outside that fill's evidence
  // window (see submission.ts). Narrowed to just that press's await span, then restored.
  let reportStep = 0;
  let jevMs = 0;
  let tokens = 0;
  let jevDone = false;
  let loopReason = 'step budget used up';
  let error: string | undefined;
  let unreadBodies = 0;
  let finalText: string | undefined;

  // Round 8 (N2): extra secret strings the app config knows about (e.g. a logged-in role's own
  // creds), redacted the same as scenario inputs but to the shared «secret» token — resolved
  // once per run, not per step (a config author who wants per-step freshness can still return a
  // fresh array from the function each call; the runner just doesn't force that cost).
  const secrets = typeof config.redact === 'function' ? config.redact() : (config.redact ?? []);
  // Round 9 (O4): one Pseudonyms map per RUN (not per decide() call) — an email/token seen in
  // one observation must scrub to the SAME numbered pseudonym the next time it appears, so Jev
  // can still recognise "the link with «email:2»" across turns.
  const pseudonyms = newPseudonyms();
  const role = s.role ? config.roles[s.role] : null;
  const baseUrl = role ? resolveBaseUrl(role, env) : env.baseUrl;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videosDir, size: { width: 640, height: 400 } } });
  let page: Page | undefined;
  let expectResults: ExpectResult[] | undefined;
  const allExpect: ExpectResult[] = [];
  let findings: Finding[] = [];
  let responses: ResponseRecord[] = [];
  let requests: RequestRecord[] = [];
  let submitted = new Set<string>();
  const missingDetail: Record<string, string> = {}; // round 8, N4/N5b — see below
  try {
    await config.setupContext?.(ctx, env);
    if (role) {
      const loginPage = await ctx.newPage();
      await role.login(loginPage, env);
      await loginPage.close();
    }
    page = await ctx.newPage();
    const detach = watch(page, sink, () => reportStep, { ownOrigins: config.ownOrigins, noise: config.noise, known: config.known });
    await page.goto(s.start.startsWith('http') ? s.start : baseUrl + s.start, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await config.beforeEach?.(page);

    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    const phaseLabel = phaseIndex ? phase.name : undefined;
    const phaseInputs: Record<string, string> = { ...(s.inputs ?? {}), ...(phase.inputs ?? {}) };
    // Values from OTHER phases are not offered to type here, but a page may still echo one (the
    // email typed at sign-up shown on the next page): redact them like config secrets.
    const offered = new Set(Object.values(phaseInputs));
    const phaseSecrets = [...secrets, ...Object.values(allInputs).filter((v) => !offered.has(v))];
    // The phase's evidence window opens at its own start navigation: step 0 for the main phase
    // (its start page's responses count), a fresh step of its own for a later phase, so the
    // previous phase's last-step traffic stays out and the start check's + start page's traffic
    // is in.
    const phaseFirstStep = phaseIndex ? ++step : 0;
    reportStep = phaseFirstStep;
    // Which controls THIS run filled, and with what — the overwrite guard below trusts only
    // values the run itself typed, never a prefilled value that merely equals an input.
    const filledByUs = new Map<string, string>();
    if (phaseIndex) {
      // A later phase starts on the SAME page/context: a path/URL, or a config check that
      // returns one (e.g. the set-password link read from a mailbox). A check that reports
      // `ok: false` is a failed expectation of this phase (FAIL, named); one that reports ok
      // without a url is a config bug (ERROR).
      let startUrl: string;
      if (typeof phase.start === 'string') {
        startUrl = phase.start;
      } else {
        const { name, args } = phase.start.check;
        const fn = config.checks?.[name];
        if (!fn) throw new Error(`phase "${phase.name}": no check named "${name}" in config.checks`);
        const r = await fn({ env, role: s.role, page, request: ctx.request }, args);
        await drainPending(sink, 5, 3_000);
        if (!r.ok) {
          allExpect.push({ assertion: { check: { name, args } }, ok: false, expected: `check "${name}" returns a start url`, actual: r.detail, phase: phase.name });
          loopReason = `phase "${phase.name}": start check "${name}" failed: ${r.detail}`;
          break;
        }
        if (!r.url) throw new Error(`phase "${phase.name}": start check "${name}" reported ok but returned no url`);
        startUrl = r.url;
      }
      await page.goto(startUrl.startsWith('http') ? startUrl : baseUrl + startUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      // The hook was written for the scenario's start page (a consent banner); on a later
      // phase's page it may find nothing and throw — that is not the phase's failure.
      try {
        await config.beforeEach?.(page);
      } catch (e) {
        trail.push({ op: 'BEFORE_EACH', label: `beforeEach failed on phase "${phase.name}" start: ${(e as Error).message.split('\n')[0].slice(0, 80)}`, text: null, conf: 1, ms: 0, url: mask(page.url()), phase: phase.name });
      }
      history.length = 0;
      jevDone = false;
      loopReason = 'step budget used up';
    }
    let unchanged = 0;
    let blockedRetries = 0;
    let blockedScrolls = 0;
    let lastBlockedScrollY = -1;
    // The most recent SUCCESSFUL fill, tracked independently of `history` — a BLOCKED settle
    // retry pushes its own 'wait' entry onto history, and the mid-loop auto-Enter guard below
    // used to look only at the immediately previous history entry, so fill -> BLOCKED retry ->
    // replacement silently never submitted the earlier value. `autoSubmitted` stops the guard
    // firing twice for the same fill.
    let lastFill: { label: string; text: string; step: number; changed: boolean; autoSubmitted: boolean; node: number; frame?: number } | null = null;
    // L2: input keys already certified as submitted (submission.ts), recomputed fresh from every
    // event seen so far — including own-origin requests the oracle has already recorded THIS
    // step, e.g. a debounced search request that landed while the loop was between decisions.
    // Fed to decide() so buildBody() can prune them from the request entirely; see jev.ts's
    // module doc comment for why redaction alone left Jev unable to tell a field was already
    // correctly filled.
    // Certification is judged per PHASE: only fills and requests from this phase's own steps.
    // A value certified in an earlier phase (the email typed at sign-up) must still be offered
    // when a later phase needs it again (the same email on the login page) — otherwise
    // buildBody() would prune the key and TYPE_TEXT with it.
    const thisPhase = <T extends { step: number }>(events: T[]) => events.filter((e) => e.step >= phaseFirstStep);
    const certifiedKeys = (): Set<string> => {
      const eventsSoFar: SubmissionEvent[] = [
        ...thisPhase(submissionEvents),
        ...thisPhase(sink.requests).map(
          (r): SubmissionEvent => ({ kind: 'request', step: r.step, method: r.method, url: r.url, postData: r.postData, bodyOversized: r.bodyOversized, contentType: r.contentType }),
        ),
      ];
      const certifiedValues = submittedInputs(eventsSoFar);
      return new Set(
        Object.entries(phaseInputs)
          .filter(([, v]) => certifiedValues.has(v))
          .map(([k]) => k),
      );
    };
    const firstStep = step + 1;
    for (step = firstStep; step < firstStep + (phase.maxSteps ?? 25); step++) {
      lastExecutedStep = step;
      reportStep = step;
      const obs: Observation = await observe(page);
      const crash = crashText.find((re) => re.test(obs.text));
      if (crash) record(sink, obs.url, step, 'crash-screen', crash.source, { noise: config.noise, known: config.known });
      const certified = certifiedKeys();
      const d: Decision = await decide(obs, phase.goal, phaseInputs, history, certified, phaseSecrets, pseudonyms);
      jevMs += d.latencyMs;
      tokens += d.inputTokens;
      const degradedNote = d.degraded ? ` (degraded: ${d.degraded})` : '';
      trail.push({ op: d.operation, label: mask((d.action?.label ?? '') + degradedNote), text: d.text === null ? null : mask(d.text), conf: d.confidence, ms: d.latencyMs, url: mask(obs.url), phase: phaseLabel });
      if (d.operation === 'DONE') {
        jevDone = true;
        loopReason = 'Jev: goal satisfied';
        break;
      }
      if (d.operation === 'BLOCKED' || !d.action) {
        // The snapshot offers only what is in the viewport, so the control Jev needs may simply
        // not be on screen yet (a form's checkboxes and submit button under a long list of
        // fields): while the page continues below the fold, SCROLL rather than give up — up to
        // a few screens, each its own step. Only then do client-rendered pages get their two
        // settle chances (they often look empty for a moment).
        // Stop scrolling once a scroll moved nothing (root scrolling disabled, a fixed layout that
        // still reports more document below): the settle retries then run as before.
        const scroll = obs.actions.find((a) => a.id === 'scroll_down');
        const scrollMoved = obs.scroll?.y !== lastBlockedScrollY;
        lastBlockedScrollY = obs.scroll?.y ?? -1;
        if (scroll && scrollMoved && blockedScrolls++ < 5) {
          await act(page, scroll, null);
          history.push({ action: 'Scroll down (auto: nothing to do above the fold)', kind: 'scroll', page_changed: null });
          trail[trail.length - 1].label += ' (auto-scrolled: more page below)';
          continue;
        }
        if (blockedRetries++ < 2) {
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(1000);
          history.push({ action: 'Wait for the page to update', kind: 'wait', page_changed: null });
          continue;
        }
        loopReason = 'Jev: no operation can progress';
        break;
      }
      // On a multi-field form, a field that already holds ANOTHER scenario input is done: do
      // not overwrite it with a different input when Jev itself ranked an empty (or foreign)
      // fill target as its next-best choice. Jev's target and text questions are answered
      // independently, so on a long form it can pair the postcode with the country field it
      // happened to look at, or retype a first name into the email — the form then never
      // validates. Only Jev's own alternatives are considered, never any empty field on the
      // page: on a one-field page (an adversarial search box) typing the next hostile input
      // over the previous one IS the intended pattern (guard 4 submits it first).
      const controlKey = (a: Action) => `${a.frame ?? 0}:${a.node}`;
      const holdsOurs = (a: Action) => !!a.value && filledByUs.get(controlKey(a)) === a.value;
      if (d.action.kind === 'fill' && d.text !== null && holdsOurs(d.action) && d.action.value !== d.text) {
        const holdsNothingOfOurs = (a: Action) => a.kind === 'fill' && (!holdsOurs(a) || a.value === d.text);
        const alt = d.alternatives.find(holdsNothingOfOurs);
        if (alt) {
          trail[trail.length - 1].label += mask(` → holds another input, not overwritten: ${alt.label.slice(0, 40)}`);
          d.action = alt;
        } else if (kind !== 'adversarial') {
          // No better target offered. An adversarial scenario feeds every input into the same
          // control by design (README "Guards"), so it may overwrite; any other kind maps inputs
          // to fields, and overwriting a filled field can only make the form invalid — skip the
          // fill and let Jev re-decide on a fresh observation (the stuck detectors end a loop).
          trail[trail.length - 1].label += ' → holds another input, not overwritten (no alternative offered)';
          history.push({ action: `${d.action.label} (holds another input, not overwritten)`, kind: 'wait', page_changed: null });
          continue;
        }
      }
      // L2 harness fallback: Jev picked TYPE_TEXT with a value that's ALREADY the target field's
      // current content (`d.action.value`, this step's own fresh observation) — pruning (above)
      // should normally keep this from happening at all, but this is state-based, not
      // history-position-based like the repeat guard below, so it still catches Jev re-picking a
      // not-yet-pruned key across a gap the repeat guard's "same as immediately-previous decision"
      // check can miss (the same class of gap round 5's `lastFill` fix closed for guard 4).
      if (d.action.kind === 'fill' && d.text !== null && d.action.value === d.text) {
        const key = Object.entries(phaseInputs).find(([, v]) => v === d.text)?.[0];
        if (key !== undefined && certified.has(key)) {
          // Already certified: never retype an already-submitted value. Pure no-op — reuse the
          // repeat guard's own next-best-target-or-scroll so the run still makes progress.
          const scroll = obs.actions.find((a) => a.id === 'scroll_down');
          const alt = d.alternatives[0] ?? scroll;
          trail[trail.length - 1].label += mask(` → already certified, no-op${alt ? `: ${alt.label.slice(0, 40)}` : ''}`);
          if (alt) {
            d.action = alt;
            if (alt.kind !== 'fill') d.text = null;
          } else {
            history.push({ action: `${d.action.label} (already certified, no-op)`, kind: 'wait', page_changed: null });
            continue;
          }
        } else {
          // Not certified yet: give it a real chance to actually reach the server instead of
          // uselessly retyping the same text into the field again. Attribute to the fill that
          // actually put this value in the field (usually `lastFill`, same reasoning as guard 4)
          // so the resulting request lands inside the right evidence window, not this later step.
          const attributionStep = lastFill && lastFill.label === d.action.label && lastFill.text === d.text ? lastFill.step : step;
          // N6 (round 8): confirm the page's OWN focus actually lands in the intended field
          // before pressing Enter — a focus-stealing element between the fill and this press
          // would otherwise submit whatever silently has focus instead. Skip the press entirely
          // (record nothing) rather than risk submitting into the wrong control.
          if (await focusAndVerify(page, d.action.node!, d.text, d.action.frame)) {
            reportStep = attributionStep;
            try {
              await page.keyboard.press('Enter');
              await page.waitForTimeout(400);
              await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
              history.push({ action: 'Press Enter (auto: field already holds the requested value)', kind: 'key', page_changed: null });
              if (lastFill && attributionStep === lastFill.step) lastFill.autoSubmitted = true;
              trail[trail.length - 1].label += ' (auto-submitted: field already holds this value)';
            } catch (e) {
              trail[trail.length - 1].label += ` (auto-submit Enter failed: ${(e as Error).message})`;
            } finally {
              reportStep = step;
            }
          } else {
            trail[trail.length - 1].label += ' (auto-submit skipped: focus verification failed)';
          }
          continue;
        }
      }
      // Repeat guard: Jev sometimes re-picks the control it just used (a hover menu it already
      // opened, a search box whose results are below the fold). Take its next-best target for
      // the same operation, else scroll; the harness owns "never repeat a no-op".
      const prev = history[history.length - 1];
      const same = prev && prev.kind === d.action.kind && prev.action === d.action.label && (prev.text ?? null) === d.text;
      if (same) {
        const scroll = obs.actions.find((a) => a.id === 'scroll_down');
        // No page change last time → the control is exhausted, reveal more page; a change (e.g. a
        // menu opened) → Jev wants something on the revealed page, take its next-best target.
        const alt = prev.page_changed === false ? (scroll ?? d.alternatives[0]) : (d.alternatives[0] ?? scroll);
        if (alt) {
          trail[trail.length - 1].label += mask(` → repeat guard: ${alt.label.slice(0, 40)}`);
          d.action = alt;
          if (alt.kind !== 'fill') d.text = null;
        }
      }
      // Unsubmitted-input rule (the original harness lesson): a value typed into a field that
      // Jev is about to REPLACE without having pressed Enter/submit is submitted first, before
      // it is lost. Only fires when Jev is about to overwrite the same field with different
      // text. Tracked via `lastFill`, not the immediately previous history entry — a BLOCKED
      // settle retry (below) pushes its own 'wait' entry in between, and this must still fire
      // across that gap. Never record a submit event when the Enter press itself fails.
      if (d.action.kind === 'fill' && lastFill && !lastFill.autoSubmitted && lastFill.label === d.action.label && lastFill.node === d.action.node && (lastFill.frame ?? 0) === (d.action.frame ?? 0) && lastFill.changed === false && lastFill.text !== d.text) {
        // O10 (round 9): before forcing an Enter press to submit the about-to-be-lost value,
        // give a debounced request a chance to land on its own — poll certifiedKeys() every
        // 250ms for up to 1.5s. Only a value that's actually one of this scenario's own inputs
        // can be recognised this way (certifiedKeys() is keyed off s.inputs); anything else
        // skips straight to the focus+Enter guard below, unchanged from before.
        const debounceKey = Object.entries(phaseInputs).find(([, v]) => v === lastFill!.text)?.[0];
        let debounceCertified = debounceKey !== undefined && certifiedKeys().has(debounceKey);
        if (debounceKey !== undefined && !debounceCertified) {
          const deadline = Date.now() + 1_500;
          // Attribute any request that lands DURING this poll to the ORIGINAL fill's own step —
          // the loop is already on a LATER step deciding the replacement text, and a request
          // landing here would otherwise share that later step with the replacement's own
          // upcoming fill event, colliding with it and falling outside this value's own
          // evidence window ([this fill's step, the next fill's step)) the moment that
          // replacement fill is recorded.
          const stepBeforePoll = reportStep;
          reportStep = lastFill.step;
          try {
            while (!debounceCertified && Date.now() < deadline) {
              await page.waitForTimeout(250);
              debounceCertified = certifiedKeys().has(debounceKey);
            }
          } finally {
            reportStep = stepBeforePoll;
          }
        }
        if (debounceCertified) {
          // Already reached the server on its own — no Enter needed, and pressing one anyway
          // risks submitting a SECOND request the app never expected.
          lastFill.autoSubmitted = true;
          trail[trail.length - 1].label += ' (auto-submit skipped: value already certified by a debounced request)';
        } else
        // N6 (round 8): confirm focus is still actually in `lastFill`'s own field before
        // pressing Enter into it — see the fallback guard above for why.
        if (await focusAndVerify(page, lastFill.node, lastFill.text, lastFill.frame)) {
          const urlBeforeEnter = obs.url;
          reportStep = lastFill.step;
          let navigated = false;
          try {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(400);
            await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
            history.push({ action: 'Press Enter (auto: submit the typed value before replacing it)', kind: 'key', page_changed: null });
            lastFill.autoSubmitted = true;
            trail[trail.length - 1].label += ' (auto-submitted previous value)';
            navigated = page.url() !== urlBeforeEnter;
          } catch (e) {
            trail[trail.length - 1].label += ` (auto-submit Enter failed: ${(e as Error).message})`;
          } finally {
            reportStep = step;
          }
          if (navigated) {
            // A plain HTML form's default Enter submission navigates the page — the node Jev's
            // CURRENT decision targets was captured from the observation BEFORE that navigation
            // and is now detached. Acting on it would just throw; instead let the next iteration
            // re-observe and re-decide fresh against the page the Enter press actually produced.
            trail[trail.length - 1].label += ' (page navigated; re-observing before the next decision)';
            continue;
          }
        } else {
          trail[trail.length - 1].label += ' (auto-submit skipped: focus verification failed)';
        }
      }
      const before = JSON.stringify([obs.url, obs.text.length, obs.actions.length]);
      try {
        await act(page, d.action, d.text);
      } catch (e) {
        history.push({ action: d.action.label, kind: d.action.kind, text: d.text, page_changed: false });
        // A fill that never executed never reached the field, let alone the server.
        if (d.action.kind === 'fill' && d.text !== null) {
          submissionEvents.push({ kind: 'fill', text: d.text, ok: false, step });
        }
        trail[trail.length - 1].label += ` (not executed: ${(e as Error).message})`;
        continue;
      }
      const after = await observe(page).catch(() => obs);
      const changed = JSON.stringify([after.url, after.text.length, after.actions.length]) !== before;
      history.push({ action: d.action.label, kind: d.action.kind, text: d.text, page_changed: changed });
      if (d.action.kind === 'fill' && d.text !== null) {
        filledByUs.set(controlKey(d.action), d.text);
        submissionEvents.push({ kind: 'fill', text: d.text, ok: true, step });
        lastFill = { label: d.action.label, text: d.text, step, changed, autoSubmitted: false, node: d.action.node!, frame: d.action.frame };
      }
      // Round 8 (N4): certification is STRONG-only now (an own-origin request that demonstrably
      // carries the value) — a bare 'submit'/'clickAfterFill' event, with no request evidence of
      // its own, is no longer read by submittedInputs() at all (see submission.ts), so tracking
      // them here is dead weight; removed along with the ChangeEvent-style types they used.
      // Round 7 (M3): a page change alone is no longer submission evidence (see submission.ts) —
      // `changed` still drives the stuck-loop detectors directly below, just not certification.
      // Typing a different input is progress by the goal's own definition even when the page
      // shows the same empty state; only identical repeats (rule below) and true no-ops count.
      const newText = d.action.kind === 'fill' && d.text !== null && !history.slice(0, -1).some((h) => h.kind === 'fill' && h.text === d.text);
      unchanged = changed || d.action.kind === 'wait' || newText ? 0 : unchanged + 1;
      const last = history.slice(-4).map((h) => h.kind + h.action + (h.text ?? ''));
      if (last.length === 4 && new Set(last).size === 1) {
        loopReason = `stuck: repeated "${d.action.label.slice(0, 40)}" 4 times`;
        break;
      }
      if (unchanged >= 4) {
        loopReason = 'stuck: 4 actions with no page change';
        break;
      }
    }

    // End-of-run rescue Enter: narrow on purpose. Only for adversarial scenarios (where an
    // unsubmitted hostile input is a harness shortfall, not a product signal), only when the
    // trailing successful fill's text is literally one of this scenario's inputs (never a
    // form field Jev happened to leave populated), and only when the step budget ran out
    // within the last two executed steps (a rescue, not a general submit-everything rule).
    // Both this rule and the mid-loop one above press Enter in the focused field — see
    // README "Guards" for why adversarial scenarios must target non-mutating inputs.
    if (kind === 'adversarial') {
      const inputValues = new Set(Object.values(phaseInputs));
      // Reuses the outer `lastFill` directly (round 8) rather than re-deriving an equivalent
      // FillEvent from `submissionEvents` — the two are always in sync (both updated together,
      // in the same statement, the moment a fill succeeds) and the outer one also carries
      // `.node`, needed for the focus verification below.
      if (lastFill && inputValues.has(lastFill.text) && lastFill.step >= lastExecutedStep - 1) {
        // Decide by ACTUAL certification, not a "was there any event at or after this step"
        // heuristic — that heuristic suppressed the rescue on evidence that doesn't certify
        // (an inert click, an unrelated poll request), leaving a real hostile input unsubmitted.
        const eventsSoFar: SubmissionEvent[] = [
          ...thisPhase(submissionEvents),
          ...thisPhase(sink.requests).map(
            (r): SubmissionEvent => ({ kind: 'request', step: r.step, method: r.method, url: r.url, postData: r.postData, bodyOversized: r.bodyOversized, contentType: r.contentType }),
          ),
        ];
        // N6 (round 8): confirm focus is still actually in the field before pressing Enter.
        if (needsRescue(eventsSoFar, lastFill.text) && (await focusAndVerify(page, lastFill.node, lastFill.text, lastFill.frame))) {
          reportStep = lastFill.step;
          try {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(400);
            await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
          } catch {
            // Nothing to undo — no submission EVENT is recorded any more either way (round 8,
            // N4); the resulting REQUEST, if any, is what submittedInputs() reads.
          } finally {
            reportStep = lastExecutedStep;
          }
        }
      }
    }

    // Post-loop settle, in order: let debounced requests land, drain their bodies (bounded —
    // an unresolved read must not hang the whole run; anything still pending is carried
    // forward, not dropped), THEN run expect checks with the oracle still attached (a check
    // may itself navigate or request), let anything a check triggered settle too, and only
    // then detach — so nothing a check does can be missed, and nothing after detach can
    // sneak into an already-judged result.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    // The per-step crash check above only ever looks at the page BEFORE each decide() call, so
    // a crash rendered by the LAST scenario action (a click that lands on "Application error",
    // with no pageerror/5xx of its own) would otherwise slip through as a clean smoke PASS.
    // Check the settled final page too — and again after `expect` runs below (round 7, M4): a
    // `check` assertion can itself navigate to a crash page, which this first call obviously
    // cannot see yet (record() dedupes by kind+detail, so calling this twice is never double
    // counted if both calls land on the same, unchanged page).
    const checkFinalCrash = async () => {
      const finalObs = await observe(page!).catch(() => null);
      if (finalObs) {
        finalText = finalObs.text.slice(0, 1_500);
        const finalCrash = crashText.find((re) => re.test(finalObs.text));
        if (finalCrash) record(sink, finalObs.url, lastExecutedStep, 'crash-screen', finalCrash.source, { noise: config.noise, known: config.known });
      }
    };
    await checkFinalCrash();

    await drainPending(sink, 5, 3_000);

    let phaseFailed = false;
    if (phase.expect?.length) {
      const results = await evaluate(phase.expect, {
        // Round 7 (M4): read lazily, at the moment each assertion actually runs — a `check`
        // assertion earlier in the SAME list can navigate the page, and a `url`/`text` assertion
        // later in the list must see the page AS IT IS THEN, not a snapshot captured before any
        // check ran. `responses` doesn't need the same treatment: it's a live reference to
        // `sink.responses`, the same array a check's own triggered request still appends to.
        url: () => page!.url(),
        bodyText: () => page!.innerText('body').catch(() => ''),
        responses: sink.responses,
        fromStep: phaseFirstStep,
        isElementVisible: async (role, name) => page!.getByRole(role as Parameters<Page['getByRole']>[0], { name }).first().isVisible().catch(() => false),
        runCheck: async (name, args) => {
          const fn = config.checks?.[name];
          if (!fn) return { ok: false, detail: `no check named "${name}" in config.checks` };
          const result = await fn({ env, role: s.role, page: page!, request: ctx.request }, args);
          // A check can itself trigger own-origin requests (e.g. it clicks something that fires
          // a fetch); drain their bodies before evaluate() moves on, so a `response` assertion
          // later in the SAME expect list sees a body that finished reading, not a race.
          await drainPending(sink, 5, 3_000);
          return result;
        },
      });
      // A `check` assertion can navigate to a crash screen; catch it now, not just before.
      await checkFinalCrash();
      for (const r of results) allExpect.push(phaseLabel ? { ...r, phase: phaseLabel } : r);
      phaseFailed = results.some((r) => !r.ok);
    }
    if (phaseLabel && !jevDone) loopReason = `phase "${phase.name}": ${loopReason}`;
    // The next phase runs only on a clean hand-over: Jev DONE here, every expectation met.
    if (!jevDone || phaseFailed) break;
    }

    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    detach();

    // No new response can arrive once the listener is gone, so a single bounded round here is
    // complete (reuses the same bounded drain, maxRounds=1). If it times out, note how many
    // JSON bodies never finished reading instead of silently evaluating with a hole in the data.
    const settledAfterDetach = await drainPending(sink, 1, 3_000);
    if (!settledAfterDetach) {
      // Approximation: a response counts as "unread" if it was JSON and never got a body —
      // this also includes bodies dropped for being oversized (>256 KiB), which is an
      // acceptable conflation for a diagnostic note, not a verdict input.
      unreadBodies = sink.responses.filter((r) => r.contentType.includes('application/json') && r.body === undefined).length;
    }

    findings = [...sink.findings];
    responses = [...sink.responses];
    requests = [...sink.requests];
    const finalEvents: SubmissionEvent[] = [
      ...submissionEvents,
      ...requests.map(
        (r): SubmissionEvent => ({ kind: 'request', step: r.step, method: r.method, url: r.url, postData: r.postData, bodyOversized: r.bodyOversized, contentType: r.contentType }),
      ),
    ];
    submitted = submittedInputs(finalEvents);
    // N4/N5b (round 8): for any adversarial input that never got fully certified, note when
    // there's a more specific reason than "nothing happened at all" — a PARTIAL prefix match
    // first (checked first: it's the more actionable, and the more likely, of the two — real
    // apps truncate long inputs far more often than they send an uninspectable body), else a
    // PLAUSIBLE-but-unconfirmable request. The BLOCKED reason can then say so specifically.
    for (const [k, v] of Object.entries(allInputs)) {
      if (submitted.has(v)) continue;
      const partial = partialMatch(finalEvents, v);
      if (partial) {
        missingDetail[k] = mask(`partial match: ${partial.prefixLength} of ${v.length} characters (via ${partial.request.method} ${partial.request.url})`);
        continue;
      }
      const candidate = uninspectableRequest(finalEvents, v);
      if (candidate) missingDetail[k] = mask(`request ${candidate.method} ${candidate.url} body not inspectable`);
    }
  } catch (e) {
    error = (e as Error).message;
    findings = [...sink.findings];
  }
  if (allExpect.length) expectResults = allExpect;

  const cleanupErrors: string[] = [];
  for (const p of ctx.pages()) {
    await p
      .screenshot({ path: join(outDir, `${s.name.replace(/\W+/g, '_')}-run${run}-final.png`) })
      .catch((e) => cleanupErrors.push(`screenshot: ${(e as Error).message}`));
  }
  const { verdict, reason: verdictReason } = decideVerdict({
    kind, jevDone, loopReason, inputs: Object.keys(allInputs).length ? allInputs : undefined, submitted, findings, expectResults, error, missingDetail,
  });
  let reason = mask(verdictReason);
  const video = page?.video();
  await ctx.close().catch((e) => cleanupErrors.push(`ctx.close: ${(e as Error).message}`));
  let videoName: string | undefined;
  if (video) {
    try {
      const videoPath = await video.path();
      videoName = `${s.name.replace(/\W+/g, '_')}-run${run}.webm`;
      renameSync(videoPath, join(videosDir, videoName));
    } catch (e) {
      cleanupErrors.push(`video: ${(e as Error).message}`);
    }
  }
  // Cleanup failures never lose the run's actual verdict — they're appended for visibility instead
  // of thrown, so a screenshot/rename hiccup can't sink an otherwise-good result.
  if (cleanupErrors.length) reason += ` (cleanup: ${cleanupErrors.join('; ')})`;
  if (unreadBodies > 0) reason += ` (${unreadBodies} response bodies unread)`;

  const calls = trail.length;
  // Everything that leaves this function is a run OUTPUT (results.json, report.html, the
  // console line): a secret input's value — in any encoding — is masked out of all of it.
  const timeline = persistedTimeline(requests, responses);
  return {
    name: s.name, kind, run, verdict, reason, steps: calls,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    jevCalls: calls, jevMsAvg: calls ? Math.round(jevMs / calls) : 0, inputTokens: tokens,
    findings: findings.map((f) => ({ ...f, detail: mask(f.detail), url: mask(f.url) })),
    trail: trail.map((t) => (t.phase === undefined ? t : { ...t, phase: mask(t.phase) })),
    requests: timeline.requests.map((r) => ({ ...r, url: mask(r.url) })),
    responses: timeline.responses.map((r) => ({ ...r, url: mask(r.url) })),
    requestsOmitted: timeline.requestsOmitted,
    responsesOmitted: timeline.responsesOmitted,
    video: videoName && `videos/${videoName}`,
    finalText: finalText === undefined ? undefined : mask(finalText),
    intent: s.intent === undefined ? undefined : mask(s.intent),
    expectResults: expectResults?.map((r) => ({ ...r, assertion: maskDeep(r.assertion, mask) as ExpectResult['assertion'], expected: mask(r.expected), actual: mask(r.actual), phase: r.phase === undefined ? undefined : mask(r.phase) })),
    submitted: [...submitted].map(mask), runId: mask(runId),
  };
}

export type RunAllOptions = {
  config: Config;
  dir: string; // config file's directory, for the default runs/ location
  envName: string;
  scenarios: Scenario[];
  concurrency?: number;
  repeat?: number;
  outDir?: string;
  deps?: RunnerDeps; // test-only: inject a fake `decide`; production never sets this
};

export async function runAll(opts: RunAllOptions): Promise<Result[]> {
  const concurrency = opts.concurrency ?? 4;
  const repeat = opts.repeat ?? 1;
  const outDir = opts.outDir ?? join(opts.dir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(join(outDir, 'videos'), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const queue = opts.scenarios.flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ s, run: i + 1 })));
    const results: Result[] = [];
    console.log(`${queue.length} runs, concurrency ${concurrency} → ${outDir}`);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          let r: Result;
          try {
            r = await runOne(browser, opts.config, opts.envName, job.s, job.run, outDir, opts.deps);
          } catch (e) {
            // A worker-level exception (outside runOne's own try/catch, e.g. newContext()
            // itself failing) must not sink the whole Promise.all — record it and move on.
            r = emptyResult(job.s, job.s.kind ?? 'acceptance', job.run, 'ERROR', (e as Error).message.split('\n')[0]);
          }
          results.push(r);
          console.log(`${r.verdict.padEnd(7)} ${r.name} #${r.run} — ${r.reason} (${r.steps} steps, ${r.seconds}s, Jev ${r.jevMsAvg}ms)`);
        }
      }),
    );

    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    renderReport(results, outDir);

    const runsDir = join(opts.dir, 'runs');
    const latest = join(runsDir, 'latest');
    try {
      if (existsSync(latest)) unlinkSync(latest);
      symlinkSync(outDir, latest, 'dir');
    } catch {
      // Non-fatal: a stale/foreign "latest" path is not worth failing the run over.
    }

    console.log(`report: ${join(outDir, 'report.html')}`);
    return results;
  } finally {
    // Always release the browser, even if a bug above threw past the per-job guards.
    await browser.close().catch(() => {});
  }
}
