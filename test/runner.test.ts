// Pure unit tests for runner.ts's own pure helpers — no browser, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestRecord, ResponseRecord } from '../src/oracles.ts';
import { fitWholeParts } from '../src/browser.ts';
import { capRecent, certifiedInputKeys, clipLabel, flattenInputEntries, maskSecrets, persistFinding, persistedTimeline } from '../src/runner.ts';

// --- round 10 (Q3): capRecent — results.json persistence cap -----------------------------------

test('capRecent: an array at or under the cap is returned unchanged, with zero omitted', () => {
  const items = Array.from({ length: 300 }, (_, i) => i);
  const { kept, omitted } = capRecent(items, 300);
  assert.deepEqual(kept, items);
  assert.equal(omitted, 0);
});

test('capRecent: an array under the cap is untouched', () => {
  const items = [1, 2, 3];
  const { kept, omitted } = capRecent(items, 300);
  assert.deepEqual(kept, items);
  assert.equal(omitted, 0);
});

test('capRecent: an array over the cap keeps only the MOST RECENT (trailing) entries', () => {
  const items = Array.from({ length: 305 }, (_, i) => i); // 0..304, chronological
  const { kept, omitted } = capRecent(items, 300);
  assert.equal(kept.length, 300);
  assert.equal(omitted, 5);
  assert.deepEqual(kept, Array.from({ length: 300 }, (_, i) => i + 5)); // 5..304 — the oldest 5 dropped
});

test('capRecent: an empty array stays empty, zero omitted', () => {
  const { kept, omitted } = capRecent([], 300);
  assert.deepEqual(kept, []);
  assert.equal(omitted, 0);
});

test('capRecent: a custom max is honoured', () => {
  const items = [1, 2, 3, 4, 5];
  const { kept, omitted } = capRecent(items, 2);
  assert.deepEqual(kept, [4, 5]);
  assert.equal(omitted, 3);
});

// --- round 11 (R5): persistedTimeline — the code runOne() actually builds a Result's timeline with

function fakeRequests(n: number): RequestRecord[] {
  return Array.from({ length: n }, (_, i) => ({ step: i, method: 'GET', url: `https://example.com/r/${i}`, postData: `secret-body-${i}`, bodyOversized: false }));
}

function fakeResponses(n: number): ResponseRecord[] {
  return Array.from({ length: n }, (_, i) => ({ step: i, method: 'GET', url: `https://example.com/r/${i}`, status: 200, contentType: 'application/json', body: `{"i":${i}}` }));
}

test('persistedTimeline: > 300 requests/responses are capped to the most recent 300 each, omitted counts set', () => {
  const t = persistedTimeline(fakeRequests(350), fakeResponses(320));
  assert.equal(t.requests.length, 300);
  assert.equal(t.responses.length, 300);
  assert.equal(t.requestsOmitted, 50);
  assert.equal(t.responsesOmitted, 20);
  // The MOST RECENT survive: requests 50..349, responses 20..319.
  assert.equal(t.requests[0].url, 'https://example.com/r/50');
  assert.equal(t.requests[299].url, 'https://example.com/r/349');
  assert.equal(t.responses[0].url, 'https://example.com/r/20');
  assert.equal(t.responses[299].url, 'https://example.com/r/319');
});

test('persistedTimeline: the persisted entries are trimmed — no postData / body / contentType / bodyOversized', () => {
  const t = persistedTimeline(fakeRequests(2), fakeResponses(2));
  assert.deepEqual(t.requests[0], { step: 0, method: 'GET', url: 'https://example.com/r/0' });
  assert.deepEqual(t.responses[0], { step: 0, method: 'GET', url: 'https://example.com/r/0', status: 200 });
});

test('persistedTimeline: at or under the cap nothing is omitted and the omitted counts are absent', () => {
  const t = persistedTimeline(fakeRequests(300), fakeResponses(10));
  assert.equal(t.requests.length, 300);
  assert.equal(t.responses.length, 10);
  assert.equal(t.requestsOmitted, undefined);
  assert.equal(t.responsesOmitted, undefined);
  assert.equal('requestsOmitted' in JSON.parse(JSON.stringify(t)), false, 'undefined omitted counts never reach results.json');
});


// Round 9 (P1): a finding is masked BEFORE it is clipped to 400 characters.
test('persistFinding masks then clips, so no secret prefix survives the boundary', () => {
  const secret = 'Pw-0123456789AB'; // 15 characters
  const detail = 'e'.repeat(387) + secret + ' tail';
  const s = { inputs: { password: secret }, secretInputs: ['password'] } as any;
  const out = persistFinding({ kind: 'console.error', detail, url: 'https://a.test/', step: 1 }, (t: string) => maskSecrets(t, s));
  assert.ok(out.detail.length <= 400);
  assert.ok(!out.detail.includes(secret.slice(0, 13)), out.detail.slice(380));
});

// Round 9 (P1): certification is per phase AND key — a value submitted in one phase never
// certifies a different key that only a later phase offers.
test('certifiedInputKeys: an earlier phase cannot certify a later phase key with the same value', () => {
  const entries = flattenInputEntries({ first: ['same-value'], second: ['same-value'] });
  const windows: { inputs: Record<string, string>; values: Set<string> }[] = [
    { inputs: { first: 'same-value' }, values: new Set(['same-value']) },
    { inputs: { second: 'same-value' }, values: new Set<string>() },
  ];
  const certified = certifiedInputKeys(entries, windows);
  assert.ok(certified.has('first'));
  assert.ok(!certified.has('second'));
});

test('certifiedInputKeys: a main-phase key inherited by a later phase is certified by either window', () => {
  const entries = flattenInputEntries({ email: ['a@x.test'] });
  const windows: { inputs: Record<string, string>; values: Set<string> }[] = [
    { inputs: { email: 'a@x.test' }, values: new Set<string>() },
    { inputs: { email: 'a@x.test' }, values: new Set(['a@x.test']) },
  ];
  assert.ok(certifiedInputKeys(entries, windows).has('email'));
});


// Round 11 (P1): a stuck reason quotes an action label — masked first, then clipped.
test('clipLabel masks before clipping', () => {
  const secret = 'Sx8!kLmN2pQr4t'; // 14 characters
  const label = 'Open the field named ' + 'z'.repeat(10) + secret;
  const out = clipLabel(label, (t: string) => t.split(secret).join('«pw»'), 40);
  assert.ok(out.length <= 40);
  assert.ok(!out.includes('Sx8!'), out);
});

// Round 11 (P1): frame text is joined as WHOLE parts — never split into lines, so a short first
// line of a multi-line secret can never be kept on its own.
test("fitWholeParts never keeps part of a multi-line part", () => {
  const secret = "Wv3!pQ9#zT\n" + "q".repeat(4000);
  const out = fitWholeParts(["m".repeat(2500), secret], 6000);
  assert.ok(!out.includes("Wv3!pQ9#zT"), "the first line alone is not kept");
  assert.equal(out, "m".repeat(2500));
});
