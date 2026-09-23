// Direct API replay as a role, no Jev in the loop. Proves an oracle finding
// (or a scenario's requests) independent of the browser-driving agent.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolveBaseUrl, type Config } from './config.ts';
import { loadScenarios } from './scenario.ts';

export type ReplayRow = { status: number | 'ERR' | 'REFUSED'; ms: number; url: string; summary: string };

export async function replayUrls(opts: { config: Config; envName: string; role: string | null; urls: string[] }): Promise<ReplayRow[]> {
  const env = opts.config.environments[opts.envName];
  if (!env) throw new Error(`no environment named "${opts.envName}" in config.environments`);
  const roleConfig = opts.role ? opts.config.roles[opts.role] : null;
  if (opts.role && !roleConfig) throw new Error(`no role named "${opts.role}" in config.roles`);
  const baseUrl = roleConfig ? resolveBaseUrl(roleConfig, env) : env.baseUrl;

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    // Login happens in a page, so a config route guard must be in place first. The URL fetches
    // below use ctx.request, which bypasses routes, so each one goes through guardRequest instead.
    await opts.config.setupContext?.(ctx, env);
    if (roleConfig) {
      const page = await ctx.newPage();
      await roleConfig.login(page, env);
      await page.close();
    }
    const rows: ReplayRow[] = [];
    for (const u of opts.urls) {
      const requested = u.startsWith('http') ? u : baseUrl + u;
      const guarded = opts.config.guardRequest ? opts.config.guardRequest(requested, env) : requested;
      if (typeof guarded !== 'string') {
        rows.push({ status: 'REFUSED', ms: 0, url: requested, summary: guarded.refuse });
        console.log(`REFUSED ${requested}\n     ${guarded.refuse}`);
        continue;
      }
      const url = guarded;
      const started = performance.now();
      try {
        const res = await ctx.request.get(url, { maxRedirects: 0, timeout: 30_000 });
        const ms = Math.round(performance.now() - started);
        const contentType = res.headers()['content-type'] ?? '';
        const body = await res.text();
        let summary = body.replace(/\s+/g, ' ').slice(0, 160);
        if (contentType.includes('json')) {
          try {
            const j = JSON.parse(body);
            const arr = Array.isArray(j) ? j : (j.items ?? j.data ?? j.results ?? null);
            if (Array.isArray(arr)) summary = `${arr.length} items · total=${j.total ?? j.pagination?.total ?? j.count ?? '?'} · ${summary.slice(0, 80)}`;
          } catch {
            // not parseable JSON despite the content-type; keep the raw text summary
          }
        }
        rows.push({ status: res.status(), ms, url, summary });
        console.log(`${res.status()} ${ms}ms ${url}\n     ${summary}`);
      } catch (e) {
        const ms = Math.round(performance.now() - started);
        rows.push({ status: 'ERR', ms, url, summary: String(e) });
        console.log(`ERR  ${ms}ms ${url}\n     ${String(e)}`);
      }
    }
    return rows;
  } finally {
    // Always release the browser, even if login (or anything else above) threw.
    await browser.close().catch(() => {});
  }
}

// Re-requests, as the scenario's own role, every URL behind a finding a
// prior `run` recorded for that scenario (finding.detail is "METHOD url").
export async function replayRun(opts: { config: Config; dir: string; envName: string; runDir: string; scenarioName: string }): Promise<ReplayRow[]> {
  const resultsPath = `${opts.runDir}/results.json`;
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as { name: string; findings: { detail: string }[] }[];
  const matches = results.filter((r) => r.name === opts.scenarioName);
  if (matches.length === 0) throw new Error(`no result named "${opts.scenarioName}" in ${resultsPath}`);

  const scenarios = loadScenarios(opts.config, opts.dir);
  const scenario = scenarios.find((s) => s.name === opts.scenarioName);
  if (!scenario) throw new Error(`no scenario named "${opts.scenarioName}" in config.scenarios`);

  const urls: string[] = [];
  for (const r of matches) {
    for (const f of r.findings) {
      const m = /^[A-Z]+ (\S+)$/.exec(f.detail);
      if (m) urls.push(m[1]);
    }
  }
  console.log(`${urls.length} finding url(s) for "${opts.scenarioName}" as role ${scenario.role ?? 'anon'}`);
  const rows = await replayUrls({ config: opts.config, envName: opts.envName, role: scenario.role, urls });
  const under400 = rows.filter((r) => typeof r.status === 'number' && r.status < 400).length;
  console.log(`${rows.length} replayed, ${under400} now < 400`);
  return rows;
}
