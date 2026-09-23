import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideVerdict, refusedByEnvironment } from '../src/verdict.ts';
import type { Finding } from '../src/oracles.ts';

const noFindings: Finding[] = [];

test('an error with NO findings: ERROR with the first line of the message', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied',
    submitted: new Set(), findings: [],
    error: 'boom\nsecond line',
  });
  assert.equal(verdict, 'ERROR');
  assert.equal(reason, 'boom');
});

test('a fresh finding wins over an error: FAIL, with the error appended to the reason', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied',
    submitted: new Set(), findings: [{ kind: 'http 500', detail: 'x', url: 'u', step: 1 }],
    error: 'boom\nsecond line',
  });
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /^1 oracle finding\(s\): http 500 \(then error: boom\)$/);
});

test('a KNOWN-only finding does not out-rank an error: ERROR still wins (only FRESH findings do)', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied',
    submitted: new Set(), findings: [{ kind: 'known:B3 http 404', detail: 'x', url: 'u', step: 1 }],
    error: 'boom',
  });
  assert.equal(verdict, 'ERROR');
  assert.equal(reason, 'boom');
});

test('fresh findings fail regardless of kind, listing every kind', () => {
  const findings: Finding[] = [
    { kind: 'http 500', detail: 'GET /x', url: 'u', step: 1 },
    { kind: 'pageerror', detail: 'boom', url: 'u', step: 2 },
  ];
  const { verdict, reason } = decideVerdict({ kind: 'smoke', jevDone: true, loopReason: 'Jev DONE', submitted: new Set(), findings });
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /2 oracle finding\(s\): http 500, pageerror/);
});

test('known-only findings do not fail; PASS notes (+N known)', () => {
  const findings: Finding[] = [{ kind: 'known:B5 http 404', detail: 'GET /x', url: 'u', step: 1 }];
  const { verdict, reason } = decideVerdict({ kind: 'smoke', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings });
  assert.equal(verdict, 'PASS');
  assert.match(reason, /\(\+1 known\)$/);
});

test('smoke PASSes on step-budget exhaustion with no fresh finding', () => {
  const { verdict, reason } = decideVerdict({ kind: 'smoke', jevDone: false, loopReason: 'step budget used up', submitted: new Set(), findings: noFindings });
  assert.equal(verdict, 'PASS');
  assert.match(reason, /step budget used up/);
});

test('smoke PASSes on a stuck loop reason too', () => {
  const { verdict } = decideVerdict({ kind: 'smoke', jevDone: false, loopReason: 'stuck: 4 actions with no page change', submitted: new Set(), findings: noFindings });
  assert.equal(verdict, 'PASS');
});

test('adversarial BLOCKED when an input value never reached submitted, named by key', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'adversarial', jevDone: false, loopReason: 'step budget used up',
    inputs: { sql: "' OR 1=1", emoji: '🌸' },
    submitted: new Set(["' OR 1=1"]),
    findings: noFindings,
  });
  assert.equal(verdict, 'BLOCKED');
  assert.match(reason, /^inputs not submitted: emoji \(step budget used up\)$/);
});

test('round 8 (N4): adversarial BLOCKED names an uninspectable candidate request per key', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'adversarial', jevDone: false, loopReason: 'step budget used up',
    inputs: { sql: "' OR 1=1", emoji: '🌸' },
    submitted: new Set(),
    findings: noFindings,
    missingDetail: { sql: 'request POST /api/search body not inspectable' },
  });
  assert.equal(verdict, 'BLOCKED');
  assert.match(reason, /^inputs not submitted: sql \(request POST \/api\/search body not inspectable\), emoji \(step budget used up\)$/);
});

test('round 8 addendum (N5b): adversarial BLOCKED names a partial-prefix match per key', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'adversarial', jevDone: false, loopReason: 'stuck: repeated "Search" 4 times',
    inputs: { long: 'x'.repeat(300) },
    submitted: new Set(),
    findings: noFindings,
    missingDetail: { long: 'partial match: 120 of 300 characters (via GET /api/sales?searchQuery=…)' },
  });
  assert.equal(verdict, 'BLOCKED');
  assert.match(
    reason,
    /^inputs not submitted: long \(partial match: 120 of 300 characters \(via GET \/api\/sales\?searchQuery=…\)\) \(stuck: repeated "Search" 4 times\)$/,
  );
});

test('adversarial PASS once every input value is submitted, regardless of Jev DONE', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'adversarial', jevDone: false, loopReason: 'step budget used up',
    inputs: { sql: "' OR 1=1", emoji: '🌸' },
    submitted: new Set(["' OR 1=1", '🌸']),
    findings: noFindings,
  });
  assert.equal(verdict, 'PASS');
  assert.equal(reason, 'all 2 inputs submitted');
});

test('acceptance BLOCKED when Jev never reached DONE', () => {
  const { verdict, reason } = decideVerdict({ kind: 'acceptance', jevDone: false, loopReason: 'stuck: repeated "Open menu" 4 times', submitted: new Set(), findings: noFindings });
  assert.equal(verdict, 'BLOCKED');
  assert.equal(reason, 'stuck: repeated "Open menu" 4 times');
});

test('acceptance FAIL lists every failed expect with expected + actual', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings: noFindings,
    expectResults: [
      { assertion: { url: '/done' }, ok: false, expected: 'url includes /done', actual: '/start' },
      { assertion: { text: 'Welcome' }, ok: true, expected: 'body text includes "Welcome"', actual: 'present' },
      { assertion: { element: { role: 'button', name: 'Save' } }, ok: false, expected: 'visible', actual: 'visible=false' },
    ],
  });
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /expect #0 url: expected url includes \/done, actual \/start/);
  assert.match(reason, /expect #2 element: expected visible, actual visible=false/);
  assert.doesNotMatch(reason, /expect #1/);
});

test('acceptance PASS when Jev DONE and every assertion is ok', () => {
  const { verdict, reason } = decideVerdict({
    kind: 'acceptance', jevDone: true, loopReason: 'Jev: goal satisfied', submitted: new Set(), findings: noFindings,
    expectResults: [{ assertion: { url: '/done' }, ok: true, expected: 'x', actual: 'y' }],
  });
  assert.equal(verdict, 'PASS');
  assert.equal(reason, 'Jev DONE + 1 assertions');
});

test('refusedByEnvironment: mutating scenario in a no-mutations environment', () => {
  assert.equal(refusedByEnvironment({ mutates: true }, { mutations: false }), true);
});

test('refusedByEnvironment: mutating scenario in a mutations-allowed environment', () => {
  assert.equal(refusedByEnvironment({ mutates: true }, { mutations: true }), false);
});

test('refusedByEnvironment: non-mutating scenario is never refused', () => {
  assert.equal(refusedByEnvironment({ mutates: false }, { mutations: false }), false);
  assert.equal(refusedByEnvironment({}, { mutations: false }), false);
});
