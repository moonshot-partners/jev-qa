// Pure unit tests for runner.ts's own pure helpers — no browser, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestRecord, ResponseRecord } from '../src/oracles.ts';
import { capRecent, persistedTimeline } from '../src/runner.ts';

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
