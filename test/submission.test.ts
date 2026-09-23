import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsRescue, partialMatch, submittedInputs, uninspectableRequest } from '../src/submission.ts';
import type { SubmissionEvent } from '../src/submission.ts';

test('a failed fill never counts, even with a request in its window', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'emoji', ok: false, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=emoji' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('a successful fill with no signal at all does not count', () => {
  const events: SubmissionEvent[] = [{ kind: 'fill', text: 'emoji', ok: true, step: 1 }];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('STRONG: a request whose URL-encoded form carries the value certifies', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: "' OR 1=1", ok: true, step: 1 },
    { kind: 'request', step: 2, method: 'GET', url: `https://example.com/search?q=${encodeURIComponent("' OR 1=1")}` },
  ];
  assert.deepEqual(submittedInputs(events), new Set(["' OR 1=1"]));
});

test('STRONG: a request whose form-urlencoded postData carries the raw value certifies', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    {
      kind: 'request',
      step: 2,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: 'q=hostile&page=1',
      contentType: 'application/x-www-form-urlencoded',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile']));
});

test('STRONG: a request whose JSON postData carries the value as a leaf certifies (round 9: needs contentType)', () => {
  const value = 'a "quoted" \\value\\';
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    {
      kind: 'request',
      step: 2,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ q: value }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

// --- round 8 (N4): the WEAK tier is gone — an unrelated request never certifies -------------

test('round 8 (N4): an unrelated request at the SAME step as an Enter/click never certifies — the weak tier is gone entirely', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    // Under the old WEAK rule, ANY own-origin request at this step (even one that plainly
    // doesn't carry the value) used to certify — a real bug: an unrelated poll/heartbeat could
    // wrongly certify an adversarial input that never actually reached the server.
    { kind: 'request', step: 2, method: 'GET', url: 'https://example.com/api/unrelated-heartbeat' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('round 8 (N4): an unrelated request in-window but at a LATER step never certifies either', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 3, method: 'GET', url: 'https://example.com/api/unrelated-later' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('an unrelated own-origin request at a later step (outside the window, no value) must NOT certify', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'first', ok: true, step: 1 },
    { kind: 'fill', text: 'second', ok: true, step: 3 },
    // Outside "first"'s window ([1,3)) and does not carry "second" either.
    { kind: 'request', step: 5, method: 'GET', url: 'https://example.com/api/unrelated-poll' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('a request that DOES carry the value, but happens after the NEXT fill, does not certify the earlier one', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'first', ok: true, step: 1 },
    { kind: 'fill', text: 'second', ok: true, step: 3 },
    { kind: 'request', step: 5, method: 'GET', url: 'https://example.com/search?q=first' }, // step 5 is outside [1,3)
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('failed press produces no evidence, so it behaves exactly like "Enter never happened"', () => {
  // The runner records no submission EVENT for a rejected Enter press any more (round 8) — only
  // the resulting REQUEST, if any, ever mattered. A pure fill with nothing else in its window
  // must not certify.
  const events: SubmissionEvent[] = [{ kind: 'fill', text: 'hostile', ok: true, step: 1 }];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('multiple values: only the ones with real evidence end up submitted', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'sql', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=sql' },
    { kind: 'fill', text: 'emoji', ok: false, step: 2 },
    { kind: 'fill', text: 'unicode', ok: true, step: 3 },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['sql']));
});

test('a retried fill: the first attempt fails, a later attempt with the same text succeeds and signals', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'emoji', ok: false, step: 1 },
    { kind: 'fill', text: 'emoji', ok: true, step: 2 },
    { kind: 'request', step: 2, method: 'GET', url: 'https://example.com/search?q=emoji' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['emoji']));
});

test('a malformed percent-escape in a request URL does not throw (decodeLoose falls back to raw)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'plain', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=%E0%A4%A' }, // truncated escape
  ];
  assert.doesNotThrow(() => submittedInputs(events));
  assert.deepEqual(submittedInputs(events), new Set());
});

// --- round 8 (N5): application/x-www-form-urlencoded decoding ('+' means space) --------------

test('N5: a form-encoded POST body ("q=a+b") certifies "a b" — decodeURIComponent alone leaves the + literal', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'a b', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: 'q=a+b',
      contentType: 'application/x-www-form-urlencoded',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['a b']));
});

test('N5: a form-encoded URL query ("?q=a+b") certifies "a b" the same way', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'a b', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=a+b' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['a b']));
});

test('N5/O5 (round 11, R1): a form-decoded value certifies when the field value equals it plus a SHORT non-path suffix — never a mid-string substring', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostility', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: `q=${encodeURIComponent('hostility*')}&page=1`,
      contentType: 'application/x-www-form-urlencoded',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostility']));
});

test('round 11 (R1): a LONG suffix after the value does not certify (only 1-2 chars qualify)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostility', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: 'q=hostility-detected&page=1',
      contentType: 'application/x-www-form-urlencoded',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('round 10 (Q1): a form-decoded value MID-STRING inside an unrelated field value does NOT certify', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostility', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: 'q=a+very+hostility+term&page=1',
      contentType: 'application/x-www-form-urlencoded',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

// Round 8 addendum: the EXACT real-world URLs from the adversarial re-run on round 7
// (33-run suite, `tests/adversarial/runs/w6d-adv/results.json`) that first surfaced the N5 gap —
// `+` for space was left literal, so these BLOCKED with the request sitting right there in the
// fill's own window.
test('N5 (addendum): the exact real "sales" search URL certifies the SQL injection value', () => {
  const value = "' OR 1=1; -- \"";
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/sales?limit=20&offset=0&searchQuery=%27+OR+1%3D1%3B+--+%22' },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

test('N5 (addendum): the exact real "media browse" search URL certifies the SQL injection value', () => {
  const value = "' OR 1=1; -- \"";
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/media/browse?limit=50&searchTerm=%27+OR+1%3D1%3B+--+%22' },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

test('N5 (addendum): an XSS payload survives real application/x-www-form-urlencoded encoding', () => {
  const value = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  // The canonical way to produce a real x-www-form-urlencoded string in JS — guaranteed to
  // decode back correctly via the SAME URLSearchParams implementation requestCarries() uses.
  const encoded = new URLSearchParams({ q: value }).toString();
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/api/media/browse?limit=50&${encoded}` },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

// --- round 8 addendum (N5b): partialMatch — a truncated-but-real prefix in the window --------

test('N5b: a request carrying a >= 8-char prefix of a long value is a partial match', () => {
  const value = 'x'.repeat(300);
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/search?q=${value.slice(0, 120)}` },
  ];
  const match = partialMatch(events, value);
  assert.ok(match, 'expected a partial match');
  assert.equal(match!.prefixLength, 120);
  assert.equal(match!.request.method, 'GET');
  assert.equal(submittedInputs(events).has(value), false, 'a partial match is NOT full certification');
});

test('N5b: reports the LONGEST prefix actually found, across multiple candidate requests', () => {
  const value = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/search?q=${value.slice(0, 10)}` },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/log?msg=${value.slice(0, 20)}` },
  ];
  const match = partialMatch(events, value);
  assert.equal(match!.prefixLength, 20, 'expected the longer of the two prefixes actually present');
});

test('N5b: a value under 8 characters is never partial-matched — too short to mean anything', () => {
  const value = 'abcdefg'; // 7 chars
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=abc' }, // a 3-char prefix IS present
  ];
  assert.equal(partialMatch(events, value), undefined);
});

test('N5b: no candidate at all when nothing in the window carries even a prefix', () => {
  const value = 'x'.repeat(50);
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/unrelated' },
  ];
  assert.equal(partialMatch(events, value), undefined);
});

// --- round 8 (N4): uninspectableRequest — a plausible-but-unconfirmable request -------------

test('uninspectableRequest: an oversized-body request in the window is a candidate', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'POST', url: 'https://example.com/api/search', bodyOversized: true },
  ];
  const candidate = uninspectableRequest(events, 'hostile');
  assert.ok(candidate, 'expected a candidate request');
  assert.equal(candidate!.method, 'POST');
  assert.equal(submittedInputs(events).has('hostile'), false, 'still NOT certified — a candidate is not proof');
});

test('uninspectableRequest: a present, non-JSON, non-matching body is a candidate', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'POST', url: 'https://example.com/api/search', postData: '\x00\x01binary-ish-not-json-not-matching' },
  ];
  const candidate = uninspectableRequest(events, 'hostile');
  assert.ok(candidate, 'expected a candidate request');
});

test('uninspectableRequest: a request that already STRONGLY certifies is never also "uninspectable"', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=hostile' },
  ];
  assert.equal(uninspectableRequest(events, 'hostile'), undefined);
});

test('uninspectableRequest: a request with NO body at all is genuinely no evidence, not "uninspectable"', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/unrelated' }, // no postData, no bodyOversized
  ];
  assert.equal(uninspectableRequest(events, 'hostile'), undefined);
});

test('uninspectableRequest: a body that parses as JSON and genuinely doesn\'t carry the value is not a candidate', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ q: 'benign' }),
      contentType: 'application/json',
    },
  ];
  assert.equal(uninspectableRequest(events, 'hostile'), undefined);
});

test('uninspectableRequest: none when the value was never even filled', () => {
  assert.equal(uninspectableRequest([], 'hostile'), undefined);
});

// --- H2: unicode / JSON-escaped evidence -----------------------------------

test('JSON body: a literal (unescaped) non-ASCII value certifies via the JSON leaf exact match (round 9: needs contentType; single-char values are below the 2-char floor)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'café', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: '{"q":"café"}',
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['café']));
});

test('JSON body: an emoji escaped as a UTF-16 surrogate pair (\\uXXXX\\uXXXX) certifies', () => {
  const emoji = '🌸';
  assert.equal(emoji.length, 2); // sanity: this IS a surrogate pair in JS's UTF-16 strings, clears the 2-char floor
  const cp = emoji.codePointAt(0)! - 0x10000;
  const high = (0xd800 + (cp >> 10)).toString(16).padStart(4, '0');
  const low = (0xdc00 + (cp & 0x3ff)).toString(16).padStart(4, '0');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: emoji, ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: `{"q":"\\u${high}\\u${low}"}`,
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set([emoji]));
});

test('JSON body: a value nested inside an object certifies via the recursive leaf walk', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ filters: { q: 'hostile' } }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile']));
});

test('JSON body (round 11, R1): a value certifies when the leaf equals it plus a SHORT non-path suffix — never a mid-string substring', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ q: 'malicious*' }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['malicious']));
});

test('JSON body (round 10, Q1): a value MID-STRING inside a longer leaf does NOT certify', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ q: 'a very malicious search term' }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('JSON body: an unrelated value does NOT certify (the recursive walk is not a rubber stamp)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: JSON.stringify({ filters: { q: 'benign' } }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('round 9 (O6): a malformed but declared-JSON postData does not throw, does NOT fall back to a raw substring match, and shows up as uninspectable instead', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/search',
      postData: '{"q":"hostile"', // truncated, invalid JSON
      contentType: 'application/json',
    },
  ];
  assert.doesNotThrow(() => submittedInputs(events));
  // Declared JSON that fails to parse is never trusted for a raw fallback (O6) — it's a genuine
  // "couldn't inspect it", surfaced via uninspectableRequest() (O8), not a silent certification.
  assert.deepEqual(submittedInputs(events), new Set());
  const candidate = uninspectableRequest(events, 'hostile');
  assert.ok(candidate, 'expected the malformed-JSON request to be an uninspectable candidate');
});

test('round 9 (O6): an UNKNOWN content-type falls back to a raw substring check only for values >= 8 chars', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'POST', url: 'https://example.com/api/search', postData: 'blob-with-malicious-inside' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['malicious']));
});

test('round 9 (O6): an UNKNOWN content-type never raw-substring-certifies a value under 8 chars', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'POST', url: 'https://example.com/api/search', postData: 'blob-with-hostile-inside' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

// --- round 9 (O5): the four literal value-match cases from the review packet ------------------

test('O5: "1" is never certified by "?page=1" — an exact match under the 2-char floor does not count', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: '1', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?page=1' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('O5: "hostile-value" is certified by "q=hostile-value" — a whole-field exact match', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile-value']));
});

test('O5: "admin" is never certified by a JSON body where "admin" is only a KEY, not a value', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'admin', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/settings',
      postData: JSON.stringify({ admin: false }),
      contentType: 'application/json',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('O5: "a b" is certified by "q=a+b" — a short exact match still counts once it clears the 2-char floor', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'a b', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=a+b' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['a b']));
});

// --- round 9 (O6): content-type gating — a JSON body's own incidental structure is never trusted
// under a decoder it wasn't declared for ---------------------------------------------------------

test('O6: a JSON body carrying "a b" inside an unrelated field does NOT certify when the fill was a benign decoy — cross-content-type sanity', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'a b', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/settings',
      postData: JSON.stringify({ meta: 'x=a+b', q: 'benign' }),
      contentType: 'application/json',
    },
  ];
  // "a b" is not a leaf value anywhere in this JSON body ("x=a+b" is itself a leaf STRING, and
  // "a b" is not equal to nor an >=8-char substring of it) — must not certify.
  assert.deepEqual(submittedInputs(events), new Set());
});

test('O6: multipart/form-data — a value in a part BODY certifies (round 11, R1: value plus a short non-path suffix)', () => {
  const boundary = '----jevBoundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="q"',
    '',
    'malicious*',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['malicious']));
});

test('round 10 (Q1): multipart/form-data — a value MID-STRING inside a longer part body does NOT certify', () => {
  const boundary = '----jevBoundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="q"',
    '',
    'a very malicious search term',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('O6: multipart/form-data — a value only in a part NAME (never a body) does not certify', () => {
  const boundary = '----jevBoundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="malicious"',
    '',
    'benign',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('O8: multipart/form-data with no boundary at all is uninspectable, not a confident miss', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: 'not-really-multipart-body',
      contentType: 'multipart/form-data',
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
  assert.ok(uninspectableRequest(events, 'malicious'), 'no boundary means we never actually got to look');
});

// --- round 10 (Q1): the exact reported bug + its four literal cases ---------------------------

test('Q1: an unrelated field that merely CONTAINS the value does not certify it (the reported bug)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'dashboard-widget', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/poll?returnTo=%2Fdashboard-widget%2Fstatus' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('Q1: a trailing wildcard/suffix after the value still certifies (field value STARTS WITH the value)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value%2A' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile-value']));
});

test('round 11 (R2): a truncated echo covering >= 75% of a long value is STILL annotation-only, never certifies (240 of 300 chars)', () => {
  const value = 'x'.repeat(300);
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/search?q=${value.slice(0, 240)}` },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
  const match = partialMatch(events, value);
  assert.ok(match, 'expected a partial match annotation');
  assert.equal(match!.prefixLength, 240);
});

test('round 11 (R2): a truncated echo covering < 75% of a long value stays annotation-only too (20 of 300 chars)', () => {
  const value = 'x'.repeat(300);
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/search?q=${value.slice(0, 20)}` },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
  const match = partialMatch(events, value);
  assert.ok(match, 'expected a partial match annotation');
  assert.equal(match!.prefixLength, 20);
});

// --- round 11 (R1): the exact reported over-eager starts-with case + its literal cases ---------

test('R1: `/dashboard` is not certified by an unrelated `returnTo=/dashboard/home` (a path continuation, never a suffix)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: '/dashboard', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/poll?returnTo=%2Fdashboard%2Fhome' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('R1: a trailing `*` after the value still certifies', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value*' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile-value']));
});

test('R1: two trailing whitespace characters after the value still certify', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value%20%20' },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['hostile-value']));
});

test('R1: a `/x` suffix (a path continuation, 2 chars) does not certify, even though it is short enough', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value%2Fx' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('R1: a `.x` suffix (a filename extension, 2 chars) does not certify either', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/api/search?q=hostile-value.x' },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

test('R1: a 3-character all-symbol suffix does not certify (the suffix is capped at 2)', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'hostile-value', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: `https://example.com/api/search?q=${encodeURIComponent('hostile-value***')}` },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
});

// --- round 10 (Q2): multipart boundary anchored to a line start, not anywhere ------------------

test('Q2: a part value containing the literal text "--<boundary>" inline does not corrupt parsing', () => {
  const boundary = 'myboundary123';
  // The value ITSELF contains "--<boundary>" mid-string, not anchored to a line start — exactly
  // the case a naive `raw.split('--boundary')` gets wrong.
  const value = 'token--myboundary123-embedded';
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="q"', '', value, `--${boundary}--`, ''].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  // The old naive split would have split ON the inline occurrence too, corrupting this part into
  // two fragments — "token" (the part BEFORE the inline text, headers intact, but truncated) and
  // "-embedded" (the part AFTER, with no header separator of its own, so it's discarded entirely)
  // — and "token" alone neither equals nor anchors to the full value. The fixed parser keeps the
  // whole part body intact as one field value, an exact match for the full value typed.
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

// --- round 11 (R3): a delimiter must also be FOLLOWED by CRLF, `--`, or end of body ------------

test('R3: `\\r\\n--abc123X` is content for boundary `abc123`, not a delimiter (nothing real follows a boundary but CRLF, `--`, or the end)', () => {
  const boundary = 'abc123';
  // A line that STARTS with `--abc123` but continues with `X…` is a longer, unrelated token — the
  // old anchored-but-unterminated regex still matched it as a delimiter, splitting this one part
  // into "first line" and a headerless fragment that was then discarded entirely.
  const value = 'first line\r\n--abc123Xstill-content';
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="q"', '', value, `--${boundary}--`, ''].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

test('round 12: `\\r\\n--abc123--X…` is content, not a closing delimiter (the closing `--` must be followed by CRLF or the end)', () => {
  const boundary = 'abc123';
  const value = 'first\r\n--abc123--Xstill-content';
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="q"', '', value, `--${boundary}--`, ''].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: value, ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set([value]));
});

test('R4: an LF-only multipart body yields no parts — documented limitation: never certifies, and is flagged uninspectable', () => {
  const boundary = 'abc123';
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="q"', '', 'malicious-payload', `--${boundary}--`, ''].join('\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'malicious-payload', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set());
  assert.ok(uninspectableRequest(events, 'malicious-payload'), 'no parts found means we never actually got to look');
});

test('R3: a normal multi-part body (delimiters each followed by CRLF, closing followed by `--`) still parses every part', () => {
  const boundary = 'abc123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="a"',
    '',
    'first-payload',
    `--${boundary}`,
    'Content-Disposition: form-data; name="b"',
    '',
    'second-payload',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'first-payload', ok: true, step: 1 },
    { kind: 'fill', text: 'second-payload', ok: true, step: 1 },
    {
      kind: 'request',
      step: 1,
      method: 'POST',
      url: 'https://example.com/api/upload',
      postData: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    },
  ];
  assert.deepEqual(submittedInputs(events), new Set(['first-payload', 'second-payload']));
});

// --- H1: needsRescue ---------------------------------------------------------

test('needsRescue: true when nothing certifies the value yet', () => {
  const events: SubmissionEvent[] = [{ kind: 'fill', text: 'alpha', ok: true, step: 1 }];
  assert.equal(needsRescue(events, 'alpha'), true);
});

test('needsRescue: true for an unrelated own-origin request that does not carry the value', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'alpha', ok: true, step: 1 },
    { kind: 'request', step: 2, method: 'GET', url: 'https://example.com/api/heartbeat' },
  ];
  assert.equal(needsRescue(events, 'alpha'), true);
});

test('needsRescue: false once the value is actually certified', () => {
  const events: SubmissionEvent[] = [
    { kind: 'fill', text: 'alpha', ok: true, step: 1 },
    { kind: 'request', step: 1, method: 'GET', url: 'https://example.com/search?q=alpha' },
  ];
  assert.equal(needsRescue(events, 'alpha'), false);
});
