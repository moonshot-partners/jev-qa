// setupContext runs on the fresh browser context BEFORE login and BEFORE the
// start navigation, so a config's route guard also covers the start URL (a
// guard installed in beforeEach runs only after the start page has loaded).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { Decision } from '../src/jev.ts';
import { runAll } from '../src/runner.ts';
import type { Scenario } from '../src/scenario.ts';

const SKIP = process.env.JEV_QA_NO_BROWSER ? 'JEV_QA_NO_BROWSER is set' : false;

test('setupContext runs before login and guards the start navigation', { skip: SKIP }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><p>ok</p></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'jevqa-setupctx-'));
  const order: string[] = [];
  try {
    const config: Config = {
      environments: { local: { baseUrl: `http://127.0.0.1:${port}`, mutations: true } },
      roles: {
        user: {
          login: async (page, env) => {
            order.push('login');
            await page.goto(env.baseUrl + '/login');
          },
        },
      },
      ownOrigins: [/127\.0\.0\.1/],
      scenarios: [],
      setupContext: async (ctx) => {
        order.push('setupContext');
        await ctx.route('**/*', (route) =>
          new URL(route.request().url()).pathname === '/forbidden' ? route.abort('blockedbyclient') : route.continue(),
        );
      },
      beforeEach: async () => {
        order.push('beforeEach');
      },
    };
    const guarded: Scenario = { name: 'test/guarded-start', kind: 'smoke', role: 'user', start: '/forbidden', goal: 'render', maxSteps: 2 };
    const allowed: Scenario = { name: 'test/allowed-start', kind: 'smoke', role: 'user', start: '/ok', goal: 'render', maxSteps: 2 };
    const decide = async (): Promise<Decision> => ({ operation: 'DONE', action: null, text: null, confidence: 1, latencyMs: 0, inputTokens: 0, alternatives: [], degraded: null });

    const results = await runAll({
      config, dir, envName: 'local', scenarios: [guarded], concurrency: 1, repeat: 1,
      outDir: join(dir, 'guarded'), deps: { decide },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'ERROR', `a blocked start must not pass: ${results[0].reason}`);
    assert.ok(!hits.includes('/forbidden'), 'the guarded start URL must never reach the server');
    assert.deepEqual(order, ['setupContext', 'login'], 'setupContext runs first; beforeEach never runs after a failed start');

    order.length = 0;
    const ok = await runAll({
      config, dir, envName: 'local', scenarios: [allowed], concurrency: 1, repeat: 1,
      outDir: join(dir, 'allowed'), deps: { decide },
    });
    assert.equal(ok[0].verdict, 'PASS', ok[0].reason);
    assert.deepEqual(order, ['setupContext', 'login', 'beforeEach']);
    assert.ok(hits.includes('/ok'));
    assert.ok(readFileSync(join(dir, 'allowed', 'results.json'), 'utf8').includes('test/allowed-start'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
