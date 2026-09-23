import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defineConfig, glob, loadConfig, resolveBaseUrl, stripStatefulFlags } from '../src/config.ts';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(dir: string, body: string): string {
  const path = join(dir, 'jev-qa.config.ts');
  writeFileSync(path, body);
  return path;
}

test('defineConfig is the identity function', () => {
  const c = { environments: {}, roles: {}, ownOrigins: [], scenarios: 'x' } as unknown as Parameters<typeof defineConfig>[0];
  assert.equal(defineConfig(c), c);
});

test('loadConfig rejects an empty environments map', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({ environments: {}, roles: {}, ownOrigins: [/x/], scenarios: 's/*.json' });`,
  );
  await assert.rejects(loadConfig(path), /environments/);
});

test('loadConfig rejects a role missing a login function', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({ environments: { local: { baseUrl: 'http://x', mutations: false } }, roles: { manager: {} }, ownOrigins: [/x/], scenarios: 's/*.json' });`,
  );
  await assert.rejects(loadConfig(path), /roles\.manager\.login/);
});

test('loadConfig rejects a non-array / empty ownOrigins', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({ environments: { local: { baseUrl: 'http://x', mutations: false } }, roles: {}, ownOrigins: [], scenarios: 's/*.json' });`,
  );
  await assert.rejects(loadConfig(path), /ownOrigins/);
});

test('loadConfig rejects missing scenarios', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({ environments: { local: { baseUrl: 'http://x', mutations: false } }, roles: {}, ownOrigins: [/x/], scenarios: [] });`,
  );
  await assert.rejects(loadConfig(path), /scenarios/);
});

test('loadConfig accepts a minimal valid config and returns its directory', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({
  environments: { local: { baseUrl: 'http://example.com', mutations: false } },
  roles: { anon: { login: async () => {} } },
  ownOrigins: [/example\\.com/],
  scenarios: 'scenarios/*.json',
});`,
  );
  const { config, dir: loadedDir } = await loadConfig(path);
  assert.equal(loadedDir, dir);
  assert.equal(Object.keys(config.environments).length, 1);
});

test('glob: * within a segment and a plain filename', () => {
  const dir = tmpDir('jevqa-glob-');
  mkdirSync(join(dir, 'scenarios'));
  writeFileSync(join(dir, 'scenarios', 'a.json'), '[]');
  writeFileSync(join(dir, 'scenarios', 'b.json'), '[]');
  writeFileSync(join(dir, 'scenarios', 'c.txt'), '');
  const matches = glob('scenarios/*.json', dir);
  assert.deepEqual(matches.map((m) => m.split('/').pop()).sort(), ['a.json', 'b.json']);
});

test('glob: ** recurses into nested directories', () => {
  const dir = tmpDir('jevqa-glob-');
  mkdirSync(join(dir, 'scenarios', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'scenarios', 'top.json'), '[]');
  writeFileSync(join(dir, 'scenarios', 'nested', 'deep.json'), '[]');
  const matches = glob('scenarios/**/*.json', dir);
  assert.deepEqual(matches.map((m) => m.split('/').pop()).sort(), ['deep.json', 'top.json']);
});

test('glob: no matches returns an empty array, not an error', () => {
  const dir = tmpDir('jevqa-glob-');
  assert.deepEqual(glob('nothing/*.json', dir), []);
});

test('stripStatefulFlags: drops g and y but keeps i/s/u/m', () => {
  const stripped = stripStatefulFlags(/foo/gimsuy);
  assert.equal(stripped.flags.includes('g'), false);
  assert.equal(stripped.flags.includes('y'), false);
  assert.equal(stripped.source, 'foo');
  for (const f of ['i', 'm', 's', 'u']) assert.equal(stripped.flags.includes(f), true);
});

test('stripStatefulFlags: a stateless regex is unaffected (still matches repeatedly)', () => {
  const re = stripStatefulFlags(/x/i);
  assert.equal(re.test('X'), true);
  assert.equal(re.test('X'), true);
  assert.equal(re.test('X'), true);
});

test('loadConfig: a /…/g ownOrigin no longer alternates match/no-match across repeated .test() calls', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({
  environments: { local: { baseUrl: 'http://example.com', mutations: false } },
  roles: { anon: { login: async () => {} } },
  ownOrigins: [/example\\.com/g],
  scenarios: 'scenarios/*.json',
});`,
  );
  const { config } = await loadConfig(path);
  const [ownOrigin] = config.ownOrigins;
  assert.equal(ownOrigin.flags.includes('g'), false);
  assert.equal(ownOrigin.test('example.com'), true);
  assert.equal(ownOrigin.test('example.com'), true);
  assert.equal(ownOrigin.test('example.com'), true);
});

test('loadConfig: known[].match and known[].kind are also normalized', async () => {
  const dir = tmpDir('jevqa-cfg-');
  const path = writeConfig(
    dir,
    `import { defineConfig } from '${new URL('../src/config.ts', import.meta.url).pathname}';
export default defineConfig({
  environments: { local: { baseUrl: 'http://example.com', mutations: false } },
  roles: { anon: { login: async () => {} } },
  ownOrigins: [/example\\.com/],
  known: [{ id: 'K1', match: /dead-page/g, kind: /^http 404$/g }],
  scenarios: 'scenarios/*.json',
});`,
  );
  const { config } = await loadConfig(path);
  const known = config.known![0];
  assert.equal(known.match.flags.includes('g'), false);
  assert.equal(known.kind!.flags.includes('g'), false);
  assert.equal(known.match.test('/dead-page'), true);
  assert.equal(known.match.test('/dead-page'), true);
});

test('resolveBaseUrl: no baseUrl falls back to the environment baseUrl', () => {
  const env = { baseUrl: 'https://env.example.com', mutations: false };
  assert.equal(resolveBaseUrl({ login: async () => {} }, env), 'https://env.example.com');
});

test('resolveBaseUrl: a static string baseUrl wins over the environment', () => {
  const env = { baseUrl: 'https://env.example.com', mutations: false };
  assert.equal(resolveBaseUrl({ baseUrl: 'https://role.example.com', login: async () => {} }, env), 'https://role.example.com');
});

test('resolveBaseUrl: a function baseUrl is called with the environment, per env', () => {
  const role = { baseUrl: (env: { baseUrl: string; mutations: boolean }) => (env.mutations ? 'http://local.example.com' : 'https://staging.example.com'), login: async () => {} };
  assert.equal(resolveBaseUrl(role, { baseUrl: 'x', mutations: false }), 'https://staging.example.com');
  assert.equal(resolveBaseUrl(role, { baseUrl: 'x', mutations: true }), 'http://local.example.com');
});
