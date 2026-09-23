import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/report.ts';
import type { Result } from '../src/runner.ts';

function result(overrides: Partial<Result>): Result {
  return {
    name: 'x', kind: 'smoke', run: 1, verdict: 'PASS', reason: 'ok', steps: 1, seconds: 1,
    jevCalls: 1, jevMsAvg: 100, inputTokens: 10, findings: [], trail: [], responses: [], requests: [], submitted: [],
    ...overrides,
  };
}

test('summarize: counts per verdict and total input tokens', () => {
  const results = [
    result({ verdict: 'PASS', inputTokens: 100 }),
    result({ verdict: 'PASS', inputTokens: 50 }),
    result({ verdict: 'FAIL', inputTokens: 25 }),
    result({ verdict: 'BLOCKED', inputTokens: 10 }),
    result({ verdict: 'ERROR', inputTokens: 5 }),
    result({ verdict: 'REFUSED', inputTokens: 0 }),
  ];
  const summary = summarize(results);
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.counts, { PASS: 2, FAIL: 1, BLOCKED: 1, ERROR: 1, REFUSED: 1 });
  assert.equal(summary.inputTokens, 190);
});

test('summarize: empty result set', () => {
  const summary = summarize([]);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.counts, { PASS: 0, FAIL: 0, BLOCKED: 0, ERROR: 0, REFUSED: 0 });
});
