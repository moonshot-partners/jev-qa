import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { classify, DEFAULT_NOISE, drainPending, newSink, record, watch } from '../src/oracles.ts';

test('classify: default third-party noise is dropped', () => {
  assert.equal(classify('http 500', 'GET https://app.posthog.com/e/', {}), null);
  assert.equal(classify('console.error', 'favicon.ico 404', {}), null);
});

test('classify: DEFAULT_NOISE does not match own-origin app paths', () => {
  assert.equal(DEFAULT_NOISE.test('GET https://example.com/api/customers'), false);
});

test('classify: config-supplied noise is appended to the default set', () => {
  const opts = { noise: [/\/monitoring\?/i] };
  assert.equal(classify('http 429', 'GET https://example.com/monitoring?x=1', opts), null);
  assert.deepEqual(classify('http 500', 'GET https://example.com/api/x', opts), { kind: 'http 500' });
});

test('classify: a known finding is tagged known:<id> and reports its id', () => {
  const known = [{ id: 'B5', match: /\/dead-page/, kind: /^http 404$/ }];
  const result = classify('http 404', 'GET https://example.com/dead-page', { known });
  assert.deepEqual(result, { kind: 'known:B5 http 404', known: 'B5' });
});

test('classify: a known entry with a kind filter does not match a different kind', () => {
  const known = [{ id: 'B5', match: /\/dead-page/, kind: /^http 404$/ }];
  const result = classify('http 500', 'GET https://example.com/dead-page', { known });
  assert.deepEqual(result, { kind: 'http 500' });
});

test('classify: a known entry with no kind filter matches any kind', () => {
  const known = [{ id: 'K1', match: /flaky-endpoint/ }];
  const result = classify('http 502', 'GET https://example.com/flaky-endpoint', { known });
  assert.deepEqual(result, { kind: 'known:K1 http 502', known: 'K1' });
});

test('classify: an ordinary finding passes through unchanged', () => {
  const result = classify('pageerror', 'TypeError: x is not a function', {});
  assert.deepEqual(result, { kind: 'pageerror' });
});

test('classify: a known entry tags crash-screen findings the same way as any other kind', () => {
  const known = [{ id: 'C1', match: /application error/, kind: /^crash-screen$/ }];
  const result = classify('crash-screen', 'application error', { known });
  assert.deepEqual(result, { kind: 'known:C1 crash-screen', known: 'C1' });
});

test('record: pushes a classified finding onto the sink with url/step', () => {
  const sink = newSink();
  record(sink, 'https://example.com/x', 3, 'http 500', 'GET https://example.com/x', {});
  assert.deepEqual(sink.findings, [{ kind: 'http 500', detail: 'GET https://example.com/x', url: 'https://example.com/x', step: 3 }]);
});

test('record: noise is dropped, not pushed', () => {
  const sink = newSink();
  record(sink, 'https://example.com/x', 1, 'http 500', 'GET https://app.posthog.com/e/', {});
  assert.deepEqual(sink.findings, []);
});

test('record: de-duplicates identical (kind, detail) pairs', () => {
  const sink = newSink();
  record(sink, 'https://example.com/x', 1, 'http 500', 'GET https://example.com/x', {});
  record(sink, 'https://example.com/x', 2, 'http 500', 'GET https://example.com/x', {});
  assert.equal(sink.findings.length, 1);
});

test('watch: detach() removes all four listeners it attached', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  const detach = watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  assert.equal(emitter.listenerCount('pageerror'), 1);
  assert.equal(emitter.listenerCount('console'), 1);
  assert.equal(emitter.listenerCount('request'), 1);
  assert.equal(emitter.listenerCount('response'), 1);
  detach();
  assert.equal(emitter.listenerCount('pageerror'), 0);
  assert.equal(emitter.listenerCount('console'), 0);
  assert.equal(emitter.listenerCount('request'), 0);
  assert.equal(emitter.listenerCount('response'), 0);
});

function fakeRequest(url: string, opts: { method?: string; postData?: string | null; headers?: Record<string, string> } = {}) {
  return {
    url: () => url,
    method: () => opts.method ?? 'GET',
    postData: () => opts.postData ?? null,
    headers: () => opts.headers ?? {},
  };
}

test('watch: records an own-origin request with method/url/postData', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 4, { ownOrigins: [/example\.com/] });
  emitter.emit('request', fakeRequest('https://example.com/api/search?q=hostile', { method: 'GET' }));
  assert.deepEqual(sink.requests, [
    { step: 4, method: 'GET', url: 'https://example.com/api/search?q=hostile', postData: undefined, bodyOversized: false, contentType: undefined },
  ]);
});

test('round 9 (O6): watch: records the request\'s Content-Type header verbatim (not lower-cased)', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  emitter.emit(
    'request',
    fakeRequest('https://example.com/api/upload', {
      method: 'POST',
      postData: 'q=hostile',
      headers: { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundaryAbC123' },
    }),
  );
  assert.equal(sink.requests[0].contentType, 'multipart/form-data; boundary=----WebKitFormBoundaryAbC123');
});

test('round 9 (O6): watch: a request with no Content-Type header at all records contentType as undefined', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  emitter.emit('request', fakeRequest('https://example.com/api/x', { method: 'GET' }));
  assert.equal(sink.requests[0].contentType, undefined);
});

test('watch: a third-party request is never recorded', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  emitter.emit('request', fakeRequest('https://app.posthog.com/e/'));
  assert.deepEqual(sink.requests, []);
});

test('watch: postData over 64 KiB is dropped, but the request is still recorded and flagged bodyOversized (round 8, N4)', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  const huge = 'x'.repeat(64 * 1024 + 1);
  emitter.emit('request', fakeRequest('https://example.com/api/x', { method: 'POST', postData: huge }));
  assert.equal(sink.requests.length, 1);
  assert.equal(sink.requests[0].postData, undefined);
  assert.equal(sink.requests[0].bodyOversized, true, 'an oversized body must be distinguishable from "no body at all"');
});

test('watch: postData at or under 64 KiB is kept, not flagged oversized', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  const small = 'q=hostile';
  emitter.emit('request', fakeRequest('https://example.com/api/x', { method: 'POST', postData: small }));
  assert.equal(sink.requests[0].postData, small);
  assert.equal(sink.requests[0].bodyOversized, false);
});

test('watch: a GET with no body at all is never flagged bodyOversized', () => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, { url: () => 'https://example.com/x' }) as unknown as Page;
  const sink = newSink();
  watch(page, sink, () => 1, { ownOrigins: [/example\.com/] });
  emitter.emit('request', fakeRequest('https://example.com/api/x', { method: 'GET' }));
  assert.equal(sink.requests[0].postData, undefined);
  assert.equal(sink.requests[0].bodyOversized, false);
});

test('drainPending: waits out a pending read that spawns another pending read before settling', async () => {
  const sink = newSink();
  let rounds = 0;
  const spawn = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(() => {
        rounds++;
        if (rounds < 3) sink.pending.push(spawn());
        resolve();
      }, 5);
    });
  sink.pending.push(spawn());
  await drainPending(sink);
  assert.equal(rounds, 3);
  assert.equal(sink.pending.length, 3);
});

test('drainPending: bounded by maxRounds even while pending keeps growing', async () => {
  const sink = newSink();
  const grow = (remaining: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(() => {
        if (remaining > 0) sink.pending.push(grow(remaining - 1));
        resolve();
      }, 20);
    });
  sink.pending.push(grow(20)); // would take ~400ms to fully settle if unbounded
  const started = Date.now();
  await drainPending(sink, 2);
  assert.ok(Date.now() - started < 200, `expected drainPending to stop after 2 rounds, took ${Date.now() - started}ms`);
});

test('drainPending: returns true once everything settles within the bound', async () => {
  const sink = newSink();
  sink.pending.push(Promise.resolve());
  const settled = await drainPending(sink, 5, 3_000);
  assert.equal(settled, true);
});

test('drainPending: a never-resolving promise times out the round (settled=false), does not hang', async () => {
  const sink = newSink();
  sink.pending.push(new Promise(() => {})); // never resolves
  const started = Date.now();
  const settled = await drainPending(sink, 1, 100); // short round bound for a fast test
  assert.equal(settled, false);
  assert.ok(Date.now() - started < 500, `expected drainPending to time out near the bound, took ${Date.now() - started}ms`);
});

test('drainPending: an unresolved promise is left in sink.pending for a later attempt to find', async () => {
  const sink = newSink();
  const stuck = new Promise(() => {});
  sink.pending.push(stuck);
  await drainPending(sink, 1, 50);
  assert.equal(sink.pending.length, 1);
  assert.equal(sink.pending[0], stuck); // carried forward, not discarded
});
