// J6 regression: replayUrls() must release its Chromium browser even when
// role.login() throws (a real browser is needed to prove chromium.launch()
// itself still works fine right afterward — no lock left behind).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { Config } from '../src/config.ts';
import { replayUrls } from '../src/replay.ts';

const SKIP = process.env.JEV_QA_NO_BROWSER ? 'JEV_QA_NO_BROWSER is set' : false;

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test('replayUrls: a throwing login still releases the browser (try/finally, not leaked)', { skip: SKIP }, async () => {
  const { server, port } = await startServer();
  try {
    const config: Config = {
      environments: { local: { baseUrl: `http://127.0.0.1:${port}`, mutations: false } },
      roles: { broken: { login: async () => { throw new Error('login intentionally broken for this test'); } } },
      ownOrigins: [/127\.0\.0\.1/],
      scenarios: [],
    };

    await assert.rejects(
      () => replayUrls({ config, envName: 'local', role: 'broken', urls: ['/'] }),
      /login intentionally broken for this test/,
    );

    // Weak but real evidence of no leaked resource: chromium.launch() (a fresh instance) still
    // works immediately afterward — a leaked browser process holding a lock/profile-dir would
    // be the kind of thing that could make this hang or fail on a resource-constrained box.
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  } finally {
    server.close();
  }
});

test('replayUrls: guardRequest rewrites or refuses before any request is sent', { skip: SKIP }, async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const config: Config = {
      environments: { local: { baseUrl: `http://127.0.0.1:${port}`, mutations: false } },
      roles: {},
      ownOrigins: [/127\.0\.0\.1/],
      scenarios: [],
      guardRequest: (url) => {
        const u = new URL(url);
        if (u.pathname === '/forbidden') return { refuse: 'forbidden path' };
        u.searchParams.set('log', '0');
        return u.toString();
      },
    };
    const rows = await replayUrls({ config, envName: 'local', role: null, urls: ['/forbidden', '/ok?log=1'] });
    assert.equal(rows[0].status, 'REFUSED');
    assert.equal(rows[0].summary, 'forbidden path');
    assert.equal(rows[1].status, 200);
    assert.deepEqual(seen, ['/ok?log=0'], 'the refused URL is never sent; the kept one is sent rewritten');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
