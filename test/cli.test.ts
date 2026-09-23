import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyWorkloadCode, exitCodeForCounts, flag, flagAll, hasFlag, parseCount, positionals } from '../src/cli.ts';
import type { Verdict } from '../src/verdict.ts';

function counts(overrides: Partial<Record<Verdict, number>>): Record<Verdict, number> {
  return { PASS: 0, FAIL: 0, BLOCKED: 0, ERROR: 0, REFUSED: 0, ...overrides };
}

test('flag: returns the value after a recognised flag', () => {
  assert.equal(flag(['--env', 'staging', '--list'], '--env'), 'staging');
});

test('flag: returns undefined when the flag is absent', () => {
  assert.equal(flag(['--env', 'staging'], '--config'), undefined);
});

test('hasFlag: true only when the exact flag is present', () => {
  assert.equal(hasFlag(['run', '--list'], '--list'), true);
  assert.equal(hasFlag(['run', '--listing'], '--list'), false);
});

test('positionals: skips recognised value-taking flags and their values', () => {
  const args = ['--config', 'jev-qa.config.ts', '--env', 'staging', 'runs/latest', 'adversarial/hostile-search'];
  assert.deepEqual(positionals(args, ['--config', '--env']), ['runs/latest', 'adversarial/hostile-search']);
});

test('flagAll: collects every value of a repeated flag, in order', () => {
  const args = ['run', '--name', 'adversarial/a', '--name', 'adversarial/b', '--kind', 'adversarial'];
  assert.deepEqual(flagAll(args, '--name'), ['adversarial/a', 'adversarial/b']);
});

test('flagAll: empty array when the flag never appears', () => {
  assert.deepEqual(flagAll(['run', '--kind', 'smoke'], '--name'), []);
});

test('flagAll: a trailing flag with no following value is not included', () => {
  assert.deepEqual(flagAll(['--name', 'a', '--name'], '--name'), ['a']);
});

test('positionals: an unlisted boolean flag is skipped, its value (if any) stays positional', () => {
  const args = ['--role', 'manager', '--verbose', 'https://example.com/api/x'];
  assert.deepEqual(positionals(args, ['--role']), ['https://example.com/api/x']);
});

test('parseCount: missing flag falls back to the default', () => {
  assert.equal(parseCount(undefined, 4, 'concurrency'), 4);
});

test('parseCount: a valid integer string is accepted', () => {
  assert.equal(parseCount('8', 4, 'concurrency'), 8);
});

test('parseCount: rejects zero', () => {
  assert.throws(() => parseCount('0', 4, 'concurrency'), /--concurrency must be an integer ≥ 1, got "0"/);
});

test('parseCount: rejects a negative number', () => {
  assert.throws(() => parseCount('-1', 4, 'repeat'), /--repeat must be an integer ≥ 1/);
});

test('parseCount: rejects a non-integer', () => {
  assert.throws(() => parseCount('2.5', 4, 'concurrency'), /--concurrency must be an integer ≥ 1/);
});

test('parseCount: rejects non-numeric garbage', () => {
  assert.throws(() => parseCount('four', 4, 'concurrency'), /--concurrency must be an integer ≥ 1, got "four"/);
});

test('exitCodeForCounts: 0 when everything passed', () => {
  assert.equal(exitCodeForCounts(counts({ PASS: 5 })), 0);
});

test('exitCodeForCounts: 1 when any FAIL is present, even alongside BLOCKED', () => {
  assert.equal(exitCodeForCounts(counts({ PASS: 3, FAIL: 1, BLOCKED: 2 })), 1);
});

test('exitCodeForCounts: 1 when any ERROR is present', () => {
  assert.equal(exitCodeForCounts(counts({ PASS: 3, ERROR: 1 })), 1);
});

test('exitCodeForCounts: 3 when only BLOCKED (no FAIL/ERROR) is present', () => {
  assert.equal(exitCodeForCounts(counts({ PASS: 3, BLOCKED: 1 })), 3);
});

test('exitCodeForCounts: REFUSED never affects the code either way', () => {
  assert.equal(exitCodeForCounts(counts({ PASS: 3, REFUSED: 4 })), 0);
  assert.equal(exitCodeForCounts(counts({ REFUSED: 4, BLOCKED: 1 })), 3);
  assert.equal(exitCodeForCounts(counts({ REFUSED: 4, FAIL: 1 })), 1);
});

test('emptyWorkloadCode: non-empty selection proceeds (null)', () => {
  assert.equal(emptyWorkloadCode(3, false), null);
});

test('emptyWorkloadCode: empty selection without --allow-empty is an error (2)', () => {
  assert.equal(emptyWorkloadCode(0, false), 2);
});

test('emptyWorkloadCode: empty selection with --allow-empty exits clean (0)', () => {
  assert.equal(emptyWorkloadCode(0, true), 0);
});
