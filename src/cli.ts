// Pure CLI argument-parsing and exit-code helpers, unit-tested without a
// process, a browser, or a network call. bin/jev-qa.ts wires these to argv
// and process.exit.
import type { Verdict } from './verdict.ts';

export const USAGE = `usage:
  jev-qa run --config <path> --env <name> [--kind smoke|adversarial|acceptance] [--filter <substr>] [--name <exact-name> ...] [--concurrency <n>] [--repeat <n>] [--out <dir>] [--list] [--allow-empty]
  jev-qa replay --config <path> --env <name> <run-dir> <scenario-name>
  jev-qa replay --config <path> --env <name> --role <role> <url...>
  jev-qa report <run-dir>

exit codes for "run": 0 = no FAIL/ERROR/BLOCKED; 1 = any FAIL or ERROR; 3 = no FAIL/ERROR but some BLOCKED.
REFUSED never changes the exit code — it is policy (an environment refusing a mutating scenario on
purpose), not a defect — but it is always printed in the summary line.
Zero scenarios selected is an error (exit 2) unless --allow-empty is given (then exit 0).`;

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

// Every value that followed an occurrence of a repeatable flag, e.g.
// `--name a --name b` → ['a', 'b']. Unlike `flag()`, which only returns
// the first.
export function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

// Every non-flag argument, skipping recognised `--flag value` pairs. A
// `--flag` not listed in `flagsWithValue` is treated as a boolean switch
// (its value, if any, is left as a positional — callers pass every
// value-taking flag they used for this command).
export function positionals(args: string[], flagsWithValue: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (flagsWithValue.includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

// Throws a plain Error (message only — no process/console access, so it's
// testable in isolation) on anything that is not an integer ≥ 1.
export function parseCount(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${label} must be an integer ≥ 1, got "${raw}"`);
  }
  return n;
}

// F8: REFUSED is deliberately excluded — it never affects the exit code.
export function exitCodeForCounts(counts: Record<Verdict, number>): 0 | 1 | 3 {
  if (counts.FAIL > 0 || counts.ERROR > 0) return 1;
  if (counts.BLOCKED > 0) return 3;
  return 0;
}

// null = proceed with the run as normal; a number = the process should
// exit with that code right away instead of launching a browser.
export function emptyWorkloadCode(scenarioCount: number, allowEmpty: boolean): 0 | 2 | null {
  if (scenarioCount > 0) return null;
  return allowEmpty ? 0 : 2;
}
