// HTML grid report, ported from the spike's run.ts. Adds per-tile kind,
// intent, failed-assertion detail (red), and a grey REFUSED colour.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from './runner.ts';

const COLOR: Record<Result['verdict'], string> = {
  PASS: '#2e9d57',
  FAIL: '#d33c3c',
  BLOCKED: '#d99a1e',
  ERROR: '#7a4bd1',
  REFUSED: '#888888',
};

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type Summary = { total: number; counts: Record<Result['verdict'], number>; inputTokens: number };

// PURE: counts per verdict + total input tokens.
export function summarize(results: Result[]): Summary {
  const counts: Record<Result['verdict'], number> = { PASS: 0, FAIL: 0, BLOCKED: 0, ERROR: 0, REFUSED: 0 };
  let inputTokens = 0;
  for (const r of results) {
    counts[r.verdict]++;
    inputTokens += r.inputTokens;
  }
  return { total: results.length, counts, inputTokens };
}

export function renderReport(results: Result[], outDir: string): string {
  const { counts, inputTokens } = summarize(results);
  const tiles = results
    .map((r) => {
      const failedAssertions = (r.expectResults ?? []).filter((e) => !e.ok);
      return `
  <div class="tile">
    ${r.video ? `<video src="${r.video}" muted autoplay loop playsinline></video>` : '<div class="novideo"></div>'}
    <div class="bar"><span>run ${r.run}&nbsp; ${esc(r.name)} <em>${r.kind}</em></span><b style="color:${COLOR[r.verdict]}">${r.verdict}</b></div>
    <details><summary>${esc(r.reason)} · ${r.steps} steps · ${r.seconds}s · Jev ${r.jevMsAvg}ms avg</summary>
      ${r.intent ? `<p class="intent">${esc(r.intent)}</p>` : ''}
      ${r.findings.map((f) => `<p class="f">step ${f.step} · ${esc(f.kind)} · ${esc(f.detail)}</p>`).join('')}
      ${failedAssertions.map((e) => `<p class="f">expect · ${esc(e.expected)} · got ${esc(e.actual)}</p>`).join('')}
      <ol>${r.trail.map((t) => `<li>${t.op} ${esc(t.label)}${t.text ? ` ← "${esc(t.text.slice(0, 60))}"` : ''} <i>${Math.round(t.conf * 100)}% · ${t.ms}ms</i></li>`).join('')}</ol>
    </details>
  </div>`;
    })
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>jev-qa run</title>
<style>body{margin:0;background:#111;color:#ddd;font:12px ui-monospace,monospace}h1{font-size:14px;padding:12px 16px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:2px}.tile{background:#1b1b1b}
video,.novideo{width:100%;aspect-ratio:16/10;display:block;background:#000}.bar{display:flex;justify-content:space-between;padding:6px 8px;background:#2a2a2a}
.bar em{color:#888;font-style:normal;margin-left:6px}
details{padding:6px 8px}summary{cursor:pointer}ol{padding-left:18px}i{color:#888}.f{color:#ff8a8a;margin:4px 0}.intent{color:#8ab4ff;margin:4px 0}</style>
<h1>${results.length} runs · ${(Object.keys(COLOR) as Result['verdict'][]).map((k) => `${k} ${counts[k]}`).join(' · ')} · ${inputTokens} Jev input tokens (≈$${((inputTokens / 1e6) * 0.042).toFixed(5)})</h1>
<div class="grid">${tiles}</div>`;
  const path = join(outDir, 'report.html');
  writeFileSync(path, html);
  return path;
}
