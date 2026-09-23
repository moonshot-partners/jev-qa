// Pure verdict rules. The runner drives the browser; this module only turns
// what happened into PASS/FAIL/BLOCKED/ERROR (REFUSED is decided earlier by
// refusedByEnvironment, before any browser work starts).
import type { ExpectResult } from './expect.ts';
import type { Finding } from './oracles.ts';

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'ERROR' | 'REFUSED';

export type VerdictInput = {
  kind: 'smoke' | 'adversarial' | 'acceptance';
  jevDone: boolean;
  loopReason: string;
  inputs?: Record<string, string>;
  submitted: Set<string>;
  findings: Finding[];
  expectResults?: ExpectResult[];
  error?: string;
  // Round 8 (N4) + addendum (N5b): per missing-input-KEY, a one-line extra detail — either a
  // partial-prefix match (submission.ts's partialMatch()) or a plausible-but-unconfirmable
  // request (uninspectableRequest()) — a more specific BLOCKED reason than implying nothing
  // happened at all.
  missingDetail?: Record<string, string>;
};

function keyOf(assertion: unknown): string {
  if (assertion && typeof assertion === 'object') {
    const k = Object.keys(assertion)[0];
    if (k) return k;
  }
  return '?';
}

export function decideVerdict(input: VerdictInput): { verdict: Verdict; reason: string } {
  const fresh = input.findings.filter((f) => !f.kind.startsWith('known:'));
  const known = input.findings.length - fresh.length;
  const knownSuffix = known ? ` (+${known} known)` : '';

  // A fresh finding is real product signal even when the run also threw afterward (e.g. an
  // HTTP 500 was recorded, then the page's own broken response caused something downstream to
  // throw) — that signal must not be swallowed by a plain ERROR. The error is still surfaced,
  // appended to the reason, so the failure is never silently dropped either.
  if (fresh.length) {
    const kinds = fresh.map((f) => f.kind).join(', ');
    let reason = `${fresh.length} oracle finding(s): ${kinds}${knownSuffix}`;
    if (input.error) reason += ` (then error: ${input.error.split('\n')[0]})`;
    return { verdict: 'FAIL', reason };
  }

  if (input.error) {
    return { verdict: 'ERROR', reason: input.error.split('\n')[0] };
  }

  // A failed expectation is product signal for EVERY kind (README: "FAIL: a fresh finding, or
  // a failed expect") — including a smoke or adversarial scenario whose later phase could not
  // start because its start check reported ok:false. Only acceptance scenarios are REQUIRED to
  // carry expectations; any kind that has them is held to them.
  const failedExpect = (input.expectResults ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.ok);
  if (failedExpect.length) {
    const reason = failedExpect
      .map(({ r, i }) => `${r.phase ? `phase "${r.phase}" ` : ''}expect #${i} ${keyOf(r.assertion)}: expected ${r.expected}, actual ${r.actual}`)
      .join('; ');
    return { verdict: 'FAIL', reason };
  }

  if (input.kind === 'smoke') {
    const reason = (input.jevDone ? 'Jev DONE' : input.loopReason) + knownSuffix;
    return { verdict: 'PASS', reason };
  }

  if (input.kind === 'adversarial') {
    const inputs = input.inputs ?? {};
    const missing = Object.entries(inputs)
      .filter(([, v]) => !input.submitted.has(v))
      .map(([k]) => k);
    if (missing.length) {
      // N4/N5b (round 8): a missing key with extra detail (a partial-prefix match, or an
      // uninspectable candidate request) gets its own parenthetical — "plausibly reached the
      // server, we just can't fully prove it" is meaningfully different from silence, and worth
      // saying per-key rather than only in the trailing loop reason (kept, for every key, as the
      // fallback explanation).
      const parts = missing.map((k) => (input.missingDetail?.[k] ? `${k} (${input.missingDetail[k]})` : k));
      return { verdict: 'BLOCKED', reason: `inputs not submitted: ${parts.join(', ')} (${input.loopReason})` };
    }
    return { verdict: 'PASS', reason: `all ${Object.keys(inputs).length} inputs submitted${knownSuffix}` };
  }

  // acceptance
  if (!input.jevDone) {
    return { verdict: 'BLOCKED', reason: input.loopReason };
  }
  const results = input.expectResults ?? [];
  return { verdict: 'PASS', reason: `Jev DONE + ${results.length} assertions${knownSuffix}` };
}

// Decided before any browser work: a mutating scenario is refused outright
// in an environment configured to disallow mutations.
export function refusedByEnvironment(scenario: { mutates?: boolean }, env: { mutations: boolean }): boolean {
  return scenario.mutates === true && env.mutations === false;
}
