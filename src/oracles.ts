// Code-owned oracles: the runner watches a page for signs the app broke,
// independent of what Jev thinks it accomplished. Ported from the spike's
// `watch()`, generalised to config-supplied own-origin hosts and noise/known lists.
import type { ConsoleMessage, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';
import type { Known } from './config.ts';

export type Finding = { kind: string; detail: string; url: string; step: number };
export type ResponseRecord = { step: number; method: string; url: string; status: number; contentType: string; body?: string };
// Own-origin requests, independent of their eventual response — the causal
// evidence submission.ts needs (a request proves the browser sent the value;
// a response only proves something came back). Also useful for reports.
// `bodyOversized` (round 8, N4): true when the request DID have a body, but it exceeded the
// 64 KiB capture cap below — distinct from `postData === undefined` meaning "no body at all",
// so submission.ts can tell "plausible but uninspectable" apart from "no evidence whatsoever".
// `contentType` (round 9, O6): the request's own Content-Type header, verbatim (not lower-cased
// here — submission.ts's requestCarries() needs the ORIGINAL casing for a multipart boundary
// token, and lower-cases its own copy only for the decoder-selection keyword check).
export type RequestRecord = { step: number; method: string; url: string; postData?: string; bodyOversized?: boolean; contentType?: string };

// Findings are appended here as the page runs; responses/requests are
// recorded for every own-origin request so `response` expect-assertions and
// submission evidence can be evaluated after the run. `pending` collects
// response-body read promises the runner must await before evaluating
// assertions (bodies are read lazily/async).
export type Sink = { findings: Finding[]; responses: ResponseRecord[]; requests: RequestRecord[]; pending: Promise<unknown>[] };

export function newSink(): Sink {
  return { findings: [], responses: [], requests: [], pending: [] };
}

// Error text that means the app broke, whatever the agent was doing.
// A config's `crashText` is appended to this list, never replaces it.
export const DEFAULT_CRASH_TEXT = [/application error/i, /something went wrong/i, /internal server error/i, /unhandled runtime error/i, /this page could not be found/i];

// Third-party analytics/monitoring noise that is never our bug. App-specific
// endpoints (e.g. a Sentry tunnel proxied through the app's own domain)
// belong in a config's `noise`, not here.
export const DEFAULT_NOISE = /posthog|sentry|google-analytics|googletagmanager|intercom|hotjar|stripe\.com|cloudflareinsights|favicon/i;

// PURE: decide what a raw (kind, detail) pair becomes. null = drop as noise;
// otherwise the (possibly known:-tagged) kind to record.
export function classify(kind: string, detail: string, opts: { noise?: RegExp[]; known?: Known[] }): null | { kind: string; known?: string } {
  if (DEFAULT_NOISE.test(detail)) return null;
  if (opts.noise?.some((re) => re.test(detail))) return null;
  const known = opts.known?.find((k) => k.match.test(detail) && (!k.kind || k.kind.test(kind)));
  if (known) return { kind: `known:${known.id} ${kind}`, known: known.id };
  return { kind };
}

// Shared by watch()'s internal oracles and the runner's own crash-screen
// check, so every finding — whatever detects it — goes through the same
// noise/known classification and de-duplication.
export function record(sink: Sink, url: string, step: number, kind: string, detail: string, opts: { noise?: RegExp[]; known?: Known[] }): void {
  const result = classify(kind, detail, opts);
  if (!result) return;
  if (sink.findings.some((f) => f.kind === result.kind && f.detail === detail)) return;
  sink.findings.push({ kind: result.kind, detail: detail.slice(0, 400), url, step });
}

// Watches a page for the run's duration and returns a `detach()` that
// removes all four listeners — call it once the step loop and expect
// evaluation are both done, before treating `sink` as final, so a late
// event can't mutate an already-judged run (see runner.ts's post-loop
// quiescence sequence).
export function watch(page: Page, sink: Sink, step: () => number, opts: { ownOrigins: RegExp[]; noise?: RegExp[]; known?: Known[] }): () => void {
  const add = (kind: string, detail: string) => record(sink, page.url(), step(), kind, detail, opts);
  const isOwnOrigin = (url: string) => opts.ownOrigins.some((re) => re.test(new URL(url).host));
  // Own-origin 401/403 are correct authz answers; the app then logs
  // "[ERROR] Failed to fetch X" to the console. Tag such console errors as
  // known:authz when a 401/403 landed in the same step.
  const denied = new Set<number>();

  const onPageError = (e: Error) => add('pageerror', e.message);
  // "Failed to load resource: … status of NNN" carries no URL, so it cannot
  // be filtered for third-party noise; the response oracle below already
  // records own-origin failures with the URL.
  const onConsole = (m: ConsoleMessage) => {
    if (m.type() !== 'error' || /^Failed to load resource/.test(m.text())) return;
    add(denied.has(step()) && /fetch|permission|forbidden|unauthori/i.test(m.text()) ? 'known:authz console.error' : 'console.error', m.text());
  };
  const onRequest = (req: PlaywrightRequest) => {
    if (!isOwnOrigin(req.url())) return;
    const raw = req.postData();
    const bodyOversized = raw !== null && Buffer.byteLength(raw, 'utf8') > 64 * 1024;
    const postData = raw !== null && !bodyOversized ? raw : undefined;
    // req.headers() is synchronous (unlike allHeaders()/headerValue()) — reading it here adds no
    // await, so it can't shift this handler's ordering relative to step().
    const contentType = req.headers()['content-type'];
    sink.requests.push({ step: step(), method: req.method(), url: req.url(), postData, bodyOversized, contentType });
  };
  const onResponse = (r: PlaywrightResponse) => {
    const s = r.status();
    const own = isOwnOrigin(r.url());
    // 401/403 can be correct authz behaviour; any other own-origin 4xx is a broken link or route.
    if (own && (s === 401 || s === 403)) denied.add(step());
    if (s >= 500 || (own && s >= 400 && s !== 401 && s !== 403)) add(`http ${s}`, `${r.request().method()} ${r.url()}`);
    if (own) {
      const contentType = r.headers()['content-type'] ?? '';
      const responseRecord: ResponseRecord = { step: step(), method: r.request().method(), url: r.url(), status: s, contentType };
      sink.responses.push(responseRecord);
      if (contentType.includes('application/json')) {
        sink.pending.push(
          r
            .text()
            .then((text) => {
              if (Buffer.byteLength(text, 'utf8') <= 256 * 1024) responseRecord.body = text;
            })
            .catch(() => undefined),
        );
      }
    }
  };

  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('request', onRequest);
  page.on('response', onResponse);
  return () => {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('request', onRequest);
    page.off('response', onResponse);
  };
}

// Response bodies are read asynchronously and a read's own resolution can
// enqueue further reads; wait for `sink.pending` to stop growing before
// treating it as final. Bounded two ways: at most `maxRounds` rounds (a
// pathological page that keeps enqueueing more reads can't hang forever),
// and each round itself is capped at `roundTimeoutMs` (a single read that
// never resolves — e.g. a stalled connection — can't hang forever either).
// Unresolved promises are left in `sink.pending`; a later bounded wait (the
// runner's post-detach snapshot) gets another, final chance at them.
// Returns false the moment any round times out (some reads may still be
// pending), true once a round's reads all settle and none were added.
export async function drainPending(sink: Sink, maxRounds = 5, roundTimeoutMs = 3_000): Promise<boolean> {
  let last = -1;
  for (let round = 0; round < maxRounds && sink.pending.length !== last; round++) {
    last = sink.pending.length;
    const settled = await Promise.race([
      Promise.all(sink.pending).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), roundTimeoutMs)),
    ]);
    if (!settled) return false;
  }
  return true;
}
