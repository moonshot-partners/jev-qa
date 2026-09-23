// Pure: decide which of a scenario's typed input values actually reached
// the server, from the runner's raw event timeline.
//
// A fill whose act() call threw is never submitted — its text still shows
// up in the Jev history for context, but it never counts here.
//
// Evidence is CAUSAL, not merely temporal, and — round 8, N4 — STRONG-ONLY:
// a value counts as submitted only when an own-origin REQUEST, somewhere
// inside the fill's own window ([this fill's step, the next fill's step, or
// the end of the run)), demonstrably carries it.
//
// Round 9 (O5/O6): "carries it" is now a VALUE-only comparison, gated by the
// request's own content-type — never a whole-string search that could match
// inside a query KEY, a URL PATH segment, or a hostname:
//   - the URL's own query string — always checked, every request has one (or none)
//   - `application/x-www-form-urlencoded` body — form field VALUES (URLSearchParams)
//   - `application/json` body — JSON string LEAF values (recursive walk)
//   - `multipart/form-data` body — each part's own body content
//   - any other (or missing) content-type — a raw substring check, but ONLY for a
//     value >= 8 characters (too short otherwise to mean anything out of an
//     unstructured blob)
// A VALUE match itself (valueMatchesField(), narrowed round 10 Q1, narrowed further round 11
// R1/R2) requires the candidate value to be at least 2 characters and either equal the whole
// field value, or (>= 8 chars) the field value equals the value plus a SHORT (1-2 char)
// non-alphanumeric, non-path suffix — the app appended a wildcard or trailing whitespace, never a
// path/hostname continuation (`/dashboard` must never certify off `/dashboard/home` — the `/` that
// starts a real continuation is deliberately excluded from the allowed suffix characters, along
// with `.`). TRUNCATION (a field value that's a genuine but shorter PREFIX of a longer value) never
// certifies here at all any more (round 11, R2) — it is exclusively partialMatch()'s
// annotation-only territory below, whatever fraction of the value it covers: a field carrying an
// unrelated, coincidentally-matching PREFIX of a long adversarial value is not proof the value
// itself ever reached the server. Never a coincidental MID-STRING substring in any direction: a
// 1-character input like "1" must never certify off an unrelated `?page=1`, a JSON KEY named
// "admin" must never certify an input "admin" whose actual field VALUE is `false`, and an input
// like "dashboard-widget" must never certify off an unrelated `returnTo=/dashboard-widget/status`
// path that merely CONTAINS it without anchoring to either end.
//
// The previous WEAK tier (any own-origin request at the same step as a
// submit/click, even one that plainly didn't carry the value) is gone
// entirely: it let an UNRELATED poll or heartbeat request certify an
// adversarial input that never actually reached the server, just because
// something else happened to fire in the same step. A bare page change was
// already never certification (round 7, M3) — page change remains real
// PROGRESS evidence for the runner's own stuck-loop detectors, just never
// evidence of reaching the server.
export type FillEvent = { kind: 'fill'; text: string; ok: boolean; step: number };
// `bodyOversized` (round 8, N4): true when a request DID have a body, but it
// was too large for the oracle to capture (see oracles.ts) — a request like
// this is a PLAUSIBLE vehicle for the value that requestCarries() can never
// confirm or deny; see uninspectableRequest(). `contentType` (round 9, O6):
// the request's own Content-Type header, lower-cased by the oracle — decides
// WHICH decoder requestCarries() trusts for this body; undefined means the
// header was absent (falls back to the raw-substring, long-values-only path).
export type RequestEvent = {
  kind: 'request';
  step: number;
  method: string;
  url: string;
  postData?: string;
  bodyOversized?: boolean;
  contentType?: string;
};
export type SubmissionEvent = FillEvent | RequestEvent;

// Tolerant of malformed percent-escapes (decodeURIComponent throws on those) — falls back to the raw string.
function decodeLoose(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// What an ensure_ascii-style JSON encoder (PHP json_encode, Python json.dumps
// with the default, many others) produces for `value`: every character above
// 0x7E becomes \uXXXX, astral characters (emoji, etc.) as a surrogate pair —
// matching JSON.stringify's escaping of quotes/backslashes/control chars.
// Exported (round 7, M2) so jev.ts's redactionForms() can reuse the exact
// same encoding instead of maintaining a second copy of this logic.
export function jsonAsciiEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code <= 0x7e) out += ch;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else {
      // Astral character: encode as the UTF-16 surrogate pair, each escaped.
      const c = code - 0x10000;
      const high = 0xd800 + (c >> 10);
      const low = 0xdc00 + (c & 0x3ff);
      out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

// A "the app appended something" suffix, never a path/hostname continuation: 1-2 characters,
// none of them alphanumeric, `/`, or `.` — `*`/`%`/whitespace qualify, `/home` or `.json` never do.
const SHORT_NON_PATH_SUFFIX = /^[^A-Za-z0-9/.]{1,2}$/;

// Round 9 (O5); narrowed round 10 (Q1); narrowed further round 11 (R1/R2): a candidate scenario
// input value never certifies off a coincidental MID-STRING substring, nor off a coincidental
// PREFIX match, nor off an over-eager "starts with" that happens to land on a real path boundary —
// the old "anywhere in the field" rule let an UNRELATED field certify a value that just happened to
// appear inside it (an input `"dashboard-widget"` certified by an unrelated
// `returnTo=/dashboard-widget/status` path); round 10's own "field starts with value" rule then let
// an UNRELATED path certify a value that was merely its own prefix (`"/dashboard"` certified by an
// unrelated `returnTo=/dashboard/home`). A match is now anchored to exactly one real shape: the
// field value EQUALS the value plus a SHORT (1-2 char), non-alphanumeric, non-path suffix (>= 8
// char value) — the app appended a wildcard or trailing whitespace, e.g. `q=hostile-value*` —
// never a `/` or `.` continuation, which is what a real path/filename extension looks like, not an
// echo of the value alone. TRUNCATION (the field value is a genuine but SHORTER prefix of the
// value) never certifies here at all (round 11, R2) — see partialMatch() below, which finds it
// independently and reports it ONLY as an annotation-only BLOCKED note, regardless of how much of
// the value it covers: a coincidentally-matching prefix in an unrelated field is not proof the
// value itself ever reached the server. Also still requires >= 2 characters for an exact match — a
// 1-character value like "1" must never certify off an unrelated `?page=1`.
function valueMatchesField(value: string, fieldValue: string): boolean {
  if (value.length < 2) return false;
  if (fieldValue === value) return true;
  if (value.length < 8 || !fieldValue.startsWith(value)) return false;
  return SHORT_NON_PATH_SUFFIX.test(fieldValue.slice(value.length));
}

function anyFieldMatches(fieldValues: string[], value: string): boolean {
  return fieldValues.some((fv) => valueMatchesField(value, fv));
}

// Recursively walks a parsed JSON value, collecting every string LEAF — never a key. JSON.parse()
// itself already decodes every encoder's \uXXXX/surrogate-pair escaping, so no separate
// escaped-string pattern match is needed once we get this far. Shared by jsonLeavesMatch() and
// (round 10, Q1) partialMatch()'s own structuredFieldValues(), which needs the LEAVES themselves,
// not just a match verdict.
function jsonLeaves(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(jsonLeaves);
  if (node && typeof node === 'object') return Object.values(node).flatMap(jsonLeaves);
  return [];
}

function jsonLeavesMatch(node: unknown, value: string): boolean {
  if (typeof node === 'string') return valueMatchesField(value, node);
  if (Array.isArray(node)) return node.some((n) => jsonLeavesMatch(n, value));
  if (node && typeof node === 'object') return Object.values(node).some((n) => jsonLeavesMatch(n, value));
  return false;
}

// Round 8 (N5): decodeURIComponent leaves a literal '+' as '+', never a space — but a real
// application/x-www-form-urlencoded query string or POST body (what a native <form> submission
// produces) encodes a space AS '+'. Parsing as form data is the only way to decode that
// correctly; harmless (and simply finds nothing) when `raw` isn't actually form-encoded at all —
// URLSearchParams never throws, it just parses best-effort.
function formDecodedValues(raw: string): string[] {
  return [...new URLSearchParams(raw).values()];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Round 9 (O5); anchored round 10 (Q2); end-anchored round 11 (R3): a MINIMAL multipart/form-data
// parser — just enough to pull out each part's own body content (never its `name=` or `filename=`
// — those are effectively keys/paths, not values). `boundary` comes from the declared Content-Type
// header; a body that doesn't actually use it, or has no boundary at all, yields no parts (never
// throws). A delimiter only counts at the very START of the body or right after a CRLF
// (`\r\n--boundary`), matching the real multipart spec — a naive `raw.split('--boundary')` (round
// 9) split on EVERY occurrence, including one sitting INSIDE a part's own value (e.g. a value
// containing the literal text "--<boundary>" mid-line), corrupting that part's content around a
// delimiter that was never real. It must ALSO be immediately followed by CRLF (a real part
// separator) or `--` (the closing delimiter) or the end of the body (round 11, R3) — without this,
// a boundary token that's a PREFIX of some longer line-starting token (e.g. boundary `abc123`
// against a line starting `--abc123X`) would still match: `\r\n--abc123X` is genuine CONTENT for
// boundary `abc123`, not a delimiter, because nothing real ever follows a boundary except a
// separator, the closing marker, or end of input.
function multipartPartBodies(contentType: string, raw: string): string[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m ? (m[1] ?? m[2]).trim() : undefined;
  if (!boundary) return [];
  // Round 12: a closing delimiter is `--boundary--` followed by CRLF or the end of the body — a
  // `--boundary--X…` continuation is part content, exactly like `--boundaryX…` (round 11, R3).
  const delimiter = new RegExp(`(?:^|\\r\\n)--${escapeRegExp(boundary)}(?=\\r\\n|--(?:\\r\\n|$)|$)`, 'g');
  const starts: number[] = [];
  for (const dm of raw.matchAll(delimiter)) {
    starts.push(dm.index! + (dm[0].startsWith('\r\n') ? 2 : 0)); // point at the "--boundary" itself, past any leading CRLF
  }
  const parts: string[] = [];
  for (let i = 0; i < starts.length - 1; i++) parts.push(raw.slice(starts[i], starts[i + 1])); // last start is the closing "--boundary--"
  return parts
    .map((p) => {
      const sep = p.indexOf('\r\n\r\n');
      return sep === -1 ? '' : p.slice(sep + 4).replace(/\r\n$/, '');
    })
    .filter(Boolean);
}

const STRUCTURED_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'application/json', 'multipart/form-data'];

// Round 9 (O6); extracted round 10 (Q1): the STRUCTURED field values a request's URL/body decode
// to, gated by content-type — the query string is always checked (every request has one, or
// none); the body is decoded by whichever of the three structured formats the declared
// Content-Type selects. Shared by requestCarries() below and by partialMatch()'s own
// truncation search, which needs the LEAVES themselves (to compare directly against the REAL
// value's own prefix) rather than reusing requestCarries() with a SYNTHETIC, shortened probe —
// that let valueMatchesField()'s truncation rule fire on a probe-vs-field-value pair that was
// never the actual typed value (a repeated-character adversarial string could inflate a
// `partialMatch()` result to a prefix length longer than any request actually carried).
// Deliberately excludes the raw/unknown-content-type fallback below — an unstructured blob has no
// real field boundary to reason about a "prefix" against.
function structuredFieldValues(req: RequestEvent): string[] {
  const values: string[] = [];
  try {
    values.push(...formDecodedValues(new URL(req.url).search.slice(1)));
  } catch {
    // not a parseable absolute URL — nothing else to check for the URL itself
  }
  if (req.postData === undefined) return values;
  // The boundary is a token from the ORIGINAL header — it's case-sensitive and appears verbatim
  // in the body's own `--boundary` markers, so only the KEYWORD check below may lower-case it.
  const rawContentType = req.contentType ?? '';
  const contentType = rawContentType.toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    values.push(...formDecodedValues(req.postData));
  } else if (contentType.includes('application/json')) {
    try {
      values.push(...jsonLeaves(JSON.parse(req.postData)));
    } catch {
      // declared JSON, didn't parse — uninspectableRequest() is where this belongs
    }
  } else if (contentType.includes('multipart/form-data')) {
    values.push(...multipartPartBodies(rawContentType, req.postData));
  }
  return values;
}

// Round 9 (O6): decoding is GATED by the request's own declared content-type — running every
// decoder unconditionally on every body (what round 8 did) let the WRONG decoder's own incidental
// structure produce a false match (e.g. a JSON body's `{"admin":false}` looking, to a naive
// substring scan, like it "carries" the string "admin" — that's the KEY, never the value). An
// UNKNOWN/absent content-type falls back to a raw substring check, but only for a value long
// enough (>= 8) that a coincidental match is implausible, and only when the body ISN'T one of the
// three structured formats — a structured body that parsed/decoded cleanly and genuinely doesn't
// carry the value is a confident miss, never a fallback opportunity.
function requestCarries(req: RequestEvent, value: string): boolean {
  if (anyFieldMatches(structuredFieldValues(req), value)) return true;
  if (req.postData === undefined) return false;
  const contentType = (req.contentType ?? '').toLowerCase();
  if (STRUCTURED_CONTENT_TYPES.some((ct) => contentType.includes(ct))) return false;
  return value.length >= 8 && (req.postData.includes(value) || decodeLoose(req.postData).includes(value));
}

// Shared by submittedInputs() and uninspectableRequest(): the step range a fill's own evidence
// may fall in — up to (but not including) the NEXT fill's step, or the end of the run.
function windowEnd(fillSteps: number[], step: number): number {
  return fillSteps.find((s) => s > step) ?? Infinity;
}

export function submittedInputs(events: SubmissionEvent[]): Set<string> {
  const fills = events.filter((e): e is FillEvent => e.kind === 'fill' && e.ok);
  const requests = events.filter((e): e is RequestEvent => e.kind === 'request');
  const fillSteps = [...new Set(fills.map((f) => f.step))].sort((a, b) => a - b);

  const submitted = new Set<string>();
  for (const fill of fills) {
    const end = windowEnd(fillSteps, fill.step);
    const inWindow = (step: number) => step >= fill.step && step < end;
    if (requests.some((r) => inWindow(r.step) && requestCarries(r, fill.text))) submitted.add(fill.text);
  }
  return submitted;
}

// PURE (round 8, N4; refined round 9, O8): for a value that never got STRONG evidence, was
// there at least an in-window own-origin request that's a PLAUSIBLE vehicle we simply couldn't
// fully inspect — as opposed to one we DID inspect and confirmed genuinely doesn't carry it?
// "Uninspectable" means real uncertainty, gated the SAME way requestCarries() decodes:
//   - captured but too large (`bodyOversized`) — ALWAYS uninspectable, whatever the content-type
//   - `application/json` that failed to JSON.parse — declared JSON we couldn't actually read
//   - `multipart/form-data` with no parts found at all (no boundary, or it didn't match)
//   - unknown/absent content-type, but the value was too SHORT (< 8 chars) to even attempt the
//     raw-substring fallback — we never actually checked, not "checked and it wasn't there"
// A `application/x-www-form-urlencoded` body (URLSearchParams never fails to parse) or a
// cleanly-parsed JSON body that just doesn't contain the value is a genuine, confident miss —
// never "uninspectable" — and neither is an unknown-content-type body where the value WAS long
// enough for the raw-substring check to actually run.
export function uninspectableRequest(events: SubmissionEvent[], value: string): RequestEvent | undefined {
  const fills = events.filter((e): e is FillEvent => e.kind === 'fill' && e.ok && e.text === value);
  const requests = events.filter((e): e is RequestEvent => e.kind === 'request');
  const fillSteps = [...new Set(events.filter((e): e is FillEvent => e.kind === 'fill' && e.ok).map((f) => f.step))].sort((a, b) => a - b);
  for (const fill of fills) {
    const end = windowEnd(fillSteps, fill.step);
    const inWindow = (step: number) => step >= fill.step && step < end;
    const candidate = requests.find((r) => {
      if (!inWindow(r.step) || requestCarries(r, value)) return false; // in window, but already STRONG
      if (r.bodyOversized) return true;
      if (r.postData === undefined) return false; // no body at all — genuinely no evidence, not "uninspectable"
      const rawContentType = r.contentType ?? '';
      const contentType = rawContentType.toLowerCase();
      if (contentType.includes('application/json')) {
        try {
          JSON.parse(r.postData);
          return false; // parsed cleanly, genuinely doesn't carry it
        } catch {
          return true; // declared JSON, couldn't actually parse it
        }
      }
      if (contentType.includes('multipart/form-data')) {
        return multipartPartBodies(rawContentType, r.postData).length === 0; // couldn't even find parts
      }
      if (contentType.includes('application/x-www-form-urlencoded')) return false; // always "parses"; a clean miss is a genuine miss
      return value.length < 8; // unknown content-type: uninspectable only if too short to have tried at all
    });
    if (candidate) return candidate;
  }
  return undefined;
}

// PURE (round 8 addendum, N5b): for a value that never got FULL strong evidence, was there an
// in-window request carrying a long-enough PREFIX of it (>= 8 characters, same threshold as
// jev.ts's redaction prefix rule)? Real apps truncate long inputs before echoing/logging/
// searching them — a 300-character adversarial value is realistically never echoed whole — so a
// request carrying the first 120 of 300 characters is real, actionable evidence the value DID
// reach the app, just not the entire literal string. Longest prefix first, across every
// in-window request, so the result reports the BEST partial match actually found. Never
// consulted for an already-fully-certified value — the caller only checks this for values
// missing from submittedInputs(). Round 10 (Q1) briefly let a HIGH-coverage truncation (>= 75% of
// the value's own length) certify outright via valueMatchesField() — round 11 (R2) reverted that:
// an unrelated field carrying an unrelated but coincidentally-prefix-matching value is not proof
// the real value reached the server, whatever fraction it happens to cover. TRUNCATION now ALWAYS
// stays here, annotation-only, regardless of coverage — this function is the only place it's ever
// reported at all.
export function partialMatch(events: SubmissionEvent[], value: string): { prefixLength: number; request: RequestEvent } | undefined {
  if (value.length < 8) return undefined;
  const fills = events.filter((e): e is FillEvent => e.kind === 'fill' && e.ok && e.text === value);
  const requests = events.filter((e): e is RequestEvent => e.kind === 'request');
  const fillSteps = [...new Set(events.filter((e): e is FillEvent => e.kind === 'fill' && e.ok).map((f) => f.step))].sort((a, b) => a - b);
  let best: { prefixLength: number; request: RequestEvent } | undefined;
  for (const fill of fills) {
    const end = windowEnd(fillSteps, fill.step);
    const inWindow = (step: number) => step >= fill.step && step < end;
    for (const request of requests) {
      if (!inWindow(request.step)) continue;
      // A candidate field value counts as a partial match only when it's a genuine (strictly
      // shorter) prefix of `value` itself — checked directly against the REAL value, never via a
      // synthetic shortened probe re-run through requestCarries() (round 8's original design):
      // that let valueMatchesField()'s truncation rule fire on a probe-vs-field-value pair that
      // was never the actual typed value.
      for (const fv of structuredFieldValues(request)) {
        if (fv.length >= 8 && fv.length < value.length && value.startsWith(fv) && (!best || fv.length > best.prefixLength)) {
          best = { prefixLength: fv.length, request };
        }
      }
    }
  }
  return best;
}

// PURE: does `value` still need the end-of-run rescue attempt? True iff it
// is NOT already certified by submittedInputs() over the events collected
// so far — replaces a cruder "was there any event at or after this step"
// heuristic, which rescued too little (an inert click or an unrelated
// request "counted" as already-signalled and suppressed a rescue the value
// actually needed) as well as too much.
export function needsRescue(events: SubmissionEvent[], value: string): boolean {
  return !submittedInputs(events).has(value);
}
